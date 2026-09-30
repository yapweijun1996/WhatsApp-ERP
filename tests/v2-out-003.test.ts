import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ChannelReconcileResult, ChannelSendResult, IncomingChannelMessage, OutgoingChannelMessage, WhatsAppChannelAdapter } from '../src/channel-contract.js';
import { V1Database } from '../src/database.js';
import { AgentTurnCoordinator } from '../src/v2-agent-turn-coordinator.js';
import { OutboundMessageService } from '../src/outbound-message-service.js';
import { ResponseGroundingGuard } from '../src/v2-response-grounding.js';
import { V2QueueService } from '../src/v2-queue.js';

const start = { accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'out-003-in', profileId: 'sales-digital-employee', nowIso: '2026-09-10T01:00:00Z', timezone: 'UTC' } as const;

class FaultInjectionChannel implements WhatsAppChannelAdapter {
  private status: 'connected' | 'disconnected' = 'disconnected';
  private handler?: (message: IncomingChannelMessage) => Promise<void>;
  private readonly reconcileResults: ChannelReconcileResult[];
  readonly sent: OutgoingChannelMessage[] = [];

  constructor(reconcileResults: ChannelReconcileResult[] = []) { this.reconcileResults = [...reconcileResults]; }
  async connect() { this.status = 'connected'; }
  async disconnect() { this.status = 'disconnected'; }
  async getStatus() { return this.status; }
  onMessage(handler: (message: IncomingChannelMessage) => Promise<void>) { this.handler = handler; }
  async emit(message: IncomingChannelMessage) { if (!this.handler) throw Error('HANDLER_REQUIRED'); return this.handler(message); }
  async send(message: OutgoingChannelMessage): Promise<ChannelSendResult> {
    this.sent.push(message);
    if (this.status !== 'connected') return { status: 'unknown', clientMessageId: message.clientMessageId };
    return { status: 'submitted', externalMessageId: `provider-${message.clientMessageId}`, submittedAt: '2026-09-10T01:00:01Z' };
  }
  async reconcile(_input: { accountId: string; clientMessageId: string }) {
    return this.reconcileResults.shift() ?? { status: 'unknown' as const };
  }
}

function prepared() {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(start.inboundMessageId, start.conversationId, 'out-003-external-in', 'INBOUND', 'text', 'please clarify', start.accountId, start.nowIso);
  const turn = new AgentTurnCoordinator(db).start(start);
  new AgentTurnCoordinator(db).completeWithResponsePlan(turn.turnId, { turnId: turn.turnId, intent: 'CLARIFY', connectiveText: 'Could you clarify your request?', factClaims: [], safeReasonCode: 'NEEDS_CLARIFICATION', outboundPurpose: 'clarification' });
  return { db, turnId: turn.turnId };
}

function inbound(externalMessageId: string, occurredAt: string): IncomingChannelMessage {
  return { channel: 'whatsapp', accountId: 'demo-account', externalMessageId, conversationId: 'conv-001', sender: { externalId: '+6591110001', phone: '+6591110001' }, type: 'text', text: externalMessageId, occurredAt };
}

async function processQueueItem(db: V1Database, queue: V2QueueService, service: OutboundMessageService, item: any, owner: string) {
  const coordinator = new AgentTurnCoordinator(db);
  const turn = coordinator.start({ accountId: item.accountId, conversationId: item.conversationId, inboundMessageId: item.messageId, nowIso: new Date().toISOString(), timezone: 'UTC' });
  queue.bindAgentTurn({ accountId: item.accountId, conversationId: item.conversationId, arrivalSeq: item.arrivalSeq, turnId: turn.turnId });
  const lease = queue.claimNext({ accountId: item.accountId, conversationId: item.conversationId, owner, nowIso: new Date().toISOString() });
  assert.ok(lease);
  const authorization = queue.recheckBeforeSideEffect({ accountId: item.accountId, conversationId: item.conversationId, owner, leaseToken: lease.leaseToken, arrivalSeq: lease.arrivalSeq, turnId: turn.turnId });
  if (!authorization.ok) return authorization;

  queue.markSideEffectStarted({ accountId: item.accountId, conversationId: item.conversationId, owner, leaseToken: lease.leaseToken, arrivalSeq: lease.arrivalSeq, turnId: turn.turnId });
  coordinator.completeWithResponsePlan(turn.turnId, { turnId: turn.turnId, intent: 'CLARIFY', connectiveText: 'Could you clarify your request?', factClaims: [], safeReasonCode: 'NEEDS_CLARIFICATION', outboundPurpose: 'clarification' });
  const sent = await service.sendTurnResponse({ authorization: new ResponseGroundingGuard(db).authorize(turn.turnId) });
  queue.complete({ accountId: item.accountId, conversationId: item.conversationId, owner, leaseToken: lease.leaseToken, arrivalSeq: lease.arrivalSeq, result: { outboundId: sent.id, status: sent.status } });
  return { ...authorization, sent };
}

