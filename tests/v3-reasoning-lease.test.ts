import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {V1Database} from '../src/database.js';
import {AgentTurnCoordinator} from '../src/v2-agent-turn-coordinator.js';
import {V2QueueService} from '../src/v2-queue.js';
import {buildContextSnapshot} from '../src/v3-context-snapshot.js';
import {buildInboundBundle} from '../src/v3-inbound-bundle.js';
import {isCurrentReasoningLease, projectReasoningLease} from '../src/v3-reasoning-lease.js';

const scope = {accountId: 'demo-account', conversationId: 'conv-001'} as const;
function fixture() {
  const database = new V1Database(':memory:'); database.resetAndSeed(); const queue = new V2QueueService(database);
  const inbound = queue.enqueueInbound({...scope, externalMessageId: 'cp003-a', occurredAt: '2030-01-01T00:00:00Z', text: 'private'});
  const bundle = buildInboundBundle(database.db, {...scope, messageIds: [inbound.messageId], bundleRevision: 1, hardCapAt: '2030-01-01T00:00:03Z', closedAt: '2030-01-01T00:00:01Z', closeReason: 'QUIET_WINDOW'});
  const context = buildContextSnapshot({accountId: scope.accountId, conversationId: scope.conversationId, turnId: 'turn-003', inboundMessageRef: {id: inbound.messageId, occurredAt: '2030-01-01T00:00:00Z'}, profile: {id: 'sales-digital-employee', version: 1}, activeQuotationSalesOrder: {quotation: null, salesOrder: null}, freshness: {fingerprint: 'cp003-fresh', inboundMessageId: inbound.messageId, summaryVersion: null, workItemRevision: null, draftRevision: null, quotationId: null, salesOrderId: null}});
  return {database, queue, bundle, context};
}
const leaseAt = '2030-01-01T00:00:00Z';

