import test from 'node:test';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {V2QueueService} from '../src/v2-queue.js';
import {assertInboundBundleRevisionProgression, buildInboundBundle, projectAdaptiveInboundBundles, readAdaptiveArrivalsFromV2Receipts, replayInboundBundle, validateInboundBundle} from '../src/v3-inbound-bundle.js';

const scope = {accountId: 'demo-account', conversationId: 'conv-001'} as const;
function fixture() {
  const database = new V1Database(':memory:'); database.resetAndSeed(); const queue = new V2QueueService(database);
  const first = queue.enqueueInbound({...scope, externalMessageId: 'cp-a', occurredAt: '2030-01-01T00:00:00Z', text: 'first'});
  const second = queue.enqueueInbound({...scope, externalMessageId: 'cp-b', occurredAt: '2020-01-01T00:00:00Z', text: 'second'});
  return {database, first, second};
}
function bundle(database: V1Database, messageIds: readonly string[], bundleRevision = 2) {
  return buildInboundBundle(database.db, { ...scope, messageIds, bundleRevision, hardCapAt: '2030-01-01T00:00:03Z', closedAt: '2030-01-01T00:00:02Z', closeReason: 'QUIET_WINDOW' });
}

test('CP-001 stable replay identity and exact ordered message membership', () => {
  const {database, first, second} = fixture();
  const value = bundle(database, [first.messageId, second.messageId]);
  const same = bundle(database, [first.messageId, second.messageId]);
  assert.equal(value.replayIdentity, same.replayIdentity);
  assert.equal(value.bundleId, same.bundleId);
  assert.deepEqual(value.messageIds, [first.messageId, second.messageId]);
  assert.equal(value.conversationRevisionAtBuild, 2);
  assert.equal(value.bundleRevision, 2);
});

test('CP-001 reuses V2 dedupe and replay is detached/immutable', () => {
  const {database, first} = fixture(); const queue = new V2QueueService(database);
  const duplicate = queue.enqueueInbound({...scope, externalMessageId: 'cp-a', occurredAt: '1990-01-01T00:00:00Z', text: 'replayed'});
  assert.equal(duplicate.deduplicated, true); assert.equal(duplicate.arrivalSeq, 1);
  const original = bundle(database, [first.messageId]); const replay = replayInboundBundle(original);
  assert.notStrictEqual(replay, original); assert.notStrictEqual(replay.messageIds, original.messageIds); assert.deepEqual(replay.messageIds, original.messageIds);
  assert.equal(Object.isFrozen(replay), true); assert.equal(Object.isFrozen(replay.messageIds), true);
  assert.throws(() => (replay.messageIds as string[]).push('bad'), TypeError);
});

test('CP-001 rejects out-of-order, duplicate, missing, and cross-scope message refs', () => {
  const {database, first, second} = fixture();
  assert.throws(() => bundle(database, [second.messageId, first.messageId]), /MESSAGE_ORDER/);
  assert.throws(() => bundle(database, [first.messageId, first.messageId]), /DUPLICATE_MESSAGE_ID/);
  assert.throws(() => bundle(database, [first.messageId, 'missing']), /MESSAGE_REF_SCOPE/);
  assert.throws(() => buildInboundBundle(database.db, {...scope, conversationId: 'foreign', messageIds: [first.messageId], bundleRevision: 1, hardCapAt: '2030-01-01T00:00:03Z', closedAt: '2030-01-01T00:00:02Z', closeReason: 'HARD_CAP'}), /CONVERSATION_SCOPE/);
});

test('CP-001 validates positive revisions and monotonic progression within scope', () => {
  const {database, first, second} = fixture(); const prior = bundle(database, [first.messageId], 1); const next = bundle(database, [first.messageId, second.messageId], 2);
  assert.doesNotThrow(() => assertInboundBundleRevisionProgression(prior, next));
  assert.throws(() => assertInboundBundleRevisionProgression(next, prior), /REGRESSION/);
  const sameRevision = {...next, bundleRevision: 2, messageIds: [first.messageId]};
  assert.throws(() => validateInboundBundle(sameRevision), /REPLAY_IDENTITY/);
  assert.throws(() => buildInboundBundle(database.db, {...scope, messageIds: [first.messageId], bundleRevision: 0, hardCapAt: '2030-01-01T00:00:03Z', closedAt: '2030-01-01T00:00:02Z', closeReason: 'QUIET_WINDOW'}), /BUNDLE_REVISION/);
});

