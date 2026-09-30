import { redactContextText } from './v2-context-projection.js';
import type { JsonValue } from './v2-capability-contracts.js';
import { canonicalSha256 } from './v2-canonical.js';

const BUSINESS_KEYS = new Set(['token', 'auth', 'authorization', 'apikey', 'provider', 'providername', 'requestid', 'latency', 'secret', 'password', 'credential', 'session', 'bearer', 'privatekey', 'rawpayload']);
const TRANSPORT_KEYS = new Set(['requestid', 'latency', 'providername']);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function transportFail(code: string): never { throw new Error(`INVALID_AGENT_TRANSPORT:${code}`); }

function ownData(value: object, code: string): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) transportFail(`${code}_PLAIN_OBJECT`);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') transportFail(`${code}_SYMBOL`);
    if (DANGEROUS_KEYS.has(key)) transportFail(`${code}_DANGEROUS_KEY`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) transportFail(`${code}_ACCESSOR`);
    output[key] = descriptor.value;
  }
  return output;
}

function keyName(key: string): string { return key.replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function sensitiveKey(key: string): boolean { return BUSINESS_KEYS.has(key) || /(?:token|auth|secret|password|credential|session|apikey|provider|requestid|latency|bearer|privatekey|rawpayload)/.test(key); }
function transportKeyAllowed(key: string): boolean { return TRANSPORT_KEYS.has(key) || /^latency(?:ms)?$/.test(key); }

/** Validate JSON plus the contract's primary key-based secret boundary. */
export function validateTransportJson(value: unknown, code: string, business: boolean, maxBytes?: number): asserts value is JsonValue {
  const seen = new Set<object>();
  const visit = (item: unknown, path: string): void => {
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (item.includes('\u0000')) transportFail(`${path}_CONTROL`);
      if (redactContextText(item) !== item) transportFail(`${path}_SECRET_VALUE`);
      return;
    }
    if (typeof item === 'number') { if (!Number.isFinite(item)) transportFail(`${path}_NONFINITE`); return; }
    if (typeof item !== 'object') transportFail(`${path}_NOT_JSON`);
    if (seen.has(item)) transportFail(`${path}_CYCLE`);
    seen.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length) transportFail(`${path}_ARRAY`);
      for (const key of Object.getOwnPropertyNames(item)) {
        if (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) transportFail(`${path}_ARRAY_KEY`);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (key !== 'length' && (!descriptor || !('value' in descriptor) || !descriptor.enumerable)) transportFail(`${path}_ARRAY_DESCRIPTOR`);
      }
      for (let index = 0; index < item.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(item, String(index))) transportFail(`${path}_HOLE`);
        visit(item[index], `${path}[${index}]`);
      }
    } else {
      const object = ownData(item, path);
      for (const [key, child] of Object.entries(object)) {
        const normalized = keyName(key);
        if (business ? sensitiveKey(normalized) : (sensitiveKey(normalized) && !transportKeyAllowed(normalized))) transportFail(`${path}_${key}_SENSITIVE_KEY`);
        visit(child, `${path}.${key}`);
      }
    }
    seen.delete(item);
  };
  visit(value, code);
  if (maxBytes !== undefined) {
    const detached = (item: unknown, seen = new Set<object>()): JsonValue => {
      if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') return item as JsonValue;
      if (typeof item !== 'object' || seen.has(item)) transportFail(`${code}_CLONE`);
      seen.add(item);
      let result: JsonValue;
      if (Array.isArray(item)) {
        const length = (Object.getOwnPropertyDescriptor(item, 'length') as PropertyDescriptor & { value: number }).value;
        const output: JsonValue[] = [];
        for (let i = 0; i < length; i++) output.push(detached((Object.getOwnPropertyDescriptor(item, String(i)) as PropertyDescriptor & { value: unknown }).value, seen));
        result = output;
      } else {
        const output: Record<string, JsonValue> = {};
        for (const key of Reflect.ownKeys(item)) {
          if (key === 'length' || typeof key !== 'string') transportFail(`${code}_CLONE`);
          output[key] = detached((Object.getOwnPropertyDescriptor(item, key) as PropertyDescriptor & { value: unknown }).value, seen);
        }
        result = output;
      }
      seen.delete(item); return result;
    };
    const bytes = Buffer.byteLength(JSON.stringify(detached(value)), 'utf8');
    if (bytes > maxBytes) transportFail(`${code}_SIZE`);
  }
}

