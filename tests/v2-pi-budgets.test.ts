import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {V1Database} from '../src/database.js';
import {V2PiRuntime} from '../src/v2-pi-runtime.js';
import {AgentTurnCoordinator} from '../src/v2-agent-turn-coordinator.js';
import {fauxAssistantMessage,fauxProvider,fauxToolCall} from '@earendil-works/pi-ai';
import {OutboundMessageService} from '../src/outbound-message-service.js';
import {SimulatedChannel} from '../src/channels.js';

const A='demo-account',C='conv-001',U='CUST-001',P='sales-digital-employee';
const start={accountId:A,conversationId:C,inboundMessageId:'pi3-in',profileId:P,nowIso:'2026-09-09T09:00:00+08:00',timezone:'Asia/Singapore'} as const;
const baseBudgets={maxModelTurns:8,maxCapabilityCalls:6,perCallTimeoutMs:15000,turnTimeoutMs:60000,maxRepairAttempts:1};
const ok=(data:unknown={})=>({status:'SUCCEEDED' as const,data,evidence:[],stateChanges:[]});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(file=':memory:'){const db=new V1Database(file);db.resetAndSeed();db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('pi3-in',?,'pi3-ext','INBOUND','text','continue order',?,'2026-09-09T01:02:03Z')").run(C,A);return db}
function budgets(db:V1Database,values:Partial<typeof baseBudgets>){db.db.prepare('UPDATE employee_profiles SET turn_budgets_json=? WHERE id=?').run(JSON.stringify({...baseBudgets,...values}),P)}
function runtime(db:V1Database,provider:ReturnType<typeof fauxProvider>,execute:(action:any,signal?:AbortSignal)=>unknown,signal?:AbortSignal){return new V2PiRuntime(db,{model:provider.getModel(),streamFn:provider.provider.streamSimple.bind(provider.provider),execute,signal})}
const finalPlan=(context:any)=>{const match=context.systemPrompt.match(/\n(\{.*\})\n\nCompleted durable/s);const turnId=match?JSON.parse(match[1]).turnId:'';return fauxAssistantMessage(JSON.stringify({turnId,intent:'ANSWER',connectiveText:'I can help with that.',factClaims:[],outboundPurpose:'customer_reply'}),{stopReason:'stop'})};
const customerCall=()=>fauxToolCall('get_customer_context',{accountId:A,conversationId:C,customerId:U});
const historyCall=()=>fauxToolCall('get_order_history',{accountId:A,conversationId:C,customerId:U,limit:2});
const statusCall=()=>fauxToolCall('get_commerce_status',{accountId:A,conversationId:C,customerId:U});

test('PI-003 durable model-turn budget stops before provider call max+1',async()=>{
 const db=fixture();budgets(db,{maxModelTurns:2,turnTimeoutMs:2000,perCallTimeoutMs:500});
 const provider=fauxProvider({provider:'pi003-model-budget',api:'faux',models:[{id:'m'}]});let modelCalls=0,executions=0;
 provider.setResponses([
  ()=>{modelCalls++;return fauxAssistantMessage(customerCall(),{stopReason:'toolUse'})},
  ()=>{modelCalls++;return fauxAssistantMessage(historyCall(),{stopReason:'toolUse'})},
  ()=>{modelCalls++;return fauxAssistantMessage(statusCall(),{stopReason:'toolUse'})},
 ]);
 const out=await runtime(db,provider,()=>{executions++;return ok()}).run(start);
 assert.equal(out.reasonCode,'PI_BUDGET_EXHAUSTED_HANDOFF');assert.equal(modelCalls,2);assert.equal(executions,2);
 assert.equal(db.db.prepare('SELECT count(*) n FROM agent_model_attempts').get().n,2);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,2);
 assert.equal((db.db.prepare('SELECT status,terminal_reason FROM agent_turns').get() as any).status,'TERMINAL');assert.equal((db.db.prepare('SELECT terminal_reason FROM agent_turns').get() as any).terminal_reason,'PI_BUDGET_EXHAUSTED_HANDOFF');assert.equal(db.db.prepare('SELECT count(*) n FROM outbound_messages').get().n,0);
});

