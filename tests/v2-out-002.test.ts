import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { AgentTurnCoordinator } from '../src/v2-agent-turn-coordinator.js';
import { ResponseGroundingGuard } from '../src/v2-response-grounding.js';
import { OutboundMessageService } from '../src/outbound-message-service.js';
import { SimulatedChannel } from '../src/channels.js';
import { V2TransportRuntime } from '../src/v2-transport-runtime.js';
import { deriveAgentDecisionIdentity } from '../src/v2-transport-contract-helpers.js';

const start = { accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'out-002-in', profileId: 'sales-digital-employee', nowIso: '2026-09-10T01:00:00Z', timezone: 'UTC' } as const;

function prepared(intent: 'ACKNOWLEDGE'|'CLARIFY'|'HANDOFF' = 'ACKNOWLEDGE') {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(start.inboundMessageId, start.conversationId, 'out-002-external-in', 'INBOUND', 'text', 'please clarify', start.accountId, start.nowIso);
  const turn = new AgentTurnCoordinator(db).start(start);
  const plan = intent === 'CLARIFY'
    ? { turnId: turn.turnId, intent, connectiveText: 'Could you clarify your request?', factClaims: [], safeReasonCode: 'NEEDS_CLARIFICATION', outboundPurpose: 'clarification' as const }
    : intent === 'HANDOFF'
      ? { turnId: turn.turnId, intent, connectiveText: 'A specialist can assist further.', factClaims: [], safeReasonCode: 'NEEDS_STAFF', handoff: { reasonCode: 'NEEDS_STAFF' }, outboundPurpose: 'handoff' as const }
      : { turnId: turn.turnId, intent, connectiveText: 'Thank you.', factClaims: [], outboundPurpose: 'acknowledgement' as const };
  new AgentTurnCoordinator(db).completeWithResponsePlan(turn.turnId, plan);
  return { db, turnId: turn.turnId, authorization: new ResponseGroundingGuard(db).authorize(turn.turnId) };
}

test('OUT-002 uses stable turn/purpose identity, exact payload replay, and no duplicate send after restart', async () => {
  const first = prepared(); const channel = new SimulatedChannel(); const service = new OutboundMessageService(first.db, channel);
  const sent = await service.sendTurnResponse({ authorization: first.authorization });
  assert.equal(sent.status, 'SUBMITTED'); assert.equal(channel.sendCount, 1);
  const replay = await service.sendTurnResponse({ authorization: new ResponseGroundingGuard(first.db).authorize(first.turnId) });
  assert.equal(replay.id, sent.id); assert.equal(channel.sendCount, 1);
  const row = first.db.db.prepare("SELECT d.turn_id,d.purpose,d.disposition,o.status,o.client_message_id,o.snapshot_hash FROM turn_outbound_dispositions d JOIN outbound_messages o ON o.entity_type='TURN_RESPONSE' AND o.entity_id=d.turn_id").get() as any;
  assert.equal(row.turn_id, first.turnId); assert.equal(row.purpose, 'acknowledgement'); assert.equal(row.disposition, 'RUNTIME_RESPONSE'); assert.equal(row.client_message_id, `turn-${first.turnId}-acknowledgement`); assert.match(row.snapshot_hash, /^[a-f0-9]{64}$/);
});

test('OUT-002 crash after provider submission is reconciled without resend', async () => {
  const first = prepared(); const channel = new SimulatedChannel(); const service = new OutboundMessageService(first.db, channel); service.setCrashAfterSubmittedBeforeFinalize();
  await assert.rejects(service.sendTurnResponse({ authorization: first.authorization }), /INJECTED_CRASH/);
  assert.equal((first.db.db.prepare('SELECT status FROM outbound_messages').get() as any).status, 'PENDING');
  const restarted = new OutboundMessageService(first.db, channel); await restarted.reconcile();
  assert.equal((first.db.db.prepare('SELECT status FROM outbound_messages').get() as any).status, 'SUBMITTED'); assert.equal(channel.sendCount, 1);
});

