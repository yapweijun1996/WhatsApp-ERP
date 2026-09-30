import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defineCapabilityResult,
  defineTurnOutboundDisposition,
  normalizeCapabilityResult,
  validateCapabilityResult,
  validateTurnOutboundDisposition,
  type CapabilityResult,
} from '../src/v2-capability-result.js';
import type { ServiceResult } from '../src/v2-domain-contracts.js';

const base = (overrides: Record<string, unknown> = {}) => ({ status: 'SUCCEEDED', evidence: [], stateChanges: [], ...overrides });
const rejects = (value: unknown, pattern: RegExp) => assert.throws(() => validateCapabilityResult(value), pattern);
const normalizeRejects = (value: unknown, pattern: RegExp) => assert.throws(() => normalizeCapabilityResult(value), pattern);

test('CAP-005 accepts canonical structured results and freezes a detached normalized copy', () => {
  const input: CapabilityResult<{ product: string; facts: string[] }> = {
    status: 'SUCCEEDED',
    data: { product: 'Fresh Chicken', facts: ['normal domain text is allowed inside structured data'] },
    evidence: [{ sourceId: 'erp-1', sourceVersion: 'v2-erp-sql-1', evidenceRefs: ['erp-1'] }],
    stateChanges: [{ entity: 'ORDER_DRAFT', from: 'DRAFTING', to: 'READY_TO_QUOTE', id: 'draft-1' }],
    reasonCode: 'VALIDATED',
    retryable: false,
    idempotency: { key: 'cap:1', replayed: false },
    revision: 3,
  };
  const normalized = normalizeCapabilityResult(input);
  assert.deepEqual(normalized, input);
  assert.notStrictEqual(normalized, input);
  assert.notStrictEqual(normalized.data, input.data);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.data), true);
  assert.equal(Object.isFrozen(normalized.evidence), true);
  assert.equal(Object.isFrozen(normalized.evidence[0]), true);
  assert.equal(Object.isFrozen(normalized.stateChanges), true);
  assert.equal(Object.isFrozen(normalized.idempotency), true);
});

test('CAP-005 accepts every status with deterministic retryability coherence', () => {
  for (const status of ['SUCCEEDED', 'NEEDS_CLARIFICATION', 'BLOCKED', 'FAILED'] as const) {
    assert.doesNotThrow(() => validateCapabilityResult(base({ status, retryable: false, reasonCode: 'SAFE_REASON' })));
  }
  assert.doesNotThrow(() => validateCapabilityResult(base({ status: 'RETRYABLE', retryable: true, reasonCode: 'TRY_AGAIN' })));
  rejects(base({ status: 'RETRYABLE' }), /RETRYABLE_REQUIRES_RETRYABLE_TRUE/);
  rejects(base({ status: 'RETRYABLE', retryable: false }), /RETRYABLE_REQUIRES_RETRYABLE_TRUE/);
  rejects(base({ status: 'BLOCKED', retryable: true }), /NON_RETRYABLE_CANNOT_CLAIM_RETRYABLE/);
  rejects(base({ status: 'NOPE' }), /INVALID_STATUS/);
});

test('CAP-005 requires normal dense JSON arrays and rejects accessors without invoking getters', () => {
  assert.doesNotThrow(() => validateCapabilityResult(base()));
  assert.doesNotThrow(() => validateCapabilityResult(base({ evidence: [{ sourceId: 'e1', evidenceRefs: [] }], stateChanges: [] })));

  let getterCalls = 0;
  const top = base() as Record<string, unknown>;
  Object.defineProperty(top, 'data', { enumerable: true, get: () => { getterCalls += 1; return {}; } });
  rejects(top, /MUST_BE_JSON/);
  assert.equal(getterCalls, 0);

  const evidence = [{ sourceId: 'e1' }];
  Object.defineProperty(evidence, '0', { enumerable: true, get: () => { getterCalls += 1; return { sourceId: 'e1' }; } });
  rejects(base({ evidence }), /MUST_BE_JSON/);
  assert.equal(getterCalls, 0);

  const sparse = new Array(2); sparse[0] = { sourceId: 'e1' };
  rejects(base({ evidence: sparse }), /MUST_BE_JSON/);
  const custom = [{ sourceId: 'e1' }]; Object.setPrototypeOf(custom, { ...Array.prototype });
  rejects(base({ evidence: custom }), /MUST_BE_JSON/);
});

test('CAP-005 fails closed for symbols, hidden fields, custom prototypes, cycles, and non-JSON data', () => {
  const symbol = base() as Record<string | symbol, unknown>; symbol[Symbol('secret')] = 'x';
  rejects(symbol, /SYMBOL_KEY_NOT_ALLOWED/);
  const hidden = base() as Record<string, unknown>; Object.defineProperty(hidden, 'prompt', { enumerable: false, value: 'secret' });
  rejects(hidden, /MUST_BE_JSON/);
  rejects(Object.assign(Object.create({ admin: true }), base()), /MUST_BE_PLAIN_OBJECT/);

  for (const data of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, (() => 1)]) rejects(base({ data }), /MUST_BE_JSON/);
  const circular: Record<string, unknown> = {}; circular.self = circular;
  rejects(base({ data: circular }), /MUST_NOT_BE_CIRCULAR/);
});

