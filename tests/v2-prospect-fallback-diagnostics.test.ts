/**
 * Prospect AI fallback diagnosability and repeated-fallback suppression.
 *
 * Covers:
 * - Demo Gateway origin rejection records PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED
 *   instead of looking like a healthy PROSPECT_ACCEPTED
 * - other bounded gateway codes map to their own closed-set reason
 * - unrecognized errors collapse to MODEL_ERROR without echoing error text
 * - rapid repeat fallbacks are persisted and audited but sent only once
 * - a recovered gateway (AI_ROUTED) clears the cooldown
 * - a healthy gateway still routes NORMAL prospects to AI, in-language
 * - no implicit customer binding is created on any fallback path
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { CommerceService } from '../src/commerce.js';
import { V2RolloutService } from '../src/v2-rollout.js';
import {
  V2CanaryIngressRouter,
  PROSPECT_AI_FALLBACK_COOLDOWN_MS,
} from '../src/v2-canary-ingress-router.js';
import { DemoGatewayError } from '../src/gateway.js';
import { PROSPECT_ONBOARDING_REPLY } from '../src/v2-inbound-abuse-guard.js';
import { ProspectSemanticRouter, prospectFallbackReasonFor } from '../src/v2-prospect-semantic-router.js';
import type { IncomingChannelMessage } from '../src/channel-contract.js';
import type { ProspectModelCaller } from '../src/v2-prospect-semantic-router.js';

const CONVERSATION = 'conv-prospect-fallback-diag';
const SENDER = '+6586188375';

function makeMsg(override: Partial<IncomingChannelMessage> = {}): IncomingChannelMessage {
  return {
    accountId: 'demo-account',
    conversationId: CONVERSATION,
    externalMessageId: `msg-fb-${Math.random().toString(36).slice(2, 10)}`,
    channel: 'whatsapp',
    occurredAt: new Date().toISOString(),
    type: 'text',
    text: 'Hi',
    sender: { externalId: SENDER, phone: SENDER },
    ...override,
  };
}

function makeHarness(prospectModel?: ProspectModelCaller) {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const sent: string[] = [];
  const router = new V2CanaryIngressRouter(db, new CommerceService(db), new V2RolloutService(db), {
    enabled: true,
    outbound: { send: async (m: any) => { sent.push(m.text); } } as any,
    prospectModel,
  });
  // Canonicalization maps the external conversation to an internal id; audits and
  // messages are keyed by that internal id.
  let internalConversationId = '';
  const receive = async (msg: IncomingChannelMessage) => {
    const canonical = router.canonicalize(msg);
    assert.notEqual(canonical, null);
    assert.equal(canonical!.customerId, null, 'prospect must never be auto-bound to a customer');
    internalConversationId = canonical!.message.conversationId;
    return await router.receiveCanonical(canonical!) as any;
  };
  const audits = () => db.db.prepare(
    'SELECT external_message_id, route_outcome FROM inbound_route_audit WHERE conversation_id=? ORDER BY occurred_at, rowid'
  ).all(internalConversationId) as { external_message_id: string; route_outcome: string }[];
  const inboundCount = () => (db.db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND direction=?'
  ).get(internalConversationId, 'INBOUND') as { n: number }).n;
  return { db, sent, receive, audits, inboundCount };
}

// ── Reason-code mapping ─────────────────────────────────────────────────────

test('gateway error codes map to closed-set fallback reasons', () => {
  assert.equal(
    prospectFallbackReasonFor(new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED')),
    'GATEWAY_ORIGIN_UNREGISTERED',
  );
  assert.equal(
    prospectFallbackReasonFor(new DemoGatewayError(401, 'DEMO_GPT_SESSION_UNAUTHORIZED')),
    'GATEWAY_SESSION_UNAUTHORIZED',
  );
  assert.equal(
    prospectFallbackReasonFor(new DemoGatewayError(429, 'DEMO_GPT_QUOTA_EXCEEDED')),
    'GATEWAY_QUOTA_EXCEEDED',
  );
  assert.equal(
    prospectFallbackReasonFor(new DemoGatewayError(502, 'DEMO_GPT_NETWORK_ERROR')),
    'GATEWAY_UNAVAILABLE',
  );
});

test('unrecognized error text never reaches the reason code', async () => {
  const secretish = 'failed with Bearer dmo_abc123 at https://gpt.example/demo/session';
  assert.equal(prospectFallbackReasonFor(new Error(secretish)), 'MODEL_ERROR');

  const routed = await new ProspectSemanticRouter(async () => { throw new Error(secretish); }).route('Hi');
  assert.equal(routed.fallbackReason, 'MODEL_ERROR');
  assert.equal(routed.reply, PROSPECT_ONBOARDING_REPLY);
});

test('empty model reply is a distinct fallback reason', async () => {
  const routed = await new ProspectSemanticRouter(async () => '   ').route('Hi');
  assert.equal(routed.routedByAI, false);
  assert.equal(routed.fallbackReason, 'EMPTY_REPLY');
});

// ── Audit diagnosability ────────────────────────────────────────────────────

test('origin-unregistered gateway records a distinct audit reason, not PROSPECT_ACCEPTED', async () => {
  const h = makeHarness(async () => { throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED'); });
  const result = await h.receive(makeMsg({ text: '你卖什么' }));

  assert.equal(result.status, 'PROSPECT_HANDLED');
  assert.equal(result.abuseState, 'NORMAL');
  assert.deepEqual(
    h.audits().map(a => a.route_outcome),
    ['PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED'],
  );
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0], PROSPECT_ONBOARDING_REPLY);
});

test('audit reason never contains gateway token or origin text', async () => {
  const h = makeHarness(async () => {
    throw new DemoGatewayError(403, 'origin http://127.0.0.1:32111 rejected token dmo_live_secret');
  });
  await h.receive(makeMsg());
  const outcome = h.audits()[0].route_outcome;
  assert.equal(outcome, 'PROSPECT_AI_FALLBACK_MODEL_ERROR');
  assert.ok(!/dmo_|127\.0\.0\.1|http/i.test(outcome));
});

// ── Repeated fallback suppression ───────────────────────────────────────────

test('rapid repeat prospects are all persisted and audited but replied to once', async () => {
  const h = makeHarness(async () => { throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED'); });
  const base = Date.parse('2026-09-28T10:00:00.000Z');
  const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();

  await h.receive(makeMsg({ text: 'Hi', occurredAt: at(0) }));
  await h.receive(makeMsg({ text: '你买什么', occurredAt: at(1_000) }));
  await h.receive(makeMsg({ text: '你卖什么', occurredAt: at(2_000) }));

  // Every inbound is persisted and audited.
  assert.equal(h.inboundCount(), 3);
  assert.deepEqual(h.audits().map(a => a.route_outcome), [
    'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED',
    'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED_SUPPRESSED',
    'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED_SUPPRESSED',
  ]);
  // The identical canned reply is sent only once.
  assert.equal(h.sent.length, 1);
});

test('fallback reply resumes after the cooldown window', async () => {
  const h = makeHarness(async () => { throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED'); });
  const base = Date.parse('2026-09-28T10:00:00.000Z');
  const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();

  await h.receive(makeMsg({ occurredAt: at(0) }));
  await h.receive(makeMsg({ occurredAt: at(1_000) }));
  await h.receive(makeMsg({ occurredAt: at(PROSPECT_AI_FALLBACK_COOLDOWN_MS + 1_000) }));

  assert.equal(h.sent.length, 2);
  assert.equal(h.audits().at(-1)!.route_outcome, 'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED');
});

test('a recovered gateway clears the cooldown and routes to AI in the same language', async () => {
  let down = true;
  const h = makeHarness(async (text) => {
    if (down) throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED');
    return text.includes('卖') ? '我们供应禽肉产品。' : 'We distribute poultry products.';
  });
  const base = Date.parse('2026-09-28T10:00:00.000Z');
  const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();

  await h.receive(makeMsg({ text: 'Hi', occurredAt: at(0) }));
  await h.receive(makeMsg({ text: 'Hi again', occurredAt: at(1_000) }));
  assert.equal(h.sent.length, 1);

  down = false;
  await h.receive(makeMsg({ text: '你卖什么', occurredAt: at(2_000) }));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1], '我们供应禽肉产品。');

  // Gateway fails again: the cooldown was cleared by the AI-routed turn.
  down = true;
  await h.receive(makeMsg({ text: 'Hello?', occurredAt: at(3_000) }));
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2], PROSPECT_ONBOARDING_REPLY);

  assert.deepEqual(h.audits().map(a => a.route_outcome), [
    'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED',
    'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED_SUPPRESSED',
    'PROSPECT_AI_ROUTED',
    'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED',
  ]);
});

test('suppression never binds a customer or creates ERP/workspace state', async () => {
  const h = makeHarness(async () => { throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED'); });
  const countOrders = () => (h.db.db.prepare('SELECT COUNT(*) AS n FROM sales_orders').get() as { n: number }).n;
  const seededOrders = countOrders();

  const base = Date.parse('2026-09-28T10:00:00.000Z');
  for (let i = 0; i < 4; i += 1) {
    await h.receive(makeMsg({ occurredAt: new Date(base + i * 1_000).toISOString() }));
  }

  // The prospect is tracked as a prospect only — never bound to CUST-001 or any customer.
  const bound = h.db.db.prepare(
    'SELECT COUNT(*) AS n FROM customer_channel_identities WHERE external_id=?'
  ).get(SENDER) as { n: number };
  assert.equal(bound.n, 0);
  const prospects = h.db.db.prepare(
    'SELECT COUNT(*) AS n FROM prospect_identities WHERE external_id=?'
  ).get(SENDER) as { n: number };
  assert.equal(prospects.n, 1);

  // No V2 agent queue entry and no new ERP state from the fallback path.
  const queued = h.db.db.prepare('SELECT COUNT(*) AS n FROM v2_inbox_items').get() as { n: number };
  assert.equal(queued.n, 0);
  assert.equal(countOrders(), seededOrders);
});