test('OUT-002 UNKNOWN is safe, never blindly resent, and can reconcile by client evidence', async () => {
  const first = prepared(); const channel = new SimulatedChannel([{ status: 'unknown', clientMessageId: 'ignored' }], [{ status: 'submitted', externalMessageId: 'provider-evidence' }]); const service = new OutboundMessageService(first.db, channel);
  const unknown = await service.sendTurnResponse({ authorization: first.authorization }); assert.equal(unknown.status, 'UNKNOWN');
  const blocked = await service.sendTurnResponse({ authorization: first.authorization }); assert.equal(blocked.status, 'UNKNOWN'); assert.equal(channel.sendCount, 1);
  await service.reconcile(); assert.equal((first.db.db.prepare('SELECT status,external_message_id FROM outbound_messages').get() as any).status, 'SUBMITTED'); assert.equal(channel.sendCount, 1);
});

test('OUT-002 real transport terminal dispositions atomically resolve action results, survive restart, and never send TURN_RESPONSE', async () => {
  const cases = [
    { name: 'request_human_handoff', args: { accountId: start.accountId, conversationId: start.conversationId, customerId: 'CUST-001', workItemId: 'out-002-wi', expectedWorkItemRevision: 1, reasonCode: 'NEEDS_STAFF' }, result: { status: 'SUCCEEDED', data: { workItemId: 'out-002-wi', state: 'HANDED_OFF', reasonCode: 'NEEDS_STAFF' }, evidence: [], stateChanges: [] }, reason: 'PI_HANDOFF_NO_CUSTOMER_MESSAGE' },
    { name: 'send_quotation', args: { accountId: start.accountId, conversationId: start.conversationId, customerId: 'CUST-001', quotationId: 'out-002-q', customerMessage: 'Please review the quotation and reply OK confirm if you would like to proceed.' }, result: { status: 'SUCCEEDED', data: { quotationId: 'out-002-q', status: 'SENT' }, evidence: [], stateChanges: [] }, reason: 'PI_CAPABILITY_OWNED_QUOTATION' },
  ] as const;
  for (const candidate of cases) {
    const db = new V1Database(':memory:'); db.resetAndSeed();
    db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(start.inboundMessageId, start.conversationId, 'out-002-runtime-in', 'INBOUND', 'text', 'hello', start.accountId, start.nowIso);
    if (candidate.name === 'request_human_handoff') db.db.prepare("INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('out-002-wi', start.accountId, start.conversationId, 'CUST-001', 'SALES_ORDER_REQUEST', 'OPEN', 1, 'staff review', null, null, null, null, start.inboundMessageId, start.nowIso, start.nowIso);
    else db.db.prepare("INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run('out-002-q', 'QT-OUT002', 'CUST-001', 'DRAFT', 'SGD', '2026-09-10', '2026-09-30', start.conversationId, start.inboundMessageId, 100, 0, 100);
    const definition = candidate.name === 'request_human_handoff' ? 'request_human_handoff' : 'send_quotation';
    const transport = { mode: 'native', id: `out-002-${candidate.name}`, decide: async (observation: any) => ({ kind: 'tool_call', turnId: observation.turnId, sequence: observation.sequence, ...deriveAgentDecisionIdentity(observation.turnId, observation.sequence), capabilityName: definition, capabilityVersion: 'v1', arguments: candidate.args }) } as any;
    let sends = 0;
    const out = await new V2TransportRuntime(db, { transport, execute: () => { return candidate.result; }, outbound: { sendTurnResponse: async () => { sends += 1; } } }).run(start);
    assert.equal(out.status, 'TERMINAL'); assert.equal(out.reasonCode, candidate.reason); assert.equal(sends, 0);
    assert.equal((db.db.prepare('SELECT status FROM agent_turns').get() as any).status, 'TERMINAL');
    assert.equal((db.db.prepare('SELECT count(*) n FROM agent_action_results').get() as any).n, 1);
    assert.equal((db.db.prepare('SELECT count(*) n FROM outbound_messages WHERE entity_type=\'TURN_RESPONSE\'').get() as any).n, 0);
    const replay = await new V2TransportRuntime(db, { transport, execute: () => { throw new Error('must not re-execute'); }, outbound: { sendTurnResponse: async () => { sends += 1; } } }).run(start);
    assert.equal(replay.status, 'TERMINAL'); assert.equal(replay.reasonCode, candidate.reason); assert.equal(sends, 0);
  }
});

test('OUT-002 runtime CLARIFY and HANDOFF customer response plans are grounded and sent exactly once across replay', async () => {
  for (const [intent, textValue, purpose, reasonCode] of [['CLARIFY', 'Could you clarify your request?', 'clarification', 'AMBIGUOUS_REQUEST'], ['HANDOFF', 'A specialist can assist further.', 'handoff', 'STAFF_REVIEW']] as const) {
    const db = new V1Database(':memory:'); db.resetAndSeed();
    db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(start.inboundMessageId, start.conversationId, 'out-002-final-in', 'INBOUND', 'text', 'hello', start.accountId, start.nowIso);
    const transport = { mode: 'native', id: `out-002-${intent}`, decide: async (observation: any) => ({ kind: 'final_response', turnId: observation.turnId, sequence: observation.sequence, ...deriveAgentDecisionIdentity(observation.turnId, observation.sequence), responsePlan: { turnId: observation.turnId, intent, connectiveText: textValue, factClaims: [], ...(reasonCode ? { safeReasonCode: reasonCode, ...(intent === 'HANDOFF' ? { handoff: { reasonCode } } : {}) } : {}), outboundPurpose: purpose } }) } as any;
    const channel = new SimulatedChannel(); const service = new OutboundMessageService(db, channel);
    const runtime = new V2TransportRuntime(db, { transport, execute: () => { throw new Error('must not execute'); }, outbound: service });
    const first = await runtime.run(start); assert.equal(first.reasonCode, 'PI_FINAL_PENDING_GROUNDING'); assert.equal(channel.sendCount, 1); assert.equal(channel.sent[0].text, textValue);
    const replay = await new V2TransportRuntime(db, { transport, execute: () => { throw new Error('must not execute'); }, outbound: new OutboundMessageService(db, channel) }).run(start);
    assert.equal(replay.status, 'TERMINAL'); assert.equal(channel.sendCount, 1);
  }
});

test('OUT-002 payload-changing retry is rejected as stale before a second provider call', async () => {
  const fixture = prepared('CLARIFY'); const channel = new SimulatedChannel([{ status: 'failed', retryable: true, errorCode: 'TEMPORARY' }]); const service = new OutboundMessageService(fixture.db, channel);
  const first = await service.sendTurnResponse({ authorization: fixture.authorization }); assert.equal(first.status, 'FAILED'); assert.equal(channel.sendCount, 1);
  fixture.db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run('out-002-reply', start.conversationId, 'out-002-reply-ext', 'INBOUND', 'text', 'follow-up', start.accountId, start.nowIso);
  await assert.rejects(() => service.sendTurnResponse({ authorization: new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId), replyToExternalMessageId: 'out-002-reply-ext' }), /TURN_OUTBOUND_REPLAY_CONFLICT|FRESH_GROUNDING_MISMATCH/);
  assert.equal(channel.sendCount, 1);
});

test('OUT-002 executes clarification and handoff customer responses through the durable owner', async () => {
  for (const intent of ['CLARIFY', 'HANDOFF'] as const) {
    const fixture = prepared(intent); const channel = new SimulatedChannel();
    const service = new OutboundMessageService(fixture.db, channel);
    const sent = await service.sendTurnResponse({ authorization: fixture.authorization });
    assert.equal(sent.status, 'SUBMITTED'); assert.equal(channel.sendCount, 1);
    assert.equal(channel.sent[0].text, intent === 'CLARIFY' ? 'Could you clarify your request?' : 'A specialist can assist further.');
    const replay = await service.sendTurnResponse({ authorization: new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId) });
    assert.equal(replay.id, sent.id); assert.equal(channel.sendCount, 1);
  }
});