test('current_order_draft_items V2PiRuntime live-shape answers exact projected lines and replays without a second provider send',async()=>{
 const db=fixture(); const item={id:'eval003-wi',revision:1}; const draft={id:'eval003-draft',current_revision:1};
 db.db.prepare("INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(item.id,A,C,U,'SALES_ORDER_REQUEST','DRAFTING',item.revision,'active draft',draft.id,null,null,null,'pi3-in','2026-09-09','2026-09-09');
 db.db.prepare("INSERT INTO order_drafts VALUES(?,?,?,?,?,'CURRENT',1,NULL,'SG-MAIN','SGD','pi3-in','2026-09-09','2026-09-09')").run(draft.id,item.id,A,C,U);
 db.db.prepare("INSERT INTO order_draft_lines VALUES('eval003-line',? ,1,'ayam','1','CTN',NULL,NULL,NULL,NULL)").run(draft.id);
 draft.current_revision=(db.db.prepare('SELECT current_revision FROM order_drafts WHERE id=?').get(draft.id) as any).current_revision;
 budgets(db,{maxModelTurns:2,turnTimeoutMs:2000,perCallTimeoutMs:500}); const provider=fauxProvider({provider:'eval003-live-shape',api:'faux',models:[{id:'m'}]}); let calls=0;
 provider.setResponses([()=>{calls++;return fauxAssistantMessage(fauxToolCall('read_order_draft',{accountId:A,conversationId:C,customerId:U,workItemId:item.id,draftId:draft.id,revision:draft.current_revision,expectedWorkItemRevision:item.revision}),{stopReason:'toolUse'})},(context:any)=>{calls++;const match=context.systemPrompt.match(/Host-visible grounding reference projection \(copy exact reference fields and allowedClaims; never derive refs\):\n(\{.*\})/);assert.ok(match);const refs=JSON.parse(match[1]);const ref=refs.references[0];const canonicalRef={sourceId:ref.sourceId,versionOrRevision:ref.versionOrRevision,evidenceRefs:ref.evidenceRefs};return fauxAssistantMessage(JSON.stringify({turnId:JSON.parse(context.systemPrompt.match(/V2 observation[^\n]*:\n(\{.*\})\n\nCompleted durable/)[1]).turnId,intent:'ANSWER',connectiveText:'Here are the current items.',factClaims:[{slot:'current_order_draft_items',canonicalRef,valueShape:'order_draft_items'}],outboundPurpose:'customer_reply'}),{stopReason:'stop'})}]);
 const channel=new SimulatedChannel(), outbound=new OutboundMessageService(db,channel); const rt=()=>new V2PiRuntime(db,{model:provider.getModel(),streamFn:provider.provider.streamSimple.bind(provider.provider),execute:()=>({status:'SUCCEEDED',data:{draftId:draft.id,revision:draft.current_revision,status:'CURRENT',lines:[{lineNo:1,requestedWording:'ayam',quantity:'1',requestedUom:'CTN'}]},evidence:[],stateChanges:[]}),outbound});
 const first=await rt().run(start); assert.equal(first.status,'TERMINAL'); assert.equal(first.reasonCode,'PI_FINAL_PENDING_GROUNDING'); assert.equal(first.responsePlan?.intent,'ANSWER'); assert.equal(channel.sendCount,1); assert.equal(channel.sent[0].text,'Here are the current items. 1. ayam — 1 CTN'); assert.equal((db.db.prepare("SELECT disposition,purpose FROM turn_outbound_dispositions").get() as any).disposition,'RUNTIME_RESPONSE'); assert.equal((db.db.prepare("SELECT count(*) n FROM outbound_messages WHERE entity_type='TURN_RESPONSE'").get() as any).n,1);
 const replay=await rt().run(start); assert.equal(replay.status,'TERMINAL'); assert.equal(replay.responsePlan?.intent,'ANSWER'); assert.equal(channel.sendCount,1); assert.equal(calls,2);
});

test('PI-003 durable capability budget blocks action and executor max+1',async()=>{
 const db=fixture();budgets(db,{maxModelTurns:4,maxCapabilityCalls:2,turnTimeoutMs:2000,perCallTimeoutMs:500});
 const provider=fauxProvider({provider:'pi003-cap-budget',api:'faux',models:[{id:'m'}]});let modelCalls=0,executions=0;
 provider.setResponses([
  ()=>{modelCalls++;return fauxAssistantMessage(customerCall(),{stopReason:'toolUse'})},
  ()=>{modelCalls++;return fauxAssistantMessage(historyCall(),{stopReason:'toolUse'})},
  ()=>{modelCalls++;return fauxAssistantMessage(statusCall(),{stopReason:'toolUse'})},
 ]);
 const out=await runtime(db,provider,()=>{executions++;return ok()}).run(start);
 assert.equal(out.reasonCode,'PI_BUDGET_EXHAUSTED_HANDOFF');assert.equal(modelCalls,3);assert.equal(executions,2);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,2);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,2);assert.equal(db.db.prepare('SELECT count(*) n FROM outbound_messages').get().n,0);
});

