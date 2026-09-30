import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {canonicalSha256} from './v2-canonical.js';
import type {V3RetrievalScope} from './v3-retrieval-index.js';

export const V3_ATTACHMENT_SOURCE_CONTRACT_VERSION = 'V3-MM-001' as const;
export const V3_ATTACHMENT_SOURCE_SCHEMA_VERSION = 1 as const;

const MAX_STRING = 512;
const MAX_MIME_TYPE = 128;
const MAX_BYTES = 25 * 1024 * 1024;
const SCOPE_KEYS = ['tenantId', 'accountId', 'channelAccountId', 'conversationId', 'customerId'] as const;
const INPUT_KEYS = ['scope', 'attachmentId', 'sourceMessageId', 'sourceRef', 'mimeType', 'bytes'] as const;
const RECORD_KEYS = ['contractVersion', 'schemaVersion', 'authority', 'untrustedAsInstruction', 'grantsEffects', 'aiAuthorityCutoff', 'deterministic', 'bounded', 'scope', 'attachmentId', 'sourceMessageId', 'sourceRef', 'mimeType', 'byteLength', 'contentSha256', 'recordFingerprint'] as const;

export type V3AttachmentSourceInput = Readonly<{
  scope: V3RetrievalScope;
  attachmentId: string;
  sourceMessageId: string;
  sourceRef: string;
  mimeType: string;
  bytes: Uint8Array;
}>;

export type V3AttachmentSourceRecord = Readonly<{
  contractVersion: typeof V3_ATTACHMENT_SOURCE_CONTRACT_VERSION;
  schemaVersion: typeof V3_ATTACHMENT_SOURCE_SCHEMA_VERSION;
  authority: 'NON_AUTHORITATIVE_DERIVED';
  untrustedAsInstruction: true;
  grantsEffects: false;
  aiAuthorityCutoff: 'SALES_ORDER.DRAFT';
  deterministic: true;
  bounded: true;
  scope: V3RetrievalScope;
  attachmentId: string;
  sourceMessageId: string;
  sourceRef: string;
  mimeType: string;
  byteLength: number;
  contentSha256: string;
  recordFingerprint: string;
}>;

export type V3AttachmentSourceBinding = Readonly<{
  scope: V3RetrievalScope;
  attachmentId: string;
  sourceMessageId: string;
  sourceRef: string;
}>;

