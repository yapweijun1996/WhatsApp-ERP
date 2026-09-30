import type { JsonValue, TurnOutboundDisposition } from './v2-capability-contracts.js';

export type { JsonValue, TurnOutboundDisposition };
export type CapabilityStatus = 'SUCCEEDED' | 'NEEDS_CLARIFICATION' | 'BLOCKED' | 'RETRYABLE' | 'FAILED';
export type EvidenceRef = {
  readonly sourceId: string;
  readonly sourceVersion?: string;
  readonly evidenceRefs?: readonly string[];
};
export type StateChangeRef = {
  readonly entity: 'MESSAGE' | 'WORK_ITEM' | 'ORDER_DRAFT' | 'QUOTATION' | 'ACCEPTANCE' | 'SALES_ORDER_DRAFT' | 'STAFF_ACTION' | 'OUTBOUND';
  readonly from?: string;
  readonly to?: string;
  readonly id?: string;
};
export type CapabilityResult<T = unknown> = {
  readonly status: CapabilityStatus;
  readonly data?: T;
  readonly evidence: readonly EvidenceRef[];
  readonly stateChanges: readonly StateChangeRef[];
  readonly reasonCode?: string;
  readonly retryable?: boolean;
  readonly idempotency?: { readonly key: string; readonly replayed: boolean };
  readonly revision?: number;
};

const STATUSES: readonly CapabilityStatus[] = ['SUCCEEDED', 'NEEDS_CLARIFICATION', 'BLOCKED', 'RETRYABLE', 'FAILED'];
const DISPOSITIONS: readonly TurnOutboundDisposition[] = ['RUNTIME_RESPONSE', 'CAPABILITY_OWNED_QUOTATION', 'HANDOFF_NO_CUSTOMER_MESSAGE', 'NONE'];
const RESULT_KEYS = ['status', 'data', 'evidence', 'stateChanges', 'reasonCode', 'retryable', 'idempotency', 'revision'] as const;
const EVIDENCE_KEYS = ['sourceId', 'sourceVersion', 'evidenceRefs'] as const;
const STATE_KEYS = ['entity', 'from', 'to', 'id'] as const;
const IDEMPOTENCY_KEYS = ['key', 'replayed'] as const;
const ENTITIES: readonly StateChangeRef['entity'][] = ['MESSAGE', 'WORK_ITEM', 'ORDER_DRAFT', 'QUOTATION', 'ACCEPTANCE', 'SALES_ORDER_DRAFT', 'STAFF_ACTION', 'OUTBOUND'];
const MAX_REF_STRING = 512;
const MAX_REASON_CODE = 256;
const DANGEROUS_KEYS: ReadonlySet<string> = Object.freeze(new Set(['__proto__', 'prototype', 'constructor']));

type DataDescriptor = PropertyDescriptor & { value: unknown };

function fail(message: string): never {
  throw new Error(`INVALID_CAPABILITY_RESULT:${message}`);
}

