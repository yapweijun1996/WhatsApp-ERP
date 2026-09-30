import assert from 'node:assert/strict';
import test from 'node:test';
import { V1Database } from '../src/database.js';
import { DemoTextToolBridge, type DemoTextModelResult } from '../src/v2-demo-text-tool-bridge.js';
import { V2TransportRuntime } from '../src/v2-transport-runtime.js';
import { deriveAgentDecisionIdentity } from '../src/v2-transport-contract-helpers.js';
import { AgentTurnCoordinator } from '../src/v2-agent-turn-coordinator.js';
import { canonicalJson, canonicalSha256 } from '../src/v2-canonical.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const account = 'demo-account', conversation = 'conv-001';
const start = { accountId: account, conversationId: conversation, inboundMessageId: 'repair-in', profileId: 'sales-digital-employee', nowIso: '2026-09-09T09:00:00+08:00', timezone: 'Asia/Singapore' } as const;
function db() { const d = new V1Database(':memory:'); d.resetAndSeed(); d.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('repair-in',?,'repair-ext','INBOUND','text','hello',?,'2026-09-09T01:02:03Z')").run(conversation, account); return d; }
function measured(prompt: string, text: string): DemoTextModelResult { return { text, inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 }, outputBudget: { direction: 'output', bytes: Buffer.byteLength(text), tokenCount: 1 } }; }
function final(prompt: string) { const e = JSON.parse(prompt).expected; return JSON.stringify({ protocolVersion: 'v1', ...e, kind: 'final_response', responsePlan: { turnId: e.turnId, intent: 'ACKNOWLEDGE', connectiveText: 'Thank you.', factClaims: [], outboundPurpose: 'acknowledgement' } }); }
function bridge(outputs: (string | ((prompt: string) => string))[], calls: number[] = []) { return new DemoTextToolBridge({ measureInput: prompt => ({ direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 }), model: async prompt => { calls.push(1); const output = outputs.shift(); const text = typeof output === 'function' ? output(prompt) : output ?? '{}'; return measured(prompt, text); } }); }
function counts(database: V1Database) { return database.db.prepare('SELECT (SELECT count(*) FROM agent_model_attempts) attempts, (SELECT count(*) FROM agent_actions) actions, (SELECT count(*) FROM agent_action_results) results').get() as any; }

test('TRAN-006 repairs a malformed-output corpus only once and uses fixed safe outcomes', async () => {
  const corpus = [
    '{"kind":', 'prose {"kind":"tool_call"}', '```json\n{}\n```',
    '{"protocolVersion":"v1"}{"protocolVersion":"v1"}',
    '{"protocolVersion":"v1","protocolVersion":"v1"}',
  ];
  for (const malformed of corpus) {
    const database = db(); const calls: number[] = [];
    const outcome = await new V2TransportRuntime(database, { transport: bridge([malformed, p => final(p)], calls), execute: () => { throw new Error('must not execute'); } }).run(start);
    assert.equal(outcome.status, 'TERMINAL', malformed);
    assert.deepEqual(counts(database), { attempts: 2, actions: 0, results: 0 });
    assert.equal(database.db.prepare("SELECT attempt_kind FROM agent_model_attempts WHERE attempt_kind='REPAIR'").get()?.attempt_kind, 'REPAIR');
  }
});

test('TRAN-006 identity mismatch is one MODEL only and never a REPAIR or action', async () => {
  const database = db(); let calls = 0;
  const outcome = await new V2TransportRuntime(database, { transport: bridge([() => {
    calls += 1;
    return JSON.stringify({ protocolVersion: 'v1', turnId: 'wrong', sequence: 1, correlationId: 'wrong', actionId: 'wrong', kind: 'final_response', responsePlan: {} });
  }]), execute: () => undefined }).run(start);
  assert.equal(outcome.status, 'FAIL_CLOSED'); assert.equal(calls, 1);
  assert.equal(database.db.prepare("SELECT count(*) FROM agent_model_attempts WHERE attempt_kind='REPAIR'").get()?.['count(*)'], 0);
  assert.equal(database.db.prepare('SELECT count(*) FROM agent_actions').get()?.['count(*)'], 0);
});

