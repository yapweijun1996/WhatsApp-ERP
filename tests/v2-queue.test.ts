import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {V1Database} from '../src/database.js';
import {V2QueueService} from '../src/v2-queue.js';
import {AgentTurnCoordinator} from '../src/v2-agent-turn-coordinator.js';

const scope={accountId:'demo-account',conversationId:'conv-001'} as const;
const leaseBaseMs=Date.now()+5*60_000;
function leaseNow(offsetMs=0){return new Date(leaseBaseMs+offsetMs).toISOString()}
function db(){const d=new V1Database(':memory:');d.resetAndSeed();return d}
function inbound(q:V2QueueService,n:string,occurredAt:string){return q.enqueueInbound({...scope,externalMessageId:n,occurredAt,text:n})}
function turn(d:V1Database,messageId:string){return new AgentTurnCoordinator(d).start({accountId:scope.accountId,conversationId:scope.conversationId,inboundMessageId:messageId,nowIso:leaseNow(),timezone:'UTC'}).turnId}
function commerce(d:V1Database){d.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('m-source','conv-001','m-source','INBOUND','text','yes','demo-account','2026-09-09')").run();d.db.prepare("INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,delivery_date,warehouse_id,remark,subtotal_cents,tax_cents,grand_total_cents,source_conversation_id,source_message_id,sent_at,accepted_at,sent_snapshot_json,sent_snapshot_hash,sent_outbound_message_id,superseded_by_quotation_id) VALUES('q1','QT-1','CUST-001','SENT','SGD','2026-09-10','2026-09-30',NULL,'SG-MAIN',NULL,100,0,100,'conv-001','m-source',NULL,NULL,NULL,NULL,NULL,NULL)").run();d.db.prepare("INSERT INTO quotation_acceptances VALUES('a1','q1','m-source','sender','2026-09-10','{}')").run();d.db.prepare("INSERT INTO sales_orders VALUES('so1','SO-1','CUST-001','DRAFT','SGD',NULL,'SG-MAIN',NULL,100,0,100,'q1','m-source',NULL,NULL)").run();d.db.prepare("INSERT INTO outbound_messages(id,conversation_id,external_message_id,client_message_id,entity_type,entity_id,snapshot_hash,payload_json,status,attempt_count,last_error,submitted_at,created_at) VALUES('out1','conv-001',NULL,'client-1','QUOTATION','q1','hash','{}','SUBMITTED',1,NULL,NULL,'2026-09-10')").run()}
async function raceWorkers(mode:'enqueue'|'claim', specs:Array<Record<string,unknown>>){
 const barrier=new SharedArrayBuffer(4),view=new Int32Array(barrier),workers:Worker[]=[];
 const wait=(worker:Worker,predicate:(value:any)=>boolean,ms=5000)=>new Promise<any>((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>finish(undefined,new Error('RACE_TIMEOUT')),ms);const onMessage=(value:any)=>{if(predicate(value))finish(value)};const onError=(error:Error)=>finish(undefined,error);const finish=(value:any,error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);worker.off('message',onMessage);worker.off('error',onError);if(error)reject(error);else resolve(value)};worker.on('message',onMessage);worker.on('error',onError)});
 try{for(const spec of specs){const worker=new Worker(new URL('./v2-queue-race-worker.ts',import.meta.url),{workerData:{...spec,mode,barrier},execArgv:['--import','tsx']});workers.push(worker);const ready=await wait(worker,v=>v.ready===true);assert.equal(ready.ready,true)}Atomics.store(view,0,1);Atomics.notify(view,0,workers.length);return await Promise.all(workers.map(worker=>wait(worker,v=>'ok' in v)))}finally{Atomics.store(view,0,1);Atomics.notify(view,0,workers.length);const terminationResults=await Promise.allSettled(workers.map(worker=>Promise.resolve().then(()=>worker.terminate())));const terminationFailure=terminationResults.find(result=>result.status==='rejected');if(terminationFailure){const reason=String(terminationFailure.reason).slice(0,200);throw new Error(`RACE_TERMINATE_FAILED: ${reason}`)}}
}

