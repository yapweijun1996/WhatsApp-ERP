import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {V1Database} from '../src/database.js';
import {V2QueueService} from '../src/v2-queue.js';
import {V3GoalGraphStore} from '../src/v3-goal-graph.js';
import {buildConversationGoal} from '../src/v3-conversation-goal.js';
import {recoverV3StalePlan} from '../src/v3-control-plane-recovery.js';
import {buildV3DurableContinuation, validateV3DurableContinuation} from '../src/v3-durable-continuation.js';

const scope={accountId:'demo-account',conversationId:'conv-001'} as const;
const at=(n:number)=>`2030-01-01T00:00:0${n}.000Z`;
const goal=(id:string,status:'OPEN'|'IN_PROGRESS'|'FULFILLED'|'SUPERSEDED'|'CANCELLED'='OPEN',links:Partial<{parentGoalId:string|null;dependsOnGoalIds:string[];relatedGoalIds:string[]}>={})=>buildConversationGoal({goalId:id,...scope,sourceMessageIds:[`opaque-${id}`],sourceAttachmentIds:[],erpObjectRefs:[],parentGoalId:null,dependsOnGoalIds:[],relatedGoalIds:[],description:`obligation ${id}`,status,createdBy:'AGENT',createdAt:at(0),updatedAt:at(1),fulfillmentEvidenceRefs:[],...links});
function db(file=':memory:'){const database=new V1Database(file);database.resetAndSeed();return {database,store:new V3GoalGraphStore(database)};}
function continuationShape(disposition:'WAITING_EXTERNAL'|'STILL_IN_PROGRESS'='WAITING_EXTERNAL',state:'WAITING'|'READY'='WAITING'){return {continuationId:`c-${disposition}`,workItemId:'wi-gate',goalId:'g-open',...scope,disposition,ownerType:'HOST' as const,ownerId:'host',state,resumeTriggerType:'OTHER_GOVERNED' as const,resumeConditionRef:'opaque-condition-ref',nextEligibleAt:null,deadlineAt:null,expectedFreshnessVectorRef:'opaque-freshness-ref',lastEvidenceRefs:[],lastEffectRefs:[],attempt:0,budgetState:{maxAttempts:3,consumed:0,deadlineAt:null},idempotencyKey:`c-${disposition}`,createdAt:at(2),updatedAt:at(2)};}

test('G8 keeps an open obligation and its durable continuation after later opaque inbound input',()=>{
  const {database,store}=db();
  store.appendGoalEvent({scope,eventId:'g-open-created',goal:goal('g-open'),eventType:'CREATED',idempotencyKey:'g-open-created',createdAt:at(2)});
  const continuation=buildV3DurableContinuation(continuationShape());
  assert.equal(continuation.disposition,'WAITING_EXTERNAL');
  const queue=new V2QueueService(database);queue.enqueueInbound({...scope,externalMessageId:'later-opaque-input',occurredAt:at(3),text:'opaque evidence'});
  assert.equal(store.readGoalGraph(scope).goals[0]?.goalId,'g-open');
  assert.equal(continuation.continuationId,'c-WAITING_EXTERNAL');
  assert.equal(recoverV3StalePlan({planId:'plan-old',reason:'NEWER_INPUT',currentBundleRevision:2,currentContextSnapshotVersion:'ctx-2'}).decision,'ABORT_REBUNDLE_REBUILD_REPLAN');
  database.db.close();
});

function structuralDisposition(value:unknown, expected={accountId:scope.accountId,conversationId:scope.conversationId,goalId:'g-open',workItemId:'wi-gate',freshnessRef:'opaque-freshness-ref',goalStatus:'OPEN'}):'VALID'|'INVALID'{
  try { const x=validateV3DurableContinuation(value); const resumable=(x.disposition==='WAITING_EXTERNAL'&&x.state==='WAITING')||(x.disposition==='STILL_IN_PROGRESS'&&(x.state==='READY'||x.state==='RUNNING')); if(!resumable||x.attempt>=x.budgetState.maxAttempts||x.accountId!==expected.accountId||x.conversationId!==expected.conversationId||x.goalId!==expected.goalId||x.workItemId!==expected.workItemId||x.expectedFreshnessVectorRef!==expected.freshnessRef||['FULFILLED','SUPERSEDED','CANCELLED'].includes(expected.goalStatus))return 'INVALID'; return 'VALID'; } catch { return 'INVALID'; }
}

test('G9/G22 enforce the structural no-empty-promise boundary for both dispositions',()=>{
  const waiting=continuationShape('WAITING_EXTERNAL','WAITING');
  const progressing=continuationShape('STILL_IN_PROGRESS','READY');
  assert.equal(structuralDisposition(waiting),'VALID');assert.equal(structuralDisposition(progressing),'VALID');
  for(const invalid of [{...waiting,state:'READY'},{...progressing,state:'WAITING'},{...waiting,attempt:3},{...waiting,goalId:'wrong-goal'},{...waiting,workItemId:'wrong-work'},{...waiting,expectedFreshnessVectorRef:'stale-freshness'},{...waiting,extra:true},null]) assert.equal(structuralDisposition(invalid),'INVALID');
  assert.equal(structuralDisposition(waiting,{...scope,goalId:'g-open',workItemId:'wi-gate',freshnessRef:'opaque-freshness-ref',goalStatus:'SUPERSEDED'}),'INVALID');
});