function fail(code: string): never { throw new Error(`V3_ATTACHMENT_SOURCE_INVALID:${code}`); }
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !isProxy(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plain(value)) fail('CLOSED_DATA');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail('CLOSED_DATA');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('ACCESSOR');
  }
  return true;
}
function string(value: unknown, code: string, max = MAX_STRING): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) fail(code);
  return value;
}
function scope(value: unknown): V3RetrievalScope {
  closed(value, SCOPE_KEYS);
  const candidate = value as Record<string, unknown>;
  for (const key of SCOPE_KEYS) {
    if (key === 'customerId') { if (candidate[key] !== null) string(candidate[key], 'SCOPE'); }
    else string(candidate[key], 'SCOPE');
  }
  return candidate as V3RetrievalScope;
}
function bytes(value: unknown): Uint8Array {
  if (value === null || typeof value !== 'object' || isProxy(value) || !(value instanceof Uint8Array)) fail('BYTES');
  if (value.byteLength === 0) fail('EMPTY_BYTES');
  if (value.byteLength > MAX_BYTES) fail('BYTES_TOO_LARGE');
  return value;
}
function digest(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function sameScope(a: V3RetrievalScope, b: V3RetrievalScope): boolean { return SCOPE_KEYS.every(key => a[key] === b[key]); }
function identityBody(record: Omit<V3AttachmentSourceRecord, 'recordFingerprint'>): Omit<V3AttachmentSourceRecord, 'recordFingerprint'> { return record; }
function input(value: unknown): V3AttachmentSourceInput {
  closed(value, INPUT_KEYS);
  const candidate = value as Record<string, unknown>;
  return {scope: scope(candidate.scope), attachmentId: string(candidate.attachmentId, 'ATTACHMENT_ID'), sourceMessageId: string(candidate.sourceMessageId, 'SOURCE_MESSAGE_ID'), sourceRef: string(candidate.sourceRef, 'SOURCE_REF'), mimeType: string(candidate.mimeType, 'MIME_TYPE', MAX_MIME_TYPE), bytes: bytes(candidate.bytes)};
}
function binding(value: unknown): V3AttachmentSourceBinding {
  closed(value, ['scope', 'attachmentId', 'sourceMessageId', 'sourceRef']);
  const candidate = value as Record<string, unknown>;
  return {scope: scope(candidate.scope), attachmentId: string(candidate.attachmentId, 'ATTACHMENT_ID'), sourceMessageId: string(candidate.sourceMessageId, 'SOURCE_MESSAGE_ID'), sourceRef: string(candidate.sourceRef, 'SOURCE_REF')};
}
function validateRecord(value: unknown): V3AttachmentSourceRecord {
  closed(value, RECORD_KEYS);
  const candidate = value as Record<string, unknown>;
  if (candidate.contractVersion !== V3_ATTACHMENT_SOURCE_CONTRACT_VERSION || candidate.schemaVersion !== 1 || candidate.authority !== 'NON_AUTHORITATIVE_DERIVED' || candidate.untrustedAsInstruction !== true || candidate.grantsEffects !== false || candidate.aiAuthorityCutoff !== 'SALES_ORDER.DRAFT' || candidate.deterministic !== true || candidate.bounded !== true) fail('CONTRACT');
  scope(candidate.scope); string(candidate.attachmentId, 'ATTACHMENT_ID'); string(candidate.sourceMessageId, 'SOURCE_MESSAGE_ID'); string(candidate.sourceRef, 'SOURCE_REF'); string(candidate.mimeType, 'MIME_TYPE', MAX_MIME_TYPE);
  const byteLength = candidate.byteLength;
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > MAX_BYTES) fail('BYTE_LENGTH');
  if (typeof candidate.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.contentSha256)) fail('CONTENT_HASH');
  if (typeof candidate.recordFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.recordFingerprint)) fail('RECORD_FINGERPRINT');
  return candidate as V3AttachmentSourceRecord;
}

export function buildV3AttachmentSource(value: V3AttachmentSourceInput): V3AttachmentSourceRecord {
  const candidate = input(value), contentSha256 = digest(candidate.bytes);
  const body = {contractVersion: V3_ATTACHMENT_SOURCE_CONTRACT_VERSION, schemaVersion: 1 as const, authority: 'NON_AUTHORITATIVE_DERIVED' as const, untrustedAsInstruction: true as const, grantsEffects: false as const, aiAuthorityCutoff: 'SALES_ORDER.DRAFT' as const, deterministic: true as const, bounded: true as const, scope: {...candidate.scope}, attachmentId: candidate.attachmentId, sourceMessageId: candidate.sourceMessageId, sourceRef: candidate.sourceRef, mimeType: candidate.mimeType, byteLength: candidate.bytes.byteLength, contentSha256};
  return frozen({...body, recordFingerprint: canonicalSha256(identityBody(body))});
}

export function verifyV3AttachmentSource(record: unknown, expected: V3AttachmentSourceBinding, rawBytes: Uint8Array): true {
  const actual = validateRecord(record), expectedBinding = binding(expected), actualBytes = bytes(rawBytes);
  if (!sameScope(actual.scope, expectedBinding.scope) || actual.attachmentId !== expectedBinding.attachmentId || actual.sourceMessageId !== expectedBinding.sourceMessageId || actual.sourceRef !== expectedBinding.sourceRef) fail('BINDING');
  const contentSha256 = digest(actualBytes);
  if (actual.byteLength !== actualBytes.byteLength || actual.contentSha256 !== contentSha256) fail('CONTENT_INTEGRITY');
  const body = {...actual}; delete (body as {recordFingerprint?: string}).recordFingerprint;
  if (actual.recordFingerprint !== canonicalSha256(body)) fail('RECORD_FINGERPRINT');
  return true;
}