test('CP-003 projects expiry and current owner/token/generation from V2 state', () => { const f = fixture(); f.queue.claimNext({...scope, owner: 'worker-a', leaseMs: 1_000, nowIso: leaseAt}); const active = projectReasoningLease(f.database.db, f.bundle, f.context, leaseAt); assert.equal(active.state, 'ACTIVE'); assert.equal(active.ownerId, 'worker-a'); assert.equal(active.generation, 1); const expired = projectReasoningLease(f.database.db, f.bundle, f.context, '2030-01-01T00:00:01.001Z'); assert.equal(expired.state, 'EXPIRED'); });
test('CP-003 heartbeat keeps only the current generation current', () => { const f = fixture(); const claimed = f.queue.claimNext({...scope, owner: 'worker-a', leaseMs: 2_000, nowIso: leaseAt})!; f.queue.heartbeat({...scope, owner: 'worker-a', leaseToken: claimed.leaseToken, leaseMs: 2_000, nowIso: '2030-01-01T00:00:00.500Z'}); const current = projectReasoningLease(f.database.db, f.bundle, f.context, '2030-01-01T00:00:01Z'); assert.equal(current.state, 'ACTIVE'); assert.equal(current.heartbeatAt, '2030-01-01T00:00:00.500Z'); assert.equal(isCurrentReasoningLease(f.database.db, current, f.bundle, f.context, '2030-01-01T00:00:01Z'), true); });
test('CP-003 reacquisition advances generation and fences the old projection/token', () => { const f = fixture(); const old = f.queue.claimNext({...scope, owner: 'worker-a', leaseMs: 1_000, nowIso: leaseAt})!; const oldProjection = projectReasoningLease(f.database.db, f.bundle, f.context, leaseAt); const reacquired = f.queue.claimNext({...scope, owner: 'worker-b', leaseMs: 2_000, nowIso: '2030-01-01T00:00:01.001Z'})!; const current = projectReasoningLease(f.database.db, f.bundle, f.context, '2030-01-01T00:00:01.001Z'); assert.equal(reacquired.leaseToken === old.leaseToken, false); assert.notEqual(current.leaseId, oldProjection.leaseId); assert.equal(current.generation, 2); assert.equal(isCurrentReasoningLease(f.database.db, oldProjection, f.bundle, f.context, '2030-01-01T00:00:01.001Z'), false); assert.throws(() => f.queue.heartbeat({...scope, owner: 'worker-a', leaseToken: old.leaseToken, nowIso: '2030-01-01T00:00:01.001Z'}), /LEASE_EXPIRED|LEASE_FENCED/); });
test('CP-003 projects V2 supersede and release/complete without new mutation authority', () => { const f = fixture(); const old = f.queue.claimNext({...scope, owner: 'worker-a', leaseMs: 30_000, nowIso: leaseAt})!; const turnId = new AgentTurnCoordinator(f.database).start({accountId: scope.accountId, conversationId: scope.conversationId, inboundMessageId: f.queue.read(scope).items[0].messageId, nowIso: leaseAt, timezone: 'UTC'}).turnId; f.queue.enqueueInbound({...scope, externalMessageId: 'cp003-b', occurredAt: '2030-01-01T00:00:01Z', text: 'new'}); assert.deepEqual(f.queue.recheckBeforeSideEffect({...scope, owner: 'worker-a', leaseToken: old.leaseToken, arrivalSeq: 1, turnId}), {ok: false, reasonCode: 'NEWER_INPUT_QUEUED'}); assert.equal(projectReasoningLease(f.database.db, f.bundle, f.context, leaseAt).state, 'SUPERSEDED'); const next = f.queue.claimNext({...scope, owner: 'worker-b', leaseMs: 30_000, nowIso: leaseAt})!; f.queue.complete({...scope, owner: 'worker-b', leaseToken: next.leaseToken, arrivalSeq: 2}); const secondMessageId = f.queue.read(scope).items[1].messageId; const secondBundle = buildInboundBundle(f.database.db, {...scope, messageIds: [secondMessageId], bundleRevision: 2, hardCapAt: '2030-01-01T00:00:04Z', closedAt: '2030-01-01T00:00:02Z', closeReason: 'QUIET_WINDOW'}); const secondContext = buildContextSnapshot({...f.context.context, inboundMessageRef: {id: secondMessageId, occurredAt: '2030-01-01T00:00:01Z'}, freshness: {...(f.context.context.freshness as any), inboundMessageId: secondMessageId}}); assert.equal(projectReasoningLease(f.database.db, secondBundle, secondContext, leaseAt).state, 'RELEASED'); });
test('CP-003 durable restart/resume preserves the V2 generation fence', () => { const dir = mkdtempSync(join(tmpdir(), 'v3-cp003-')); const file = join(dir, 'db.sqlite'); let d = new V1Database(file); d.resetAndSeed(); const q = new V2QueueService(d); const first = q.enqueueInbound({...scope, externalMessageId: 'cp003-restart', occurredAt: leaseAt, text: 'private'}); const bundle = buildInboundBundle(d.db, {...scope, messageIds: [first.messageId], bundleRevision: 1, hardCapAt: '2030-01-01T00:00:03Z', closedAt: '2030-01-01T00:00:01Z', closeReason: 'QUIET_WINDOW'}); const fixtureContext = fixture().context; const context = buildContextSnapshot({...fixtureContext.context, inboundMessageRef: {id: first.messageId, occurredAt: leaseAt}, freshness: {...(fixtureContext.context.freshness as any), inboundMessageId: first.messageId}}); const old = q.claimNext({...scope, owner: 'old', leaseMs: 10_000, nowIso: leaseAt})!; const oldProjection = projectReasoningLease(d.db, bundle, context, leaseAt); d.db.close(); d = new V1Database(file); const resumed = new V2QueueService(d).claimNext({...scope, owner: 'new', leaseMs: 2_000, nowIso: '2030-01-01T00:01:00Z'})!; assert.ok(resumed); const current = projectReasoningLease(d.db, bundle, context, '2030-01-01T00:01:00Z'); assert.equal(current.generation, 2); assert.equal(isCurrentReasoningLease(d.db, oldProjection, bundle, context, '2030-01-01T00:01:00Z'), false); assert.throws(() => new V2QueueService(d).heartbeat({...scope, owner: 'old', leaseToken: old.leaseToken, nowIso: '2030-01-01T00:01:00Z'}), /LEASE_EXPIRED|LEASE_FENCED/); d.db.close(); rmSync(dir, {recursive: true, force: true}); });
test('CP-003 rejects wrong scope, same-scope stale context, and returns immutable content-free output', () => { const f = fixture(); f.queue.claimNext({...scope, owner: 'worker-a', nowIso: leaseAt}); assert.throws(() => projectReasoningLease(f.database.db, {...f.bundle, accountId: 'other'}, f.context, leaseAt), /V3_INBOUND_BUNDLE_INVALID/); const wrongContext = buildContextSnapshot({...f.context.context, conversationId: 'other'}); assert.throws(() => projectReasoningLease(f.database.db, f.bundle, wrongContext, leaseAt), /SCOPE_MISMATCH/); assert.throws(() => projectReasoningLease(f.database.db, f.bundle, {...f.context, sourceRevisionRefs: {...f.context.sourceRevisionRefs, conversationId: 'other'}}, leaseAt), /V3_CONTEXT_SNAPSHOT_INVALID/); const projection = projectReasoningLease(f.database.db, f.bundle, f.context, leaseAt); assert.equal(Object.isFrozen(projection), true); assert.equal(projection.acquiredAt, null); assert.equal(JSON.stringify(projection).includes('private'), false); assert.throws(() => ((projection as any).state = 'RELEASED'), TypeError); });

