import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { authorizeCapability } from '../src/v2-capability-authorization.js';

const A = 'demo-account', C = 'conv-001', U = 'CUST-001';
function host(db: V1Database, extra: Record<string, unknown> = {}) {
  return { db: db.db, profileId: 'sales-digital-employee', permissions: ['v2.capability.get_customer_context', 'v2.capability.create_order_draft', 'v2.capability.read_order_draft'], accountId: A, conversationId: C, customerId: U, ...extra } as any;
}
function action(name: string, args: Record<string, unknown>) { return { name, arguments: args }; }
function customerArgs() { return { accountId: A, conversationId: C, customerId: U }; }

test('CAP-003 fails closed for unknown, alias, forbidden, and prompt-injected actions', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  for (const name of ['not_registered', 'getCustomerContext', 'post_sales_order']) {
    assert.throws(() => authorizeCapability(action(name, customerArgs()), host(db)), /UNKNOWN_CAPABILITY/);
  }
  assert.throws(() => authorizeCapability(action('get_customer_context', { ...customerArgs(), permission: 'v2.capability.create_order_draft', role: 'admin', profileId: 'admin' }), host(db)), /ARGUMENTS_UNKNOWN_FIELD/);
  assert.throws(() => authorizeCapability(action('get_customer_context', customerArgs()), host(db, { permissions: [] })), /PERMISSION_DENIED/);
});

test('CAP-003 validates plain JSON arguments without invoking accessors', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed(); let calls = 0;
  const args = customerArgs() as Record<string, unknown>;
  Object.defineProperty(args, 'customerId', { enumerable: true, get: () => { calls += 1; return U; } });
  assert.throws(() => authorizeCapability(action('get_customer_context', args), host(db)), /ARGUMENTS_NOT_JSON/);
  assert.equal(calls, 0);
  const sparse = { ...customerArgs(), extra: undefined };
  assert.throws(() => authorizeCapability(action('get_customer_context', sparse), host(db)), /ARGUMENTS\.extra_NOT_JSON/);
});

test('CAP-003 binds the host account, conversation, and canonical customer', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  assert.throws(() => authorizeCapability(action('get_customer_context', { ...customerArgs(), accountId: 'other' }), host(db)), /ACCOUNT_OR_CONVERSATION_SCOPE/);
  assert.throws(() => authorizeCapability(action('get_customer_context', { ...customerArgs(), conversationId: 'missing' }), host(db)), /ACCOUNT_OR_CONVERSATION_SCOPE/);
  assert.throws(() => authorizeCapability(action('get_customer_context', { ...customerArgs(), customerId: 'other' }), host(db)), /CUSTOMER_SCOPE/);
  assert.throws(() => authorizeCapability(action('get_customer_context', customerArgs()), host(db, { customerId: 'other' })), /CUSTOMER_SCOPE/);
});

test('CAP-003 re-reads work-item and current draft ownership and revisions', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO work_items VALUES('w1',?,?,?,'SALES_ORDER_REQUEST','OPEN',3,'goal',NULL,NULL,NULL,NULL,NULL,datetime('now'),datetime('now'))").run(A, C, U);
  db.db.prepare("INSERT INTO order_drafts VALUES('d1','w1',?,?,?,'CURRENT',4,NULL,NULL,NULL,NULL,datetime('now'),datetime('now'))").run(A, C, U);
  db.db.prepare("INSERT INTO work_items VALUES('w2',?,?,?,'SALES_ORDER_REQUEST','OPEN',1,'other',NULL,NULL,NULL,NULL,NULL,datetime('now'),datetime('now'))").run('other-account', 'other-conversation', 'OTHER');
  db.db.prepare("INSERT INTO order_drafts VALUES('d2','w2',?,?,?,'CURRENT',1,NULL,NULL,NULL,NULL,datetime('now'),datetime('now'))").run(A, C, U);
  const args = { ...customerArgs(), workItemId: 'w1', draftId: 'd1', revision: 4, expectedWorkItemRevision: 3 };
  assert.throws(() => authorizeCapability(action('read_order_draft', { ...args, revision: 3 }), host(db)), /STALE_OR_MISSING_DRAFT_REVISION/);
  assert.throws(() => authorizeCapability(action('read_order_draft', { ...args, workItemId: 'missing' }), host(db)), /WORK_ITEM_SCOPE/);
  assert.throws(() => authorizeCapability(action('read_order_draft', { ...args, draftId: 'missing' }), host(db)), /DRAFT_SCOPE/);
  assert.throws(() => authorizeCapability(action('read_order_draft', { ...args, workItemId: 'w2', draftId: 'd2', expectedWorkItemRevision: 1, revision: 1 }), host(db)), /WORK_ITEM_SCOPE/);
  assert.throws(() => authorizeCapability(action('read_order_draft', { ...args, draftId: 'd2', expectedWorkItemRevision: 3, revision: 1 }), host(db)), /DRAFT_SCOPE/);
  const before = db.db.prepare('SELECT count(*) AS n FROM order_draft_revisions').get() as { n: number };
  const allowed = authorizeCapability(action('read_order_draft', args), host(db));
  assert.deepEqual(allowed.scope, { accountId: A, conversationId: C, customerId: U, workItemId: 'w1', draftId: 'd1' });
  assert.equal((db.db.prepare('SELECT count(*) AS n FROM order_draft_revisions').get() as { n: number }).n, before.n);
});