test('QUEUE arrival sequence is monotonic by receipt, not provider occurred_at, and redelivery dedupes',()=>{
 const d=db(),q=new V2QueueService(d);const a=inbound(q,'ext-a','2030-01-01T00:00:00Z'),b=inbound(q,'ext-b','2020-01-01T00:00:00Z'),again=inbound(q,'ext-a','2010-01-01T00:00:00Z');
 assert.equal(a.arrivalSeq,1);assert.equal(b.arrivalSeq,2);assert.equal(again.deduplicated,true);assert.equal(again.arrivalSeq,1);const lease=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;q.complete({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1});assert.equal(q.read(scope).processedWatermark,1);const late=inbound(q,'ext-late','2000-01-01T00:00:00Z');assert.equal(late.arrivalSeq,3);assert.equal(q.read(scope).processedWatermark,1);
});

test('QUEUE lease is exclusive, heartbeats, expires, and can be reacquired/resumed',()=>{
 const d=db(),q=new V2QueueService(d);inbound(q,'ext-lease','2026-09-10T00:00:00Z');const lease=q.claimNext({...scope,owner:'worker-a',leaseMs:10_000,nowIso:leaseNow()})!;
 assert.throws(()=>q.claimNext({...scope,owner:'worker-b',nowIso:leaseNow(1_000)}),/LEASE_BUSY/);q.heartbeat({...scope,owner:'worker-a',leaseToken:lease.leaseToken,nowIso:leaseNow(2_000)});
 const resumed=q.claimNext({...scope,owner:'worker-b',nowIso:leaseNow(60_000)})!;assert.equal(resumed.arrivalSeq,1);assert.equal(resumed.sideEffectStarted,false);q.complete({...scope,owner:'worker-b',leaseToken:resumed.leaseToken,arrivalSeq:1});assert.equal(q.read(scope).processedWatermark,1);
});

test('QUEUE same-owner replacement and stale tokens cannot fence the current item',()=>{
 const d=db(),q=new V2QueueService(d);inbound(q,'ext-fence','2026-09-10T00:00:00Z');const first=q.claimNext({...scope,owner:'same',leaseMs:10_000,nowIso:leaseNow()})!;
 assert.throws(()=>q.claimNext({...scope,owner:'same',nowIso:leaseNow(1_000)}),/LEASE_BUSY/);
 const replacement=q.claimNext({...scope,owner:'same',nowIso:leaseNow(60_000)})!;
 assert.notEqual(replacement.leaseToken,first.leaseToken);assert.throws(()=>q.complete({...scope,owner:'same',leaseToken:first.leaseToken,arrivalSeq:1}),/LEASE_EXPIRED|LEASE_FENCED/);
 q.complete({...scope,owner:'same',leaseToken:replacement.leaseToken,arrivalSeq:1});assert.equal(q.read(scope).processedWatermark,1);
});

test('QUEUE post-side-effect expiry resumes the same item and finishes idempotently',()=>{
 const d=db(),q=new V2QueueService(d);const message=inbound(q,'ext-side-effect-resume','2026-09-10T00:00:00Z'),turnId=turn(d,message.messageId);const first=q.claimNext({...scope,owner:'old',leaseMs:1_000,nowIso:leaseNow()})!;
 q.markSideEffectStarted({...scope,owner:'old',leaseToken:first.leaseToken,arrivalSeq:1,turnId});const resumed=q.claimNext({...scope,owner:'new',nowIso:leaseNow(60_000)})!;
 assert.equal(resumed.id,first.id);assert.equal(resumed.sideEffectStarted,true);q.complete({...scope,owner:'new',leaseToken:resumed.leaseToken,arrivalSeq:1,result:'already-posted'});assert.equal(q.read(scope).items[0].state,'COMPLETED');
});

