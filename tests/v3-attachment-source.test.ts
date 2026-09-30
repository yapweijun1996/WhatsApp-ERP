import assert from 'node:assert/strict';
import test from 'node:test';
import {buildV3AttachmentSource, verifyV3AttachmentSource} from '../src/v3-attachment-source.js';

const scope = {tenantId: 'tenant-1', accountId: 'account-1', channelAccountId: 'channel-1', conversationId: 'conversation-1', customerId: 'customer-1'} as const;
const input = (bytes = new Uint8Array([1, 2, 3])) => ({scope, attachmentId: 'attachment-1', sourceMessageId: 'message-1', sourceRef: 'media://source-1', mimeType: 'application/octet-stream', bytes});
const binding = {scope, attachmentId: 'attachment-1', sourceMessageId: 'message-1', sourceRef: 'media://source-1'};

test('builds a deterministic deeply immutable non-authoritative source', () => {
  const one = buildV3AttachmentSource(input()), two = buildV3AttachmentSource(input());
  assert.deepEqual(one, two); assert.equal(one.contractVersion, 'V3-MM-001'); assert.equal(one.schemaVersion, 1); assert.equal(one.authority, 'NON_AUTHORITATIVE_DERIVED'); assert.equal(one.untrustedAsInstruction, true); assert.equal(one.grantsEffects, false); assert.equal(one.aiAuthorityCutoff, 'SALES_ORDER.DRAFT'); assert(Object.isFrozen(one)); assert(Object.isFrozen(one.scope)); assert.equal(verifyV3AttachmentSource(one, binding, input().bytes), true);
});
test('rejects content tampering and changed bytes change hash and identity', () => {
  const record = buildV3AttachmentSource(input()), changed = buildV3AttachmentSource(input(new Uint8Array([1, 2, 4])));
  assert.notEqual(record.contentSha256, changed.contentSha256); assert.notEqual(record.recordFingerprint, changed.recordFingerprint); assert.throws(() => verifyV3AttachmentSource(record, binding, new Uint8Array([1, 2, 4])), /CONTENT_INTEGRITY/);
});
test('rejects scope, message, and attachment reference tampering', () => {
  const record = buildV3AttachmentSource(input());
  assert.throws(() => verifyV3AttachmentSource(record, {...binding, scope: {...scope, accountId: 'other'}}, input().bytes), /BINDING/);
  assert.throws(() => verifyV3AttachmentSource(record, {...binding, sourceMessageId: 'other'}, input().bytes), /BINDING/);
  assert.throws(() => verifyV3AttachmentSource(record, {...binding, sourceRef: 'other'}, input().bytes), /BINDING/);
});
test('does not accept caller-supplied integrity or authority fields', () => {
  assert.throws(() => buildV3AttachmentSource({...input(), byteLength: 3} as never), /CLOSED_DATA/);
  assert.throws(() => buildV3AttachmentSource({...input(), contentSha256: '00'.repeat(32)} as never), /CLOSED_DATA/);
  assert.throws(() => buildV3AttachmentSource({...input(), authority: 'AUTHORITATIVE'} as never), /CLOSED_DATA/);
});
test('fails closed on accessors and proxies without invoking getters', () => {
  let called = false; const accessor = {...input()} as Record<string, unknown>; Object.defineProperty(accessor, 'mimeType', {enumerable: true, get() { called = true; return 'text/plain'; }});
  assert.throws(() => buildV3AttachmentSource(accessor as never), /ACCESSOR/); assert.equal(called, false);
  const proxied = new Proxy(input(), {get() { throw new Error('getter executed'); }});
  assert.throws(() => buildV3AttachmentSource(proxied), /CLOSED_DATA/);
});
test('rejects malformed, empty, and oversized inputs', () => {
  assert.throws(() => buildV3AttachmentSource(input(new Uint8Array())), /EMPTY_BYTES/);
  assert.throws(() => buildV3AttachmentSource(input(new Uint8Array(25 * 1024 * 1024 + 1))), /BYTES_TOO_LARGE/);
  assert.throws(() => buildV3AttachmentSource({...input(), scope: {...scope, customerId: ''}} as never), /SCOPE/);
  assert.throws(() => verifyV3AttachmentSource({...buildV3AttachmentSource(input()), contentSha256: 'x'} as never, binding, input().bytes), /CONTENT_HASH/);
});
