import { canonicalJson, canonicalSha256 } from './v2-canonical.js';
import { getCapability } from './v2-capability-registry.js';
import type { CapabilityDefinition } from './v2-capability-contracts.js';
import { validateCapabilityArgumentsForDefinition } from './v2-capability-schema.js';
import {
  assertDemoV1Budget,
  computeDemoV1ResultHash,
  normalizeDemoV1Envelope,
  type DemoV1Envelope,
} from './v2-demo-v1-envelope.js';
import { normalizeCapabilityResult } from './v2-capability-result.js';
import {
  normalizeAgentDecision,
  normalizeAgentObservation,
  type AgentDecision,
  type AgentModelTransport,
  type AgentObservation,
} from './v2-agent-model-transport.js';
import {
  canonicalTransportId,
  deriveAgentDecisionIdentity,
  exactKeys,
  plainRecord,
  transportFail,
  validateTransportJson,
} from './v2-transport-contract-helpers.js';

export const DEMO_TEXT_BRIDGE_MAX_INPUT_BYTES = 32 * 1024;
export const DEMO_TEXT_BRIDGE_MAX_OUTPUT_BYTES = 16 * 1024;

/** The Browser Demo model has no provider-native tool or structured-output API. */
export type DemoTextModelResult = Readonly<{
  text: string;
  inputBudget: { direction: 'input'; bytes: number; tokenCount: number };
  outputBudget: { direction: 'output'; bytes: number; tokenCount: number };
}>;
export type DemoTextModelRequest = Readonly<{ signal?: AbortSignal; maxOutputTokens: 4000 }>;
export type DemoTextModel = (prompt: string, request: DemoTextModelRequest) => Promise<DemoTextModelResult>;
export type DemoTextToolBridgeOptions = Readonly<{
  model: DemoTextModel;
  /** Trusted adapter measurement; the bridge never estimates token counts. */
  measureInput: (prompt: string) => Readonly<{ direction: 'input'; bytes: number; tokenCount: number }>;
  id?: string;
}>;

type TurnState = {
  nextSequence: number;
  actionIds: Set<string>;
  pending?: Readonly<{ turnId: string; sequence: number; correlationId: string; actionId: string; name: string }>;
  inFlight?: Readonly<{ sequence: number; fingerprint: string }>;
  terminal?: boolean;
  failedAttempt?: Readonly<{ sequence: number; fingerprint: string; retryUsed: boolean }>;
};

function fail(code: string): never { throw new Error(`DEMO_TEXT_BRIDGE_FAILED:${code}`); }

const projectionKeys = ['name', 'version', 'purpose', 'inputSchema', 'sideEffect', 'timeoutMs', 'idempotencyRequired', 'outboundDisposition', 'evidenceMode', 'groundingMode'] as const;
const workflowInstruction = 'AI-first semantics: infer customer intent from the full conversation, Role/Skills and canonical host state; never use exact-phrase matching as business authority. Select at most one appropriate capability at a time. For repeat orders, gather required history/workspace facts before draft mutation. Do not send a quotation on an initial capture unless the customer semantically requested or authorized quotation. Distinguish quotation permission from quotation acceptance by meaning, not phrase matching. Record commitment only when customer intent is explicit and unambiguous and canonical quotation state permits it. After Draft Sales Order exists, stop autonomous commerce mutation. Never invent IDs/revisions or protected ERP facts; use capabilities and grounding.';
const protocolInstruction = 'Return one plain JSON object only and echo expected turnId, sequence, correlationId, actionId. tool_call keys: protocolVersion,turnId,sequence,correlationId,actionId,kind,name,arguments; protocolVersion=v1; name must be an available capability; arguments must match its schema. final_response keys: protocolVersion,turnId,sequence,correlationId,actionId,kind,responsePlan. responsePlan requires turnId, intent ANSWER|CLARIFY|HANDOFF|ACKNOWLEDGE, factClaims, and outboundPurpose mapped to customer_reply|clarification|handoff|acknowledgement. connectiveText is natural model-written customer-facing language, not canned text. Keep it concise. Do not put prices, quantities, UOM, stock/availability claims, dates, currency amounts, document numbers/statuses, or other protected commercial facts in connectiveText; use factClaims with exact host-visible canonicalRefs. ACKNOWLEDGE has no factClaims. CLARIFY may optionally include safeReasonCode; HANDOFF requires safeReasonCode and matching handoff.reasonCode and is only for real staff escalation. Host alone executes actions.'


