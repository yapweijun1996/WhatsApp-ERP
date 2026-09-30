import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {V1Database} from '../src/database.js';
import {V2QueueService} from '../src/v2-queue.js';
import {AgentTurnCoordinator} from '../src/v2-agent-turn-coordinator.js';
import {buildInboundBundle} from '../src/v3-inbound-bundle.js';
import {buildContextSnapshot} from '../src/v3-context-snapshot.js';
import {buildV3FreshnessVectorFromDatabase, type V3FreshnessVectorInput} from '../src/v3-freshness-vector.js';
import {projectReasoningLease} from '../src/v3-reasoning-lease.js';
import {admitV3SideEffect} from '../src/v3-side-effect-admission.js';
import {recoverV3AdmittedEffect, recoverV3StalePlan} from '../src/v3-control-plane-recovery.js';
import {assertV3PlanContextCurrent, projectV3InvalidationEventFromDatabase} from '../src/v3-invalidation.js';

const scope={accountId:'demo-account',conversationId:'conv-001'} as const;
const t0='2030-01-01T00:00:00Z';

function fixture(file=':memory:') {
  const database=new V1Database(file); database.resetAndSeed(); const queue=new V2QueueService(database);
  const inbound=queue.enqueueInbound({...scope,externalMessageId:'cp007-a',occurredAt:t0,text:'opaque evidence'});
  const turn=new AgentTurnCoordinator(database).start({...scope,inboundMessageId:inbound.messageId,nowIso:t0,timezone:'UTC'});
  const action=new AgentTurnCoordinator(database).propose({turnId:turn.turnId,sequence:1,capabilityName:'get_customer_context',capabilityVersion:'v1',arguments:{accountId:scope.accountId,conversationId:scope.conversationId,customerId:'CUST-001'}}).actions[0];
  const bundle=buildInboundBundle(database.db,{...scope,messageIds:[inbound.messageId],bundleRevision:1,hardCapAt:'2030-01-01T00:00:03Z',closedAt:'2030-01-01T00:00:01Z',closeReason:'QUIET_WINDOW'});
  const raw=JSON.parse((database.db.prepare('SELECT context_snapshot_json FROM agent_turns WHERE id=?').get(turn.turnId) as any).context_snapshot_json);
  const context=buildContextSnapshot(raw);
  const deps:Omit<V3FreshnessVectorInput,'authoritativeV2FreshnessFingerprint'>={identityScope:{accountId:scope.accountId,conversationId:scope.conversationId,customerId:'CUST-001',channelAccountId:scope.accountId},employeeProfile:{id:'sales-digital-employee',version:1},capabilityPolicy:{policyVersion:1,availableCapabilities:[]},workItemOrderDraftRefs:{workItem:null,orderDraft:null},canonicalBusiness:{quotations:[],acceptances:[],outbound:[],salesOrders:[]},relevantErpEvidence:[],goalGraph:{version:null,dependencyRefs:[]},attachmentExtraction:{version:null,dependencyRefs:[]},retentionAccess:{version:1,dependencyRefs:[]},conversationBundle:{conversationRevision:bundle.conversationRevisionAtBuild,bundleRevision:bundle.bundleRevision,messageRefs:[{id:inbound.messageId,version:1}]} };
  const vector=buildV3FreshnessVectorFromDatabase(database.db,deps);
  const claimed=queue.claimNext({...scope,owner:'cp007',leaseMs:1000,nowIso:t0})!;
  const lease=projectReasoningLease(database.db,bundle,context,t0);
  return {database,queue,bundle,context,vector,claimed,lease,action,turnId:turn.turnId,deps};
}
function admissionInput(f:any, lease=f.lease, token=f.claimed.leaseToken, owner='cp007') {
  const hash=(f.database.db.prepare('SELECT arguments_hash FROM agent_actions WHERE id=?').get(f.action.id) as any).arguments_hash;
  return {bundle:f.bundle,context:f.context,freshnessVector:f.vector,lease,arrivalSeq:1,owner,leaseToken:token,nowIso:t0,actionId:f.action.id,actionSequence:f.action.sequence,capabilityName:f.action.capability.name,capabilityVersion:f.action.capability.version,argumentsHash:String(hash)};
}
function close(f:any){f.database.db.close();}

test('CP-007 G2 interrupted burst fences the stale plan and replans without language interpretation',()=>{
  const f=fixture();
  try {
    f.queue.enqueueInbound({...scope,externalMessageId:'cp007-b',occurredAt:'2030-01-01T00:00:01Z',text:'arbitrary newer evidence'});
    assert.throws(()=>admitV3SideEffect(f.database,admissionInput(f)),/NEWER_INPUT_QUEUED/);
    assert.equal(f.queue.read(scope).items[0].state,'SUPERSEDED');
    assert.equal(f.queue.read(scope).items[0].sideEffectStarted,false);
    const recovery=recoverV3StalePlan({planId:'plan-g2',reason:'NEWER_INPUT',currentBundleRevision:2,currentContextSnapshotVersion:f.context.contextSnapshotVersion});
    assert.equal(recovery.decision,'ABORT_REBUNDLE_REBUILD_REPLAN');
  } finally {close(f);}
});