test('OUT-002 reply reference cannot cross conversation scope', async () => {
  const fixture = prepared('CLARIFY'); const channel = new SimulatedChannel();
  fixture.db.db.prepare("INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status) VALUES('conv-002','demo-account','external-conv-002','CUST-001','ACTIVE')").run();
  fixture.db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('cross-message','conv-002','cross-conversation','INBOUND','text','other', 'demo-account', '2026-09-10T01:00:00Z')").run();
  const service = new OutboundMessageService(fixture.db, channel);
  await assert.rejects(() => service.sendTurnResponse({ authorization: fixture.authorization, replyToExternalMessageId: 'cross-conversation' }), /TURN_REPLY_SCOPE/);
  assert.equal(channel.sendCount, 0);
});

test('OUT-002 disposition is guarded, append-only, exclusive, and reset-safe after runtime output', async () => {
  const fixture = prepared('CLARIFY'); const service = new OutboundMessageService(fixture.db, new SimulatedChannel());
  await service.sendTurnResponse({ authorization: fixture.authorization });
  const row = fixture.db.db.prepare('SELECT turn_id,purpose FROM turn_outbound_dispositions').get() as any;
  assert.throws(() => fixture.db.db.prepare("UPDATE turn_outbound_dispositions SET purpose='handoff'").run(), /IMMUTABLE_TURN_OUTBOUND_DISPOSITION/);
  assert.throws(() => fixture.db.db.prepare("DELETE FROM turn_outbound_dispositions").run(), /IMMUTABLE_TURN_OUTBOUND_DISPOSITION/);
  assert.throws(() => fixture.db.db.prepare("INSERT INTO turn_outbound_dispositions(turn_id,disposition,purpose,outbound_message_id,payload_hash,created_at) VALUES('raw','HANDOFF_NO_CUSTOMER_MESSAGE','handoff','raw-out','hash','now')").run(), /TURN_OUTBOUND_DISPOSITION_INSERT_REQUIRES_SERVICE/);
  assert.equal(row.purpose, 'clarification');
  fixture.db.resetAndSeed();
  assert.equal(fixture.db.db.prepare('SELECT count(*) n FROM turn_outbound_dispositions').get().n, 0);
});

