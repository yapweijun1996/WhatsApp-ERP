import test from 'node:test';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {OutboundMessageService} from '../src/outbound-message-service.js';
import {AgentTurnCoordinator} from '../src/v2-agent-turn-coordinator.js';
import {validateGroundedResponsePlan, type GroundedResponsePlan} from '../src/v2-grounded-response-plan.js';

function fixture(send: (message: any) => Promise<any>) {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('ful-004-in','conv-001','ful-004-in-ext','INBOUND','text','hello','demo-account','2026-09-20T00:00:00Z')").run();
  const turn = new AgentTurnCoordinator(db).start({accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'ful-004-in', profileId: 'sales-digital-employee', nowIso: '2026-09-20T00:00:00Z', timezone: 'UTC'});
  const adapter = {send, reconcile: async () => ({status: 'unknown' as const})} as any;
  return {db, turnId: turn.turnId, service: new OutboundMessageService(db, adapter)};
}

function plan(turnId: string): GroundedResponsePlan {
  return validateGroundedResponsePlan({turnId, intent: 'ANSWER', connectiveText: 'Done.', factClaims: [], outboundPurpose: 'customer_reply', deliveryUnits: [
    {deliveryUnitId: 'u-1', unitType: 'TEXT_BUBBLE', text: 'First.', purpose: 'customer_reply'},
    {deliveryUnitId: 'u-2', unitType: 'TEXT_BUBBLE', text: 'Second.', purpose: 'customer_reply'},
  ]}, turnId);
}

function args(f: ReturnType<typeof fixture>, p: GroundedResponsePlan, admitDeliveryUnit: any) {
  void admitDeliveryUnit;
  return {accountId: 'demo-account', conversationId: 'conv-001', turnId: f.turnId, plan: p};
}

test('FUL-004 admits each uncommitted unit immediately before its provider attempt', async () => {
  const calls: string[] = [], admissions: string[] = [];
  const f = fixture(async message => { calls.push(message.clientMessageId); return {status: 'submitted', externalMessageId: message.clientMessageId, submittedAt: '2026-09-20T00:00:00Z'}; });
  const p = plan(f.turnId); new AgentTurnCoordinator(f.db).completeWithResponsePlan(f.turnId, p);
  const admission = async (input: any) => { admissions.push(input.deliveryUnitId); return {status: 'ADMITTED' as const, effectIdentity: `cp004-${input.deliveryUnitId}`, itemId: input.outboundMessageId}; };
  await f.service.sendDeliveryUnits(args(f, p, admission));
  assert.deepEqual(admissions, []);
  assert.equal(calls.length, 2);
});

test('FUL-004 preserves the submitted prefix and fails closed on stale remainder admission', async () => {
  let calls = 0, admissions = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) f.db.queueEnqueue({accountId: 'demo-account', conversationId: 'conv-001', externalMessageId: 'ful-004-newer-ext', messageId: 'ful-004-newer', messageType: 'text', text: 'newer', senderExternalId: 'customer-001', senderPhone: null, replyToExternalMessageId: null, occurredAt: '2026-09-20T00:01:00Z', rawRef: null, now: '2026-09-20T00:01:00Z', itemId: 'ful-004-newer-item'});
    return {status: 'submitted', externalMessageId: `ful004-${calls}`, submittedAt: '2026-09-20T00:00:00Z'};
  });
  const p = plan(f.turnId); new AgentTurnCoordinator(f.db).completeWithResponsePlan(f.turnId, p);
  await assert.rejects(() => f.service.sendDeliveryUnits(args(f, p, async () => { throw new Error('ignored'); })), /CP004_STALE_REPLAN_REMAINDER/);
  assert.equal(calls, 1);
  assert.equal(admissions, 0);
  assert.equal((f.db.db.prepare("SELECT status FROM outbound_messages WHERE entity_type='DELIVERY_UNIT' AND entity_id LIKE '%'").all() as any[]).find(row => row.status === 'SUBMITTED')?.status, 'SUBMITTED');
  const units = f.db.db.prepare("SELECT status FROM outbound_messages WHERE entity_type='DELIVERY_UNIT' ORDER BY created_at").all() as any[];
  assert.deepEqual(units.map(row => row.status), ['SUBMITTED', 'SUPERSEDED']);
  await f.service.sendDeliveryUnits(args(f, p, async () => { throw new Error('ignored'); }));
  assert.equal(calls, 1);
  assert.equal((f.db.db.prepare("SELECT count(*) AS count FROM outbound_messages WHERE entity_type='DELIVERY_UNIT' AND status='SUBMITTED'").get() as any).count, 1);
});

test('FUL-004 replay resumes from durable unit state and missing admission fails closed', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return {status: 'submitted', externalMessageId: `ful004-${calls}`, submittedAt: '2026-09-20T00:00:00Z'}; });
  const p = plan(f.turnId); new AgentTurnCoordinator(f.db).completeWithResponsePlan(f.turnId, p);
  await f.service.sendDeliveryUnits({accountId: 'demo-account', conversationId: 'conv-001', turnId: f.turnId, plan: p});
  assert.equal(calls, 2);
  const admission = async (input: any) => ({status: 'ADMITTED' as const, effectIdentity: 'cp004-restart', itemId: input.outboundMessageId});
  await f.service.sendDeliveryUnits(args(f, p, admission));
  await f.service.sendDeliveryUnits(args(f, p, admission));
  assert.equal(calls, 2);
});
