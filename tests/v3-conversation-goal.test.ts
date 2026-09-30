import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationGoal, validateConversationGoal, CONVERSATION_GOAL_STATUSES } from '../src/v3-conversation-goal.js';

const base = () => ({ goalId: 'goal-opaque', accountId: 'account-a', conversationId: 'conversation-a', sourceMessageIds: ['message-opaque'], sourceAttachmentIds: ['attachment-opaque'], erpObjectRefs: [{ objectType: 'QUOTE', objectId: 'erp-opaque', accountId: 'account-a', conversationId: 'conversation-a' }], parentGoalId: null, dependsOnGoalIds: [], relatedGoalIds: [], description: 'opaque obligation', status: 'OPEN' as const, createdBy: 'AGENT' as const, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:01.000Z', fulfillmentEvidenceRefs: ['evidence-opaque'] });

test('builds the closed, valid, non-authoritative contract', () => { const goal = buildConversationGoal(base()); assert.equal(goal.status, 'OPEN'); assert.equal(goal.authority, 'NON_AUTHORITATIVE_DERIVED'); assert.equal(goal.aiAuthorityCutoff, 'SALES_ORDER.DRAFT'); assert.equal(goal.createdBy, 'AGENT'); });
test('accepts every architecture status', () => { for (const status of CONVERSATION_GOAL_STATUSES) assert.equal(buildConversationGoal({ ...base(), status }).status, status); });
test('rejects extras, missing fields, bad versions, and authority widening', () => { const valid = buildConversationGoal(base()); for (const mutation of [() => ({ ...valid, unexpected: 1 }), () => { const x = { ...valid }; delete (x as any).description; return x; }, () => ({ ...valid, authority: 'CANONICAL_COMMERCE' }), () => ({ ...valid, aiAuthorityCutoff: 'SALES_ORDER.POSTED' })]) assert.throws(() => validateConversationGoal(mutation()), /V3_CONVERSATION_GOAL_INVALID/); });
test('accepts empty optional provenance and rejects empty source-message provenance', () => { const valid = base(); valid.sourceAttachmentIds = []; valid.erpObjectRefs = []; valid.fulfillmentEvidenceRefs = []; const goal = buildConversationGoal(valid); assert.deepEqual(goal.sourceAttachmentIds, []); assert.deepEqual(goal.erpObjectRefs, []); assert.deepEqual(goal.fulfillmentEvidenceRefs, []); assert.throws(() => buildConversationGoal({ ...valid, sourceMessageIds: [] }), /SOURCE_MESSAGES_EMPTY/); });
test('rejects accessors, polluted prototypes, unsafe arrays, and malformed provenance', () => { const valid = buildConversationGoal(base()); const getter = { ...valid }; let getterCalls = 0; Object.defineProperty(getter, 'description', { enumerable: true, get: () => { getterCalls += 1; return 'unsafe'; } }); assert.throws(() => validateConversationGoal(getter), /INVALID/); assert.equal(getterCalls, 0); const buildGetter = { ...base() }; Object.defineProperty(buildGetter, 'description', { enumerable: true, get: () => { getterCalls += 1; return 'unsafe'; } }); assert.throws(() => buildConversationGoal(buildGetter as any), /INVALID/); assert.equal(getterCalls, 0); const polluted = Object.create({ polluted: true }); Object.assign(polluted, valid); assert.throws(() => validateConversationGoal(polluted), /INVALID/); assert.throws(() => buildConversationGoal(polluted as any), /INVALID/); for (const field of ['sourceMessageIds', 'sourceAttachmentIds', 'fulfillmentEvidenceRefs']) for (const value of [[''], ['same', 'same'], Object.assign([], { extra: 'x' })]) assert.throws(() => validateConversationGoal({ ...valid, [field]: value }), /INVALID/); });
test('rejects scope mismatch and invalid ERP provenance', () => { const valid = buildConversationGoal(base()); assert.throws(() => validateConversationGoal({ ...valid, erpObjectRefs: [{ ...valid.erpObjectRefs[0], accountId: 'other-account' }] }), /ERP_SCOPE/); assert.throws(() => validateConversationGoal({ ...valid, erpObjectRefs: [{ ...valid.erpObjectRefs[0], unexpected: 'x' }] }), /INVALID/); assert.throws(() => validateConversationGoal({ ...valid, erpObjectRefs: [{ ...valid.erpObjectRefs[0], objectId: valid.erpObjectRefs[0].objectId }, valid.erpObjectRefs[0]] }), /INVALID/); });
test('rejects hidden and symbol own-key extras at every closed boundary without invoking accessors', () => {
  const valid = buildConversationGoal(base());
  const symbol = Symbol('hidden-extra');
  let getterCalls = 0;
  const topLevel = { ...valid };
  Object.defineProperty(topLevel, 'hiddenExtra', { value: 'x', enumerable: false });
  Object.defineProperty(topLevel, symbol, { get: () => { getterCalls += 1; return 'x'; } });
  assert.throws(() => validateConversationGoal(topLevel), /V3_CONVERSATION_GOAL_INVALID/);
  assert.equal(getterCalls, 0);

  for (const field of ['sourceMessageIds', 'sourceAttachmentIds', 'fulfillmentEvidenceRefs']) {
    const values = [...(valid[field] as readonly string[])];
    Object.defineProperty(values, 'hiddenExtra', { value: 'x', enumerable: false });
    Object.defineProperty(values, symbol, { get: () => { getterCalls += 1; return 'x'; } });
    assert.throws(() => validateConversationGoal({ ...valid, [field]: values }), /INVALID/);
    assert.equal(getterCalls, 0);
  }

  const ref = { ...valid.erpObjectRefs[0] };
  Object.defineProperty(ref, 'hiddenExtra', { value: 'x', enumerable: false });
  Object.defineProperty(ref, symbol, { get: () => { getterCalls += 1; return 'x'; } });
  assert.throws(() => validateConversationGoal({ ...valid, erpObjectRefs: [ref] }), /V3_CONVERSATION_GOAL_INVALID/);
  assert.equal(getterCalls, 0);
});
test('rejects whitespace-only text across identifiers, provenance, refs, and description', () => {
  const valid = buildConversationGoal(base());
  for (const mutation of [
    { goalId: '   ' }, { accountId: '\t' }, { conversationId: '\n' },
    { sourceMessageIds: ['   '] }, { sourceAttachmentIds: ['\t'] },
    { erpObjectRefs: [{ ...valid.erpObjectRefs[0], objectType: ' ' }] },
    { erpObjectRefs: [{ ...valid.erpObjectRefs[0], objectId: '\n' }] },
    { erpObjectRefs: [{ ...valid.erpObjectRefs[0], accountId: '\t' }] },
    { erpObjectRefs: [{ ...valid.erpObjectRefs[0], conversationId: '   ' }] },
    { description: ' \t\n' }, { parentGoalId: ' ' },
  ]) assert.throws(() => validateConversationGoal({ ...valid, ...mutation }), /V3_CONVERSATION_GOAL_INVALID/);
});
test('rejects timestamps and self references', () => { const valid = buildConversationGoal(base()); for (const x of [{ ...valid, createdAt: 'not-time' }, { ...valid, updatedAt: '2026-09-13T00:00:00.000Z' }, { ...valid, parentGoalId: valid.goalId }, { ...valid, dependsOnGoalIds: [valid.goalId] }, { ...valid, relatedGoalIds: [valid.goalId] }]) assert.throws(() => validateConversationGoal(x), /INVALID/); });
test('returns detached deeply immutable output', () => { const input = base(); const goal = buildConversationGoal(input); input.sourceMessageIds[0] = 'changed'; assert.equal(goal.sourceMessageIds[0], 'message-opaque'); assert.notStrictEqual(goal.sourceMessageIds, input.sourceMessageIds); assert(Object.isFrozen(goal)); assert(Object.isFrozen(goal.erpObjectRefs[0])); assert.throws(() => (goal.erpObjectRefs[0].objectId = 'changed'), TypeError); });