function ownObjectData(value: object, field: string): Record<string, DataDescriptor> {
  const result = Object.create(null) as Record<string, DataDescriptor>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${field}_SYMBOL_KEY_NOT_ALLOWED`);
    if (DANGEROUS_KEYS.has(key)) fail(`${field}_DANGEROUS_KEY_${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(`${field}_MUST_BE_JSON`);
    result[key] = descriptor as DataDescriptor;
  }
  return result;
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${field}_MUST_BE_PLAIN_OBJECT`);
  }
  return Object.fromEntries(Object.entries(ownObjectData(value, field)).map(([key, descriptor]) => [key, descriptor.value]));
}

function assertJson(value: unknown, field: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${field}_MUST_BE_JSON`);
    return;
  }
  if (typeof value !== 'object') fail(`${field}_MUST_BE_JSON`);
  if (seen.has(value)) fail(`${field}_MUST_NOT_BE_CIRCULAR`);
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${field}_MUST_BE_JSON`);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.enumerable || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      fail(`${field}_MUST_BE_JSON`);
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) fail(`${field}_MUST_BE_JSON`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(`${field}_MUST_BE_JSON`);
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(`${field}[${index}]_MUST_BE_JSON`);
      assertJson(descriptor.value, `${field}[${index}]`, seen);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail(`${field}_MUST_BE_JSON`);
    for (const [key, descriptor] of Object.entries(ownObjectData(value, field))) {
      assertJson(descriptor.value, `${field}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function cloneJson<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) fail('MUST_NOT_BE_CIRCULAR');
  seen.add(value);
  let output: unknown;
  if (Array.isArray(value)) {
    const length = (Object.getOwnPropertyDescriptor(value, 'length') as PropertyDescriptor & { value: number }).value;
    const array: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index)) as DataDescriptor;
      array.push(cloneJson(descriptor.value, seen));
    }
    output = array;
  } else {
    output = Object.fromEntries(Object.entries(ownObjectData(value, 'value')).map(([key, descriptor]) => [key, cloneJson(descriptor.value, seen)]));
  }
  seen.delete(value);
  return output as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function known(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field}_UNKNOWN_FIELD_${key}`);
}

function nonBlankText(value: unknown, field: string, max = MAX_REF_STRING): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) fail(`${field}_INVALID_STRING`);
}

function reasonCode(value: unknown): asserts value is string {
  nonBlankText(value, 'reasonCode', MAX_REASON_CODE);
  if (!/^[A-Z][A-Z0-9_.:-]*$/.test(value)) fail('reasonCode_MUST_BE_MACHINE_CODE');
}

function validateEvidence(value: unknown): void {
  if (!Array.isArray(value)) fail('evidence_MUST_BE_ARRAY');
  assertJson(value, 'evidence');
  for (let index = 0; index < value.length; index += 1) {
    const ref = plainRecord(value[index], `evidence[${index}]`);
    known(ref, EVIDENCE_KEYS, `evidence[${index}]`);
    nonBlankText(ref.sourceId, `evidence[${index}].sourceId`);
    if ('sourceVersion' in ref) nonBlankText(ref.sourceVersion, `evidence[${index}].sourceVersion`);
    if ('evidenceRefs' in ref) {
      if (!Array.isArray(ref.evidenceRefs)) fail(`evidence[${index}].evidenceRefs_MUST_BE_ARRAY`);
      for (let nestedIndex = 0; nestedIndex < ref.evidenceRefs.length; nestedIndex += 1) {
        nonBlankText(ref.evidenceRefs[nestedIndex], `evidence[${index}].evidenceRefs[${nestedIndex}]`);
      }
    }
  }
}

function validateStateChanges(value: unknown): void {
  if (!Array.isArray(value)) fail('stateChanges_MUST_BE_ARRAY');
  assertJson(value, 'stateChanges');
  for (let index = 0; index < value.length; index += 1) {
    const ref = plainRecord(value[index], `stateChanges[${index}]`);
    known(ref, STATE_KEYS, `stateChanges[${index}]`);
    if (typeof ref.entity !== 'string' || !ENTITIES.includes(ref.entity as StateChangeRef['entity'])) fail(`stateChanges[${index}]_INVALID_ENTITY`);
    for (const field of ['from', 'to', 'id'] as const) if (field in ref) nonBlankText(ref[field], `stateChanges[${index}].${field}`);
  }
}

export function validateCapabilityResult(input: unknown): asserts input is CapabilityResult {
  const value = plainRecord(input, 'result');
  assertJson(input, 'result');
  known(value, RESULT_KEYS, 'result');
  if (!STATUSES.includes(value.status as CapabilityStatus)) fail('INVALID_STATUS');
  if (!('evidence' in value)) fail('evidence_REQUIRED');
  if (!('stateChanges' in value)) fail('stateChanges_REQUIRED');
  validateEvidence(value.evidence);
  validateStateChanges(value.stateChanges);
  if ('data' in value) assertJson(value.data, 'data');
  if ('reasonCode' in value) reasonCode(value.reasonCode);
  if ('retryable' in value && typeof value.retryable !== 'boolean') fail('retryable_MUST_BE_BOOLEAN');
  if (value.status === 'RETRYABLE' && value.retryable !== true) fail('RETRYABLE_REQUIRES_RETRYABLE_TRUE');
  if (value.status !== 'RETRYABLE' && value.retryable === true) fail('NON_RETRYABLE_CANNOT_CLAIM_RETRYABLE');
  if ('idempotency' in value) {
    const idempotency = plainRecord(value.idempotency, 'idempotency');
    known(idempotency, IDEMPOTENCY_KEYS, 'idempotency');
    nonBlankText(idempotency.key, 'idempotency.key');
    if (typeof idempotency.replayed !== 'boolean') fail('idempotency.replayed_MUST_BE_BOOLEAN');
  }
  if ('revision' in value && (!Number.isSafeInteger(value.revision) || (value.revision as number) <= 0)) fail('revision_MUST_BE_POSITIVE_SAFE_INTEGER');
}

export function normalizeCapabilityResult<T = unknown>(input: unknown): Readonly<CapabilityResult<T>> {
  validateCapabilityResult(input);
  return deepFreeze(cloneJson(input)) as Readonly<CapabilityResult<T>>;
}

export function defineCapabilityResult<T>(input: CapabilityResult<T>): Readonly<CapabilityResult<T>> {
  return normalizeCapabilityResult<T>(input);
}

export function validateTurnOutboundDisposition(input: unknown): asserts input is TurnOutboundDisposition {
  if (typeof input !== 'string' || !DISPOSITIONS.includes(input as TurnOutboundDisposition)) {
    throw new Error('INVALID_TURN_OUTBOUND_DISPOSITION:INVALID_VALUE');
  }
}

export function defineTurnOutboundDisposition<T extends TurnOutboundDisposition>(input: T): T {
  validateTurnOutboundDisposition(input);
  return input;
}