test('CP-001 validation detaches caller data and rejects invalid structure', () => {
  const {database, first} = fixture(); const original = bundle(database, [first.messageId]); const supplied = structuredClone(original) as Record<string, unknown>;
  const validated = validateInboundBundle(supplied); supplied.messageIds = ['changed'];
  assert.deepEqual(validated.messageIds, [first.messageId]); assert.notStrictEqual(validated, supplied);
  const invalid = structuredClone(original) as Record<string, unknown>; invalid.closeReason = 'CUSTOMER_SAID_YES';
  assert.throws(() => validateInboundBundle(invalid), /CLOSE_REASON/);
});

const adaptive = (times: number[], ids = times.map((_, index) => `adaptive-${index + 1}`)) => times.map((offset, index) => ({messageId: ids[index], arrivalSeq: index + 1, arrivedAt: new Date(Date.UTC(2030, 0, 1, 0, 0, 0, offset)).toISOString()}));
const decisions = (value: readonly any[]) => value.map(({messageIds, quietWindowMs, closeAt, closeReason, nextCollectionBoundary}) => ({messageCount: messageIds.length, quietWindowMs, closeAt, closeReason, nextCollectionBoundary}));

test('CP-002 single message closes at the bounded quiet window', () => {
  const [projection] = projectAdaptiveInboundBundles(adaptive([0]));
  assert.deepEqual(projection.messageIds, ['adaptive-1']);
  assert.equal(projection.quietWindowMs, 800);
  assert.equal(projection.bundleRevision, 1);
  assert.equal(projection.closeAt, '2030-01-01T00:00:00.800Z');
  assert.equal(projection.closeReason, 'QUIET_WINDOW');
});

test('CP-002 rapid burst extends the bundle and closes after the newest bubble quiet period', () => {
  const projections = projectAdaptiveInboundBundles(adaptive([0, 100, 200]));
  assert.equal(projections.length, 1);
  assert.deepEqual(projections[0].messageIds, ['adaptive-1', 'adaptive-2', 'adaptive-3']);
  assert.equal(projections[0].quietWindowMs, 900);
  assert.equal(projections[0].bundleRevision, 3);
  assert.equal(projections[0].closeAt, '2030-01-01T00:00:01.100Z');
});

test('CP-002 quiet gap splits below the hard cap', () => {
  const projections = projectAdaptiveInboundBundles(adaptive([0, 1_000]));
  assert.deepEqual(projections.map((projection) => projection.messageIds), [['adaptive-1'], ['adaptive-2']]);
  assert.equal(projections[0].closeAt, '2030-01-01T00:00:00.800Z');
  assert.equal(projections[0].closeReason, 'QUIET_WINDOW');
});

test('CP-002 adaptive history uses the accepted window at the exact boundary', () => {
  const projections = projectAdaptiveInboundBundles(adaptive([0, 100, 1_000]));
  assert.deepEqual(projections.map((projection) => projection.messageIds), [['adaptive-1', 'adaptive-2'], ['adaptive-3']]);
  assert.equal(projections[0].quietWindowMs, 900);
  assert.equal(projections[0].closeAt, '2030-01-01T00:00:01.000Z');
  assert.equal(projections[0].closeReason, 'QUIET_WINDOW');
});

test('CP-002 hard cap wins during a sustained burst under the current quiet window', () => {
  const projections = projectAdaptiveInboundBundles(adaptive([0, 700, 1_400, 2_100, 2_800, 3_100]));
  assert.deepEqual(projections[0].messageIds, ['adaptive-1', 'adaptive-2', 'adaptive-3', 'adaptive-4', 'adaptive-5']);
  assert.equal(projections[0].closeAt, '2030-01-01T00:00:03.000Z');
  assert.equal(projections[0].closeReason, 'HARD_CAP');
  assert.deepEqual(projections[1].messageIds, ['adaptive-6']);
});

