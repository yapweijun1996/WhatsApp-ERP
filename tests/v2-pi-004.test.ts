import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGroundedResponsePlan, validateGroundedResponsePlan, PROTECTED_FACT_SLOTS } from '../src/v2-grounded-response-plan.js';
import { listCapabilities } from '../src/v2-capability-registry.js';

const turnId = 'turn-1';
const base = () => ({ turnId, intent: 'ANSWER', connectiveText: 'I can help with that.', factClaims: [], outboundPurpose: 'customer_reply' });
const claim = (slot = 'price', valueShape = 'money_amount') => ({ slot, canonicalRef: { sourceId: 'erp-evidence-1', versionOrRevision: 'revision-4', evidenceRefs: ['evidence-1'] }, valueShape });

test('PI-004 accepts bounded ACKNOWLEDGE and commercial plans with references only', () => {
  const ack = validateGroundedResponsePlan({ ...base(), intent: 'ACKNOWLEDGE', connectiveText: 'Thank you.', outboundPurpose: 'acknowledgement' }, turnId);
  assert.equal(ack.factClaims.length, 0);
  const plan = validateGroundedResponsePlan({ ...base(), factClaims: [claim()] }, turnId);
  assert.equal(plan.factClaims[0].canonicalRef.sourceId, 'erp-evidence-1');
  assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.factClaims[0].canonicalRef), true);
  assert.throws(() => (plan as any).turnId = 'changed');
});

test('PI-004 validates state-aware clarification and handoff shapes', () => {
  assert.doesNotThrow(() => validateGroundedResponsePlan({ ...base(), intent: 'CLARIFY', connectiveText: 'Could you clarify your request?', outboundPurpose: 'clarification', safeReasonCode: 'AMBIGUOUS_SKU' }, turnId));
  assert.doesNotThrow(() => validateGroundedResponsePlan({ ...base(), intent: 'HANDOFF', connectiveText: 'A specialist can assist further.', outboundPurpose: 'handoff', safeReasonCode: 'STAFF_REVIEW', handoff: { reasonCode: 'STAFF_REVIEW' } }, turnId));
  assert.doesNotThrow(() => validateGroundedResponsePlan({ ...base(), intent: 'CLARIFY', connectiveText: 'Could you clarify your request?', outboundPurpose: 'clarification' }, turnId));
  assert.throws(() => validateGroundedResponsePlan({ ...base(), intent: 'HANDOFF', connectiveText: 'A specialist can assist further.', outboundPurpose: 'handoff', handoff: { reasonCode: 'STAFF_REVIEW' } }, turnId), /SAFE_REASON_REQUIRED/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), intent: 'ANSWER', handoff: { reasonCode: 'X' } }, turnId), /HANDOFF_FORBIDDEN/);
});

test('PI-004 rejects prose/fences/multiple objects, wrong scope, fabricated slots and missing evidence', () => {
  for (const raw of ['```json\n{}\n```', 'leading ' + JSON.stringify(base()), JSON.stringify(base()) + JSON.stringify(base())]) assert.throws(() => parseGroundedResponsePlan(raw, turnId));
  assert.throws(() => validateGroundedResponsePlan({ ...base(), turnId: 'other' }, turnId), /TURN_ID_SCOPE/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), factClaims: [claim('invented_fact')] }, turnId), /SLOT/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), factClaims: [{ ...claim(), canonicalRef: { sourceId: 'x', versionOrRevision: 'v', evidenceRefs: [] } }] }, turnId), /EVIDENCE/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), factClaims: [{ ...claim(), canonicalRef: { sourceId: 'x', versionOrRevision: 'v', evidenceRefs: ['e', 'e'] } }] }, turnId), /DUPLICATE/);
});

test('PI-004 rejects value smuggling, commercial identifiers, secrets and escape fields', () => {
  for (const text of ['Price is 12 SGD', 'Quote SO-123 is ready', 'Bearer secret-token', 'The quantity is 3']) assert.throws(() => validateGroundedResponsePlan({ ...base(), connectiveText: text }, turnId));
  assert.throws(() => validateGroundedResponsePlan({ ...base(), valueShape: 'the protected value' } as any, turnId), /UNKNOWN/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), providerId: 'wa', rawPayload: {}, staffAuthority: true } as any, turnId), /UNKNOWN/);
});

