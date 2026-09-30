import { canonicalJson, canonicalSha256 } from './v2-canonical.js';
import type { JsonValue } from './v2-capability-contracts.js';
import { normalizeCapabilityResult, type CapabilityResult, type CapabilityStatus } from './v2-capability-result.js';
import { validateGroundedResponsePlan, type GroundedResponsePlan } from './v2-grounded-response-plan.js';
import { normalizeAgentDecision, type AgentDecision } from './v2-agent-model-transport.js';
import { canonicalTransportId, validateTransportJson } from './v2-transport-contract-helpers.js';

export const DEMO_V1_MAX_INPUT_BYTES = 32 * 1024;
export const DEMO_V1_MAX_OUTPUT_BYTES = 16 * 1024;
export const DEMO_V1_INPUT_TOKEN_BUDGET = 8000;
export const DEMO_V1_OUTPUT_TOKEN_BUDGET = 4000;

export type DemoV1Common = Readonly<{ protocolVersion: 'v1'; turnId: string; sequence: number; correlationId: string; actionId: string }>;
export type DemoV1Envelope =
  | (DemoV1Common & Readonly<{ kind: 'tool_call'; name: string; arguments: JsonValue; capabilityVersion?: string }>)
  | (DemoV1Common & Readonly<{ kind: 'capability_result'; name: string; status: CapabilityStatus; result: CapabilityResult; resultHash: string }>)
  | (DemoV1Common & Readonly<{ kind: 'final_response'; responsePlan: GroundedResponsePlan }>);

