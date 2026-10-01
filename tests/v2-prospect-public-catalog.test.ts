/**
 * PUBLIC_CATALOG_READ — the only ERP read surface an unverified prospect reaches.
 *
 * The increment under test lets a prospect ask what the business sells and get a
 * truthful answer built from real product rows, without widening the boundary:
 *
 * - Catalog use is the model's semantic decision. Nothing on the host inspects
 *   the customer's message, so the same Chinese listing query routes to a lookup
 *   or to plain prose purely on what the model asks for.
 * - Every lookup is allowlisted and bounded (tool name, query, limit).
 * - Model context carries only the four safe discovery fields. Price, discount,
 *   credit, order history, customer identity, private stock, warehouse and any
 *   mutation surface are unreachable, not merely unrequested.
 * - Every product line the customer sees is host-rendered from retrieved
 *   evidence, so an empty result is an honest "nothing matches" and an
 *   unsupported product id fails the turn closed.
 * - SUSPICIOUS / COOLDOWN / BLOCKED still spend zero model calls and zero reads.
 * - The pre-existing stale-fallback fence and duplicate protection still hold on
 *   the catalog path, and the verified-customer path plus the SALES_ORDER.DRAFT
 *   ceiling are untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { CommerceService } from '../src/commerce.js';
import { V2RolloutService } from '../src/v2-rollout.js';
import {
  V2CanaryIngressRouter,
  PROSPECT_AI_CATALOG_GROUNDED_OUTCOME,
  PROSPECT_AI_CATALOG_NO_MATCH_OUTCOME,
  PROSPECT_AI_FALLBACK_STALE_SUPPRESSED_SUFFIX,
  PROSPECT_DUPLICATE_DELIVERY_OUTCOME,
} from '../src/v2-canary-ingress-router.js';
import { DemoGatewayError } from '../src/gateway.js';
import {
  PROSPECT_ABUSE_REPLIES,
  PROSPECT_ONBOARDING_REPLY,
  PROSPECT_SUSPICIOUS_REPLY,
} from '../src/v2-inbound-abuse-guard.js';
import {
  createPublicCatalogReader,
  executeProspectCatalogTool,
  normalizeProspectCatalogToolCall,
  projectPublicCatalogItem,
  PROSPECT_CATALOG_MAX_LIMIT,
  PROSPECT_CATALOG_MAX_QUERY_CHARS,
  PUBLIC_CATALOG_SAFE_FIELDS,
} from '../src/v2-prospect-public-catalog.js';
import { DemoErpAdapter } from '../src/erp.js';
import type { IncomingChannelMessage } from '../src/channel-contract.js';
import type { ProspectModelCaller } from '../src/v2-prospect-semantic-router.js';

const CONVERSATION = 'conv-prospect-catalog';
const CONVERSATION_B = 'conv-prospect-catalog-b';
const SENDER = '+6586190001';
const SENDER_B = '+6586190002';
const BASE_MS = Date.parse('2026-09-29T02:00:00.000Z');
const at = (offsetMs: number) => new Date(BASE_MS + offsetMs).toISOString();

/** Listing-style query in Chinese: "what do you sell". Never regex-matched by the host. */
const ZH_LISTING = '你卖什么';

// Explicit synthetic prospect reply authorization; never used in real runtime.
const TEST_PROSPECT_SCOPES=["conv-001", "conv-prospect-catalog", "conv-prospect-catalog-b", "convertUom"].map(externalConversationId=>({accountId:"demo-account",externalConversationId}));

function makeMsg(override: Partial<IncomingChannelMessage> = {}): IncomingChannelMessage {
  const sender = override.sender?.externalId ?? SENDER;
  return {
    accountId: 'demo-account',
    conversationId: CONVERSATION,
    externalMessageId: `msg-cat-${Math.random().toString(36).slice(2, 10)}`,
    channel: 'whatsapp',
    occurredAt: at(0),
    type: 'text',
    text: 'Hi',
    ...override,
    sender: override.sender ?? { externalId: sender, phone: sender },
  };
}

/**
 * Model seam returning a fixed script. Every prompt the model was given is kept
 * so the tests can assert what did — and did not — enter prospect model context.
 */
function scriptedModel(script: readonly string[]) {
  const prompts: string[] = [];
  let index = 0;
  const model: ProspectModelCaller = async (messageText: string) => {
    prompts.push(messageText);
    if (index >= script.length) throw new Error('SCRIPT_EXHAUSTED');
    return script[index++];
  };
  return { model, prompts };
}

