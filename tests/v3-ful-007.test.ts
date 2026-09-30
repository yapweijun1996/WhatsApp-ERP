import assert from 'node:assert/strict';
import { test } from 'node:test';
import { V1Database } from '../src/database.js';
import { OutboundMessageService } from '../src/outbound-message-service.js';
import { AgentTurnCoordinator } from '../src/v2-agent-turn-coordinator.js';
import { validateGroundedResponsePlan, type GroundedResponsePlan } from '../src/v2-grounded-response-plan.js';
import { buildConversationGoal } from '../src/v3-conversation-goal.js';
import { V3GoalGraphStore } from '../src/v3-goal-graph.js';
import { V3GoalProposalHost } from '../src/v3-goal-proposal.js';
import { V3DurableContinuationStore } from '../src/v3-durable-continuation.js';
import { releaseV3Fulfillment } from '../src/v3-fulfillment-release.js';
import { projectAdaptiveInboundBundles } from '../src/v3-inbound-bundle.js';
import { scriptedSemanticAgentFactory } from './semantic-agent.js';
import { GOLDEN_LINES, goldenOffer } from './semantic-agent.js';

const scope = { accountId: 'demo-account', conversationId: 'conv-001' } as const;
const now = '2026-09-20T00:00:00.000Z';

function fixture(goalStatus: 'OPEN' | 'WAITING_EXTERNAL' = 'OPEN') {
  const database = new V1Database(':memory:');
  database.resetAndSeed();
  database.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run('m-007', scope.conversationId, 'm-007', 'INBOUND', 'TEXT', 'opaque multilingual order bubbles', 'customer', scope.accountId, now);
  database.db.prepare("INSERT INTO work_items(id,account_id,conversation_id,customer_id,type,state,revision,goal_summary,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run('wi-007', scope.accountId, scope.conversationId, 'CUST-001', 'SALES_ORDER_REQUEST', 'DRAFTING', 1, 'order', 'm-007', now, now);
  const host = new V3GoalProposalHost(database);
  const goal = buildConversationGoal({ goalId: 'goal-007', ...scope, sourceMessageIds: ['m-007'], sourceAttachmentIds: [], erpObjectRefs: [], parentGoalId: null, dependsOnGoalIds: [], relatedGoalIds: [], description: 'opaque', status: 'OPEN', createdBy: 'AGENT', createdAt: now, updatedAt: now, fulfillmentEvidenceRefs: [] });
  host.admit({ scope, operation: 'CREATE', expected: { goalId: null, revision: null, status: null }, goal }, { proposalId: 'p-007', idempotencyKey: 'p-007', createdAt: now });
  const secondary = buildConversationGoal({ ...goal, goalId: 'goal-007-secondary', description: 'secondary concurrent goal', sourceMessageIds: ['m-007'], updatedAt: now });
  host.admit({ scope, operation: 'CREATE', expected: { goalId: null, revision: null, status: null }, goal: secondary }, { proposalId: 'p-007-secondary', idempotencyKey: 'idem-test-1', createdAt: now });
  if (goalStatus === 'WAITING_EXTERNAL') host.admit({ scope, operation: 'UPDATE', expected: { goalId: 'goal-007', revision: 1, status: 'OPEN' }, goal: { ...goal, status: goalStatus, updatedAt: '2026-09-20T00:00:01.000Z' } }, { proposalId: 'p-007-wait', idempotencyKey: 'p-007-wait', createdAt: '2026-09-20T00:00:01.000Z' });
  const turn = new AgentTurnCoordinator(database).start({ accountId: scope.accountId, conversationId: scope.conversationId, inboundMessageId: 'm-007', profileId: 'sales-digital-employee', nowIso: now, timezone: 'UTC' });
  return { database, graph: new V3GoalGraphStore(database), continuation: new V3DurableContinuationStore(database), turnId: turn.turnId };
}

function plan(turnId: string, disposition: 'FULFILLED' | 'WAITING_EXTERNAL' = 'FULFILLED'): GroundedResponsePlan {
  const primary = { goalId: 'goal-007', disposition, capabilityEvidenceRefs: disposition === 'FULFILLED' ? ['cap-1'] : [], groundingRefs: disposition === 'FULFILLED' ? ['ground-1'] : [], ...(disposition === 'WAITING_EXTERNAL' ? { continuationRef: 'missing-continuation' } : {}) };
  return validateGroundedResponsePlan({ turnId, intent: 'ANSWER', connectiveText: '已处理。', factClaims: [], outboundPurpose: 'customer_reply', goalDispositions: [primary, { goalId: 'goal-007-secondary', disposition: 'FULFILLED', capabilityEvidenceRefs: ['cap-2'], groundingRefs: ['ground-2'] }], deliveryUnits: [{ deliveryUnitId: 'u-1', unitType: 'TEXT_BUBBLE', text: '已处理。', purpose: 'customer_reply' }] }, turnId);
}

function stored(f: ReturnType<typeof fixture>, p: GroundedResponsePlan) {
  new AgentTurnCoordinator(f.database).completeWithResponsePlan(f.turnId, p);
}

test('G1 composes eight rapid bubbles into one semantic goal and released response plan', async () => {
  const f = fixture();
  const bubbles = ['Need Ayam whole, 10 CTN', 'red one five cartons', 'delivery Friday please', 'boleh quote sekali', 'also list available items', 'same customer account', 'one quotation for all', 'terima kasih'];
  const arrivals = bubbles.map((_, index) => ({ messageId: `g1-bubble-${index + 1}`, arrivalSeq: index + 1, arrivedAt: `2030-01-01T00:00:00.${String(index * 100).padStart(3, '0')}Z` }));
  const rows = arrivals;
  const bundles = projectAdaptiveInboundBundles(rows);
  assert.equal(bundles.length, 1);
  assert.deepEqual(bundles[0].messageIds, arrivals.map((arrival) => arrival.messageId));
  const semantic = scriptedSemanticAgentFactory([goldenOffer('2030-01-03')]);
  let semanticRuns = 0;
  const result = await semantic((intent) => { semanticRuns += 1; assert.equal(intent.intent, 'offer_quote'); return Promise.resolve(); }).run(bubbles.join(' '));
  assert.equal(semanticRuns, 1);
  assert.equal(result.lines?.length, 2);
  assert.equal(result.requestedDeliveryDate, '2030-01-03');
  const response = plan(f.turnId);
  stored(f, response);
  let sends = 0;
  const released = await releaseV3Fulfillment({ ...scope, turnId: f.turnId, plan: response, scope, goalGraphStore: f.graph, continuationStore: f.continuation, outbound: new OutboundMessageService(f.database, { send: async message => { sends += 1; return { status: 'submitted', externalMessageId: message.clientMessageId, submittedAt: now }; }, reconcile: async () => ({ status: 'unknown' }) } as any) });
  assert.equal(released[0].status, 'SUBMITTED');
  assert.equal(sends, 1);
  f.database.db.close();
});

test('G14 mixed-language bubbles produce one coherent semantic goal and result', async () => {
  const f = fixture();
  const bubbles = ['要 10 CTN ayam', 'red one 五箱', 'Friday delivery boleh?', 'please quote dulu'];
  const semantic = scriptedSemanticAgentFactory([goldenOffer('2030-01-03')]);
  let runs = 0;
  const result = await semantic((intent) => { runs += 1; assert.equal(intent.intent, 'offer_quote'); return Promise.resolve(); }).run(bubbles.join(' | '));
  assert.equal(runs, 1);
  assert.deepEqual(result.lines, GOLDEN_LINES);
  assert.equal(result.requestedDeliveryDate, '2030-01-03');
  const response = plan(f.turnId);
  stored(f, response);
  const released = await releaseV3Fulfillment({ ...scope, turnId: f.turnId, plan: response, scope, goalGraphStore: f.graph, continuationStore: f.continuation, outbound: new OutboundMessageService(f.database, { send: async message => ({ status: 'submitted', externalMessageId: message.clientMessageId, submittedAt: now }), reconcile: async () => ({ status: 'unknown' }) } as any) });
  assert.equal(released[0].status, 'SUBMITTED');
  f.database.db.close();
});

test('FUL-007 releases a complete multi-goal-shaped plan only through the Host gate', async () => {
  const f = fixture(); const p = plan(f.turnId); stored(f, p); let sends = 0;
  const outbound = new OutboundMessageService(f.database, { send: async message => { sends++; return { status: 'submitted', externalMessageId: message.clientMessageId, submittedAt: now }; }, reconcile: async () => ({ status: 'unknown' }) } as any);
  const result = await releaseV3Fulfillment({ ...scope, turnId: f.turnId, plan: p, scope, goalGraphStore: f.graph, continuationStore: f.continuation, outbound });
  assert.equal(result[0].status, 'SUBMITTED'); assert.equal(sends, 1); f.database.db.close();
});

test('FUL-007 rejects empty or unbacked promises before reconciliation/provider activity', async () => {
  const f = fixture(); const p = plan(f.turnId); stored(f, p); let reconciles = 0; let sends = 0;
  const outbound = new OutboundMessageService(f.database, { send: async () => { sends++; return { status: 'submitted', externalMessageId: 'unexpected' }; }, reconcile: async () => { reconciles++; return { status: 'unknown' }; } } as any);
  await assert.rejects(() => releaseV3Fulfillment({ ...scope, turnId: f.turnId, plan: { ...p, deliveryUnits: [] }, scope, goalGraphStore: f.graph, outbound }), /EMPTY_DELIVERY/);
  await assert.rejects(() => releaseV3Fulfillment({ ...scope, turnId: f.turnId, plan: plan(f.turnId, 'WAITING_EXTERNAL'), scope, goalGraphStore: f.graph, continuationStore: f.continuation, outbound }), /CONTINUATION_INVALID/);
  assert.equal(reconciles, 0); assert.equal(sends, 0); f.database.db.close();
});

test('FUL-007 reconnect recovery reconciles UNKNOWN before the same stable delivery can retry', async () => {
  const f = fixture(); const p = plan(f.turnId); stored(f, p); const sent: string[] = []; let first = true;
  const adapter = { send: async (message: any) => { sent.push(message.clientMessageId); if (first) { first = false; throw new Error('crash after provider acceptance'); } return { status: 'submitted', externalMessageId: 'provider-007', submittedAt: now }; }, reconcile: async (input: any) => ({ status: 'not_found' as const, clientMessageId: input.clientMessageId }) };
  const firstOwner = new OutboundMessageService(f.database, adapter as any);
  await assert.rejects(() => releaseV3Fulfillment({ ...scope, turnId: f.turnId, plan: p, scope, goalGraphStore: f.graph, outbound: firstOwner }), /crash after provider acceptance/);
  const restarted = new OutboundMessageService(f.database, adapter as any);
  const result = await releaseV3Fulfillment({ ...scope, turnId: f.turnId, plan: p, scope, goalGraphStore: f.graph, outbound: restarted });
  assert.equal(result[0].status, 'SUBMITTED'); assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]); f.database.db.close();
});
