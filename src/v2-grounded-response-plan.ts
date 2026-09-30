/**
 * PI-004 candidate contract. This is deliberately only a shape/scope guard.
 * It does not re-read canonical state, prove a claim, render, or send anything;
 * those responsibilities belong to V2-GROUND-001 and later outbound work.
 */
import { redactContextText } from './v2-context-projection.js';

export const PROTECTED_FACT_SLOTS = [
  'customer_identity', 'product', 'quantity', 'uom', 'price', 'currency', 'total',
  'stock', 'availability', 'delivery_date', 'date', 'quotation_reference',
  'quotation_number', 'quotation_status', 'sales_order_number', 'sales_order_status',
  'commitment_outcome',
] as const;
/** Narrow aggregate claim is a separate extension so the original scalar
 * capability grounding SSOT remains backwards compatible. */
export const DRAFT_PROTECTED_FACT_SLOTS = ['current_order_draft_items'] as const;
export type ProtectedFactSlot = typeof PROTECTED_FACT_SLOTS[number] | typeof DRAFT_PROTECTED_FACT_SLOTS[number];

const SLOT_SET = new Set<string>([...PROTECTED_FACT_SLOTS, ...DRAFT_PROTECTED_FACT_SLOTS]);
const VALUE_SHAPES = ['identifier', 'decimal_quantity', 'currency_code', 'money_amount', 'boolean', 'date', 'document_identifier', 'status', 'commitment', 'order_draft_items'] as const;
const VALUE_SHAPE_SET = new Set<string>(VALUE_SHAPES);
const INTENTS = ['ANSWER', 'CLARIFY', 'HANDOFF', 'ACKNOWLEDGE'] as const;
const INTENT_SET = new Set<string>(INTENTS);
const OUTBOUND_PURPOSES = ['customer_reply', 'clarification', 'handoff', 'acknowledgement'] as const;
const OUTBOUND_SET = new Set<string>(OUTBOUND_PURPOSES);
const SAFE_REASONS = /^[A-Z][A-Z0-9_]{0,79}$/;
const MAX_TEXT = 1000;
const MAX_REF = 256;
const MAX_CLAIMS = 24;
const MAX_EVIDENCE = 16;
const MAX_GOALS = 32;
const MAX_DELIVERY_UNITS = 32;
const MAX_ATTACHMENTS = 32;
const MAX_PURPOSE = 160;
const DISPOSITIONS = ['FULFILLED', 'NEEDS_CLARIFICATION', 'WAITING_EXTERNAL', 'BLOCKED_BY_AUTHORITY', 'STILL_IN_PROGRESS'] as const;
const DISPOSITION_SET = new Set<string>(DISPOSITIONS);
const DELIVERY_UNIT_TYPES = ['TEXT_BUBBLE', 'CAPTION', 'PDF', 'DOCUMENT'] as const;
const DELIVERY_UNIT_TYPE_SET = new Set<string>(DELIVERY_UNIT_TYPES);
const SLOT_SHAPES: Record<ProtectedFactSlot, typeof VALUE_SHAPES[number]> = {
  customer_identity: 'identifier', product: 'identifier', quantity: 'decimal_quantity', uom: 'identifier',
  price: 'money_amount', currency: 'currency_code', total: 'money_amount', stock: 'decimal_quantity',
  availability: 'boolean', delivery_date: 'date', date: 'date', quotation_reference: 'document_identifier',
  quotation_number: 'document_identifier', quotation_status: 'status', sales_order_number: 'document_identifier',
  sales_order_status: 'status', commitment_outcome: 'commitment', current_order_draft_items: 'order_draft_items',
};
const PURPOSE_BY_INTENT = { ANSWER: 'customer_reply', CLARIFY: 'clarification', HANDOFF: 'handoff', ACKNOWLEDGE: 'acknowledgement' } as const;
const REF_FORBIDDEN = /(?:secret|password|passwd|token|bearer|api[_-]?key|authorization|provider|staff|employee|auth|raw[_-]?payload|webhook|whatsapp|wa[_-]?jid|cookie|session|private[_-]?key|credential)/i;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#@+-]{0,255}$/;