test('G15 preserves four independent goals, explicit edges, terminal isolation, and restart readback',()=>{
  const dir=mkdtempSync(join(tmpdir(),'v3-goal-gate-'));const file=join(dir,'graph.sqlite');
  try { const f=db(file); const items=[goal('order-edit','OPEN',{parentGoalId:'quote-request'}),goal('quote-request'),goal('history-question','OPEN',{relatedGoalIds:['delivery-clarification']}),goal('delivery-clarification','OPEN',{relatedGoalIds:['history-question']})];
    for(const [i,g] of items.entries())f.store.appendGoalEvent({scope,eventId:g.goalId,goal:g,eventType:'CREATED',idempotencyKey:g.goalId,createdAt:at(i+2)});
    f.store.appendGoalEdge({scope,edgeId:'edge-parent',fromGoalId:'order-edit',toGoalId:'quote-request',edgeType:'PARENT',idempotencyKey:'edge-parent',createdAt:at(6)});
    f.store.appendGoalEdge({scope,edgeId:'edge-related',fromGoalId:'history-question',toGoalId:'delivery-clarification',edgeType:'RELATED',idempotencyKey:'edge-related',createdAt:at(7)});
    const terminal=goal('order-edit','SUPERSEDED',{parentGoalId:'quote-request'});f.store.appendGoalEvent({scope,eventId:'order-edit-terminal',goal:terminal,eventType:'SUPERSEDED',idempotencyKey:'order-edit-terminal',createdAt:at(8)});f.database.db.close();
    const reopenedDatabase=new V1Database(file);const graph=new V3GoalGraphStore(reopenedDatabase).readGoalGraph(scope);assert.deepEqual(graph.goals.map(x=>[x.goalId,x.status]),[['order-edit','SUPERSEDED'],['quote-request','OPEN'],['history-question','OPEN'],['delivery-clarification','OPEN']]);assert.equal(graph.edges.length,2);reopenedDatabase.db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('G15 independent SQLite writers allocate unique revisions without silent goal loss',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'v3-goal-gate-race-'));const file=join(dir,'graph.sqlite');
  try {
    const f=db(file); f.database.db.close();
    const barrier=new SharedArrayBuffer(4), view=new Int32Array(barrier);
    const events=['writer-a','writer-b'].map(id=>({scope,eventId:id,goal:goal(id),eventType:'CREATED' as const,idempotencyKey:id,createdAt:at(2)}));
    const workers=events.map(event=>new Worker(new URL('./v3-goal-gate-race-worker.ts',import.meta.url),{workerData:{file,event,barrier},execArgv:['--import','tsx']}));
    await Promise.all(workers.map(w=>new Promise<void>((resolve,reject)=>{w.once('message',m=>m.ready?resolve():reject(Error(String(m))));w.once('error',reject)})));
    Atomics.store(view,0,1); Atomics.notify(view,0,2);
    const results=await Promise.all(workers.map(w=>new Promise<any>((resolve,reject)=>{w.once('message',resolve);w.once('error',reject)})));
    assert.equal(results.filter(x=>x.ok).length,2);
    await Promise.all(workers.map(w=>new Promise<void>(resolve=>w.once('exit',()=>resolve()))));
    const checkDatabase=new V1Database(file); const rows=checkDatabase.db.prepare('SELECT goal_id,revision FROM conversation_goal_events ORDER BY revision').all() as {goal_id:string;revision:number}[]; assert.deepEqual(rows.map(row=>row.revision),[1,2]); assert.deepEqual(rows.map(row=>row.goal_id).sort(),['writer-a','writer-b']); checkDatabase.db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('G22 negative continuation inputs fail closed without interpreting customer language',()=>{
  const base=continuationShape();
  assert.throws(()=>validateV3DurableContinuation({...base,attempt:-1}),/ATTEMPT/);
  assert.throws(()=>validateV3DurableContinuation({...base,budgetState:{maxAttempts:0,consumed:0,deadlineAt:null}}),/BUDGET/);
  assert.equal(structuralDisposition({...base,accountId:'other'}),'INVALID');
  assert.equal(structuralDisposition({...base,conversationId:'other'}),'INVALID');
  assert.throws(()=>validateV3DurableContinuation({...base,resumeConditionRef:''}),/CONDITION/);
  const accessor:any={...base};let called=0;Object.defineProperty(accessor,'ownerId',{enumerable:true,get(){called++;throw Error('getter')}});assert.throws(()=>validateV3DurableContinuation(accessor),/INPUT_SHAPE/);assert.equal(called,0);
});

test('G8/G22 interruption preserves the old plan as stale and never authorizes provider attempts',()=>{
  const recovered=recoverV3StalePlan({planId:'interrupted-plan',reason:'INVALIDATED_DEPENDENCY',currentBundleRevision:4,currentContextSnapshotVersion:'ctx-4'});assert.equal(recovered.decision,'ABORT_REBUNDLE_REBUILD_REPLAN');
  assert.throws(()=>recoverV3StalePlan({...recovered as any,planId:'tampered'}),/PLAN_SHAPE/);
});

test('G15 raw persistence bypass remains blocked and unrelated account data is not projected',()=>{
  const {database,store}=db();const g=goal('isolated');store.appendGoalEvent({scope,eventId:'isolated',goal:g,eventType:'CREATED',idempotencyKey:'isolated',createdAt:at(2)});assert.throws(()=>database.db.prepare("INSERT INTO conversation_goal_events(event_id,account_id,conversation_id,goal_id,event_type,goal_json,goal_hash,idempotency_key,created_at,revision) VALUES('raw','demo-account','conv-001','raw','CREATED','{}','x','raw','2030-01-01T00:00:03Z',99)").run(),/V3_GOAL_EVENT/);assert.throws(()=>store.readGoalGraph({accountId:'other',conversationId:scope.conversationId}),/SCOPE/);database.db.close();
});
