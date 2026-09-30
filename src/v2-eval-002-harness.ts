import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { DemoTextToolBridge } from './v2-demo-text-tool-bridge.js';
import { NativeToolTransport } from './v2-native-tool-transport.js';
import { compareTransportSemanticParity } from './v2-transport-semantic-oracle.js';
import { normalizeAgentDecision, type AgentObservation, type TurnTrace } from './v2-agent-model-transport.js';

const observation: AgentObservation = {
  turnId: 'eval-002-turn-001',
  sequence: 1,
  context: {
    accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'eval-002-message-001',
    workItem: { id: 'eval-002-work-item', revision: 3, state: 'DRAFTING' },
    orderDraft: { id: 'eval-002-draft', revision: 2, state: 'CURRENT' },
    provenance: { sourceMessageId: 'eval-002-message-001', evidenceRefs: ['eval-002-erp-evidence-001'] },
  },
  availableCapabilities: [],
  completedActions: [],
};

const plan = {
  turnId: observation.turnId, intent: 'ACKNOWLEDGE' as const, connectiveText: 'Thank you.',
  factClaims: [], outboundPurpose: 'acknowledgement' as const,
};

function streamFor(message: unknown) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message: message as any });
  return stream;
}

function assistantMessage() {
  return { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(plan) }], stopReason: 'stop' };
}

function demoModel(prompt: string) {
  const request = (JSON.parse(prompt) as { expected: { turnId: string; sequence: number; correlationId: string; actionId: string } }).expected;
  return Promise.resolve({
    text: JSON.stringify({ protocolVersion: 'v1', ...request, kind: 'final_response', responsePlan: plan }),
    inputBudget: { direction: 'input' as const, bytes: Buffer.byteLength(prompt), tokenCount: 1 },
    outputBudget: { direction: 'output' as const, bytes: Buffer.byteLength(JSON.stringify({ protocolVersion: 'v1', ...request, kind: 'final_response', responsePlan: plan })), tokenCount: 1 },
  });
}

function trace(decision: Awaited<ReturnType<NativeToolTransport['decide']>>, mode: string): TurnTrace {
  return {
    turnId: observation.turnId, decision, evidence: [], stateChanges: [], outboundDisposition: 'RUNTIME_RESPONSE',
    grounding: null, terminal: { status: 'TERMINAL', reasonCode: 'PI_FINAL_PENDING_GROUNDING' },
    wire: { requestId: `${mode}-eval-002` }, provider: { providerName: 'deterministic-test-double' },
  };
}

export async function runV2Eval002() {
  const native = new NativeToolTransport({ model: {} as any, stream: () => streamFor(assistantMessage()), id: 'eval-002-native' });
  const demo = new DemoTextToolBridge({ model: demoModel, measureInput: prompt => ({ direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 }), id: 'eval-002-demo' });
  const nativeDecision = await native.decide(observation);
  const demoDecision = await demo.decide(observation);
  const nativeTrace = trace(nativeDecision, native.mode);
  const demoTrace = trace(demoDecision, demo.mode);
  const parity = compareTransportSemanticParity(nativeTrace, demoTrace);
  const state = observation.context;
  return {
    evaluation: 'V2-EVAL-002', status: parity.equal ? 'PASS' : 'FAIL',
    transports: [{ id: native.id, mode: native.mode }, { id: demo.id, mode: demo.mode }],
    parity: { ...parity, nativeDecision: normalizeAgentDecision(nativeDecision), demoDecision: normalizeAgentDecision(demoDecision) },
    captured: { state, provenance: (state as any).provenance, terminal: nativeTrace.terminal, outboundDisposition: nativeTrace.outboundDisposition },
    safety: { v2CustomerTraffic: 'OFF', aiCutoff: 'SALES_ORDER.DRAFT', liveProviders: false, qrWhatsApp: false, salesOrderPostConfirmDo: false },
  };
}
