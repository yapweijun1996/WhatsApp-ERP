import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V1Database } from '../src/database.js';
import { WorkspaceMigrationService } from '../src/v2-workspace-migration.js';
import { WorkItemService } from '../src/v2-work-item.js';
import { OrderDraftService } from '../src/v2-order-draft.js';
import { V2QuotationService } from '../src/v2-quotation.js';
import { renderV2QuotationTemplate } from '../src/outbound-message-service.js';
import { CommerceService } from '../src/commerce.js';
import { SimulatedChannel } from '../src/channels.js';
import { createMigrationApprovalAuthority } from '../src/migration-auth.js';
import { issueBoundMigrationApproval } from './migration-approval-helper.js';
import { createHash } from 'node:crypto';

const A='demo-account', C='conv-001', U='CUST-001', M='com004-source';
const LEGACY_SNAPSHOT=JSON.stringify({quotationNo:'QT-RETRY-RACE',customerId:U,currency:'SGD',lines:[{rowItemNo:1,stockCode:'SKU-1',description:'Item',quantity:1,uom:'CTN',unitPriceCents:100,subtotalCents:100}],subtotalCents:100,taxCents:0,grandTotalCents:100});
const LEGACY_HASH=createHash('sha256').update(LEGACY_SNAPSHOT).digest('hex');
const QUOTATION_TEMPLATE='Thank you for your interest. Please review quotation {{quotation_number}} in {{currency}} {{total}}.';

test('V2 quotation outbound renders only AI wording plus explicitly requested canonical facts',()=>{
  const rendered=renderV2QuotationTemplate(QUOTATION_TEMPLATE,{quotation_no:'QT-EXACT',currency:'SGD',grand_total_cents:12345});
  assert.equal(rendered,'Thank you for your interest. Please review quotation QT-EXACT in SGD 123.45.');
  assert.throws(()=>renderV2QuotationTemplate('Please review QT-FAKE in USD 9.99.',{quotation_no:'QT-EXACT',currency:'SGD',grand_total_cents:12345}),/V2_QUOTATION_FACT_PLACEHOLDER_REQUIRED/);
});
function raceWorkers(file:string, quotationId:string, lockAndReleaseInitialRead:()=>void, release:()=>void, initialStatus?:string, constructionOnly=false, allowExpectedError=false){
  const barrier=new SharedArrayBuffer(4), workers=[A,A].map((owner)=>new Worker(new URL('./v2-com-004-race-worker.ts',import.meta.url),{type:'module',execArgv:['--import','tsx'],workerData:{file,quotationId,owner,barrier,initialStatus,constructionOnly}}));
  return new Promise<any[]>((resolve,reject)=>{const results:any[]=[];const completed=new Set<Worker>();let constructed=0,ready=0,done=0,settled=false;const finish=(error?:Error)=>{if(settled)return;settled=true;Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0);void Promise.allSettled(workers.map(worker=>worker.terminate())).finally(()=>error?reject(error):resolve(results));};for(const worker of workers){worker.on('message',message=>{try{if(message.error){if(allowExpectedError){results.push(message);finish();return}finish(Error(message.error));return}if(message.constructed&&++constructed===workers.length){lockAndReleaseInitialRead();Atomics.store(new Int32Array(barrier),0,1);Atomics.notify(new Int32Array(barrier),0)}if(message.ready&&++ready===workers.length){release();}if(message.done){completed.add(worker);done++;}if(message.sent||message.done)results.push(message);if(done===workers.length)finish()}catch(error){finish(error instanceof Error?error:Error(String(error)))}});worker.on('error',error=>finish(error));worker.on('exit',code=>{if(!settled&&!completed.has(worker))finish(Error(`race worker exited unexpectedly with code ${code}`))});}});
}