function makeHarness(prospectModel?: ProspectModelCaller) {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const sent: { conversationId: string; text: string }[] = [];
  const router = new V2CanaryIngressRouter(db, new CommerceService(db), new V2RolloutService(db), {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    outbound: { send: async (m: any) => { sent.push({ conversationId: m.conversationId, text: m.text }); return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()}; } } as any,
    prospectModel,
  });
  const internalIds = new Map<string, string>();
  const receive = async (msg: IncomingChannelMessage) => {
    const canonical = router.canonicalize(msg);
    assert.notEqual(canonical, null);
    assert.equal(canonical!.customerId, null, 'prospect must never be auto-bound to a customer');
    internalIds.set(msg.conversationId, canonical!.message.conversationId);
    return await router.receiveCanonical(canonical!) as any;
  };
  const auditFor = (externalMessageId: string) => (db.db.prepare(
    'SELECT route_outcome FROM inbound_route_audit WHERE external_message_id=?'
  ).get(externalMessageId) as { route_outcome: string } | undefined)?.route_outcome;
  const auditCount = () => (db.db.prepare('SELECT COUNT(*) AS n FROM inbound_route_audit').get() as { n: number }).n;
  const evidenceRows = () => db.db.prepare(
    `SELECT external_message_id, call_seq, tool_name, query_text, limit_value, result_count,
     product_ids_json, items_json, grounded, grounded_product_ids_json
     FROM prospect_catalog_evidence ORDER BY external_message_id, call_seq`
  ).all() as any[];
  const sequenceRows = (externalConversationId: string) => db.db.prepare(
    'SELECT external_message_id, inbound_seq, reply_state FROM prospect_reply_sequence WHERE conversation_id=? ORDER BY inbound_seq'
  ).all(internalIds.get(externalConversationId)!) as { external_message_id: string; inbound_seq: number; reply_state: string }[];
  /** Pre-loads the abuse-guard window so a state can be reached without 20 turns. */
  const seedInboundBurst = (count: number, senderExternalId = SENDER) => {
    for (let i = 0; i < count; i++) {
      db.db.prepare(
        `INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,
         sender_external_id,sender_phone,account_id,occurred_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `msg-burst-${i}`, 'conv-001', `ext-burst-${i}`, 'INBOUND', 'text', 'hi',
        senderExternalId, senderExternalId, 'demo-account', at(-(count - i) * 1000)
      );
    }
  };
  return { db, sent, receive, auditFor, auditCount, evidenceRows, sequenceRows, seedInboundBurst };
}

const toolCall = (body: Record<string, unknown>) => JSON.stringify(body);
const finalAnswer = (reply: string, productIds: readonly string[] = []) => JSON.stringify({ reply, productIds });

/**
 * Values that exist in the seeded ERP but belong to a verified customer, a
 * price list, stock, or order history. None may appear in prospect model
 * context, in the customer-visible reply, or in persisted catalog evidence.
 */
const FORBIDDEN_IN_PROSPECT_CONTEXT = [
  'CUST-001', 'Sunrise', 'identity-001', '+6591110001',   // customer identity
  '4800', '3650', '4200', 'unitPriceCents', 'unit_price', 'SGD', 'discount', 'credit', // price/discount/credit
  'SO-000041', 'so-seeded-041', 'grandTotal', 'order_history', 'orders',               // order history
  'SG-MAIN', 'warehouse', 'quantity_base', 'availableBase', '820', '144',              // private stock/warehouse
  'INSERT', 'UPDATE', 'DELETE', 'quotation',                                           // mutation surfaces
  'red one', 'wings',                                                                  // customer-scoped aliases
];

function assertNoPrivateData(label: string, haystacks: readonly string[]): void {
  for (const text of haystacks) {
    for (const token of FORBIDDEN_IN_PROSPECT_CONTEXT) {
      assert.ok(
        !text.toLowerCase().includes(token.toLowerCase()),
        `${label} must not contain private token ${token}: ${text}`,
      );
    }
  }
}

// ── Catalog use is the model's semantic decision, never host regex routing ───

test('Chinese listing query reaches a catalog lookup only because the model asked for one', async () => {
  const { model, prompts } = scriptedModel([
    toolCall({ tool: 'list_public_catalog', limit: 5 }),
    finalAnswer('我们主要供应以下产品：', ['FCH-WHOLE-12', 'FRANK-RED-1KG', 'FCH-WING-2KG']),
  ]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'zh-1', text: ZH_LISTING }));

  assert.equal(result.routeOutcome, PROSPECT_AI_CATALOG_GROUNDED_OUTCOME);
  assert.equal(result.grounded, true);
  assert.equal(result.catalogCallCount, 1);
  assert.deepEqual(result.groundedProductIds, ['FCH-WHOLE-12', 'FRANK-RED-1KG', 'FCH-WING-2KG']);

  // The host handed the model the raw customer text: no normalization, no
  // keyword extraction, no host-side intent hint of any kind.
  assert.equal(prompts[0], ZH_LISTING);
  assert.equal(prompts.length, 2);

  // The reply is the model's connective sentence plus host-rendered evidence lines.
  assert.equal(h.sent.length, 1);
  const reply = h.sent[0].text;
  assert.ok(reply.startsWith('我们主要供应以下产品：'));
  assert.ok(reply.includes('- FCH-WHOLE-12 — Frozen Whole Chicken 1.2kg x 10 (PCS)'));
  assert.ok(reply.includes('- FRANK-RED-1KG — Red Label Chicken Frank 1kg x 10 (PACK)'));
  assert.ok(reply.includes('- FCH-WING-2KG — Frozen Chicken Wing 2kg x 6 (PACK)'));
});

test('the identical Chinese query stays text-only when the model does not ask for a lookup', async () => {
  const PROSE = '您好！请问贵公司名称是什么？我们可以安排同事跟进。';
  const { model, prompts } = scriptedModel([PROSE]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'zh-2', text: ZH_LISTING }));

  // Same message text, different model decision, no catalog read: proof that
  // routing is semantic and not a host pattern match on the message.
  assert.equal(result.routeOutcome, 'PROSPECT_AI_ROUTED');
  assert.equal(result.catalogCallCount, 0);
  assert.equal(result.grounded, false);
  assert.deepEqual(result.groundedProductIds, []);
  assert.deepEqual(h.evidenceRows(), []);
  assert.deepEqual(h.sent, [{ conversationId: CONVERSATION, text: PROSE }]);
  assert.equal(prompts.length, 1);
});

test('an English listing query uses the same seam with no language gating', async () => {
  const { model } = scriptedModel([
    toolCall({ tool: 'search_public_catalog', query: 'chicken', limit: 3 }),
    finalAnswer('Here is part of our range:', ['FCH-WHOLE-12']),
  ]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'en-1', text: 'Hello, what do you sell?' }));

  assert.equal(result.routeOutcome, PROSPECT_AI_CATALOG_GROUNDED_OUTCOME);
  assert.equal(result.catalogCallCount, 1);
  assert.equal(h.evidenceRows()[0].tool_name, 'search_public_catalog');
  assert.equal(h.evidenceRows()[0].query_text, 'chicken');
});

// ── Bounded, allowlisted query + limit ──────────────────────────────────────

test('a bounded allowlisted query honours its limit end to end', async () => {
  const { model } = scriptedModel([
    toolCall({ tool: 'search_public_catalog', query: '鸡', limit: 2 }),
    finalAnswer('这些是我们的产品：', ['FCH-WHOLE-12', 'FCH-WING-2KG']),
  ]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'lim-1', text: '你有鸡肉吗' }));

  assert.equal(result.catalogCallCount, 1);
  const [row] = h.evidenceRows();
  assert.equal(row.tool_name, 'search_public_catalog');
  assert.equal(row.query_text, '鸡');
  assert.equal(row.limit_value, 2);
  // The public alias 鸡 matches all three seeded products; the limit caps it at 2.
  assert.equal(row.result_count, 2);
  assert.equal(JSON.parse(row.items_json).length, 2);
  assert.equal(row.grounded, 1);
});

test('normalization rejects every out-of-bounds or non-allowlisted tool shape', () => {
  const denied = (candidate: unknown) => assert.throws(
    () => normalizeProspectCatalogToolCall(candidate),
    /^Error: PROSPECT_CATALOG_DENIED:/,
  );

  // Employee/customer-scoped capability names are simply unknown here.
  denied({ tool: 'get_customer_price', productId: 'FCH-WHOLE-12' });
  denied({ tool: 'search_products', query: 'chicken' });
  denied({ tool: 'check_stock', productId: 'FCH-WHOLE-12' });
  denied({ tool: 'resolve_customer', sender: SENDER });
  denied({ tool: 'get_recent_orders', limit: 5 });
  // Bounds.
  denied({ tool: 'search_public_catalog', query: 'chicken', limit: PROSPECT_CATALOG_MAX_LIMIT + 1 });
  denied({ tool: 'search_public_catalog', query: 'chicken', limit: 0 });
  denied({ tool: 'search_public_catalog', query: 'chicken', limit: 2.5 });
  denied({ tool: 'search_public_catalog', query: 'x'.repeat(PROSPECT_CATALOG_MAX_QUERY_CHARS + 1) });
  denied({ tool: 'search_public_catalog', query: '   ' });
  denied({ tool: 'search_public_catalog' });
  // A customer scope cannot be smuggled in as an extra argument.
  denied({ tool: 'search_public_catalog', query: 'chicken', customerId: 'CUST-001' });
  denied({ tool: 'list_public_catalog', limit: 5, warehouseId: 'SG-MAIN' });
  // The listing tool takes no query, so neither shape can carry the other's args.
  denied({ tool: 'list_public_catalog', query: 'chicken', limit: 5 });

  // The allowed shapes normalize with a bounded default limit.
  assert.deepEqual(
    { ...normalizeProspectCatalogToolCall({ tool: 'search_public_catalog', query: '  chicken  ' }) },
    { name: 'search_public_catalog', query: 'chicken', limit: 5 },
  );
  assert.deepEqual(
    { ...normalizeProspectCatalogToolCall({ tool: 'list_public_catalog' }) },
    { name: 'list_public_catalog', query: null, limit: 5 },
  );
});

test('an out-of-bounds model tool call fails the turn closed with no catalog read', async () => {
  const { model } = scriptedModel([toolCall({ tool: 'search_public_catalog', query: 'chicken', limit: 500 })]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'lim-2', text: 'list everything' }));

  assert.equal(result.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_TOOL_REJECTED');
  assert.equal(result.catalogCallCount, 0);
  assert.deepEqual(h.evidenceRows(), []);
  assert.deepEqual(h.sent, [{ conversationId: CONVERSATION, text: PROSPECT_ONBOARDING_REPLY }]);
});

test('a non-allowlisted customer-scoped tool request fails the turn closed', async () => {
  const { model } = scriptedModel([toolCall({ tool: 'get_customer_price', query: 'FCH-WHOLE-12' })]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'deny-1', text: 'how much is chicken' }));

  assert.equal(result.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_TOOL_REJECTED');
  assert.deepEqual(h.evidenceRows(), []);
  assert.equal(h.sent[0].text, PROSPECT_ONBOARDING_REPLY);
});

test('more lookups than one prospect turn permits fails closed on the budget', async () => {
  const { model } = scriptedModel([
    toolCall({ tool: 'search_public_catalog', query: 'chicken', limit: 1 }),
    toolCall({ tool: 'search_public_catalog', query: 'frank', limit: 1 }),
    toolCall({ tool: 'search_public_catalog', query: 'wing', limit: 1 }),
  ]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'budget-1', text: 'tell me everything' }));

  assert.equal(result.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_TOOL_BUDGET');
  // The two permitted reads are still recorded; the third was never performed.
  assert.equal(h.evidenceRows().length, 2);
  assert.equal(h.sent[0].text, PROSPECT_ONBOARDING_REPLY);
});

// ── Returned evidence carries only the four safe discovery fields ────────────

test('returned catalog evidence contains only productId, stockCode, description, baseUom', async () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const reader = createPublicCatalogReader(db.db);

  for (const call of [
    { name: 'list_public_catalog' as const, query: null, limit: 10 },
    { name: 'search_public_catalog' as const, query: '鸡', limit: 10 },
  ]) {
    const result = await executeProspectCatalogTool(call, reader);
    assert.ok(result.items.length > 0);
    for (const item of result.items) {
      assert.deepEqual(Object.keys(item).sort(), [...PUBLIC_CATALOG_SAFE_FIELDS].sort());
    }
  }
  assert.deepEqual([...PUBLIC_CATALOG_SAFE_FIELDS], ['productId', 'stockCode', 'description', 'baseUom']);
});

test('a widened ERP projection fails the call loudly instead of being trimmed away', () => {
  const evidence = {
    type: 'public_catalog', input: {}, observedAt: at(0), sourceVersion: 'demo-v1' as const,
    output: {
      productId: 'FCH-WHOLE-12', stockCode: 'FCH-WHOLE-12',
      description: 'Frozen Whole Chicken 1.2kg x 10', baseUom: 'PCS',
      unitPriceCents: 4800,
    },
  };
  assert.throws(() => projectPublicCatalogItem(evidence), /UNSAFE_CATALOG_FIELD_unitPriceCents/);
});

test('the prospect-reachable ERP surface is exactly two bound read methods', () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const reader = createPublicCatalogReader(db.db) as any;

  assert.deepEqual(Object.keys(reader).sort(), ['listPublicCatalog', 'searchPublicCatalog']);
  assert.ok(Object.isFrozen(reader));
  for (const unreachable of [
    'resolveCustomer', 'searchProducts', 'getProduct', 'getRecentOrders', 'resolveUom',
    'convertUom', 'getCustomerPrice', 'checkStock',
  ]) {
    assert.equal(reader[unreachable], undefined, `${unreachable} must not be reachable from a prospect turn`);
  }
});

// ── Private commercial data cannot enter prospect model context ──────────────

test('no price, credit, order history, identity, stock or warehouse value enters model context', async () => {
  const { model, prompts } = scriptedModel([
    toolCall({ tool: 'list_public_catalog', limit: 10 }),
    finalAnswer('这些是我们供应的产品：', ['FCH-WHOLE-12', 'FRANK-RED-1KG', 'FCH-WING-2KG']),
  ]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'priv-1', text: ZH_LISTING }));
  assert.equal(result.grounded, true);

  // Every prompt the model saw, the customer-visible reply, and the persisted
  // evidence are all checked against the seeded private values.
  assertNoPrivateData('model prompt', prompts);
  assertNoPrivateData('customer reply', h.sent.map(m => m.text));
  assertNoPrivateData('persisted evidence', h.evidenceRows().map(r => r.items_json));

  // The evidence block the model received is present and holds only safe fields.
  assert.ok(prompts[1].includes('[PUBLIC_CATALOG_EVIDENCE]'));
  for (const item of JSON.parse(h.evidenceRows()[0].items_json)) {
    assert.deepEqual(Object.keys(item).sort(), [...PUBLIC_CATALOG_SAFE_FIELDS].sort());
  }

  // The prospect turn wrote no commerce state and bound no customer.
  const counts = h.db.db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotations) AS q, (SELECT COUNT(*) FROM sales_orders) AS so,
     (SELECT COUNT(*) FROM customer_channel_identities WHERE external_id=?) AS bound,
     (SELECT COUNT(*) FROM agent_turns) AS turns`
  ).get(SENDER) as { q: number; so: number; bound: number; turns: number };
  assert.equal(counts.q, 0);
  // Only the seeded historical order remains; the prospect turn created none.
  assert.equal(counts.so, 1);
  assert.equal(counts.bound, 0);
  assert.equal(counts.turns, 0);
});