test('TRAN-006 rejects non-repairable provider, secret, measurement, capability, and host errors without retry', async () => {
  const cases: Array<[string, string]> = [
    ['provider', 'MODEL_FAILED'], ['secret', 'MODEL_OUTPUT_SECRET'], ['oversized', 'OUTPUT_SIZE'],
    ['unknown capability', 'UNKNOWN_OR_UNAVAILABLE_CAPABILITY'], ['host projection', 'CAPABILITY_PROJECTION_FIELDS'],
  ];
  for (const [, expected] of cases) {
    const database = db(); const transport = { mode: 'demo-text', id: `nonrepair-${expected}`, decide: async () => { throw new Error(`DEMO_TEXT_BRIDGE_FAILED:${expected}`); } } as any;
    const outcome = await new V2TransportRuntime(database, { transport, execute: () => { throw new Error('must not execute'); } }).run(start);
    assert.equal(outcome.status, 'FAIL_CLOSED');
    assert.equal(counts(database).attempts, 1);
  }
  const provider = { mode: 'demo-text', id: 'provider-failure', decide: async () => { throw new Error('provider/network'); } } as any;
  const failed = await new V2TransportRuntime(db(), { transport: provider, execute: () => undefined }).run(start);
  assert.equal(failed.reasonCode, 'PI_MODEL_FAILED');
});

test('TRAN-006 repaired tool calls enter the existing host executor path only after repair', async () => {
  const database = db(); let executions = 0;
  const tool = (prompt: string) => { const e = JSON.parse(prompt).expected; return JSON.stringify({ protocolVersion: 'v1', ...e, kind: 'tool_call', name: 'get_customer_context', arguments: { accountId: account, conversationId: conversation, customerId: 'CUST-001' } }); };
  const transport = bridge(['not json', tool, p => final(p)]);
  const outcome = await new V2TransportRuntime(database, { transport, encodeHostCapabilityResult: value => transport.encodeHostCapabilityResult(value), execute: () => { executions += 1; return { status: 'SUCCEEDED', data: {}, evidence: [], stateChanges: [] }; } }).run(start);
  assert.equal(outcome.status, 'TERMINAL', JSON.stringify(outcome)); assert.equal(executions, 1); assert.deepEqual(counts(database), { attempts: 3, actions: 1, results: 1 });
});

test('TRAN-006 second malformed output is exactly MODEL plus REPAIR, with zero actions/results', async () => {
  const database = db(); const outcome = await new V2TransportRuntime(database, { transport: bridge(['bad', 'still bad', 'must not run']), execute: () => { throw new Error('must not execute'); } }).run(start);
  assert.equal(outcome.reasonCode, 'PI_BUDGET_EXHAUSTED_HANDOFF'); assert.deepEqual(counts(database), { attempts: 2, actions: 0, results: 0 });
});