test('PI-003 model attempt count survives database restart and cannot reset budget',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi003-model-restart-')),file=join(dir,'db.sqlite');try{
  let db=fixture(file);budgets(db,{maxModelTurns:1,turnTimeoutMs:2000,perCallTimeoutMs:500});let c=new AgentTurnCoordinator(db),turn=c.start(start);c.reserveModelAttempt({turnId:turn.turnId,kind:'MODEL',reasonCode:'PRECRASH'});db.db.close();
  db=new V1Database(file);const provider=fauxProvider({provider:'pi003-restart',api:'faux',models:[{id:'m'}]});let modelCalls=0;provider.setResponses([()=>{modelCalls++;return fauxAssistantMessage('must not run',{stopReason:'stop'})}]);const out=await runtime(db,provider,()=>ok()).run(start);
  assert.equal(modelCalls,0);assert.equal(out.reasonCode,'PI_BUDGET_EXHAUSTED_HANDOFF');assert.equal(db.db.prepare('SELECT count(*) n FROM agent_model_attempts').get().n,1);assert.equal((db.db.prepare('SELECT terminal_reason FROM agent_turns').get() as any).terminal_reason,'PI_BUDGET_EXHAUSTED_HANDOFF');db.db.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('PI-003 per-call timeout leaves uncertain side effect pending for reconciliation, never a fake result',async()=>{
 const db=fixture();budgets(db,{perCallTimeoutMs:20,turnTimeoutMs:1000});const provider=fauxProvider({provider:'pi003-call-timeout',api:'faux',models:[{id:'m'}]});provider.setResponses([fauxAssistantMessage(customerCall(),{stopReason:'toolUse'})]);let executions=0,aborted=false,lateFinished=false;
 const rt=runtime(db,provider,(_action,signal)=>new Promise(resolve=>{executions++;signal?.addEventListener('abort',()=>{aborted=true;setTimeout(()=>{lateFinished=true;resolve(ok({late:true}))},30)},{once:true})}));
 const out=await rt.run(start);await delay(70);
 assert.equal(out.reasonCode,'PI_RECONCILE_ACTION_PENDING');assert.equal(out.projection.status,'RECONCILE_ACTION');assert.equal(executions,1);assert.equal(aborted,true);assert.equal(lateFinished,true);
 assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,1);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,0);const ev=db.db.prepare('SELECT outcome,reason_code FROM agent_action_execution_events').get() as any;assert.equal(ev.outcome,'TIMEOUT');assert.equal(ev.reason_code,'PI_CAPABILITY_TIMEOUT');
 const again=await rt.run(start);assert.equal(again.reasonCode,'PI_RECONCILE_ACTION_PENDING');assert.equal(executions,1);assert.equal(db.db.prepare('SELECT count(*) n FROM outbound_messages').get().n,0);
});

