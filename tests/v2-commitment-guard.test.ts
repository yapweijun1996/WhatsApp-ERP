import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CommerceService } from '../src/commerce.js';
import { quotationCommercialSealPayload } from '../src/commerce.js';
import { CommitmentGuard, commitmentMessageRef, narrowCommitmentProposal } from '../src/v2-commitment-guard.js';
import { SimulatedChannel } from '../src/channels.js';

const message = (text: string, id: string, occurredAt = new Date(Date.now() + 1000).toISOString()) => ({
  channel: 'whatsapp' as const, accountId: 'demo-account', externalMessageId: id, conversationId: 'conv-001',
  sender: { externalId: '+6591110001', phone: '+6591110001' }, type: 'text' as const, text, occurredAt,
});

test('COM-002 semantic kind is AI-owned while target and evidence scope remain host-owned', async () => {
  const { service, guard, quote } = await sentQuote();
  const inbound = persist(service, message('Yes', 'model-semantic-accept'));
  const proposal = narrowCommitmentProposal({ kind: 'ACCEPT' }, { accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: inbound });
  const authorized = guard.authorize(proposal);
  assert.equal(authorized.reasonCode, 'ACCEPTED');
  assert.equal(authorized.quoteRef?.id, quote.id);
  assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'SENT');
  assert.equal((service.database.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n, 0);
  assert.throws(() => narrowCommitmentProposal({ kind: 'ACCEPT', quotationId: quote.id, customerId: 'CUST-001', explicit: true }, { accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: inbound }), /COMMITMENT_PROPOSAL_INVALID/);
});

test('COM-002 narrowing does not invoke accessor-backed kind or coerce non-string values', () => {
  let getterInvoked = false;
  const accessorBacked = Object.defineProperty({}, 'kind', {
    enumerable: true,
    get() { getterInvoked = true; return 'ACCEPT'; },
  });
  const context = { accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'inbound-1' };
  assert.throws(() => narrowCommitmentProposal(accessorBacked, context), /COMMITMENT_PROPOSAL_KIND_INVALID/);
  assert.equal(getterInvoked, false);
  assert.throws(() => narrowCommitmentProposal({ kind: { toString: () => 'ACCEPT' } }, context), /COMMITMENT_PROPOSAL_KIND_INVALID/);
  assert.throws(() => narrowCommitmentProposal({ kind: new String('ACCEPT') }, context), /COMMITMENT_PROPOSAL_KIND_INVALID/);
  const proposal = narrowCommitmentProposal({ kind: 'ACCEPT' }, context);
  assert.equal(Object.isFrozen(proposal), true);
  assert.deepEqual(proposal, { ...context, kind: 'ACCEPT' });
});

test('COM-002 narrowing treats host evidence as an exact descriptor-safe boundary', () => {
  let invoked = false;
  const context = Object.defineProperties({}, {
    accountId: { enumerable: true, get() { invoked = true; return 'demo-account'; } },
    conversationId: { enumerable: true, value: 'conv-001' },
    inboundMessageId: { enumerable: true, value: 'inbound-1' },
  });
  assert.throws(() => narrowCommitmentProposal({ kind: 'ACCEPT' }, context as any), /COMMITMENT_EVIDENCE_CONTEXT_INVALID/);
  assert.equal(invoked, false);
  assert.throws(() => narrowCommitmentProposal({ kind: 'ACCEPT' }, { accountId: 'a', conversationId: 'c', inboundMessageId: 'i', extra: 'forged' } as any), /COMMITMENT_EVIDENCE_CONTEXT_INVALID/);
  const inherited = Object.create({ accountId: 'a', conversationId: 'c', inboundMessageId: 'i' });
  assert.throws(() => narrowCommitmentProposal({ kind: 'ACCEPT' }, inherited), /COMMITMENT_EVIDENCE_CONTEXT_INVALID/);
  assert.throws(() => narrowCommitmentProposal({ kind: 'ACCEPT' }, Object.assign(Object.create(null), { accountId: 'a', conversationId: 'c', inboundMessageId: 'i' })), /COMMITMENT_EVIDENCE_CONTEXT_INVALID/);
});