export type GroundedResponsePlan = Readonly<{
  turnId: string;
  intent: typeof INTENTS[number];
  connectiveText?: string;
  factClaims: ReadonlyArray<Readonly<{
    slot: ProtectedFactSlot;
    canonicalRef: Readonly<{ sourceId: string; versionOrRevision: string; evidenceRefs: ReadonlyArray<string> }>;
    valueShape: typeof VALUE_SHAPES[number];
  }>>;
  safeReasonCode?: string;
  handoff?: Readonly<{ reasonCode: string }>;
  outboundPurpose: typeof OUTBOUND_PURPOSES[number];
  bundleId?: string;
  goalDispositions?: ReadonlyArray<Readonly<{
    goalId: string;
    disposition: typeof DISPOSITIONS[number];
    capabilityEvidenceRefs: ReadonlyArray<string>;
    groundingRefs: ReadonlyArray<string>;
    continuationRef?: string;
  }>>;
  responseEvidenceRefs?: ReadonlyArray<string>;
  attachments?: ReadonlyArray<string>;
  deliveryUnits?: ReadonlyArray<Readonly<{
    deliveryUnitId: string;
    unitType: typeof DELIVERY_UNIT_TYPES[number];
    text?: string;
    attachmentRef?: string;
    purpose: string;
  }>>;
}>;

function fail(code: string): never { throw new Error(`RESPONSE_PLAN_INVALID:${code}`); }
function ownPlain(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const out = value as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(out).length) fail(`${code}_SYMBOL`);
  for (const name of Object.getOwnPropertyNames(out)) {
    const descriptor = Object.getOwnPropertyDescriptor(out, name);
    if (!descriptor || descriptor.get || descriptor.set) fail(`${code}_ACCESSOR`);
    if (!descriptor.enumerable) fail(`${code}_NON_ENUMERABLE`);
  }
  return out;
}
function keys(value: Record<string, unknown>, allowed: ReadonlySet<string>, code: string) {
  for (const key of Object.getOwnPropertyNames(value)) if (!allowed.has(key)) fail(`${code}_UNKNOWN_${key}`);
}
function boundedText(value: unknown, code: string, max = MAX_REF): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0 || value.length > max) fail(code);
  if (value.includes('\u0000')) fail(`${code}_CONTROL`);
  return value;
}
function canonicalIdentifier(value: unknown, code: string, max = MAX_REF): string {
  const result = boundedText(value, code, max);
  if (!SAFE_IDENTIFIER.test(result) || REF_FORBIDDEN.test(result) || redactContextText(result) !== result) fail(`${code}_UNSAFE`);
  return result;
}
function safeReason(value: unknown, code: string): string {
  const result = boundedText(value, code, 80);
  if (!SAFE_REASONS.test(result)) fail(`${code}_FORMAT`);
  return result;
}
function deepClone(value: unknown, seen = new WeakSet<object>()): any {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('NON_FINITE_NUMBER');
    if (typeof value === 'symbol' || typeof value === 'function') fail('UNSAFE_VALUE');
    return value;
  }
  if (seen.has(value)) fail('CYCLE');
  seen.add(value);
  const source = Array.isArray(value) ? value : ownPlain(value, 'PLAIN_JSON');
  const result: any = Array.isArray(source) ? source.map(item => deepClone(item, seen)) : Object.fromEntries(Object.entries(source).map(([k, v]) => [k, deepClone(v, seen)]));
  seen.delete(value);
  return result;
}
function inspectJson(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('NON_FINITE_NUMBER');
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'undefined') fail('UNSAFE_VALUE');
    return;
  }
  if (seen.has(value)) fail('CYCLE');
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) fail('ARRAY_PLAIN_JSON');
    for (const name of Object.getOwnPropertyNames(value)) {
      if (name !== 'length' && !/^\d+$/.test(name)) fail('ARRAY_UNKNOWN_KEY');
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor?.get || descriptor?.set) fail('ARRAY_ACCESSOR');
      if (name !== 'length' && !descriptor?.enumerable) fail('ARRAY_NON_ENUMERABLE');
    }
    for (let index = 0; index < value.length; index++) if (!Object.prototype.hasOwnProperty.call(value, String(index))) fail('ARRAY_HOLE');
    for (const item of value) inspectJson(item, seen);
  } else {
    const object = ownPlain(value, 'PLAIN_JSON');
    for (const item of Object.values(object)) inspectJson(item, seen);
  }
  seen.delete(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as any)) freeze(child); Object.freeze(value); }
  return value;
}
const CONNECTIVE_DIGITS = /[0-9０-９٠-٩]/u;
const CONNECTIVE_CURRENCY = /(?:[$€£¥]|\b(?:SGD|USD|MYR|EUR|GBP|JPY|CNY|RMB|dollars?|ringgit|cents?|sen|bucks?)\b)/i;
const CONNECTIVE_FACT_ASSERTION = /(?:\b(?:price|total|quantity|qty|stock|availability)\b\s*(?:is|are|=|:|at|has|have)\b|\b(?:in stock|out of stock|stock\s+(?:is\s+)?(?:available|unavailable))\b|\b(?:quotation|quote|sales order|order|draft)\b\s+(?:is|was|has been)\s+(?:sent|accepted|draft|posted|confirmed|ready|rejected|cancelled|canceled|current)\b|\b(?:accepted|confirmed|posted|rejected|cancelled|canceled)\b|\bdelivery\b\s+(?:is|will be|on|by)\b|\bstatus\b\s*(?:is|=|:)\s*\w+)/i;
export function validateNaturalCustomerText(value: unknown): string {
  const result = boundedText(value, 'CONNECTIVE_TEXT', MAX_TEXT);
  if (redactContextText(result) !== result) fail('CONNECTIVE_TEXT_SECRET');
  // Free-form model wording is allowed, but protected/commercial facts must still
  // travel through factClaims so GROUND-001 can verify them canonically.
  const withoutClockTimes = result.replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g, '');
  if (CONNECTIVE_DIGITS.test(withoutClockTimes) || CONNECTIVE_CURRENCY.test(result) || CONNECTIVE_FACT_ASSERTION.test(result)) fail('CONNECTIVE_TEXT_FACTLIKE');
  return result;
}

