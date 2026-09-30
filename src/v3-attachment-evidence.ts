import {isProxy} from 'node:util/types';
import {canonicalSha256} from './v2-canonical.js';
import type {V3RetrievalScope} from './v3-retrieval-index.js';
import {V3_ATTACHMENT_SOURCE_CONTRACT_VERSION, type V3AttachmentSourceRecord} from './v3-attachment-source.js';

export const V3_ATTACHMENT_EVIDENCE_CONTRACT_VERSION = 'V3-MM-002' as const;
export const V3_ATTACHMENT_EVIDENCE_SCHEMA_VERSION = 1 as const;

const MAX_STRING = 512;
const MAX_ARRAY = 128;
const MAX_NUMBER = 1_000_000;
const SCOPE_KEYS = ['tenantId', 'accountId', 'channelAccountId', 'conversationId', 'customerId'] as const;
const INPUT_KEYS = ['source', 'mediaType', 'extractionType', 'extractionVersion', 'extractorRef', 'extractorVersion', 'pageNumber', 'regionRef', 'boundingBox', 'timeRange', 'derivedAt', 'freshnessState', 'provenanceRefs'] as const;
const RECORD_KEYS = ['contractVersion', 'schemaVersion', 'authority', 'untrustedAsInstruction', 'grantsEffects', 'aiAuthorityCutoff', 'deterministic', 'bounded', 'scope', 'evidenceId', 'attachmentId', 'sourceMessageId', 'sourceRef', 'sourceContentHash', 'sourceContractVersion', 'sourceSchemaVersion', 'sourceFingerprint', 'mediaType', 'extractionType', 'extractionVersion', 'extractorRef', 'extractorVersion', 'pageNumber', 'regionRef', 'boundingBox', 'timeRange', 'derivedAt', 'freshnessState', 'provenanceRefs', 'trustClass', 'recordFingerprint'] as const;
const SOURCE_KEYS = ['contractVersion', 'schemaVersion', 'authority', 'untrustedAsInstruction', 'grantsEffects', 'aiAuthorityCutoff', 'deterministic', 'bounded', 'scope', 'attachmentId', 'sourceMessageId', 'sourceRef', 'mimeType', 'byteLength', 'contentSha256', 'recordFingerprint'] as const;

type Box = Readonly<{x: number; y: number; width: number; height: number}>;
type TimeRange = Readonly<{start: number; end: number}>;
export type V3AttachmentEvidenceInput = Readonly<{
  source: V3AttachmentSourceRecord;
  mediaType: 'IMAGE'|'PDF'|'DOCUMENT'|'AUDIO'|'OTHER';
  extractionType: 'TEXT'|'OCR'|'VISION'|'TABLE'|'TRANSCRIPT'|'OTHER';
  extractionVersion: string;
  extractorRef: string;
  extractorVersion: string;
  pageNumber: number|null;
  regionRef: string|null;
  boundingBox: Box|null;
  timeRange: TimeRange|null;
  derivedAt: string;
  freshnessState: 'CURRENT'|'STALE'|'SUPERSEDED'|'INVALIDATED';
  provenanceRefs: readonly string[];
}>;
export type V3AttachmentEvidenceRecord = Readonly<{
  contractVersion: typeof V3_ATTACHMENT_EVIDENCE_CONTRACT_VERSION;
  schemaVersion: typeof V3_ATTACHMENT_EVIDENCE_SCHEMA_VERSION;
  authority: 'NON_AUTHORITATIVE_DERIVED';
  untrustedAsInstruction: true;
  grantsEffects: false;
  aiAuthorityCutoff: 'SALES_ORDER.DRAFT';
  deterministic: true;
  bounded: true;
  scope: V3RetrievalScope;
  evidenceId: string;
  attachmentId: string;
  sourceMessageId: string;
  sourceRef: string;
  sourceContentHash: string;
  sourceContractVersion: typeof V3_ATTACHMENT_SOURCE_CONTRACT_VERSION;
  sourceSchemaVersion: 1;
  sourceFingerprint: string;
  mediaType: V3AttachmentEvidenceInput['mediaType'];
  extractionType: V3AttachmentEvidenceInput['extractionType'];
  extractionVersion: string;
  extractorRef: string;
  extractorVersion: string;
  pageNumber: number|null;
  regionRef: string|null;
  boundingBox: Box|null;
  timeRange: TimeRange|null;
  derivedAt: string;
  freshnessState: V3AttachmentEvidenceInput['freshnessState'];
  provenanceRefs: readonly string[];
  trustClass: 'UNTRUSTED_CUSTOMER_EVIDENCE';
  recordFingerprint: string;
}>;