test('OUT-002 pre-send fresh-grounding mismatch never strands PENDING; bounded retry reauthorizes and succeeds exactly once', async () => {
  const fixture = prepared(); const channel = new SimulatedChannel(); const service = new OutboundMessageService(fixture.db, channel);
  const original = ResponseGroundingGuard.prototype.authorize;
  let calls = 0;
  (ResponseGroundingGuard.prototype as any).authorize = function (turnId: string) {
    calls += 1;
    const real = original.call(this, turnId);
    return calls === 1 ? { ...real, verdict: { ...real.verdict, renderedText: 'Tampered text that never matches the claimed authorization.' } } : real;
  };
  try {
    await assert.rejects(service.sendTurnResponse({ authorization: fixture.authorization }), /FRESH_GROUNDING_MISMATCH/);
  } finally {
    ResponseGroundingGuard.prototype.authorize = original;
  }
  assert.equal(channel.sendCount, 0);
  const row = fixture.db.db.prepare('SELECT status,last_error,attempt_count FROM outbound_messages').get() as any;
  assert.equal(row.status, 'FAILED');
  assert.match(row.last_error, /^retryable:FRESH_GROUNDING_MISMATCH/);
  assert.equal(row.attempt_count, 1);

  const retry = await service.sendTurnResponse({ authorization: new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId) });
  assert.equal(retry.status, 'SUBMITTED'); assert.equal(channel.sendCount, 1);
  assert.equal((fixture.db.db.prepare('SELECT attempt_count FROM outbound_messages').get() as any).attempt_count, 2);
});

test('OUT-002 provider send exception is durably UNKNOWN, never blindly resent on replay', async () => {
  const fixture = prepared();
  let sendCalls = 0;
  const channel = { async send() { sendCalls += 1; throw Error('ECONNRESET'); } } as any;
  const service = new OutboundMessageService(fixture.db, channel);
  await assert.rejects(service.sendTurnResponse({ authorization: fixture.authorization }), /ECONNRESET/);
  assert.equal(sendCalls, 1);
  const row = fixture.db.db.prepare('SELECT status,last_error FROM outbound_messages').get() as any;
  assert.equal(row.status, 'UNKNOWN'); assert.match(row.last_error, /^unresolved:ECONNRESET/);
  const replay = await service.sendTurnResponse({ authorization: new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId) });
  assert.equal(replay.status, 'UNKNOWN'); assert.equal(sendCalls, 1);
});