test('QUEUE durable resume works in a fresh service/database instance',()=>{
 const dir=mkdtempSync(join(tmpdir(),'v2-queue-')),file=join(dir,'db.sqlite');try{let d=new V1Database(file);d.resetAndSeed();let q=new V2QueueService(d);inbound(q,'ext-restart','2026-09-10T00:00:00Z');const first=q.claimNext({...scope,owner:'old',nowIso:leaseNow()})!;d.db.close();d=new V1Database(file);q=new V2QueueService(d);const second=q.claimNext({...scope,owner:'new',nowIso:leaseNow(60_000)})!;assert.equal(second.arrivalSeq,first.arrivalSeq);q.complete({...scope,owner:'new',leaseToken:second.leaseToken,arrivalSeq:1});d.db.close();}finally{rmSync(dir,{recursive:true,force:true})}
});

test('QUEUE newer input supersedes before side effect, but never after side effect starts',()=>{
 const d=db(),q=new V2QueueService(d),oldMessage=inbound(q,'ext-old','2026-09-10T00:00:00Z'),oldTurn=turn(d,oldMessage.messageId);const old=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;inbound(q,'ext-new','2026-09-10T00:00:01Z');const stale=q.recheckBeforeSideEffect({...scope,owner:'w',leaseToken:old.leaseToken,arrivalSeq:1,turnId:oldTurn});assert.deepEqual(stale,{ok:false,reasonCode:'NEWER_INPUT_QUEUED'});assert.equal(q.read(scope).items[0].state,'SUPERSEDED');
 const next=q.claimNext({...scope,owner:'w2',nowIso:leaseNow(2_000)})!,nextTurn=turn(d,q.read(scope).items[1].messageId);assert.equal(q.markSideEffectStarted({...scope,owner:'w2',leaseToken:next.leaseToken,arrivalSeq:2,turnId:nextTurn}).sideEffectStarted,true);inbound(q,'ext-later','2026-09-10T00:00:03Z');const allowed=q.recheckBeforeSideEffect({...scope,owner:'w2',leaseToken:next.leaseToken,arrivalSeq:2,turnId:nextTurn});assert.equal(allowed.ok,true);assert.equal(allowed.reasonCode,'AUTHORIZED');q.complete({...scope,owner:'w2',leaseToken:next.leaseToken,arrivalSeq:2,result:'done'});
});

test('QUEUE expired old token cannot supersede or release a reacquired lease',()=>{
 const d=db(),q=new V2QueueService(d),message=inbound(q,'ext-old-token','2026-09-10T00:00:00Z'),turnId=turn(d,message.messageId),old=q.claimNext({...scope,owner:'old',leaseMs:1_000,nowIso:leaseNow()})!;
 inbound(q,'ext-new-token','2026-09-10T00:00:01Z');const fresh=q.claimNext({...scope,owner:'new',nowIso:leaseNow(60_000)})!;
 assert.throws(()=>q.recheckBeforeSideEffect({...scope,owner:'old',leaseToken:old.leaseToken,arrivalSeq:1,turnId}),/LEASE_EXPIRED/);
 assert.equal(q.read(scope).leaseOwner,'new');assert.equal(q.read(scope).items[0].state,'PROCESSING');assert.equal(fresh.leaseToken===old.leaseToken,false);
});

test('QUEUE atomic side-effect authorization fences newer input before marking',()=>{
 const d=db(),q=new V2QueueService(d),message=inbound(q,'ext-atomic-newer','2026-09-10T00:00:00Z'),turnId=turn(d,message.messageId),lease=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;inbound(q,'ext-atomic-newer-2','2026-09-10T00:00:01Z');
 assert.throws(()=>q.markSideEffectStarted({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,turnId}),/NEWER_INPUT_QUEUED/);assert.equal(q.read(scope).items[0].sideEffectStarted,false);assert.equal(q.read(scope).items[0].state,'SUPERSEDED');assert.equal(q.read(scope).leaseOwner,null);
});

test('QUEUE atomic side-effect authorization detects canonical mutation as stale',()=>{
 const d=db(),q=new V2QueueService(d),message=inbound(q,'ext-atomic-stale','2026-09-10T00:00:00Z'),turnId=turn(d,message.messageId),lease=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;d.db.prepare("UPDATE customers SET credit_status='HOLD' WHERE id='CUST-001'").run();
 assert.throws(()=>q.markSideEffectStarted({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,turnId}),/STALE_CONTEXT/);assert.equal(q.read(scope).items[0].sideEffectStarted,false);assert.equal(q.read(scope).items[0].state,'PROCESSING');
});