test('PI-003 external cancellation before model/action is resumable and mutates no action ledger',async()=>{
 const db=fixture();const provider=fauxProvider({provider:'pi003-pre-cancel',api:'faux',models:[{id:'m'}]});let modelCalls=0;provider.setResponses([()=>{modelCalls++;return fauxAssistantMessage(customerCall(),{stopReason:'toolUse'})}]);const ac=new AbortController();ac.abort();const out=await runtime(db,provider,()=>ok()).run(start,ac.signal);
 assert.equal(out.reasonCode,'PI_CANCELLED');assert.equal(modelCalls,0);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_model_attempts').get().n,0);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,0);assert.equal((db.db.prepare('SELECT status FROM agent_turns').get() as any).status,'AWAITING_DECISION');
});

test('PI-003 cancellation during executor records uncertain action and restart never re-executes it',async()=>{
 const db=fixture();budgets(db,{perCallTimeoutMs:1000,turnTimeoutMs:2000});const provider=fauxProvider({provider:'pi003-mid-cancel',api:'faux',models:[{id:'m'}]});provider.setResponses([fauxAssistantMessage(customerCall(),{stopReason:'toolUse'})]);const ac=new AbortController();let executions=0,aborted=false;
 const rt=runtime(db,provider,(_action,signal)=>new Promise(resolve=>{executions++;setTimeout(()=>ac.abort(),10);signal?.addEventListener('abort',()=>{aborted=true;setTimeout(()=>resolve(ok({late:true})),25)},{once:true})}));
 const out=await rt.run(start,ac.signal);await delay(50);assert.equal(out.reasonCode,'PI_RECONCILE_ACTION_PENDING');assert.equal(aborted,true);assert.equal(executions,1);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,0);assert.equal((db.db.prepare('SELECT outcome FROM agent_action_execution_events').get() as any).outcome,'CANCELLED');
 const again=await rt.run(start);assert.equal(again.reasonCode,'PI_RECONCILE_ACTION_PENDING');assert.equal(executions,1);
});

test('PI-003 cancel after durable propose but before executor scheduling never invokes executor',async()=>{
 const db=fixture();budgets(db,{perCallTimeoutMs:500,turnTimeoutMs:2000});const provider=fauxProvider({provider:'pi003-propose-cancel-race',api:'faux',models:[{id:'m'}]});provider.setResponses([fauxAssistantMessage(customerCall(),{stopReason:'toolUse'})]);const ac=new AbortController();let executions=0;
 const original=AgentTurnCoordinator.prototype.propose;(AgentTurnCoordinator.prototype as any).propose=function(input:any){const projection=original.call(this,input);queueMicrotask(()=>ac.abort());return projection};
 try{const out=await runtime(db,provider,()=>{executions++;return ok()}).run(start,ac.signal);assert.equal(executions,0);assert.equal(out.reasonCode,'PI_RECONCILE_ACTION_PENDING');assert.equal(out.projection.status,'RECONCILE_ACTION');assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,0);const ev=db.db.prepare('SELECT outcome,reason_code FROM agent_action_execution_events').get() as any;assert.equal(ev.outcome,'CANCELLED');assert.equal(ev.reason_code,'PI_CANCELLED');}
 finally{(AgentTurnCoordinator.prototype as any).propose=original}
});