test('CAP-005 rejects dangerous own enumerable data keys at every structured boundary', () => {
  const dangerousKeys = ['__proto__', 'constructor', 'prototype'] as const;
  const defineDataKey = (value: Record<string, unknown>, key: string, data: unknown) => {
    Object.defineProperty(value, key, { enumerable: true, configurable: true, value: data });
    return value;
  };

  for (const key of dangerousKeys) {
    const pollutedValue = { polluted: true };
    normalizeRejects(defineDataKey(base(), key, pollutedValue), new RegExp(`DANGEROUS_KEY_${key}`));
    normalizeRejects(base({ data: defineDataKey({ safe: true }, key, pollutedValue) }), new RegExp(`DANGEROUS_KEY_${key}`));
    normalizeRejects(base({ evidence: [defineDataKey({ sourceId: 'e1' }, key, pollutedValue)], stateChanges: [] }), new RegExp(`DANGEROUS_KEY_${key}`));
    normalizeRejects(base({ evidence: [], stateChanges: [defineDataKey({ entity: 'ORDER_DRAFT' }, key, pollutedValue)] }), new RegExp(`DANGEROUS_KEY_${key}`));
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    assert.equal((Object.prototype as { polluted?: boolean }).polluted, undefined);
  }

  let getterCalls = 0;
  const getterValue = base();
  Object.defineProperty(getterValue, '__proto__', { enumerable: true, configurable: true, get: () => { getterCalls += 1; return { polluted: true }; } });
  normalizeRejects(getterValue, /DANGEROUS_KEY___proto__/);
  assert.equal(getterCalls, 0);
});

test('CAP-005 top-level contract contains no customer prose or authority escape fields', () => {
  for (const key of ['message', 'reply', 'customerMessage', 'customerFacingText', 'prompt', 'secret', 'handler', 'staffAuthority']) {
    rejects(base({ [key]: 'do not expose me' }), new RegExp(`UNKNOWN_FIELD_${key}`));
  }
  assert.doesNotThrow(() => validateCapabilityResult(base({ data: { description: 'Normal product description' } })));
});

test('CAP-005 validates machine reason codes, idempotency, revisions, evidence, and state changes', () => {
  rejects(base({ reasonCode: '' }), /reasonCode_INVALID_STRING/);
  rejects(base({ reasonCode: 'Please tell the customer to retry' }), /reasonCode_MUST_BE_MACHINE_CODE/);
  rejects(base({ reasonCode: 'x'.repeat(257) }), /reasonCode_INVALID_STRING/);

  rejects(base({ idempotency: { key: ' ', replayed: false } }), /idempotency.key_INVALID_STRING/);
  rejects(base({ idempotency: { key: 'k', replayed: 'yes' } }), /idempotency.replayed_MUST_BE_BOOLEAN/);
  rejects(base({ idempotency: { key: 'k', replayed: false, staff: true } }), /idempotency_UNKNOWN_FIELD_staff/);
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) rejects(base({ revision }), /revision_MUST_BE_POSITIVE_SAFE_INTEGER/);

  rejects(base({ evidence: [{}] }), /sourceId_INVALID_STRING/);
  rejects(base({ evidence: [{ sourceId: ' ' }] }), /sourceId_INVALID_STRING/);
  rejects(base({ evidence: [{ sourceId: 'e', sourceVersion: '' }] }), /sourceVersion_INVALID_STRING/);
  rejects(base({ evidence: [{ sourceId: 'e', evidenceRefs: [''] }] }), /evidenceRefs\[0\]_INVALID_STRING/);
  rejects(base({ evidence: [{ sourceId: 'e', prompt: 'x' }] }), /UNKNOWN_FIELD_prompt/);

  rejects(base({ stateChanges: [{ entity: 'DATABASE' }] }), /INVALID_ENTITY/);
  rejects(base({ stateChanges: [{ entity: 'ORDER_DRAFT', id: '' }] }), /id_INVALID_STRING/);
  rejects(base({ stateChanges: [{ entity: 'ORDER_DRAFT', staffAuthority: 'x' }] }), /UNKNOWN_FIELD_staffAuthority/);
});

test('CAP-005 deep-freezes descendants even when the input ancestor was already frozen', () => {
  const data = { nested: { value: 'x' } };
  const input = base({ data, evidence: [{ sourceId: 'e1' }], stateChanges: [] });
  Object.freeze(input);
  const normalized = defineCapabilityResult(input as CapabilityResult<typeof data>);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.data), true);
  assert.equal(Object.isFrozen(normalized.data?.nested), true);
  assert.equal(Object.isFrozen(normalized.evidence), true);
});

test('CAP-005 standardizes exactly four TurnOutboundDisposition values without aliases', () => {
  for (const disposition of ['RUNTIME_RESPONSE', 'CAPABILITY_OWNED_QUOTATION', 'HANDOFF_NO_CUSTOMER_MESSAGE', 'NONE'] as const) {
    assert.doesNotThrow(() => validateTurnOutboundDisposition(disposition));
    assert.equal(defineTurnOutboundDisposition(disposition), disposition);
  }
  for (const invalid of ['CAPABILITY_OWNED_OUTBOUND', 'runtime_response', 'QUOTATION', '', null, 1]) {
    assert.throws(() => validateTurnOutboundDisposition(invalid), /INVALID_TURN_OUTBOUND_DISPOSITION/);
  }
});

test('CAP-005 remains type-compatible with existing ServiceResult producers', () => {
  const serviceSuccess: ServiceResult<{ id: string }> = {
    status: 'SUCCEEDED', data: { id: 'q1' }, evidence: [], stateChanges: [],
  };
  const success = normalizeCapabilityResult(serviceSuccess);
  assert.equal(success.status, 'SUCCEEDED');

  const serviceRetry: ServiceResult<{ id: string }> = {
    status: 'RETRYABLE', data: { id: 'q1' }, evidence: [{ sourceId: 'out-1', sourceVersion: 'FAILED' }],
    stateChanges: [], reasonCode: 'OUTBOUND_RETRYABLE_FAILURE', retryable: true,
  };
  assert.equal(normalizeCapabilityResult(serviceRetry).retryable, true);
});
