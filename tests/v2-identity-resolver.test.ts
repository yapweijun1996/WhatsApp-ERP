/**
 * Focused tests for the evidence-based identity resolver and prospect inbound path.
 * Covers: unknown/prospect persistence, verified flow, access control, abuse guard,
 * prospect AI routing bypass, and authority ceiling invariants.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { IdentityResolver } from '../src/v2-identity-resolver.js';
import { InboundAbuseGuard, PROSPECT_ABUSE_REPLIES, PROSPECT_ONBOARDING_REPLY, PROSPECT_SUSPICIOUS_REPLY } from '../src/v2-inbound-abuse-guard.js';
import { V2CanaryIngressRouter } from '../src/v2-canary-ingress-router.js';
import { CommerceService } from '../src/commerce.js';
import { V2RolloutService } from '../src/v2-rollout.js';
import type { IncomingChannelMessage } from '../src/channel-contract.js';
import type { ProspectModelCaller } from '../src/v2-prospect-semantic-router.js';

// Explicit synthetic prospect reply authorization; never used in real runtime.
const TEST_PROSPECT_SCOPES=["conv-001", "conv-blocked-test", "conv-cooldown-test", "conv-prospect-ai", "conv-prospect-erp-isolation", "conv-prospect-failclosed", "conv-prospect-no-model", "conv-suspicious-audit", "conv-suspicious-test", "unknown-conv-ext-001"].map(externalConversationId=>({accountId:"demo-account",externalConversationId}));

function makeMsg(override: Partial<IncomingChannelMessage> = {}): IncomingChannelMessage {
  return {
    accountId: 'demo-account',
    conversationId: 'unknown-conv-ext-001',
    externalMessageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel: 'whatsapp',
    occurredAt: new Date().toISOString(),
    type: 'text',
    text: 'Hello',
    sender: { externalId: '+65UNKNOWN001', phone: '+65UNKNOWN001', displayName: 'Unknown Sender' },
    ...override,
  };
}

describe('IdentityResolver — unknown/prospect persistence', () => {
  let db: V1Database;
  let resolver: IdentityResolver;

  beforeEach(() => {
    db = new V1Database(':memory:');
    db.resetAndSeed();
    resolver = new IdentityResolver(db.db);
  });

  it('first contact persisted as UNKNOWN, not bound to any customer', () => {
    const msg = makeMsg();
    const result = resolver.resolve(msg);
    assert.equal(result.identityState, 'UNKNOWN');
    assert.equal(result.customerId, null);
    assert.notEqual(result.prospectId, null);

    const row = db.db.prepare(
      'SELECT * FROM prospect_identities WHERE channel_account_id=? AND external_id=?'
    ).get('demo-account', '+65UNKNOWN001') as any;
    assert.ok(row !== undefined);
    assert.equal(row.channel, 'whatsapp');
    assert.equal(row.message_count, 1);
  });

  it('unknown sender is NOT bound to CUST-001 or any default customer', () => {
    const msg = makeMsg();
    resolver.resolve(msg);

    const binding = db.db.prepare(
      'SELECT * FROM customer_channel_identities WHERE external_id=?'
    ).get('+65UNKNOWN001') as any;
    assert.equal(binding, undefined);
  });

  it('second message from same sender → PROSPECT state, message_count incremented', () => {
    const msg1 = makeMsg({ externalMessageId: 'msg-first' });
    const result1 = resolver.resolve(msg1);
    assert.equal(result1.identityState, 'UNKNOWN');

    const msg2 = makeMsg({ externalMessageId: 'msg-second' });
    const result2 = resolver.resolve(msg2);
    assert.equal(result2.identityState, 'PROSPECT');
    assert.equal(result2.customerId, null);
    assert.equal(result2.prospectId, result1.prospectId);

    const row = db.db.prepare(
      'SELECT message_count FROM prospect_identities WHERE channel_account_id=? AND external_id=?'
    ).get('demo-account', '+65UNKNOWN001') as any;
    assert.equal(row.message_count, 2);
  });

  it('env-var phone match commits VERIFIED_CUSTOMER binding when BOTH env vars are set', () => {
    const originalPhone = process.env.WHATSAPP_QR_CUSTOMER_PHONE;
    const originalId = process.env.WHATSAPP_QR_CUSTOMER_ID;
    try {
      process.env.WHATSAPP_QR_CUSTOMER_PHONE = '+6591110001';
      process.env.WHATSAPP_QR_CUSTOMER_ID = 'CUST-001';
      const msg = makeMsg({ sender: { externalId: '+6591110001', phone: '+6591110001' } });
      const result = resolver.resolve(msg);
      assert.equal(result.identityState, 'VERIFIED_CUSTOMER');
      assert.equal(result.customerId, 'CUST-001');
      assert.equal(result.prospectId, null);
    } finally {
      if (originalPhone !== undefined) process.env.WHATSAPP_QR_CUSTOMER_PHONE = originalPhone;
      else delete process.env.WHATSAPP_QR_CUSTOMER_PHONE;
      if (originalId !== undefined) process.env.WHATSAPP_QR_CUSTOMER_ID = originalId;
      else delete process.env.WHATSAPP_QR_CUSTOMER_ID;
    }
  });

  it('P1: phone match without WHATSAPP_QR_CUSTOMER_ID does NOT bind to CUST-001 or any default customer', () => {
    const originalPhone = process.env.WHATSAPP_QR_CUSTOMER_PHONE;
    const originalId = process.env.WHATSAPP_QR_CUSTOMER_ID;
    try {
      process.env.WHATSAPP_QR_CUSTOMER_PHONE = '+6591110002';
      delete process.env.WHATSAPP_QR_CUSTOMER_ID;
      const msg = makeMsg({ sender: { externalId: '+6591110002', phone: '+6591110002' } });
      const result = resolver.resolve(msg);
      // Missing WHATSAPP_QR_CUSTOMER_ID must never imply CUST-001 or any default
      assert.notEqual(result.identityState, 'VERIFIED_CUSTOMER');
      assert.equal(result.customerId, null);
      // No customer_channel_identities row created
      const binding = db.db.prepare(
        'SELECT * FROM customer_channel_identities WHERE external_id=?'
      ).get('+6591110002') as any;
      assert.equal(binding, undefined);
    } finally {
      if (originalPhone !== undefined) process.env.WHATSAPP_QR_CUSTOMER_PHONE = originalPhone;
      else delete process.env.WHATSAPP_QR_CUSTOMER_PHONE;
      if (originalId !== undefined) process.env.WHATSAPP_QR_CUSTOMER_ID = originalId;
      else delete process.env.WHATSAPP_QR_CUSTOMER_ID;
    }
  });

  it('existing customer_channel_identities binding resolves VERIFIED_CUSTOMER without env vars', () => {
    // identity-001 maps +6591110001 → CUST-001 in seed
    const msg = makeMsg({ sender: { externalId: '+6591110001', phone: '+6591110001' } });
    const result = resolver.resolve(msg);
    assert.equal(result.identityState, 'VERIFIED_CUSTOMER');
    assert.equal(result.customerId, 'CUST-001');
  });

  it('ambiguous sender with no binding stays UNKNOWN, never promoted without evidence', () => {
    const msg = makeMsg({ sender: { externalId: '+65AMBIGUOUS', phone: '+65AMBIGUOUS' } });
    for (let i = 0; i < 3; i++) {
      const result = resolver.resolve({ ...msg, externalMessageId: `msg-amb-${i}` });
      assert.equal(result.customerId, null);
      assert.ok(['UNKNOWN', 'PROSPECT'].includes(result.identityState));
    }
    const binding = db.db.prepare(
      'SELECT * FROM customer_channel_identities WHERE external_id=?'
    ).get('+65AMBIGUOUS') as any;
    assert.equal(binding, undefined);
  });
});

describe('Access control — PROSPECT cannot access ERP or workspace', () => {
  let db: V1Database;
  let router: V2CanaryIngressRouter;

  beforeEach(() => {
    db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async () => {} } as any,
    });
  });

  it('prospect canonicalize returns non-null canonical with null customerId', () => {
    const msg = makeMsg();
    const canonical = router.canonicalize(msg);
    assert.notEqual(canonical, null);
    assert.equal(canonical!.customerId, null);
  });

  it('receiveCanonical for prospect returns PROSPECT_HANDLED, not workspace state', async () => {
    const msg = makeMsg();
    const canonical = router.canonicalize(msg);
    const result = await router.receiveCanonical(canonical!) as any;
    assert.equal(result.status, 'PROSPECT_HANDLED');
    // Must not return commerce workspace state (which would have salesOrder or similar keys)
    assert.equal(result.salesOrder, undefined);
    assert.equal(result.quotation, undefined);
  });

  it('prospect cannot reach V2 agent queue (no v2_inbox_items row created)', async () => {
    const msg = makeMsg();
    const canonical = router.canonicalize(msg);
    await router.receiveCanonical(canonical!);
    const queued = db.db.prepare(
      'SELECT COUNT(*) AS n FROM v2_inbox_items WHERE account_id=?'
    ).get('demo-account') as any;
    assert.equal(queued.n, 0);
  });

  it('prospect route audit recorded', async () => {
    const msg = makeMsg();
    const canonical = router.canonicalize(msg);
    await router.receiveCanonical(canonical!);
    const audit = db.db.prepare(
      'SELECT * FROM inbound_route_audit WHERE account_id=? AND external_message_id=?'
    ).get('demo-account', msg.externalMessageId) as any;
    assert.ok(audit !== undefined);
    assert.ok(['UNKNOWN', 'PROSPECT'].includes(audit.identity_state));
    // No prospectModel is wired here, so the fallback records why it fell back.
    assert.equal(audit.route_outcome, 'PROSPECT_AI_FALLBACK_MODEL_UNAVAILABLE');
  });
});

describe('Abuse guard — zero-model path', () => {
  let db: V1Database;
  let guard: InboundAbuseGuard;

  beforeEach(() => {
    db = new V1Database(':memory:');
    db.resetAndSeed();
    guard = new InboundAbuseGuard(db.db);
  });

  it('first message is NORMAL (no model call needed)', () => {
    const result = guard.evaluate('demo-account', '+65SPAM001', new Date().toISOString());
    assert.equal(result.state, 'NORMAL');
    assert.equal(result.messageCountInWindow, 0);
  });

  it('COOLDOWN threshold: 10+ messages → fixed reply, no model', () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      db.db.prepare(
        `INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,
         sender_external_id,sender_phone,account_id,occurred_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `msg-spam-${i}`, 'conv-001', `ext-spam-${i}`, 'INBOUND', 'text', 'hi',
        '+65SPAM001', '+65SPAM001', 'demo-account',
        new Date(now - (10 - i) * 1000).toISOString()
      );
    }
    const result = guard.evaluate('demo-account', '+65SPAM001', new Date(now).toISOString());
    assert.equal(result.state, 'COOLDOWN');
    assert.ok(PROSPECT_ABUSE_REPLIES.COOLDOWN.length > 0);
  });

  it('BLOCKED threshold: 20+ messages → fixed reply', () => {
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      db.db.prepare(
        `INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,
         sender_external_id,sender_phone,account_id,occurred_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `msg-block-${i}`, 'conv-001', `ext-block-${i}`, 'INBOUND', 'text', 'hi',
        '+65BLOCK001', '+65BLOCK001', 'demo-account',
        new Date(now - (20 - i) * 1000).toISOString()
      );
    }
    const result = guard.evaluate('demo-account', '+65BLOCK001', new Date(now).toISOString());
    assert.equal(result.state, 'BLOCKED');
    assert.ok(PROSPECT_ABUSE_REPLIES.BLOCKED.length > 0);
  });

  it('messages outside 60s window do not count', () => {
    const now = Date.now();
    for (let i = 0; i < 15; i++) {
      db.db.prepare(
        `INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,
         sender_external_id,sender_phone,account_id,occurred_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `msg-old-${i}`, 'conv-001', `ext-old-${i}`, 'INBOUND', 'text', 'hi',
        '+65OLD001', '+65OLD001', 'demo-account',
        new Date(now - 90000 - i * 1000).toISOString()
      );
    }
    const result = guard.evaluate('demo-account', '+65OLD001', new Date(now).toISOString());
    assert.equal(result.state, 'NORMAL');
  });

  it('COOLDOWN/BLOCKED → handleProspect returns fixed reply info in audit, no agent turn', async () => {
    const db2 = new V1Database(':memory:');
    db2.resetAndSeed();
    const commerce = new CommerceService(db2);
    const rollout = new V2RolloutService(db2);
    let sentReply: string | undefined;
    const router = new V2CanaryIngressRouter(db2, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async (msg: any) => { sentReply = msg.text; } } as any,
    });

    const senderExternalId = '+65SPAMROUTER';
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      db2.db.prepare(
        `INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,
         sender_external_id,sender_phone,account_id,occurred_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `msg-pre-${i}`, 'conv-001', `ext-pre-${i}`, 'INBOUND', 'text', 'hi',
        senderExternalId, senderExternalId, 'demo-account',
        new Date(now - (10 - i) * 1000).toISOString()
      );
    }

    const msg = makeMsg({ sender: { externalId: senderExternalId, phone: senderExternalId }, externalMessageId: `msg-abuse-trigger` });
    const canonical = router.canonicalize(msg);
    const result = await router.receiveCanonical(canonical!) as any;
    assert.equal(result.status, 'PROSPECT_HANDLED');
    assert.equal(result.abuseState, 'COOLDOWN');
    assert.equal(sentReply, PROSPECT_ABUSE_REPLIES.COOLDOWN);

    const turns = db2.db.prepare('SELECT COUNT(*) AS n FROM agent_turns').get() as any;
    assert.equal(turns.n, 0);
  });
});

describe('Verified customer flow regression', () => {
  let db: V1Database;
  let router: V2CanaryIngressRouter;

  beforeEach(() => {
    db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async () => {} } as any,
    });
  });

  it('seeded identity-001 (+6591110001) canonicalizes to VERIFIED_CUSTOMER with CUST-001', () => {
    const msg = makeMsg({
      conversationId: 'conv-001',
      sender: { externalId: '+6591110001', phone: '+6591110001' },
    });
    const canonical = router.canonicalize(msg);
    assert.notEqual(canonical, null);
    assert.equal(canonical!.customerId, 'CUST-001');
    assert.equal(canonical!.identityState, 'VERIFIED_CUSTOMER');
  });

  it('prospect sender does not pollute customer conversation (IDENTITY_CONFLICT guard)', () => {
    const msg = makeMsg({
      conversationId: 'conv-001',
      sender: { externalId: '+65STRANGER', phone: '+65STRANGER' },
    });
    assert.throws(() => router.canonicalize(msg), /V2_CANONICAL_IDENTITY_CONFLICT/);
  });
});

describe('SALES_ORDER.DRAFT ceiling — authority unchanged for prospects', () => {
  it('PROSPECT_HANDLED result never carries sales order data', async () => {
    const db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    const router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async () => {} } as any,
    });
    const msg = makeMsg();
    const canonical = router.canonicalize(msg);
    const result = await router.receiveCanonical(canonical!) as any;
    assert.equal(result.status, 'PROSPECT_HANDLED');
    assert.equal(result.draft, undefined);
    assert.equal(result.order, undefined);
    assert.equal(result.salesOrder, undefined);
  });

  it('P0: NORMAL prospect with no prospectModel falls back to static onboarding reply', async () => {
    const db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    let sentText: string | undefined;
    const router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async (msg: any) => { sentText = msg.text; } } as any,
      // No prospectModel configured — must fail closed to static onboarding
    });

    const convId = 'conv-prospect-no-model';
    db.db.prepare(
      "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
    ).run(convId, 'demo-account', convId);

    const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-no-model-01' });
    const canonical = router.canonicalize(msg);
    const result = await router.receiveCanonical(canonical!) as any;
    assert.equal(result.status, 'PROSPECT_HANDLED');
    assert.equal(result.abuseState, 'NORMAL');
    assert.equal(sentText, PROSPECT_ONBOARDING_REPLY);
  });

  it('P0: NORMAL prospect with prospectModel invokes AI routing seam and sends AI reply', async () => {
    const db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    let sentText: string | undefined;
    let modelCallCount = 0;
    const AI_REPLY = 'Hello! I can help you with product information. What are you looking for?';
    const prospectModel: ProspectModelCaller = async (_msg) => {
      modelCallCount++;
      return AI_REPLY;
    };
    const router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async (msg: any) => { sentText = msg.text; } } as any,
      prospectModel,
    });

    const convId = 'conv-prospect-ai';
    db.db.prepare(
      "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
    ).run(convId, 'demo-account', convId);

    const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-ai-route-01', text: 'What products do you sell?' });
    const canonical = router.canonicalize(msg);
    const result = await router.receiveCanonical(canonical!) as any;
    assert.equal(result.status, 'PROSPECT_HANDLED');
    assert.equal(result.abuseState, 'NORMAL');
    assert.notEqual(sentText, PROSPECT_ONBOARDING_REPLY);
    assert.equal(sentText, AI_REPLY);
    assert.equal(modelCallCount, 1);
    const audit = db.db.prepare(
      'SELECT route_outcome FROM inbound_route_audit WHERE account_id=? AND external_message_id=?'
    ).get('demo-account', msg.externalMessageId) as any;
    assert.equal(audit.route_outcome, 'PROSPECT_AI_ROUTED');
  });

  it('P0: AI prospect routing cannot access ERP capability executor', async () => {
    const db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    const erpCalls: string[] = [];
    const prospectModel: ProspectModelCaller = async (_messageText) => {
      return 'Thank you for your enquiry. How can I help?';
    };
    const originalExecute = (commerce as any).execute;
    (commerce as any).execute = (...args: any[]) => {
      erpCalls.push(String(args[0]));
      return originalExecute?.apply(commerce, args);
    };
    const router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async () => {} } as any,
      prospectModel,
    });

    const convId = 'conv-prospect-erp-isolation';
    db.db.prepare(
      "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
    ).run(convId, 'demo-account', convId);

    const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-erp-isolation-01', text: 'Show me customer orders' });
    const canonical = router.canonicalize(msg);
    await router.receiveCanonical(canonical!);
    assert.equal(erpCalls.length, 0);
  });

  it('P0: AI routing fails closed to onboarding reply when prospectModel throws', async () => {
    const db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    let sentText: string | undefined;
    const prospectModel: ProspectModelCaller = async () => {
      throw new Error('MODEL_UNAVAILABLE');
    };
    const router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async (msg: any) => { sentText = msg.text; } } as any,
      prospectModel,
    });

    const convId = 'conv-prospect-failclosed';
    db.db.prepare(
      "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
    ).run(convId, 'demo-account', convId);

    const msg = makeMsg({ conversationId: convId, externalMessageId: 'msg-failclosed-01' });
    const canonical = router.canonicalize(msg);
    const result = await router.receiveCanonical(canonical!) as any;
    assert.equal(result.status, 'PROSPECT_HANDLED');
    assert.equal(sentText, PROSPECT_ONBOARDING_REPLY);
    const persisted = db.db.prepare(
      'SELECT 1 FROM messages WHERE account_id=? AND external_message_id=?'
    ).get('demo-account', msg.externalMessageId);
    assert.ok(persisted !== undefined);
  });
});

describe('P2: SUSPICIOUS prospect explicit bounded behavior', () => {
  function insertMessages(db: V1Database, senderId: string, count: number, nowMs: number) {
    for (let i = 0; i < count; i++) {
      db.db.prepare(
        `INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,
         sender_external_id,sender_phone,account_id,occurred_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `msg-sus-${i}`, 'conv-001', `ext-sus-${i}`, 'INBOUND', 'text', 'hi',
        senderId, senderId, 'demo-account',
        new Date(nowMs - (count - i) * 1000).toISOString()
      );
    }
  }

  it('SUSPICIOUS state sends explicit warning reply (not NORMAL onboarding, not abuse replies)', async () => {
    const db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    let sentText: string | undefined;
    let modelCallCount = 0;
    const prospectModel: ProspectModelCaller = async () => {
      modelCallCount++;
      return 'AI reply';
    };
    const router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async (msg: any) => { sentText = msg.text; } } as any,
      prospectModel,
    });

    const senderExternalId = '+65SUSPICIOUS001';
    const now = Date.now();
    insertMessages(db, senderExternalId, 5, now);

    const convId = 'conv-suspicious-test';
    db.db.prepare(
      "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
    ).run(convId, 'demo-account', convId);

    const msg = makeMsg({
      conversationId: convId,
      externalMessageId: 'msg-sus-trigger',
      sender: { externalId: senderExternalId, phone: senderExternalId },
    });
    const canonical = router.canonicalize(msg);
    const result = await router.receiveCanonical(canonical!) as any;
    assert.equal(result.status, 'PROSPECT_HANDLED');
    assert.equal(result.abuseState, 'SUSPICIOUS');
    assert.equal(sentText, PROSPECT_SUSPICIOUS_REPLY);
    assert.notEqual(sentText, PROSPECT_ONBOARDING_REPLY);
    assert.equal(modelCallCount, 0);
  });

  it('SUSPICIOUS route_outcome recorded in audit as PROSPECT_SUSPICIOUS', async () => {
    const db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    const router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async () => {} } as any,
    });

    const senderExternalId = '+65SUSPICIOUS002';
    const now = Date.now();
    insertMessages(db, senderExternalId, 5, now);

    const convId = 'conv-suspicious-audit';
    db.db.prepare(
      "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
    ).run(convId, 'demo-account', convId);

    const msg = makeMsg({
      conversationId: convId,
      externalMessageId: 'msg-sus-audit',
      sender: { externalId: senderExternalId, phone: senderExternalId },
    });
    const canonical = router.canonicalize(msg);
    await router.receiveCanonical(canonical!);
    const audit = db.db.prepare(
      'SELECT route_outcome, abuse_state FROM inbound_route_audit WHERE account_id=? AND external_message_id=?'
    ).get('demo-account', msg.externalMessageId) as any;
    assert.equal(audit.route_outcome, 'PROSPECT_SUSPICIOUS');
    assert.equal(audit.abuse_state, 'SUSPICIOUS');
  });

  it('COOLDOWN invokes zero model calls and zero ERP tool calls', async () => {
    const db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    let modelCallCount = 0;
    const prospectModel: ProspectModelCaller = async () => {
      modelCallCount++;
      return 'AI reply';
    };
    const router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async () => {} } as any,
      prospectModel,
    });

    const senderExternalId = '+65COOLDOWN001';
    const now = Date.now();
    insertMessages(db, senderExternalId, 10, now);

    const convId = 'conv-cooldown-test';
    db.db.prepare(
      "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
    ).run(convId, 'demo-account', convId);

    const msg = makeMsg({
      conversationId: convId,
      externalMessageId: 'msg-cooldown-trigger',
      sender: { externalId: senderExternalId, phone: senderExternalId },
    });
    const canonical = router.canonicalize(msg);
    const result = await router.receiveCanonical(canonical!) as any;
    assert.equal(result.abuseState, 'COOLDOWN');
    assert.equal(modelCallCount, 0);
    const turns = db.db.prepare('SELECT COUNT(*) AS n FROM agent_turns').get() as any;
    assert.equal(turns.n, 0);
  });

  it('BLOCKED invokes zero model calls', async () => {
    const db = new V1Database(':memory:');
    db.resetAndSeed();
    const commerce = new CommerceService(db);
    const rollout = new V2RolloutService(db);
    let modelCallCount = 0;
    const prospectModel: ProspectModelCaller = async () => {
      modelCallCount++;
      return 'AI reply';
    };
    const router = new V2CanaryIngressRouter(db, commerce, rollout, {
      enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

      allowLegacyFallback: true,
      outbound: { send: async () => {} } as any,
      prospectModel,
    });

    const senderExternalId = '+65BLOCKED001';
    const now = Date.now();
    insertMessages(db, senderExternalId, 20, now);

    const convId = 'conv-blocked-test';
    db.db.prepare(
      "INSERT INTO conversations(id,channel_account_id,external_conversation_id,customer_id,status,last_message_at) VALUES(?,?,?,NULL,'OPEN',datetime('now'))"
    ).run(convId, 'demo-account', convId);

    const msg = makeMsg({
      conversationId: convId,
      externalMessageId: 'msg-blocked-trigger',
      sender: { externalId: senderExternalId, phone: senderExternalId },
    });
    const canonical = router.canonicalize(msg);
    const result = await router.receiveCanonical(canonical!) as any;
    assert.equal(result.abuseState, 'BLOCKED');
    assert.equal(modelCallCount, 0);
  });
});
