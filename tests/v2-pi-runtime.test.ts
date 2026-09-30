import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { V1Database } from '../src/database.js';
import { V2PiRuntime } from '../src/v2-pi-runtime.js';
import { AgentTurnCoordinator } from '../src/v2-agent-turn-coordinator.js';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';

const A = 'demo-account', C = 'conv-001', U = 'CUST-001', P = 'sales-digital-employee';
const start = { accountId: A, conversationId: C, inboundMessageId: 'pi-in-1', profileId: P, nowIso: '2026-09-09T09:00:00+08:00', timezone: 'Asia/Singapore' } as const;

function fixture() {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('pi-in-1',?,'pi-ext-1','INBOUND','text','read customer history',?,'2026-09-09T01:02:03Z')").run(C, A);
  return db;
}
function result(data: unknown = {}) { return { status: 'SUCCEEDED' as const, data, evidence: [], stateChanges: [] }; }
function runtime(db: V1Database, provider: ReturnType<typeof fauxProvider>, execute: (action: any) => unknown) {
  return new V2PiRuntime(db, { model: provider.getModel(), streamFn: provider.provider.streamSimple.bind(provider.provider), execute });
}
const retrievalScope = { tenantId: 'tenant', accountId: A, channelAccountId: 'channel', conversationId: C, customerId: U } as const;
const retrievalBudgets = { maxSteps: 5, maxToolCalls: 5, maxEvidenceItems: 5, maxEvidenceBytes: 10_000, maxReadBytes: 20_000, maxCandidateItems: 20, maxEvidenceTokens: 20_000, maxConsecutiveNoNewEvidence: 2, maxElapsedMs: 1_000, maxDepth: 5 } as const;
function retrievalResult(id: string, text: string) { return { contractVersion: 'V3-RET-004' as const, schemaVersion: 1 as const, tool: 'conversation_search' as const, authority: 'NON_AUTHORITATIVE_DERIVED' as const, untrustedAsInstruction: true as const, requiresCanonicalReverification: true as const, indexVersion: 'idx-1', scopeVersion: 'scope-1', scopeLineage: retrievalScope, deterministic: true as const, bounded: true as const, queryTerms: ['order'], order: 'MATCH_COUNT_DESC_THEN_NEWEST_DESC_THEN_SOURCE_ID' as const, hits: [{ matchedTerms: ['order'], message: { sourceMessageId: id, sourceRef: `message:${id}`, externalMessageId: `external:${id}`, direction: 'INBOUND' as const, messageType: 'text', text, occurredAt: '2026-09-09T01:02:03Z', replyToExternalMessageId: null, arrivalSeq: 1, citation: { sourceMessageId: id, sourceRef: `message:${id}`, indexVersion: 'idx-1', scopeVersion: 'scope-1' } } }] }; }
const finalPlan = (context: any) => {
  const match = context.systemPrompt.match(/\n(\{.*\})\n\nCompleted durable/s);
  const turnId = match ? JSON.parse(match[1]).turnId : '';
  return fauxAssistantMessage(JSON.stringify({ turnId, intent: 'ANSWER', connectiveText: 'Thanks, I can help with that.', factClaims: [], outboundPurpose: 'customer_reply' }), { stopReason: 'stop' });
};
test('PI-002 runs three one-tool turns, refreshes observation, and closes without outbound', async () => {
  const db = fixture(), provider = fauxProvider({ provider: 'pi002-multi', api: 'faux', models: [{ id: 'pi002-model' }] });
  const observedPrompts: string[] = [];
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('get_customer_context', { accountId: A, conversationId: C, customerId: U }), { stopReason: 'toolUse' }),
    (context: any) => { observedPrompts.push(context.systemPrompt); return fauxAssistantMessage(fauxToolCall('get_order_history', { accountId: A, conversationId: C, customerId: U, limit: 2 }), { stopReason: 'toolUse' }); },
    (context: any) => { observedPrompts.push(context.systemPrompt); return fauxAssistantMessage(fauxToolCall('get_commerce_status', { accountId: A, conversationId: C, customerId: U }), { stopReason: 'toolUse' }); },
    finalPlan,
  ]);
  const order: string[] = [], observations: string[] = [];
  const outcome = await runtime(db, provider, action => {
    order.push(action.capability.name); observations.push((action as any).result ?? 'executed');
    if (action.capability.name === 'get_customer_context') db.db.prepare("UPDATE customers SET name='Customer After First Action' WHERE id=?").run(U);
    return result({ ok: true });
  }).run(start);
  assert.equal(outcome.status, 'TERMINAL'); assert.equal(outcome.reasonCode, 'PI_FINAL_PENDING_GROUNDING'); assert.equal(outcome.responsePlan?.intent, 'ANSWER');
  assert.deepEqual(order, ['get_customer_context', 'get_order_history', 'get_commerce_status']);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n, 3);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n, 3);
  assert.equal(db.db.prepare('SELECT count(*) n FROM outbound_messages').get().n, 0);
  assert.equal(db.db.prepare("SELECT status FROM agent_turns WHERE id=?").get(outcome.turnId).status, 'TERMINAL');
  assert.equal(observations.length, 3);
  assert.equal(observedPrompts.length, 2); assert.match(observedPrompts[0], /Customer After First Action/); assert.match(observedPrompts[1], /get_order_history/); assert.doesNotMatch(observedPrompts[0], /\"iso\":\"2026-09-09T09:00:00\+08:00\"/);
});