export function parseGroundedResponsePlan(raw: string, expectedTurnId: string): GroundedResponsePlan {
  if (typeof raw !== 'string' || raw.length > 8192) fail('RAW_SIZE');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail('MALFORMED_JSON'); }
  return validateGroundedResponsePlan(parsed, expectedTurnId);
}

export function validateGroundedResponsePlan(candidate: unknown, expectedTurnId: string): GroundedResponsePlan {
  boundedText(expectedTurnId, 'EXPECTED_TURN_ID', 160);
  inspectJson(candidate);
  const root = ownPlain(candidate, 'ROOT');
  keys(root, new Set(['turnId', 'intent', 'connectiveText', 'factClaims', 'safeReasonCode', 'handoff', 'outboundPurpose', 'bundleId', 'goalDispositions', 'responseEvidenceRefs', 'attachments', 'deliveryUnits']), 'PLAN');
  const turnId = boundedText(root.turnId, 'TURN_ID', 160);
  if (turnId !== expectedTurnId) fail('TURN_ID_SCOPE');
  if (typeof root.intent !== 'string' || !INTENT_SET.has(root.intent)) fail('INTENT');
  if (typeof root.outboundPurpose !== 'string' || !OUTBOUND_SET.has(root.outboundPurpose)) fail('OUTBOUND_PURPOSE');
  if (!Array.isArray(root.factClaims) || root.factClaims.length > MAX_CLAIMS) fail('FACT_CLAIMS');
  const claims = root.factClaims.map((claim, index) => {
    const c = ownPlain(claim, `FACT_${index}`);
    keys(c, new Set(['slot', 'canonicalRef', 'valueShape']), `FACT_${index}`);
    if (typeof c.slot !== 'string' || !SLOT_SET.has(c.slot)) fail(`FACT_${index}_SLOT`);
    if (typeof c.valueShape !== 'string' || !VALUE_SHAPE_SET.has(c.valueShape)) fail(`FACT_${index}_VALUE_SHAPE`);
    const ref = ownPlain(c.canonicalRef, `FACT_${index}_REF`);
    keys(ref, new Set(['sourceId', 'versionOrRevision', 'evidenceRefs']), `FACT_${index}_REF`);
    const sourceId = canonicalIdentifier(ref.sourceId, `FACT_${index}_SOURCE`, MAX_REF);
    const versionOrRevision = canonicalIdentifier(ref.versionOrRevision, `FACT_${index}_VERSION`, 128);
    if (!Array.isArray(ref.evidenceRefs) || ref.evidenceRefs.length === 0 || ref.evidenceRefs.length > MAX_EVIDENCE) fail(`FACT_${index}_EVIDENCE`);
    const evidenceRefs = ref.evidenceRefs.map((e, n) => canonicalIdentifier(e, `FACT_${index}_EVIDENCE_${n}`, MAX_REF));
    if (new Set(evidenceRefs).size !== evidenceRefs.length) fail(`FACT_${index}_DUPLICATE_EVIDENCE`);
    if (c.valueShape !== SLOT_SHAPES[c.slot as ProtectedFactSlot]) fail(`FACT_${index}_SLOT_VALUE_SHAPE`);
    return { slot: c.slot as ProtectedFactSlot, canonicalRef: { sourceId, versionOrRevision, evidenceRefs }, valueShape: c.valueShape as typeof VALUE_SHAPES[number] };
  });
  const connectiveText = root.connectiveText === undefined ? undefined : validateNaturalCustomerText(root.connectiveText);
  const reason = root.safeReasonCode === undefined ? undefined : safeReason(root.safeReasonCode, 'SAFE_REASON');
  const handoff = root.handoff === undefined ? undefined : (() => { const h = ownPlain(root.handoff, 'HANDOFF'); keys(h, new Set(['reasonCode']), 'HANDOFF'); return { reasonCode: safeReason(h.reasonCode, 'HANDOFF_REASON') }; })();
  if (root.outboundPurpose !== PURPOSE_BY_INTENT[root.intent as keyof typeof PURPOSE_BY_INTENT]) fail('INTENT_OUTBOUND_MISMATCH');
  if (root.intent === 'HANDOFF' && !reason) fail('SAFE_REASON_REQUIRED');
  if (root.intent === 'HANDOFF' && !handoff) fail('HANDOFF_REQUIRED');
  if (root.intent === 'HANDOFF' && reason !== handoff?.reasonCode) fail('HANDOFF_REASON_MISMATCH');
  if (root.intent !== 'HANDOFF' && handoff) fail('HANDOFF_FORBIDDEN');
  if ((root.intent === 'ANSWER' || root.intent === 'ACKNOWLEDGE') && reason) fail('SAFE_REASON_FORBIDDEN');
  if (root.intent === 'ACKNOWLEDGE' && claims.length > 0) fail('ACKNOWLEDGE_FACTS');
  if (root.intent === 'ACKNOWLEDGE' && !connectiveText) fail('ACKNOWLEDGE_TEXT_REQUIRED');
  if (root.intent === 'ANSWER' && !connectiveText && claims.length === 0) fail('ANSWER_MEANINGLESS');
  const bundleId = root.bundleId === undefined ? undefined : canonicalIdentifier(root.bundleId, 'BUNDLE_ID');
  const responseEvidenceRefs = root.responseEvidenceRefs === undefined ? undefined : uniqueRefs(root.responseEvidenceRefs, 'RESPONSE_EVIDENCE', MAX_EVIDENCE);
  const attachments = root.attachments === undefined ? undefined : uniqueRefs(root.attachments, 'ATTACHMENTS', MAX_ATTACHMENTS);
  const goalDispositions = root.goalDispositions === undefined ? undefined : parseGoalDispositions(root.goalDispositions);
  const deliveryUnits = root.deliveryUnits === undefined ? undefined : parseDeliveryUnits(root.deliveryUnits, attachments);
  return freeze(deepClone({ turnId, intent: root.intent, ...(connectiveText === undefined ? {} : { connectiveText }), factClaims: claims, ...(reason === undefined ? {} : { safeReasonCode: reason }), ...(handoff === undefined ? {} : { handoff }), outboundPurpose: root.outboundPurpose, ...(bundleId === undefined ? {} : { bundleId }), ...(goalDispositions === undefined ? {} : { goalDispositions }), ...(responseEvidenceRefs === undefined ? {} : { responseEvidenceRefs }), ...(attachments === undefined ? {} : { attachments }), ...(deliveryUnits === undefined ? {} : { deliveryUnits }) }));
}