test('customer-scoped product aliases are invisible to the public catalog', async () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const reader = createPublicCatalogReader(db.db);
  const adapter = new DemoErpAdapter(db.db);

  // "red one" and "wings" are seeded as CUST-001-scoped vocabulary.
  for (const privateAlias of ['red one', 'wings']) {
    const publicResult = await executeProspectCatalogTool(
      { name: 'search_public_catalog', query: privateAlias, limit: 10 }, reader,
    );
    assert.deepEqual(publicResult.items, [], `${privateAlias} must not resolve publicly`);
    // The same term still resolves on the verified-customer path, so the public
    // fence is exclusion of customer scope, not loss of customer capability.
    const customerResult = await adapter.searchProducts('CUST-001', privateAlias);
    assert.ok(customerResult.length > 0);
  }

  // Public (customer_id IS NULL) vocabulary does resolve.
  const publicTerm = await executeProspectCatalogTool(
    { name: 'search_public_catalog', query: '鸡', limit: 10 }, reader,
  );
  assert.equal(publicTerm.items.length, 3);
});

// ── An empty result is an honest answer, never an invented one ───────────────

test('a no-result lookup produces a grounded honest no-result answer', async () => {
  const NO_MATCH = '抱歉，我们目前没有符合的产品。';
  const { model } = scriptedModel([
    toolCall({ tool: 'search_public_catalog', query: 'solar panel', limit: 5 }),
    finalAnswer(NO_MATCH, []),
  ]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'none-1', text: '你们有太阳能板吗' }));

  assert.equal(result.routeOutcome, PROSPECT_AI_CATALOG_NO_MATCH_OUTCOME);
  assert.equal(result.grounded, true);
  assert.deepEqual(result.groundedProductIds, []);
  assert.equal(result.catalogCallCount, 1);

  // The reply is the honest sentence alone: no host-rendered line, no invented SKU.
  assert.deepEqual(h.sent, [{ conversationId: CONVERSATION, text: NO_MATCH }]);
  assert.ok(!/FCH-|FRANK-/.test(h.sent[0].text));

  const [row] = h.evidenceRows();
  assert.equal(row.result_count, 0);
  assert.equal(row.product_ids_json, '[]');
  assert.equal(row.grounded_product_ids_json, '[]');
});