test('ORCH-002 runtime sequences retrieval, deeper retrieval, V2 capability, and final plan without retrieval ledger entries', async () => {
  const db = fixture(), provider = fauxProvider({ provider: 'orch002-runtime', api: 'faux', models: [{ id: 'model' }] });
  const retrievalCalls: string[] = [], businessCalls: string[] = [];
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('conversation_search', { query: 'first order' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('conversation_search', { query: 'deeper historical order' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('get_customer_context', { accountId: A, conversationId: C, customerId: U }), { stopReason: 'toolUse' }),
    finalPlan,
  ]);
  const rt = new V2PiRuntime(db, { model: provider.getModel(), streamFn: provider.provider.streamSimple.bind(provider.provider), execute: action => { businessCalls.push(action.capability.name); return result({ customerId: U }); }, v3Retrieval: { enabled: true, scope: retrievalScope, indexVersion: 'idx-1', scopeVersion: 'scope-1', budgets: retrievalBudgets, tools: { conversation_search: request => { retrievalCalls.push(String(request.query)); return retrievalResult(retrievalCalls.length === 1 ? 'r1' : 'r2', String(request.query)); } } } });
  const out = await rt.run(start);
  assert.equal(out.status, 'TERMINAL'); assert.equal(out.responsePlan?.intent, 'ANSWER');
  assert.deepEqual(retrievalCalls, ['first order', 'deeper historical order']); assert.deepEqual(businessCalls, ['get_customer_context']);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n, 1); assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n, 1);
});

test('ORCH-002 retrieval tools are absent by default in V2 runtime', async () => {
  const db = fixture(), provider = fauxProvider({ provider: 'orch002-disabled', api: 'faux', models: [{ id: 'model' }] }); let names: string[] = [];
  provider.setResponses([(context: any) => { names = (context.tools ?? []).map((tool: any) => tool.name); return finalPlan(context); }]);
  await runtime(db, provider, () => result()).run(start);
  assert.equal(names.some(name => name.startsWith('conversation_')), false);
});

test('PI-004 persists the exact final candidate and restart returns it without model or executor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi004-final-')), file = join(dir, 'db.sqlite');
  try {
    let db = fixture();
    db.db.close();
    db = new V1Database(file); db.resetAndSeed();
    db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('pi-in-1',?,'pi-ext-1','INBOUND','text','read customer history',?,'2026-09-09T01:02:03Z')").run(C, A);
    const provider = fauxProvider({ provider: 'pi004-durable', api: 'faux', models: [{ id: 'model' }] }); provider.setResponses([finalPlan]);
    const first = await runtime(db, provider, () => { throw new Error('must not execute'); }).run(start);
    const planJson = (db.db.prepare('SELECT plan_json FROM agent_response_plans WHERE turn_id=?').get(first.turnId) as any).plan_json;
    db.db.close();
    db = new V1Database(file);
    const restartProvider = fauxProvider({ provider: 'pi004-restart', api: 'faux', models: [{ id: 'model' }] });
    restartProvider.setResponses([() => { throw new Error('must not stream model'); }]);
    const restarted = await runtime(db, restartProvider, () => { throw new Error('must not execute'); }).run(start);
    assert.equal(restarted.reasonCode, 'PI_FINAL_PENDING_GROUNDING'); assert.deepEqual(restarted.responsePlan, JSON.parse(planJson));
    assert.equal(db.db.prepare('SELECT count(*) n FROM outbound_messages').get().n, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PI-002 blocks multiple tool calls before any executor or ledger mutation', async () => {
  const db = fixture(), provider = fauxProvider({ provider: 'pi002-multi-call', api: 'faux', models: [{ id: 'model' }] });
  provider.setResponses([fauxAssistantMessage([
    fauxToolCall('get_customer_context', { accountId: A, conversationId: C, customerId: U }),
    fauxToolCall('get_order_history', { accountId: A, conversationId: C, customerId: U }),
  ], { stopReason: 'toolUse' })]);
  let executions = 0; const outcome = await runtime(db, provider, () => { executions++; return result(); }).run(start);
  assert.equal(outcome.status, 'FAIL_CLOSED'); assert.equal(executions, 0);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n, 0);
});