test('OUT-002 send exception then reconciled not_found permits exactly one further fresh-authorized attempt', async () => {
  const fixture = prepared();
  let sendCalls = 0, reconcileCalls = 0;
  const channel = {
    async send(message: any) { sendCalls += 1; if (sendCalls === 1) throw Error('ETIMEDOUT'); return { status: 'submitted', externalMessageId: `provider-${message.clientMessageId}`, submittedAt: '2026-09-10T01:00:05Z' }; },
    async reconcile() { reconcileCalls += 1; return { status: 'not_found' as const }; },
  } as any;
  const service = new OutboundMessageService(fixture.db, channel);
  await assert.rejects(service.sendTurnResponse({ authorization: fixture.authorization }), /ETIMEDOUT/);
  assert.equal((fixture.db.db.prepare('SELECT status FROM outbound_messages').get() as any).status, 'UNKNOWN');

  const restarted = new OutboundMessageService(fixture.db, channel);
  await restarted.reconcile();
  assert.equal(reconcileCalls, 1);
  const afterReconcile = fixture.db.db.prepare('SELECT status,last_error,attempt_count,client_message_id FROM outbound_messages').get() as any;
  assert.equal(afterReconcile.status, 'FAILED'); assert.equal(afterReconcile.last_error, 'retryable:not_found');
  assert.equal(afterReconcile.client_message_id, `turn-${fixture.turnId}-acknowledgement`);

  const retry = await restarted.sendTurnResponse({ authorization: new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId) });
  assert.equal(retry.status, 'SUBMITTED'); assert.equal(sendCalls, 2);
  assert.equal((fixture.db.db.prepare('SELECT attempt_count FROM outbound_messages').get() as any).attempt_count, 2);
});

test('OUT-002 send exception stays UNKNOWN across restart when reconciliation evidence is unavailable', async () => {
  const fixture = prepared();
  let sendCalls = 0;
  const channel = { async send() { sendCalls += 1; throw Error('NETWORK_DOWN'); }, async reconcile() { return { status: 'unknown' as const }; } } as any;
  const service = new OutboundMessageService(fixture.db, channel);
  await assert.rejects(service.sendTurnResponse({ authorization: fixture.authorization }), /NETWORK_DOWN/);

  const restarted = new OutboundMessageService(fixture.db, channel);
  await restarted.reconcile();
  const row = fixture.db.db.prepare('SELECT status,client_message_id FROM outbound_messages').get() as any;
  assert.equal(row.status, 'UNKNOWN'); assert.equal(row.client_message_id, `turn-${fixture.turnId}-acknowledgement`);

  const replay = await restarted.sendTurnResponse({ authorization: new ResponseGroundingGuard(fixture.db).authorize(fixture.turnId) });
  assert.equal(replay.status, 'UNKNOWN'); assert.equal(sendCalls, 1);
});

test('OUT-002 final NONE is durable, exclusive, and replay-safe without a customer message', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(start.inboundMessageId, start.conversationId, 'out-002-none', 'INBOUND', 'text', 'hello', start.accountId, start.nowIso);
  const coordinator = new AgentTurnCoordinator(db); const turn = coordinator.start(start);
  coordinator.complete({ turnId: turn.turnId, reason: 'PI_MODEL_FAILED' });
  assert.deepEqual(db.db.prepare('SELECT disposition,purpose,outbound_message_id FROM turn_outbound_dispositions WHERE turn_id=?').get(turn.turnId), { disposition: 'NONE', purpose: 'none', outbound_message_id: null });
  assert.doesNotThrow(() => coordinator.complete({ turnId: turn.turnId, reason: 'PI_MODEL_FAILED' }));
  assert.equal(db.db.prepare('SELECT count(*) n FROM turn_outbound_dispositions WHERE turn_id=?').get(turn.turnId).n, 1);
});
