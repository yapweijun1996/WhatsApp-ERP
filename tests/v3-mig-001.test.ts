import assert from 'node:assert/strict';
import test from 'node:test';
import { V3ShadowRollout } from '../src/v3-shadow-rollout.js';

const a = { accountId: 'account-a', conversationId: 'conversation-a' } as const;
const b = { accountId: 'account-b', conversationId: 'conversation-b' } as const;

test('MIG-001 defaults to OFF and records no shadow observation', () => {
  const rollout = new V3ShadowRollout();
  assert.equal(rollout.select(a).effectiveMode, 'OFF');
  const result = { status: 'TERMINAL', answer: 'V2' };
  assert.strictEqual(rollout.runShadowOnly(a, result, () => { throw Error('must not run'); }), result);
  assert.deepEqual(rollout.telemetry(a), { scope: a, mode: 'OFF', observations: 0, completed: 0, failed: 0, lastEventKind: null });
});

test('MIG-001 selects conversation scope over account scope and exposes bounded telemetry', () => {
  const rollout = new V3ShadowRollout();
  rollout.configure({ accountId: a.accountId }, 'SHADOW');
  rollout.configure(a, 'SHADOW');
  assert.deepEqual(rollout.select(a), { configuredMode: 'SHADOW', effectiveMode: 'SHADOW', configuredScope: a });
  let seen: unknown;
  const result = { status: 'TERMINAL', answer: 'V2' };
  rollout.runShadowOnly(a, result, observation => { seen = observation; });
  assert.deepEqual(seen, { eventKind: 'V2_RESULT', resultClass: 'TERMINAL' });
  assert.deepEqual(rollout.telemetry(a), { scope: a, mode: 'SHADOW', observations: 1, completed: 1, failed: 0, lastEventKind: 'V2_RESULT' });
});

test('MIG-001 isolates account and conversation scopes', () => {
  const rollout = new V3ShadowRollout();
  rollout.configure({ accountId: a.accountId }, 'SHADOW');
  assert.equal(rollout.select(a).effectiveMode, 'SHADOW');
  assert.equal(rollout.select(b).effectiveMode, 'OFF');
  assert.equal(rollout.telemetry(b).observations, 0);
});

test('MIG-001 shadow execution cannot mutate, send, or replace the V2 result', () => {
  const rollout = new V3ShadowRollout();
  rollout.configure(a, 'SHADOW');
  const v2Result = Object.freeze({ status: 'TERMINAL', answer: 'authoritative V2 response' });
  let sends = 0;
  const returned = rollout.runShadowOnly(a, v2Result, observation => {
    assert.equal(Object.isFrozen(observation), true);
    sends += 1;
    assert.throws(() => (observation as { resultClass: string }).resultClass = 'FAIL_CLOSED');
    return { status: 'SHADOW_REPLACEMENT', send: true };
  });
  assert.strictEqual(returned, v2Result);
  assert.equal(sends, 1);
  assert.equal(v2Result.answer, 'authoritative V2 response');
});