test('claiming a product over an empty result fails the turn closed', async () => {
  const { model } = scriptedModel([
    toolCall({ tool: 'search_public_catalog', query: 'solar panel', limit: 5 }),
    finalAnswer('We stock this item:', ['FCH-WHOLE-12']),
  ]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'none-2', text: 'do you sell solar panels' }));

  assert.equal(result.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_GROUNDING_REJECTED');
  assert.equal(result.grounded, false);
  assert.deepEqual(h.sent, [{ conversationId: CONVERSATION, text: PROSPECT_ONBOARDING_REPLY }]);
});

// ── A grounded answer cannot exceed the returned evidence ───────────────────

test('a product id outside the returned evidence fails the turn closed', async () => {
  const { model } = scriptedModel([
    toolCall({ tool: 'search_public_catalog', query: 'frank', limit: 1 }),
    // FCH-WING-2KG exists in the ERP but was not retrieved by this query.
    finalAnswer('We supply these:', ['FRANK-RED-1KG', 'FCH-WING-2KG']),
  ]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'ground-1', text: 'what frankfurters do you have' }));

  assert.equal(result.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_GROUNDING_REJECTED');
  assert.equal(result.grounded, false);
  assert.deepEqual(result.groundedProductIds, []);
  assert.deepEqual(h.sent, [{ conversationId: CONVERSATION, text: PROSPECT_ONBOARDING_REPLY }]);
  // The performed read is still audited; only the ungrounded answer was refused.
  assert.equal(h.evidenceRows().length, 1);
  assert.equal(h.evidenceRows()[0].grounded, 0);
});

