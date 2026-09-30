import {isProxy} from 'node:util/types';
import {canonicalSha256} from './v2-canonical.js';
import {buildV3AttachmentEvidence, type V3AttachmentEvidenceRecord} from './v3-attachment-evidence.js';
import type {V3AttachmentSourceRecord} from './v3-attachment-source.js';

export const V3_ATTACHMENT_EXTRACTION_CONTRACT_VERSION = 'V3-MM-003' as const;
export const V3_ATTACHMENT_EXTRACTION_SCHEMA_VERSION = 1 as const;

export type V3ExtractionKind = 'TEXT'|'OCR'|'VISION'|'TABLE'|'TRANSCRIPT';
export type V3ExtractionMediaKind = 'IMAGE'|'PDF'|'DOCUMENT'|'AUDIO';
export type V3ExtractionStatus = 'SUCCEEDED'|'FAILED';
export type V3ExtractionErrorCode = 'ADAPTER_FAILURE'|'INVALID_OUTPUT'|'OUTPUT_TOO_LARGE'|'INCOMPATIBLE_MEDIA_KIND'|'SOURCE_MISMATCH';

type TextOutput = Readonly<{text: string}>;
type VisionOutput = Readonly<{description: string}>;
type TableOutput = Readonly<{columns: readonly string[]; rows: readonly (readonly string[])[]}>;
export type V3NormalizedExtraction = TextOutput|VisionOutput|TableOutput;

export type V3AttachmentExtractionRequest = Readonly<{
  source: V3AttachmentSourceRecord;
  mediaKind: V3ExtractionMediaKind;
  extractionKind: V3ExtractionKind;
  extractionVersion: string;
  derivedAt: string;
  provenanceRefs: readonly string[];
  pageNumber: number|null;
  regionRef: string|null;
  timeRange: Readonly<{start: number; end: number}>|null;
}>;

export type V3AttachmentExtractionAdapter = Readonly<{
  adapterId: string;
  adapterVersion: string;
  extract: (request: V3AttachmentExtractionRequest) => unknown;
}>;

export type V3AttachmentExtractionResult = Readonly<{
  contractVersion: typeof V3_ATTACHMENT_EXTRACTION_CONTRACT_VERSION;
  schemaVersion: typeof V3_ATTACHMENT_EXTRACTION_SCHEMA_VERSION;
  status: V3ExtractionStatus;
  errorCode: V3ExtractionErrorCode|null;
  adapterId: string;
  adapterVersion: string;
  mediaKind: V3ExtractionMediaKind;
  extractionKind: V3ExtractionKind;
  source: Readonly<{attachmentId: string; sourceMessageId: string; sourceRef: string; sourceFingerprint: string}>;
  output: V3NormalizedExtraction|null;
  outputFingerprint: string|null;
  evidence: V3AttachmentEvidenceRecord|null;
  authority: 'NON_AUTHORITATIVE_DERIVED';
  untrustedAsInstruction: true;
  grantsEffects: false;
  aiAuthorityCutoff: 'SALES_ORDER.DRAFT';
  deterministic: true;
  bounded: true;
}>;

const MAX_STRING = 16_384;
const MAX_ADAPTER_STRING = 256;
const MAX_CELLS = 256;
const MAX_PROVENANCE = 128;
const MEDIA = ['IMAGE', 'PDF', 'DOCUMENT', 'AUDIO'] as const;
const KINDS = ['TEXT', 'OCR', 'VISION', 'TABLE', 'TRANSCRIPT'] as const;
const COMPATIBILITY: Record<V3ExtractionKind, readonly V3ExtractionMediaKind[]> = {
  TEXT: ['PDF', 'DOCUMENT'], OCR: ['IMAGE', 'PDF', 'DOCUMENT'], VISION: ['IMAGE', 'PDF', 'DOCUMENT'],
  TABLE: ['IMAGE', 'PDF', 'DOCUMENT'], TRANSCRIPT: ['AUDIO'],
};

