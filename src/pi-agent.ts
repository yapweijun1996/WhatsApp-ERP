import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type, createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { demoGatewayConfig, demoGatewayModel, DemoGatewaySession } from './gateway.js';

export type OrderIntent = 'offer_quote' | 'prepare_quote' | 'accept_quote' | 'reject_quote' | 'clarify';
export type InterpretedOrderLine = { query: string; quantity: number; uom: string; rowItemRemark?: string };
export type OrderIntentResult = {
  intent: OrderIntent;
  reason: string;
  lines?: InterpretedOrderLine[];
  requestedDeliveryDate?: string;
};
type Handler = (intent: OrderIntentResult) => Promise<unknown>;

const forbidden = ['post_sales_order', 'confirm_sales_order', 'create_delivery_order', 'DO_READY'];

/** Pi interprets customer wording only; deterministic CommerceService/ERP owns all canonical business truth. */
export function piOrderToolNames() { return ['interpret_order']; }
export function forbiddenPiToolNames() { return forbidden.slice(); }

const intentEnum = z.enum(['offer_quote', 'prepare_quote', 'accept_quote', 'reject_quote', 'clarify']);
const canonicalLineSchema = z.object({
  query: z.string().min(1),
  quantity: z.number().finite().positive(),
  uom: z.string().min(1),
  rowItemRemark: z.string().optional(),
}).strict();
const orderIntentSchema = z.object({
  intent: intentEnum,
  reason: z.string().min(1),
  lines: z.array(canonicalLineSchema).optional(),
  requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
const demoWireLineSchema = z.union([
  canonicalLineSchema,
  z.object({
    product: z.string().min(1),
    quantity: z.number().finite().positive(),
    uom: z.string().min(1),
    rowItemRemark: z.string().optional(),
  }).strict().transform(({ product, ...line }) => ({ query: product, ...line })),
]);
const demoWireIntentSchema = z.object({
  intent: intentEnum,
  reason: z.string().min(1),
  lines: z.array(demoWireLineSchema).nullable().optional(),
  requestedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}).strict();
export const OrderIntentResultSchema = orderIntentSchema;

/**
 * Accept one complete JSON object from the text-only Demo Gateway. The wire adapter
 * normalizes only two observed representation quirks: product -> query and null
 * optional values -> omitted. Business meaning is canonicalized separately.
 */
export function parseOrderIntentResult(text: string): OrderIntentResult {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
    throw new Error('DEMO_GPT_INVALID_ORDER_INTENT_JSON');
  }
  try {
    const wire = demoWireIntentSchema.parse(JSON.parse(candidate));
    return orderIntentSchema.parse({
      intent: wire.intent,
      reason: wire.reason,
      ...(wire.lines?.length ? { lines: wire.lines } : {}),
      ...(wire.requestedDeliveryDate ? { requestedDeliveryDate: wire.requestedDeliveryDate } : {}),
    });
  } catch {
    throw new Error('DEMO_GPT_INVALID_ORDER_INTENT_JSON');
  }
}

function assistantMessage(agent: Agent): AssistantMessage | undefined {
  return [...agent.state.messages].reverse().find((message: any) => message.role === 'assistant') as AssistantMessage | undefined;
}

function assistantText(agent: Agent): string {
  const message = assistantMessage(agent);
  return message?.content
    .filter((part: any) => part.type === 'text')
    .map((part: any) => part.text)
    .join('') ?? '';
}

function customerTextFromContext(context: any): string {
  const user = [...(context.messages ?? [])].reverse().find((message: any) => message.role === 'user');
  if (typeof user?.content === 'string') return user.content;
  if (Array.isArray(user?.content)) {
    return user.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
  }
  return '';
}

function createDemoStream(session: DemoGatewaySession) {
  return (model: Model<any>, context: any, options?: any) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const input = [
          context.systemPrompt ? `SYSTEM INSTRUCTIONS:\n${context.systemPrompt}` : '',
          `CUSTOMER MESSAGE:\n${customerTextFromContext(context)}`,
          'Return only the JSON object. Do not add markdown or commentary.',
        ].filter(Boolean).join('\n\n');
        const result = await session.completeText(input, options?.signal);
        const message: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          ...(result.responseId ? { responseId: result.responseId } : {}),
          usage: {
            input: result.usage?.inputTokens ?? 0,
            output: result.usage?.outputTokens ?? 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: result.usage?.totalTokens ?? 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: Date.now(),
        };
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        (message.content[0] as any).text = result.text;
        stream.push({ type: 'text_delta', contentIndex: 0, delta: result.text, partial: message });
        stream.push({ type: 'text_end', contentIndex: 0, content: result.text, partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
      } catch (error) {
        const reason: 'aborted' | 'error' = options?.signal?.aborted ? 'aborted' : 'error';
        const message: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: reason,
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
        stream.push({ type: 'error', reason, error: message });
      }
    })();
    return stream;
  };
}

