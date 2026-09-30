import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { OutboundMessageService, ful003DeliveryIdentity } from '../src/outbound-message-service.js';
import { AgentTurnCoordinator } from '../src/v2-agent-turn-coordinator.js';
import { validateGroundedResponsePlan, type GroundedResponsePlan } from '../src/v2-grounded-response-plan.js';

function fixture(send: (message: any) => Promise<any>, reconcile: (input: any) => Promise<any>, complete = true) {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('ful-005-in','conv-001','ful-005-in-ext','INBOUND','text','hello','demo-account','2026-09-20T00:00:00Z')").run();
  const turn = new AgentTurnCoordinator(db).start({ accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'ful-005-in', profileId: 'sales-digital-employee', nowIso: '2026-09-20T00:00:00Z', timezone: 'UTC' });
  const plan = validateGroundedResponsePlan({ turnId: turn.turnId, intent: 'ANSWER', connectiveText: 'Done.', factClaims: [], outboundPurpose: 'customer_reply', deliveryUnits: [{ deliveryUnitId: 'u-1', unitType: 'TEXT_BUBBLE', text: 'Done.', purpose: 'customer_reply' }] }, turn.turnId);
  if (complete) new AgentTurnCoordinator(db).completeWithResponsePlan(turn.turnId, plan);
  return { db, turnId: turn.turnId, plan, service: new OutboundMessageService(db, { send, reconcile } as any) };
}

function args(f: ReturnType<typeof fixture>, plan: GroundedResponsePlan) {
  return { accountId: 'demo-account', conversationId: 'conv-001', turnId: f.turnId, plan };
}

test('FUL-005 parks provider uncertainty and reconnect reconciliation submits by the same stable identity', async () => {
  const sent: any[] = [], reconciled: any[] = [];
  const f = fixture(async message => { sent.push(message); throw new Error('socket lost after provider acceptance'); }, async input => { reconciled.push(input); return { status: 'submitted', externalMessageId: 'provider-005', submittedAt: '2026-09-20T00:01:00Z' }; });
  await assert.rejects(() => f.service.sendDeliveryUnits(args(f, f.plan)), /socket lost/);
  assert.equal((f.db.db.prepare("SELECT status FROM outbound_messages WHERE entity_type='DELIVERY_UNIT'").get() as any).status, 'UNKNOWN');

  const restarted = new OutboundMessageService(f.db, { send: async () => { throw new Error('blind resend'); }, reconcile: async input => { reconciled.push(input); return { status: 'submitted', externalMessageId: 'provider-005', submittedAt: '2026-09-20T00:01:00Z' }; } } as any);
  await restarted.reconcile();
  const identity = ful003DeliveryIdentity(f.turnId, 'u-1').clientMessageId;
  assert.deepEqual(sent.map(x => x.clientMessageId), [identity]);
  assert.deepEqual(reconciled.map(x => x.clientMessageId), [identity]);
  assert.equal((f.db.db.prepare("SELECT status,external_message_id FROM outbound_messages WHERE entity_type='DELIVERY_UNIT'").get() as any).status, 'SUBMITTED');
  await restarted.reconcile();
  assert.equal(reconciled.length, 1);
});

test('FUL-005 not_found resolves uncertainty to retryable failure, then retries once with the same identity', async () => {
  const sent: any[] = [], reconciled: any[] = [];
  let first = true;
  const f = fixture(async message => { sent.push(message); if (first) { first = false; throw new Error('provider outcome uncertain'); } return { status: 'submitted', externalMessageId: `provider-${sent.length}`, submittedAt: '2026-09-20T00:02:00Z' }; }, async input => { reconciled.push(input); return { status: 'not_found' }; });
  await assert.rejects(() => f.service.sendDeliveryUnits(args(f, f.plan)), /provider outcome uncertain/);
  await f.service.reconcile();
  assert.equal((f.db.db.prepare("SELECT status,last_error FROM outbound_messages WHERE entity_type='DELIVERY_UNIT'").get() as any).status, 'FAILED');
  assert.equal((f.db.db.prepare("SELECT last_error FROM outbound_messages WHERE entity_type='DELIVERY_UNIT'").get() as any).last_error, 'retryable:not_found');
  const result = await f.service.sendDeliveryUnits(args(f, f.plan));
  assert.equal(result[0].status, 'SUBMITTED');
  assert.deepEqual(sent.map(x => x.clientMessageId), [ful003DeliveryIdentity(f.turnId, 'u-1').clientMessageId, ful003DeliveryIdentity(f.turnId, 'u-1').clientMessageId]);
  assert.deepEqual(reconciled.map(x => x.clientMessageId), [ful003DeliveryIdentity(f.turnId, 'u-1').clientMessageId]);
});

test('FUL-005 capability-owned quotation disposition blocks runtime delivery without a provider call', async () => {
  let sends = 0;
  const f = fixture(async () => { sends++; return { status: 'submitted', externalMessageId: 'must-not-send', submittedAt: '2026-09-20T00:03:00Z' }; }, async () => ({ status: 'unknown' }), false);
  f.db.db.prepare("INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,delivery_date,warehouse_id,remark,subtotal_cents,tax_cents,grand_total_cents,source_conversation_id,source_message_id,sent_at,accepted_at,sent_snapshot_json,sent_snapshot_hash,sent_outbound_message_id,superseded_by_quotation_id) VALUES('quote-005','QT-005','CUST-001','DRAFT','SGD','2026-09-20','2026-09-30',NULL,'SG-MAIN',NULL,0,0,0,'conv-001','ful-005-in',NULL,NULL,NULL,NULL,NULL,NULL)").run();
  const action = new AgentTurnCoordinator(f.db).propose({ turnId: f.turnId, sequence: 1, capabilityName: 'send_quotation', capabilityVersion: 'v1', arguments: { accountId: 'demo-account', conversationId: 'conv-001', customerId: 'CUST-001', quotationId: 'quote-005', customerMessage: 'Please review.', quotationRevision: 1 }, idempotencyKey: 'ful-005-quote' });
  new AgentTurnCoordinator(f.db).recordResultAndComplete({ turnId: f.turnId, actionId: action.actions[0].id, sequence: 1, result: { status: 'SUCCEEDED', data: { quotationId: 'quote-005', status: 'SENT' }, evidence: [], stateChanges: [] }, reason: 'PI_CAPABILITY_OWNED_QUOTATION' });
  await assert.rejects(() => f.service.sendDeliveryUnits(args(f, f.plan)), /DELIVERY_RESPONSE_PLAN_REQUIRED/);
  assert.equal(sends, 0);
  assert.equal((f.db.db.prepare("SELECT count(*) AS n FROM outbound_messages WHERE conversation_id='conv-001'").get() as any).n, 0);
});