function fail(code: V3ExtractionErrorCode): never { throw new Error(`V3_ATTACHMENT_EXTRACTION_INVALID:${code}`); }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !isProxy(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> { if (!plain(value)) fail('INVALID_OUTPUT'); const own = Reflect.ownKeys(value); if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) fail('INVALID_OUTPUT'); for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !d.enumerable || !('value' in d)) fail('INVALID_OUTPUT'); } return true; }
function string(value: unknown, max = MAX_STRING): string { if (typeof value !== 'string' || value.trim() === '' || value.length > max) fail(value && typeof value === 'string' && value.length > max ? 'OUTPUT_TOO_LARGE' : 'INVALID_OUTPUT'); return value; }
function frozen<T>(value: T): T { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) frozen(child); Object.freeze(value); } return value; }
function normalize(value: unknown, kind: V3ExtractionKind): V3NormalizedExtraction {
  if (kind === 'TABLE') {
    closed(value, ['columns', 'rows']); const v = value as Record<string, unknown>;
    if (!Array.isArray(v.columns) || !Array.isArray(v.rows) || v.columns.length === 0 || v.columns.length > MAX_CELLS || v.rows.length > MAX_CELLS) fail('INVALID_OUTPUT');
    const columns = v.columns.map(c => string(c, 512)); const rows = v.rows.map(row => { if (!Array.isArray(row) || row.length !== columns.length) fail('INVALID_OUTPUT'); return row.map(cell => string(cell, 2_048)); });
    if (columns.length * Math.max(1, rows.length) > MAX_CELLS) fail('OUTPUT_TOO_LARGE');
    return {columns, rows};
  }
  if (kind === 'VISION') { closed(value, ['description']); return {description: string((value as Record<string, unknown>).description)}; }
  closed(value, ['text']); return {text: string((value as Record<string, unknown>).text)};
}
function request(value: V3AttachmentExtractionRequest): V3AttachmentExtractionRequest {
  if (!MEDIA.includes(value.mediaKind) || !KINDS.includes(value.extractionKind)) fail('INVALID_OUTPUT');
  if (!COMPATIBILITY[value.extractionKind].includes(value.mediaKind)) fail('INCOMPATIBLE_MEDIA_KIND');
  string(value.extractionVersion, MAX_ADAPTER_STRING); string(value.derivedAt, MAX_ADAPTER_STRING);
  if (!Array.isArray(value.provenanceRefs) || value.provenanceRefs.length > MAX_PROVENANCE) fail('INVALID_OUTPUT'); value.provenanceRefs.forEach(ref => string(ref, 512));
  return value;
}
function base(requested: V3AttachmentExtractionRequest, adapter: V3AttachmentExtractionAdapter, status: V3ExtractionStatus, errorCode: V3ExtractionErrorCode|null, output: V3NormalizedExtraction|null, evidence: V3AttachmentEvidenceRecord|null): V3AttachmentExtractionResult {
  const source = {attachmentId: requested.source.attachmentId, sourceMessageId: requested.source.sourceMessageId, sourceRef: requested.source.sourceRef, sourceFingerprint: requested.source.recordFingerprint};
  return frozen({contractVersion: V3_ATTACHMENT_EXTRACTION_CONTRACT_VERSION, schemaVersion: 1 as const, status, errorCode, adapterId: string(adapter.adapterId, MAX_ADAPTER_STRING), adapterVersion: string(adapter.adapterVersion, MAX_ADAPTER_STRING), mediaKind: requested.mediaKind, extractionKind: requested.extractionKind, source, output, outputFingerprint: output === null ? null : canonicalSha256(output), evidence, authority: 'NON_AUTHORITATIVE_DERIVED' as const, untrustedAsInstruction: true as const, grantsEffects: false as const, aiAuthorityCutoff: 'SALES_ORDER.DRAFT' as const, deterministic: true as const, bounded: true as const});
}

export function runV3AttachmentExtractionAdapter(adapter: V3AttachmentExtractionAdapter, input: V3AttachmentExtractionRequest): V3AttachmentExtractionResult {
  try {
    const requested = request(input);
    if (adapter === null || typeof adapter !== 'object' || typeof adapter.extract !== 'function') return base(requested, adapter, 'FAILED', 'ADAPTER_FAILURE', null, null);
    let raw: unknown; try { raw = adapter.extract(requested); } catch { return base(requested, adapter, 'FAILED', 'ADAPTER_FAILURE', null, null); }
    const output = normalize(raw, requested.extractionKind);
    const evidence = buildV3AttachmentEvidence({source: requested.source, mediaType: requested.mediaKind, extractionType: requested.extractionKind, extractionVersion: requested.extractionVersion, extractorRef: adapter.adapterId, extractorVersion: adapter.adapterVersion, pageNumber: requested.pageNumber, regionRef: requested.regionRef, boundingBox: null, timeRange: requested.timeRange, derivedAt: requested.derivedAt, freshnessState: 'CURRENT', provenanceRefs: requested.provenanceRefs});
    return base(requested, adapter, 'SUCCEEDED', null, output, evidence);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = message.includes('OUTPUT_TOO_LARGE') ? 'OUTPUT_TOO_LARGE' : message.includes('INCOMPATIBLE_MEDIA_KIND') ? 'INCOMPATIBLE_MEDIA_KIND' : /SOURCE_(FINGERPRINT|HASH|CONTRACT|LENGTH)/.test(message) ? 'SOURCE_MISMATCH' : 'INVALID_OUTPUT';
    const requested = input; return base(requested, adapter, 'FAILED', code, null, null);
  }
}