test('COM-004 concurrent V1Database construction preserves the identity trigger invariant',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'com004-db-startup-')),file=join(dir,'commerce.sqlite');
  try{
    await raceWorkers(file,'unused',()=>{},()=>{},undefined,true);
    const db=new V1Database(file);
    assert.equal((db.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='agent_turns_identity_immutable'").get() as any).n,1);
    db.db.close();
  }finally{rmSync(dir,{recursive:true,force:true})}
});
function fixture(outcomes:any[]=[]){
  const authority=createMigrationApprovalAuthority();
  const db=new V1Database(':memory:',authority); db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,datetime('now'))").run(M,C,M,'INBOUND','text','order','+6591110001',A);
  const migration=new WorkspaceMigrationService(db,authority), work=new WorkItemService(db);
  const shadow=migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'shadow',approval:issueBoundMigrationApproval(authority,migration,'com-test','MIGRATION_OWNER','SHADOW_IMPORT',{accountId:A,conversationId:C,customerId:U})});
  migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null,idempotencyKey:'promote',approval:issueBoundMigrationApproval(authority,migration,'com-test','V1_OWNER','PROMOTE_CANARY',{accountId:A,conversationId:C,customerId:U},{expectedHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null})});
  const item=work.getOrCreate({accountId:A,conversationId:C,customerId:U,sourceMessageId:M,idempotencyKey:'work'});
  const drafts=new OrderDraftService(db,work); const draft=drafts.create({workItemId:item.id,accountId:A,conversationId:C,customerId:U,sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD',lines:[{lineNo:1,requestedWording:'ayam',quantity:1,requestedUom:'CTN'}]},{idempotencyKey:'draft',expectedWorkItemRevision:item.revision});
  const channel=new SimulatedChannel(outcomes); void channel.connect();
  const commerce=new CommerceService(db,channel); const quotes=new V2QuotationService(db,commerce);
  return {db,work,drafts,draft,commerce,quotes,channel,item:work.read(item.id)!};
}

test('COM-004 fresh quote preparation snapshots the exact revision and supersedes atomically on proven submit',async()=>{
  const x=fixture([{status:'submitted',externalMessageId:'new-out',submittedAt:new Date().toISOString()}]);
  x.db.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('old-sent','QT-OLD',U,'SENT','SGD','2026-09-10','2026-09-20',C,M,100,0,100);
  const requote=x.drafts.prepareRequote(x.draft.id,{idempotencyKey:'requote',sourceMessageId:M,expectedDraftRevision:1,expectedWorkItemRevision:x.item.revision});
  const prepared=await x.quotes.prepare({scope:{accountId:A,conversationId:C},draftId:x.draft.id,revision:requote.current_revision,expectedWorkItemRevision:x.work.read(x.item.id)!.revision});
  assert.equal(prepared.status,'SUCCEEDED');
  const q=(x.db.db.prepare("SELECT * FROM quotations WHERE status='DRAFT'").get() as any);
  const replay=await x.quotes.prepare({scope:{accountId:A,conversationId:C},draftId:x.draft.id,revision:2,expectedWorkItemRevision:x.work.read(x.item.id)!.revision});
  assert.equal((replay as any).data.id,q.id); assert.equal((x.db.db.prepare("SELECT count(*) n FROM quotations WHERE status='DRAFT'").get() as any).n,1);
  x.db.db.prepare("UPDATE quotations SET status='SENT' WHERE id<>?").run(q.id);
  const sent=await x.quotes.send(q.id,QUOTATION_TEMPLATE); assert.equal(sent.status,'SUCCEEDED');
  assert.equal(x.channel.sent[0].text,'Thank you for your interest. Please review quotation QT-000001 in SGD 48.00.');
  const statuses=x.db.db.prepare('SELECT status,superseded_by_quotation_id FROM quotations ORDER BY rowid').all() as any[];
  assert.deepEqual(statuses.map(r=>r.status),['SUPERSEDED','SENT']); assert.equal(statuses[0].superseded_by_quotation_id,q.id);
  const snap=JSON.parse((x.db.db.prepare('SELECT sent_snapshot_json FROM quotations WHERE id=?').get(q.id) as any).sent_snapshot_json);
  // PREPARE_REQUOTE is DRAFT-003 itself: it creates immutable revision 2.
  // COM-004 must bind the replacement to that exact revision, not the prior
  // revision that was used to request the change.
  assert.equal(snap.sourceDraftId,x.draft.id); assert.equal(snap.sourceDraftRevision,2);
  assert.equal((x.db.db.prepare('SELECT count(*) n FROM commercial_integrity_seals WHERE entity_type=\'QUOTATION\' AND entity_id=?').get(q.id) as any).n,1);
});

test('COM-004 independent SQLite connections give retry ownership to one failed-attempt transition',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'com004-retry-race-')),file=join(dir,'commerce.sqlite');let db:V1Database|undefined;
  try{
    db=new V1Database(file);db.resetAndSeed();
    db.db.prepare("INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents,sent_snapshot_json,sent_snapshot_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('retry-race-quote','QT-RETRY-RACE',U,'DRAFT','SGD','2026-09-10','2099-09-20',C,M,100,0,100,LEGACY_SNAPSHOT,LEGACY_HASH);
    db.db.prepare('INSERT INTO outbound_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('retry-race-out',C,null,'quote-QT-RETRY-RACE','QUOTATION','retry-race-quote',LEGACY_HASH,JSON.stringify({quotationNo:'QT-RETRY-RACE',snapshot:LEGACY_SNAPSHOT,customerMessage:''}),'FAILED',1,'retryable:temporary',null,new Date().toISOString());
    const locked=db;
    const results=await raceWorkers(file,'retry-race-quote',()=>locked.db.exec('BEGIN IMMEDIATE'),()=>{locked.db.exec('COMMIT');locked.db.close();db=undefined},'FAILED');
    assert.equal(results.filter(result=>result.sent).length,1,JSON.stringify(results));
    const final=new V1Database(file);assert.equal((final.db.prepare('SELECT attempt_count FROM outbound_messages WHERE id=?').get('retry-race-out') as any).attempt_count,2);assert.equal((final.db.prepare('SELECT status FROM quotations WHERE id=?').get('retry-race-quote') as any).status,'SENT');final.db.close();
  }finally{db?.db.close();rmSync(dir,{recursive:true,force:true})}
});