test('QUEUE freshness fingerprints only current draft product/customer price/current warehouse stock',()=>{
 const d=db(),q=new V2QueueService(d),message=inbound(q,'ext-scoped-freshness','2026-09-10T00:00:00Z');
 d.db.prepare("INSERT INTO work_items(id,account_id,conversation_id,customer_id,type,state,revision,goal_summary,active_order_draft_id,active_quotation_id,assigned_profile,blocking_reason,source_message_id,created_at,updated_at) VALUES('wi-fresh',?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(scope.accountId,scope.conversationId,'CUST-001','SALES_ORDER_REQUEST','DRAFTING',1,'goal','draft-fresh',null,null,null,message.messageId,'2026-09-10','2026-09-10');
 d.db.prepare("INSERT INTO order_drafts VALUES('draft-fresh','wi-fresh',?,?,?,'CURRENT',1,NULL,'SG-MAIN','SGD',?, '2026-09-10','2026-09-10')").run(scope.accountId,scope.conversationId,'CUST-001',message.messageId);
 d.db.prepare("INSERT INTO order_draft_lines VALUES('line-fresh','draft-fresh',1,'ayam','1','CTN',NULL,'FCH-WHOLE-12','CTN',NULL)").run();
 const turnId=turn(d,message.messageId),lease=q.claimNext({...scope,owner:'fresh',nowIso:leaseNow()})!;
 d.db.prepare("UPDATE products SET description='unrelated changed' WHERE id='FRANK-RED-1KG'").run();
 d.db.prepare("INSERT INTO customers VALUES('CUST-OTHER','CUST-OTHER','Other','SGD','OK','SG-MAIN')").run();
 d.db.prepare("INSERT INTO customer_prices VALUES('price-other','CUST-OTHER','FRANK-RED-1KG','CTN',1,'SGD','2026-01-01',NULL)").run();
 d.db.prepare("UPDATE stock_balances SET quantity_base='999' WHERE product_id='FRANK-RED-1KG' AND warehouse_id='SG-MAIN'").run();
 assert.equal(q.recheckBeforeSideEffect({...scope,owner:'fresh',leaseToken:lease.leaseToken,arrivalSeq:1,turnId}).ok,true);
 d.db.prepare("UPDATE customer_prices SET unit_price_cents=4801 WHERE id='price-ayam'").run();
 d.db.prepare("UPDATE stock_balances SET quantity_base='819' WHERE product_id='FCH-WHOLE-12' AND warehouse_id='SG-MAIN'").run();
 assert.deepEqual(q.recheckBeforeSideEffect({...scope,owner:'fresh',leaseToken:lease.leaseToken,arrivalSeq:1,turnId}),{ok:false,reasonCode:'STALE_CONTEXT'});
});

test('QUEUE caller freshness is forbidden and turn proof is required',()=>{
 const d=db(),q=new V2QueueService(d),message=inbound(q,'ext-context','2026-09-10T00:00:00Z'),turnId=turn(d,message.messageId),lease=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;assert.deepEqual(q.recheckBeforeSideEffect({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,turnId,expectedWorkItemRevision:1} as any),{ok:false,reasonCode:'CALLER_FRESHNESS_FORBIDDEN'});assert.throws(()=>q.recheckBeforeSideEffect({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1} as any),/TURN_ID/);inbound(q,'ext-newer','2026-09-10T00:00:01Z');assert.equal(q.shouldSuppressNonessentialReply({...scope,arrivalSeq:1,runtimeOwned:true,essential:false}),true);assert.equal(q.shouldSuppressNonessentialReply({...scope,arrivalSeq:1,runtimeOwned:false,essential:false}),false);
});

test('QUEUE exact completion replay works after lease release and conflicts fail',()=>{
 const d=db(),q=new V2QueueService(d);inbound(q,'ext-replay','2026-09-10T00:00:00Z');const lease=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;q.complete({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,result:{ok:true}});assert.doesNotThrow(()=>q.complete({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,result:{ok:true}}));assert.throws(()=>q.complete({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,result:{ok:false}}),/COMPLETION_REPLAY_CONFLICT/);
});

test('QUEUE turn, conversation, and inbound-message mismatches reject',()=>{
 const d=db(),q=new V2QueueService(d),message=inbound(q,'ext-scope','2026-09-10T00:00:00Z'),validTurn=turn(d,message.messageId),lease=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;
 assert.throws(()=>q.recheckBeforeSideEffect({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,turnId:'missing'}),/TURN_NOT_FOUND/);
 const other=inbound(q,'ext-other','2026-09-10T00:00:01Z');const otherTurn=turn(d,other.messageId);assert.throws(()=>q.recheckBeforeSideEffect({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,turnId:otherTurn}),/TURN_SCOPE/);
});

test('QUEUE canonical quote/status/outbound/SO mutations block side-effect start with unchanged workspace revisions',()=>{
 const mutations=[
  (d:V1Database)=>d.db.prepare("UPDATE quotations SET status='SUPERSEDED' WHERE id='q1'").run(),
  (d:V1Database)=>d.db.prepare("UPDATE outbound_messages SET status='FAILED' WHERE id='out1'").run(),
  (d:V1Database)=>d.db.prepare("UPDATE sales_orders SET status='CONFIRMED' WHERE id='so1'").run(),
 ];
 for(const mutate of mutations){const d=db(),q=new V2QueueService(d);commerce(d);const message=inbound(q,'ext-commerce-'+mutations.indexOf(mutate),'2026-09-10T00:00:00Z'),turnId=turn(d,message.messageId),lease=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;const before=d.db.prepare('SELECT revision FROM work_items WHERE conversation_id=?').get(scope.conversationId);mutate(d);assert.deepEqual(d.db.prepare('SELECT revision FROM work_items WHERE conversation_id=?').get(scope.conversationId),before);assert.deepEqual(q.recheckBeforeSideEffect({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,turnId}),{ok:false,reasonCode:'STALE_CONTEXT'});}
});

test('QUEUE conversation-level outbound mutations invalidate authorization independently of quotation IDs',()=>{
 const d=db(),q=new V2QueueService(d),message=inbound(q,'ext-conversation-outbound','2026-09-10T00:00:00Z'),turnId=turn(d,message.messageId);
 d.db.prepare("INSERT INTO outbound_messages(id,conversation_id,external_message_id,client_message_id,entity_type,entity_id,snapshot_hash,payload_json,status,attempt_count,last_error,submitted_at,created_at) VALUES('out-other','conv-001',NULL,'client-other','OTHER','conversation','hash-other','{\"body\":\"before\"}','PENDING',0,NULL,NULL,'2026-09-10')").run();
 const lease=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;
 d.db.prepare("UPDATE outbound_messages SET status='FAILED',payload_json='{\"body\":\"after\"}',attempt_count=1 WHERE id='out-other'").run();
 assert.deepEqual(q.recheckBeforeSideEffect({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,turnId}),{ok:false,reasonCode:'STALE_CONTEXT'});
 assert.throws(()=>q.markSideEffectStarted({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,turnId}),/STALE_CONTEXT/);
 assert.equal(q.read(scope).items[0].sideEffectStarted,false);
});

test('QUEUE customer policy and validation evidence mutations invalidate authorization',()=>{
 const cases=[
  (d:V1Database)=>d.db.prepare("UPDATE customers SET credit_status='HOLD' WHERE id='CUST-001'").run(),
  (d:V1Database)=>d.insertV2OrderValidation({id:'v2-new',draftId:'draft-policy',draftRevision:1,mode:'DRAFT',status:'BLOCKED',resultJson:'{}',evidenceRefsJson:'["ev-queue"]',createdAt:'2026-09-10'}),
  (d:V1Database)=>{d.insertV2ErpEvidence({id:'ev-queue-new',evidenceType:'stock',toolCallId:'tool-new',lookupKey:'lookup-new',inputJson:'{}',outputJson:'{}',observedAt:'2026-09-10',sourceVersion:'erp-v2'});d.insertV2OrderValidation({id:'v2-new-evidence',draftId:'draft-policy',draftRevision:1,mode:'DRAFT',status:'SUCCEEDED',resultJson:'{}',evidenceRefsJson:'["ev-queue-new"]',createdAt:'2026-09-10'});},
 ];
 for(const mutate of cases){const d=db(),q=new V2QueueService(d);const message=inbound(q,'ext-policy-'+cases.indexOf(mutate),'2026-09-10T00:00:00Z');d.db.prepare("INSERT INTO work_items(id,account_id,conversation_id,customer_id,type,state,revision,goal_summary,active_order_draft_id,active_quotation_id,assigned_profile,blocking_reason,source_message_id,created_at,updated_at) VALUES('wi-policy',?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(scope.accountId,scope.conversationId,'CUST-001','SALES_ORDER_REQUEST','DRAFTING',1,'goal','draft-policy',null,null,null,message.messageId,'2026-09-10','2026-09-10');
  d.db.prepare("INSERT INTO order_drafts VALUES('draft-policy','wi-policy',?,?,?,'CURRENT',1,NULL,'SG-MAIN','SGD',?, '2026-09-10','2026-09-10')").run(scope.accountId,scope.conversationId,'CUST-001',message.messageId);d.insertV2ErpEvidence({id:'ev-queue',evidenceType:'stock',toolCallId:'tool',lookupKey:'lookup',inputJson:'{}',outputJson:'{}',observedAt:'2026-09-10',sourceVersion:'erp-v1'});d.insertV2OrderValidation({id:'v2-old',draftId:'draft-policy',draftRevision:1,mode:'DRAFT',status:'SUCCEEDED',resultJson:'{}',evidenceRefsJson:'["ev-queue"]',createdAt:'2026-09-10'});const turnId=turn(d,message.messageId),lease=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;mutate(d);assert.deepEqual(q.recheckBeforeSideEffect({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,turnId}),{ok:false,reasonCode:'STALE_CONTEXT'});
 }
});

test('QUEUE profile role mission tone language and permission plus channel identity changes invalidate authorization',()=>{
 const mutations=[
  (d:V1Database)=>d.db.prepare("UPDATE employee_profiles SET role='OTHER_ROLE' WHERE id='sales-digital-employee'").run(),
  (d:V1Database)=>d.db.prepare("UPDATE employee_profiles SET mission='Other mission' WHERE id='sales-digital-employee'").run(),
  (d:V1Database)=>d.db.prepare("UPDATE employee_profiles SET tone='OTHER_TONE',language_policy_json='{"+"\"mode\":\"ADAPT_TO_CUSTOMER_LANGUAGE\",\"fallbackLocale\":\"ms-SG\"}' WHERE id='sales-digital-employee'").run(),
  (d:V1Database)=>d.db.prepare("UPDATE employee_profiles SET capability_permissions_json='[]' WHERE id='sales-digital-employee'").run(),
  (d:V1Database)=>d.db.prepare("UPDATE customer_channel_identities SET external_id='+6591110002' WHERE id='identity-001'").run(),
 ];
 for(const [index,mutate] of mutations.entries()){const d=db(),q=new V2QueueService(d),message=inbound(q,`ext-profile-${index}`,'2026-09-10T00:00:00Z'),turnId=turn(d,message.messageId),lease=q.claimNext({...scope,owner:'w',nowIso:leaseNow()})!;mutate(d);assert.deepEqual(q.recheckBeforeSideEffect({...scope,owner:'w',leaseToken:lease.leaseToken,arrivalSeq:1,turnId}),{ok:false,reasonCode:'STALE_CONTEXT'});}
});

test('QUEUE two independent SQLite connections race for one live lease, including same owner',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'v2-queue-race-')),file=join(dir,'db.sqlite');let seed:V1Database|undefined;
 try{seed=new V1Database(file);seed.resetAndSeed();const q=new V2QueueService(seed);inbound(q,'ext-two-connections','2026-09-10T00:00:00Z');seed.db.close();seed=undefined;
  const results=await raceWorkers('claim',[{file,owner:'same-owner'},{file,owner:'same-owner'}]);const winners=results.filter(r=>r.ok&&r.lease),losers=results.filter(r=>!r.ok||!r.lease);assert.equal(winners.length,1);assert.equal(losers.length,1);assert.equal(winners[0].lease.arrivalSeq,1);
  const d=new V1Database(file),finalQueue=new V2QueueService(d),winner=winners[0].lease;assert.throws(()=>finalQueue.complete({...scope,owner:'same-owner',leaseToken:'forged',arrivalSeq:1}),/LEASE_EXPIRED|LEASE_FENCED/);assert.equal(finalQueue.read(scope).items[0].state,'PROCESSING');assert.equal(finalQueue.read(scope).processedWatermark,0);d.db.close();
 }finally{seed?.db.close();rmSync(dir,{recursive:true,force:true})}
});

