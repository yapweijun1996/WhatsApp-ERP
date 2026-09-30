import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommerceService } from '../src/commerce.js';
import { V1Database } from '../src/database.js';
import { SimulatedChannel } from '../src/channels.js';
import { CommitmentGuard } from '../src/v2-commitment-guard.js';
import { scriptedSemanticAgentFactory, goldenOffer, prepareQuote, acceptQuote } from './semantic-agent.js';

const order = 'Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?';
const message = (text: string, id: string) => ({
  channel: 'whatsapp' as const, accountId: 'demo-account', externalMessageId: id, conversationId: 'conv-001',
  sender: { externalId: '+6591110001', phone: '+6591110001' }, type: 'text' as const, text,
  occurredAt: new Date(Date.now() + 1000).toISOString(),
});

async function sentQuote(service = new CommerceService(undefined, new SimulatedChannel(), undefined, scriptedSemanticAgentFactory([goldenOffer(), prepareQuote, acceptQuote]))) {
  const channel = (service as any).adapter as SimulatedChannel;
  await channel.connect();
  service.resetAndSeed();
  await service.inbound(message(order, `com003-order-${Math.random()}`));
  await service.inbound(message('Yes please.', `com003-prepare-${Math.random()}`));
  return service;
}

test('COM-003 duplicate acceptance is replay-safe and creates one acceptance and one Draft SO', async () => {
  const service = await sentQuote();
  const db = service.database.db;
  await service.inbound(message('OK confirm.', 'com003-accept'));
  await service.inbound(message('OK confirm.', 'com003-accept'));
  assert.equal((db.prepare('SELECT count(*) AS n FROM quotation_acceptances').get() as any).n, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM sales_orders WHERE status='DRAFT'").get() as any).n, 1);
  assert.equal((db.prepare("SELECT status FROM quotations WHERE status='ACCEPTED'").get() as any).status, 'ACCEPTED');
});

test('COM-003 accepts canonical internal source-message refs used by V2 quotations', async () => {
  const service = await sentQuote();
  const db = service.database.db;
  const quote = db.prepare("SELECT id,source_message_id FROM quotations WHERE status='SENT'").get() as any;
  const source = db.prepare("SELECT id FROM messages WHERE external_message_id=? AND account_id='demo-account' AND conversation_id='conv-001' AND direction='INBOUND'").get(quote.source_message_id) as any;
  assert.ok(source?.id);
  db.prepare('UPDATE quotations SET source_message_id=? WHERE id=?').run(source.id, quote.id);
  await service.inbound(message('OK confirm.', 'com003-v2-internal-source'));
  assert.equal((db.prepare('SELECT count(*) AS n FROM quotation_acceptances WHERE quotation_id=?').get(quote.id) as any).n, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM sales_orders WHERE source_quotation_id=? AND status='DRAFT'").get(quote.id) as any).n, 1);
});

test('COM-003 forbidden non-SENT quote states cannot create a Draft SO', async () => {
  for (const status of ['REJECTED', 'EXPIRED', 'SUPERSEDED']) {
    const service = await sentQuote();
    const db = service.database.db;
    db.prepare('UPDATE quotations SET status=?').run(status);
    await service.inbound(message('OK confirm.', `com003-forbidden-${status}`));
    assert.equal((db.prepare('SELECT count(*) AS n FROM quotation_acceptances').get() as any).n, 0, status);
    assert.equal((db.prepare("SELECT count(*) AS n FROM sales_orders WHERE source_quotation_id NOT LIKE 'seeded-%'").get() as any).n, 0, status);
  }
});

test('COM-003 two independent SQLite connections serialize concurrent acceptance attempts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'com003-'));
  const filename = join(directory, 'commerce.sqlite');
  try {
    const first = new CommerceService(new V1Database(filename), new SimulatedChannel(), undefined, scriptedSemanticAgentFactory([goldenOffer(), prepareQuote, acceptQuote]));
    await (first as any).adapter.connect();
    first.resetAndSeed();
    await first.inbound(message(order, 'com003-race-order'));
    await first.inbound(message('Yes please.', 'com003-race-prepare'));
    const second = new CommerceService(new V1Database(filename), new SimulatedChannel(), undefined, scriptedSemanticAgentFactory([]));
    await (second as any).adapter.connect();
    await Promise.all([
      first.inbound(message('OK confirm.', 'com003-race-a')),
      second.inbound(message('OK confirm.', 'com003-race-b')),
    ]);
    const db = first.database.db;
    assert.equal((db.prepare('SELECT count(*) AS n FROM quotation_acceptances').get() as any).n, 1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM sales_orders WHERE status='DRAFT'").get() as any).n, 1);
    assert.equal((db.prepare("SELECT status FROM quotations WHERE status='ACCEPTED'").get() as any).status, 'ACCEPTED');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('COM-003 acceptance rechecks persisted scope and sender inside commit, with atomic rollback', async () => {
  for (const variant of ['source-conversation', 'account', 'customer', 'sender'] as const) {
    const service = await sentQuote();
    const db = service.database.db;
    const quote = db.prepare("SELECT * FROM quotations WHERE status='SENT'").get() as any;
    const acceptanceMessage = message('OK confirm.', `com003-adversarial-${variant}`);
    const messageId = `canonical-${variant}`;
    db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(messageId, 'conv-001', acceptanceMessage.externalMessageId, 'INBOUND', 'text', acceptanceMessage.text, acceptanceMessage.sender.externalId, 'demo-account', acceptanceMessage.occurredAt);
    const authorized = new CommitmentGuard(db).authorize({ kind: 'ACCEPT', accountId: 'demo-account', conversationId: 'conv-001', inboundMessageId: messageId });
    assert.equal(authorized.reasonCode, 'ACCEPTED', variant);
    const sequenceBefore = (db.prepare("SELECT next_number FROM document_sequences WHERE document_type='sales_order'").get() as any).next_number;
    if (variant === 'source-conversation') db.prepare("UPDATE quotations SET source_conversation_id='other-conversation' WHERE id=?").run(quote.id);
    if (variant === 'account') db.prepare("UPDATE conversations SET channel_account_id='other-account' WHERE id='conv-001'").run();
    if (variant === 'customer') db.prepare("UPDATE conversations SET customer_id='OTHER-CUSTOMER' WHERE id='conv-001'").run();
    if (variant === 'sender') db.prepare("UPDATE messages SET sender_external_id='+6599999999' WHERE id=?").run(messageId);
    let error: unknown;
    try { (service as any).accept(acceptanceMessage, quote, authorized); } catch (caught) { error = caught; }
    assert.ok(error, variant);
    assert.match(String(error), /CANONICAL_SCOPE_MISMATCH|INBOUND_NOT_PERSISTED/, variant);
    assert.equal((db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status, 'SENT', variant);
    assert.equal((db.prepare('SELECT count(*) AS n FROM quotation_acceptances').get() as any).n, 0, variant);
    assert.equal((db.prepare("SELECT count(*) AS n FROM sales_orders WHERE source_quotation_id=?").get(quote.id) as any).n, 0, variant);
    assert.equal((db.prepare("SELECT next_number FROM document_sequences WHERE document_type='sales_order'").get() as any).next_number, sequenceBefore, variant);
  }
});
