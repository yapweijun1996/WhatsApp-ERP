import {createHash} from 'node:crypto';

function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CANONICAL_NUMBER_INVALID');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const source=value as Record<string,unknown>;
    const result:Record<string,unknown>={};
    for(const key of Object.keys(source).sort()) if(source[key]!==undefined) result[key]=normalize(source[key]);
    return result;
  }
  throw new Error('CANONICAL_VALUE_INVALID');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