test('CP-007 G18 proves both atomic-admission interleavings on independent SQLite connections',()=>{
  for(const newerFirst of [true,false]) {
    const dir=mkdtempSync(join(tmpdir(),'v3-cp007-g18-')),file=join(dir,'db.sqlite'); let f:any;
    try {
      f=fixture(file); const proof=admissionInput(f); f.database.db.close();
      const first=new V1Database(file),second=new V1Database(file);
      if(newerFirst) {
        new V2QueueService(first).enqueueInbound({...scope,externalMessageId:'cp007-race-new',occurredAt:'2030-01-01T00:00:01Z',text:'new evidence'});
        assert.throws(()=>admitV3SideEffect(second,proof),/NEWER_INPUT_QUEUED|V3_LEASE_NOT_CURRENT/);
        assert.equal((second.db.prepare('SELECT side_effect_started,state FROM v2_inbox_items WHERE arrival_seq=1').get() as any).side_effect_started,0);
      } else {
        assert.equal(admitV3SideEffect(first,proof).status,'ADMITTED');
        new V2QueueService(second).enqueueInbound({...scope,externalMessageId:'cp007-race-after',occurredAt:'2030-01-01T00:00:01Z',text:'post-effect evidence'});
        assert.equal((second.db.prepare('SELECT side_effect_started FROM v2_inbox_items WHERE arrival_seq=1').get() as any).side_effect_started,1);
      }
      first.db.close(); second.db.close();
    } finally {try{f?.database.db.close();}catch{} rmSync(dir,{recursive:true,force:true});}
  }
});

test('CP-007 G19 crash/restart reacquisition permanently fences the old generation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'v3-cp007-g19-')),file=join(dir,'db.sqlite'); let f:any;
  try {
    f=fixture(file); const oldProof=admissionInput(f),oldToken=f.claimed.leaseToken;
    const admitted=admitV3SideEffect(f.database,oldProof);
    assert.equal(admitted.status,'ADMITTED');
    assert.equal((f.database.db.prepare('SELECT side_effect_started FROM v2_inbox_items WHERE arrival_seq=1').get() as any).side_effect_started,1);
    f.database.db.close();
    const resumed=new V1Database(file),queue=new V2QueueService(resumed),next=queue.claimNext({...scope,owner:'worker-b',leaseMs:30000,nowIso:'2030-01-01T00:00:02Z'})!;
    assert.equal(next.sideEffectStarted,true); assert.equal(next.leaseToken===oldToken,false);
    const recovery=recoverV3AdmittedEffect({effectIdentity:admitted.effectIdentity,durableState:'UNKNOWN'});
    assert.equal(recovery.decision,'RECONCILE_REQUIRED'); assert.equal(recovery.mayProviderAttempt,false);
    assert.throws(()=>admitV3SideEffect(resumed,oldProof),/V3_LEASE_NOT_CURRENT|V2_QUEUE_LEASE_FENCED/);
    const current=projectReasoningLease(resumed.db,oldProof.bundle,oldProof.context,'2030-01-01T00:00:02Z');
    assert.equal(current.generation,2);
    assert.throws(()=>admitV3SideEffect(resumed,admissionInput({...f,database:resumed,queue,claimed:next,lease:current},current,next.leaseToken,'worker-b')),/RECONCILE_REQUIRED/);
    assert.equal((resumed.db.prepare('SELECT count(*) AS n FROM v2_inbox_items WHERE side_effect_started=1').get() as any).n,1); resumed.db.close();
  } finally {try{f?.database.db.close();}catch{} rmSync(dir,{recursive:true,force:true});}
});

test('CP-007 G20 invalidates a bound plan with no new inbound and leaves effect unstarted',()=>{
  const f=fixture();
  try {
    f.database.db.prepare("UPDATE customers SET credit_status='HOLD' WHERE id='CUST-001'").run();
    const current=projectV3InvalidationEventFromDatabase(f.database.db,f.vector,f.deps,'2030-01-01T00:00:02Z');
    assert.equal(current.stale,true); assert.deepEqual(current.changedClasses,['authoritativeV2FreshnessFingerprint']);
    assert.throws(()=>assertV3PlanContextCurrent(f.database.db,f.lease,f.bundle,f.context,f.vector,f.deps,'2030-01-01T00:00:00.500Z'),/STALE_CONTEXT/);
    assert.equal((f.database.db.prepare('SELECT count(*) AS n FROM v2_inbox_items WHERE arrival_seq>1').get() as any).n,0);
    assert.equal((f.database.db.prepare('SELECT side_effect_started FROM v2_inbox_items WHERE arrival_seq=1').get() as any).side_effect_started,0);
  } finally {close(f);}
});

