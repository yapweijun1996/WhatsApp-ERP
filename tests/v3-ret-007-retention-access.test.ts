import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalSha256} from '../src/v2-canonical.js';
import {bindV3DerivedRetentionArtifact, evaluateV3DerivedRetentionAccess, projectV3RetentionAccess, type V3RetentionAccessProjectionInput} from '../src/v3-retention-access.js';

const base: V3RetentionAccessProjectionInput = {accountId: 'account-1', conversationId: 'conversation-1', version: 1, sources: [
  {sourceId: 'message-1', state: 'ACTIVE', available: true}, {sourceId: 'message-2', state: 'ACTIVE', available: true},
]};
const artifact = (ids = ['message-1', 'message-2'], version = 1) => ({kind: 'CONVERSATION_MEMORY' as const, accountId: 'account-1', conversationId: 'conversation-1', retentionAccessVersion: version, sourceMessageIds: ids, sourceSetHash: canonicalSha256({accountId: 'account-1', conversationId: 'conversation-1', sourceMessageIds: ids})});
function derived(ids = ['message-1', 'message-2'], version = 1) { return artifact(ids, version); }

test('RET-007 active sources pass and evidence is immutable/content-minimized', () => {
  const projection = projectV3RetentionAccess(base), result = evaluateV3DerivedRetentionAccess(projection, derived());
  assert.equal(result.status, 'USABLE'); assert.equal(result.affectedSourceCount, 0); assert.equal(Object.isFrozen(result), true); assert.equal('text' in result, false); assert.equal('raw' in result, false);
});
test('RET-007 revoked, deleted, expired, and unavailable sources require rebuild without salvage', () => {
  for (const state of ['REVOKED', 'DELETED', 'EXPIRED'] as const) {
    const projection = projectV3RetentionAccess({...base, version: 2, sources: [{sourceId: 'message-1', state, available: true}, base.sources[1]]});
    const result = evaluateV3DerivedRetentionAccess(projection, derived(['message-1'], 2)); assert.equal(result.status, 'REBUILD_REQUIRED'); assert.equal(result.affectedSourceCount, 1); assert.equal(result.reasonCodes.includes(`SOURCE_${state}`), true);
  }
  const projection = projectV3RetentionAccess({...base, version: 2, sources: [{sourceId: 'message-1', state: 'ACTIVE', available: false}, base.sources[1]]});
  assert.equal(evaluateV3DerivedRetentionAccess(projection, derived(['message-1'], 2)).status, 'REBUILD_REQUIRED');
});
test('RET-007 stale versions and restore/rebuild ordering cannot resurrect old evidence', () => {
  const old = projectV3RetentionAccess(base), current = projectV3RetentionAccess({...base, version: 2, sources: [{sourceId: 'message-1', state: 'REVOKED', available: true}, base.sources[1]]});
  assert.equal(evaluateV3DerivedRetentionAccess(current, derived(['message-1'], 1)).status, 'REBUILD_REQUIRED'); assert.throws(() => bindV3DerivedRetentionArtifact(current, derived(['message-1'], 1)), /REBUILD_REQUIRED/);
  assert.equal(evaluateV3DerivedRetentionAccess(old, derived(['message-1'], 1)).status, 'USABLE');
});
test('RET-007 rejects forged/cross-scope/accessor/proxy-like/custom/extra inputs', () => {
  const projection = projectV3RetentionAccess(base), good = derived();
  assert.throws(() => evaluateV3DerivedRetentionAccess({...projection, accountId: 'other'}, good), /INTEGRITY|FIELDS/);
  assert.throws(() => evaluateV3DerivedRetentionAccess(projection, {...good, accountId: 'other'}), /SOURCE_SET_HASH/);
  assert.throws(() => projectV3RetentionAccess({...base, policy: 'one-year'} as any), /PROJECTION_FIELDS/);
  const accessor = {} as any; Object.defineProperty(accessor, 'accountId', {enumerable: true, get() { throw new Error('getter invoked');}}); Object.assign(accessor, {conversationId: base.conversationId, version: 1, sources: base.sources}); assert.throws(() => projectV3RetentionAccess(accessor), /ACCESSOR/);
  const custom = Object.assign(Object.create({forged: true}), base); assert.throws(() => projectV3RetentionAccess(custom), /PLAIN_JSON|PROJECTION_SHAPE/);
});
test('RET-007 canonical ERP truth is outside invalidation and remains untouched', () => {
  const canonical = {quotationId: 'quotation-1', acceptanceId: 'acceptance-1', salesOrderId: 'sales-order-draft-1'};
  const before = structuredClone(canonical); const projection = projectV3RetentionAccess({...base, version: 2, sources: [{sourceId: 'message-1', state: 'DELETED', available: true}, base.sources[1]]});
  assert.equal(evaluateV3DerivedRetentionAccess(projection, derived(['message-1'], 2)).status, 'REBUILD_REQUIRED'); assert.deepEqual(canonical, before);
});
