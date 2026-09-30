import { canonicalSha256 } from './v2-canonical.js';
import { validateGroundedResponsePlan, type GroundedResponsePlan } from './v2-grounded-response-plan.js';
import { V3_RETRIEVAL_LOOP_TOOLS, type V3RetrievalLoopOutcome, type V3RetrievalLoopToolName } from './v3-retrieval-loop.js';
import { V3OrchestratorRetrievalSession, type V3OrchestratorRetrievalTrace } from './v3-orchestrator-retrieval-bridge.js';

export type V3ParityEnvelope = Readonly<{
  observation: unknown;
  retrieval: Readonly<{ request: Readonly<{ contractVersion: 'V3-RET-006'; schemaVersion: 1; kind: 'RETRIEVE'; tool: V3RetrievalLoopToolName; arguments: Readonly<Record<string, unknown>>; authority: 'NON_AUTHORITATIVE_DERIVED'; grantsEffects: false }>; result: V3RetrievalLoopOutcome; trace: readonly V3OrchestratorRetrievalTrace[] }>;
  finalPlan: GroundedResponsePlan;
}>;

export type V3ParityProjection = Readonly<{
  observation: unknown;
  retrieval: V3ParityEnvelope['retrieval'];
  finalPlan: GroundedResponsePlan;
  aiAuthorityCutoff: 'SALES_ORDER.DRAFT';
  hostExecution: 'HOST_ONLY';
}>;

const tools = new Set<string>(V3_RETRIEVAL_LOOP_TOOLS);
const ownKeys = (value: unknown, expected: readonly string[], code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`V3_ORCH005_INVALID:${code}`);
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index])) throw new Error(`V3_ORCH005_INVALID:${code}`);
  return value as Record<string, unknown>;
};

type PiStreamMessage = Readonly<{ content: readonly unknown[] }>;

function piContent(value: unknown, code: string): readonly unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as PiStreamMessage).content)) throw new Error(`V3_ORCH005_INVALID:${code}`);
  return (value as PiStreamMessage).content;
}

/** Reads the actual Pi AssistantMessage boundary shared by native providers and createPiDemoStream. */
function retrievalStream(value: unknown): Readonly<{ tool: V3RetrievalLoopToolName; arguments: Readonly<Record<string, unknown>> }> {
  const content = piContent(value, 'PI_RETRIEVAL_MESSAGE');
  if (content.length !== 1) throw new Error('V3_ORCH005_INVALID:PI_RETRIEVAL_MESSAGE');
  const item = content[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('V3_ORCH005_INVALID:PI_RETRIEVAL_BLOCK');
  const block = item as Record<string, unknown>;
  const actual = Object.keys(block).sort(), expected = ['arguments', 'id', 'name', 'type'];
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error('V3_ORCH005_INVALID:PI_RETRIEVAL_BLOCK');
  if (block.type !== 'toolCall' || typeof block.id !== 'string' || typeof block.name !== 'string' || !tools.has(block.name)) throw new Error('V3_ORCH005_INVALID:RETRIEVAL_TOOL');
  const args = ownKeys(block.arguments, Object.keys(block.arguments as object), 'RETRIEVAL_ARGUMENTS');
  return { tool: block.name as V3RetrievalLoopToolName, arguments: args };
}

function finalStream(value: unknown, turnId: string): GroundedResponsePlan {
  const content = piContent(value, 'PI_FINAL_MESSAGE');
  if (content.length !== 1) throw new Error('V3_ORCH005_INVALID:PI_FINAL_MESSAGE');
  const item = content[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('V3_ORCH005_INVALID:PI_FINAL_BLOCK');
  const block = item as Record<string, unknown>;
  const actual = Object.keys(block).sort(), expected = ['text', 'type'];
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) || block.type !== 'text' || typeof block.text !== 'string') throw new Error('V3_ORCH005_INVALID:PI_FINAL_BLOCK');
  let plan: unknown;
  try { plan = JSON.parse(block.text); } catch { throw new Error('V3_ORCH005_INVALID:PI_FINAL_JSON'); }
  return finalPlan(plan, turnId);
}

function finalPlan(value: unknown, turnId: string): GroundedResponsePlan {
  return validateGroundedResponsePlan(value, turnId);
}

export async function normalizeV3ParityEnvelope(input: Readonly<{ observation: unknown; nativeRetrievalStream: unknown; demoRetrievalStream: unknown; nativeFinalStream: unknown; demoFinalStream: unknown; retrievalSession: V3OrchestratorRetrievalSession; turnId: string }>): Promise<Readonly<{ native: V3ParityProjection; demo: V3ParityProjection; equal: boolean; nativeHash: string; demoHash: string }>> {
  const nativeRetrieval = retrievalStream(input.nativeRetrievalStream);
  const demoRetrieval = retrievalStream(input.demoRetrievalStream);
  if (nativeRetrieval.tool !== demoRetrieval.tool || canonicalSha256(nativeRetrieval.arguments) !== canonicalSha256(demoRetrieval.arguments)) throw new Error('V3_ORCH005_INVALID:RETRIEVAL_SEMANTIC_MISMATCH');
  const plan = finalStream(input.nativeFinalStream, input.turnId);
  const demoPlan = finalStream(input.demoFinalStream, input.turnId);
  if (canonicalSha256(plan) !== canonicalSha256(demoPlan)) throw new Error('V3_ORCH005_INVALID:FINAL_PLAN_MISMATCH');
  const retrievalResult = await input.retrievalSession.execute(nativeRetrieval.tool, nativeRetrieval.arguments) as V3RetrievalLoopOutcome;
  const retrieval = { request: { contractVersion: 'V3-RET-006' as const, schemaVersion: 1 as const, kind: 'RETRIEVE' as const, tool: nativeRetrieval.tool, arguments: nativeRetrieval.arguments, authority: 'NON_AUTHORITATIVE_DERIVED' as const, grantsEffects: false as const }, result: retrievalResult, trace: input.retrievalSession.traces() };
  const projection = (final: GroundedResponsePlan): V3ParityProjection => ({ observation: input.observation, retrieval, finalPlan: final, aiAuthorityCutoff: 'SALES_ORDER.DRAFT', hostExecution: 'HOST_ONLY' });
  const native = projection(plan), demo = projection(demoPlan);
  const nativeHash = canonicalSha256(native), demoHash = canonicalSha256(demo);
  return { native, demo, equal: nativeHash === demoHash, nativeHash, demoHash };
}

export function assertV3RetrievalCannotExecute(input: unknown): void {
  const item = ownKeys(input, ['authority', 'grantsEffects', 'kind', 'tool'], 'MODEL_RETRIEVAL_RESULT');
  if (item.kind !== 'RETRIEVE' || item.authority !== 'NON_AUTHORITATIVE_DERIVED' || item.grantsEffects !== false || typeof item.tool !== 'string' || !tools.has(item.tool)) throw new Error('V3_ORCH005_RETRIEVAL_NOT_HOST_READ_ONLY');
}