test('CP-003 requires the context to name the latest message in a multi-message bundle', () => {
  const f = fixture(); const second = f.queue.enqueueInbound({...scope, externalMessageId: 'cp003-latest', occurredAt: '2030-01-01T00:00:01Z', text: 'latest'});
  const bundle = buildInboundBundle(f.database.db, {...scope, messageIds: [f.bundle.messageIds[0], second.messageId], bundleRevision: 2, hardCapAt: '2030-01-01T00:00:04Z', closedAt: '2030-01-01T00:00:02Z', closeReason: 'QUIET_WINDOW'});
  assert.throws(() => projectReasoningLease(f.database.db, bundle, f.context, leaseAt), /STALE_CONTEXT/);
});

test('CP-003 fails closed when V2 leases an earlier message in a multi-message bundle', () => {
  const f = fixture(); const first = f.queue.claimNext({...scope, owner: 'worker-a', leaseMs: 1_000, nowIso: leaseAt})!;
  const second = f.queue.enqueueInbound({...scope, externalMessageId: 'cp003-later-processing', occurredAt: '2030-01-01T00:00:01Z', text: 'later'});
  const bundle = buildInboundBundle(f.database.db, {...scope, messageIds: [first.messageId, second.messageId], bundleRevision: 2, hardCapAt: '2030-01-01T00:00:04Z', closedAt: '2030-01-01T00:00:02Z', closeReason: 'QUIET_WINDOW'});
  const context = buildContextSnapshot({...f.context.context, inboundMessageRef: {id: second.messageId, occurredAt: '2030-01-01T00:00:01Z'}, freshness: {...(f.context.context.freshness as any), inboundMessageId: second.messageId}});
  assert.throws(() => projectReasoningLease(f.database.db, bundle, context, leaseAt), /LEASE_BINDING/);
});

test('CP-003 derives terminal state from the latest bundle message', () => {
  const f = fixture(); const second = f.queue.enqueueInbound({...scope, externalMessageId: 'cp003-terminal-latest', occurredAt: '2030-01-01T00:00:01Z', text: 'latest'});
  const bundle = buildInboundBundle(f.database.db, {...scope, messageIds: [f.bundle.messageIds[0], second.messageId], bundleRevision: 2, hardCapAt: '2030-01-01T00:00:04Z', closedAt: '2030-01-01T00:00:02Z', closeReason: 'QUIET_WINDOW'});
  const context = buildContextSnapshot({...f.context.context, inboundMessageRef: {id: second.messageId, occurredAt: '2030-01-01T00:00:01Z'}, freshness: {...(f.context.context.freshness as any), inboundMessageId: second.messageId}});
  f.database.db.exec('DROP TRIGGER v2_inbox_update_guard');
  f.database.db.prepare("UPDATE v2_inbox_items SET state='SUPERSEDED' WHERE message_id=?").run(f.bundle.messageIds[0]);
  f.database.db.prepare("UPDATE v2_inbox_items SET state='COMPLETED' WHERE message_id=?").run(second.messageId);
  assert.equal(projectReasoningLease(f.database.db, bundle, context, leaseAt).state, 'RELEASED');
  f.database.db.prepare("UPDATE v2_inbox_items SET state='SUPERSEDED' WHERE message_id=?").run(second.messageId);
  assert.equal(projectReasoningLease(f.database.db, bundle, context, leaseAt).state, 'SUPERSEDED');
});

test('CP-003 rejects corrupt lease coherence', () => {
  const f = fixture(); f.queue.claimNext({...scope, owner: 'worker-a', nowIso: leaseAt});
  f.database.db.exec('DROP TRIGGER v2_inbox_state_update_guard');
  f.database.db.prepare('UPDATE v2_conversation_inbox SET lease_owner=NULL WHERE account_id=? AND conversation_id=?').run(scope.accountId, scope.conversationId);
  assert.throws(() => projectReasoningLease(f.database.db, f.bundle, f.context, leaseAt), /LEASE_COHERENCE/);
});

test('CP-003 rejects accessor-backed expected projections before reading values', () => {
  const clean = fixture(); clean.queue.claimNext({...scope, owner: 'worker-a', nowIso: leaseAt}); const projection = projectReasoningLease(clean.database.db, clean.bundle, clean.context, leaseAt);
  const getter = Object.create(Object.prototype, Object.fromEntries(Object.keys(projection).map((key) => [key, {get: () => { throw new Error('getter invoked'); }, enumerable: true}])));
  assert.throws(() => isCurrentReasoningLease(clean.database.db, getter, clean.bundle, clean.context, leaseAt), /EXPECTED_SHAPE/);
});