test('COM-002 direct guard validation invokes no proposal user code and rejects forged fields', async () => {
  const { service, guard } = await sentQuote();
  let coercionInvoked = false;
  const coercible = { kind: { toString() { coercionInvoked = true; return 'ACCEPT'; } }, accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'missing' };
  assert.equal(guard.authorize(coercible as any).reasonCode, 'PROPOSAL_INVALID');
  assert.equal(coercionInvoked, false);
  let accessorInvoked = false;
  const accessor = Object.defineProperty({ accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'missing' }, 'kind', {
    enumerable: true, get() { accessorInvoked = true; return 'ACCEPT'; },
  });
  assert.equal(guard.authorize(accessor as any).reasonCode, 'PROPOSAL_INVALID');
  assert.equal(accessorInvoked, false);
  const forged = { kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'missing', quotationId: 'forged' };
  assert.equal(guard.authorize(forged as any).reasonCode, 'PROPOSAL_INVALID');
  assert.equal((service.database.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n, 0);
});

test('COM-002 valid semantic proposal is still guard-authorized and cannot select a forged target', async () => {
  const { service, guard, quote } = await sentQuote();
  const id = persist(service, message('OK confirm', 'model-valid'));
  const proposal = narrowCommitmentProposal({ kind: 'ACCEPT' }, { accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: id });
  const authorized = guard.authorize(proposal);
  assert.equal(authorized.reasonCode, 'ACCEPTED');
  assert.equal(authorized.quoteRef?.id, quote.id);
  assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'SENT');
  assert.equal((service.database.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n, 0);
  const forged = persist(service, message('OK confirm', 'model-forged'));
  service.database.db.prepare("UPDATE messages SET sender_external_id='+6599999999' WHERE id=?").run(forged);
  assert.equal(guard.authorize(narrowCommitmentProposal({ kind: 'ACCEPT' }, { accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: forged })).reasonCode, 'IDENTITY_MISMATCH');
});

async function sentQuote() {
  const channel = new SimulatedChannel(); await channel.connect();
  const service = new CommerceService(undefined, channel); service.resetAndSeed();
  const sourceId = persist(service, message('arbitrary source evidence', 'source-order', new Date(Date.now() - 2000).toISOString()));
  const sentAt = new Date(Date.now() - 1000).toISOString();
  const quoteId = 'canonical-sent-quote';
  const quoteNo = 'QT-CANONICAL-SENT';
  const lineId = 'canonical-sent-line';
  const productId = 'FCH-WHOLE-12';
  const description = 'Frozen Whole Chicken 1.2kg x 10';
  const quantity = '1';
  const uom = 'CTN';
  const unitPriceCents = 4800;
  const snapshot = JSON.stringify({ quotationNo: quoteNo, customerId: 'CUST-001', warehouseId: 'SG-MAIN', currency: 'SGD', deliveryDate: '2026-09-15', remark: null, lines: [{ rowItemNo: 1, productId, stockCode: productId, description, rowItemRemark: null, quantity, uom, unitPriceCents, subtotalCents: unitPriceCents }], subtotalCents: unitPriceCents, taxCents: 0, grandTotalCents: unitPriceCents });
  service.database.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,delivery_date,warehouse_id,remark,subtotal_cents,tax_cents,grand_total_cents,source_conversation_id,source_message_id,sent_at,accepted_at,sent_snapshot_json,sent_snapshot_hash,sent_outbound_message_id,superseded_by_quotation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(quoteId, quoteNo, 'CUST-001', 'SENT', 'SGD', sentAt, new Date(Date.now() + 604800000).toISOString(), '2026-09-15', 'SG-MAIN', null, unitPriceCents, 0, unitPriceCents, 'conv-001', sourceId, sentAt, null, snapshot, sha(snapshot), 'quote-external-001', null);
  service.database.db.prepare('INSERT INTO quotation_lines VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(lineId, quoteId, 1, productId, productId, description, null, quantity, uom, unitPriceCents, unitPriceCents);
  const evidence = [
    ['customer', 'resolve_customer', { sender: '+6591110001', text: 'arbitrary source evidence', accountId: 'demo-account' }, { customerId: 'CUST-001', warehouseId: 'SG-MAIN' }],
    ['product', 'search_products', { customerId: 'CUST-001', query: 'ayam' }, { productId, stockCode: productId, description }],
    ['uom', 'resolve_uom', { productId, expression: uom }, { productId, requestedUom: uom }],
    ['uom_conversion', 'convert_uom', { productId, quantity: 1, fromUom: uom, toUom: 'PCS' }, { productId, quantity: 1, fromUom: uom }],
    ['price', 'get_customer_price', { customerId: 'CUST-001', productId, quantity: 1, uom, date: sentAt.slice(0, 10) }, { customerId: 'CUST-001', productId, uom, unitPriceCents }],
    ['stock', 'check_stock', { productId, warehouseId: 'SG-MAIN', quantity: 1, uom }, { productId, warehouseId: 'SG-MAIN', uom }],
    ['order_history', 'get_recent_orders', { customerId: 'CUST-001', limit: 5 }, { orders: [] }],
  ] as const;
  for (const [role, toolName, input, output] of evidence) {
    const toolCallId = `canonical-tool-${role}`;
    const callEvidence = { type: role, input, output, observedAt: sentAt, sourceVersion: 'demo-v1', toolCallId };
    service.database.db.prepare('INSERT INTO agent_tool_calls VALUES(?,?,?,?,?,?,?)').run(toolCallId, 'canonical-run', toolName, JSON.stringify(input), JSON.stringify(callEvidence), 'SUCCEEDED', sentAt);
    const evidenceId = `canonical-evidence-${role}`;
    const inputJson = JSON.stringify(input);
    service.database.insertErpEvidence({ id: evidenceId, evidenceType: role, toolCallId, lookupKey: sha(inputJson), inputJson, outputJson: JSON.stringify(output), observedAt: sentAt, sourceVersion: 'demo-v1' });
    service.database.db.prepare('INSERT INTO quotation_line_evidence VALUES(?,?,?)').run(lineId, evidenceId, role);
    service.database.insertGroundingProvenance({ evidenceId, accountId: 'demo-account', conversationId: 'conv-001', customerId: 'CUST-001', quotationId: quoteId, linkType: 'TEST_CANONICAL_QUOTATION', createdAt: sentAt });
  }
  const sealPayload = quotationCommercialSealPayload(service.database.db, quoteId, snapshot);
  service.database.insertCommercialIntegritySeal({ entityType: 'QUOTATION', entityId: quoteId, accountId: 'demo-account', conversationId: 'conv-001', customerId: 'CUST-001', lineageId: quoteId, payloadJson: sealPayload, payloadHash: sha(sealPayload), sealedAt: sentAt });
  service.database.db.prepare('INSERT INTO outbound_messages(id,conversation_id,external_message_id,client_message_id,entity_type,entity_id,snapshot_hash,payload_json,status,attempt_count,last_error,submitted_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('canonical-quote-outbound', 'conv-001', 'quote-external-001', 'quote-client-001', 'QUOTATION', quoteId, sha(snapshot), '{}', 'SUBMITTED', 1, null, sentAt, sentAt);
  const quote = service.database.db.prepare("SELECT * FROM quotations WHERE status='SENT'").get() as any;
  return { service, quote, guard: new CommitmentGuard(service.database.db) };
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function persist(service: CommerceService, m: ReturnType<typeof message>) {
  const id = `canonical-${m.externalMessageId}`;
  service.database.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,account_id,occurred_at,forwarding_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, 'conv-001', m.externalMessageId, 'INBOUND', 'text', m.text, m.sender.externalId, m.sender.phone, m.accountId, m.occurredAt, null);
  return id;
}

test('COM-001 canonical identity and ordering evidence fail closed without re-parsing customer language', async () => {
  const identityCase = await sentQuote();
  const badIdentityId = persist(identityCase.service, message('whatever wording', 'bad-identity'));
  identityCase.service.database.db.prepare("UPDATE messages SET sender_external_id='+6599999999' WHERE id=?").run(badIdentityId);
  const identityResult = identityCase.guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: badIdentityId });
  assert.equal(identityResult.reasonCode, 'IDENTITY_MISMATCH');
  assert.equal((identityCase.service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(identityCase.quote.id) as any).status, 'SENT');

  const reorderCase = await sentQuote();
  const tooEarly = new Date(new Date(reorderCase.quote.sent_at).getTime() - 1).toISOString();
  const reorderedId = persist(reorderCase.service, message('semantic accept', 'reordered-ai', tooEarly));
  const reordered = reorderCase.guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: reorderedId });
  assert.equal(reordered.reasonCode, 'MESSAGE_REORDERED');
  assert.equal((reorderCase.service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(reorderCase.quote.id) as any).status, 'SENT');
});

