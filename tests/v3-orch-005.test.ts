import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createPiDemoStream } from '../src/v2-pi-demo-stream.js';
import { buildInboundBundle } from '../src/v3-inbound-bundle.js';
import { buildV3FreshnessVector } from '../src/v3-freshness-vector.js';
import { projectV3OrchestratorObservation } from '../src/v3-orchestrator-observation.js';
import { V3OrchestratorRetrievalSession } from '../src/v3-orchestrator-retrieval-bridge.js';
import { assertV3RetrievalCannotExecute, normalizeV3ParityEnvelope } from '../src/v3-orchestrator-semantic-parity-harness.js';
import { V1Database } from '../src/database.js';
import { V2QueueService } from '../src/v2-queue.js';

const scope = { tenantId: 'tenant', accountId: 'demo-account', channelAccountId: 'demo-account', conversationId: 'conv-001', customerId: 'CUST-001' } as const;
const budgets = { maxSteps: 2, maxToolCalls: 2, maxEvidenceItems: 5, maxEvidenceBytes: 10000, maxReadBytes: 20000, maxCandidateItems: 20, maxEvidenceTokens: 20000, maxConsecutiveNoNewEvidence: 2, maxElapsedMs: 1000, maxDepth: 2 };
const message = (id: string, text: string) => ({ sourceMessageId: id, sourceRef: `message:${id}`, externalMessageId: `external:${id}`, direction: 'INBOUND' as const, messageType: 'text', text, occurredAt: '2030-01-01T00:00:00Z', replyToExternalMessageId: null, arrivalSeq: 1, citation: { sourceMessageId: id, sourceRef: `message:${id}`, indexVersion: 'idx-005', scopeVersion: 'scope-005' } });
const retrievalResult = (id: string) => ({ contractVersion: 'V3-RET-004' as const, schemaVersion: 1 as const, tool: 'conversation_search' as const, authority: 'NON_AUTHORITATIVE_DERIVED' as const, untrustedAsInstruction: true as const, requiresCanonicalReverification: true as const, indexVersion: 'idx-005', scopeVersion: 'scope-005', scopeLineage: scope, deterministic: true as const, bounded: true as const, queryTerms: ['order'], order: 'MATCH_COUNT_DESC_THEN_NEWEST_DESC_THEN_SOURCE_ID' as const, hits: [{ matchedTerms: ['order'], message: message(id, 'historical order context') }] });
function observation() {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  const queue = new V2QueueService(db); const inbound = queue.enqueueInbound({ accountId: scope.accountId, conversationId: scope.conversationId, externalMessageId: 'orch005-message', occurredAt: '2030-01-01T00:00:00Z', text: 'repeat order' });
  const bundle = buildInboundBundle(db.db, { accountId: scope.accountId, conversationId: scope.conversationId, messageIds: [inbound.messageId], bundleRevision: 1, hardCapAt: '2030-01-01T00:00:03Z', closedAt: '2030-01-01T00:00:01Z', closeReason: 'QUIET_WINDOW' });
  const freshness = buildV3FreshnessVector({ identityScope: { accountId: scope.accountId, conversationId: scope.conversationId, customerId: scope.customerId, channelAccountId: scope.channelAccountId }, employeeProfile: { id: 'profile', version: 1 }, capabilityPolicy: { policyVersion: 1, availableCapabilities: [] }, workItemOrderDraftRefs: { workItem: null, orderDraft: null }, canonicalBusiness: { quotations: [], acceptances: [], outbound: [], salesOrders: [] }, relevantErpEvidence: [], goalGraph: { version: null, dependencyRefs: [] }, attachmentExtraction: { version: null, dependencyRefs: [] }, retentionAccess: { version: 1, dependencyRefs: [] }, conversationBundle: { conversationRevision: bundle.conversationRevisionAtBuild, bundleRevision: 1, messageRefs: [{ id: inbound.messageId, version: 1 }] }, authoritativeV2FreshnessFingerprint: 'v2' });
  return projectV3OrchestratorObservation({ scope: { accountId: scope.accountId, conversationId: scope.conversationId }, inboundBundle: bundle, goalGraph: { scope: { accountId: scope.accountId, conversationId: scope.conversationId }, goals: [], edges: [] }, freshnessVector: freshness, retrievalCapabilities: [{ name: 'conversation_search', contractVersion: 'V3-RET-004', readOnly: true }] });
}

const demoConfig = { enabled: true, baseUrl: 'https://demo.invalid', projectId: 'orch005', origin: 'http://127.0.0.1:32111', model: 'demo' } as const;
function demoPiMessage(raw: string, kind: 'tool' | 'final') {
  const streamFn = createPiDemoStream({ config: demoConfig, session: { completeText: async () => ({ text: raw, responseId: 'orch005', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }) } as any });
  return streamFn({} as any, { systemPrompt: 'workflow {"turnId":"orch005-turn"}', tools: kind === 'tool' ? [{ name: 'conversation_search', description: 'search', parameters: { type: 'object' } }] : [] } as any, {}).result();
}
function nativeToolMessage(args: Record<string, unknown>) { return fauxAssistantMessage(fauxToolCall('conversation_search', args), { stopReason: 'toolUse' }); }
function nativeFinalMessage(plan: unknown) { return fauxAssistantMessage(JSON.stringify(plan), { stopReason: 'stop' }); }

