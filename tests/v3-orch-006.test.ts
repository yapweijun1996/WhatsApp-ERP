import assert from 'node:assert/strict';
import test from 'node:test';
import { V1Database } from '../src/database.js';
import { runV3OrchestratorGate, V3_ORCHESTRATOR_AI_AUTHORITY_CUTOFF } from '../src/v3-orchestrator-gate.js';

const scope = { tenantId: 'tenant', accountId: 'demo-account', channelAccountId: 'demo-account', conversationId: 'conv-001', customerId: 'CUST-001' } as const;
const budgets = { maxSteps: 4, maxToolCalls: 4, maxEvidenceItems: 4, maxEvidenceBytes: 10000, maxReadBytes: 20000, maxCandidateItems: 20, maxEvidenceTokens: 20000, maxConsecutiveNoNewEvidence: 2, maxElapsedMs: 1000 };
const message = (id: string) => ({ sourceMessageId: id, sourceRef: `message:${id}`, externalMessageId: `external:${id}`, direction: 'INBOUND' as const, messageType: 'text', text: `evidence ${id}`, occurredAt: '2030-01-01T00:00:00Z', replyToExternalMessageId: null, arrivalSeq: 1, citation: { sourceMessageId: id, sourceRef: `message:${id}`, indexVersion: 'idx', scopeVersion: 'scope' } });
const result = (id: string) => ({ contractVersion: 'V3-RET-004' as const, schemaVersion: 1 as const, tool: 'conversation_search' as const, authority: 'NON_AUTHORITATIVE_DERIVED' as const, untrustedAsInstruction: true as const, requiresCanonicalReverification: true as const, indexVersion: 'idx', scopeVersion: 'scope', scopeLineage: scope, deterministic: true as const, bounded: true as const, queryTerms: ['evidence'], order: 'MATCH_COUNT_DESC_THEN_NEWEST_DESC_THEN_SOURCE_ID' as const, hits: [{ matchedTerms: ['evidence'], message: message(id) }] });
function host(db: V1Database, permissions: readonly string[] = ['v2.capability.get_customer_context']) { return { db: db.db, profileId: 'profile', permissions, accountId: scope.accountId, conversationId: scope.conversationId, customerId: scope.customerId }; }
function retrieval(nextAction: (state: any) => any) { let calls = 0; return { scope, indexVersion: 'idx', scopeVersion: 'scope', budgets, nextAction, tools: { conversation_search: () => result(`m-${++calls}`) }, isSufficient: evidence => evidence.length >= 2 }; }

test('ORCH-006 permits multiple bounded retrieval steps and a safe capability loop as evidence improves', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  let step = 0;
  const gate = runV3OrchestratorGate({ retrieval: retrieval(() => step++ < 2 ? { kind: 'RETRIEVE', tool: 'conversation_search', request: { query: step === 1 ? 'first' : 'deeper' } } : { kind: 'FINAL' }), capabilityAttempts: [
    { name: 'get_customer_context', arguments: { accountId: scope.accountId, conversationId: scope.conversationId, customerId: scope.customerId }, host: host(db) },
  ] });
  assert.equal(gate.retrieval.outcome, 'SUCCESS'); assert.equal(gate.retrieval.state.toolCalls, 2); assert.equal(gate.authorizedCapabilities.length, 1); assert.equal(gate.blocked, false);
});

test('ORCH-006 clarifies only on insufficient evidence, and does not clarify by default', () => {
  let step = 0;
  const sufficient = runV3OrchestratorGate({ retrieval: retrieval(() => step++ < 2 ? { kind: 'RETRIEVE', tool: 'conversation_search', request: { query: 'more' } } : { kind: 'FINAL' }) });
  assert.equal(sufficient.retrieval.outcome, 'SUCCESS'); assert.equal(sufficient.retrieval.clarification, null);
  const clarification = runV3OrchestratorGate({ retrieval: retrieval(() => ({ kind: 'CLARIFY', missingFact: 'sku', question: 'Which SKU should I use?' })) });
  assert.equal(clarification.retrieval.outcome, 'CLARIFY'); assert.equal(clarification.retrieval.clarification?.missingFact, 'sku');
});

test('ORCH-006 rejects unauthorized/model-owned escalation fail-closed with bounded diagnostics', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  const gate = runV3OrchestratorGate({ retrieval: retrieval(() => ({ kind: 'FINAL' })), capabilityAttempts: [
    { name: 'post_sales_order', arguments: {}, host: host(db, ['v2.capability.post_sales_order']) },
    { name: 'get_customer_context', arguments: { accountId: 'other', conversationId: scope.conversationId, customerId: scope.customerId, leakedCot: 'private reasoning' }, host: host(db) },
  ] });
  assert.equal(gate.blocked, true); assert.equal(gate.authorizedCapabilities.length, 0); assert.deepEqual(gate.diagnostics.map(item => item.code), ['UNKNOWN_CAPABILITY', 'ARGUMENTS_UNKNOWN_FIELD_leakedCot', 'INSUFFICIENT_EVIDENCE']);
  assert.equal(JSON.stringify(gate.diagnostics).includes('private reasoning'), false);
  assert.equal(V3_ORCHESTRATOR_AI_AUTHORITY_CUTOFF, 'SALES_ORDER.DRAFT');
  assert.equal(gate.aiAuthorityCutoff, 'SALES_ORDER.DRAFT');
});