function uniqueRefs(value: unknown, code: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) fail(`${code}_BOUNDS`);
  const refs = value.map((item, index) => canonicalIdentifier(item, `${code}_${index}`));
  if (new Set(refs).size !== refs.length) fail(`${code}_DUPLICATE`);
  return refs;
}

function parseGoalDispositions(value: unknown): Array<{
  goalId: string;
  disposition: typeof DISPOSITIONS[number];
  capabilityEvidenceRefs: string[];
  groundingRefs: string[];
  continuationRef?: string;
}> {
  if (!Array.isArray(value) || value.length > MAX_GOALS) fail('GOAL_DISPOSITIONS_BOUNDS');
  const goalIds = new Set<string>();
  return value.map((item, index) => {
    const goal = ownPlain(item, `GOAL_${index}`);
    keys(goal, new Set(['goalId', 'disposition', 'capabilityEvidenceRefs', 'groundingRefs', 'continuationRef']), `GOAL_${index}`);
    const goalId = canonicalIdentifier(goal.goalId, `GOAL_${index}_ID`);
    if (goalIds.has(goalId)) fail(`GOAL_${index}_DUPLICATE_ID`);
    goalIds.add(goalId);
    if (typeof goal.disposition !== 'string' || !DISPOSITION_SET.has(goal.disposition)) fail(`GOAL_${index}_DISPOSITION`);
    const capabilityEvidenceRefs = uniqueRefs(goal.capabilityEvidenceRefs, `GOAL_${index}_CAPABILITY_EVIDENCE`, MAX_EVIDENCE);
    const groundingRefs = uniqueRefs(goal.groundingRefs, `GOAL_${index}_GROUNDING`, MAX_EVIDENCE);
    const continuationRef = goal.continuationRef === undefined ? undefined : canonicalIdentifier(goal.continuationRef, `GOAL_${index}_CONTINUATION`);
    const needsContinuation = goal.disposition === 'WAITING_EXTERNAL' || goal.disposition === 'STILL_IN_PROGRESS';
    if (needsContinuation !== (continuationRef !== undefined)) fail(`GOAL_${index}_CONTINUATION_${needsContinuation ? 'REQUIRED' : 'FORBIDDEN'}`);
    return { goalId, disposition: goal.disposition as typeof DISPOSITIONS[number], capabilityEvidenceRefs, groundingRefs, ...(continuationRef === undefined ? {} : { continuationRef }) };
  });
}