test('PI-004 allows natural AI connective text while blocking ungrounded commercial facts', () => {
  for (const text of ['Hi! How can I help with your order today?','I have captured your order request. Would you like me to prepare a quotation?','Happy to help. What would you like to do next?']) assert.doesNotThrow(() => validateGroundedResponsePlan({ ...base(), connectiveText: text }, turnId));
  for (const text of ['The price is available','forty-eight dollars','٤٨ dollars','４８ dollars','The quotation is ready','quantity 2 CTN','stock is available','status is confirmed']) assert.throws(() => validateGroundedResponsePlan({ ...base(), connectiveText: text }, turnId), /CONNECTIVE_TEXT_FACTLIKE/);
});

test('PI-004 rejects accessors, custom prototypes, cycles, non-finite values and oversize arrays', () => {
  const accessor: any = base(); Object.defineProperty(accessor, 'connectiveText', { get() { throw new Error('must not invoke'); }, enumerable: true });
  assert.throws(() => validateGroundedResponsePlan(accessor, turnId), /ACCESSOR/);
  assert.throws(() => validateGroundedResponsePlan(Object.assign(Object.create({ bad: true }), base()), turnId), /PLAIN_JSON/);
  const cyclic: any = base(); cyclic.extra = cyclic; assert.throws(() => validateGroundedResponsePlan(cyclic, turnId), /UNKNOWN|CYCLE/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), factClaims: Array.from({ length: 25 }, claim) }, turnId), /FACT_CLAIMS/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), factClaims: [{ ...claim(), valueShape: Number.NaN }] } as any, turnId), /NON_FINITE|VALUE_SHAPE/);
});

test('PI-004 binds intent purpose slot shape and handoff reason exactly', () => {
  assert.throws(() => validateGroundedResponsePlan({ ...base(), intent: 'ANSWER', outboundPurpose: 'clarification' }, turnId), /INTENT_OUTBOUND_MISMATCH/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), factClaims: [claim('price', 'status')] }, turnId), /SLOT_VALUE_SHAPE/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), intent: 'HANDOFF', connectiveText: 'A specialist can assist further.', outboundPurpose: 'handoff', safeReasonCode: 'STAFF_REVIEW', handoff: { reasonCode: 'OTHER_REASON' } }, turnId), /HANDOFF_REASON_MISMATCH/);
  assert.throws(() => validateGroundedResponsePlan({ ...base(), safeReasonCode: 'NOT_ALLOWED' }, turnId), /SAFE_REASON_FORBIDDEN/);
  assert.throws(() => validateGroundedResponsePlan({ turnId, intent: 'ANSWER', factClaims: [], outboundPurpose: 'customer_reply' }, turnId), /ANSWER_MEANINGLESS/);
  assert.throws(() => validateGroundedResponsePlan({ turnId, intent: 'ACKNOWLEDGE', factClaims: [], outboundPurpose: 'acknowledgement' }, turnId), /ACKNOWLEDGE_TEXT_REQUIRED/);
});

test('PI-004 rejects unsafe canonical refs and hidden JSON properties', () => {
  for (const bad of ['Bearer-secret', 'provider-id-1', 'staff-auth-1', 'raw_payload_1', 'api_key_123']) {
    assert.throws(() => validateGroundedResponsePlan({ ...base(), factClaims: [{ ...claim(), canonicalRef: { sourceId: bad, versionOrRevision: 'revision-4', evidenceRefs: ['evidence-1'] } }] }, turnId), /UNSAFE/);
  }
  const hidden: any = base(); Object.defineProperty(hidden, 'shadow', { value: 'x', enumerable: false });
  assert.throws(() => validateGroundedResponsePlan(hidden, turnId), /NON_ENUMERABLE/);
  const evidence = ['evidence-1']; Object.defineProperty(evidence, '0', { value: 'evidence-1', enumerable: false });
  assert.throws(() => validateGroundedResponsePlan({ ...base(), factClaims: [{ ...claim(), canonicalRef: { sourceId: 'erp-evidence-1', versionOrRevision: 'revision-4', evidenceRefs: evidence } }] }, turnId), /ARRAY_NON_ENUMERABLE/);
});


test('PI-004 protected slot catalog exactly matches the frozen capability grounding SSOT', () => {
  const registrySlots = [...new Set(listCapabilities().flatMap(capability => capability.grounding.protectedFactSlots))].sort();
  assert.deepEqual([...PROTECTED_FACT_SLOTS].sort(), registrySlots);
});

test('PI-004 allows authoritative clock-time wording but still rejects other free-form numbers', () => {
  assert.doesNotThrow(() => validateGroundedResponsePlan({ ...base(), connectiveText: '现在是 21:32。' }, turnId));
  assert.throws(() => validateGroundedResponsePlan({ ...base(), connectiveText: 'You asked for 10 cartons.' }, turnId), /CONNECTIVE_TEXT_FACTLIKE/);
});