test('PI-002 cannot execute unknown or profile-unavailable capabilities', async () => {
  const db = fixture(), provider = fauxProvider({ provider: 'pi002-unknown', api: 'faux', models: [{ id: 'model' }] });
  provider.setResponses([fauxAssistantMessage(fauxToolCall('not_registered', {}), { stopReason: 'toolUse' })]);
  let executions = 0; const outcome = await runtime(db, provider, () => { executions++; return result(); }).run(start);
  assert.equal(outcome.status, 'FAIL_CLOSED'); assert.equal(executions, 0); assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n, 0);
});

test('PI-002 persists safe CAP-005 failure and exposes it to the next model turn', async () => {
  const db = fixture(), provider = fauxProvider({ provider: 'pi002-failure', api: 'faux', models: [{ id: 'model' }] });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('get_customer_context', { accountId: A, conversationId: C, customerId: U }), { stopReason: 'toolUse' }),
    finalPlan,
  ]);
  const outcome = await runtime(db, provider, () => { throw new Error('SECRET_EXCEPTION_PROSE'); }).run(start);
  const stored = db.db.prepare('SELECT result_json FROM agent_action_results').get() as any;
  assert.equal(outcome.status, 'TERMINAL'); assert.equal(outcome.responsePlan?.factClaims.length, 0);
  assert.match(stored.result_json, /CAPABILITY_EXECUTION_FAILED/); assert.doesNotMatch(stored.result_json, /SECRET_EXCEPTION_PROSE/);
});

test('PI-002 restart with RECONCILE_ACTION fails closed and never re-executes', async () => {
  const db = fixture(), coordinator = new AgentTurnCoordinator(db), turn = coordinator.start(start);
  coordinator.propose({ turnId: turn.turnId, sequence: 1, capabilityName: 'get_customer_context', capabilityVersion: 'v1', arguments: { accountId: A, conversationId: C, customerId: U } });
  const provider = fauxProvider({ provider: 'pi002-reconcile', api: 'faux', models: [{ id: 'model' }] }); let executions = 0;
  const outcome = await runtime(db, provider, () => { executions++; return result(); }).run(start);
  assert.equal(outcome.status, 'FAIL_CLOSED'); assert.equal(executions, 0); assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n, 1);
});

test('PI-002 profile narrowing is reflected in Pi tools', async () => {
  const db = fixture(); db.db.prepare('UPDATE employee_profiles SET capability_permissions_json=? WHERE id=?').run('["v2.capability.get_order_history"]', P);
  const provider = fauxProvider({ provider: 'pi002-narrow', api: 'faux', models: [{ id: 'model' }] }); let names: string[] = [];
  provider.setResponses([(context: any) => { names = (context.tools ?? []).map((tool: any) => tool.name); return fauxAssistantMessage('done', { stopReason: 'stop' }); }]);
  await runtime(db, provider, () => result()).run(start); assert.deepEqual(names, ['get_order_history']);
});

