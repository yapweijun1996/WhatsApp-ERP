import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGroundedResponsePlan } from '../src/v2-grounded-response-plan.js';

const turnId = 'ful-001-turn';
const base = () => ({ turnId, intent: 'ANSWER', connectiveText: 'I can help with that.', factClaims: [], outboundPurpose: 'customer_reply' });

test('FUL-001 accepts the extended closed response plan', () => {
  const plan = validateGroundedResponsePlan({
    ...base(), bundleId: 'bundle-1', responseEvidenceRefs: ['evidence-1'], attachments: ['attachment-1'],
    goalDispositions: [{ goalId: 'goal-1', disposition: 'FULFILLED', capabilityEvidenceRefs: ['cap-1'], groundingRefs: ['ground-1'] }],
    deliveryUnits: [
      { deliveryUnitId: 'unit-1', unitType: 'TEXT_BUBBLE', text: 'Here is the update.', purpose: 'customer_reply' },
      { deliveryUnitId: 'unit-2', unitType: 'PDF', attachmentRef: 'attachment-1', purpose: 'quotation_document' },
    ],
  }, turnId);
  assert.equal(plan.bundleId, 'bundle-1');
  assert.equal(plan.goalDispositions?.[0].disposition, 'FULFILLED');
  assert.equal(plan.deliveryUnits?.[1].attachmentRef, 'attachment-1');
  assert.equal(Object.isFrozen(plan), true);
});

test('FUL-001 preserves V2 compatibility and optional V3 fields', () => {
  const plan = validateGroundedResponsePlan(base(), turnId);
  assert.equal(plan.deliveryUnits, undefined);
  assert.equal(plan.goalDispositions, undefined);
});

test('FUL-001 rejects unknown root and nested authority fields', () => {
  assert.throws(() => validateGroundedResponsePlan({ ...base(), providerId: 'wa-1' }, turnId), /PLAN_UNKNOWN/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), goalDispositions: [{ goalId: 'g', disposition: 'FULFILLED', capabilityEvidenceRefs: [], groundingRefs: [], staffAuthority: true }] }, turnId), /GOAL_0_UNKNOWN/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), deliveryUnits: [{ deliveryUnitId: 'u', unitType: 'TEXT_BUBBLE', text: 'Hi.', purpose: 'reply', recipient: 'customer' }] }, turnId), /DELIVERY_0_UNKNOWN/);
});

test('FUL-001 requires continuation only for waiting or in-progress goals', () => {
  const waiting = { ...base(), goalDispositions: [{ goalId: 'g-1', disposition: 'WAITING_EXTERNAL', capabilityEvidenceRefs: [], groundingRefs: [], continuationRef: 'continuation-1' }] };
  assert.doesNotThrow(() => validateGroundedResponsePlan(waiting, turnId));
  const missingContinuation = { ...waiting.goalDispositions[0] };
  delete (missingContinuation as any).continuationRef;
  assert.throws(() => validateGroundedResponsePlan({ ...waiting, goalDispositions: [missingContinuation] }, turnId), /CONTINUATION_REQUIRED/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), goalDispositions: [{ goalId: 'g-1', disposition: 'FULFILLED', capabilityEvidenceRefs: [], groundingRefs: [], continuationRef: 'continuation-1' }] }, turnId), /CONTINUATION_FORBIDDEN/);
});

test('FUL-001 rejects duplicate goal IDs, delivery IDs, and evidence refs', () => {
  assert.throws(() => validateGroundedResponsePlan({ ...base(), goalDispositions: [
    { goalId: 'g-1', disposition: 'FULFILLED', capabilityEvidenceRefs: [], groundingRefs: [] },
    { goalId: 'g-1', disposition: 'BLOCKED_BY_AUTHORITY', capabilityEvidenceRefs: [], groundingRefs: [] },
  ] }, turnId), /DUPLICATE_ID/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), responseEvidenceRefs: ['e-1', 'e-1'] }, turnId), /RESPONSE_EVIDENCE_DUPLICATE/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), deliveryUnits: [
    { deliveryUnitId: 'u-1', unitType: 'TEXT_BUBBLE', text: 'First.', purpose: 'reply' },
    { deliveryUnitId: 'u-1', unitType: 'TEXT_BUBBLE', text: 'Second.', purpose: 'reply' },
  ] }, turnId), /DUPLICATE_ID/);
});

test('FUL-001 preserves delivery unit order exactly', () => {
  const units = [
    { deliveryUnitId: 'u-2', unitType: 'CAPTION', text: 'Second.', purpose: 'caption' },
    { deliveryUnitId: 'u-1', unitType: 'DOCUMENT', attachmentRef: 'a-1', purpose: 'document' },
  ];
  const plan = validateGroundedResponsePlan({ ...base(), attachments: ['a-1'], deliveryUnits: units }, turnId);
  assert.deepEqual(plan.deliveryUnits?.map(unit => unit.deliveryUnitId), ['u-2', 'u-1']);
});

test('FUL-001 enforces text versus attachment payload shape', () => {
  assert.throws(() => validateGroundedResponsePlan({ ...base(), deliveryUnits: [{ deliveryUnitId: 'u', unitType: 'TEXT_BUBBLE', purpose: 'reply' }] }, turnId), /PAYLOAD_SHAPE/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), deliveryUnits: [{ deliveryUnitId: 'u', unitType: 'PDF', text: 'not media', purpose: 'document' }] }, turnId), /PAYLOAD_SHAPE/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), deliveryUnits: [{ deliveryUnitId: 'u', unitType: 'DOCUMENT', attachmentRef: 'a', text: 'both', purpose: 'document' }] }, turnId), /PAYLOAD_SHAPE/);
});

test('FUL-001 applies natural text and safe identifier validation', () => {
  assert.throws(() => validateGroundedResponsePlan({ ...base(), bundleId: 'provider-id-1' }, turnId), /UNSAFE/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), deliveryUnits: [{ deliveryUnitId: 'u', unitType: 'TEXT_BUBBLE', text: 'The price is 12 SGD.', purpose: 'reply' }] }, turnId), /FACTLIKE/);
});

test('FUL-001 bounds response evidence, goals, delivery units, and per-goal refs', () => {
  const refs = Array.from({ length: 17 }, (_, index) => `e-${index}`);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), responseEvidenceRefs: refs }, turnId), /BOUNDS/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), goalDispositions: [{ goalId: 'g', disposition: 'FULFILLED', capabilityEvidenceRefs: refs, groundingRefs: [] }] }, turnId), /BOUNDS/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), deliveryUnits: Array.from({ length: 33 }, (_, index) => ({ deliveryUnitId: `u-${index}`, unitType: 'TEXT_BUBBLE', text: 'Hi.', purpose: 'reply' })) }, turnId), /BOUNDS/);
});
