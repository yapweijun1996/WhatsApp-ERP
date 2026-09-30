import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,rmSync} from 'node:fs';
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

const scope={accountId:'demo-account',conversationId:'conv-001'} as const;
function fixture(file=':memory:'){
  const database=new V1Database(file);database.resetAndSeed();const queue=new V2QueueService(database);
  const inbound=queue.enqueueInbound({...scope,externalMessageId:'cp004-a',occurredAt:'2030-01-01T00:00:00Z',text:'private'});
  const turn=new AgentTurnCoordinator(database).start({...scope,inboundMessageId:inbound.messageId,nowIso:'2030-01-01T00:00:00Z',timezone:'UTC'});
  const action=new AgentTurnCoordinator(database).propose({turnId:turn.turnId,sequence:1,capabilityName:'get_customer_context',capabilityVersion:'v1',arguments:{accountId:scope.accountId,conversationId:scope.conversationId,customerId:'CUST-001'}}).actions[0];
  const bundle=buildInboundBundle(database.db,{...scope,messageIds:[inbound.messageId],bundleRevision:1,hardCapAt:'2030-01-01T00:00:03Z',closedAt:'2030-01-01T00:00:01Z',closeReason:'QUIET_WINDOW'});
  const raw=JSON.parse(database.db.prepare('SELECT context_snapshot_json FROM agent_turns WHERE id=?').get(turn.turnId)!.context_snapshot_json);
  const context=buildContextSnapshot(raw);
  const deps:Omit<V3FreshnessVectorInput,'authoritativeV2FreshnessFingerprint'>={identityScope:{accountId:scope.accountId,conversationId:scope.conversationId,customerId:'CUST-001',channelAccountId:scope.accountId},employeeProfile:{id:'sales-digital-employee',version:1},capabilityPolicy:{policyVersion:1,availableCapabilities:[]},workItemOrderDraftRefs:{workItem:null,orderDraft:null},canonicalBusiness:{quotations:[],acceptances:[],outbound:[],salesOrders:[]},relevantErpEvidence:[],goalGraph:{version:null,dependencyRefs:[]},attachmentExtraction:{version:null,dependencyRefs:[]},retentionAccess:{version:1,dependencyRefs:[]},conversationBundle:{conversationRevision:bundle.conversationRevisionAtBuild,bundleRevision:bundle.bundleRevision,messageRefs:[{id:inbound.messageId,version:1}]} };
  const vector=buildV3FreshnessVectorFromDatabase(database.db,deps);const claimed=queue.claimNext({...scope,owner:'cp004',nowIso:'2030-01-01T00:00:00Z'})!;const lease=projectReasoningLease(database.db,bundle,context,'2030-01-01T00:00:00Z');
  return {database,queue,bundle,context,vector,claimed,lease,action};
}
function input(f:any){return {bundle:f.bundle,context:f.context,freshnessVector:f.vector,lease:f.lease,arrivalSeq:1,owner:'cp004',leaseToken:f.claimed.leaseToken,nowIso:'2030-01-01T00:00:00Z',actionId:f.action.id,actionSequence:f.action.sequence,capabilityName:f.action.capability.name,capabilityVersion:f.action.capability.version,argumentsHash:String(f.database.db.prepare('SELECT arguments_hash FROM agent_actions WHERE id=?').get(f.action.id).arguments_hash)}}

test('CP-004 admits once and fails closed on an already-started replay',()=>{const f=fixture();const first=admitV3SideEffect(f.database,input(f));assert.throws(()=>admitV3SideEffect(f.database,{...input(f),lease:projectReasoningLease(f.database.db,f.bundle,f.context,'2030-01-01T00:00:00Z')}),/RECONCILE_REQUIRED/);assert.equal(first.status,'ADMITTED');assert.equal(Object.keys(first).sort().join('|'),'effectIdentity|itemId|status');assert.equal(f.database.db.prepare('SELECT side_effect_started FROM v2_inbox_items WHERE id=?').get(f.claimed.id).side_effect_started,1);});
test('CP-004 fails closed before the CAS for stale freshness and tampered action identity',()=>{const f=fixture();f.database.db.prepare("UPDATE employee_profiles SET version=version+1 WHERE id='sales-digital-employee'").run();assert.throws(()=>admitV3SideEffect(f.database,input(f)),/PROFILE_VERSION_MISMATCH|STALE_FRESHNESS_VECTOR|V3_STALE_FRESHNESS/);const g=fixture();assert.throws(()=>admitV3SideEffect(g.database,{...input(g),argumentsHash:'tampered'}),/EFFECT_IDENTITY/);assert.equal(g.database.db.prepare('SELECT side_effect_started FROM v2_inbox_items WHERE id=?').get(g.claimed.id).side_effect_started,0);});
test('CP-004 rejects accessor and extra-field top-level inputs without invoking getters',()=>{const f=fixture();const candidate:any={...input(f)};let invoked=false;Object.defineProperty(candidate,'owner',{get(){invoked=true;throw new Error('GETTER_INVOKED')},enumerable:true});assert.throws(()=>admitV3SideEffect(f.database,candidate),/INPUT_SHAPE/);assert.equal(invoked,false);assert.throws(()=>admitV3SideEffect(f.database,{...input(f),extra:'authority'} as any),/INPUT_SHAPE/);assert.equal(f.database.db.prepare('SELECT side_effect_started FROM v2_inbox_items WHERE id=?').get(f.claimed.id).side_effect_started,0);});

async function race(file:string, admissionInput:unknown, mutation:'newer'|'authority'){
  const barrier=new SharedArrayBuffer(4), view=new Int32Array(barrier);const specs=[{task:'admit',file,admissionInput,barrier},{task:mutation,file,barrier}];const workers=specs.map(data=>new Worker(new URL('./v3-side-effect-admission-race-worker.ts',import.meta.url),{workerData:data,execArgv:['--import','tsx']}));
  await Promise.all(workers.map(worker=>new Promise<void>((resolve,reject)=>{worker.once('message',v=>v.ready?resolve():reject(new Error(String(v))));worker.once('error',reject)})));Atomics.store(view,0,1);Atomics.notify(view,0,2);const results=await Promise.all(workers.map(worker=>new Promise<any>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)})));await Promise.all(workers.map(worker=>worker.terminate()));return results;
}
test('CP-004 multi-connection races are linearizable for newer inbound and authority mutation',async()=>{
  for(const mutation of ['newer','authority'] as const){const dir=mkdtempSync(join(tmpdir(),'v3-cp004-'));const file=join(dir,'db.sqlite');try{const f=fixture(file),proof=input(f);f.database.db.close();const results=await race(file,proof,mutation);assert.equal(results.filter(r=>r.status==='MUTATED').every(r=>r.committed===true),true);const check=new V1Database(file);const row=check.db.prepare('SELECT side_effect_started,state FROM v2_inbox_items WHERE arrival_seq=1').get() as any;if(mutation==='newer'){const admitted=results.some(r=>r.status==='ADMITTED');assert.equal(admitted||row.state==='SUPERSEDED',true);assert.equal(row.side_effect_started===1||row.state==='SUPERSEDED',true);}else{const admitted=results.some(r=>r.status==='ADMITTED');const stale=results.some(r=>String(r.error??'').includes('STALE')||String(r.error??'').includes('PERMISSION'));assert.equal(admitted||stale,true);assert.equal(row.side_effect_started,admitted?1:0);}check.db.close();}finally{rmSync(dir,{recursive:true,force:true})}}
});
