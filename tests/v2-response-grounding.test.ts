import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { OrderValidationService } from '../src/v2-order-validation.js';
import { AgentTurnCoordinator } from '../src/v2-agent-turn-coordinator.js';
import { ResponseGroundingGuard, isFreshGroundingAuthorization } from '../src/v2-response-grounding.js';
import { buildGroundingReferenceProjection } from '../src/v2-grounding-references.js';
import { createHash } from 'node:crypto';

function fixture(quantity='2', deliveryDate='2026-09-20') {
  const db=new V1Database(':memory:'); db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('ground-msg','conv-001','ground-msg','INBOUND','text','order','demo-account',datetime('now'))").run();
  db.db.prepare("INSERT INTO work_items VALUES('ground-wi','demo-account','conv-001','CUST-001','SALES_ORDER_REQUEST','DRAFTING',1,'order',NULL,NULL,NULL,NULL,'ground-msg',datetime('now'),datetime('now'))").run();
  db.db.prepare("INSERT INTO order_drafts VALUES('ground-draft','ground-wi','demo-account','conv-001','CUST-001','CURRENT',1,?,'SG-MAIN','SGD','ground-msg',datetime('now'),datetime('now'))").run(deliveryDate);
  db.db.prepare("UPDATE work_items SET active_order_draft_id='ground-draft' WHERE id='ground-wi'").run();
  db.db.prepare("INSERT INTO order_draft_revisions VALUES('ground-rev','ground-draft',1,0,'CREATE','AI',NULL,'ground-msg','ground-create','ground-hash',?,datetime('now'))").run(JSON.stringify({lines:[{line_no:1,requested_wording:'ayam',quantity,requested_uom:'CTN'}],requestedDeliveryDate:deliveryDate,warehouseId:'SG-MAIN',currency:'SGD'}));
  return db;
}

async function prepared() {
  const db=fixture();
  const validation=await new OrderValidationService(db).validateDraft({draftId:'ground-draft',revision:1}); assert.equal(validation.status,'SUCCEEDED');
  const evidence=(validation.data!.lines[0].evidenceRefs.find(id=>(db.db.prepare('SELECT evidence_type FROM erp_evidence WHERE id=?').get(id) as any).evidence_type==='customer_price'))!;
  const ev=db.db.prepare('SELECT source_version FROM erp_evidence WHERE id=?').get(evidence) as any;
  const coordinator=new AgentTurnCoordinator(db); const turn=coordinator.start({accountId:'demo-account',conversationId:'conv-001',inboundMessageId:'ground-msg',nowIso:'2026-09-09T09:00:00+08:00',timezone:'Asia/Singapore'});
  coordinator.completeWithResponsePlan(turn.turnId,{turnId:turn.turnId,intent:'ANSWER',connectiveText:'Verified.',factClaims:[{slot:'price',canonicalRef:{sourceId:evidence,versionOrRevision:ev.source_version,evidenceRefs:[evidence]},valueShape:'money_amount'}],outboundPurpose:'customer_reply'});
  return {db,turnId:turn.turnId,evidence};
}

async function preparedClaim(slot:'price'|'delivery_date', quantity='2') {
  const db=fixture(quantity);
  const validation=await new OrderValidationService(db).validateDraft({draftId:'ground-draft',revision:1});
  assert.equal(validation.status,'SUCCEEDED');
  const evidence=(validation.data!.evidenceRefs.find(id=>(db.db.prepare('SELECT evidence_type FROM erp_evidence WHERE id=?').get(id) as any).evidence_type===(slot==='delivery_date'?'draft_delivery':'customer_price')))!;
  const ev=db.db.prepare('SELECT source_version FROM erp_evidence WHERE id=?').get(evidence) as any;
  const coordinator=new AgentTurnCoordinator(db); const turn=coordinator.start({accountId:'demo-account',conversationId:'conv-001',inboundMessageId:'ground-msg',nowIso:'2026-09-09T09:00:00+08:00',timezone:'Asia/Singapore'});
  coordinator.completeWithResponsePlan(turn.turnId,{turnId:turn.turnId,intent:'ANSWER',connectiveText:'I can provide the details.',factClaims:[{slot,canonicalRef:{sourceId:evidence,versionOrRevision:ev.source_version,evidenceRefs:[evidence]},valueShape:slot==='delivery_date'?'date':'money_amount'}],outboundPurpose:'customer_reply'});
  return {db,turnId:turn.turnId,evidence};
}