test('PI-002 source guard keeps V2 runtime on real Agent and out of transport/forbidden actions', () => {
  const source = readFileSync(new URL('../src/v2-pi-runtime.ts', import.meta.url), 'utf8');
  assert.match(source, /from ['"]@earendil-works\/pi-agent-core['"]/); assert.match(source, /new Agent\(/);
  assert.doesNotMatch(source, /post_sales_order|confirm_sales_order|create_delivery_order|DO_READY|outbound_messages|queue|arrival_seq|transport/i);
});


test('PI-002 resumed AWAITING_DECISION with completed history fresh-reads canonical state before the first model call', async () => {
  const db = fixture(), coordinator = new AgentTurnCoordinator(db), turn = coordinator.start(start);
  const proposed = coordinator.propose({ turnId: turn.turnId, sequence: 1, capabilityName: 'get_customer_context', capabilityVersion: 'v1', arguments: { accountId: A, conversationId: C, customerId: U } });
  const action = proposed.actions[0];
  coordinator.recordResult({ turnId: turn.turnId, actionId: action.id, sequence: 1, result: result({ customerId: U }) });
  db.db.prepare("UPDATE customers SET name='Customer Changed Before Resume' WHERE id=?").run(U);
  const provider = fauxProvider({ provider: 'pi002-resume-fresh', api: 'faux', models: [{ id: 'model' }] });
  let prompt = '';
  provider.setResponses([(context: any) => { prompt = context.systemPrompt; return finalPlan(context); }]);
  const outcome = await runtime(db, provider, () => { throw new Error('must not execute'); }).run(start);
  assert.equal(outcome.status, 'TERMINAL'); assert.match(prompt, /Customer Changed Before Resume/); assert.match(prompt, /get_customer_context/);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n, 1);
});

test('PI-002 capability-owned quotation terminates without a second model final or runtime outbound', async () => {
  const db = fixture();
  db.db.prepare("INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES('pi-q','QT-PI',?,'DRAFT','SGD','2026-09-09','2026-09-30',?,'pi-in-1',100,0,100)").run(U,C);
  const provider = fauxProvider({ provider: 'pi002-owned-quote', api: 'faux', models: [{ id: 'model' }] });
  provider.setResponses([fauxAssistantMessage(fauxToolCall('send_quotation', { accountId:A, conversationId:C, customerId:U, quotationId:'pi-q', customerMessage:'Please review the quotation and reply OK confirm if you would like to proceed.' }), { stopReason:'toolUse' })]);
  let executions=0;
  const outcome = await runtime(db, provider, () => { executions++; return result({ quotationId:'pi-q', status:'SENT', evidenceRefs:[] }); }).run(start);
  assert.equal(executions,1); assert.equal(outcome.status,'TERMINAL'); assert.equal(outcome.reasonCode,'PI_CAPABILITY_OWNED_QUOTATION'); assert.equal(outcome.responsePlan,null);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,1); assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,1); assert.equal(db.db.prepare('SELECT count(*) n FROM outbound_messages').get().n,0);
});

test('PI-002 redacts and bounds internal final text and never exposes a raw AssistantMessage', async () => {
  const db=fixture(), provider=fauxProvider({provider:'pi002-final-redact',api:'faux',models:[{id:'model'}]});
  provider.setResponses([fauxAssistantMessage(`Bearer SUPERSECRET123 ${'x'.repeat(9000)}`,{stopReason:'stop'})]);
  const outcome=await runtime(db,provider,()=>result()).run(start);
  assert.equal(outcome.status,'TERMINAL'); assert.equal(outcome.reasonCode,'PI_BUDGET_EXHAUSTED_HANDOFF'); assert.equal(outcome.responsePlan?.intent,'HANDOFF'); assert.equal('finalAssistantMessage' in outcome,false);
});


test('PI-002 redacts and bounds optional system preamble before model visibility', async () => {
  const db=fixture(), provider=fauxProvider({provider:'pi002-preamble',api:'faux',models:[{id:'model'}]});
  let prompt=''; provider.setResponses([(context:any)=>{prompt=context.systemPrompt;return finalPlan(context)}]);
  const rt=new V2PiRuntime(db,{model:provider.getModel(),streamFn:provider.provider.streamSimple.bind(provider.provider),execute:()=>result(),systemPreamble:`Bearer PREAMBLESECRET ${'p'.repeat(3000)}`});
  const outcome=await rt.run(start);
  assert.equal(outcome.status,'TERMINAL'); assert.doesNotMatch(prompt,/PREAMBLESECRET/); assert.ok(prompt.indexOf('V2 observation')<=2200);
});

test('PI-002 unexpected stream rejection fails closed without fabricating an action', async () => {
  const db=fixture(), provider=fauxProvider({provider:'pi002-reject',api:'faux',models:[{id:'model'}]});
  const rejectingStream:any=async()=>{throw new Error('provider exploded')};
  const outcome=await new V2PiRuntime(db,{model:provider.getModel(),streamFn:rejectingStream,execute:()=>result()}).run(start);
  assert.equal(outcome.status,'FAIL_CLOSED'); assert.equal(outcome.reasonCode,'PI_MODEL_FAILED');
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,0);
});