test('COM-001 active SENT cancel and reject are exact idempotent mutations with evidence', async () => {
  const { service, guard, quote } = await sentQuote();
  const cancel = message('cancel', 'cancel-1'); const cancelId = persist(service, cancel);
  const first = guard.authorize({ kind: 'CANCEL', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: cancelId });
  assert.equal(first.outcome, 'APPLIED'); assert.equal(service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id).status, 'REJECTED');
  const replay = guard.authorize({ kind: 'CANCEL', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: cancelId });
  assert.equal(replay.outcome, 'NOOP_REPLAY'); assert.equal(service.database.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type='COMMITMENT'").get().n, 1);
});

test('COM-001 explicit REJECT moves active SENT to REJECTED once with bound inbound/audit evidence', async () => {
  const { service, guard, quote } = await sentQuote();
  const m = message('reject', 'reject-1'); const id = persist(service, m);
  const first = guard.authorize({ kind: 'REJECT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: id });
  assert.equal(first.outcome, 'APPLIED'); assert.equal(first.reasonCode, 'REJECTED');
  assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'REJECTED');
  assert.equal(first.evidenceRefs.length, 2); assert.equal(first.evidenceRefs[1].sourceId, id);
  const replay = guard.authorize({ kind: 'REJECT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: id });
  assert.equal(replay.outcome, 'NOOP_REPLAY'); assert.equal(replay.reasonCode, 'REJECTED');
  assert.equal((service.database.db.prepare("SELECT count(*) n FROM audit_events WHERE entity_id=? AND event_type='COMMITMENT'").get(quote.id) as any).n, 1);
  assert.equal((service.database.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n, 0);
  assert.equal((service.database.db.prepare('SELECT count(*) n FROM sales_orders').get() as any).n, 1);
});

test('COM-001 guard authorization is separate from acceptance mutation and unrelated outbound does not block', async () => {
  const { service, guard, quote } = await sentQuote();
  service.database.db.prepare("INSERT INTO outbound_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run('unrelated', 'conv-001', null, 'other', 'MESSAGE', 'not-a-quote', 'hash', '{}', 'PENDING', 1, null, null, new Date().toISOString());
  const id = persist(service, message('OK confirm', 'authorize-only'));
  const result = guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: id });
  assert.equal(result.outcome, 'APPLIED'); assert.equal(result.reasonCode, 'ACCEPTED');
  assert.deepEqual(result.evidenceRefs, [
    { sourceId: id, sourceVersion: 'INBOUND' },
    { sourceId: quote.id, sourceVersion: 'QUOTATION' },
  ]);
  assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'SENT');
  assert.equal((service.database.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n, 0);
  assert.equal((service.database.db.prepare('SELECT count(*) n FROM sales_orders').get() as any).n, 1);
});

test('COM-001 forwarding, ordering, reply, and canonical scope mismatches fail closed', async () => {
  for (const variant of ['forwarded', 'malformed', 'reordered', 'reply', 'wrong-account', 'wrong-conversation', 'wrong-sender', 'quote-scope'] as const) {
    const { service, guard, quote } = await sentQuote();
    const m = message('OK confirm', `evidence-${variant}`, variant === 'reordered' ? new Date(new Date(quote.sent_at).getTime() - 1).toISOString() : undefined);
    const id = persist(service, m);
    if (variant === 'forwarded') service.database.db.prepare(`UPDATE messages SET forwarding_json='{"isForwarded":true}' WHERE id=?`).run(id);
    if (variant === 'malformed') service.database.db.prepare(`UPDATE messages SET forwarding_json='{"isForwarded":"false"}' WHERE id=?`).run(id);
    if (variant === 'reply') service.database.db.prepare("UPDATE messages SET reply_to_external_message_id='uncorrelated' WHERE id=?").run(id);
    if (variant === 'wrong-account') { assert.equal(guard.authorize({ kind: 'ACCEPT', accountId: 'wrong-account', conversationId: 'conv-001', inboundMessageId: id }).reasonCode, 'INBOUND_NOT_PERSISTED'); assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'SENT'); continue; }
    if (variant === 'wrong-conversation') { assert.equal(guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'wrong-conversation', inboundMessageId: id }).reasonCode, 'INBOUND_NOT_PERSISTED'); assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'SENT'); continue; }
    if (variant === 'wrong-sender') service.database.db.prepare("UPDATE messages SET sender_external_id='+6599999999' WHERE id=?").run(id);
    if (variant === 'quote-scope') service.database.db.prepare("UPDATE quotations SET customer_id='OTHER-CUSTOMER' WHERE id=?").run(quote.id);
    const result = guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: id });
    assert.notEqual(result.outcome, 'APPLIED', variant);
    assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'SENT');
    assert.equal((service.database.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n, 0);
    assert.equal((service.database.db.prepare('SELECT count(*) n FROM sales_orders').get() as any).n, 1);
  }
});

