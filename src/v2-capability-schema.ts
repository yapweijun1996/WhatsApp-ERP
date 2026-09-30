import type { CapabilityDefinition, JsonSchema, JsonValue } from './v2-capability-contracts.js';

const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
export const MAX_CAPABILITY_ARGUMENT_BYTES = 16 * 1024;
const MAX_DEPTH = 16;
const MAX_NODES = 512;
const MAX_ARRAY_LENGTH = 128;
const MAX_OBJECT_KEYS = 128;
const MAX_STRING_BYTES = 8 * 1024;
const fail = (code: string): never => { throw new Error(`CAPABILITY_SCHEMA_INVALID:${code}`); };
type Data = PropertyDescriptor & { value: unknown };

function dataObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value as object) !== Object.prototype) fail(`${path}_OBJECT`);
  const object = value as object;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string') fail(`${path}_SYMBOL`);
    if (typeof key === 'string' && DANGEROUS.has(key)) fail(`${path}_DANGEROUS_KEY`);
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(`${path}_DESCRIPTOR`);
    out[key as string] = (descriptor as Data).value;
  }
  return out;
}

type Limits = { nodes: number };

function json(value: unknown, path: string, seen = new Set<object>(), depth = 0, limits: Limits = { nodes: 0 }): JsonValue {
  limits.nodes += 1;
  if (limits.nodes > MAX_NODES) fail(`${path}_NODE_LIMIT`);
  if (depth > MAX_DEPTH) fail(`${path}_DEPTH_LIMIT`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) fail(`${path}_STRING_LIMIT`); return value; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(`${path}_NONFINITE`); return value; }
  if (typeof value !== 'object' || value === null || seen.has(value)) fail(`${path}_JSON`);
  seen.add(value as object);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value as object) !== Array.prototype) fail(`${path}_ARRAY`);
    const length = Object.getOwnPropertyDescriptor(value, 'length') as (PropertyDescriptor & { value: number }) | undefined;
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value)) fail(`${path}_ARRAY`);
    const size = (length as PropertyDescriptor & { value: number }).value;
    if (size > MAX_ARRAY_LENGTH) fail(`${path}_ARRAY_LENGTH_LIMIT`);
    const out: JsonValue[] = [];
    for (let i = 0; i < size; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i)) as Data | undefined;
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(`${path}_SPARSE`);
      out.push(json((descriptor as Data).value, `${path}[${i}]`, seen, depth + 1, limits));
    }
    for (const key of Reflect.ownKeys(value)) if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= size)) fail(`${path}_KEY`);
    seen.delete(value as object); return out;
  }
  const source = dataObject(value, path);
  if (Object.keys(source).length > MAX_OBJECT_KEYS) fail(`${path}_OBJECT_KEYS_LIMIT`);
  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(source)) out[key] = json(child, `${path}.${key}`, seen, depth + 1, limits);
  seen.delete(value as object); return out;
}

function validate(value: unknown, schema: JsonSchema, path: string): JsonValue {
  const result = json(value, path);
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > MAX_CAPABILITY_ARGUMENT_BYTES) fail(`${path}_BYTE_LIMIT`);
  if (schema.enum && !schema.enum.some(item => Object.is(item, result))) fail(`${path}_ENUM`);
  if (schema.type === 'null' && result !== null) fail(`${path}_TYPE`);
  if (schema.type === 'string' && typeof result !== 'string') fail(`${path}_TYPE`);
  if (schema.type === 'string' && typeof result === 'string' && typeof schema.minLength === 'number' && result.length < schema.minLength) fail(`${path}_MIN_LENGTH`);
  if (schema.type === 'string' && typeof result === 'string' && typeof schema.maxLength === 'number' && result.length > schema.maxLength) fail(`${path}_MAX_LENGTH`);
  if (schema.type === 'boolean' && typeof result !== 'boolean') fail(`${path}_TYPE`);
  if (schema.type === 'number' && (typeof result !== 'number')) fail(`${path}_TYPE`);
  if (schema.type === 'integer' && (typeof result !== 'number' || !Number.isSafeInteger(result))) fail(`${path}_TYPE`);
  if ((schema.type === 'number' || schema.type === 'integer') && typeof result === 'number') {
    if (typeof schema.minimum === 'number' && result < schema.minimum) fail(`${path}_MINIMUM`);
    if (typeof schema.maximum === 'number' && result > schema.maximum) fail(`${path}_MAXIMUM`);
  }
  if (schema.type === 'array') {
    if (!schema.items || !Array.isArray(result)) fail(`${path}_TYPE`);
    if (typeof schema.minItems === 'number' && (result as JsonValue[]).length < schema.minItems) fail(`${path}_MIN_ITEMS`);
    if (typeof schema.maxItems === 'number' && (result as JsonValue[]).length > schema.maxItems) fail(`${path}_MAX_ITEMS`);
    return (result as JsonValue[]).map((item, index) => validate(item, schema.items!, `${path}[${index}]`));
  }
  if (schema.type === 'object') {
    if (result === null || Array.isArray(result) || typeof result !== 'object') fail(`${path}_TYPE`);
    const source = result as Record<string, JsonValue>;
    const properties = schema.properties ?? {};
    for (const key of Object.keys(source)) {
      if (!(key in properties) && schema.additionalProperties === false) fail(`${path}_UNKNOWN_${key}`);
      const child = properties[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
      if (child) validate(source[key], child, `${path}.${key}`);
    }
    for (const key of schema.required ?? []) if (!Object.prototype.hasOwnProperty.call(source, key)) fail(`${path}_MISSING_${key}`);
  }
  return result;
}

export function validateCapabilityArgumentsForDefinition(definition: CapabilityDefinition, value: unknown): JsonValue {
  return validate(value, definition.inputSchema, 'ARGUMENTS');
}