/** Model-facing compression only. Full registry metadata/schema was already
 * validated by capabilityForObservation and remains host-owned authority.
 * The compact guide gives the Demo model exact argument names/types/enums;
 * returned arguments are still validated against the full registry schema. */
function compactSchemaGuide(schema: unknown): string {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) fail('CAPABILITY_SCHEMA');
  const value = schema as Record<string, unknown>;
  if (Array.isArray(value.enum)) return value.enum.map(item => String(item)).join('|');
  if (value.type === 'array') return `[${compactSchemaGuide(value.items)}]`;
  if (value.type === 'object') {
    const properties = value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)
      ? value.properties as Record<string, unknown> : {};
    const required = new Set(Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === 'string') : []);
    return `{${Object.entries(properties).map(([name, child]) => `${name}${required.has(name) ? '' : '?'}:${compactSchemaGuide(child)}`).join(',')}}`;
  }
  if (value.type === 'integer') return 'int';
  if (value.type === 'string' || value.type === 'number' || value.type === 'boolean') return value.type;
  fail('CAPABILITY_SCHEMA');
}

function compactCapabilityGuides(capabilities: readonly CapabilityDefinition[]) {
  return capabilities.map(capability => ({ name: capability.name, arguments: compactSchemaGuide(capability.inputSchema) }));
}

type WorkflowDirective = Readonly<{ phase:string; requiredCapability?:string; finalOnly?:boolean }>;
function assertWorkflowArguments(directive: WorkflowDirective, observation: AgentObservation, capabilityName: string, args: unknown): void {
  if (directive.requiredCapability !== capabilityName) return;
  if (capabilityName === 'reuse_previous_order') {
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('WORKFLOW_REFERENCE_MISMATCH');
    const argumentRecord = args as Record<string, unknown>;
    const completed = Array.isArray(observation.completedActions) ? observation.completedActions as any[] : [];
    const history = completed.find(action => action?.name === 'get_order_history' && action?.status === 'SUCCEEDED');
    const orders = Array.isArray(history?.data?.orders) ? history.data.orders : [];
    const allowedIds = orders.map((order: any) => order?.id).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
    if (!allowedIds.length || typeof argumentRecord.previousSalesOrderId !== 'string' || !allowedIds.includes(argumentRecord.previousSalesOrderId)) fail('WORKFLOW_REFERENCE_MISMATCH');
  }
}

function workflowDirective(observation: AgentObservation): WorkflowDirective {
  const context = observation.context as any;
  // AI-first: the bridge never classifies natural language. Only canonical
  // lifecycle state can force a safety stop.
  if (context?.activeQuotationSalesOrder?.salesOrder?.status === 'DRAFT') {
    return { phase:'SALES_ORDER_DRAFT_STOP', finalOnly:true };
  }
  return { phase:'AI_FIRST' };
}

/**
 * TRAN-006's deliberately closed repair boundary. These are errors raised
 * while validating model-authored output after the model has returned. Host
 * projection/input failures, provider failures, secrets, interruption and
 * bridge state errors are intentionally excluded.
 */
const REPAIRABLE_MODEL_OUTPUT_CODES = new Set([
  'MODEL_OUTPUT_INVALID', 'MODEL_TEXT', 'PLAIN_JSON_OBJECT_REQUIRED',
  'MALFORMED_JSON', 'JSON_OBJECT_REQUIRED', 'DUPLICATE_JSON_KEY',
  'MODEL_ARGUMENTS_INVALID',
  'FINAL_RESPONSE_INVALID', 'FINAL_RESPONSE_PLAN_INVALID',
  'FINAL_RESPONSE_FIELDS', 'FINAL_RESPONSE_INTENT',
  'FINAL_RESPONSE_PURPOSE', 'FINAL_RESPONSE_CONNECTIVE_TEXT',
  'FINAL_RESPONSE_FACT_CLAIMS', 'FINAL_RESPONSE_HANDOFF',
  'WORKFLOW_ACTION_REQUIRED', 'WORKFLOW_ACTION_MISMATCH', 'WORKFLOW_FINAL_REQUIRED',
]);

/** Fixed machine-safe classification; never exposes provider/model text. */
export function isRepairableDemoTextModelOutputFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const prefix = 'DEMO_TEXT_BRIDGE_FAILED:';
  if (!error.message.startsWith(prefix)) return false;
  return REPAIRABLE_MODEL_OUTPUT_CODES.has(error.message.slice(prefix.length));
}

function safeOutputFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  const code = message.startsWith('DEMO_TEXT_BRIDGE_FAILED:') ? message.slice('DEMO_TEXT_BRIDGE_FAILED:'.length) : '';
  if (code && /^[A-Z0-9_]+$/.test(code)) fail(code);
  if (/BUDGET_EXCEEDED/.test(message)) fail('BUDGET_EXCEEDED');
  if (/INPUT_MEASUREMENT_MISMATCH/.test(message)) fail('INPUT_MEASUREMENT_MISMATCH');
  if (/OUTPUT_MEASUREMENT_MISMATCH/.test(message)) fail('OUTPUT_MEASUREMENT_MISMATCH');
  if (/SECRET_VALUE|SECRET|BEARER|AUTH|TOKEN/i.test(message)) fail('MODEL_OUTPUT_SECRET');
  if (/ARGUMENT|SCHEMA/i.test(message)) fail('MODEL_ARGUMENTS_INVALID');
  if (/TURN_ID|SEQUENCE|CORRELATION_ID|ACTION_ID|CAPABILITY_VERSION|NAME/i.test(message)) fail('MODEL_ID_INVALID');
  if (/RESULT_HASH|CAPABILITY_RESULT/i.test(message)) fail('MODEL_RESULT_INVALID');
  fail('MODEL_OUTPUT_INVALID');
}

function exactObjectText(raw: unknown): unknown {
  if (typeof raw !== 'string') fail('MODEL_TEXT');
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > DEMO_TEXT_BRIDGE_MAX_OUTPUT_BYTES) fail('OUTPUT_SIZE');
  const text = raw.trim();
  if (!text || text[0] !== '{' || text[text.length - 1] !== '}') fail('PLAIN_JSON_OBJECT_REQUIRED');
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('MALFORMED_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('JSON_OBJECT_REQUIRED');

  // JSON.parse keeps the last member when an object contains duplicate keys.
  // Scan the already-parsed JSON syntax so the wire representation is
  // unambiguous without introducing another parser dependency.
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? '')) offset += 1; };
  const stringEnd = (): number => {
    const start = offset;
    if (text[offset++] !== '"') fail('MALFORMED_JSON');
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '\\') { if (offset >= text.length) fail('MALFORMED_JSON'); offset += 1; }
      else if (character === '"') return offset;
    }
    fail('MALFORMED_JSON');
  };
  const scanValue = (): void => {
    whitespace();
    if (text[offset] === '"') { stringEnd(); return; }
    if (text[offset] === '{') {
      offset += 1; whitespace(); const keys = new Set<string>();
      if (text[offset] === '}') { offset += 1; return; }
      while (true) {
        whitespace(); const start = offset; const end = stringEnd();
        const key = JSON.parse(text.slice(start, end)) as string;
        if (keys.has(key)) fail('DUPLICATE_JSON_KEY');
        keys.add(key); whitespace();
        if (text[offset++] !== ':') fail('MALFORMED_JSON');
        scanValue(); whitespace();
        if (text[offset] === '}') { offset += 1; return; }
        if (text[offset++] !== ',') fail('MALFORMED_JSON');
      }
    }
    if (text[offset] === '[') {
      offset += 1; whitespace();
      if (text[offset] === ']') { offset += 1; return; }
      while (true) {
        scanValue(); whitespace();
        if (text[offset] === ']') { offset += 1; return; }
        if (text[offset++] !== ',') fail('MALFORMED_JSON');
      }
    }
    while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset += 1;
  };
  scanValue(); whitespace();
  if (offset !== text.length) fail('MALFORMED_JSON');
  return value;
}

function strictResultRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const detached = plainRecord(value, code);
  return detached;
}

function strictExactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function capabilityForObservation(entry: unknown): CapabilityDefinition {
  const value = plainRecord(entry, 'AVAILABLE_CAPABILITY');
  if (Object.keys(value).some(key => !(projectionKeys as readonly string[]).includes(key))) fail('CAPABILITY_PROJECTION_FIELDS');
  if (Object.keys(value).length !== projectionKeys.length || typeof value.name !== 'string' || typeof value.version !== 'string' || typeof value.purpose !== 'string') fail('CAPABILITY_PROJECTION_FIELDS');
  const capability = getCapability(value.name);
  if (!capability || value.version !== capability.version) fail('INVALID_AVAILABLE_CAPABILITY');
  if (canonicalJson(value.inputSchema) !== canonicalJson(capability.inputSchema)) fail('CAPABILITY_SCHEMA_MISMATCH');
  if (value.purpose !== capability.name || value.sideEffect !== capability.sideEffect || value.timeoutMs !== capability.timeout.perCallMs || value.idempotencyRequired !== capability.idempotency.required || value.outboundDisposition !== capability.outbound.disposition || value.evidenceMode !== capability.evidence.mode || value.groundingMode !== capability.grounding.mode) fail('CAPABILITY_METADATA_MISMATCH');
  return capability;
}

function resultEnvelope(input: Readonly<{
  turnId: string;
  sequence: number;
  correlationId: string;
  actionId: string;
  name: string;
  result: unknown;
}>): Extract<DemoV1Envelope, { kind: 'capability_result' }> {
  const capability = getCapability(input.name);
  if (!capability) fail('UNKNOWN_CAPABILITY');
  validateTransportJson(input.result, 'HOST_RESULT', true, 32 * 1024);
  const result = normalizeCapabilityResult(input.result);
  // normalizeDemoV1Envelope is the sole wire/result contract and computes the
  // TRAN-001 JCS hash over the complete normalized CapabilityResult.
  const normalized = normalizeDemoV1Envelope({
    protocolVersion: 'v1', turnId: input.turnId, sequence: input.sequence,
    correlationId: input.correlationId, actionId: input.actionId,
    kind: 'capability_result', name: capability.name,
    status: result.status, result,
    resultHash: computeDemoV1ResultHash({
      protocolVersion: 'v1', turnId: input.turnId, sequence: input.sequence,
      correlationId: input.correlationId, actionId: input.actionId,
      kind: 'capability_result', name: capability.name, status: result.status, result,
    } as any),
  }) as Extract<DemoV1Envelope, { kind: 'capability_result' }>;
  return normalized;
}

/**
 * Parser/protocol adapter only. It deliberately has no capability handlers,
 * database access, outbound access, or retry/repair loop.
 */
export class DemoTextToolBridge implements AgentModelTransport {
  readonly mode = 'demo-text' as const;
  readonly id: string;
  private readonly model: DemoTextModel;
  private readonly turns = new Map<string, TurnState>();

  constructor(options: DemoTextToolBridgeOptions) {
    if (typeof options.model !== 'function') fail('MODEL');
    if (typeof options.measureInput !== 'function') fail('INPUT_MEASUREMENT');
    this.model = options.model;
    this.measureInput = options.measureInput;
    this.id = options.id === undefined ? 'demo-text' : canonicalTransportId(options.id, 'TRANSPORT_ID', 160);
  }
  private readonly measureInput: DemoTextToolBridgeOptions['measureInput'];