test('COM-001 expired, superseded, missing inbound, invalid, and concurrent states are safe', async () => {
  const expired = await sentQuote();
  expired.service.database.db.prepare("UPDATE quotations SET valid_until='2000-01-01' WHERE id=?").run(expired.quote.id);
  const expiredId = persist(expired.service, message('OK confirm', 'expired'));
  assert.equal(expired.guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: expiredId }).reasonCode, 'QUOTE_EXPIRED');
  assert.equal((expired.service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(expired.quote.id) as any).status, 'SENT');
  const terminal = await sentQuote();
  terminal.service.database.db.prepare("UPDATE quotations SET status='EXPIRED', valid_until='2999-01-01' WHERE id=?").run(terminal.quote.id);
  const terminalId = persist(terminal.service, message('OK confirm', 'terminal-expired'));
  const terminalResult = terminal.guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: terminalId });
  assert.equal(terminalResult.reasonCode, 'QUOTE_EXPIRED');
  assert.equal(terminalResult.outcome, 'NEEDS_CLARIFICATION');
  assert.equal((terminal.service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(terminal.quote.id) as any).status, 'EXPIRED');
  assert.equal((terminal.service.database.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n, 0);
  const superseded = await sentQuote();
  superseded.service.database.db.prepare("UPDATE quotations SET status='SUPERSEDED' WHERE id=?").run(superseded.quote.id);
  const supersededId = persist(superseded.service, message('OK confirm', 'superseded'));
  assert.equal(superseded.guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: supersededId }).reasonCode, 'QUOTE_SUPERSEDED');
  assert.equal(superseded.guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: 'missing' }).reasonCode, 'INBOUND_NOT_PERSISTED');
  assert.equal(superseded.guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: supersededId, ...({ kind: 'INVALID' } as any) }).reasonCode, 'PROPOSAL_INVALID');
  superseded.service.database.db.prepare("UPDATE quotations SET status='ACCEPTED' WHERE id=?").run(superseded.quote.id);
  assert.equal(superseded.guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: supersededId }).reasonCode, 'COMMITMENT_ALREADY_ACCEPTED');
  assert.equal((superseded.service.database.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n, 0);
});