async function enqueueInIndependentWorkers(file: string, messages: Array<{ externalMessageId: string; messageId: string; occurredAt: string }>) {
  const barrier = new SharedArrayBuffer(4);
  const view = new Int32Array(barrier);
  const workers = messages.map(message => new Worker(new URL('./v2-queue-race-worker.ts', import.meta.url), {
    workerData: { ...message, file, mode: 'enqueue', barrier },
    execArgv: ['--import', 'tsx'],
  }));
  const wait = (worker: Worker) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OUT003_WORKER_TIMEOUT')), 5000);
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.on('message', value => {
      if ('ok' in value) { clearTimeout(timer); resolve(value); }
    });
  });
  try {
    await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('message', value => value.ready ? resolve() : undefined);
    })));
    Atomics.store(view, 0, 1); Atomics.notify(view, 0, workers.length);
    return await Promise.all(workers.map(wait));
  } finally {
    Atomics.store(view, 0, 1); Atomics.notify(view, 0, workers.length);
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

test('OUT-003 provider reconnect reconciles an interrupted send without a resend', async () => {
  const fixture = prepared(); const channel = new FaultInjectionChannel([{ status: 'submitted', externalMessageId: 'provider-after-reconnect' }]);
  await channel.connect();
  const service = new OutboundMessageService(fixture.db, channel);
  // The provider has accepted/recorded the send, but the caller loses the
  // result before durable finalization, modelling a real in-flight disconnect.
  service.setCrashAfterSubmittedBeforeFinalize();
  await assert.rejects(() => service.sendTurnResponse({ authorization: new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId) }), /INJECTED_CRASH_AFTER_SUBMITTED/);
  assert.equal(channel.sent.length, 1);
  assert.equal((fixture.db.db.prepare('SELECT status FROM outbound_messages').get() as any).status, 'PENDING');
  await channel.disconnect();
  await channel.connect(); await service.reconcile();
  assert.equal((fixture.db.db.prepare('SELECT status,external_message_id FROM outbound_messages').get() as any).status, 'SUBMITTED');
  const replay = await service.sendTurnResponse({ authorization: new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId) });
  assert.equal(replay.status, 'SUBMITTED'); assert.equal(channel.sent.length, 1);
});

test('OUT-003 unresolved UNKNOWN remains blocked after reconnect and never blind-resends', async () => {
  const fixture = prepared(); const channel = new FaultInjectionChannel([{ status: 'unknown' }]);
  const service = new OutboundMessageService(fixture.db, channel);
  const first = await service.sendTurnResponse({ authorization: new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId) });
  assert.equal(first.status, 'UNKNOWN'); await channel.connect(); await service.reconcile();
  const second = await service.sendTurnResponse({ authorization: new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId) });
  assert.equal(second.status, 'UNKNOWN'); assert.equal(channel.sent.length, 1);
  assert.equal((fixture.db.db.prepare('SELECT status FROM outbound_messages').get() as any).status, 'UNKNOWN');
});

test('OUT-003 duplicate and reordered inbound delivery is processed once through the provider boundary', async () => {
  const db = new V1Database(':memory:'); db.resetAndSeed(); const queue = new V2QueueService(db); const channel = new FaultInjectionChannel(); await channel.connect(); const service = new OutboundMessageService(db, channel);
  channel.onMessage(message => { queue.enqueueInbound({ accountId: message.accountId, conversationId: message.conversationId, externalMessageId: message.externalMessageId, text: message.text, occurredAt: message.occurredAt }); return Promise.resolve(); });
  await channel.emit(inbound('provider-a', '2026-09-10T01:00:02Z'));
  await Promise.all([channel.emit(inbound('provider-b', '2026-09-10T01:00:01Z')), channel.emit(inbound('provider-a', '2026-09-10T01:00:02Z'))]);
  const result = queue.read({ accountId: 'demo-account', conversationId: 'conv-001' });
  assert.equal(result.items.length, 2); assert.deepEqual(result.items.map(item => item.arrivalSeq), [1, 2]);
  assert.equal(queue.enqueueInbound({ accountId: 'demo-account', conversationId: 'conv-001', externalMessageId: 'provider-a', text: 'replay', occurredAt: '2020-01-01T00:00:00Z' }).deduplicated, true);
  assert.equal(queue.read({ accountId: 'demo-account', conversationId: 'conv-001' }).items.length, 2);

  const items = queue.read({ accountId: 'demo-account', conversationId: 'conv-001' }).items;
  const superseded = await processQueueItem(db, queue, service, items[0], 'processor-1');
  assert.equal(superseded.ok, false); assert.equal(superseded.reasonCode, 'NEWER_INPUT_QUEUED');
  assert.equal(channel.sent.length, 0);
  const sent = await processQueueItem(db, queue, service, items[1], 'processor-2');
  assert.equal(sent.ok, true); assert.equal(sent.sent.status, 'SUBMITTED');
  assert.equal(channel.sent.length, 1);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM outbound_messages WHERE entity_type='TURN_RESPONSE'").get() as any).n, 1);
  assert.deepEqual(queue.read({ accountId: 'demo-account', conversationId: 'conv-001' }).items.map(item => item.state), ['SUPERSEDED', 'COMPLETED']);
  assert.equal(queue.read({ accountId: 'demo-account', conversationId: 'conv-001' }).processedWatermark, 2);
});

