import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V1Database } from '../src/database.js';
import { CommerceService } from '../src/commerce.js';
import { OutboundMessageService } from '../src/outbound-message-service.js';
import { SimulatedChannel, UnsupportedChannel, QrDemoAdapter } from '../src/channels.js';
import { V2CanaryIngressRouter } from '../src/v2-canary-ingress-router.js';
import { V2RolloutService, V2_CAPABILITIES } from '../src/v2-rollout.js';
import { createRolloutApprovalAuthority } from '../src/rollout-auth.js';
import { createMigrationApprovalAuthority } from '../src/migration-auth.js';
import { WorkspaceMigrationService } from '../src/v2-workspace-migration.js';
import { issueBoundMigrationApproval } from './migration-approval-helper.js';
import type { PiHarnessRunner } from '../src/v2-pi-harness.js';

const input = { channel: 'whatsapp' as const, accountId: 'demo-account', conversationId: 'conv-001', sender: { externalId: '+6591110001', phone: '+6591110001' }, type: 'text' as const, text: 'hello', occurredAt: new Date().toISOString() };

/** Builds a fresh in-memory workspace with conv-001/CUST-001 promoted to V2 so the
 * router's canary path (and therefore the presence wrap around it) is reachable. */
function v2Ready() {
  const migrationAuthority = createMigrationApprovalAuthority();
  const approvals = createRolloutApprovalAuthority();
  const db = new V1Database(':memory:', migrationAuthority, approvals);
  db.resetAndSeed();
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(db, channel);
  const rollout = new V2RolloutService(db, approvals);
  const migration = new WorkspaceMigrationService(db, migrationAuthority);
  const scope = { accountId: 'demo-account', conversationId: 'conv-001', customerId: 'CUST-001' };
  const shadow = migration.shadowImport({ ...scope, idempotencyKey: 'presence-shadow', approval: issueBoundMigrationApproval(migrationAuthority, migration, 'test', 'MIGRATION_OWNER', 'SHADOW_IMPORT', scope) });
  migration.promoteCanary({ ...scope, expectedLegacySourceHash: shadow.sourceHash!, expectedWorkItemId: null, expectedDraftRevision: null, idempotencyKey: 'presence-promote', approval: issueBoundMigrationApproval(migrationAuthority, migration, 'test', 'V1_OWNER', 'PROMOTE_CANARY', scope, { expectedHash: shadow.sourceHash!, expectedWorkItemId: null, expectedDraftRevision: null }) });
  for (const capability of V2_CAPABILITIES) rollout.configure({ capability, enabled: true, idempotencyKey: `presence-${capability}`, approval: approvals.issue('test', { action: 'ENABLE', capability, accountId: null, conversationId: null, enabled: true }) });
  return { db, channel, commerce, rollout };
}

/** A fake engine standing in for Pi/native transport: it only needs to prove the
 * router's composing/paused wrap behaves correctly around whatever the engine does,
 * including calling the real outbound send path like a genuine customer reply would. */
function fakeHarness(run: PiHarnessRunner['run']): PiHarnessRunner {
  return { describe: () => ({ engine: 'test' }), run };
}

test('PRESENCE-001 SimulatedChannel publishes available on connect and again on reconnect', async () => {
  const channel = new SimulatedChannel();
  await channel.connect();
  assert.deepEqual(channel.presenceEvents, [{ kind: 'available' }]);
  await channel.disconnect();
  await channel.connect();
  assert.deepEqual(channel.presenceEvents, [{ kind: 'available' }, { kind: 'available' }]);
});

