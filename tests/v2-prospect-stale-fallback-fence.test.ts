/**
 * Stale generic-fallback freshness fence for prospect/unknown inbound.
 *
 * A slow message A can only finish after a newer message B in the same
 * conversation has already been answered. Sending A's generic onboarding
 * fallback at that point contradicts the reply the prospect already received,
 * so the fallback is fenced off durable arrival evidence — never by sleeping,
 * debouncing, or dropping inbound.
 *
 * Covers:
 * - the race itself: B answered first, A's late fallback suppressed
 * - no newer inbound: the fallback is still delivered
 * - conversation isolation: newer traffic in Y never fences X
 * - the pre-existing same-reason cooldown suppression is untouched
 * - duplicate provider delivery still yields exactly one reply
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { CommerceService } from '../src/commerce.js';
import { V2RolloutService } from '../src/v2-rollout.js';
import {
  V2CanaryIngressRouter,
  PROSPECT_AI_FALLBACK_STALE_SUPPRESSED_SUFFIX,
} from '../src/v2-canary-ingress-router.js';
import { DemoGatewayError } from '../src/gateway.js';
import { PROSPECT_ONBOARDING_REPLY } from '../src/v2-inbound-abuse-guard.js';
import type { IncomingChannelMessage } from '../src/channel-contract.js';
import type { ProspectModelCaller } from '../src/v2-prospect-semantic-router.js';

const CONVERSATION_X = 'conv-prospect-stale-x';
const CONVERSATION_Y = 'conv-prospect-stale-y';
const SENDER_X = '+6586188375';
const SENDER_Y = '+6586188376';
const BASE_MS = Date.parse('2026-09-28T10:00:00.000Z');
const at = (offsetMs: number) => new Date(BASE_MS + offsetMs).toISOString();

// Explicit synthetic prospect reply authorization; never used in real runtime.
const TEST_PROSPECT_SCOPES=["conv-prospect-stale-x", "conv-prospect-stale-y"].map(externalConversationId=>({accountId:"demo-account",externalConversationId}));

function makeMsg(override: Partial<IncomingChannelMessage> = {}): IncomingChannelMessage {
  const sender = override.sender?.externalId ?? SENDER_X;
  return {
    accountId: 'demo-account',
    conversationId: CONVERSATION_X,
    externalMessageId: `msg-stale-${Math.random().toString(36).slice(2, 10)}`,
    channel: 'whatsapp',
    occurredAt: at(0),
    type: 'text',
    text: 'Hi',
    ...override,
    sender: override.sender ?? { externalId: sender, phone: sender },
  };
}

function makeHarness(prospectModel?: ProspectModelCaller) {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const sent: { conversationId: string; text: string }[] = [];
  const router = new V2CanaryIngressRouter(db, new CommerceService(db), new V2RolloutService(db), {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    outbound: { send: async (m: any) => { sent.push({ conversationId: m.conversationId, text: m.text }); } } as any,
    prospectModel,
  });
  // Canonicalization maps each external conversation to its internal id; audits
  // and messages are keyed by that internal id.
  const internalIds = new Map<string, string>();
  const receive = async (msg: IncomingChannelMessage) => {
    const canonical = router.canonicalize(msg);
    assert.notEqual(canonical, null);
    assert.equal(canonical!.customerId, null, 'prospect must never be auto-bound to a customer');
    internalIds.set(msg.conversationId, canonical!.message.conversationId);
    return await router.receiveCanonical(canonical!) as any;
  };
  const internalId = (externalConversationId: string) => internalIds.get(externalConversationId)!;
  const auditFor = (externalMessageId: string) => (db.db.prepare(
    'SELECT route_outcome FROM inbound_route_audit WHERE external_message_id=?'
  ).get(externalMessageId) as { route_outcome: string } | undefined)?.route_outcome;
  const audits = (externalConversationId: string) => (db.db.prepare(
    'SELECT external_message_id, route_outcome FROM inbound_route_audit WHERE conversation_id=? ORDER BY occurred_at, rowid'
  ).all(internalId(externalConversationId)) as { external_message_id: string; route_outcome: string }[]);
  const inboundIds = (externalConversationId: string) => (db.db.prepare(
    "SELECT external_message_id FROM messages WHERE conversation_id=? AND direction='INBOUND' ORDER BY occurred_at, rowid"
  ).all(internalId(externalConversationId)) as { external_message_id: string }[]).map(r => r.external_message_id);
  const sequenceRows = (externalConversationId: string) => db.db.prepare(
    'SELECT external_message_id, inbound_seq, reply_state FROM prospect_reply_sequence WHERE conversation_id=? ORDER BY inbound_seq'
  ).all(internalId(externalConversationId)) as { external_message_id: string; inbound_seq: number; reply_state: string }[];
  return { db, sent, receive, auditFor, audits, inboundIds, sequenceRows };
}

/** Model seam that holds one message's call open until the test releases it. */
function deferredModel(heldText: string, replyFor: (text: string) => string) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const model: ProspectModelCaller = async (text) => {
    if (text === heldText) {
      await gate;
      throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED');
    }
    return replyFor(text);
  };
  return { model, release: () => release() };
}