test('TRAN-006 respects maxRepairAttempts, maxModelTurns, cancellation, and timeout during repair', async () => {
  for (const budgets of [{ maxRepairAttempts: 0 }, { maxModelTurns: 1 }]) {
    const database = db(); const row = database.db.prepare('SELECT turn_budgets_json FROM employee_profiles WHERE id=?').get('sales-digital-employee') as any;
    database.db.prepare('UPDATE employee_profiles SET turn_budgets_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.turn_budgets_json), ...budgets }), 'sales-digital-employee');
    const outcome = await new V2TransportRuntime(database, { transport: bridge(['bad', 'must not run']), execute: () => undefined }).run(start);
    assert.equal(outcome.reasonCode, 'PI_BUDGET_EXHAUSTED_HANDOFF'); assert.equal(counts(database).attempts, 1);
  }
  const controller = new AbortController(); let calls = 0;
  const transport = new DemoTextToolBridge({ measureInput: prompt => ({ direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 }), model: async prompt => { calls += 1; if (calls === 1) return measured(prompt, 'bad'); await new Promise(resolve => setTimeout(resolve, 50)); return measured(prompt, final(prompt)); } });
  const pending = new V2TransportRuntime(db(), { transport }).run(start, controller.signal); setTimeout(() => controller.abort(), 5); const cancelled = await pending;
  assert.equal(cancelled.reasonCode, 'PI_CANCELLED'); assert.equal(calls, 2);
});

test('TRAN-006 restart cannot reset the durable repair ledger or widen the same-observation boundary', async () => {
  const database = db(); const first = bridge(['bad', 'still bad']);
  const outcome = await new V2TransportRuntime(database, { transport: first, execute: () => undefined }).run(start);
  assert.equal(outcome.reasonCode, 'PI_BUDGET_EXHAUSTED_HANDOFF');
  const replay = await new V2TransportRuntime(database, { transport: bridge([p => final(p)]), execute: () => undefined }).run(start);
  assert.equal(replay.status, 'TERMINAL'); assert.equal(replay.responsePlan?.intent, 'HANDOFF'); assert.equal(counts(database).attempts, 2);
  const observation: any = { turnId: 'scope', sequence: 1, context: {}, availableCapabilities: [], completedActions: [] };
  const boundary = bridge(['bad', p => final(p)]);
  await assert.rejects(() => boundary.decide(observation));
  await assert.rejects(() => boundary.decide({ ...observation, context: { widened: true } }), /REPAIR_SCOPE_MISMATCH/);
});

test('TRAN-006 file-backed crash after malformed classification resumes only the pending repair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tran006-pending-')), file = join(dir, 'db.sqlite');
  try {
    let database = db(); database.db.close(); database = new V1Database(file); database.resetAndSeed();
    database.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('repair-in',?,'repair-ext','INBOUND','text','hello',?,'2026-09-09T01:02:03Z')").run(conversation, account);
    const coordinator = new AgentTurnCoordinator(database), projection = coordinator.start(start), runtime = new V2TransportRuntime(database, { transport: bridge(['unused']), execute: () => undefined });
    const observation = (runtime as any).observation(projection), hashes = { observationHash: canonicalSha256(canonicalJson(observation)), projectionHash: canonicalSha256(canonicalJson(observation.availableCapabilities)) };
    const modelSequence = coordinator.reserveModelAttempt({ turnId: projection.turnId, kind: 'MODEL', reasonCode: 'CRASH_WINDOW_MODEL' });
    coordinator.recordRepairPending({ turnId: projection.turnId, decisionSequence: modelSequence, ...hashes }); database.db.close();
    database = new V1Database(file); let calls = 0;
    const out = await new V2TransportRuntime(database, { transport: bridge([p => final(p)], []), execute: () => undefined }).run(start);
    calls += Number(database.db.prepare("SELECT count(*) FROM agent_model_attempts WHERE attempt_kind='REPAIR'").get()?.['count(*)'] ?? 0);
    assert.equal(out.status, 'TERMINAL'); assert.equal(calls, 1); assert.deepEqual(counts(database), { attempts: 2, actions: 0, results: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TRAN-006 file-backed crash after repair reservation makes zero additional provider calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tran006-reserved-')), file = join(dir, 'db.sqlite');
  try {
    let database = new V1Database(file); database.resetAndSeed(); database.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('repair-in',?,'repair-ext','INBOUND','text','hello',?,'2026-09-09T01:02:03Z')").run(conversation, account);
    const coordinator = new AgentTurnCoordinator(database), projection = coordinator.start(start), runtime = new V2TransportRuntime(database, { transport: bridge(['unused']), execute: () => undefined });
    const observation = (runtime as any).observation(projection), hashes = { observationHash: canonicalSha256(canonicalJson(observation)), projectionHash: canonicalSha256(canonicalJson(observation.availableCapabilities)) }, modelSequence = coordinator.reserveModelAttempt({ turnId: projection.turnId, kind: 'MODEL', reasonCode: 'CRASH_WINDOW_MODEL' });
    coordinator.recordRepairPending({ turnId: projection.turnId, decisionSequence: modelSequence, ...hashes }); coordinator.reserveRepairAttempt({ turnId: projection.turnId, decisionSequence: modelSequence, ...hashes, reasonCode: 'CRASH_WINDOW_REPAIR' }); database.db.close();
    database = new V1Database(file); let calls = 0; const transport = bridge([p => { calls += 1; return final(p); }]);
    const out = await new V2TransportRuntime(database, { transport, execute: () => undefined }).run(start);
    assert.equal(out.reasonCode, 'PI_REPAIR_RECOVERY_HANDOFF'); assert.equal(calls, 0); assert.deepEqual(counts(database), { attempts: 2, actions: 0, results: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TRAN-006 file-backed ordinary MODEL reservation or valid outcome never replays the provider call', async () => {
  for (const phase of ['RESERVED', 'VALID'] as const) {
    const dir = mkdtempSync(join(tmpdir(), `tran006-model-${phase.toLowerCase()}-`)), file = join(dir, 'db.sqlite');
    try {
      let database = new V1Database(file); database.resetAndSeed();
      database.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('repair-in',?,'repair-ext','INBOUND','text','hello',?,'2026-09-09T01:02:03Z')").run(conversation, account);
      const coordinator = new AgentTurnCoordinator(database), projection = coordinator.start(start), runtime = new V2TransportRuntime(database, { transport: bridge(['unused']), execute: () => undefined });
      const observation = (runtime as any).observation(projection), hashes = { observationHash: canonicalSha256(canonicalJson(observation)), projectionHash: canonicalSha256(canonicalJson(observation.availableCapabilities)) };
      const sequence = coordinator.reserveModelAttempt({ turnId: projection.turnId, kind: 'MODEL', reasonCode: `CRASH_WINDOW_${phase}`, ...hashes });
      if (phase === 'VALID') coordinator.recordModelValid({ turnId: projection.turnId, sequence, ...hashes });
      database.db.close(); database = new V1Database(file); let calls = 0;
      const out = await new V2TransportRuntime(database, { transport: bridge([p => { calls += 1; return final(p); }]), execute: () => undefined }).run(start);
      assert.equal(out.status, 'FAIL_CLOSED'); assert.equal(calls, 0); assert.equal(counts(database).attempts, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('TRAN-006 file-backed VALID repair uncertainty never replays the provider call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tran006-valid-')), file = join(dir, 'db.sqlite');
  try {
    let database = new V1Database(file); database.resetAndSeed();
    database.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('repair-in',?,'repair-ext','INBOUND','text','hello',?,'2026-09-09T01:02:03Z')").run(conversation, account);
    const coordinator = new AgentTurnCoordinator(database), projection = coordinator.start(start), runtime = new V2TransportRuntime(database, { transport: bridge(['unused']), execute: () => undefined });
    const observation = (runtime as any).observation(projection), hashes = { observationHash: canonicalSha256(canonicalJson(observation)), projectionHash: canonicalSha256(canonicalJson(observation.availableCapabilities)) }, modelSequence = coordinator.reserveModelAttempt({ turnId: projection.turnId, kind: 'MODEL', reasonCode: 'CRASH_WINDOW_MODEL', ...hashes });
    coordinator.recordRepairPending({ turnId: projection.turnId, decisionSequence: modelSequence, ...hashes }); coordinator.reserveRepairAttempt({ turnId: projection.turnId, decisionSequence: modelSequence, ...hashes, reasonCode: 'CRASH_WINDOW_REPAIR' }); coordinator.recordRepairValid({ turnId: projection.turnId, decisionSequence: modelSequence, ...hashes });
    database.db.close(); database = new V1Database(file); let calls = 0;
    const out = await new V2TransportRuntime(database, { transport: bridge([p => { calls += 1; return final(p); }]), execute: () => undefined }).run(start);
    assert.equal(out.reasonCode, 'PI_REPAIR_RECOVERY_HANDOFF'); assert.equal(calls, 0); assert.equal(counts(database).attempts, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TRAN-006 recovery maps MODEL attempts to decision sequence across a prior repair', () => {
  const database = db(), coordinator = new AgentTurnCoordinator(database), projection = coordinator.start(start);
  const firstHash = { observationHash: '1'.repeat(64), projectionHash: 'a'.repeat(64) };
  const firstModel = coordinator.reserveModelAttempt({ turnId: projection.turnId, kind: 'MODEL', reasonCode: 'FIRST', ...firstHash });
  coordinator.recordModelValid({ turnId: projection.turnId, sequence: firstModel, ...firstHash });
  coordinator.propose({ turnId: projection.turnId, sequence: 1, actionId: 'repair-map-action-1', capability: { name: 'get_customer_context', version: 'v1' }, arguments: { accountId: account, conversationId: conversation, customerId: 'CUST-001' }, idempotencyKey: 'repair-map-1' });
  coordinator.recordResult({ turnId: projection.turnId, actionId: 'repair-map-action-1', sequence: 1, result: { status: 'SUCCEEDED', data: {}, evidence: [], stateChanges: [] } });
  const secondHash = { observationHash: '2'.repeat(64), projectionHash: 'b'.repeat(64) };
  const secondModel = coordinator.reserveModelAttempt({ turnId: projection.turnId, kind: 'MODEL', reasonCode: 'SECOND', ...secondHash });
  coordinator.recordRepairPending({ turnId: projection.turnId, decisionSequence: secondModel, ...secondHash });
  coordinator.reserveRepairAttempt({ turnId: projection.turnId, decisionSequence: secondModel, ...secondHash, reasonCode: 'SECOND_REPAIR' });
  coordinator.recordRepairValid({ turnId: projection.turnId, decisionSequence: secondModel, ...secondHash });
  coordinator.propose({ turnId: projection.turnId, sequence: 2, actionId: 'repair-map-action-2', capability: { name: 'get_order_history', version: 'v1' }, arguments: { accountId: account, conversationId: conversation, customerId: 'CUST-001', limit: 1 }, idempotencyKey: 'repair-map-2' });
  coordinator.recordRepairCommitted({ turnId: projection.turnId, decisionSequence: secondModel, ...secondHash });
  coordinator.recordResult({ turnId: projection.turnId, actionId: 'repair-map-action-2', sequence: 2, result: { status: 'SUCCEEDED', data: {}, evidence: [], stateChanges: [] } });
  const thirdHash = { observationHash: '3'.repeat(64), projectionHash: 'c'.repeat(64) };
  const thirdModel = coordinator.reserveModelAttempt({ turnId: projection.turnId, kind: 'MODEL', reasonCode: 'THIRD', ...thirdHash });
  coordinator.recordModelValid({ turnId: projection.turnId, sequence: thirdModel, ...thirdHash });
  coordinator.propose({ turnId: projection.turnId, sequence: 3, actionId: 'repair-map-action-3', capability: { name: 'get_commerce_status', version: 'v1' }, arguments: { accountId: account, conversationId: conversation, customerId: 'CUST-001' }, idempotencyKey: 'repair-map-3' });
  coordinator.recordResult({ turnId: projection.turnId, actionId: 'repair-map-action-3', sequence: 3, result: { status: 'SUCCEEDED', data: {}, evidence: [], stateChanges: [] } });
  assert.equal(thirdModel, 4);
  assert.equal(coordinator.modelAttemptRecovery(projection.turnId), 'REFLECTED');
});

test('TRAN-006 reset clears coordinator-recorded MODEL evidence before attempts', () => {
  const database = db(), coordinator = new AgentTurnCoordinator(database), projection = coordinator.start(start);
  const observationHash = 'a'.repeat(64), projectionHash = 'b'.repeat(64);
  const sequence = coordinator.reserveModelAttempt({ turnId: projection.turnId, kind: 'MODEL', reasonCode: 'RESET_REGRESSION', observationHash, projectionHash });
  coordinator.recordModelValid({ turnId: projection.turnId, sequence, observationHash, projectionHash });
  assert.equal(database.db.prepare('SELECT count(*) n FROM agent_model_attempt_evidence').get()?.n, 1);
  assert.equal(database.db.prepare('SELECT count(*) n FROM agent_model_attempts').get()?.n, 1);

  assert.doesNotThrow(() => database.resetAndSeed());
  assert.equal(database.db.prepare('SELECT count(*) n FROM agent_model_attempt_evidence').get()?.n, 0);
  assert.equal(database.db.prepare('SELECT count(*) n FROM agent_model_attempts').get()?.n, 0);
  assert.equal(database.db.prepare("SELECT count(*) n FROM channel_accounts WHERE id='demo-account'").get()?.n, 1);
});

test('TRAN-006 repair evidence is coordinator-gated and immutable', () => {
  const database = db(), coordinator = new AgentTurnCoordinator(database), projection = coordinator.start(start);
  assert.throws(() => database.db.prepare("INSERT INTO agent_repair_evidence VALUES('raw',?,?,1,'a','b','PENDING','now')").run(projection.turnId, 1), /AGENT_REPAIR_EVIDENCE_INSERT_REQUIRES_COORDINATOR/);
  const observation = { turnId: projection.turnId, sequence: 1, context: {}, availableCapabilities: [], completedActions: [] } as any, hashes = { observationHash: 'a', projectionHash: 'b' };
  coordinator.reserveModelAttempt({ turnId: projection.turnId, kind: 'MODEL', reasonCode: 'RAW_TEST' }); coordinator.recordRepairPending({ turnId: projection.turnId, decisionSequence: 1, ...hashes });
  assert.throws(() => database.db.prepare('UPDATE agent_repair_evidence SET phase=\'FAILED\'').run(), /IMMUTABLE_AGENT_REPAIR_EVIDENCE/);
  assert.throws(() => database.db.prepare('DELETE FROM agent_repair_evidence').run(), /IMMUTABLE_AGENT_REPAIR_EVIDENCE/); void observation;
});