test('COM-004 independent SQLite connections fail closed for an unsealed no-line quotation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'com004-race-')),file=join(dir,'commerce.sqlite');let db:V1Database|undefined;
  try{
    db=new V1Database(file);db.resetAndSeed();
    db.db.prepare("INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents,sent_snapshot_json,sent_snapshot_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('race-quote','QT-RACE',U,'DRAFT','SGD','2026-09-10','2099-09-20',C,M,100,0,100,LEGACY_SNAPSHOT.replace('QT-RETRY-RACE','QT-RACE'),createHash('sha256').update(LEGACY_SNAPSHOT.replace('QT-RETRY-RACE','QT-RACE')).digest('hex'));
    const locked=db;
    const results=await raceWorkers(file,'race-quote',()=>locked.db.exec('BEGIN IMMEDIATE'),()=>{locked.db.exec('COMMIT');locked.db.close();db=undefined},undefined,false,true);
    assert.equal(results.filter(result=>result.sent).length,0,JSON.stringify(results));
    const final=new V1Database(file);assert.equal((final.db.prepare('SELECT count(*) AS n FROM outbound_messages WHERE entity_id=?').get('race-quote') as any).n,0);assert.equal((final.db.prepare('SELECT status FROM quotations WHERE id=?').get('race-quote') as any).status,'DRAFT');final.db.close();
  }finally{db?.db.close();rmSync(dir,{recursive:true,force:true})}
});

test('COM-004 terminal non-submitted replacement failure preserves the old SENT quote and never retries blindly',async()=>{
  const x=fixture([{status:'failed',retryable:false,errorCode:'REJECTED'}]);
  const old='old-sent'; x.db.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(old,'QT-OLD',U,'SENT','SGD','2026-09-10','2026-09-20',C,M,100,0,100);
  const requote=x.drafts.prepareRequote(x.draft.id,{idempotencyKey:'requote',sourceMessageId:M,expectedDraftRevision:1,expectedWorkItemRevision:x.item.revision});
  const prepared=await x.quotes.prepare({scope:{accountId:A,conversationId:C},draftId:x.draft.id,revision:requote.current_revision,expectedWorkItemRevision:x.work.read(x.item.id)!.revision});
  const q=(prepared as any).data.id; const failed=await x.quotes.send(q,QUOTATION_TEMPLATE); assert.equal(failed.status,'FAILED');
  assert.equal((x.db.db.prepare('SELECT status FROM quotations WHERE id=?').get(old) as any).status,'SENT');
  assert.equal((x.db.db.prepare('SELECT status FROM quotations WHERE id=?').get(q) as any).status,'DRAFT');
  await x.quotes.send(q,QUOTATION_TEMPLATE); assert.equal(x.channel.sendCount,1);
});