function parseDeliveryUnits(value: unknown, rootAttachments?: ReadonlyArray<string>): Array<{
  deliveryUnitId: string;
  unitType: typeof DELIVERY_UNIT_TYPES[number];
  text?: string;
  attachmentRef?: string;
  purpose: string;
}> {
  if (!Array.isArray(value) || value.length > MAX_DELIVERY_UNITS) fail('DELIVERY_UNITS_BOUNDS');
  const ids = new Set<string>();
  return value.map((item, index) => {
    const unit = ownPlain(item, `DELIVERY_${index}`);
    keys(unit, new Set(['deliveryUnitId', 'unitType', 'text', 'attachmentRef', 'purpose']), `DELIVERY_${index}`);
    const deliveryUnitId = canonicalIdentifier(unit.deliveryUnitId, `DELIVERY_${index}_ID`);
    if (ids.has(deliveryUnitId)) fail(`DELIVERY_${index}_DUPLICATE_ID`);
    ids.add(deliveryUnitId);
    if (typeof unit.unitType !== 'string' || !DELIVERY_UNIT_TYPE_SET.has(unit.unitType)) fail(`DELIVERY_${index}_TYPE`);
    const isText = unit.unitType === 'TEXT_BUBBLE' || unit.unitType === 'CAPTION';
    const text = unit.text === undefined ? undefined : validateNaturalCustomerText(unit.text);
    const attachmentRef = unit.attachmentRef === undefined ? undefined : canonicalIdentifier(unit.attachmentRef, `DELIVERY_${index}_ATTACHMENT`);
    if (isText !== (text !== undefined) || (!isText) !== (attachmentRef !== undefined)) fail(`DELIVERY_${index}_PAYLOAD_SHAPE`);
    if (!isText && (!rootAttachments || !rootAttachments.includes(attachmentRef!))) fail(`DELIVERY_${index}_ATTACHMENT_REF_UNKNOWN`);
    const purpose = canonicalIdentifier(unit.purpose, `DELIVERY_${index}_PURPOSE`, MAX_PURPOSE);
    return { deliveryUnitId, unitType: unit.unitType as typeof DELIVERY_UNIT_TYPES[number], ...(text === undefined ? {} : { text }), ...(attachmentRef === undefined ? {} : { attachmentRef }), purpose };
  });
}