function fail(code: string): never { throw new Error(`INVALID_DEMO_V1_ENVELOPE:${code}`); }
function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(`${code}_PLAIN_OBJECT`);
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) { if (typeof key !== 'string') fail(`${code}_SYMBOL`); if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail(`${code}_DANGEROUS_KEY`); const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !('value' in d) || !d.enumerable) fail(`${code}_ACCESSOR`); Object.defineProperty(out, key, { value: d.value, enumerable: true, writable: true, configurable: true }); }
  return out;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], code: string) { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${code}_UNKNOWN_${key}`); }
function id(value: unknown, code: string, max = 160): string { try { return canonicalTransportId(value, code, max); } catch { fail(code); } }
function seq(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) fail('SEQUENCE'); return value as number; }
function json(value: unknown, code: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(`${code}_NONFINITE`); return; }
  if (typeof value !== 'object' || seen.has(value)) fail(`${code}_JSON`); seen.add(value);
  if (Array.isArray(value)) { if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) fail(`${code}_ARRAY`); for (const name of Object.getOwnPropertyNames(value)) { if (name !== 'length' && !/^\d+$/.test(name)) fail(`${code}_ARRAY_KEY`); const descriptor = Object.getOwnPropertyDescriptor(value, name); if (descriptor?.get || descriptor?.set || (name !== 'length' && !descriptor?.enumerable)) fail(`${code}_ARRAY_DESCRIPTOR`); } for (let i = 0; i < value.length; i++) { if (!Object.prototype.hasOwnProperty.call(value, String(i))) fail(`${code}_HOLE`); json(value[i], `${code}[${i}]`, seen); } }
  else { const object = record(value, code); for (const child of Object.values(object)) json(child, code, seen); }
  seen.delete(value);
}
function common(v: Record<string, unknown>) { if (v.protocolVersion !== 'v1') fail('PROTOCOL_VERSION'); return { protocolVersion: 'v1' as const, turnId: id(v.turnId, 'TURN_ID', 256), sequence: seq(v.sequence), correlationId: id(v.correlationId, 'CORRELATION_ID', 256), actionId: id(v.actionId, 'ACTION_ID', 256) }; }
function unsignedResult(v: DemoV1Envelope & { kind: 'capability_result' }) { const { resultHash: _ignored, ...unsigned } = v; return unsigned; }
function clone(value: any, seen = new Set<object>()): any {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) fail('CYCLE'); seen.add(value);
  const result = Array.isArray(value) ? value.map(item => clone(item, seen)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item, seen)]));
  seen.delete(value); return Object.freeze(result);
}

export function computeDemoV1ResultHash(input: Omit<DemoV1Envelope, 'resultHash'> & { kind: 'capability_result' }): string {
  validateTransportJson(input, 'RESULT_HASH_INPUT', true);
  const v = record(input, 'RESULT_HASH_INPUT'); keys(v, ['protocolVersion','turnId','sequence','correlationId','actionId','kind','name','status','result'], 'RESULT_HASH_INPUT');
  common(v); if (v.kind !== 'capability_result') fail('RESULT_HASH_KIND'); id(v.name, 'NAME', 160);
  const normalized = normalizeCapabilityResult(v.result); if (v.status !== normalized.status) fail('STATUS_RESULT_MISMATCH');
  const hashRecord = { protocolVersion: 'v1' as const, turnId: v.turnId, sequence: v.sequence, correlationId: v.correlationId, actionId: v.actionId, kind: 'capability_result' as const, name: v.name, status: normalized.status, result: normalized };
  return canonicalSha256(hashRecord);
}
export function verifyDemoV1ResultHash(input: unknown): boolean {
  try { const v = normalizeDemoV1Envelope(input); return v.kind === 'capability_result' && v.resultHash === computeDemoV1ResultHash(unsignedResult(v)); } catch { return false; }
}

export function normalizeDemoV1Envelope(input: unknown): DemoV1Envelope {
  json(input, 'ENVELOPE'); const v = record(input, 'ENVELOPE'); const c = common(v);
  let result: DemoV1Envelope;
  if (v.kind === 'tool_call') {
    keys(v, ['protocolVersion','turnId','sequence','correlationId','actionId','kind','name','capabilityVersion','arguments'], 'TOOL_CALL');
    if ('arguments' in v === false) fail('ARGUMENTS_REQUIRED'); validateTransportJson(v.arguments, 'ARGUMENTS', true);
    const item = { ...c, kind: 'tool_call' as const, name: id(v.name, 'NAME', 160), ...(v.capabilityVersion === undefined ? {} : { capabilityVersion: id(v.capabilityVersion, 'CAPABILITY_VERSION', 80) }), arguments: clone(v.arguments) as JsonValue };
    result = item;
  } else if (v.kind === 'capability_result') {
    keys(v, ['protocolVersion','turnId','sequence','correlationId','actionId','kind','name','status','result','resultHash'], 'CAPABILITY_RESULT');
    validateTransportJson(v.result, 'RESULT', true); const normalized = normalizeCapabilityResult(v.result); if (v.status !== normalized.status) fail('STATUS_RESULT_MISMATCH');
    if (typeof v.resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.resultHash)) fail('RESULT_HASH');
    const item = { ...c, kind: 'capability_result' as const, name: id(v.name, 'NAME', 160), status: normalized.status, result: normalized, resultHash: v.resultHash };
    if (item.resultHash !== computeDemoV1ResultHash(unsignedResult(item))) fail('RESULT_HASH_MISMATCH'); result = item;
  } else if (v.kind === 'final_response') {
    keys(v, ['protocolVersion','turnId','sequence','correlationId','actionId','kind','responsePlan'], 'FINAL_RESPONSE');
    result = { ...c, kind: 'final_response' as const, responsePlan: validateGroundedResponsePlan(v.responsePlan, c.turnId) };
  } else fail('KIND');
  const size = Buffer.byteLength(canonicalJson(result), 'utf8');
  if (size > (result.kind === 'tool_call' ? DEMO_V1_MAX_INPUT_BYTES : DEMO_V1_MAX_OUTPUT_BYTES)) fail('ENVELOPE_SIZE');
  return clone(result) as DemoV1Envelope;
}

export const validateDemoV1Envelope = normalizeDemoV1Envelope;

export type DemoV1BudgetDirection = 'input' | 'output';
export type DemoV1BudgetMeasurement = Readonly<{ direction: DemoV1BudgetDirection; bytes: number; tokenCount: number }>;

/** Contract assertion for measurements supplied by a matched future transport.
 * This function deliberately does not tokenize or estimate tokens. */
export function assertDemoV1Budget(input: unknown): asserts input is DemoV1BudgetMeasurement {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) fail('BUDGET_MEASUREMENT');
  const v = input as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) { if (typeof key !== 'string' || !['direction', 'bytes', 'tokenCount'].includes(key)) fail('BUDGET_MEASUREMENT_FIELDS'); const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('BUDGET_MEASUREMENT_FIELDS'); }
  if (v.direction !== 'input' && v.direction !== 'output') fail('BUDGET_DIRECTION');
  for (const field of ['bytes', 'tokenCount']) {
    const value = v[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`BUDGET_${field.toUpperCase()}`);
  }
  const byteLimit = v.direction === 'input' ? DEMO_V1_MAX_INPUT_BYTES : DEMO_V1_MAX_OUTPUT_BYTES;
  const tokenLimit = v.direction === 'input' ? DEMO_V1_INPUT_TOKEN_BUDGET : DEMO_V1_OUTPUT_TOKEN_BUDGET;
  if ((v.bytes as number) > byteLimit || (v.tokenCount as number) > tokenLimit) fail('BUDGET_EXCEEDED');
}

/** Fixture-only semantic mapping; it does not execute, register, or authorize a capability. */
export function demoV1ToAgentDecision(input: DemoV1Envelope): AgentDecision {
  const envelope = normalizeDemoV1Envelope(input);
  if (envelope.kind === 'tool_call') return normalizeAgentDecision({ kind: 'tool_call', turnId: envelope.turnId, sequence: envelope.sequence, correlationId: envelope.correlationId, actionId: envelope.actionId, capabilityName: envelope.name, ...(envelope.capabilityVersion === undefined ? {} : { capabilityVersion: envelope.capabilityVersion }), arguments: envelope.arguments });
  if (envelope.kind === 'final_response') return normalizeAgentDecision({ kind: 'final_response', turnId: envelope.turnId, sequence: envelope.sequence, correlationId: envelope.correlationId, actionId: envelope.actionId, responsePlan: envelope.responsePlan });
  fail('RESULT_IS_NOT_DECISION');
}