test('COM-004 retry replays the exact durable caption and PDF despite changed caller input and quote snapshot',async()=>{
  const x=fixture([{status:'failed',retryable:true,errorCode:'TEMPORARY'}]);
  const prepared=await x.quotes.prepare({scope:{accountId:A,conversationId:C},draftId:x.draft.id,revision:1,expectedWorkItemRevision:x.work.revision});
  const q=(prepared as any).data.id;
  const first=await x.quotes.send(q,QUOTATION_TEMPLATE); assert.equal(first.status,'RETRYABLE');
  const before=x.channel.sent[0]; const payload=(x.db.db.prepare('SELECT payload_json FROM outbound_messages WHERE entity_id=?').get(q) as any).payload_json;
  x.db.db.prepare("UPDATE quotations SET sent_snapshot_json='{}',sent_snapshot_hash='bad' WHERE id=?").run(q);
  const second=await x.quotes.send(q,'Thank you {{quotation_number}} in USD {{total}}.'); assert.equal(second.status,'SUCCEEDED');
  assert.deepEqual(x.channel.sent[1],before); assert.equal((x.db.db.prepare('SELECT payload_json FROM outbound_messages WHERE entity_id=?').get(q) as any).payload_json,payload);
});

test('COM-004 accepted commitment blocks quote preparation at the AI cutoff',async()=>{
  const x=fixture();
  const postedBefore=(x.db.db.prepare("SELECT count(*) n FROM sales_orders WHERE status IN ('POSTED','CONFIRMED','DO_READY')").get() as any).n;
  x.db.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('accepted','QT-ACCEPTED',U,'ACCEPTED','SGD','2026-09-10','2026-09-20',C,M,100,0,100);
  const result=await x.quotes.prepare({scope:{accountId:A,conversationId:C},draftId:x.draft.id,revision:1,expectedWorkItemRevision:x.work.read(x.item.id)!.revision});
  assert.equal(result.status,'BLOCKED'); assert.equal((result as any).reasonCode,'CANONICAL_COMMITMENT_HANDOFF');
  assert.equal((x.db.db.prepare("SELECT count(*) n FROM sales_orders WHERE status IN ('POSTED','CONFIRMED','DO_READY')").get() as any).n,postedBefore);
});

test('COM-004 pending/unknown replacement keeps old SENT and reconciliation does not blind resend',async()=>{
  const x=fixture([{status:'unknown',clientMessageId:'ignored'}]);
  const old='old-sent'; x.db.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(old,'QT-OLD',U,'SENT','SGD','2026-09-10','2026-09-20',C,M,100,0,100);
  const requote=x.drafts.prepareRequote(x.draft.id,{idempotencyKey:'requote',sourceMessageId:M,expectedDraftRevision:1,expectedWorkItemRevision:x.item.revision});
  const prepared=await x.quotes.prepare({scope:{accountId:A,conversationId:C},draftId:x.draft.id,revision:requote.current_revision,expectedWorkItemRevision:x.work.read(x.item.id)!.revision});
  const q=(prepared as any).data.id; const pending=await x.quotes.send(q,QUOTATION_TEMPLATE); assert.equal(pending.status,'BLOCKED');
  assert.equal((x.db.db.prepare('SELECT status FROM quotations WHERE id=?').get(old) as any).status,'SENT');
  assert.equal((x.db.db.prepare('SELECT status FROM quotations WHERE id=?').get(q) as any).status,'DRAFT');
  assert.equal(x.channel.sendCount,1); await x.quotes.reconcile(); assert.equal(x.channel.sendCount,1);
});