test('CP-002 earliest current deadline wins when a prospective bubble skips quiet close', () => {
  const [projection, next] = projectAdaptiveInboundBundles(adaptive([0, 3_001]));
  assert.deepEqual(projection.messageIds, ['adaptive-1']);
  assert.equal(projection.closeAt, '2030-01-01T00:00:00.800Z');
  assert.equal(projection.closeReason, 'QUIET_WINDOW');
  assert.equal(next.messageIds[0], 'adaptive-2');
});

test('CP-002 exact equality at the earliest deadline closes deterministically', () => {
  const [quiet] = projectAdaptiveInboundBundles(adaptive([0, 800]));
  assert.equal(quiet.closeAt, '2030-01-01T00:00:00.800Z');
  assert.equal(quiet.closeReason, 'QUIET_WINDOW');

  const [hardCap] = projectAdaptiveInboundBundles(adaptive([0, 700, 1_400, 2_100, 2_800, 3_000]));
  assert.equal(hardCap.closeAt, '2030-01-01T00:00:03.000Z');
  assert.equal(hardCap.closeReason, 'HARD_CAP');
});

test('CP-002 replay is deterministic and detached/immutable', () => {
  const input = adaptive([0, 100, 200]);
  const first = projectAdaptiveInboundBundles(input);
  const second = projectAdaptiveInboundBundles(structuredClone(input));
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0].messageIds), true);
  assert.throws(() => (first[0].messageIds as string[]).push('bad'), TypeError);
});

test('CP-002 preserves exact V2 arrival order and ignores provider occurred_at order', () => {
  const {database, first, second} = fixture();
  const rows = database.db.prepare('SELECT message_id,arrival_seq FROM v2_inbox_items WHERE account_id=? AND conversation_id=? ORDER BY arrival_seq').all(scope.accountId, scope.conversationId) as Array<{message_id: string; arrival_seq: number}>;
  const projections = projectAdaptiveInboundBundles(rows.map((row) => ({messageId: row.message_id, arrivalSeq: row.arrival_seq, arrivedAt: new Date(Date.UTC(2030, 0, 1, 0, 0, 0, (row.arrival_seq - 1) * 100)).toISOString()})));
  assert.deepEqual(projections[0].messageIds, [first.messageId, second.messageId]);
});

test('CP-002 receipt projection uses V2 Host created_at, not provider occurred_at', () => {
  const {database, first, second} = fixture();
  const receipts = readAdaptiveArrivalsFromV2Receipts(database.db, scope, [first.messageId, second.messageId]);
  assert.deepEqual(receipts.map((arrival) => arrival.messageId), [first.messageId, second.messageId]);
  assert.deepEqual(receipts.map((arrival) => arrival.arrivalSeq), [1, 2]);
  assert.equal(receipts[0].arrivedAt, database.db.prepare('SELECT created_at FROM v2_inbox_items WHERE message_id=?').get(first.messageId).created_at);
  assert.notEqual(receipts[0].arrivedAt, database.db.prepare('SELECT occurred_at FROM messages WHERE id=?').get(first.messageId).occurred_at);
  assert.deepEqual(projectAdaptiveInboundBundles(receipts).map((projection) => projection.messageIds), [[first.messageId, second.messageId]]);
});

test('CP-002 projection feeds the existing CP-001 InboundBundle without a second authority', () => {
  const {database, first, second} = fixture();
  const plan = projectAdaptiveInboundBundles([
    {messageId: first.messageId, arrivalSeq: 1, arrivedAt: '2030-01-01T00:00:00.000Z'},
    {messageId: second.messageId, arrivalSeq: 2, arrivedAt: '2030-01-01T00:00:00.100Z'},
  ]);
  const value = bundle(database, plan[0].messageIds, plan[0].bundleRevision);
  assert.equal(value.authority, 'NON_AUTHORITATIVE_SHADOW');
  assert.deepEqual(value.messageIds, plan[0].messageIds);
  assert.equal(value.bundleRevision, 2);
});

