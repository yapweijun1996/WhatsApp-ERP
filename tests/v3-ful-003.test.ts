import test from 'node:test';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {OutboundMessageService} from '../src/outbound-message-service.js';
import {ful003DeliveryIdentity} from '../src/outbound-message-service.js';
import {AgentTurnCoordinator} from '../src/v2-agent-turn-coordinator.js';
import {validateGroundedResponsePlan, type GroundedResponsePlan} from '../src/v2-grounded-response-plan.js';

const base = (turnId: string, deliveryUnits: unknown[]): GroundedResponsePlan => validateGroundedResponsePlan({
  turnId, intent: 'ANSWER', connectiveText: 'Done.', factClaims: [], outboundPurpose: 'customer_reply',
  deliveryUnits,
}, turnId);
const admission = async () => ({status: 'ADMITTED' as const, effectIdentity: 'ful-003-test-admission', itemId: 'ful-003-test-item'});

function fixture(send: (message: any) => Promise<any>, plan?: GroundedResponsePlan, complete = true) {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('ful-003-in','conv-001','ful-003-in-ext','INBOUND','text','hello','demo-account','2026-09-20T00:00:00Z')").run();
  const turn = new AgentTurnCoordinator(db).start({accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'ful-003-in', profileId: 'sales-digital-employee', nowIso: '2026-09-20T00:00:00Z', timezone: 'UTC'});
  const storedPlan = plan ?? base(turn.turnId, [{deliveryUnitId: 'u-1', unitType: 'TEXT_BUBBLE', text: 'Default.', purpose: 'customer_reply'}]);
  if (complete) new AgentTurnCoordinator(db).completeWithResponsePlan(turn.turnId, storedPlan);
  const adapter = { send, reconcile: async () => ({status: 'unknown' as const}) } as any;
  return {db, service: new OutboundMessageService(db, adapter), turnId: turn.turnId, plan: storedPlan,
    admitDeliveryUnit: admission};
}

function deliveryArgs(f: ReturnType<typeof fixture>, plan: GroundedResponsePlan) {
  return {accountId: 'demo-account', conversationId: 'conv-001', turnId: f.turnId, plan};
}

test('FUL-003 creates one stable durable effect per delivery unit and replays idempotently', async () => {
  let sends = 0;
  const {db, service, turnId} = fixture(async (message) => { sends++; return {status: 'submitted', externalMessageId: `ext-${message.clientMessageId}`, submittedAt: '2026-09-20T00:00:00Z'}; }, undefined, false);
  const plan = base(turnId, [
    {deliveryUnitId: 'u-1', unitType: 'TEXT_BUBBLE', text: 'First.', purpose: 'free-form-a'},
    {deliveryUnitId: 'u-2', unitType: 'CAPTION', text: 'Second.', purpose: 'free-form-b'},
  ]);
  new AgentTurnCoordinator(db).completeWithResponsePlan(turnId, plan);
  const first = await service.sendDeliveryUnits({accountId: 'demo-account', conversationId: 'conv-001', turnId, plan});
  const replay = await service.sendDeliveryUnits({accountId: 'demo-account', conversationId: 'conv-001', turnId, plan});
  assert.deepEqual(first.map((row: any) => row.client_message_id), [ful003DeliveryIdentity(turnId, 'u-1').clientMessageId, ful003DeliveryIdentity(turnId, 'u-2').clientMessageId]);
  assert.deepEqual(replay.map((row: any) => row.id), first.map((row: any) => row.id));
  assert.equal(sends, 2);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM outbound_messages WHERE entity_type='DELIVERY_UNIT'").get() as any).n, 2);
});

test('FUL-003 preserves plan order and does not let purpose select dispatch semantics', async () => {
  const sent: string[] = [];
  const {service, turnId} = fixture(async (message) => { sent.push(message.clientMessageId); return {status: 'submitted', externalMessageId: message.clientMessageId, submittedAt: '2026-09-20T00:00:00Z'}; }, undefined, false);
  const plan = base(turnId, [
    {deliveryUnitId: 'u-a', unitType: 'TEXT_BUBBLE', text: 'A.', purpose: 'quotation_document'},
    {deliveryUnitId: 'u-b', unitType: 'CAPTION', text: 'B.', purpose: 'not-a-capability'},
  ]);
  new AgentTurnCoordinator((service as any).database).completeWithResponsePlan(turnId, plan);
  await service.sendDeliveryUnits({accountId: 'demo-account', conversationId: 'conv-001', turnId, plan});
  assert.deepEqual(sent, [ful003DeliveryIdentity(turnId, 'u-a').clientMessageId, ful003DeliveryIdentity(turnId, 'u-b').clientMessageId]);
});

