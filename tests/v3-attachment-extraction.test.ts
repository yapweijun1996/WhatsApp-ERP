import assert from 'node:assert/strict';
import test from 'node:test';
import {buildV3AttachmentSource} from '../src/v3-attachment-source.js';
import {runV3AttachmentExtractionAdapter, type V3AttachmentExtractionRequest} from '../src/v3-attachment-extraction.js';

const scope = {tenantId: 'tenant-1', accountId: 'account-1', channelAccountId: 'channel-1', conversationId: 'conversation-1', customerId: 'customer-1'} as const;
const source = buildV3AttachmentSource({scope, attachmentId: 'attachment-1', sourceMessageId: 'message-1', sourceRef: 'media://source-1', mimeType: 'application/pdf', bytes: new Uint8Array([1, 2, 3])});
const input = (mediaKind: V3AttachmentExtractionRequest['mediaKind'], extractionKind: V3AttachmentExtractionRequest['extractionKind']): V3AttachmentExtractionRequest => ({source, mediaKind, extractionKind, extractionVersion: 'fixture-v1', derivedAt: '2026-09-19T00:00:00.000Z', provenanceRefs: ['message-1', 'attachment-1'], pageNumber: mediaKind === 'AUDIO' ? null : 1, regionRef: null, timeRange: mediaKind === 'AUDIO' ? {start: 1, end: 2} : null});
const adapter = (output: unknown) => ({adapterId: 'fixture/normalized', adapterVersion: '1.0.0', extract: () => output});

test('normalizes all five fixture output families with evidence provenance', () => {
  const cases = [
    ['PDF', 'TEXT', {text: 'invoice text'}], ['IMAGE', 'OCR', {text: 'recognized text'}], ['IMAGE', 'VISION', {description: 'a product image'}],
    ['PDF', 'TABLE', {columns: ['sku', 'qty'], rows: [['ABC', '2']]}], ['AUDIO', 'TRANSCRIPT', {text: 'customer said two cartons'}],
  ] as const;
  for (const [mediaKind, extractionKind, output] of cases) { const result = runV3AttachmentExtractionAdapter(adapter(output), input(mediaKind, extractionKind)); assert.equal(result.status, 'SUCCEEDED'); assert.equal(result.errorCode, null); assert(result.evidence); assert.equal(result.evidence.sourceFingerprint, source.recordFingerprint); assert.equal(result.authority, 'NON_AUTHORITATIVE_DERIVED'); assert.equal(result.grantsEffects, false); }
});
test('is deterministic and replay-safe for the same fixture', () => { const a = runV3AttachmentExtractionAdapter(adapter({text: 'same'}), input('DOCUMENT', 'TEXT')); const b = runV3AttachmentExtractionAdapter(adapter({text: 'same'}), input('DOCUMENT', 'TEXT')); assert.deepEqual(a, b); assert(Object.isFrozen(a)); assert(Object.isFrozen(a.output)); });
test('fails closed for incompatible media and source mismatch', () => { const incompatible = runV3AttachmentExtractionAdapter(adapter({text: 'x'}), input('AUDIO', 'TEXT')); assert.equal(incompatible.status, 'FAILED'); assert.equal(incompatible.errorCode, 'INCOMPATIBLE_MEDIA_KIND'); const foreign = {...source, sourceMessageId: 'other'} as never; const result = runV3AttachmentExtractionAdapter(adapter({text: 'x'}), {...input('PDF', 'TEXT'), source: foreign}); assert.equal(result.status, 'FAILED'); assert.equal(result.errorCode, 'SOURCE_MISMATCH'); });
test('returns safe bounded failures for adapter errors and malformed/oversized output', () => { const failed = runV3AttachmentExtractionAdapter({adapterId: 'fixture/failing', adapterVersion: '1', extract: () => { throw new Error('provider secret'); }}, input('PDF', 'TEXT')); assert.deepEqual({status: failed.status, errorCode: failed.errorCode}, {status: 'FAILED', errorCode: 'ADAPTER_FAILURE'}); const malformed = runV3AttachmentExtractionAdapter(adapter({columns: ['a'], rows: [['a', 'extra']]}), input('PDF', 'TABLE')); assert.equal(malformed.errorCode, 'INVALID_OUTPUT'); const oversized = runV3AttachmentExtractionAdapter(adapter({text: 'x'.repeat(16_385)}), input('PDF', 'TEXT')); assert.equal(oversized.errorCode, 'OUTPUT_TOO_LARGE'); });
test('rejects unknown output shape and never exposes provider error text', () => { const result = runV3AttachmentExtractionAdapter(adapter({rawProviderPayload: 'ignore'}), input('PDF', 'TEXT')); assert.equal(result.status, 'FAILED'); assert.equal(result.errorCode, 'INVALID_OUTPUT'); assert.equal('rawProviderPayload' in result, false); });