test('COM-004 changed ERP truth blocks quote-time preparation without promoting prior validation',async()=>{
  const x=fixture();
  const validation=await x.drafts.validate(x.draft.id,{idempotencyKey:'validate',sourceMessageId:M,expectedDraftRevision:1,expectedWorkItemRevision:x.item.revision});
  assert.equal(validation.status,'SUCCEEDED');
  x.db.db.prepare("UPDATE stock_balances SET quantity_base='0' WHERE warehouse_id='SG-MAIN'").run();
  const result=await x.quotes.prepare({scope:{accountId:A,conversationId:C},draftId:x.draft.id,revision:2,expectedWorkItemRevision:x.work.read(x.item.id)!.revision});
  assert.equal(result.status,'BLOCKED'); assert.equal((result as any).reasonCode,'STOCK_SHORTAGE');
  assert.equal((x.db.db.prepare('SELECT count(*) n FROM quotations').get() as any).n,0);
});

test('COM-004 V2 prepared and sent quote accepts once and copies its immutable snapshot to one Draft SO',async()=>{
  const x=fixture([{status:'submitted',externalMessageId:'v2-accept-out',submittedAt:new Date().toISOString()}]);
  const prepared=await x.quotes.prepare({scope:{accountId:A,conversationId:C},draftId:x.draft.id,revision:1,expectedWorkItemRevision:x.work.revision});
  assert.equal(prepared.status,'SUCCEEDED');
  const quotationId=(prepared as any).data.id;
  const sent=await x.quotes.send(quotationId,QUOTATION_TEMPLATE); assert.equal(sent.status,'SUCCEEDED',JSON.stringify(sent));
  const before=x.db.db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId) as any;
  const snapshot=JSON.parse(before.sent_snapshot_json);
  await x.commerce.inbound({accountId:A,conversationId:C,externalMessageId:'v2-accept-inbound',type:'text',text:'OK confirm',sender:{externalId:'+6591110001',phone:'+6591110001'},occurredAt:new Date().toISOString()});
  (x.commerce as any).accept({accountId:A,conversationId:C,externalMessageId:'v2-accept-inbound',type:'text',text:'OK confirm',sender:{externalId:'+6591110001',phone:'+6591110001'}},before);
  const accepted=x.db.db.prepare('SELECT status FROM quotations WHERE id=?').get(quotationId) as any;
  const acceptances=x.db.db.prepare('SELECT count(*) n FROM quotation_acceptances WHERE quotation_id=?').get(quotationId) as any;
  const orders=x.db.db.prepare('SELECT * FROM sales_orders WHERE source_quotation_id=?').all(quotationId) as any[];
  assert.equal(accepted.status,'ACCEPTED'); assert.equal(acceptances.n,1); assert.equal(orders.length,1); assert.equal(orders[0].status,'DRAFT');
  assert.deepEqual(orders[0],{...orders[0],status:'DRAFT',source_quotation_id:quotationId});
  const lines=x.db.db.prepare('SELECT product_id,stock_code,stock_description,quantity,uom,unit_price_cents,subtotal_cents FROM sales_order_lines WHERE sales_order_id=? ORDER BY row_item_no').all(orders[0].id) as any[];
  assert.deepEqual(lines,snapshot.lines.map((line:any)=>({product_id:line.productId,stock_code:line.stockCode,stock_description:line.description,quantity:String(line.quantity),uom:line.uom,unit_price_cents:line.unitPriceCents,subtotal_cents:line.subtotalCents})));
  await x.commerce.inbound({accountId:A,conversationId:C,externalMessageId:'v2-accept-inbound-replay',type:'text',text:'OK confirm',sender:{externalId:'+6591110001',phone:'+6591110001'},occurredAt:new Date().toISOString()});
  assert.equal((x.db.db.prepare('SELECT count(*) n FROM quotation_acceptances WHERE quotation_id=?').get(quotationId) as any).n,1);
  assert.equal((x.db.db.prepare('SELECT count(*) n FROM sales_orders WHERE source_quotation_id=?').get(quotationId) as any).n,1);
});