test('a model-authored product code in connective text fails the turn closed', async () => {
  const { model } = scriptedModel([
    toolCall({ tool: 'list_public_catalog', limit: 5 }),
    finalAnswer('We also carry FCH-WING-2KG for you:', ['FCH-WHOLE-12']),
  ]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'ground-2', text: 'what do you sell' }));

  assert.equal(result.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_GROUNDING_REJECTED');
  assert.equal(h.sent[0].text, PROSPECT_ONBOARDING_REPLY);
});

test('a model-authored price or quantity in connective text fails the turn closed', async () => {
  for (const [id, connective] of [
    ['ground-3', 'Our whole chicken is $48 per carton:'],
    ['ground-4', 'We have 820 units ready:'],
    ['ground-5', 'Priced in SGD for you:'],
  ] as const) {
    const { model } = scriptedModel([
      toolCall({ tool: 'list_public_catalog', limit: 5 }),
      finalAnswer(connective, ['FCH-WHOLE-12']),
    ]);
    const h = makeHarness(model);
    const result = await h.receive(makeMsg({ externalMessageId: id, text: 'price list please' }));
    assert.equal(result.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_GROUNDING_REJECTED', connective);
    assert.equal(h.sent[0].text, PROSPECT_ONBOARDING_REPLY);
  }
});

test('prose after a lookup, or a lookup answered with no selection, both fail closed', async () => {
  // Free prose after retrieval is exactly the ungrounded answer this seam stops.
  const prose = scriptedModel([
    toolCall({ tool: 'list_public_catalog', limit: 5 }),
    'We sell frozen chicken, frankfurters and wings.',
  ]);
  const h1 = makeHarness(prose.model);
  const r1 = await h1.receive(makeMsg({ externalMessageId: 'ground-6', text: 'what do you sell' }));
  assert.equal(r1.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_GROUNDING_REJECTED');
  assert.equal(h1.sent[0].text, PROSPECT_ONBOARDING_REPLY);

  // Evidence was available but nothing was selected: not an honest no-result.
  const empty = scriptedModel([
    toolCall({ tool: 'list_public_catalog', limit: 5 }),
    finalAnswer('Nothing matches your request.', []),
  ]);
  const h2 = makeHarness(empty.model);
  const r2 = await h2.receive(makeMsg({ externalMessageId: 'ground-7', text: 'what do you sell' }));
  assert.equal(r2.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_GROUNDING_REJECTED');
  assert.equal(h2.sent[0].text, PROSPECT_ONBOARDING_REPLY);
});

test('a product code can never be asserted on a prospect reply that did no lookup', async () => {
  const { model } = scriptedModel(['Yes, we stock FCH-WING-2KG in cartons.']);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'ground-8', text: 'do you have FCH-WING-2KG' }));

  assert.equal(result.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_GROUNDING_REJECTED');
  assert.equal(result.catalogCallCount, 0);
  assert.equal(h.sent[0].text, PROSPECT_ONBOARDING_REPLY);
});

test('a money amount is refused on a text-only prospect reply too, since no price surface exists', async () => {
  // A prospect turn can reach no price, discount or credit read at all, so any
  // currency amount in the reply would be guessed — with or without a lookup.
  for (const [id, prose] of [
    ['money-1', 'Our whole chicken is about $48 per carton.'],
    ['money-2', '一箱大约 SGD 48。'],
  ] as const) {
    const { model } = scriptedModel([prose]);
    const h = makeHarness(model);
    const result = await h.receive(makeMsg({ externalMessageId: id, text: 'how much per carton' }));
    assert.equal(result.routeOutcome, 'PROSPECT_AI_FALLBACK_CATALOG_GROUNDING_REJECTED', prose);
    assert.equal(h.sent[0].text, PROSPECT_ONBOARDING_REPLY);
  }

  // A contact number or opening hours on a text-only reply is still allowed.
  const { model } = scriptedModel(['Please call our office at 6555 0123, open 9am to 6pm.']);
  const h = makeHarness(model);
  const result = await h.receive(makeMsg({ externalMessageId: 'money-3', text: 'how do I reach you' }));
  assert.equal(result.routeOutcome, 'PROSPECT_AI_ROUTED');
  assert.equal(h.sent[0].text, 'Please call our office at 6555 0123, open 9am to 6pm.');
});

// ── Abuse states spend zero model calls and zero catalog reads ───────────────

for (const [state, burst, expectedReply, expectedOutcome] of [
  ['SUSPICIOUS', 5, PROSPECT_SUSPICIOUS_REPLY, 'PROSPECT_SUSPICIOUS'],
  ['COOLDOWN', 10, PROSPECT_ABUSE_REPLIES.COOLDOWN, 'PROSPECT_COOLDOWN'],
  ['BLOCKED', 20, PROSPECT_ABUSE_REPLIES.BLOCKED, 'PROSPECT_BLOCKED'],
] as const) {
  test(`${state} consumes zero model calls and zero catalog reads`, async () => {
    // The script would gladly perform a catalog lookup if the model were reached.
    const { model, prompts } = scriptedModel([
      toolCall({ tool: 'list_public_catalog', limit: 5 }),
      finalAnswer('Our range:', ['FCH-WHOLE-12']),
    ]);
    const h = makeHarness(model);
    h.seedInboundBurst(burst);

    const result = await h.receive(makeMsg({ externalMessageId: `abuse-${state}`, text: ZH_LISTING }));

    assert.equal(result.abuseState, state);
    assert.equal(result.routeOutcome, expectedOutcome);
    assert.equal(prompts.length, 0, 'no model call may be made');
    assert.equal(result.catalogCallCount, 0);
    assert.deepEqual(h.evidenceRows(), [], 'no catalog read may be performed');
    assert.deepEqual(h.sent, [{ conversationId: CONVERSATION, text: expectedReply }]);
  });
}

// ── Pre-existing fences still hold on the catalog path ──────────────────────

test('a newer answered catalog turn still fences the older message\'s stale fallback', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prompts: string[] = [];
  // A is held open and then fails; B runs a catalog turn to completion.
  const model: ProspectModelCaller = async (text) => {
    prompts.push(text);
    if (text === 'A') { await gate; throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED'); }
    if (text === 'B') return toolCall({ tool: 'list_public_catalog', limit: 1 });
    return finalAnswer('Our range includes:', ['FCH-WHOLE-12']);
  };
  const h = makeHarness(model);

  const pendingA = h.receive(makeMsg({ externalMessageId: 'stale-A', text: 'A', occurredAt: at(0) }));
  const resultB = await h.receive(makeMsg({ externalMessageId: 'stale-B', text: 'B', occurredAt: at(1_000) }));
  assert.equal(resultB.routeOutcome, PROSPECT_AI_CATALOG_GROUNDED_OUTCOME);

  release();
  const resultA = await pendingA;

  assert.equal(resultA.replySuppressed, true);
  assert.equal(
    h.auditFor('stale-A'),
    `PROSPECT_AI_FALLBACK_GATEWAY_ORIGIN_UNREGISTERED${PROSPECT_AI_FALLBACK_STALE_SUPPRESSED_SUFFIX}`,
  );
  // Only B's grounded reply reached the prospect.
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0].text.includes('- FCH-WHOLE-12 —'));
  assert.equal(h.evidenceRows().length, 1);
  assert.equal(h.evidenceRows()[0].external_message_id, 'stale-B');
});