test('FUL-003 fails closed on replay payload conflict and unresolved attachment dispatch', async () => {
  let sends = 0;
  const {db, service, turnId} = fixture(async () => { sends++; return {status: 'submitted', externalMessageId: 'unexpected', submittedAt: '2026-09-20T00:00:00Z'}; }, undefined, false);
  const firstPlan = base(turnId, [{deliveryUnitId: 'u-1', unitType: 'TEXT_BUBBLE', text: 'Original.', purpose: 'customer_reply'}]);
  new AgentTurnCoordinator(db).completeWithResponsePlan(turnId, firstPlan);
  await service.sendDeliveryUnits({accountId: 'demo-account', conversationId: 'conv-001', turnId, plan: firstPlan});
  const changed = base(turnId, [{deliveryUnitId: 'u-1', unitType: 'TEXT_BUBBLE', text: 'Changed.', purpose: 'customer_reply'}]);
  await assert.rejects(() => service.sendDeliveryUnits({accountId: 'demo-account', conversationId: 'conv-001', turnId, plan: changed}), /DELIVERY_PLAN_NOT_STORED/);

  const attachmentFixture = fixture(async () => { sends++; return {status: 'submitted', externalMessageId: 'unexpected-attachment', submittedAt: '2026-09-20T00:00:00Z'}; }, undefined, false);
  const attachmentPlan = validateGroundedResponsePlan({
    turnId: attachmentFixture.turnId, intent: 'ANSWER', connectiveText: 'Done.', factClaims: [], outboundPurpose: 'customer_reply',
    attachments: ['attachment-1'], deliveryUnits: [{deliveryUnitId: 'u-2', unitType: 'DOCUMENT', attachmentRef: 'attachment-1', purpose: 'customer_reply'}],
  }, attachmentFixture.turnId);
  new AgentTurnCoordinator(attachmentFixture.db).completeWithResponsePlan(attachmentFixture.turnId, attachmentPlan);
  const result = await attachmentFixture.service.sendDeliveryUnits({accountId: 'demo-account', conversationId: 'conv-001', turnId: attachmentFixture.turnId, plan: attachmentPlan});
  assert.equal(result[0].status, 'FAILED');
  assert.match(result[0].last_error, /ATTACHMENT_RESOLUTION_REQUIRED/);
  assert.equal(sends, 1);
  assert.equal((db.db.prepare("SELECT count(*) AS n FROM outbound_messages WHERE entity_type='DELIVERY_UNIT'").get() as any).n, 1);
  assert.equal((attachmentFixture.db.db.prepare("SELECT count(*) AS n FROM outbound_messages WHERE entity_type='DELIVERY_UNIT'").get() as any).n, 1);
});

test('FUL-003 requires attachment refs to belong to the validated root attachment set', () => {
  assert.throws(() => base('ful-003-turn', [{deliveryUnitId: 'u-1', unitType: 'PDF', attachmentRef: 'missing', purpose: 'document'}]), /ATTACHMENT_REF_UNKNOWN/);
});

test('FUL-003 rejects forged, nonexistent, wrong-scope, and unstored plans before provider calls', async () => {
  let sends = 0;
  const {db, service, turnId, plan} = fixture(async () => { sends++; return {status: 'submitted', externalMessageId: 'unexpected', submittedAt: '2026-09-20T00:00:00Z'}; });
  await assert.rejects(() => service.sendDeliveryUnits({accountId: 'demo-account', conversationId: 'conv-001', turnId: 'missing-turn', plan: base('missing-turn', [])}), /DELIVERY_TURN_SCOPE/);
  await assert.rejects(() => service.sendDeliveryUnits({accountId: 'other-account', conversationId: 'conv-001', turnId, plan}), /DELIVERY_TURN_SCOPE/);
  await assert.rejects(() => service.sendDeliveryUnits({accountId: 'demo-account', conversationId: 'conv-001', turnId, plan: base(turnId, [{deliveryUnitId: 'u-1', unitType: 'TEXT_BUBBLE', text: 'Forged.', purpose: 'customer_reply'}])}), /DELIVERY_PLAN_NOT_STORED/);
  const unstored = fixture(async () => { sends++; return {status: 'submitted', externalMessageId: 'unexpected', submittedAt: '2026-09-20T00:00:00Z'}; }, undefined, false);
  await assert.rejects(() => unstored.service.sendDeliveryUnits({accountId: 'demo-account', conversationId: 'conv-001', turnId: unstored.turnId, plan: unstored.plan}), /DELIVERY_RESPONSE_PLAN_REQUIRED/);
  assert.equal(sends, 0);
  db.db.close();
});

test('FUL-003 identity hash separates ambiguous (a,b-c) and (a-b,c) tuples', () => {
  const left = ful003DeliveryIdentity('a', 'b-c');
  const right = ful003DeliveryIdentity('a-b', 'c');
  assert.notEqual(left.clientMessageId, right.clientMessageId);
  assert.notEqual(left.entityId, right.entityId);
});