test('COM-001 pending and unknown quotation outbound suspend acceptance while old quote stays SENT', async () => {
  for (const status of ['PENDING', 'UNKNOWN'] as const) {
    const { service, guard, quote } = await sentQuote();
    service.database.db.prepare("INSERT INTO outbound_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`unresolved-${status}`, 'conv-001', null, `replacement-${status}`, 'QUOTATION', 'replacement', 'hash', '{}', status, 1, null, null, new Date().toISOString());
    const id = persist(service, message('OK confirm', `unresolved-${status}`));
    const result = guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: id });
    assert.equal(result.reasonCode, 'UNRESOLVED_OUTBOUND'); assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'SENT');
    assert.equal((service.database.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n, 0);
    assert.equal((service.database.db.prepare('SELECT count(*) n FROM sales_orders').get() as any).n, 1);
  }
});

test('COM-001 pending and unknown quotation outbound do not prevent explicit rejection or cancellation', async () => {
  for (const status of ['PENDING', 'UNKNOWN'] as const) {
    for (const kind of ['REJECT', 'CANCEL'] as const) {
      const { service, guard, quote } = await sentQuote();
      service.database.db.prepare("INSERT INTO outbound_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`unresolved-${status}-${kind}`, 'conv-001', null, `replacement-${status}-${kind}`, 'QUOTATION', 'replacement', 'hash', '{}', status, 1, null, null, new Date().toISOString());
      const id = persist(service, message(kind === 'REJECT' ? 'reject' : 'cancel', `unresolved-${status}-${kind}`));
      const first = guard.authorize({ kind, accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: id });
      assert.equal(first.outcome, 'APPLIED');
      assert.equal(first.reasonCode, kind === 'REJECT' ? 'REJECTED' : 'REJECTION_RECORDED');
      assert.equal(first.evidenceRefs[1].sourceId, id);
      assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'REJECTED');
      const replay = guard.authorize({ kind, accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: id });
      assert.equal(replay.outcome, 'NOOP_REPLAY');
      assert.equal((service.database.db.prepare("SELECT count(*) n FROM audit_events WHERE entity_id=? AND event_type='COMMITMENT'").get(quote.id) as any).n, 1);
    }
  }
});