test('PI-002 malformed executor result is converted to bounded CAP-005 failure before the next observation', async () => {
  const db=fixture(), provider=fauxProvider({provider:'pi002-malformed-result',api:'faux',models:[{id:'model'}]});
  provider.setResponses([fauxAssistantMessage(fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U}),{stopReason:'toolUse'}),finalPlan]);
  const outcome=await runtime(db,provider,()=>({totally:'invalid'})).run(start);
  const stored=db.db.prepare('SELECT result_json FROM agent_action_results').get() as any;
  assert.equal(outcome.status,'TERMINAL'); assert.match(stored.result_json,/CAPABILITY_EXECUTION_FAILED/); assert.doesNotMatch(stored.result_json,/totally/);
});


test('PI-002 active turn capability authority can narrow but cannot widen mid-turn', async () => {
  const db=fixture();
  db.db.prepare('UPDATE employee_profiles SET capability_permissions_json=? WHERE id=?').run('["v2.capability.get_customer_context"]',P);
  const coordinator=new AgentTurnCoordinator(db), turn=coordinator.start(start);
  const proposed=coordinator.propose({turnId:turn.turnId,sequence:1,capabilityName:'get_customer_context',capabilityVersion:'v1',arguments:{accountId:A,conversationId:C,customerId:U}});
  coordinator.recordResult({turnId:turn.turnId,actionId:proposed.actions[0].id,sequence:1,result:result({customerId:U})});
  db.db.prepare('UPDATE employee_profiles SET capability_permissions_json=? WHERE id=?').run('["v2.capability.get_customer_context","v2.capability.get_order_history"]',P);
  const provider=fauxProvider({provider:'pi002-no-widen',api:'faux',models:[{id:'model'}]}); let names:string[]=[];
  provider.setResponses([(context:any)=>{names=(context.tools??[]).map((tool:any)=>tool.name);return finalPlan(context);}]);
  const outcome=await runtime(db,provider,()=>{throw new Error('must not execute')}).run(start);
  assert.equal(outcome.status,'TERMINAL'); assert.deepEqual(names,['get_customer_context']);
});

test('PI-002 empty final is not accepted as a terminal model decision', async () => {
  const db=fixture(),provider=fauxProvider({provider:'pi002-empty-final',api:'faux',models:[{id:'model'}]});
  provider.setResponses([fauxAssistantMessage('',{stopReason:'stop'})]);
  const outcome=await runtime(db,provider,()=>result()).run(start);
  assert.equal(outcome.status,'TERMINAL'); assert.equal(outcome.reasonCode,'PI_BUDGET_EXHAUSTED_HANDOFF'); assert.equal(outcome.responsePlan?.intent,'HANDOFF');
  assert.equal((db.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(outcome.turnId) as any).status,'TERMINAL');
});


test('PI-002 failed capability-owned quotation does not terminalize or suppress the next model decision', async () => {
  const db=fixture();
  db.db.prepare("INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES('pi-q-fail','QT-PI-F',?,'DRAFT','SGD','2026-09-09','2026-09-30',?,'pi-in-1',100,0,100)").run(U,C);
  const provider=fauxProvider({provider:'pi002-owned-quote-fail',api:'faux',models:[{id:'model'}]});
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('send_quotation',{accountId:A,conversationId:C,customerId:U,quotationId:'pi-q-fail',customerMessage:'Please review the quotation and reply OK confirm if you would like to proceed.'}),{stopReason:'toolUse'}),
    finalPlan,
  ]);
  const failed={status:'FAILED' as const,evidence:[],stateChanges:[],reasonCode:'SEND_FAILED'};
  const outcome=await runtime(db,provider,()=>failed).run(start);
  assert.equal(outcome.status,'TERMINAL'); assert.equal(outcome.reasonCode,'PI_FINAL_PENDING_GROUNDING'); assert.equal(outcome.responsePlan?.intent,'ANSWER');
  assert.match((db.db.prepare('SELECT result_json FROM agent_action_results').get() as any).result_json,/SEND_FAILED/);
});