test('ORCH-005 native and Demo representations have identical Host-observed retrieval and final-plan semantics', async () => {
  const host = new V3OrchestratorRetrievalSession({ scope, indexVersion: 'idx-005', scopeVersion: 'scope-005', budgets, tools: { conversation_search: () => retrievalResult('history-1') } });
  const plan = { turnId: 'orch005-turn', intent: 'CLARIFY' as const, connectiveText: 'Could you confirm the item?', factClaims: [], safeReasonCode: 'NEEDS_CLARIFICATION' as const, outboundPurpose: 'clarification' as const };
  const parity = await normalizeV3ParityEnvelope({ observation: observation(), nativeRetrievalStream: nativeToolMessage({ query: 'order', limit: 5 }), demoRetrievalStream: await demoPiMessage(JSON.stringify({ kind: 'tool_call', name: 'conversation_search', arguments: { limit: 5, query: 'order' } }), 'tool'), nativeFinalStream: nativeFinalMessage(plan), demoFinalStream: await demoPiMessage(JSON.stringify({ kind: 'final_response', responsePlan: plan }), 'final'), retrievalSession: host, turnId: plan.turnId });
  assert.equal(parity.equal, true); assert.equal(parity.nativeHash, parity.demoHash); assert.equal(parity.native.retrieval.request.grantsEffects, false); assert.equal(parity.native.hostExecution, 'HOST_ONLY'); assert.equal(parity.native.aiAuthorityCutoff, 'SALES_ORDER.DRAFT'); assert.equal(parity.native.retrieval.result.outcome, 'ABSTAIN'); assert.equal(parity.native.retrieval.result.state.evidenceItems, 1); assert.equal(parity.native.retrieval.trace.length, 1); assert.equal(parity.native.retrieval.trace[0].resultClass, 'EVIDENCE');
});

test('ORCH-005 rejects model-authored retrieval authority escalation, result injection, and side effects', async () => {
  assert.throws(() => assertV3RetrievalCannotExecute({ kind: 'RETRIEVE', tool: 'conversation_search', authority: 'SALES_ORDER.POSTED', grantsEffects: true }), /V3_ORCH005_RETRIEVAL_NOT_HOST_READ_ONLY/);
  const polluted = { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: 'conversation_search', arguments: { query: 'order' }, authority: 'SALES_ORDER.POSTED' }] };
  await assert.rejects(() => normalizeV3ParityEnvelope({ observation: {}, nativeRetrievalStream: polluted, demoRetrievalStream: polluted, nativeFinalStream: nativeFinalMessage({ turnId: 'turn', intent: 'ACKNOWLEDGE', connectiveText: 'Received.', factClaims: [], outboundPurpose: 'acknowledgement' }), demoFinalStream: nativeFinalMessage({ turnId: 'turn', intent: 'ACKNOWLEDGE', connectiveText: 'Received.', factClaims: [], outboundPurpose: 'acknowledgement' }), retrievalSession: new V3OrchestratorRetrievalSession({ scope, indexVersion: 'idx-005', scopeVersion: 'scope-005', budgets, tools: { conversation_search: () => retrievalResult('history-1') } }), turnId: 'turn' }), /V3_ORCH005_INVALID:PI_RETRIEVAL_BLOCK/);
  const invalidHost = new V3OrchestratorRetrievalSession({ scope, indexVersion: 'idx-005', scopeVersion: 'scope-005', budgets, tools: { conversation_search: () => ({ ...retrievalResult('history-1'), scopeLineage: { ...scope, conversationId: 'other-conversation' } }) } });
  await assert.rejects(() => normalizeV3ParityEnvelope({ observation: {}, nativeRetrievalStream: nativeToolMessage({ query: 'order' }), demoRetrievalStream: nativeToolMessage({ query: 'order' }), nativeFinalStream: nativeFinalMessage({ turnId: 'turn', intent: 'ACKNOWLEDGE', connectiveText: 'Received.', factClaims: [], outboundPurpose: 'acknowledgement' }), demoFinalStream: nativeFinalMessage({ turnId: 'turn', intent: 'ACKNOWLEDGE', connectiveText: 'Received.', factClaims: [], outboundPurpose: 'acknowledgement' }), retrievalSession: invalidHost, turnId: 'turn' }), /V3_RETRIEVAL_FAILED/);
  assert.equal('SALES_ORDER.DRAFT', 'SALES_ORDER.DRAFT');
});