test('OUT-003 concurrent inbound messages use independent SQLite connections and one provider side effect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v2-out-003-race-')); const file = join(dir, 'db.sqlite');
  try {
    const seed = new V1Database(file); seed.resetAndSeed(); seed.db.close();
    const results = await enqueueInIndependentWorkers(file, [
      { externalMessageId: 'concurrent-a', messageId: 'message-a', occurredAt: '2026-09-10T01:00:02Z' },
      { externalMessageId: 'concurrent-b', messageId: 'message-b', occurredAt: '2026-09-10T01:00:01Z' },
    ]);
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    const db = new V1Database(file); const queue = new V2QueueService(db); const channel = new FaultInjectionChannel(); await channel.connect(); const service = new OutboundMessageService(db, channel);
    assert.equal(queue.enqueueInbound({ accountId: 'demo-account', conversationId: 'conv-001', externalMessageId: 'concurrent-a', text: 'duplicate', occurredAt: '2020-01-01T00:00:00Z' }).deduplicated, true);
    const result = queue.read({ accountId: 'demo-account', conversationId: 'conv-001' });
    assert.equal(result.items.length, 2); assert.deepEqual(result.items.map(item => item.arrivalSeq), [1, 2]);
    const queueNow = new Date().toISOString();
    const first = result.items[0]; const firstTurn = new AgentTurnCoordinator(db).start({ accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: first.messageId, nowIso: queueNow, timezone: 'UTC' });
    queue.bindAgentTurn({ accountId: 'demo-account', conversationId: 'conv-001', arrivalSeq: first.arrivalSeq, turnId: firstTurn.turnId });
    const firstLease = queue.claimNext({ accountId: 'demo-account', conversationId: 'conv-001', owner: 'race-first', nowIso: queueNow })!;
    assert.deepEqual(queue.recheckBeforeSideEffect({ accountId: 'demo-account', conversationId: 'conv-001', owner: 'race-first', leaseToken: firstLease.leaseToken, arrivalSeq: 1, turnId: firstTurn.turnId }), { ok: false, reasonCode: 'NEWER_INPUT_QUEUED' });
    assert.equal(queue.read({ accountId: 'demo-account', conversationId: 'conv-001' }).items[0].state, 'SUPERSEDED');
    const second = queue.read({ accountId: 'demo-account', conversationId: 'conv-001' }).items[1];
    const secondResult = await processQueueItem(db, queue, service, second, 'race-second');
    assert.equal(secondResult.ok, true); assert.equal(secondResult.sent.status, 'SUBMITTED');
    assert.equal(channel.sent.length, 1);
    assert.equal((db.db.prepare("SELECT count(*) AS n FROM outbound_messages WHERE entity_type='TURN_RESPONSE'").get() as any).n, 1);
    assert.equal(queue.read({ accountId: 'demo-account', conversationId: 'conv-001' }).processedWatermark, 2);
    assert.equal((db.db.prepare("SELECT count(*) AS n FROM v2_inbox_items WHERE state='COMPLETED'").get() as any).n, 1);
    db.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OUT-003 concurrent replay of one turn has one exclusive outbound disposition and provider attempt', async () => {
  const fixture = prepared(); const channel = new FaultInjectionChannel(); await channel.connect(); const service = new OutboundMessageService(fixture.db, channel);
  const authorization = new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId);
  const results = await Promise.all([service.sendTurnResponse({ authorization }), service.sendTurnResponse({ authorization })]);
  assert.deepEqual(results.map(result => result.status), ['SUBMITTED', 'SUBMITTED']); assert.equal(channel.sent.length, 1);
  assert.equal((fixture.db.db.prepare('SELECT count(*) AS n FROM turn_outbound_dispositions WHERE turn_id=?').get(fixture.turnId) as any).n, 1);
  assert.equal((fixture.db.db.prepare('SELECT count(*) AS n FROM outbound_messages WHERE entity_type=\'TURN_RESPONSE\' AND entity_id=?').get(fixture.turnId) as any).n, 1);
});