// ── The race ────────────────────────────────────────────────────────────────

test('a newer answered inbound fences the older message\'s generic fallback', async () => {
  const B_REPLY = 'We distribute poultry products.';
  const { model, release } = deferredModel('A', () => B_REPLY);
  const h = makeHarness(model);

  const msgA = makeMsg({ externalMessageId: 'prov-A', text: 'A', occurredAt: at(0) });
  const msgB = makeMsg({ externalMessageId: 'prov-B', text: 'B', occurredAt: at(1_000) });

  // A starts its model call and is held open.
  const pendingA = h.receive(msgA);
  // B arrives in the same conversation while A is still pending and is answered.
  const resultB = await h.receive(msgB);
  assert.equal(resultB.routeOutcome, 'PROSPECT_AI_ROUTED');
  assert.deepEqual(h.sent, [{ conversationId: CONVERSATION_X, text: B_REPLY }]);

  // A now fails and would otherwise send the generic onboarding fallback.
  release();
  const resultA = await pendingA;

  // B's valid reply was sent exactly once; A's stale fallback was never sent.
  assert.equal(h.sent.filter(m => m.text === B_REPLY).length, 1);
  assert.equal(h.sent.filter(m => m.text === PROSPECT_ONBOARDING_REPLY).length, 0);
  assert.equal(h.sent.length, 1);

  // Both inbound messages are preserved; nothing was coalesced or dropped.
  assert.deepEqual(h.inboundIds(CONVERSATION_X), ['prov-A', 'prov-B']);

  // A is audited with a bounded stale-suppression outcome.
  assert.equal(resultA.status, 'PROSPECT_HANDLED');
  assert.equal(resultA.abuseState, 'NORMAL');
  assert.equal(resultA.replySuppressed, true);
  assert.equal(
    h.auditFor('prov-A'),
    `PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED${PROSPECT_AI_FALLBACK_STALE_SUPPRESSED_SUFFIX}`,
  );
  assert.ok(h.auditFor('prov-A')!.endsWith(PROSPECT_AI_FALLBACK_STALE_SUPPRESSED_SUFFIX));
  assert.equal(h.auditFor('prov-B'), 'PROSPECT_AI_ROUTED');

  // Durable arrival evidence follows provider order, not model completion order.
  assert.deepEqual(h.sequenceRows(CONVERSATION_X), [
    { external_message_id: 'prov-A', inbound_seq: 1, reply_state: 'SUPPRESSED' },
    { external_message_id: 'prov-B', inbound_seq: 2, reply_state: 'SENT' },
  ]);

  // No implicit customer binding on either path.
  const bound = h.db.db.prepare(
    'SELECT COUNT(*) AS n FROM customer_channel_identities WHERE external_id=?'
  ).get(SENDER_X) as { n: number };
  assert.equal(bound.n, 0);
});