test('PI-003 durable host deadline survives restart and expires before any later provider call',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi003-deadline-')),file=join(dir,'db.sqlite');try{
  let db=fixture(file);budgets(db,{turnTimeoutMs:10,perCallTimeoutMs:5});const c=new AgentTurnCoordinator(db),turn=c.start(start);const deadline=c.budget(turn.turnId).deadlineAt;db.db.close();await delay(30);db=new V1Database(file);
  const provider=fauxProvider({provider:'pi003-deadline',api:'faux',models:[{id:'m'}]});let modelCalls=0;provider.setResponses([()=>{modelCalls++;return fauxAssistantMessage('must not run',{stopReason:'stop'})}]);const out=await runtime(db,provider,()=>ok()).run(start);
  assert.equal(modelCalls,0);assert.equal(out.reasonCode,'PI_BUDGET_EXHAUSTED_HANDOFF');assert.equal((db.db.prepare('SELECT runtime_deadline_at FROM agent_turns').get() as any).runtime_deadline_at,deadline);assert.equal((db.db.prepare('SELECT terminal_reason FROM agent_turns').get() as any).terminal_reason,'PI_BUDGET_EXHAUSTED_HANDOFF');db.db.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('PI-003 host total-timeout returns even when model stream ignores AbortSignal forever',async()=>{
 const db=fixture();budgets(db,{turnTimeoutMs:20,perCallTimeoutMs:10});const provider=fauxProvider({provider:'pi003-hung-model-timeout',api:'faux',models:[{id:'m'}]});let executions=0;const hangingStream:any=async()=>new Promise(()=>{});const rt=new V2PiRuntime(db,{model:provider.getModel(),streamFn:hangingStream,execute:()=>{executions++;return ok()}});const before=Date.now();const out=await rt.run(start);const elapsed=Date.now()-before;
 assert.equal(out.reasonCode,'PI_BUDGET_EXHAUSTED_HANDOFF');assert.ok(elapsed<500);assert.equal(executions,0);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_model_attempts').get().n,1);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,0);assert.equal((db.db.prepare('SELECT status FROM agent_turns').get() as any).status,'TERMINAL');
});

test('PI-003 host cancellation returns even when model stream ignores AbortSignal forever',async()=>{
 const db=fixture();budgets(db,{turnTimeoutMs:2000,perCallTimeoutMs:500});const provider=fauxProvider({provider:'pi003-hung-model-cancel',api:'faux',models:[{id:'m'}]});const hangingStream:any=async()=>new Promise(()=>{});const ac=new AbortController();setTimeout(()=>ac.abort(),20);const before=Date.now();const out=await new V2PiRuntime(db,{model:provider.getModel(),streamFn:hangingStream,execute:()=>ok()}).run(start,ac.signal);const elapsed=Date.now()-before;
 assert.equal(out.reasonCode,'PI_CANCELLED');assert.ok(elapsed<500);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_model_attempts').get().n,1);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,0);assert.equal((db.db.prepare('SELECT status FROM agent_turns').get() as any).status,'AWAITING_DECISION');
});

test('PI-003 late model tool response after host timeout cannot create an action or side effect',async()=>{
 const db=fixture();budgets(db,{turnTimeoutMs:20,perCallTimeoutMs:10});const provider=fauxProvider({provider:'pi003-late-model-tool',api:'faux',models:[{id:'m'}]});provider.setResponses([fauxAssistantMessage(customerCall(),{stopReason:'toolUse'})]);let executions=0;const delayedStream:any=async(model:any,context:any,options:any)=>{await delay(60);return provider.provider.streamSimple(model,context,{...options,signal:undefined})};const rt=new V2PiRuntime(db,{model:provider.getModel(),streamFn:delayedStream,execute:()=>{executions++;return ok()}});const out=await rt.run(start);assert.equal(out.reasonCode,'PI_BUDGET_EXHAUSTED_HANDOFF');await delay(100);assert.equal(executions,0);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_actions').get().n,0);assert.equal(db.db.prepare('SELECT count(*) n FROM agent_action_results').get().n,0);
});

test('PI-003 one repair attempt is durable, consumes model budget, and can recover a truncated decision',async()=>{
 const db=fixture();budgets(db,{maxModelTurns:2,maxRepairAttempts:1,turnTimeoutMs:2000,perCallTimeoutMs:500});const provider=fauxProvider({provider:'pi003-repair-ok',api:'faux',models:[{id:'m'}]});provider.setResponses([fauxAssistantMessage('cut',{stopReason:'length'}),finalPlan]);const out=await runtime(db,provider,()=>ok()).run(start);
 assert.equal(out.status,'TERMINAL');assert.equal(out.responsePlan?.intent,'ANSWER');const rows=db.db.prepare('SELECT sequence,attempt_kind FROM agent_model_attempts ORDER BY sequence').all() as any[];assert.deepEqual(rows,[{sequence:1,attempt_kind:'MODEL'},{sequence:2,attempt_kind:'REPAIR'}]);
});

test('PI-003 second malformed decision exhausts after exactly one durable repair',async()=>{
 const db=fixture();budgets(db,{maxModelTurns:3,maxRepairAttempts:1,turnTimeoutMs:2000,perCallTimeoutMs:500});const provider=fauxProvider({provider:'pi003-repair-limit',api:'faux',models:[{id:'m'}]});provider.setResponses([fauxAssistantMessage('cut1',{stopReason:'length'}),fauxAssistantMessage('cut2',{stopReason:'length'}),fauxAssistantMessage('must not run',{stopReason:'stop'})]);const out=await runtime(db,provider,()=>ok()).run(start);
 assert.equal(out.reasonCode,'PI_BUDGET_EXHAUSTED_HANDOFF');assert.equal(db.db.prepare('SELECT count(*) n FROM agent_model_attempts').get().n,2);assert.equal(db.db.prepare("SELECT count(*) n FROM agent_model_attempts WHERE attempt_kind='REPAIR'").get().n,1);assert.equal((db.db.prepare('SELECT terminal_reason FROM agent_turns').get() as any).terminal_reason,'PI_BUDGET_EXHAUSTED_HANDOFF');
});

test('PI-003 budget provenance and interruption ledgers are immutable and raw SQL cannot forge them',()=>{
 const db=fixture();budgets(db,{maxModelTurns:2,maxCapabilityCalls:2,turnTimeoutMs:2000,perCallTimeoutMs:500});const c=new AgentTurnCoordinator(db),turn=c.start(start),b=c.budget(turn.turnId);assert.equal(b.budgets.maxModelTurns,2);assert.throws(()=>db.db.prepare("UPDATE agent_turns SET budget_provenance_json='{}' WHERE id=?").run(turn.turnId),/IMMUTABLE_AGENT_TURN_IDENTITY/);
 assert.throws(()=>db.db.prepare("INSERT INTO agent_model_attempts(id,turn_id,sequence,attempt_kind,reason_code,created_at) VALUES('raw',?,1,'MODEL','RAW','now')").run(turn.turnId),/AGENT_MODEL_ATTEMPT_INSERT_REQUIRES_COORDINATOR/);c.reserveModelAttempt({turnId:turn.turnId,kind:'MODEL',reasonCode:'TEST'});const mid=(db.db.prepare('SELECT id FROM agent_model_attempts').get() as any).id;assert.throws(()=>db.db.prepare("UPDATE agent_model_attempts SET reason_code='x' WHERE id=?").run(mid),/IMMUTABLE_AGENT_MODEL_ATTEMPT/);
 const proposed=c.propose({turnId:turn.turnId,sequence:1,capabilityName:'get_customer_context',capabilityVersion:'v1',arguments:{accountId:A,conversationId:C,customerId:U}}),action=proposed.actions[0];assert.throws(()=>db.db.prepare("INSERT INTO agent_action_execution_events(id,turn_id,action_id,sequence,outcome,reason_code,created_at) VALUES('raw-event',?,?,1,'TIMEOUT','RAW','now')").run(turn.turnId,action.id),/AGENT_ACTION_EXECUTION_EVENT_INSERT_REQUIRES_COORDINATOR/);
 c.recordExecutionInterruption({turnId:turn.turnId,actionId:action.id,sequence:1,outcome:'TIMEOUT',reasonCode:'PI_CAPABILITY_TIMEOUT'});const eid=(db.db.prepare('SELECT id FROM agent_action_execution_events').get() as any).id;assert.throws(()=>db.db.prepare("UPDATE agent_action_execution_events SET reason_code='x' WHERE id=?").run(eid),/IMMUTABLE_AGENT_ACTION_EXECUTION_EVENT/);assert.throws(()=>c.recordResult({turnId:turn.turnId,actionId:action.id,sequence:1,result:ok()}),/ACTION_EXECUTION_UNCERTAIN/);
});

test('PI-003 migration backfills operational immutable budget/deadline and legacy model-attempt lower bound',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi003-migrate-')),file=join(dir,'db.sqlite');try{const raw=new Database(file);raw.exec(`
  CREATE TABLE agent_turns(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,inbound_message_id TEXT NOT NULL,profile_id TEXT NOT NULL,profile_version INTEGER NOT NULL,timezone TEXT NOT NULL,status TEXT NOT NULL,context_fingerprint TEXT NOT NULL,context_snapshot_json TEXT NOT NULL,context_provenance_json TEXT NOT NULL,terminal_reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT,UNIQUE(account_id,conversation_id,inbound_message_id));
  CREATE TABLE agent_actions(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,sequence INTEGER NOT NULL,capability_name TEXT NOT NULL,capability_version TEXT NOT NULL,arguments_json TEXT NOT NULL,arguments_hash TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(turn_id,sequence));
  INSERT INTO agent_turns VALUES('legacy-turn','a','c','m','sales-digital-employee',1,'UTC','AWAITING_DECISION','h','{}','{}',NULL,'2026-09-09T10:00:00.000Z','2026-09-09T10:00:01.000Z',NULL);
  INSERT INTO agent_actions VALUES('legacy-action','legacy-turn',1,'get_customer_context','v1','{}','h','2026-09-09T10:00:02.000Z');
 `);raw.close();const db=new V1Database(file);const row=db.db.prepare("SELECT budget_provenance_json,runtime_started_at,runtime_deadline_at FROM agent_turns WHERE id='legacy-turn'").get() as any;assert.deepEqual(JSON.parse(row.budget_provenance_json),baseBudgets);assert.equal(row.runtime_started_at,'2026-09-09T10:00:00.000Z');assert.equal(Date.parse(row.runtime_deadline_at)-Date.parse(row.runtime_started_at),60000);assert.equal((db.db.prepare("SELECT attempt_kind,reason_code FROM agent_model_attempts WHERE turn_id='legacy-turn'").get() as any).attempt_kind,'MODEL');assert.equal((db.db.prepare("SELECT reason_code FROM agent_model_attempts WHERE turn_id='legacy-turn'").get() as any).reason_code,'PI003_LEGACY_ACTION_LOWER_BOUND');const c=new AgentTurnCoordinator(db);assert.deepEqual(c.budget('legacy-turn').budgets,baseBudgets);assert.throws(()=>db.db.prepare("UPDATE agent_turns SET runtime_deadline_at='2099-01-01T00:00:00.000Z' WHERE id='legacy-turn'").run(),/IMMUTABLE_AGENT_TURN_IDENTITY/);db.db.close();}finally{rmSync(dir,{recursive:true,force:true})}
});

test('PI-003 source remains budget/runtime-only and does not widen authority or transport scope',()=>{const source=readFileSync(new URL('../src/v2-pi-runtime.ts',import.meta.url),'utf8');assert.doesNotMatch(source,/ResponseGroundingGuard|OutboundMessageService|arrival_seq|DemoTextToolBridge|post_sales_order|confirm_sales_order|create_delivery_order|DO_READY/i);});