function quoteFixture(status:'SENT'|'ACCEPTED'='SENT', acceptanceSeal=true) {
  const db=fixture(); const product=db.db.prepare("SELECT * FROM products WHERE id='FCH-WHOLE-12'").get() as any;
  const quoteId='ground-quote', lineId='ground-quote-line', evidenceIds=['quote-product','quote-uom','quote-conversion','quote-price','quote-stock'];
  for (const [index,id] of evidenceIds.entries()) db.insertErpEvidence({id,evidenceType:['product_resolution','uom_resolution','uom_conversion','customer_price','warehouse_stock'][index],toolCallId:`tool-${id}`,lookupKey:id,inputJson:'{}',outputJson:'{}',observedAt:'2026-09-09T00:00:00.000Z',sourceVersion:'quote-v1'});
  const snapshot={quotationNo:'QT-GROUND',customerId:'CUST-001',warehouseId:'SG-MAIN',currency:'SGD',deliveryDate:'2026-09-20',remark:null,lines:[{rowItemNo:1,productId:product.id,stockCode:product.stock_code,description:product.description,rowItemRemark:null,quantity:'2',uom:'CTN',unitPriceCents:4800,subtotalCents:9600}],subtotalCents:9600,taxCents:0,grandTotalCents:9600};
  const snapshotJson=JSON.stringify(snapshot), snapshotHash=createHash('sha256').update(snapshotJson).digest('hex');
  db.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,delivery_date,warehouse_id,remark,subtotal_cents,tax_cents,grand_total_cents,source_conversation_id,source_message_id,sent_at,accepted_at,sent_snapshot_json,sent_snapshot_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(quoteId,'QT-GROUND','CUST-001',status,'SGD','2026-09-09','2099-09-30','2026-09-20','SG-MAIN',null,9600,0,9600,'conv-001','ground-msg','2026-09-09T00:00:00.000Z',status==='ACCEPTED'?'2026-09-09T01:00:00.000Z':null,snapshotJson,snapshotHash);
  db.db.prepare('INSERT INTO quotation_lines VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(lineId,quoteId,1,product.id,product.stock_code,product.description,null,'2','CTN',4800,9600);
  for (const [id,role] of evidenceIds.map((id,index)=>[id,['product','uom','uom_conversion','price','stock'][index]] as [string,string])) { db.db.prepare('INSERT INTO quotation_line_evidence VALUES(?,?,?)').run(lineId,id,role); db.insertGroundingProvenance({evidenceId:id,accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',quotationId:quoteId,linkType:'TEST_QUOTATION',createdAt:'2026-09-09T00:00:00.000Z'}); }
  const sealPayload=JSON.stringify({snapshot:snapshotJson,lines:db.db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no').all(quoteId),evidence:db.db.prepare('SELECT qle.quotation_line_id,qle.evidence_id,qle.role FROM quotation_line_evidence qle JOIN quotation_lines ql ON ql.id=qle.quotation_line_id WHERE ql.quotation_id=? ORDER BY qle.quotation_line_id,qle.evidence_id,qle.role').all(quoteId)}); db.insertCommercialIntegritySeal({entityType:'QUOTATION',entityId:quoteId,accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',lineageId:quoteId,payloadJson:sealPayload,payloadHash:createHash('sha256').update(sealPayload).digest('hex'),sealedAt:'2026-09-09T00:00:00.000Z'});
  if(status==='ACCEPTED'){
    db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,account_id,occurred_at) VALUES('ground-accept','conv-001','ground-accept','INBOUND','text','OK confirm','+6591110001','demo-account','2026-09-09T02:00:00.000Z')").run();
    const evidenceJson=JSON.stringify({text:'OK confirm',externalMessageId:'ground-accept',conversationId:'conv-001',accountId:'demo-account'}); db.db.prepare('INSERT INTO quotation_acceptances VALUES(?,?,?,?,?,?)').run('ground-acceptance',quoteId,'ground-accept','+6591110001','2026-09-09T02:00:00.000Z',evidenceJson);
    if(acceptanceSeal){const acceptancePayload=JSON.stringify({quotationId:quoteId,messageId:'ground-accept',senderExternalId:'+6591110001',acceptedAt:'2026-09-09T02:00:00.000Z',evidenceJson}); db.insertCommercialIntegritySeal({entityType:'ACCEPTANCE',entityId:'ground-acceptance',accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',lineageId:quoteId,payloadJson:acceptancePayload,payloadHash:createHash('sha256').update(acceptancePayload).digest('hex'),sealedAt:'2026-09-09T02:00:00.000Z'});}
    db.db.prepare('INSERT INTO sales_orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ground-so','SO-GROUND','CUST-001','DRAFT','SGD','2026-09-20','SG-MAIN',null,9600,0,9600,quoteId,'ground-accept',null,null);
    db.db.prepare('INSERT INTO sales_order_lines VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('ground-so-line','ground-so',lineId,1,product.id,product.stock_code,product.description,'2','CTN',4800,9600); const soPayload=JSON.stringify({quotationId:quoteId,customerId:'CUST-001',currency:'SGD',deliveryDate:'2026-09-20',warehouseId:'SG-MAIN',remark:null,subtotalCents:9600,taxCents:0,grandTotalCents:9600,lines:db.db.prepare('SELECT * FROM sales_order_lines WHERE sales_order_id=? ORDER BY row_item_no').all('ground-so')}); db.insertCommercialIntegritySeal({entityType:'SALES_ORDER',entityId:'ground-so',accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',lineageId:quoteId,payloadJson:soPayload,payloadHash:createHash('sha256').update(soPayload).digest('hex'),sealedAt:'2026-09-09T00:00:00.000Z'});
  }
  return {db,quoteId,lineId,evidenceIds};
}

function quoteTurn(db:V1Database, sourceId:string, version:string, evidenceRefs:string[], slots:Array<'quotation_number'|'quotation_status'|'total'|'sales_order_number'|'sales_order_status'|'commitment_outcome'>, inboundMessageId='ground-msg') {
  const coordinator=new AgentTurnCoordinator(db), turn=coordinator.start({accountId:'demo-account',conversationId:'conv-001',inboundMessageId,nowIso:'2026-09-09T09:00:00+08:00',timezone:'Asia/Singapore'});
  coordinator.completeWithResponsePlan(turn.turnId,{turnId:turn.turnId,intent:'ANSWER',connectiveText:'Verified.',factClaims:slots.map(slot=>({slot,canonicalRef:{sourceId,versionOrRevision:version,evidenceRefs},valueShape:slot==='commitment_outcome'?'commitment':slot.includes('number')?'document_identifier':slot.includes('status')?'status':'money_amount'})),outboundPurpose:'customer_reply'});
  return turn.turnId;
}

function currentOrderDraftItemsAction() {
  const db=fixture();
  db.db.prepare("INSERT INTO order_draft_lines VALUES('ground-line','ground-draft',1,'ayam','2','CTN',NULL,NULL,NULL,NULL)").run();
  const coordinator=new AgentTurnCoordinator(db);
  const turn=coordinator.start({accountId:'demo-account',conversationId:'conv-001',inboundMessageId:'ground-msg',nowIso:'2026-09-09T09:00:00+08:00',timezone:'Asia/Singapore'});
  const revision=1;
  const args={accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',workItemId:'ground-wi',draftId:'ground-draft',revision,expectedWorkItemRevision:1};
  const proposed=coordinator.proposeAction({turnId:turn.turnId,sequence:1,capabilityName:'read_order_draft',capabilityVersion:'v1',arguments:args});
  const action=proposed.actions[0];
  const result={status:'SUCCEEDED',data:{draftId:'ground-draft',revision:1,status:'CURRENT',lines:[{lineNo:1,requestedWording:'ayam',quantity:'2',requestedUom:'CTN'}]},evidence:[],stateChanges:[]};
  const completed=coordinator.recordResult({turnId:turn.turnId,actionId:action.id,sequence:1,result});
  return {db,turnId:turn.turnId,action:{...completed.actions[0],turnId:turn.turnId},args,result};
}

test('current_order_draft_items projection exposes one aggregate claim only for a durable successful same-turn action',()=>{
  const x=currentOrderDraftItemsAction();
  const projection=buildGroundingReferenceProjection(x.db.db,'demo-account','conv-001',[x.action],x.turnId);
  assert.equal(projection.references.length,1);
  assert.deepEqual(projection.references[0].allowedClaims,[{slot:'current_order_draft_items',valueShape:'order_draft_items'}]);
  assert.deepEqual(projection.references[0].evidenceRefs,['draft:ground-draft:revision:1']);
});

test('current_order_draft_items forged result object, foreign turn/action, stale revision, and line wording quantity UOM tamper fail closed',()=>{
  const x=currentOrderDraftItemsAction();
  const project=(candidate:any)=>buildGroundingReferenceProjection(x.db.db,'demo-account','conv-001',[candidate],x.turnId).references;
  assert.equal(project({...x.action,result:{...x.result,data:{...x.result.data,lines:[{lineNo:1,requestedWording:'forged',quantity:'99',requestedUom:'EA'}]}}}).length,0);
  assert.equal(project({...x.action,id:'foreign-action'}).length,0);
  assert.equal(project({...x.action,turnId:'foreign-turn'}).length,0);
  x.db.db.prepare("UPDATE order_drafts SET current_revision=current_revision+1 WHERE id='ground-draft'").run();
  assert.equal(project(x.action).length,0);
});

test('order draft items wording quantity UOM tamper and invented canonical ref fail grounding',()=>{
  const x=currentOrderDraftItemsAction();
  const refs=buildGroundingReferenceProjection(x.db.db,'demo-account','conv-001',[x.action],x.turnId).references;
  const ref=refs[0];
  const canonicalRef={sourceId:ref.sourceId,versionOrRevision:ref.versionOrRevision,evidenceRefs:ref.evidenceRefs};
  const coordinator=new AgentTurnCoordinator(x.db);
  coordinator.completeWithResponsePlan(x.turnId,{turnId:x.turnId,intent:'ANSWER',connectiveText:'Here are the current items.',factClaims:[{slot:'current_order_draft_items',canonicalRef,valueShape:'order_draft_items'}],outboundPurpose:'customer_reply'});
  const guard=new ResponseGroundingGuard(x.db);
  assert.equal(guard.ground(x.turnId).verdict,'PASS');
  x.db.db.prepare("UPDATE order_draft_lines SET requested_wording='tampered',quantity='9',requested_uom='EA' WHERE draft_id='ground-draft'").run();
  assert.equal(guard.ground(x.turnId).verdict,'REJECT');
  const y=currentOrderDraftItemsAction();
  const yRef=buildGroundingReferenceProjection(y.db.db,'demo-account','conv-001',[y.action],y.turnId).references[0];
  const invented={sourceId:'draft:invented',versionOrRevision:yRef.versionOrRevision,evidenceRefs:yRef.evidenceRefs};
  new AgentTurnCoordinator(y.db).completeWithResponsePlan(y.turnId,{turnId:y.turnId,intent:'ANSWER',connectiveText:'Here are the current items.',factClaims:[{slot:'current_order_draft_items',canonicalRef:invented,valueShape:'order_draft_items'}],outboundPurpose:'customer_reply'});
  assert.equal(new ResponseGroundingGuard(y.db).ground(y.turnId).verdict,'REJECT');
});

test('current_order_draft_items permits natural adjective wording but rejects explicit draft status assertion',()=>{
  const x=currentOrderDraftItemsAction();
  const ref=buildGroundingReferenceProjection(x.db.db,'demo-account','conv-001',[x.action],x.turnId).references[0];
  const canonicalRef={sourceId:ref.sourceId,versionOrRevision:ref.versionOrRevision,evidenceRefs:ref.evidenceRefs};
  assert.doesNotThrow(()=>new AgentTurnCoordinator(x.db).completeWithResponsePlan(x.turnId,{turnId:x.turnId,intent:'ANSWER',connectiveText:'Here are the current items.',factClaims:[{slot:'current_order_draft_items',canonicalRef,valueShape:'order_draft_items'}],outboundPurpose:'customer_reply'}));
  const y=currentOrderDraftItemsAction();
  const yRef=buildGroundingReferenceProjection(y.db.db,'demo-account','conv-001',[y.action],y.turnId).references[0];
  const yCanonicalRef={sourceId:yRef.sourceId,versionOrRevision:yRef.versionOrRevision,evidenceRefs:yRef.evidenceRefs};
  assert.throws(()=>new AgentTurnCoordinator(y.db).completeWithResponsePlan(y.turnId,{turnId:y.turnId,intent:'ANSWER',connectiveText:'The draft is current.',factClaims:[{slot:'current_order_draft_items',canonicalRef:yCanonicalRef,valueShape:'order_draft_items'}],outboundPurpose:'customer_reply'}),/CONNECTIVE_TEXT_FACTLIKE/);
});

test('current_order_draft_items after plan creation re-reads durable draft revision and lines before authorization',()=>{
  const x=currentOrderDraftItemsAction();
  const ref=buildGroundingReferenceProjection(x.db.db,'demo-account','conv-001',[x.action],x.turnId).references[0];
  const canonicalRef={sourceId:ref.sourceId,versionOrRevision:ref.versionOrRevision,evidenceRefs:ref.evidenceRefs};
  const c=new AgentTurnCoordinator(x.db);
  c.completeWithResponsePlan(x.turnId,{turnId:x.turnId,intent:'ANSWER',connectiveText:'Here are the current items.',factClaims:[{slot:'current_order_draft_items',canonicalRef,valueShape:'order_draft_items'}],outboundPurpose:'customer_reply'});
  x.db.db.prepare("UPDATE order_drafts SET current_revision=2 WHERE id='ground-draft'").run();
  assert.equal(new ResponseGroundingGuard(x.db).ground(x.turnId).verdict,'REJECT');
});

test('GROUND-001 resolves canonical protected facts, appends a fresh verdict on every execution, and has no outbound side effect',async()=>{
  const {db,turnId}=await prepared(); const guard=new ResponseGroundingGuard(db); const first=guard.execute(turnId);
  assert.equal(first.verdict,'PASS', JSON.stringify(first)); assert.equal(first.factSlots[0].value,'48.00');
  const second=guard.execute(turnId); assert.notEqual(second,first); assert.equal((db.db.prepare('SELECT count(*) n FROM grounding_verdicts').get() as any).n,2);
  assert.equal((db.db.prepare('SELECT count(*) n FROM outbound_messages').get() as any).n,0);
  assert.throws(()=>db.db.prepare("UPDATE grounding_verdicts SET verdict='PASS'").run(),/IMMUTABLE_GROUNDING_VERDICT/);
  assert.throws(()=>db.db.prepare("INSERT INTO grounding_verdicts(id,turn_id,sequence,plan_hash,authority_fingerprint,verdict,verdict_json,verdict_hash,verified_at) VALUES('x','x',1,'x','x','PASS','{}','x','now')").run(),/GROUNDING_INSERT_REQUIRES_GUARD/);
});

test('GROUND-001 fresh authorization is opaque and historical verdicts cannot authorize',async()=>{
  const {db,turnId}=await prepared(); const guard=new ResponseGroundingGuard(db); const fresh=guard.authorize(turnId); assert.equal(fresh.authorizationStatus,'FRESH_ONLY'); assert.equal(isFreshGroundingAuthorization(fresh),true); assert.equal(isFreshGroundingAuthorization(guard.readLatest(turnId)),false); assert.equal(isFreshGroundingAuthorization(guard.history(turnId)[0]),false); assert.equal((db.db.prepare('SELECT count(*) n FROM grounding_verdicts').get() as any).n,1); guard.authorize(turnId); assert.equal((db.db.prepare('SELECT count(*) n FROM grounding_verdicts').get() as any).n,2);
});

test('GROUND-001 rejects stale mutable truth and duplicate claims without commercial fallback',async()=>{
  const preparedData=await prepared(); const {db,turnId,evidence}=preparedData; db.db.prepare("UPDATE customer_prices SET unit_price_cents=5000 WHERE id='price-ayam'").run();
  const guard=new ResponseGroundingGuard(db); const stale=guard.execute(turnId); assert.equal(stale.verdict,'REJECT'); assert.equal(stale.factSlots.length,0); assert.equal(stale.renderedText,'');
  const row=db.db.prepare('SELECT plan_json FROM agent_response_plans WHERE turn_id=?').get(turnId) as any; const plan=JSON.parse(row.plan_json); plan.factClaims.push(plan.factClaims[0]);
  assert.throws(()=>guard.ground(turnId,plan),/PLAN_REPLAY_CONFLICT/);
  assert.ok(evidence);
});

test('GROUND-001 refreshes stock authority, appends history, and exposes no mutation callback',async()=>{
  const {db,turnId}=await prepared(); const guard=new ResponseGroundingGuard(db); const first=guard.ground(turnId);
  db.db.prepare("UPDATE stock_balances SET quantity_base='1' WHERE product_id='FCH-WHOLE-12'").run();
  const second=guard.ground(turnId);
  assert.notEqual(second,first); assert.equal((db.db.prepare('SELECT count(*) n FROM grounding_verdicts WHERE turn_id=?').get(turnId) as any).n,2);
  assert.equal(guard.history(turnId).length,2); assert.equal((guard as any).mutate,undefined); assert.equal((db as any).runResponseGrounding,undefined);
  assert.throws(()=>db.db.prepare("DELETE FROM grounding_verdicts").run(),/IMMUTABLE_GROUNDING_VERDICT/);
  assert.equal(Object.isFrozen(second),true); assert.equal(Object.isFrozen(second.factSlots),true); assert.equal(second.renderedText.includes('provider'),false);
});

test('GROUND-001 projection is scoped and never widens from arbitrary action-result refs', async () => {
  const db = fixture();
  db.db.prepare("INSERT INTO conversations VALUES('ground-foreign','demo-account','foreign','CUST-001','OPEN',datetime('now'))").run();
  assert.throws(()=>db.db.prepare("INSERT INTO erp_evidence VALUES('foreign-evidence','customer_price','foreign-tool','foreign-lookup','{}','{}','2026-09-09','foreign-v1')").run(),/V2_ERP_EVIDENCE_INSERT_REQUIRES_SERVICE/);
  const projection = buildGroundingReferenceProjection(db.db, 'demo-account', 'conv-001', [{ evidence: [{ sourceId: 'foreign-evidence', sourceVersion: 'foreign-v1', evidenceRefs: ['foreign-evidence'] }] }]);
  assert.equal(projection.references.some(ref => ref.sourceId === 'foreign-evidence'), false);
  assert.ok(projection.references.every(ref => ref.evidenceRefs.length > 0));
});

test('GROUND-001 rejects legacy partial validation rows and historical reads are never authorization artifacts',async()=>{
  const {db,turnId,evidence}=await prepared();
  db.insertV2OrderValidation({id:'legacy-partial',draftId:'ground-draft',draftRevision:1,mode:'DRAFT',status:'SUCCEEDED',resultJson:JSON.stringify({draftId:'ground-draft',draftRevision:1,lines:[{stockCode:'FCH-WHOLE-12',quantity:'2',requestedUom:'CTN',unitPriceCents:4800,subtotalCents:9600,availableBaseQuantity:'820',evidenceRefs:[evidence]}],subtotalCents:9600,taxCents:0,grandTotalCents:9600}),evidenceRefsJson:JSON.stringify([{sourceId:evidence,sourceVersion:'v2-erp-sql-1',evidenceRefs:[evidence]}]),createdAt:new Date().toISOString()});
  const guard=new ResponseGroundingGuard(db);assert.equal(guard.execute(turnId).verdict,'REJECT');const historical=guard.readLatest(turnId)!;assert.equal(historical.authorizationStatus,'HISTORICAL_READ_ONLY');assert.equal(historical.canAuthorize,false);
});

test('GROUND-001 rejects direct forged ERP provenance and stale draft delivery facts',async()=>{
  const db=fixture();assert.throws(()=>db.db.prepare("INSERT INTO erp_evidence VALUES('forged','customer_price','x','x','{}','{}','2026-09-09','x')").run(),/V2_ERP_EVIDENCE_INSERT_REQUIRES_SERVICE/);assert.throws(()=>db.db.prepare("INSERT INTO v2_order_validations VALUES('forged-v','ground-draft',1,'DRAFT','SUCCEEDED','{}','[]','now')").run(),/V2_VALIDATION_INSERT_REQUIRES_SERVICE/);
});

test('GROUND-001 independently rejects protected facts and canonical descriptors in connective text',async()=>{
  const {db,turnId}=await prepared(); const guard=new ResponseGroundingGuard(db);
  const row=db.db.prepare('SELECT plan_json FROM agent_response_plans WHERE turn_id=?').get(turnId) as any;
  const plan=JSON.parse(row.plan_json); plan.connectiveText=`Verified price is 48.00 from ${plan.factClaims[0].canonicalRef.sourceId}.`;
  assert.throws(()=>guard.ground(turnId,plan),/RESPONSE_PLAN_INVALID:CONNECTIVE_TEXT_FACTLIKE/);
  const benign=await prepared();
  assert.equal(new ResponseGroundingGuard(benign.db).ground(benign.turnId).verdict,'PASS');
});

test('GROUND-001 grounds service-created draft delivery evidence and rejects a freshly changed current date',async()=>{
  const {db,turnId}=await preparedClaim('delivery_date'); const guard=new ResponseGroundingGuard(db);
  assert.equal(guard.ground(turnId).verdict,'PASS',JSON.stringify(guard.ground(turnId)));
  db.db.prepare("UPDATE order_drafts SET requested_delivery_date='2026-09-21' WHERE id='ground-draft'").run();
  assert.equal(guard.ground(turnId).verdict,'REJECT');
});

test('GROUND-001 requires exact-cent arithmetic on fresh grounding, including fractional quantities',async()=>{
  const exact=await preparedClaim('price','2'); assert.equal(new ResponseGroundingGuard(exact.db).ground(exact.turnId).verdict,'PASS');
  const fractional=await preparedClaim('price','2.5');
  assert.equal(new ResponseGroundingGuard(fractional.db).ground(fractional.turnId).verdict,'PASS');
  fractional.db.db.prepare("UPDATE customer_prices SET unit_price_cents=4801 WHERE id='price-ayam'").run();
  assert.equal(new ResponseGroundingGuard(fractional.db).ground(fractional.turnId).verdict,'REJECT');
});

test('GROUND-001 rejects a customer eligibility change after validation',async()=>{
  const {db,turnId}=await prepared(); db.db.prepare("UPDATE customers SET credit_status='HOLD' WHERE id='CUST-001'").run();
  assert.equal(new ResponseGroundingGuard(db).ground(turnId).verdict,'REJECT');
});

test('ERP evidence is immutable to raw UPDATE and DELETE while reset remains authorized',async()=>{
  const db=fixture(); const validation=await new OrderValidationService(db).validateDraft({draftId:'ground-draft',revision:1});
  assert.equal(validation.status,'SUCCEEDED');
  const evidenceId=validation.data!.evidenceRefs[0];
  assert.throws(()=>db.db.prepare("UPDATE erp_evidence SET output_json='{}' WHERE id=?").run(evidenceId),/IMMUTABLE_ERP_EVIDENCE/);
  assert.throws(()=>db.db.prepare('DELETE FROM erp_evidence WHERE id=?').run(evidenceId),/IMMUTABLE_ERP_EVIDENCE/);
  assert.doesNotThrow(()=>db.resetAndSeed());
  assert.equal((db.db.prepare('SELECT count(*) n FROM erp_evidence').get() as any).n,0);
});

test('GROUND-001 grounds a real scoped quote from its frozen snapshot and rejects broken provenance or tampering',()=>{
  const valid=quoteFixture();
  const projection=buildGroundingReferenceProjection(valid.db.db,'demo-account','conv-001');
  const quoteRef=projection.references.find(ref=>ref.sourceId==='ground-quote'&&ref.versionOrRevision==='quote:ground-quote:SENT');
  assert.ok(quoteRef); assert.ok(projection.descriptors.includes('quote:ground-quote:SENT'));
  const turnId=quoteTurn(valid.db,'ground-quote','quote:ground-quote:SENT',valid.evidenceIds,['quotation_number','quotation_status','total']);
  const validVerdict=new ResponseGroundingGuard(valid.db).ground(turnId); assert.equal(validVerdict.verdict,'PASS',JSON.stringify(validVerdict));
  for (const mutate of [
    (db:V1Database)=>db.db.prepare("DELETE FROM quotation_line_evidence WHERE quotation_line_id='ground-quote-line'").run(),
    (db:V1Database)=>db.db.prepare("INSERT INTO quotation_line_evidence VALUES('ground-quote-line','missing-erp-evidence','price')").run(),
    (db:V1Database)=>db.db.prepare("UPDATE quotations SET sent_snapshot_json='{}' WHERE id='ground-quote'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE quotations SET sent_snapshot_hash='bad-hash' WHERE id='ground-quote'").run(),
    (db:V1Database)=>{const s={...JSON.parse((db.db.prepare("SELECT sent_snapshot_json FROM quotations WHERE id='ground-quote'").get() as any).sent_snapshot_json),grandTotalCents:1};const j=JSON.stringify(s);db.db.prepare("UPDATE quotations SET sent_snapshot_json=?,sent_snapshot_hash=? WHERE id='ground-quote'").run(j,createHash('sha256').update(j).digest('hex'));},
    (db:V1Database)=>{const s={...JSON.parse((db.db.prepare("SELECT sent_snapshot_json FROM quotations WHERE id='ground-quote'").get() as any).sent_snapshot_json),currency:'USD'};const j=JSON.stringify(s);db.db.prepare("UPDATE quotations SET sent_snapshot_json=?,sent_snapshot_hash=? WHERE id='ground-quote'").run(j,createHash('sha256').update(j).digest('hex'));},
    (db:V1Database)=>{const s={...JSON.parse((db.db.prepare("SELECT sent_snapshot_json FROM quotations WHERE id='ground-quote'").get() as any).sent_snapshot_json),deliveryDate:'2026-09-21'};const j=JSON.stringify(s);db.db.prepare("UPDATE quotations SET sent_snapshot_json=?,sent_snapshot_hash=? WHERE id='ground-quote'").run(j,createHash('sha256').update(j).digest('hex'));},
    (db:V1Database)=>db.db.prepare("UPDATE quotations SET warehouse_id='OTHER' WHERE id='ground-quote'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE quotation_lines SET unit_price_cents=1 WHERE id='ground-quote-line'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE quotation_lines SET product_id='OTHER' WHERE id='ground-quote-line'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE quotation_lines SET quantity='3' WHERE id='ground-quote-line'").run(),
  ]) { const broken=quoteFixture(); const id=quoteTurn(broken.db,'ground-quote','quote:ground-quote:SENT',broken.evidenceIds,['total']); mutate(broken.db); assert.equal(new ResponseGroundingGuard(broken.db).ground(id).verdict,'REJECT'); }
});

test('GROUND-001 grounds an accepted quote and draft SO, while requiring authentic acceptance and rejecting SO header/line tampering',()=>{
  const valid=quoteFixture('ACCEPTED'); const id=quoteTurn(valid.db,'ground-so','so:ground-so:DRAFT',valid.evidenceIds,['sales_order_number','sales_order_status','total']);
  const validVerdict=new ResponseGroundingGuard(valid.db).ground(id); assert.equal(validVerdict.verdict,'PASS',JSON.stringify(validVerdict));
  const commitmentId=quoteTurn(valid.db,'ground-acceptance','acceptance:ground-acceptance:ACCEPTED',valid.evidenceIds,['commitment_outcome'],'ground-accept');
  assert.equal(new ResponseGroundingGuard(valid.db).ground(commitmentId).verdict,'PASS');
  for (const mutate of [
    (db:V1Database)=>db.db.prepare("UPDATE sales_orders SET grand_total_cents=1 WHERE id='ground-so'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE sales_orders SET currency='USD' WHERE id='ground-so'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE sales_orders SET delivery_date='2026-09-21' WHERE id='ground-so'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE sales_orders SET warehouse_id='OTHER' WHERE id='ground-so'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE sales_order_lines SET product_id='OTHER' WHERE id='ground-so-line'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE sales_order_lines SET quantity='3' WHERE id='ground-so-line'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE sales_order_lines SET unit_price_cents=1 WHERE id='ground-so-line'").run(),
    (db:V1Database)=>db.db.prepare("DELETE FROM quotation_acceptances WHERE id='ground-acceptance'").run(),
    (db:V1Database)=>db.db.prepare("UPDATE messages SET conversation_id='foreign' WHERE id='ground-accept'").run(),
  ]) { const broken=quoteFixture('ACCEPTED'); const brokenId=quoteTurn(broken.db,'ground-so','so:ground-so:DRAFT',broken.evidenceIds,['total']); mutate(broken.db); assert.equal(new ResponseGroundingGuard(broken.db).ground(brokenId).verdict,'REJECT'); }
});

test('GROUND-001 rejects a forged scoped acceptance row without a server integrity seal',()=>{
  const forged=quoteFixture('ACCEPTED',false);
  const commitmentId=quoteTurn(forged.db,'ground-acceptance','acceptance:ground-acceptance:ACCEPTED',forged.evidenceIds,['commitment_outcome'],'ground-accept');
  assert.equal(new ResponseGroundingGuard(forged.db).ground(commitmentId).verdict,'REJECT');
});
