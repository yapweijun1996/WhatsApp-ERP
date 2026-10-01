/**
 * Tests for the ProspectModelCaller factory and Demo Gateway wiring.
 *
 * Covers:
 * - createProspectModelCaller wraps DemoGatewaySession.completeWithSystem
 * - bounded system instruction is passed (no ERP/customer/order scope)
 * - message text forwarded correctly (truncated at 2000 chars)
 * - errors propagate so ProspectSemanticRouter can fail-closed
 * - app wiring: NORMAL prospect gets AI reply when factory is wired in V2CanaryIngressRouter
 * - absent factory → static onboarding fallback (no model call)
 * - SUSPICIOUS/COOLDOWN/BLOCKED: zero model calls regardless of factory presence
 * - no implicit CUST-001 binding regression
 * - verified-customer path unaffected by prospectModel presence
 * - authority ceiling (SALES_ORDER.DRAFT) unchanged
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProspectModelCaller, PROSPECT_SYSTEM_INSTRUCTION } from '../src/v2-prospect-model-caller.js';
import { V1Database } from '../src/database.js';
import { CommerceService } from '../src/commerce.js';
import { V2RolloutService } from '../src/v2-rollout.js';
import { V2CanaryIngressRouter } from '../src/v2-canary-ingress-router.js';
import { PROSPECT_ONBOARDING_REPLY } from '../src/v2-inbound-abuse-guard.js';
import type { IncomingChannelMessage } from '../src/channel-contract.js';
import type { DemoGatewaySession } from '../src/gateway.js';

// Explicit synthetic prospect reply authorization; never used in real runtime.
const TEST_PROSPECT_SCOPES=["conv-001", "conv-factory-absent", "conv-factory-blocked", "conv-factory-cooldown", "conv-factory-err", "conv-factory-normal", "conv-factory-sus", "conv-no-binding", "conv-prospect-factory-ext"].map(externalConversationId=>({accountId:"demo-account",externalConversationId}));

function makeMsg(override: Partial<IncomingChannelMessage> = {}): IncomingChannelMessage {
  return {
    accountId: 'demo-account',
    conversationId: 'conv-prospect-factory-ext',
    externalMessageId: `msg-f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel: 'whatsapp',
    occurredAt: new Date().toISOString(),
    type: 'text',
    text: 'Hello',
    sender: { externalId: '+65PROSP001', phone: '+65PROSP001' },
    ...override,
  };
}

function makeSession(completeWithSystem: DemoGatewaySession['completeWithSystem']): DemoGatewaySession {
  return { completeWithSystem } as unknown as DemoGatewaySession;
}

// ── Factory unit tests ──────────────────────────────────────────────────────

test('createProspectModelCaller calls completeWithSystem with the bounded system instruction', async () => {
  let capturedSystem: string | undefined;
  let capturedUser: string | undefined;

  const session = makeSession(async (system, user) => {
    capturedSystem = system;
    capturedUser = user;
    return { text: 'Welcome! We distribute poultry products.' };
  });

  const caller = createProspectModelCaller(session);
  const result = await caller('What do you sell?');

  assert.equal(result, 'Welcome! We distribute poultry products.');
  assert.equal(capturedUser, 'What do you sell?');
  // System instruction must be the exported constant (no runtime mutation)
  assert.equal(capturedSystem, PROSPECT_SYSTEM_INSTRUCTION);
});

test('PROSPECT_SYSTEM_INSTRUCTION explicitly forbids ERP access and customer binding', () => {
  // Structural check: the instruction contains the key restrictions
  assert.match(PROSPECT_SYSTEM_INSTRUCTION, /NEVER.*bind|NEVER.*account|NEVER.*ERP/i);
  assert.match(PROSPECT_SYSTEM_INSTRUCTION, /NEVER.*order/i);
  assert.match(PROSPECT_SYSTEM_INSTRUCTION, /NEVER.*price|NEVER.*pricing/i);
  assert.match(PROSPECT_SYSTEM_INSTRUCTION, /chain.of.thought|reasoning step/i);
});

test('caller truncates message text to 2000 characters before forwarding to session', async () => {
  let capturedUser: string | undefined;
  const session = makeSession(async (_, user) => {
    capturedUser = user;
    return { text: 'reply' };
  });

  const longMsg = 'a'.repeat(3000);
  const caller = createProspectModelCaller(session);
  await caller(longMsg);

  assert.equal(capturedUser?.length, 2000);
});

test('short message text is passed unmodified', async () => {
  let capturedUser: string | undefined;
  const session = makeSession(async (_, user) => {
    capturedUser = user;
    return { text: 'reply' };
  });

  const caller = createProspectModelCaller(session);
  await caller('Short question?');

  assert.equal(capturedUser, 'Short question?');
});

test('error from completeWithSystem propagates so ProspectSemanticRouter can fail-closed', async () => {
  const session = makeSession(async () => {
    throw new Error('DEMO_GPT_QUOTA_EXCEEDED');
  });

  const caller = createProspectModelCaller(session);
  await assert.rejects(() => caller('hello'), /DEMO_GPT_QUOTA_EXCEEDED/);
});

test('AbortSignal is forwarded to completeWithSystem', async () => {
  let capturedSignal: AbortSignal | undefined;
  const session = makeSession(async (_, __, signal) => {
    capturedSignal = signal;
    return { text: 'ok' };
  });

  const controller = new AbortController();
  const caller = createProspectModelCaller(session);
  await caller('hello', controller.signal);
  assert.equal(capturedSignal, controller.signal);
});

// ── Integration: factory wired into V2CanaryIngressRouter ──────────────────

test('NORMAL prospect with factory-backed prospectModel receives AI reply', async () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const commerce = new CommerceService(db);
  const rollout = new V2RolloutService(db);
  let sentText: string | undefined;
  let sessionCallCount = 0;

  const session = makeSession(async () => {
    sessionCallCount++;
    return { text: 'We sell fresh and frozen poultry. How can we help?' };
  });
  const prospectModel = createProspectModelCaller(session);

  const router = new V2CanaryIngressRouter(db, commerce, rollout, {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    allowLegacyFallback: true,
    outbound: { send: async (msg: any) => { sentText = msg.text; return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};} } as any,
    prospectModel,
  });

  const convId = 'conv-factory-normal';
  db.db.prepare(
    "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
  ).run(convId, 'demo-account', convId);

  const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-factory-normal-01', text: 'What do you sell?' });
  const canonical = router.canonicalize(msg);
  const result = await router.receiveCanonical(canonical!) as any;

  assert.equal(result.status, 'PROSPECT_HANDLED');
  assert.equal(result.abuseState, 'NORMAL');
  assert.equal(sessionCallCount, 1);
  assert.equal(sentText, 'We sell fresh and frozen poultry. How can we help?');
  assert.notEqual(sentText, PROSPECT_ONBOARDING_REPLY);
  // Audit records AI routing
  const audit = db.db.prepare(
    'SELECT route_outcome FROM inbound_route_audit WHERE account_id=? AND external_message_id=?'
  ).get('demo-account', msg.externalMessageId) as any;
  assert.equal(audit.route_outcome, 'PROSPECT_AI_ROUTED');
});

test('absent prospectModel (demoSession unavailable) falls back to static onboarding reply', async () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const commerce = new CommerceService(db);
  const rollout = new V2RolloutService(db);
  let sentText: string | undefined;

  // No prospectModel = demoSession was undefined (demo gateway not configured)
  const router = new V2CanaryIngressRouter(db, commerce, rollout, {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    allowLegacyFallback: true,
    outbound: { send: async (msg: any) => { sentText = msg.text; return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};} } as any,
    // prospectModel intentionally omitted
  });

  const convId = 'conv-factory-absent';
  db.db.prepare(
    "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
  ).run(convId, 'demo-account', convId);

  const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-factory-absent-01' });
  const canonical = router.canonicalize(msg);
  const result = await router.receiveCanonical(canonical!) as any;

  assert.equal(result.status, 'PROSPECT_HANDLED');
  assert.equal(sentText, PROSPECT_ONBOARDING_REPLY);
  // Inbound still persisted despite no model
  const persisted = db.db.prepare('SELECT 1 FROM messages WHERE account_id=? AND external_message_id=?').get('demo-account', msg.externalMessageId);
  assert.ok(persisted !== undefined);
});

test('session error causes ProspectSemanticRouter to fail-closed to onboarding reply', async () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const commerce = new CommerceService(db);
  const rollout = new V2RolloutService(db);
  let sentText: string | undefined;

  const session = makeSession(async () => { throw new Error('DEMO_GPT_NETWORK_ERROR'); });
  const prospectModel = createProspectModelCaller(session);

  const router = new V2CanaryIngressRouter(db, commerce, rollout, {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    allowLegacyFallback: true,
    outbound: { send: async (msg: any) => { sentText = msg.text; return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};} } as any,
    prospectModel,
  });

  const convId = 'conv-factory-err';
  db.db.prepare(
    "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
  ).run(convId, 'demo-account', convId);

  const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-factory-err-01' });
  const canonical = router.canonicalize(msg);
  const result = await router.receiveCanonical(canonical!) as any;

  assert.equal(result.status, 'PROSPECT_HANDLED');
  assert.equal(sentText, PROSPECT_ONBOARDING_REPLY);
  // Message persisted even on model failure
  const persisted = db.db.prepare('SELECT 1 FROM messages WHERE account_id=? AND external_message_id=?').get('demo-account', msg.externalMessageId);
  assert.ok(persisted !== undefined);
});

// ── SUSPICIOUS/COOLDOWN/BLOCKED: zero model calls ──────────────────────────

function insertMessages(db: V1Database, senderId: string, count: number, nowMs: number) {
  for (let i = 0; i < count; i++) {
    db.db.prepare(
      `INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,
       sender_external_id,sender_phone,account_id,occurred_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      `msg-gate-${senderId}-${i}`, 'conv-001', `ext-gate-${senderId}-${i}`, 'INBOUND', 'text', 'hi',
      senderId, senderId, 'demo-account',
      new Date(nowMs - (count - i) * 1000).toISOString()
    );
  }
}

test('SUSPICIOUS state: factory-backed prospectModel is NOT called (zero model calls)', async () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const commerce = new CommerceService(db);
  const rollout = new V2RolloutService(db);
  let sessionCallCount = 0;

  const session = makeSession(async () => { sessionCallCount++; return { text: 'should not appear' }; });
  const prospectModel = createProspectModelCaller(session);

  const router = new V2CanaryIngressRouter(db, commerce, rollout, {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    allowLegacyFallback: true,
    outbound: { send: async () => {return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};} } as any,
    prospectModel,
  });

  const senderId = '+65SUS-FACTORY';
  insertMessages(db, senderId, 5, Date.now());

  const convId = 'conv-factory-sus';
  db.db.prepare(
    "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
  ).run(convId, 'demo-account', convId);

  const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-factory-sus-01', sender: { externalId: senderId, phone: senderId } });
  const canonical = router.canonicalize(msg);
  const result = await router.receiveCanonical(canonical!) as any;
  assert.equal(result.abuseState, 'SUSPICIOUS');
  assert.equal(sessionCallCount, 0);
});

test('COOLDOWN state: factory-backed prospectModel is NOT called', async () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const commerce = new CommerceService(db);
  const rollout = new V2RolloutService(db);
  let sessionCallCount = 0;

  const session = makeSession(async () => { sessionCallCount++; return { text: 'should not appear' }; });
  const router = new V2CanaryIngressRouter(db, commerce, rollout, {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    allowLegacyFallback: true,
    outbound: { send: async () => {return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};} } as any,
    prospectModel: createProspectModelCaller(session),
  });

  const senderId = '+65COOLDOWN-FACTORY';
  insertMessages(db, senderId, 10, Date.now());

  const convId = 'conv-factory-cooldown';
  db.db.prepare(
    "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
  ).run(convId, 'demo-account', convId);

  const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-factory-cooldown-01', sender: { externalId: senderId, phone: senderId } });
  const result = await router.receiveCanonical(router.canonicalize(msg)!) as any;
  assert.equal(result.abuseState, 'COOLDOWN');
  assert.equal(sessionCallCount, 0);
});

test('BLOCKED state: factory-backed prospectModel is NOT called', async () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const commerce = new CommerceService(db);
  const rollout = new V2RolloutService(db);
  let sessionCallCount = 0;

  const session = makeSession(async () => { sessionCallCount++; return { text: 'should not appear' }; });
  const router = new V2CanaryIngressRouter(db, commerce, rollout, {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    allowLegacyFallback: true,
    outbound: { send: async () => {return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};} } as any,
    prospectModel: createProspectModelCaller(session),
  });

  const senderId = '+65BLOCKED-FACTORY';
  insertMessages(db, senderId, 20, Date.now());

  const convId = 'conv-factory-blocked';
  db.db.prepare(
    "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
  ).run(convId, 'demo-account', convId);

  const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-factory-blocked-01', sender: { externalId: senderId, phone: senderId } });
  const result = await router.receiveCanonical(router.canonicalize(msg)!) as any;
  assert.equal(result.abuseState, 'BLOCKED');
  assert.equal(sessionCallCount, 0);
});

// ── CUST-001 binding regression ────────────────────────────────────────────

test('NORMAL prospect with prospectModel is NOT bound to CUST-001 or any customer', async () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const commerce = new CommerceService(db);
  const rollout = new V2RolloutService(db);

  const session = makeSession(async () => ({ text: 'We can help! Please share your contact details.' }));
  const router = new V2CanaryIngressRouter(db, commerce, rollout, {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    allowLegacyFallback: true,
    outbound: { send: async () => {return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};} } as any,
    prospectModel: createProspectModelCaller(session),
  });

  const senderExternalId = '+65NEW-PROSPECT';
  const convId = 'conv-no-binding';
  db.db.prepare(
    "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
  ).run(convId, 'demo-account', convId);

  const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-no-binding-01', sender: { externalId: senderExternalId, phone: senderExternalId }, text: 'I want to place an order' });
  const canonical = router.canonicalize(msg);
  await router.receiveCanonical(canonical!);

  // No customer_channel_identities row created
  const binding = db.db.prepare(
    'SELECT * FROM customer_channel_identities WHERE external_id=?'
  ).get(senderExternalId) as any;
  assert.equal(binding, undefined);
  // Specifically not bound to CUST-001
  const cust001 = db.db.prepare(
    "SELECT * FROM customer_channel_identities WHERE customer_id='CUST-001' AND external_id=?"
  ).get(senderExternalId) as any;
  assert.equal(cust001, undefined);
});

// ── Verified-customer path unaffected ─────────────────────────────────────

test('verified customer (CUST-001) canonicalize is unaffected by prospectModel presence', () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const commerce = new CommerceService(db);
  const rollout = new V2RolloutService(db);

  const session = makeSession(async () => ({ text: 'should never be called for verified customer' }));
  const router = new V2CanaryIngressRouter(db, commerce, rollout, {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    allowLegacyFallback: true,
    outbound: { send: async () => {return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};} } as any,
    prospectModel: createProspectModelCaller(session),
  });

  // identity-001 maps +6591110001 → CUST-001 in seed
  const msg = makeMsg({
    conversationId: 'conv-001',
    sender: { externalId: '+6591110001', phone: '+6591110001' },
  });
  const canonical = router.canonicalize(msg);
  assert.notEqual(canonical, null);
  assert.equal(canonical!.customerId, 'CUST-001');
  assert.equal(canonical!.identityState, 'VERIFIED_CUSTOMER');
});

// ── Authority ceiling unchanged ────────────────────────────────────────────

test('PROSPECT_HANDLED result never contains sales order data regardless of prospectModel', async () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const commerce = new CommerceService(db);
  const rollout = new V2RolloutService(db);

  const session = makeSession(async () => ({ text: 'Helpful business reply.' }));
  const router = new V2CanaryIngressRouter(db, commerce, rollout, {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    allowLegacyFallback: true,
    outbound: { send: async () => {return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};} } as any,
    prospectModel: createProspectModelCaller(session),
  });

  const msg = makeMsg();
  const canonical = router.canonicalize(msg);
  const result = await router.receiveCanonical(canonical!) as any;

  assert.equal(result.status, 'PROSPECT_HANDLED');
  // Ceiling invariant: no order data reachable from prospect path
  assert.equal(result.draft, undefined);
  assert.equal(result.order, undefined);
  assert.equal(result.salesOrder, undefined);
  assert.equal(result.quotation, undefined);
});

// ── App wiring: prospectModel set when demoSession available ───────────────

test('createProspectModelCaller is non-undefined when DemoGatewaySession is present', () => {
  // Verify the factory returns a function (not undefined) when a session is supplied.
  // This mirrors the condition in app.ts:
  //   const prospectModel = demoSession ? createProspectModelCaller(demoSession) : undefined;
  const session = makeSession(async () => ({ text: 'ok' }));
  const prospectModel = createProspectModelCaller(session);
  assert.equal(typeof prospectModel, 'function');
});