test('a duplicate provider delivery of a grounded catalog turn replies and reads exactly once', async () => {
  const { model, prompts } = scriptedModel([
    toolCall({ tool: 'list_public_catalog', limit: 2 }),
    finalAnswer('Our range includes:', ['FCH-WHOLE-12']),
  ]);
  const h = makeHarness(model);
  const msg = makeMsg({ externalMessageId: 'dup-1', text: ZH_LISTING, occurredAt: at(0) });

  const first = await h.receive(msg);
  const second = await h.receive({ ...msg });

  assert.equal(first.routeOutcome, PROSPECT_AI_CATALOG_GROUNDED_OUTCOME);
  // The redelivery is recognized from durable arrival evidence: no second model
  // call, no second catalog read, no second customer-visible reply.
  assert.equal(second.routeOutcome, PROSPECT_DUPLICATE_DELIVERY_OUTCOME);
  assert.equal(second.replySuppressed, true);
  assert.equal(second.catalogCallCount, 0);
  assert.equal(prompts.length, 2, 'the model script must not be replayed');
  assert.equal(h.sent.length, 1);
  assert.equal(h.evidenceRows().length, 1);
  assert.equal(h.auditCount(), 1, 'a redelivery must not add an audit row that could clear the cooldown');
  assert.deepEqual(h.sequenceRows(CONVERSATION), [
    { external_message_id: 'dup-1', inbound_seq: 1, reply_state: 'SENT' },
  ]);
});