function fail(code: string): never { throw new Error(`V3_ATTACHMENT_EVIDENCE_INVALID:${code}`); }
function frozen<T>(value: T): T { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) frozen(child); Object.freeze(value); } return value; }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !isProxy(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> { if (!plain(value)) fail('CLOSED_DATA'); const own = Reflect.ownKeys(value); if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) fail('CLOSED_DATA'); for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('ACCESSOR'); } return true; }
function text(value: unknown, code: string, max = MAX_STRING): string { if (typeof value !== 'string' || value.trim() === '' || value.length > max) fail(code); return value; }
function nullableText(value: unknown, code: string): string|null { return value === null ? null : text(value, code); }
function finite(value: unknown, code: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_NUMBER) fail(code); return value; }
function scope(value: unknown): V3RetrievalScope { closed(value, SCOPE_KEYS); const c = value as Record<string, unknown>; for (const key of SCOPE_KEYS) key === 'customerId' ? (c[key] === null ? undefined : text(c[key], 'SCOPE')) : text(c[key], 'SCOPE'); return c as V3RetrievalScope; }
function source(value: unknown): V3AttachmentSourceRecord {
  closed(value, SOURCE_KEYS); const c = value as Record<string, unknown>;
  if (c.contractVersion !== V3_ATTACHMENT_SOURCE_CONTRACT_VERSION || c.schemaVersion !== 1 || c.authority !== 'NON_AUTHORITATIVE_DERIVED' || c.untrustedAsInstruction !== true || c.grantsEffects !== false || c.aiAuthorityCutoff !== 'SALES_ORDER.DRAFT' || c.deterministic !== true || c.bounded !== true) fail('SOURCE_CONTRACT');
  scope(c.scope); text(c.attachmentId, 'ATTACHMENT_ID'); text(c.sourceMessageId, 'SOURCE_MESSAGE_ID'); text(c.sourceRef, 'SOURCE_REF'); text(c.mimeType, 'MIME_TYPE', 128);
  if (typeof c.byteLength !== 'number' || !Number.isSafeInteger(c.byteLength) || c.byteLength <= 0 || c.byteLength > 25 * 1024 * 1024) fail('SOURCE_LENGTH');
  if (typeof c.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(c.contentSha256) || typeof c.recordFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(c.recordFingerprint)) fail('SOURCE_HASH');
  const {recordFingerprint: _ignored, ...body} = c; if (c.recordFingerprint !== canonicalSha256(body)) fail('SOURCE_FINGERPRINT');
  return c as V3AttachmentSourceRecord;
}
function box(value: unknown): Box|null { if (value === null) return null; closed(value, ['x', 'y', 'width', 'height']); const c = value as Record<string, unknown>; return {x: finite(c.x, 'BOUNDING_BOX'), y: finite(c.y, 'BOUNDING_BOX'), width: finite(c.width, 'BOUNDING_BOX'), height: finite(c.height, 'BOUNDING_BOX')}; }
function range(value: unknown): TimeRange|null { if (value === null) return null; closed(value, ['start', 'end']); const c = value as Record<string, unknown>; const start = finite(c.start, 'TIME_RANGE'), end = finite(c.end, 'TIME_RANGE'); if (end < start) fail('TIME_RANGE'); return {start, end}; }
function refs(value: unknown): readonly string[] { if (!Array.isArray(value) || isProxy(value) || value.length > MAX_ARRAY) fail('PROVENANCE'); return value.map(v => text(v, 'PROVENANCE_REF')); }
function input(value: unknown): V3AttachmentEvidenceInput { closed(value, INPUT_KEYS); const c = value as Record<string, unknown>; const sourceRecord = source(c.source); const mediaType = c.mediaType, extractionType = c.extractionType, freshnessState = c.freshnessState; if (!['IMAGE','PDF','DOCUMENT','AUDIO','OTHER'].includes(String(mediaType))) fail('MEDIA_TYPE'); if (!['TEXT','OCR','VISION','TABLE','TRANSCRIPT','OTHER'].includes(String(extractionType))) fail('EXTRACTION_TYPE'); if (!['CURRENT','STALE','SUPERSEDED','INVALIDATED'].includes(String(freshnessState))) fail('FRESHNESS'); if (typeof c.pageNumber !== 'number' || !Number.isSafeInteger(c.pageNumber) || c.pageNumber < 1 || c.pageNumber > MAX_NUMBER) { if (c.pageNumber !== null) fail('PAGE_NUMBER'); } return {source: sourceRecord, mediaType: mediaType as V3AttachmentEvidenceInput['mediaType'], extractionType: extractionType as V3AttachmentEvidenceInput['extractionType'], extractionVersion: text(c.extractionVersion, 'EXTRACTION_VERSION'), extractorRef: text(c.extractorRef, 'EXTRACTOR_REF'), extractorVersion: text(c.extractorVersion, 'EXTRACTOR_VERSION'), pageNumber: c.pageNumber as number|null, regionRef: nullableText(c.regionRef, 'REGION_REF'), boundingBox: box(c.boundingBox), timeRange: range(c.timeRange), derivedAt: text(c.derivedAt, 'DERIVED_AT'), freshnessState: freshnessState as V3AttachmentEvidenceInput['freshnessState'], provenanceRefs: refs(c.provenanceRefs)}; }
function body(record: Omit<V3AttachmentEvidenceRecord, 'recordFingerprint'>): Omit<V3AttachmentEvidenceRecord, 'recordFingerprint'> { return record; }