export function machineCode(value: unknown, code: string, max = 80): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_.:-]{0,79}$/.test(value) || value.length > max) transportFail(code);
  return value;
}

export function boundedTransportText(value: unknown, code: string, max = 4096): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\u0000') || redactContextText(value) !== value) transportFail(code);
  return value;
}

export function canonicalTransportId(value: unknown, code: string, max = 256): string {
  const result = boundedTransportText(value, code, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#@+-]*$/.test(result) || /(?:secret|password|passwd|token|bearer|api[_-]?key|authorization|provider|staff|employee|auth|raw[_-]?payload|webhook|whatsapp|cookie|session|private[_-]?key|credential)/i.test(result)) transportFail(`${code}_UNSAFE`);
  return result;
}

/** Provider-independent per-turn identity for one model decision. */
export function deriveAgentDecisionIdentity(turnId: string, sequence: number): Readonly<{ correlationId: string; actionId: string }> {
  canonicalTransportId(turnId, 'DECISION_TURN_ID', 160);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) transportFail('DECISION_IDENTITY');
  const digest = canonicalSha256({ domain: 'v2-agent-decision-identity', turnId, sequence });
  return Object.freeze({ correlationId: `agent:${digest.slice(0, 32)}`, actionId: `action:${digest.slice(32)}` });
}

export function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) transportFail(`${code}_PLAIN_OBJECT`);
  return ownData(value, code);
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) transportFail(`${code}_UNKNOWN_${key}`);
}

export type TransportMetadata = Readonly<{
  requestId?: string;
  latencyMs?: number;
  providerName?: string;
}>;

/** Normalize the deliberately closed, non-business transport metadata surface. */
export function normalizeTransportMetadata(value: unknown, code: string): TransportMetadata {
  const input = plainRecord(value, code);
  for (const key of Object.keys(input)) {
    if (DANGEROUS_KEYS.has(key)) transportFail(`${code}_DANGEROUS_KEY`);
    if (!['requestId', 'latency', 'latencyMs', 'providerName'].includes(key)) transportFail(`${code}_UNKNOWN_${key}`);
  }
  if ('latency' in input && 'latencyMs' in input) transportFail(`${code}_LATENCY_AMBIGUOUS`);
  const hasRequestId = Object.prototype.hasOwnProperty.call(input, 'requestId');
  const hasProviderName = Object.prototype.hasOwnProperty.call(input, 'providerName');
  const hasLatency = Object.prototype.hasOwnProperty.call(input, 'latency');
  const hasLatencyMs = Object.prototype.hasOwnProperty.call(input, 'latencyMs');
  const requestId = hasRequestId ? canonicalTransportId(input.requestId, `${code}_REQUEST_ID`, 256) : undefined;
  const providerName = hasProviderName ? boundedTransportText(input.providerName, `${code}_PROVIDER_NAME`, 160) : undefined;
  const rawLatency = hasLatencyMs ? input.latencyMs : hasLatency ? input.latency : undefined;
  let latencyMs: number | undefined;
  if (rawLatency !== undefined) {
    if (typeof rawLatency !== 'number' || !Number.isSafeInteger(rawLatency) || rawLatency < 0 || rawLatency > 86_400_000) transportFail(`${code}_LATENCY`);
    latencyMs = rawLatency;
  }
  return Object.freeze({
    ...(requestId === undefined ? {} : { requestId }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(providerName === undefined ? {} : { providerName }),
  });
}