  async decide(input: AgentObservation, signal?: AbortSignal, attemptKind: 'MODEL'|'REPAIR' = 'MODEL'): Promise<AgentDecision> {
    if (signal?.aborted) fail('ABORTED');
    const observation = normalizeAgentObservation(input);
    const existing = this.turns.get(observation.turnId);
    if (existing?.terminal) fail('TERMINAL');
    if (existing?.pending) fail('PENDING_RESULT');
    if (existing?.inFlight) fail('DECISION_IN_FLIGHT');
    if (existing && observation.sequence < existing.nextSequence) fail('REPLAY');
    if (existing && observation.sequence > existing.nextSequence) fail('OUT_OF_ORDER_OBSERVATION');
    if (!existing && observation.sequence !== 1) fail('INITIAL_SEQUENCE');
    const state = existing ?? { nextSequence: 1, actionIds: new Set<string>() };
    const identity = deriveAgentDecisionIdentity(observation.turnId, observation.sequence);
    if (!Array.isArray(observation.availableCapabilities)) fail('CAPABILITIES_NOT_ARRAY');
    const projectionFingerprint = canonicalSha256(canonicalJson(observation.availableCapabilities));
    const fingerprint = canonicalSha256(canonicalJson({ observation, identity, projectionFingerprint }));
    if (state.failedAttempt && attemptKind !== 'REPAIR') {
      if (state.failedAttempt.sequence !== observation.sequence || state.failedAttempt.fingerprint !== fingerprint) fail('REPAIR_SCOPE_MISMATCH');
      if (state.failedAttempt.retryUsed) fail('REPAIR_EXHAUSTED');
      // TRAN-003 may validate one same-observation retry boundary, but it must
      // never become the autonomous repair loop owned by TRAN-006.
      state.failedAttempt = { ...state.failedAttempt, retryUsed: true };
      this.turns.set(observation.turnId, state);
    }
    let capabilities: CapabilityDefinition[];
    try { capabilities = observation.availableCapabilities.map(capabilityForObservation); } catch (error) { safeOutputFailure(error); }
    if (new Set(capabilities.map(capability => capability.name)).size !== capabilities.length) fail('DUPLICATE_CAPABILITY');
    const names = new Set(capabilities.map(capability => capability.name));
    const directive = workflowDirective(observation);
    const modelObservation = { turnId: observation.turnId, sequence: observation.sequence, context: observation.context, capabilityGuides: compactCapabilityGuides(capabilities), completedActions: observation.completedActions };
    const prompt = canonicalJson({ protocolVersion: 'v1', instruction: state.failedAttempt || attemptKind === 'REPAIR'
      ? `${protocolInstruction} Repair the previous malformed model output. Return exactly one valid object now; do not repeat the malformed output.`
      : protocolInstruction, workflow: workflowInstruction, workflowState: directive, expected: { turnId: observation.turnId, sequence: observation.sequence, ...identity }, observation: modelObservation });
    try {
      const inputBudget = this.measureInput(prompt);
      assertDemoV1Budget(inputBudget);
      if (inputBudget.direction !== 'input') fail('BUDGET_DIRECTION');
      if (inputBudget.bytes !== Buffer.byteLength(prompt, 'utf8')) fail('INPUT_MEASUREMENT_MISMATCH');
    } catch (error) {
      safeOutputFailure(error);
    }
    state.inFlight = { sequence: observation.sequence, fingerprint };
    this.turns.set(observation.turnId, state);
    try {
      let modelResult: DemoTextModelResult;
      try { modelResult = await this.model(prompt, { signal, maxOutputTokens: 4000 }); } catch { fail('MODEL_FAILED'); }
      if (signal?.aborted) fail('ABORTED');
      try {
        const result = strictResultRecord(modelResult, 'MODEL_OUTPUT_INVALID');
        strictExactKeys(result, ['text', 'inputBudget', 'outputBudget'], 'MODEL_OUTPUT_INVALID');
        if (typeof result.text !== 'string') fail('MODEL_OUTPUT_INVALID');
        const inputBudget = strictResultRecord(result.inputBudget, 'MODEL_OUTPUT_INVALID');
        const outputBudget = strictResultRecord(result.outputBudget, 'MODEL_OUTPUT_INVALID');
        strictExactKeys(inputBudget, ['direction', 'bytes', 'tokenCount'], 'MODEL_OUTPUT_INVALID');
        strictExactKeys(outputBudget, ['direction', 'bytes', 'tokenCount'], 'MODEL_OUTPUT_INVALID');
        assertDemoV1Budget({ direction: inputBudget.direction, bytes: inputBudget.bytes, tokenCount: inputBudget.tokenCount });
        assertDemoV1Budget({ direction: outputBudget.direction, bytes: outputBudget.bytes, tokenCount: outputBudget.tokenCount });
        if (inputBudget.direction !== 'input' || outputBudget.direction !== 'output') fail('BUDGET_DIRECTION');
        const promptBytes = Buffer.byteLength(prompt, 'utf8');
        if (inputBudget.bytes !== promptBytes) fail('INPUT_MEASUREMENT_MISMATCH');
        if (outputBudget.bytes !== Buffer.byteLength(result.text, 'utf8')) fail('OUTPUT_MEASUREMENT_MISMATCH');
        const raw = result.text;
        const envelope = normalizeDemoV1Envelope(exactObjectText(raw));
        if (envelope.kind === 'capability_result') fail('MODEL_AUTHORED_CAPABILITY_RESULT');
        if (envelope.turnId !== observation.turnId) fail('TURN_MISMATCH');
        if (envelope.sequence !== observation.sequence) fail('SEQUENCE_MISMATCH');
        if (state.actionIds.has(envelope.actionId)) fail('DUPLICATE_ACTION');
        if (envelope.correlationId !== identity.correlationId) fail('CORRELATION_MISMATCH');
        if (envelope.actionId !== identity.actionId) fail('ACTION_MISMATCH');
        if (directive.finalOnly && envelope.kind === 'tool_call') fail('WORKFLOW_FINAL_REQUIRED');
        if (directive.requiredCapability) {
          if (envelope.kind !== 'tool_call') fail('WORKFLOW_ACTION_REQUIRED');
          if (envelope.name !== directive.requiredCapability) fail('WORKFLOW_ACTION_MISMATCH');
        }
        if (envelope.kind === 'tool_call') {
          if (!names.has(envelope.name)) fail('UNKNOWN_OR_UNAVAILABLE_CAPABILITY');
          const capability = getCapability(envelope.name);
          if (!capability) fail('UNKNOWN_OR_UNAVAILABLE_CAPABILITY');
          if (envelope.capabilityVersion !== undefined && envelope.capabilityVersion !== capability.version) fail('CAPABILITY_VERSION_MISMATCH');
          const args = validateCapabilityArgumentsForDefinition(capability, envelope.arguments);
          assertWorkflowArguments(directive, observation, capability.name, args);
          const decision = normalizeAgentDecision({ kind: 'tool_call', turnId: envelope.turnId, sequence: envelope.sequence, correlationId: envelope.correlationId, actionId: envelope.actionId, capabilityName: capability.name, capabilityVersion: capability.version, arguments: args });
          state.actionIds.add(envelope.actionId); state.nextSequence += 1; state.failedAttempt = undefined;
          state.pending = { turnId: envelope.turnId, sequence: envelope.sequence, correlationId: envelope.correlationId, actionId: envelope.actionId, name: capability.name };
          return decision;
        }
        const decision = normalizeAgentDecision({ kind: 'final_response', turnId: envelope.turnId, sequence: envelope.sequence, correlationId: envelope.correlationId, actionId: envelope.actionId, responsePlan: envelope.responsePlan });
        state.actionIds.add(envelope.actionId); state.nextSequence += 1; state.pending = undefined; state.terminal = true; state.failedAttempt = undefined;
        return decision;
      } catch (error) {
        state.failedAttempt = { sequence: observation.sequence, fingerprint, retryUsed: state.failedAttempt?.retryUsed ?? false };
        safeOutputFailure(error);
      }
    } catch (error) {
      safeOutputFailure(error);
    } finally {
      state.inFlight = undefined;
      this.turns.set(observation.turnId, state);
    }
  }