test('PI-002 mid-turn profile version change returns fail-closed instead of throwing or re-executing', async () => {
  const db=fixture(), provider=fauxProvider({provider:'pi002-profile-version-change',api:'faux',models:[{id:'model'}]});
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U}),{stopReason:'toolUse'}),
    fauxAssistantMessage('must not be reached',{stopReason:'stop'}),
  ]);
  let executions=0;
  const outcome=await runtime(db,provider,()=>{executions++;db.db.prepare('UPDATE employee_profiles SET version=version+1 WHERE id=?').run(P);return result({customerId:U})}).run(start);
  assert.equal(executions,1); assert.equal(outcome.status,'FAIL_CLOSED'); assert.equal(outcome.reasonCode,'PI_MODEL_FAILED');
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,1); assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,1);
});


test('PI-002 failed handoff capability does not terminalize the turn', async () => {
  const db=fixture();
  db.db.prepare("INSERT INTO work_items(id,account_id,conversation_id,customer_id,type,state,revision,goal_summary,assigned_profile,source_message_id,created_at,updated_at) VALUES('pi-wi',?,?,?,'SALES_ORDER_REQUEST','OPEN',1,'help customer',?,'pi-in-1','2026-09-09','2026-09-09')").run(A,C,U,P);
  const provider=fauxProvider({provider:'pi002-handoff-fail',api:'faux',models:[{id:'model'}]});
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('request_human_handoff',{accountId:A,conversationId:C,customerId:U,workItemId:'pi-wi',expectedWorkItemRevision:1,reasonCode:'MANUAL_REVIEW'}),{stopReason:'toolUse'}),
    finalPlan,
  ]);
  const failed={status:'FAILED' as const,evidence:[],stateChanges:[],reasonCode:'HANDOFF_FAILED'};
  const outcome=await runtime(db,provider,()=>failed).run(start);
  assert.equal(outcome.status,'TERMINAL'); assert.equal(outcome.reasonCode,'PI_FINAL_PENDING_GROUNDING'); assert.equal(outcome.responsePlan?.intent,'ANSWER');
  assert.match((db.db.prepare('SELECT result_json FROM agent_action_results').get() as any).result_json,/HANDOFF_FAILED/);
});


test('PI-002 rejects a mixed assistant action plus final text before any executor or ledger mutation', async () => {
  const db=fixture(),provider=fauxProvider({provider:'pi002-mixed-action-final',api:'faux',models:[{id:'model'}]});
  provider.setResponses([fauxAssistantMessage([
    {type:'text',text:'I will do this and it is done.'},
    fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U}) as any,
  ] as any,{stopReason:'toolUse'})]);
  let executions=0;
  const outcome=await runtime(db,provider,()=>{executions++;return result();}).run(start);
  assert.equal(outcome.status,'FAIL_CLOSED'); assert.equal(outcome.reasonCode,'PI_MIXED_ACTION_AND_FINAL'); assert.equal(executions,0);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,0); assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,0);
});

test('PI-002 fail-closed outcomes project the latest durable ledger after a post-action model failure', async () => {
  const db=fixture(),provider=fauxProvider({provider:'pi002-latest-ledger-on-fail',api:'faux',models:[{id:'model'}]});
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U}),{stopReason:'toolUse'}),
    () => { throw new Error('provider failed after durable result'); },
  ]);
  const outcome=await runtime(db,provider,()=>result({customerId:U})).run(start);
  assert.equal(outcome.status,'FAIL_CLOSED'); assert.equal(outcome.reasonCode,'PI_MODEL_FAILED'); assert.equal(outcome.projection.actions.length,1); assert.notEqual(outcome.projection.actions[0].result,null);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,1); assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,1);
});