// ── The fence must not over-fire ────────────────────────────────────────────

test('a failed message with no newer inbound still sends its fallback', async () => {
  const h = makeHarness(async () => { throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED'); });

  const result = await h.receive(makeMsg({ externalMessageId: 'prov-only', occurredAt: at(0) }));

  assert.equal(result.replySuppressed, false);
  assert.deepEqual(h.sent, [{ conversationId: CONVERSATION_X, text: PROSPECT_ONBOARDING_REPLY }]);
  assert.equal(h.auditFor('prov-only'), 'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED');
});

test('newer traffic in conversation Y never fences conversation X', async () => {
  const Y_REPLY = 'We distribute poultry products.';
  const { model, release } = deferredModel('A', () => Y_REPLY);
  const h = makeHarness(model);

  const msgA = makeMsg({ externalMessageId: 'prov-A', text: 'A', occurredAt: at(0) });
  const msgY = makeMsg({
    externalMessageId: 'prov-Y',
    conversationId: CONVERSATION_Y,
    sender: { externalId: SENDER_Y, phone: SENDER_Y },
    text: 'Y',
    occurredAt: at(1_000),
  });

  const pendingA = h.receive(msgA);
  const resultY = await h.receive(msgY);
  assert.equal(resultY.routeOutcome, 'PROSPECT_AI_ROUTED');

  release();
  const resultA = await pendingA;

  // X has no newer inbound of its own, so its fallback is delivered normally.
  assert.equal(resultA.replySuppressed, false);
  assert.equal(h.auditFor('prov-A'), 'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED');
  assert.deepEqual(h.sent, [
    { conversationId: CONVERSATION_Y, text: Y_REPLY },
    { conversationId: CONVERSATION_X, text: PROSPECT_ONBOARDING_REPLY },
  ]);
  assert.deepEqual(h.inboundIds(CONVERSATION_X), ['prov-A']);
  assert.deepEqual(h.inboundIds(CONVERSATION_Y), ['prov-Y']);
});

// ── Pre-existing guards are unchanged ───────────────────────────────────────

test('same-reason cooldown suppression is unchanged and distinguishable from the fence', async () => {
  const h = makeHarness(async () => { throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED'); });

  await h.receive(makeMsg({ externalMessageId: 'prov-1', occurredAt: at(0) }));
  await h.receive(makeMsg({ externalMessageId: 'prov-2', occurredAt: at(1_000) }));

  assert.equal(h.sent.length, 1);
  assert.equal(h.auditFor('prov-1'), 'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED');
  // Cooldown suppression keeps its own suffix; the stale fence never fired here.
  assert.equal(h.auditFor('prov-2'), 'PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED_SUPPRESSED');
  assert.ok(!h.auditFor('prov-2')!.endsWith(PROSPECT_AI_FALLBACK_STALE_SUPPRESSED_SUFFIX));
  assert.deepEqual(h.inboundIds(CONVERSATION_X), ['prov-1', 'prov-2']);
});

test('a duplicate provider delivery keeps one inbound, one sequence slot and one reply', async () => {
  const h = makeHarness(async () => { throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED'); });
  const msg = makeMsg({ externalMessageId: 'prov-dup', occurredAt: at(0) });

  await h.receive(msg);
  await h.receive({ ...msg });

  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.inboundIds(CONVERSATION_X), ['prov-dup']);
  // The redelivery recovers its original arrival slot instead of being admitted
  // as newer traffic, so it can never fence the message it duplicates.
  assert.deepEqual(h.sequenceRows(CONVERSATION_X), [
    { external_message_id: 'prov-dup', inbound_seq: 1, reply_state: 'SENT' },
  ]);
});