  /** Host-side serialization of a result; this never dispatches the capability. */
  encodeHostCapabilityResult(input: Readonly<{ turnId: string; sequence: number; correlationId: string; actionId: string; name: string; result: unknown }>): Extract<DemoV1Envelope, { kind: 'capability_result' }> {
    try {
      // Detach/validate the host boundary before reading any fields. This
      // makes accessors, prototype pollution, unknown keys, and hostile error
      // text fail with a fixed bridge code rather than escaping.
      const value = plainRecord(input, 'HOST_RESULT_INPUT');
      exactKeys(value, ['turnId', 'sequence', 'correlationId', 'actionId', 'name', 'result'], 'HOST_RESULT_INPUT');
      const normalizedInput = {
        turnId: value.turnId,
        sequence: value.sequence,
        correlationId: value.correlationId,
        actionId: value.actionId,
        name: value.name,
        result: value.result,
      } as Readonly<{ turnId: string; sequence: number; correlationId: string; actionId: string; name: string; result: unknown }>;
      const state = this.turns.get(normalizedInput.turnId);
      if (!state?.pending || state.pending.sequence !== normalizedInput.sequence || state.pending.correlationId !== normalizedInput.correlationId || state.pending.actionId !== normalizedInput.actionId || state.pending.name !== normalizedInput.name) fail('HOST_RESULT_CORRELATION');
      let envelope: Extract<DemoV1Envelope, { kind: 'capability_result' }>;
      try { envelope = resultEnvelope(normalizedInput); } catch { fail('HOST_RESULT_INVALID'); }
      state.pending = undefined;
      return envelope;
    } catch (error) {
      if (error instanceof Error && error.message === 'DEMO_TEXT_BRIDGE_FAILED:HOST_RESULT_CORRELATION') throw error;
      fail('HOST_RESULT_INVALID');
    }
  }
}

export { DemoTextToolBridge as V2DemoTextToolBridge };