test('PI-004 builds a state-aware plan from completed structured evidence refs without rendering protected values', async () => {
  const db=fixture(), provider=fauxProvider({provider:'pi004-evidence-plan',api:'faux',models:[{id:'model'}]});
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U}),{stopReason:'toolUse'}),
    fauxAssistantMessage(fauxToolCall('get_order_history',{accountId:A,conversationId:C,customerId:U,limit:2}),{stopReason:'toolUse'}),
    fauxAssistantMessage(fauxToolCall('get_commerce_status',{accountId:A,conversationId:C,customerId:U}),{stopReason:'toolUse'}),
    (context:any)=>{
      assert.match(context.systemPrompt,/customer-evidence-1/); assert.match(context.systemPrompt,/history-evidence-1/); assert.match(context.systemPrompt,/commerce-evidence-1/);
      const match=context.systemPrompt.match(/\n(\{.*\})\n\nCompleted durable/s), turnId=match?JSON.parse(match[1]).turnId:'';
      return fauxAssistantMessage(JSON.stringify({
        turnId,intent:'ANSWER',connectiveText:'I can provide the details.',outboundPurpose:'customer_reply',factClaims:[
          {slot:'customer_identity',valueShape:'identifier',canonicalRef:{sourceId:'customer-evidence-1',versionOrRevision:'v1',evidenceRefs:['customer-row-1']}},
          {slot:'sales_order_number',valueShape:'document_identifier',canonicalRef:{sourceId:'history-evidence-1',versionOrRevision:'v2',evidenceRefs:['order-row-1']}},
          {slot:'date',valueShape:'date',canonicalRef:{sourceId:'history-evidence-1',versionOrRevision:'v2',evidenceRefs:['order-row-1']}},
          {slot:'quotation_status',valueShape:'status',canonicalRef:{sourceId:'commerce-evidence-1',versionOrRevision:'v3',evidenceRefs:['quote-row-1']}},
        ],
      }),{stopReason:'stop'});
    },
  ]);
  let calls=0;
  const outcome=await runtime(db,provider,action=>{
    calls++;
    if(action.capability.name==='get_customer_context') return {status:'SUCCEEDED',data:{customerId:U,code:'CUST-001',name:'Sunrise Mini Mart Pte Ltd',currency:'SGD'},evidence:[{sourceId:'customer-evidence-1',sourceVersion:'v1',evidenceRefs:['customer-row-1']}],stateChanges:[]};
    if(action.capability.name==='get_order_history') return {status:'SUCCEEDED',data:{orders:[{id:'so-1',salesOrderNo:'SO-000001',date:'2026-09-01',grandTotalCents:100}]},evidence:[{sourceId:'history-evidence-1',sourceVersion:'v2',evidenceRefs:['order-row-1']}],stateChanges:[]};
    return {status:'SUCCEEDED',data:{quotationId:'q-1',quotationStatus:'SENT'},evidence:[{sourceId:'commerce-evidence-1',sourceVersion:'v3',evidenceRefs:['quote-row-1']}],stateChanges:[]};
  }).run(start);
  assert.equal(calls,3); assert.equal(outcome.reasonCode,'PI_FINAL_PENDING_GROUNDING'); assert.equal(outcome.responsePlan?.factClaims.length,4);
    assert.equal(outcome.responsePlan?.connectiveText,'I can provide the details.'); assert.equal(db.db.prepare('SELECT count(*) n FROM outbound_messages').get().n,0);
});

test('PI-004 ACKNOWLEDGE CLARIFY and HANDOFF plans remain candidate-only and create no outbound', async () => {
  for(const candidate of [
    {intent:'ACKNOWLEDGE',connectiveText:'Thank you.',factClaims:[],outboundPurpose:'acknowledgement'},
    {intent:'CLARIFY',connectiveText:'Could you clarify your request?',factClaims:[],safeReasonCode:'AMBIGUOUS_REQUEST',outboundPurpose:'clarification'},
    {intent:'HANDOFF',connectiveText:'A specialist can assist further.',factClaims:[],safeReasonCode:'STAFF_REVIEW',handoff:{reasonCode:'STAFF_REVIEW'},outboundPurpose:'handoff'},
  ]){
    const db=fixture(), provider=fauxProvider({provider:`pi004-${candidate.intent}`,api:'faux',models:[{id:'model'}]});
    provider.setResponses([(context:any)=>{const m=context.systemPrompt.match(/\n(\{.*\})\n\nCompleted durable/s),turnId=m?JSON.parse(m[1]).turnId:'';return fauxAssistantMessage(JSON.stringify({turnId,...candidate}),{stopReason:'stop'})}]);
    const out=await runtime(db,provider,()=>{throw new Error('must not execute')}).run(start);
    assert.equal(out.responsePlan?.intent,candidate.intent); assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,0); assert.equal(db.db.prepare('SELECT count(*) n FROM outbound_messages').get().n,0);
  }
});