test('COM-001 after accepted Draft SO cancel/change hand off and cannot unwind', async () => {
  const { service, quote } = await sentQuote();
  const acceptanceId = persist(service, message('arbitrary acceptance evidence', 'accepted-for-handoff'));
  service.acceptV2(acceptanceId);
  const guard = new CommitmentGuard(service.database.db);
  for (const kind of ['CANCEL', 'CHANGE'] as const) {
    const id = persist(service, message(kind === 'CANCEL' ? 'cancel' : 'change quantity', `handoff-${kind}`));
    assert.equal(guard.authorize({ kind, accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: id }).outcome, 'HANDOFF');
  }
  assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'ACCEPTED');
  assert.equal((service.database.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n, 1);
  assert.equal((service.database.db.prepare('SELECT count(*) n FROM sales_orders').get() as any).n, 2);
});

test('COM-001 change and unresolved replacement suspend acceptance without superseding old SENT', async () => {
  const { service, guard, quote } = await sentQuote();
  const change = message('change red one to 2', 'change-1'); const changeId = persist(service, change);
  const replacement = guard.authorize({ kind: 'CHANGE', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: changeId });
  assert.equal(replacement.reasonCode, 'REPLACEMENT_REQUIRED');
  service.database.db.prepare("INSERT INTO outbound_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run('pending-replacement', 'conv-001', null, 'quote-replacement', 'QUOTATION', 'replacement', 'hash', '{}', 'PENDING', 1, null, null, new Date().toISOString());
  const accept = message('OK confirm', 'accept-during-replacement'); const acceptId = persist(service, accept);
  const suspended = guard.authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: acceptId });
  assert.equal(suspended.reasonCode, 'UNRESOLVED_OUTBOUND'); assert.equal(service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id).status, 'SENT');
  assert.equal(commitmentMessageRef(service.database.db, accept), acceptId);
});

test('COM-001 mixed customer wording is not host-classified; the AI semantic kind drives guarded authorization', async () => {
  const { service, guard, quote } = await sentQuote();
  const m = message('OK confirm, but change red one to 2', 'semantic-change'); const id = persist(service, m);
  const result = guard.authorize({ kind: 'CHANGE', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: id });
  assert.equal(result.reasonCode, 'REPLACEMENT_REQUIRED');
  assert.equal((service.database.db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'SENT');
});
