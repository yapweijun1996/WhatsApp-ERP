import assert from 'node:assert/strict';
import {test} from 'node:test';
import {V1Database} from '../src/database.js';
import {V3GoalGraphStore} from '../src/v3-goal-graph.js';
import {buildConversationGoal} from '../src/v3-conversation-goal.js';
import {validateGroundedResponsePlan, type GroundedResponsePlan} from '../src/v2-grounded-response-plan.js';
import {validateV3FulfillmentGate} from '../src/v3-fulfillment-gate.js';

const scope = {accountId: 'demo-account', conversationId: 'conv-001'} as const;
const base = {turnId: 'ful-002-turn', intent: 'ANSWER' as const, connectiveText: 'I can help.', factClaims: [], outboundPurpose: 'customer_reply' as const};
const goal = (goalId: string, status: 'OPEN'|'IN_PROGRESS'|'FULFILLED'|'SUPERSEDED'|'CANCELLED' = 'OPEN') => buildConversationGoal({
  goalId, ...scope, sourceMessageIds: [`message-${goalId}`], sourceAttachmentIds: [], erpObjectRefs: [],
  parentGoalId: null, dependsOnGoalIds: [], relatedGoalIds: [], description: `goal ${goalId}`, status,
  createdBy: 'AGENT', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:01.000Z', fulfillmentEvidenceRefs: [],
});
function fixture(statuses: Array<['a'|'b'|'terminal', Parameters<typeof goal>[1]]>) {
  const database = new V1Database(':memory:'); database.resetAndSeed(); const store = new V3GoalGraphStore(database);
  statuses.forEach(([id, status], index) => {
    const createdAt = `2026-09-19T00:00:0${2 + index * 2}.000Z`;
    store.appendGoalEvent({scope, eventId: `event-${id}`, goal: goal(id), eventType: 'CREATED', idempotencyKey: `key-${id}`, createdAt});
    if (status !== 'OPEN') store.appendGoalEvent({scope, eventId: `event-${id}-update`, goal: goal(id, status), eventType: status === 'SUPERSEDED' ? 'SUPERSEDED' : status === 'CANCELLED' ? 'CANCELLED' : 'UPDATED', idempotencyKey: `key-${id}-update`, createdAt: `2026-09-19T00:00:0${3 + index * 2}.000Z`});
  });
  return {database, store};
}
function plan(dispositions: unknown[]): GroundedResponsePlan {
  return validateGroundedResponsePlan({...base, goalDispositions: dispositions}, base.turnId);
}
const open = (goalId: string, disposition: string = 'FULFILLED', evidence = true) => ({goalId, disposition, capabilityEvidenceRefs: evidence ? ['cap-1'] : [], groundingRefs: evidence ? ['ground-1'] : [], ...(disposition === 'STILL_IN_PROGRESS' || disposition === 'WAITING_EXTERNAL' ? {continuationRef: 'continuation-1'} : {})});

test('FUL-002 accepts exact disposition coverage for every active goal', () => {
  const {database, store} = fixture([['a', 'OPEN'], ['b', 'IN_PROGRESS']]);
  assert.doesNotThrow(() => validateV3FulfillmentGate({goalGraphStore: store, scope, plan: plan([open('a'), open('b', 'NEEDS_CLARIFICATION', false)])})); database.db.close();
});
test('FUL-002 rejects a missing active goal disposition', () => {
  const {database, store} = fixture([['a', 'OPEN'], ['b', 'OPEN']]);
  assert.throws(() => validateV3FulfillmentGate({goalGraphStore: store, scope, plan: plan([open('a')])}), /MISSING_GOAL_DISPOSITION:b/); database.db.close();
});
test('FUL-002 rejects unknown and terminal-only dispositions', () => {
  const unknown = fixture([['a', 'OPEN']]);
  assert.throws(() => validateV3FulfillmentGate({goalGraphStore: unknown.store, scope, plan: plan([open('a'), open('missing')])}), /EXTRA_GOAL_DISPOSITION:missing/); unknown.database.db.close();
  const terminal = fixture([['a', 'OPEN'], ['terminal', 'SUPERSEDED']]);
  assert.throws(() => validateV3FulfillmentGate({goalGraphStore: terminal.store, scope, plan: plan([open('a'), open('terminal')])}), /TERMINAL_GOAL_DISPOSITION:terminal/); terminal.database.db.close();
});
test('FUL-002 requires both evidence classes only for FULFILLED', () => {
  const grounding = fixture([['a', 'OPEN']]);
  assert.throws(() => validateV3FulfillmentGate({goalGraphStore: grounding.store, scope, plan: plan([{...open('a'), groundingRefs: []}])}), /MISSING_GROUNDING_EVIDENCE:a/); grounding.database.db.close();
  const capability = fixture([['a', 'OPEN']]);
  assert.throws(() => validateV3FulfillmentGate({goalGraphStore: capability.store, scope, plan: plan([{...open('a'), capabilityEvidenceRefs: []}])}), /MISSING_CAPABILITY_EVIDENCE:a/); capability.database.db.close();
  const allowed = fixture([['a', 'OPEN']]);
  assert.doesNotThrow(() => validateV3FulfillmentGate({goalGraphStore: allowed.store, scope, plan: plan([open('a', 'NEEDS_CLARIFICATION', false)])})); allowed.database.db.close();
});
test('FUL-002 fails closed on graph scope errors', () => {
  const {database, store} = fixture([['a', 'OPEN']]);
  assert.throws(() => validateV3FulfillmentGate({goalGraphStore: store, scope: {accountId: 'other', conversationId: scope.conversationId}, plan: plan([open('a')])}), /V3_GOAL_GRAPH_SCOPE/); database.db.close();
});
