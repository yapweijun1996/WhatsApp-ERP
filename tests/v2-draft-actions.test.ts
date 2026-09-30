import test from 'node:test';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {OrderDraftService,WorkItemService} from '../src/v2-workspace.js';
import {WorkspaceMigrationService} from '../src/v2-workspace-migration.js';
import {OrderValidationService} from '../src/v2-order-validation.js';
import {createMigrationApprovalAuthority} from '../src/migration-auth.js';
import { issueBoundMigrationApproval } from './migration-approval-helper.js';

const A='demo-account',C='conv-001',U='CUST-001',M='draft-action-message';
function setup(){const authority=createMigrationApprovalAuthority(),db=new V1Database(':memory:',authority);db.resetAndSeed();db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))").run(M,C,M,'INBOUND','text','order','+6591110001','+6591110001',A);const migration=new WorkspaceMigrationService(db,authority),work=new WorkItemService(db),shadow=migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'shadow',approval:issueBoundMigrationApproval(authority,migration,'draft-test','MIGRATION_OWNER','SHADOW_IMPORT',{accountId:A,conversationId:C,customerId:U})});migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null,idempotencyKey:'promote',approval:issueBoundMigrationApproval(authority,migration,'draft-test','V1_OWNER','PROMOTE_CANARY',{accountId:A,conversationId:C,customerId:U},{expectedHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null})});const item=work.getOrCreate({accountId:A,conversationId:C,customerId:U,sourceMessageId:M,idempotencyKey:'work'});return{db,work,drafts:new OrderDraftService(db,work),item};}
const line=(lineNo:number,word:string,quantity:string|number)=>({lineNo,requestedWording:word,quantity,requestedUom:'CTN'});
function opts(draftRevision:number,workRevision:number,key:string,sourceMessageId=M){return{idempotencyKey:key,sourceMessageId,expectedDraftRevision:draftRevision,expectedWorkItemRevision:workRevision};}