export function buildV3AttachmentEvidence(value: V3AttachmentEvidenceInput): V3AttachmentEvidenceRecord {
  const c = input(value), s = c.source;
  const identity = {sourceFingerprint: s.recordFingerprint, sourceContentHash: s.contentSha256, attachmentId: s.attachmentId, sourceMessageId: s.sourceMessageId, mediaType: c.mediaType, extractionType: c.extractionType, extractionVersion: c.extractionVersion, extractorRef: c.extractorRef, extractorVersion: c.extractorVersion, pageNumber: c.pageNumber, regionRef: c.regionRef, boundingBox: c.boundingBox, timeRange: c.timeRange, provenanceRefs: c.provenanceRefs};
  const evidenceId = `${V3_ATTACHMENT_EVIDENCE_CONTRACT_VERSION}:evidence:${canonicalSha256(identity)}`;
  const candidate = {contractVersion: V3_ATTACHMENT_EVIDENCE_CONTRACT_VERSION, schemaVersion: 1 as const, authority: 'NON_AUTHORITATIVE_DERIVED' as const, untrustedAsInstruction: true as const, grantsEffects: false as const, aiAuthorityCutoff: 'SALES_ORDER.DRAFT' as const, deterministic: true as const, bounded: true as const, scope: {...s.scope}, evidenceId, attachmentId: s.attachmentId, sourceMessageId: s.sourceMessageId, sourceRef: s.sourceRef, sourceContentHash: s.contentSha256, sourceContractVersion: V3_ATTACHMENT_SOURCE_CONTRACT_VERSION, sourceSchemaVersion: 1 as const, sourceFingerprint: s.recordFingerprint, mediaType: c.mediaType, extractionType: c.extractionType, extractionVersion: c.extractionVersion, extractorRef: c.extractorRef, extractorVersion: c.extractorVersion, pageNumber: c.pageNumber, regionRef: c.regionRef, boundingBox: c.boundingBox, timeRange: c.timeRange, derivedAt: c.derivedAt, freshnessState: c.freshnessState, provenanceRefs: [...c.provenanceRefs], trustClass: 'UNTRUSTED_CUSTOMER_EVIDENCE' as const};
  return frozen({...candidate, recordFingerprint: canonicalSha256(body(candidate))});
}

export function verifyV3AttachmentEvidence(record: unknown, expectedSource: V3AttachmentSourceRecord): true {
  closed(record, RECORD_KEYS); const c = record as Record<string, unknown>; const expected = source(expectedSource);
  if (c.contractVersion !== V3_ATTACHMENT_EVIDENCE_CONTRACT_VERSION || c.schemaVersion !== 1 || c.authority !== 'NON_AUTHORITATIVE_DERIVED' || c.untrustedAsInstruction !== true || c.grantsEffects !== false || c.aiAuthorityCutoff !== 'SALES_ORDER.DRAFT' || c.trustClass !== 'UNTRUSTED_CUSTOMER_EVIDENCE') fail('CONTRACT');
  scope(c.scope); text(c.evidenceId, 'EVIDENCE_ID'); text(c.attachmentId, 'ATTACHMENT_ID'); text(c.sourceMessageId, 'SOURCE_MESSAGE_ID'); text(c.sourceRef, 'SOURCE_REF'); if (typeof c.sourceContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(c.sourceContentHash)) fail('SOURCE_HASH'); if (c.sourceContractVersion !== V3_ATTACHMENT_SOURCE_CONTRACT_VERSION || c.sourceSchemaVersion !== 1 || typeof c.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(c.sourceFingerprint)) fail('SOURCE_CONTRACT');
  if (!['IMAGE','PDF','DOCUMENT','AUDIO','OTHER'].includes(String(c.mediaType))) fail('MEDIA_TYPE'); if (!['TEXT','OCR','VISION','TABLE','TRANSCRIPT','OTHER'].includes(String(c.extractionType))) fail('EXTRACTION_TYPE'); text(c.extractionVersion, 'EXTRACTION_VERSION'); text(c.extractorRef, 'EXTRACTOR_REF'); text(c.extractorVersion, 'EXTRACTOR_VERSION'); if (c.pageNumber !== null && (typeof c.pageNumber !== 'number' || !Number.isSafeInteger(c.pageNumber) || c.pageNumber < 1 || c.pageNumber > MAX_NUMBER)) fail('PAGE_NUMBER'); nullableText(c.regionRef, 'REGION_REF'); box(c.boundingBox); range(c.timeRange); text(c.derivedAt, 'DERIVED_AT'); if (!['CURRENT','STALE','SUPERSEDED','INVALIDATED'].includes(String(c.freshnessState))) fail('FRESHNESS'); refs(c.provenanceRefs);
  if (c.attachmentId !== expected.attachmentId || c.sourceMessageId !== expected.sourceMessageId || c.sourceRef !== expected.sourceRef || c.sourceContentHash !== expected.contentSha256 || c.sourceFingerprint !== expected.recordFingerprint || canonicalSha256(expected.scope) !== canonicalSha256(c.scope)) fail('BINDING');
  const copy = {...c}; delete copy.recordFingerprint; if (typeof c.recordFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(c.recordFingerprint) || c.recordFingerprint !== canonicalSha256(copy)) fail('RECORD_FINGERPRINT');
  return true;
}