function makeTools(handler: Handler): AgentTool<any>[] {
  return [{
    name: 'interpret_order',
    label: 'Interpret order intent',
    description: 'Interpret customer wording into a bounded V1 intent and optional requested lines. Never invent customer/SKU/UOM conversion/price/stock/document numbers and never post or confirm Sales Orders.',
    parameters: Type.Object({
      intent: Type.Union([
        Type.Literal('offer_quote'),
        Type.Literal('prepare_quote'),
        Type.Literal('accept_quote'),
        Type.Literal('reject_quote'),
        Type.Literal('clarify'),
      ]),
      reason: Type.String(),
      lines: Type.Optional(Type.Array(Type.Object({
        query: Type.String(),
        quantity: Type.Number(),
        uom: Type.String(),
        rowItemRemark: Type.Optional(Type.String()),
      }))),
      requestedDeliveryDate: Type.Optional(Type.String()),
    }),
    execute: async (_id, args) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(args) }],
      details: await handler(args as OrderIntentResult),
      terminate: true,
    }),
  }];
}

export class PiOrderAgent {
  readonly allowedToolNames: string[];
  private readonly provider = fauxProvider({ provider: 'order-demo', api: 'faux', models: [{ id: 'order-demo-model', name: 'Order test model' }] });
  private readonly agent: Agent;
  private readonly tools: AgentTool<any>[];
  private readonly demoMode: boolean;
  private readonly demoSession?: DemoGatewaySession;
  // Explicit non-semantic test fallback. It is intentionally unable to inspect
  // customer wording; production semantic interpretation requires a model.
  private readonly scriptedResponse = () => fauxAssistantMessage(
    fauxToolCall('interpret_order', { intent: 'clarify', reason: 'NO_SEMANTIC_MODEL_AVAILABLE' }),
    { stopReason: 'toolUse' },
  );

  constructor(
    private readonly onIntent: Handler,
    private readonly onEvent?: (event: { type: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean }) => void,
  ) {
    this.tools = makeTools(onIntent);
    const demoConfig = demoGatewayConfig();
    this.demoMode = demoConfig.enabled;
    this.allowedToolNames = this.demoMode ? [] : piOrderToolNames();
    this.demoSession = this.demoMode ? new DemoGatewaySession(demoConfig) : undefined;
    this.provider.setResponses([this.scriptedResponse]);
    const offlineProvider = this.provider.provider;
    this.agent = new Agent({
      initialState: {
        model: this.demoMode ? demoGatewayModel(demoConfig) : offlineProvider.getModels()[0],
        systemPrompt: 'Return one JSON object matching the declared order-intent schema. Interpret the complete customer conversation semantically. Do not guess canonical ERP entities, commercial facts, or dates. The host validates and executes bounded actions; autonomy stops at SALES_ORDER.DRAFT.',
        tools: this.demoMode ? [] : this.tools,
      },
      streamFn: this.demoMode ? createDemoStream(this.demoSession!) : offlineProvider.streamSimple.bind(offlineProvider),
      toolExecution: 'sequential',
    });
    this.agent.subscribe(async (event) => {
      if (event.type === 'tool_execution_start') this.onEvent?.({ type: event.type, toolName: event.toolName, args: event.args });
      if (event.type === 'tool_execution_end') this.onEvent?.({ type: event.type, toolName: event.toolName, result: event.result, isError: event.isError });
    });
  }

  async run(text: string): Promise<OrderIntentResult> {
    let result: OrderIntentResult = { intent: 'clarify', reason: 'agent produced no intent' };
    const original = this.onIntent;
    this.agent.reset();
    if (this.demoMode) {
      await this.agent.prompt(text);
      const message = assistantMessage(this.agent);
      if (message?.stopReason === 'error' || message?.stopReason === 'aborted') {
        throw new Error(message.errorMessage ?? 'DEMO_GPT_AGENT_FAILED');
      }
      const modelIntent = parseOrderIntentResult(assistantText(this.agent));
      await original(modelIntent);
      return modelIntent;
    }

    this.provider.setResponses([this.scriptedResponse]);
    (this.tools[0] as any).execute = async (_id: string, args: OrderIntentResult) => {
      result = args;
      const output = await original(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(args) }], details: output, terminate: true };
    };
    let runError: unknown;
    const unsubscribe = this.agent.subscribe(async event => {
      if (event.type === 'tool_execution_end' && event.isError) runError = event.result;
    });
    await this.agent.prompt(text);
    unsubscribe();
    if (runError) throw new Error(typeof runError === 'string' ? runError : JSON.stringify(runError));
    return result;
  }
}

export type PiModel = Model<any>;