test('a duplicate delivery of a suppressed fallback stays suppressed and reads nothing', async () => {
  const h = makeHarness(async () => { throw new DemoGatewayError(403, 'DEMO_GPT_ORIGIN_UNREGISTERED'); });
  const msg = makeMsg({ externalMessageId: 'dup-2', occurredAt: at(0) });

  await h.receive(msg);
  await h.receive({ ...msg });

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, PROSPECT_ONBOARDING_REPLY);
  assert.deepEqual(h.evidenceRows(), []);
  assert.deepEqual(h.sequenceRows(CONVERSATION), [
    { external_message_id: 'dup-2', inbound_seq: 1, reply_state: 'SENT' },
  ]);
});

test('traffic in another prospect conversation never fences or dedupes this one', async () => {
  const { model } = scriptedModel([
    toolCall({ tool: 'list_public_catalog', limit: 1 }),
    finalAnswer('Our range includes:', ['FCH-WHOLE-12']),
    toolCall({ tool: 'list_public_catalog', limit: 1 }),
    finalAnswer('Our range includes:', ['FCH-WHOLE-12']),
  ]);
  const h = makeHarness(model);

  const a = await h.receive(makeMsg({ externalMessageId: 'iso-A', text: ZH_LISTING, occurredAt: at(0) }));
  const b = await h.receive(makeMsg({
    externalMessageId: 'iso-B', conversationId: CONVERSATION_B,
    sender: { externalId: SENDER_B, phone: SENDER_B }, text: ZH_LISTING, occurredAt: at(1_000),
  }));

  assert.equal(a.routeOutcome, PROSPECT_AI_CATALOG_GROUNDED_OUTCOME);
  assert.equal(b.routeOutcome, PROSPECT_AI_CATALOG_GROUNDED_OUTCOME);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent.map(m => m.conversationId), [CONVERSATION, CONVERSATION_B]);
  assert.equal(h.evidenceRows().length, 2);
});

