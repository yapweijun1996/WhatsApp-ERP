import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {V1Database} from '../src/database.js';
import {evaluateV3ContextShadow, assertV3ContextShadowGates, type ShadowConversationFixture} from '../src/v3-context-shadow-eval.js';

const A = 'demo-account', C = 'conv-001';
function fixture(count: number): {db: V1Database; fixture: ShadowConversationFixture} {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  const messageIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `shadow-${count}-${i}`; messageIds.push(id);
    db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,reply_to_external_message_id,account_id,occurred_at,raw_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, C, id, 'INBOUND', 'text', `chronology message ${i}`, 'shadow-sender', '+6500000000', null, A, `2026-09-10T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, 'shadow-raw');
  }
  return {db, fixture: {accountId: A, conversationId: C, inboundMessageId: messageIds[messageIds.length - 1], messageIds}};
}

test('CTX-006 evaluates a short conversation deterministically with exact authority parity and no effects', () => {
  const first = fixture(6); const a = evaluateV3ContextShadow(first.db.db, first.fixture); const b = evaluateV3ContextShadow(first.db.db, first.fixture);
  assertV3ContextShadowGates(a); assert.deepEqual(a, b); assert.equal(a.metrics.authorityParity.passed, true); assert.equal(a.metrics.zeroCustomerVisibleEffect.passed, true);
});

test('CTX-006 long conversation is deterministic and proves V2 bounded transcript versus source-linked V3 memory and budgeted model context', () => {
  const {db, fixture: input} = fixture(121); const result = evaluateV3ContextShadow(db.db, input); const replay = evaluateV3ContextShadow(db.db, input);
  assertV3ContextShadowGates(result); assert.deepEqual(result, replay); assert.ok(input.messageIds.length > 100); assert.equal(result.v2.transcriptMessages, 20); assert.equal(result.metrics.completeness.value, 1); assert.equal(result.v3.memory.rollingMemory.sourceMessageIds.length, 121); assert.ok(result.v3.modelFacingChars < result.v3.memory.rollingMemory.text.length + JSON.stringify(result.v3.memory).length); assert.ok(result.v3.plan.budget.usedContextTokens <= result.v3.plan.budget.availableContextTokens);
});

test('CTX-006 memory proposal is chronology/index-only and cross-scope sources fail closed', () => {
  const source = readFileSync(new URL('../src/v3-context-shadow-eval.ts', import.meta.url), 'utf8'); const proposal = source.slice(source.indexOf('function chronologyProposal'), source.indexOf('function freshnessInput')); assert.doesNotMatch(proposal, /same as|quotation|price|stock|keyword|regex/i);
  const {db, fixture: input} = fixture(6); const foreign = new V1Database(':memory:'); foreign.resetAndSeed();
  assert.throws(() => evaluateV3ContextShadow(foreign.db, input), /AGENT_CONTEXT|V3_CONTEXT|CONTEXT_PROJECTION|SOURCE/);
  void db;
});