test('PI-004 malformed final after completed action uses one model-only repair and no extra capability', async () => {
  const db=fixture(),provider=fauxProvider({provider:'pi004-repair-after-action',api:'faux',models:[{id:'model'}]});
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U}),{stopReason:'toolUse'}),
    fauxAssistantMessage('not-json',{stopReason:'stop'}),
    finalPlan,
  ]);
  let executions=0; const out=await runtime(db,provider,()=>{executions++;return result({customerId:U})}).run(start);
  assert.equal(out.reasonCode,'PI_FINAL_PENDING_GROUNDING'); assert.equal(executions,1); assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,1);
  assert.equal(db.db.prepare("SELECT count(*) n FROM agent_model_attempts WHERE attempt_kind='REPAIR'").get().n,1);
});

test('PI-004 repair tool-call attempt is blocked before propose or executor', async () => {
  const db=fixture(),provider=fauxProvider({provider:'pi004-repair-tool-block',api:'faux',models:[{id:'model'}]});
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U}),{stopReason:'toolUse'}),
    fauxAssistantMessage('not-json',{stopReason:'stop'}),
    fauxAssistantMessage(fauxToolCall('get_order_history',{accountId:A,conversationId:C,customerId:U,limit:2}),{stopReason:'toolUse'}),
  ]);
  let executions=0; const out=await runtime(db,provider,()=>{executions++;return result({customerId:U})}).run(start);
  assert.equal(out.status,'FAIL_CLOSED'); assert.equal(out.reasonCode,'PI_MODEL_FAILED'); assert.equal(executions,1);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,1); assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,1);
});

test('PI-004 second malformed final after action exhausts the single durable repair budget', async () => {
  const db=fixture(),provider=fauxProvider({provider:'pi004-repair-exhaust-action',api:'faux',models:[{id:'model'}]});
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U}),{stopReason:'toolUse'}),
    fauxAssistantMessage('bad-one',{stopReason:'stop'}),
    fauxAssistantMessage('bad-two',{stopReason:'stop'}),
  ]);
  let executions=0; const out=await runtime(db,provider,()=>{executions++;return result({customerId:U})}).run(start);
  assert.equal(out.reasonCode,'PI_BUDGET_EXHAUSTED_HANDOFF'); assert.equal(executions,1); assert.equal(db.db.prepare("SELECT count(*) n FROM agent_model_attempts WHERE attempt_kind='REPAIR'").get().n,1);
  assert.equal((db.db.prepare('SELECT terminal_reason FROM agent_turns WHERE id=?').get(out.turnId) as any).terminal_reason,'PI_BUDGET_EXHAUSTED_HANDOFF');
});


test('PI-004 repeated completed model action is blocked before a second executor call', async () => {
  const db=fixture(), provider=fauxProvider({provider:'pi004-repeat-completed',api:'faux',models:[{id:'model'}]});
  const call=fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U});
  provider.setResponses([fauxAssistantMessage(call,{stopReason:'toolUse'}),fauxAssistantMessage(call,{stopReason:'toolUse'})]);
  let executions=0;
  const outcome=await runtime(db,provider,()=>{executions++;return result({customerId:U})}).run(start);
  assert.equal(outcome.status,'FAIL_CLOSED'); assert.equal(executions,1);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,1);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,1);
});

test('Pi Harness required-tool policy may retry a non-tool model turn without widening authority', async () => {
  const db=fixture(), provider=fauxProvider({provider:'pi-required-tool-retry',api:'faux',models:[{id:'model'}]});
  provider.setResponses([
    fauxAssistantMessage('{}',{stopReason:'stop'}),
    fauxAssistantMessage(fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U}),{stopReason:'toolUse'}),
    finalPlan,
  ]);
  let executions=0;
  const rt=new V2PiRuntime(db,{model:provider.getModel(),streamFn:provider.provider.streamSimple.bind(provider.provider),execute:()=>{executions++;return result({customerId:U})},allowedCapabilityNames:['get_customer_context'],capabilityPolicy:(context,projection)=>projection.actions.length===0?{phase:'CUSTOMER_CONTEXT_REQUIRED',allowedCapabilityNames:['get_customer_context'],finalOnly:false}:{phase:'GENERAL',allowedCapabilityNames:[],finalOnly:true}});
  const out=await rt.run(start);
  assert.equal(executions,1);assert.equal(out.status,'TERMINAL');assert.equal(out.reasonCode,'PI_FINAL_PENDING_GROUNDING');
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get()?.n,1);
  assert.equal(db.db.prepare('SELECT count(*) n FROM agent_model_attempts').get()?.n,3);
});