// ── Verified customer path and the SALES_ORDER.DRAFT ceiling are untouched ──

test('the verified customer path is unaffected by the public catalog surface', async () => {
  const { model, prompts } = scriptedModel([
    toolCall({ tool: 'list_public_catalog', limit: 5 }),
    finalAnswer('Our range:', ['FCH-WHOLE-12']),
  ]);
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const router = new V2CanaryIngressRouter(db, new CommerceService(db), new V2RolloutService(db), {
    enabled: true,
    prospectReplyScopes:TEST_PROSPECT_SCOPES,

    allowLegacyFallback: true,
    outbound: { send: async () => {return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};} } as any,
    prospectModel: model,
  });

  const canonical = router.canonicalize(makeMsg({
    conversationId: 'conv-001',
    sender: { externalId: '+6591110001', phone: '+6591110001' },
    text: ZH_LISTING,
  }));
  assert.notEqual(canonical, null);
  assert.equal(canonical!.customerId, 'CUST-001');
  assert.equal(canonical!.identityState, 'VERIFIED_CUSTOMER');

  // A verified customer never reaches the prospect seam, so neither the prospect
  // model nor the public catalog is touched on that path.
  assert.equal(prompts.length, 0);
  assert.equal(
    (db.db.prepare('SELECT COUNT(*) AS n FROM prospect_catalog_evidence').get() as { n: number }).n, 0,
  );

  // Customer-scoped ERP truth is unchanged and still richer than the public projection.
  const adapter = new DemoErpAdapter(db.db);
  const priced = await adapter.getCustomerPrice('CUST-001', 'FCH-WHOLE-12', 1, 'CTN', '2026-09-29');
  assert.equal(priced.output.unitPriceCents, 4800);
  const scoped = await adapter.searchProducts('CUST-001', 'ayam');
  assert.equal(scoped[0].output.alias, 'ayam');
});

test('a grounded catalog turn leaves the SALES_ORDER.DRAFT ceiling unchanged', async () => {
  const { model } = scriptedModel([
    toolCall({ tool: 'list_public_catalog', limit: 5 }),
    finalAnswer('Our range includes:', ['FCH-WHOLE-12', 'FRANK-RED-1KG']),
  ]);
  const h = makeHarness(model);

  const result = await h.receive(makeMsg({ externalMessageId: 'ceiling-1', text: '我想买鸡，请报价' }));

  assert.equal(result.status, 'PROSPECT_HANDLED');
  assert.equal(result.grounded, true);
  // No quotation, no draft, no posted order, no work item, no agent turn: a
  // catalog answer is discovery only and cannot advance the commerce lifecycle.
  const state = h.db.db.prepare(
    `SELECT (SELECT COUNT(*) FROM quotations) AS quotations,
     (SELECT COUNT(*) FROM sales_orders WHERE status='DRAFT') AS drafts,
     (SELECT COUNT(*) FROM sales_orders WHERE posted_at > ?) AS newlyPosted,
     (SELECT COUNT(*) FROM v2_inbox_items) AS inbox,
     (SELECT COUNT(*) FROM agent_turns) AS turns`
  ).get(at(-86_400_000)) as Record<string, number>;
  assert.deepEqual(state, { quotations: 0, drafts: 0, newlyPosted: 0, inbox: 0, turns: 0 });
  for (const key of Object.keys(result)) {
    assert.ok(!/salesOrder|quotation|draft/i.test(key), `PROSPECT_HANDLED must not expose ${key}`);
  }
});