test('V2-DRAFT-003 line, delivery, replay, stale, empty, and immutable history actions',async()=>{
  const x=setup(),d=x.drafts.create({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD',lines:[line(1,'ayam','1.50')]},{idempotencyKey:'create',expectedWorkItemRevision:1});
  const added=x.drafts.addLine(d.id,line(2,'wings',2),opts(1,2,'add'));assert.equal(added.current_revision,2);assert.equal(added.lines.length,2);
  assert.deepEqual(x.drafts.addLine(d.id,line(2,'wings',2),opts(1,2,'add')),added);
  assert.throws(()=>x.drafts.addLine(d.id,line(3,'other',1),opts(1,2,'add')),/IDEMPOTENCY_CONFLICT/);
  const changed=x.drafts.changeLine(d.id,2,{quantity:'2.125'},opts(2,2,'change'));assert.equal(changed.lines[1].quantity,'2.125');
  const delivered=x.drafts.setDeliveryRequest(d.id,'2026-09-25',opts(3,2,'delivery'));assert.equal(delivered.requested_delivery_date,'2026-09-25');
  const removed=x.drafts.removeLine(d.id,1,opts(4,2,'remove'));assert.equal(removed.lines.length,1);
  const empty=x.drafts.removeLine(d.id,2,opts(5,2,'remove-last'));assert.deepEqual(empty.lines,[]);
  assert.equal(x.drafts.removeLine(d.id,2,opts(5,2,'remove-last')).current_revision,6);
  assert.throws(()=>x.drafts.addLine(d.id,line(2,'wings',1),opts(5,2,'different')),/STALE_DRAFT_REVISION/);
  assert.equal((x.db.db.prepare('SELECT count(*) n FROM order_draft_revisions WHERE draft_id=?').get(d.id) as any).n,6);
  assert.deepEqual(x.drafts.readRevision(d.id,1).lines,[{line_no:1,requested_wording:'ayam',quantity:'1.5',requested_uom:'CTN',row_remark:null,resolved_product_id:null,resolved_uom:null,evidence_refs_json:null}]);
});

test('V2-DRAFT-003 reuse copies historical order and preserves source immutability',()=>{
  const x=setup();const result=x.drafts.reusePreviousOrder({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,previousSalesOrderId:'so-seeded-041',sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD'},{idempotencyKey:'reuse',expectedWorkItemRevision:1});
  assert.equal(result.lines?.[0].quantity,'10');assert.equal(x.drafts.readRevision(result.id,1).sourceOrderId,'so-seeded-041');
  assert.equal((x.db.db.prepare("SELECT count(*) n FROM sales_order_lines WHERE sales_order_id='so-seeded-041'").get() as any).n,2);
  assert.equal(x.drafts.reusePreviousOrder({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,previousSalesOrderId:'so-seeded-041',sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD'},{idempotencyKey:'reuse',expectedWorkItemRevision:1}).id,result.id);
});

test('reuse normalizes nullable inputs and replays independently of source-order lines',()=>{
  const x=setup(),input={workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,previousSalesOrderId:'so-seeded-041',sourceMessageId:M,requestedDeliveryDate:'',warehouseId:'SG-MAIN',currency:'SGD'};
  const first=x.drafts.reusePreviousOrder(input,{idempotencyKey:'reuse-normalized',expectedWorkItemRevision:1});
  x.db.db.prepare("UPDATE sales_order_lines SET quantity='99' WHERE id='sol-seeded-041-1'").run();x.db.db.prepare("DELETE FROM sales_order_lines WHERE id='sol-seeded-041-2'").run();
  const replay=x.drafts.reusePreviousOrder({...input,requestedDeliveryDate:null},{idempotencyKey:'reuse-normalized',expectedWorkItemRevision:1});
  assert.deepStrictEqual(replay,first);assert.throws(()=>x.drafts.reusePreviousOrder({...input,requestedDeliveryDate:'2026-09-30'},{idempotencyKey:'reuse-normalized',expectedWorkItemRevision:1}),/IDEMPOTENCY_CONFLICT/);
});

test('SENT quote edits prepare requote without sending or superseding, while accepted Draft SO blocks',()=>{
  const x=setup(),d=x.drafts.create({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD',lines:[line(1,'ayam',1)]},{idempotencyKey:'create',expectedWorkItemRevision:1});
  x.db.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('q-sent','QT-SENT',U,'SENT','SGD','2026-09-08','2026-09-30',C,M,4800,0,4800);
  const r=x.drafts.changeLine(d.id,1,{quantity:'1.25'},opts(1,2,'sent-edit'));assert.equal(r.current_revision,2);assert.equal((x.db.db.prepare("SELECT status FROM quotations WHERE id='q-sent'").get() as any).status,'SENT');
  const prepared=x.drafts.prepareRequote(d.id,opts(2,2,'requote'));assert.equal(prepared.current_revision,3);assert.equal(x.work.read(x.item.id)?.state,'CHANGING');assert.equal((x.db.db.prepare("SELECT count(*) n FROM quotations WHERE status='SENT'").get() as any).n,1);
  x.db.db.prepare("UPDATE quotations SET status='ACCEPTED' WHERE id='q-sent'").run();assert.throws(()=>x.drafts.changeLine(d.id,1,{quantity:2},opts(3,3,'after-accept')),/CANONICAL_COMMITMENT_HANDOFF/);
});

test('validate records a revision, replays exactly, and rejects stale draft/work-item revisions',async()=>{const x=setup(),d=x.drafts.create({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD',lines:[line(1,'ayam','1.50')]},{idempotencyKey:'create',expectedWorkItemRevision:1});const v={idempotencyKey:'validate',sourceMessageId:M,expectedDraftRevision:1,expectedWorkItemRevision:2};const ok=await x.drafts.validate(d.id,v);assert.equal(ok.status,'SUCCEEDED');assert.equal(ok.data?.draftRevision,1);assert.equal(x.drafts.read(d.id)?.current_revision,2);const replay=await x.drafts.validate(d.id,v);assert.equal(replay.status,ok.status);assert.deepEqual(replay.data,ok.data);assert.equal((x.db.db.prepare("SELECT count(*) n FROM order_draft_revisions WHERE draft_id=? AND action_type='VALIDATE'").get(d.id) as any).n,1);await assert.rejects(()=>x.drafts.validate(d.id,{...v,idempotencyKey:'stale',expectedDraftRevision:1}),/STALE_DRAFT_REVISION/);await assert.rejects(()=>x.drafts.validate(d.id,{...v,idempotencyKey:'stale-work',expectedDraftRevision:2,expectedWorkItemRevision:1}),/STALE_WORK_ITEM_REVISION/);});

test('blocked validation is a revisioned idempotent action',async()=>{
  const x=setup(),d=x.drafts.create({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD',lines:[line(1,'missing-product',1)]},{idempotencyKey:'create',expectedWorkItemRevision:1}),v={idempotencyKey:'blocked-validate',sourceMessageId:M,expectedDraftRevision:1,expectedWorkItemRevision:2};
  const first=await x.drafts.validate(d.id,v);assert.equal(first.status,'BLOCKED');assert.equal(x.drafts.read(d.id)?.current_revision,2);
  const counts=()=>({revisions:(x.db.db.prepare("SELECT count(*) n FROM order_draft_revisions WHERE draft_id=? AND action_type='VALIDATE'").get(d.id) as any).n,provenance:(x.db.db.prepare("SELECT count(*) n FROM workspace_provenance_links WHERE draft_id=? AND link_type='DRAFT_VALIDATION'").get(d.id) as any).n,attempts:(x.db.db.prepare('SELECT count(*) n FROM v2_order_validations WHERE draft_id=?').get(d.id) as any).n});
  assert.deepStrictEqual(counts(),{revisions:1,provenance:1,attempts:1});const replay=await x.drafts.validate(d.id,v);assert.deepStrictEqual(replay,first);assert.deepStrictEqual(counts(),{revisions:1,provenance:1,attempts:1});
});

test('validation blocks canonical states without advancing the draft',async()=>{
  for(const state of ['DRAFT_QUOTE','ACCEPTED_QUOTE','DRAFT_SO','PENDING','UNKNOWN']){
    const x=setup(),d=x.drafts.create({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD',lines:[line(1,'ayam',1)]},{idempotencyKey:'create',expectedWorkItemRevision:1});
    if(state==='DRAFT_QUOTE'||state==='ACCEPTED_QUOTE')x.db.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(`q-${state}`,'QT-'+state,U,state==='DRAFT_QUOTE'?'DRAFT':'ACCEPTED','SGD','2026-09-08','2026-09-30',C,M,4800,0,4800);
    if(state==='DRAFT_SO'){x.db.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('q-draft-so','QT-DRAFT-SO',U,'ACCEPTED','SGD','2026-09-08','2026-09-30',C,M,4800,0,4800);x.db.db.prepare('INSERT INTO sales_orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('so-draft','SO-DRAFT',U,'DRAFT','SGD',null,'SG-MAIN','draft',4800,0,4800,'q-draft-so','accept-draft',null,null);}
    if(state==='PENDING'||state==='UNKNOWN')x.db.db.prepare('INSERT INTO outbound_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`out-${state}`,C,null,`client-${state}`,'QUOTE','q',`hash-${state}`,'{}',state,0,null,null,new Date().toISOString());
    const before=(x.db.db.prepare('SELECT count(*) n FROM order_draft_revisions WHERE draft_id=?').get(d.id) as any).n;await assert.rejects(()=>x.drafts.validate(d.id,{idempotencyKey:'blocked-'+state,sourceMessageId:M,expectedDraftRevision:1,expectedWorkItemRevision:2}),/CANONICAL_/);assert.equal((x.db.db.prepare('SELECT current_revision FROM order_drafts WHERE id=?').get(d.id) as any).current_revision,1);assert.equal((x.db.db.prepare('SELECT count(*) n FROM order_draft_revisions WHERE draft_id=?').get(d.id) as any).n,before);
  }
});

test('validation final guard wins over a commitment appearing during async validation',async()=>{
  const x=setup(),d=x.drafts.create({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD',lines:[line(1,'ayam',1)]},{idempotencyKey:'create',expectedWorkItemRevision:1}),original=OrderValidationService.prototype.validate;
  OrderValidationService.prototype.validate=async function(input:any){const result=await original.call(this,input);this.database.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('q-race','QT-RACE',U,'ACCEPTED','SGD','2026-09-08','2026-09-30',C,M,4800,0,4800);return result};
  try{await assert.rejects(()=>x.drafts.validate(d.id,{idempotencyKey:'race',sourceMessageId:M,expectedDraftRevision:1,expectedWorkItemRevision:2}),/CANONICAL_COMMITMENT_HANDOFF/);}finally{OrderValidationService.prototype.validate=original}assert.equal(x.drafts.read(d.id)?.current_revision,1);assert.equal((x.db.db.prepare('SELECT count(*) n FROM order_draft_revisions WHERE draft_id=?').get(d.id) as any).n,1);
});

test('DRAFT quote protects every ordinary workspace mutation',()=>{const x=setup(),d=x.drafts.create({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD',lines:[line(1,'ayam',1)]},{idempotencyKey:'create',expectedWorkItemRevision:1});x.db.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('q-draft','QT-DRAFT',U,'DRAFT','SGD','2026-09-08','2026-09-30',C,M,4800,0,4800);assert.throws(()=>x.drafts.changeLine(d.id,1,{quantity:2},opts(1,2,'draft-change')),/CANONICAL_QUOTE_ACTION_REQUIRED/);assert.throws(()=>x.drafts.setDeliveryRequest(d.id,'2026-09-30',opts(1,2,'draft-delivery')),/CANONICAL_QUOTE_ACTION_REQUIRED/);});

test('requote validates the WorkItem transition before writing the draft',()=>{const x=setup(),d=x.drafts.create({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD',lines:[line(1,'ayam',1)]},{idempotencyKey:'create',expectedWorkItemRevision:1});x.db.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,source_conversation_id,source_message_id,subtotal_cents,tax_cents,grand_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('q-sent','QT-SENT',U,'SENT','SGD','2026-09-08','2026-09-30',C,M,4800,0,4800);x.work.transition({workItemId:x.item.id,accountId:A,conversationId:C,to:'READY_TO_QUOTE',expectedRevision:2,idempotencyKey:'ready',actorType:'AI',sourceMessageId:M});assert.throws(()=>x.drafts.prepareRequote(d.id,opts(1,3,'requote')),/INVALID_WORK_ITEM_TRANSITION/);assert.equal(x.drafts.read(d.id)?.current_revision,1);});

test('mutations bind provenance to the current inbound message and reject wrong scope',()=>{const x=setup(),m2='draft-action-message-2';x.db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))").run(m2,C,m2,'INBOUND','text','change','+6591110001','+6591110001',A);const d=x.drafts.create({workItemId:x.item.id,accountId:A,conversationId:C,customerId:U,sourceMessageId:M,warehouseId:'SG-MAIN',currency:'SGD',lines:[line(1,'ayam',1)]},{idempotencyKey:'create',expectedWorkItemRevision:1});const changed=x.drafts.changeLine(d.id,1,{quantity:2},opts(1,2,'m2',m2));assert.equal(changed.source_message_id,m2);assert.equal((x.db.db.prepare('SELECT source_message_id FROM order_draft_revisions WHERE draft_id=? AND revision=2').get(d.id) as any).source_message_id,m2);assert.throws(()=>x.drafts.setDeliveryRequest(d.id,null,opts(2,2,'wrong','missing')),/SOURCE_MESSAGE_SCOPE/);});