test('PRESENCE-002 QrDemoAdapter publishes available when the linked-device socket reaches open, including on reconnect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qr-presence-'));
  try {
    const calls: Array<[string, string | undefined]> = [];
    let listeners: Record<string, Array<(payload: unknown) => unknown>> = {};
    const makeFakeSocket = () => {
      listeners = {};
      const socket: any = {
        ev: { on: (event: string, cb: (payload: unknown) => unknown) => { (listeners[event] ??= []).push(cb); } },
        sendPresenceUpdate: async (type: string, jid?: string) => { calls.push([type, jid]); },
        sendMessage: async () => ({ key: { id: 'fake' } }),
        end: () => {},
      };
      return socket;
    };
    const emit = async (event: string, payload: unknown) => { for (const cb of listeners[event] ?? []) await cb(payload); };
    const adapter = new QrDemoAdapter(dir, 'presence-acct', () => makeFakeSocket());
    await adapter.connect();
    await emit('connection.update', { connection: 'open' });
    assert.deepEqual(calls, [['available', undefined]]);

    // Simulate a reconnect deterministically (no real backoff timers): a close
    // followed by a fresh manual connect that reaches 'open' on a new socket.
    await emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    await adapter.disconnect();
    await adapter.connect();
    await emit('connection.update', { connection: 'open' });
    assert.deepEqual(calls, [['available', undefined], ['available', undefined]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PRESENCE-003 composing is sent before AI/tool processing and paused after the customer-facing reply completes', async () => {
  const { db, channel, commerce, rollout } = v2Ready();
  const log: string[] = [];
  const baseSend = channel.send.bind(channel);
  channel.send = async (message) => { log.push('send'); return baseSend(message); };
  const baseChatPresence = channel.sendChatPresence.bind(channel);
  channel.sendChatPresence = async (presenceInput) => { log.push(`presence:${presenceInput.state}`); return baseChatPresence(presenceInput); };
  const harness = fakeHarness(async (start) => {
    await commerce.outbound.send({ accountId: 'demo-account', clientMessageId: `presence-order-${start.inboundMessageId}`, conversationId: 'conv-001', text: 'hello there' });
    return { turnId: 'fake', status: 'TERMINAL', reasonCode: 'PI_FINAL_PENDING_GROUNDING', responsePlan: null, projection: {} as any };
  });
  const router = new V2CanaryIngressRouter(db, commerce, rollout, { enabled: true, piHarness: harness, outbound: commerce.outbound, owner: 'presence-order-test' });
  await router.receive({ ...input, externalMessageId: 'presence-order-1' });
  assert.deepEqual(log, ['presence:composing', 'send', 'presence:paused']);
});

test('PRESENCE-004 paused always fires via cleanup when processing throws (timeout/cancel style failure)', async () => {
  const { db, channel, commerce, rollout } = v2Ready();
  const harness = fakeHarness(async () => { throw new Error('PI_CANCELLED_SIMULATED'); });
  const router = new V2CanaryIngressRouter(db, commerce, rollout, { enabled: true, piHarness: harness, outbound: commerce.outbound, owner: 'presence-cancel-test' });
  const result = await router.receive({ ...input, externalMessageId: 'presence-cancel-1' }) as any;
  assert.equal(result.status, 'FAIL_CLOSED');
  assert.equal(channel.sendCount, 0);
  const chat = channel.presenceEvents.filter((event): event is { kind: 'chat'; conversationId: string; state: 'composing' | 'paused' } => event.kind === 'chat');
  assert.deepEqual(chat.map(event => event.state), ['composing', 'paused']);
});

test('PRESENCE-005 paused fires exactly once for a normally-returned terminal handoff/budget outcome', async () => {
  const { db, channel, commerce, rollout } = v2Ready();
  const harness = fakeHarness(async () => ({ turnId: 'fake', status: 'FAIL_CLOSED', reasonCode: 'PI_BUDGET_EXHAUSTED_HANDOFF', responsePlan: null, projection: {} as any }));
  const router = new V2CanaryIngressRouter(db, commerce, rollout, { enabled: true, piHarness: harness, outbound: commerce.outbound, owner: 'presence-handoff-test' });
  await router.receive({ ...input, externalMessageId: 'presence-handoff-1' });
  const chat = channel.presenceEvents.filter((event): event is { kind: 'chat'; conversationId: string; state: 'composing' | 'paused' } => event.kind === 'chat');
  assert.deepEqual(chat.map(event => event.state), ['composing', 'paused']);
});

test('PRESENCE-006 chat presence provider failures are isolated and never affect the business turn', async () => {
  const { db, channel, commerce, rollout } = v2Ready();
  let presenceAttempts = 0;
  channel.sendChatPresence = async () => { presenceAttempts++; throw new Error('boom-presence'); };
  const harness = fakeHarness(async (start) => {
    await commerce.outbound.send({ accountId: 'demo-account', clientMessageId: `presence-err-${start.inboundMessageId}`, conversationId: 'conv-001', text: 'hi despite presence failure' });
    return { turnId: 'fake', status: 'TERMINAL', reasonCode: 'PI_FINAL_PENDING_GROUNDING', responsePlan: null, projection: {} as any };
  });
  const router = new V2CanaryIngressRouter(db, commerce, rollout, { enabled: true, piHarness: harness, outbound: commerce.outbound, owner: 'presence-error-test' });
  const result = await router.receive({ ...input, externalMessageId: 'presence-error-1' }) as any;
  assert.equal(result.status, 'TERMINAL');
  assert.equal(channel.sendCount, 1);
  assert.equal(channel.sent[0].text, 'hi despite presence failure');
  assert.equal(presenceAttempts, 2);
});

test('PRESENCE-007 duplicate/replayed inbound delivery does not create a second composing/paused cycle', async () => {
  const { db, channel, commerce, rollout } = v2Ready();
  let runs = 0;
  const harness = fakeHarness(async (start) => {
    runs++;
    await commerce.outbound.send({ accountId: 'demo-account', clientMessageId: `presence-dup-${start.inboundMessageId}`, conversationId: 'conv-001', text: 'hi' });
    return { turnId: 'fake', status: 'TERMINAL', reasonCode: 'PI_FINAL_PENDING_GROUNDING', responsePlan: null, projection: {} as any };
  });
  const router = new V2CanaryIngressRouter(db, commerce, rollout, { enabled: true, piHarness: harness, outbound: commerce.outbound, owner: 'presence-dup-test' });
  const duplicate = { ...input, externalMessageId: 'presence-dup-1' };
  await router.receive(duplicate);
  await router.receive(duplicate);
  assert.equal(runs, 1);
  assert.equal(channel.sendCount, 1);
  const chat = channel.presenceEvents.filter((event): event is { kind: 'chat'; conversationId: string; state: 'composing' | 'paused' } => event.kind === 'chat');
  assert.deepEqual(chat.map(event => event.state), ['composing', 'paused']);
});

test('PRESENCE-008 unsupported channel adapter safely no-ops for available/composing/paused', async () => {
  const channel = new UnsupportedChannel('email');
  await channel.connect();
  assert.equal(typeof (channel as any).publishAvailable, 'undefined');
  assert.equal(typeof (channel as any).sendChatPresence, 'undefined');
  const db = new V1Database(':memory:'); db.resetAndSeed();
  const outbound = new OutboundMessageService(db, channel);
  await assert.doesNotReject(outbound.sendPresenceComposing('conv-001'));
  await assert.doesNotReject(outbound.sendPresencePaused('conv-001'));
});

test('PRESENCE-009 an outbound owner stub without presence support is a safe no-op for the router', async () => {
  const { db, commerce, rollout } = v2Ready();
  const outboundWithoutPresence = { sendTurnResponse: commerce.outbound.sendTurnResponse.bind(commerce.outbound) };
  const harness = fakeHarness(async () => ({ turnId: 'fake', status: 'TERMINAL', reasonCode: 'PI_FINAL_PENDING_GROUNDING', responsePlan: null, projection: {} as any }));
  const router = new V2CanaryIngressRouter(db, commerce, rollout, { enabled: true, piHarness: harness, outbound: outboundWithoutPresence, owner: 'presence-nopresence-test' });
  const result = await router.receive({ ...input, externalMessageId: 'presence-nopresence-1' }) as any;
  assert.equal(result.status, 'TERMINAL');
});