test('CAP-003 requires trusted host-envelope idempotency for mutation and never accepts model keys', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  const args = { ...customerArgs(), workItemId: 'w1', expectedWorkItemRevision: 1, lines: [] };
  db.db.prepare("INSERT INTO work_items VALUES('w1',?,?,?,'SALES_ORDER_REQUEST','OPEN',1,'goal',NULL,NULL,NULL,NULL,NULL,datetime('now'),datetime('now'))").run(A, C, U);
  assert.throws(() => authorizeCapability(action('create_order_draft', { ...args, idempotencyKey: 'model-key' }), host(db)), /ARGUMENTS_UNKNOWN_FIELD_idempotencyKey/);
  assert.throws(() => authorizeCapability(action('create_order_draft', args), host(db)), /IDEMPOTENCY_KEY_REQUIRED/);
  const envelope = authorizeCapability(action('create_order_draft', args), host(db, { idempotencyKey: 'host-key' }));
  assert.equal(envelope.idempotencyKey, 'host-key');
  assert.equal((db.db.prepare('SELECT count(*) AS n FROM order_drafts').get() as { n: number }).n, 0);
});

test('CAP-003 rejects blank trusted keys and profile identifiers without changing identity', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  const args = { ...customerArgs(), workItemId: 'w1', expectedWorkItemRevision: 1, lines: [] };
  db.db.prepare("INSERT INTO work_items VALUES('w1',?,?,?,'SALES_ORDER_REQUEST','OPEN',1,'goal',NULL,NULL,NULL,NULL,NULL,datetime('now'),datetime('now'))").run(A, C, U);
  assert.throws(() => authorizeCapability(action('create_order_draft', args), host(db, { idempotencyKey: '   ' })), /IDEMPOTENCY_KEY_REQUIRED/);
  assert.throws(() => authorizeCapability(action('create_order_draft', args), host(db, { profileId: ' \t' , idempotencyKey: 'host-key' })), /PROFILE_ID/);
  assert.throws(() => authorizeCapability(action('create_order_draft', args), host(db, { permissions: ['  '], idempotencyKey: 'host-key' })), /PROFILE_PERMISSIONS/);
  const envelope = authorizeCapability(action('create_order_draft', args), host(db, { idempotencyKey: '  host-key  ' }));
  assert.equal(envelope.idempotencyKey, '  host-key  ');
});

test('CAP-003 can positively authorize prepare_quotation with its registered revision contract', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO work_items VALUES('w1',?,?,?,'SALES_ORDER_REQUEST','OPEN',3,'goal',NULL,NULL,NULL,NULL,NULL,datetime('now'),datetime('now'))").run(A, C, U);
  db.db.prepare("INSERT INTO order_drafts VALUES('d1','w1',?,?,?,'CURRENT',4,NULL,NULL,NULL,NULL,datetime('now'),datetime('now'))").run(A, C, U);
  const result = authorizeCapability(action('prepare_quotation', { ...customerArgs(), workItemId: 'w1', draftId: 'd1', draftRevision: 4, expectedWorkItemRevision: 3 }), host(db, { permissions: ['v2.capability.prepare_quotation'], idempotencyKey: 'quote-key' }));
  assert.equal(result.capability.name, 'prepare_quotation');
  assert.equal(result.idempotencyKey, 'quote-key');
});

test('CAP-003 checks canonical quotation, acceptance, and inbound message scope', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,subtotal_cents,tax_cents,grand_total_cents,source_conversation_id,source_message_id) VALUES('q1','QT-1',?,'SENT','SGD',datetime('now'),date('now','+1 day'),0,0,0,?,?)").run(U, C, 'msg-1');
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,account_id,occurred_at) VALUES('msg-1',?,'ext-1','INBOUND','text',?,datetime('now'))").run(C, A);
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,account_id,occurred_at) VALUES('other-msg','other-conversation','other-ext','INBOUND','text',?,datetime('now'))").run(A);
  const base = { ...customerArgs(), quotationId: 'q1', acceptanceEvidenceId: 'a1' };
  assert.throws(() => authorizeCapability(action('record_customer_commitment', { ...customerArgs(), inboundMessageId: 'other-msg', commitment: 'ACCEPT' }), host(db, { permissions: ['v2.capability.record_customer_commitment'], idempotencyKey: 'k0' })), /INBOUND_MESSAGE_SCOPE/);
  assert.throws(() => authorizeCapability(action('create_sales_order_draft', base), host(db, { permissions: ['v2.capability.create_sales_order_draft'], idempotencyKey: 'k' })), /ACCEPTANCE_SCOPE/);
  db.db.prepare("INSERT INTO quotation_acceptances VALUES('a1','q1','msg-1','sender',datetime('now'),'{}')").run();
  const ok = authorizeCapability(action('create_sales_order_draft', base), host(db, { permissions: ['v2.capability.create_sales_order_draft'], idempotencyKey: 'k' }));
  assert.equal(ok.capability.name, 'create_sales_order_draft');
});