test('CP-002 reuses V2 dedupe: redelivery does not change the projected bundle', () => {
  const {database, first, second} = fixture();
  const queue = new V2QueueService(database);
  assert.equal(queue.enqueueInbound({...scope, externalMessageId: 'cp-a', occurredAt: '2040-01-01T00:00:00Z', text: 'different'}).deduplicated, true);
  const rows = database.db.prepare('SELECT message_id,arrival_seq FROM v2_inbox_items WHERE account_id=? AND conversation_id=? ORDER BY arrival_seq').all(scope.accountId, scope.conversationId) as Array<{message_id: string; arrival_seq: number}>;
  const result = projectAdaptiveInboundBundles(rows.map((row) => ({messageId: row.message_id, arrivalSeq: row.arrival_seq, arrivedAt: new Date(Date.UTC(2030, 0, 1, 0, 0, 0, (row.arrival_seq - 1) * 100)).toISOString()})));
  assert.deepEqual(result[0].messageIds, [first.messageId, second.messageId]);
});

test('CP-002 decisions do not depend on customer text or keywords', () => {
  const timing = [0, 100, 200];
  const one = projectAdaptiveInboundBundles(adaptive(timing, ['one-a', 'one-b', 'one-c']));
  const other = projectAdaptiveInboundBundles(adaptive(timing, ['other-a', 'other-b', 'other-c']));
  assert.deepEqual(decisions(one), decisions(other));
});

test('CP-002 starts a separate collection after hard cap and after side-effect-start boundary', () => {
  const hardCap = projectAdaptiveInboundBundles(adaptive([0, 3_001]));
  assert.equal(hardCap.length, 2);
  const sideEffect = projectAdaptiveInboundBundles(adaptive([0, 100, 200]), undefined, 1);
  assert.deepEqual(sideEffect.map((item) => item.messageIds), [['adaptive-1'], ['adaptive-2', 'adaptive-3']]);
  assert.equal(sideEffect[0].nextCollectionBoundary, 'SIDE_EFFECT_STARTED');
});

test('CP-002 quiet windows remain bounded and invalid timing/configuration fails closed', () => {
  for (const gap of [0, 1, 799, 800, 1_500, 20_000]) {
    const projection = projectAdaptiveInboundBundles(adaptive([0, gap]))[0];
    assert.ok(projection.quietWindowMs >= 800 && projection.quietWindowMs <= 1_500);
  }
  assert.throws(() => projectAdaptiveInboundBundles(adaptive([0, -1])), /ARRIVAL_ORDER/);
  assert.throws(() => projectAdaptiveInboundBundles(adaptive([0]), {minQuietWindowMs: 1_501, maxQuietWindowMs: 1_500}), /QUIET_WINDOW_BOUNDS/);
  assert.throws(() => projectAdaptiveInboundBundles(adaptive([0]), {hardCapMs: 700}), /HARD_CAP_BOUNDS/);
  assert.throws(() => projectAdaptiveInboundBundles([{messageId: 'bad', arrivalSeq: 1, arrivedAt: 'invalid'}]), /ARRIVED_AT/);
});

test('CP-002 deterministic burst property corpus preserves order, coverage, deadlines, and text neutrality', () => {
  // A fixed corpus gives property-style coverage without introducing a random
  // seed or any customer-language input into the Host projection.
  for (let burst = 0; burst < 64; burst += 1) {
    const times = [0];
    for (let index = 1; index < 12; index += 1) {
      const gap = ((burst * 17 + index * 31) % 1_901);
      times.push(times[index - 1] + gap);
    }
    const first = projectAdaptiveInboundBundles(adaptive(times));
    const replay = projectAdaptiveInboundBundles(adaptive(times, times.map((_, index) => `semantic-${burst}-${index}`)));
    assert.deepEqual(decisions(first), decisions(replay));
    assert.deepEqual(first.flatMap((projection) => projection.messageIds), adaptive(times).map((arrival) => arrival.messageId));
    for (const projection of first) {
      assert.ok(projection.quietWindowMs >= 800 && projection.quietWindowMs <= 1_500);
      assert.ok(Date.parse(projection.closeAt) <= Date.parse(projection.hardCapAt));
      assert.ok(projection.messageIds.length >= 1);
    }
  }
});