async function concurrentClaimRace(file:string,iteration:number) {
  const barrier=new SharedArrayBuffer(4),view=new Int32Array(barrier);
  const workers=[0,1].map(i=>new Worker(new URL('./v2-queue-race-worker.ts',import.meta.url),{workerData:{mode:'claim',file,owner:`stress-${iteration}-${i}`,barrier},execArgv:['--import','tsx']}));
  const ready=workers.map(w=>new Promise<void>((resolve,reject)=>{w.once('message',v=>v.ready?resolve():reject(new Error(String(v))));w.once('error',reject)})); await Promise.all(ready); Atomics.store(view,0,1); Atomics.notify(view,0,2);
  const results=await Promise.all(workers.map(w=>new Promise<any>((resolve,reject)=>{w.once('message',resolve);w.once('error',reject)}))); await Promise.all(workers.map(w=>w.terminate())); return results;
}

async function concurrentAdmissionRace(file:string, admissionInput:unknown, iteration:number) {
  const barrier=new SharedArrayBuffer(4),view=new Int32Array(barrier);
  const specs=[{task:'admit',file,admissionInput,barrier},{task:'newer',file,barrier}];
  const workers=specs.map(data=>new Worker(new URL('./v3-side-effect-admission-race-worker.ts',import.meta.url),{workerData:data,execArgv:['--import','tsx'],name:`cp007-admission-${iteration}`}));
  await Promise.all(workers.map(w=>new Promise<void>((resolve,reject)=>{w.once('message',v=>v.ready?resolve():reject(new Error(String(v))));w.once('error',reject)})));
  Atomics.store(view,0,1); Atomics.notify(view,0,2);
  const results=await Promise.all(workers.map(w=>new Promise<any>((resolve,reject)=>{w.once('message',resolve);w.once('error',reject)})));
  await Promise.all(workers.map(w=>w.terminate())); return results;
}

test('CP-007 bounded multi-connection stress: lease crash/reacquire and claim race have one winner per iteration',async()=>{
  const iterations=12;
  for(let i=0;i<iterations;i++) {
    const dir=mkdtempSync(join(tmpdir(),'v3-cp007-stress-')),file=join(dir,'db.sqlite'); let d:V1Database|undefined;
    try { d=new V1Database(file); d.resetAndSeed(); const q=new V2QueueService(d); q.enqueueInbound({...scope,externalMessageId:`cp007-stress-${i}`,occurredAt:t0,text:'stress'}); const old=q.claimNext({...scope,owner:'crashed',leaseMs:1000,nowIso:t0})!; d.db.close(); d=undefined;
      const resumed=new V1Database(file),rq=new V2QueueService(resumed),next=rq.claimNext({...scope,owner:'reacquired',nowIso:'2030-01-01T00:00:02Z'})!; assert.equal(next.arrivalSeq,old.arrivalSeq); resumed.db.close();
      const raceDir=mkdtempSync(join(tmpdir(),'v3-cp007-race-')),raceFile=join(raceDir,'db.sqlite');
      try { const raceDb=new V1Database(raceFile); raceDb.resetAndSeed(); new V2QueueService(raceDb).enqueueInbound({...scope,externalMessageId:`cp007-race-stress-${i}`,occurredAt:'2026-09-10T00:00:00Z',text:'race'}); raceDb.db.close();
        const raced=await concurrentClaimRace(raceFile,i); assert.equal(raced.filter(r=>r.lease).length,1); assert.equal(raced.filter(r=>!r.lease).length,1);
        const check=new V1Database(raceFile); assert.equal((check.db.prepare('SELECT count(*) AS n FROM v2_conversation_inbox WHERE lease_owner IS NOT NULL').get() as any).n,1); check.db.close();
      } finally {rmSync(raceDir,{recursive:true,force:true});}
      const admissionDir=mkdtempSync(join(tmpdir(),'v3-cp007-admission-race-')),admissionFile=join(admissionDir,'db.sqlite');
      try {
        const admittedFixture=fixture(admissionFile),proof=admissionInput(admittedFixture); admittedFixture.database.db.close();
        const results=await concurrentAdmissionRace(admissionFile,proof,i);
        const admitted=results.filter(r=>r.status==='ADMITTED'),mutated=results.filter(r=>r.status==='MUTATED');
        assert.equal(mutated.length,1); assert.equal(mutated[0].committed,true);
        const check=new V1Database(admissionFile),row=check.db.prepare('SELECT state,side_effect_started FROM v2_inbox_items WHERE arrival_seq=1').get() as any;
        assert.equal(admitted.length===1||row.state==='SUPERSEDED',true);
        assert.equal(Number(row.side_effect_started),admitted.length===1?1:0);
        assert.equal(admitted.length<=1,true); check.db.close();
      } finally {rmSync(admissionDir,{recursive:true,force:true});}
    } finally {d?.db.close();rmSync(dir,{recursive:true,force:true});}
  }
});