test('QUEUE two independent SQLite connections enqueue without lost inbound or raw SQLITE_BUSY/UNIQUE errors',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'v2-queue-enqueue-race-')),file=join(dir,'db.sqlite');let seed:V1Database|undefined;
 try{seed=new V1Database(file);seed.resetAndSeed();seed.db.close();seed=undefined;
  const results=await raceWorkers('enqueue',[{file,externalMessageId:'ext-enqueue-a',messageId:'m-enqueue-a'},{file,externalMessageId:'ext-enqueue-b',messageId:'m-enqueue-b'}]);assert.ok(results.every(r=>r.ok),JSON.stringify(results));assert.deepEqual(results.map(r=>r.result.arrivalSeq).sort((a:number,b:number)=>a-b),[1,2]);
  const d=new V1Database(file),items=d.db.prepare('SELECT arrival_seq FROM v2_inbox_items WHERE account_id=? AND conversation_id=? ORDER BY arrival_seq').all(scope.accountId,scope.conversationId) as any[];assert.deepEqual(items.map(r=>r.arrival_seq),[1,2]);d.db.close();
 }finally{seed?.db.close();rmSync(dir,{recursive:true,force:true})}
});

test('QUEUE raw callers have no generic authority and cannot mutate queue state',()=>{
 const d=db(),q=new V2QueueService(d),message=inbound(q,'ext-raw-authority','2026-09-10T00:00:00Z');
 for(const name of ['runQueueMutation','queuePersistence','queueTransaction'])assert.equal((d as any)[name],undefined);
 assert.equal((d as any).V2_QUEUE_PERSISTENCE_CAPABILITY,undefined);
 assert.throws(()=>d.db.prepare("INSERT INTO v2_conversation_inbox(account_id,conversation_id,updated_at) VALUES('demo-account','conv-001','now')").run(),/V2_QUEUE_INSERT_REQUIRES_SERVICE/);
 assert.throws(()=>d.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,account_id,occurred_at,arrival_seq) VALUES('x','conv-001','x','INBOUND','text','demo-account','now',99)").run(),/V2_QUEUE_MESSAGE_REQUIRES_SERVICE/);
 assert.throws(()=>d.db.prepare("UPDATE messages SET arrival_seq=99 WHERE id=?").run(message.messageId),/V2_QUEUE_MESSAGE_REQUIRES_SERVICE/);
 assert.throws(()=>d.db.prepare("UPDATE v2_inbox_items SET state='COMPLETED' WHERE message_id=?").run(message.messageId),/IMMUTABLE_V2_QUEUE_ITEM/);
 assert.throws(()=>d.db.prepare("DELETE FROM v2_inbox_items WHERE message_id=?").run(message.messageId),/IMMUTABLE_V2_QUEUE_ITEM/);
 assert.throws(()=>d.db.prepare("UPDATE v2_conversation_inbox SET processed_watermark=99,lease_owner='intruder',lease_token='forged' WHERE account_id='demo-account' AND conversation_id='conv-001'").run(),/IMMUTABLE_V2_QUEUE_STATE/);
});
