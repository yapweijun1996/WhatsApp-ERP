import test from 'node:test';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {OrderValidationService} from '../src/v2-order-validation.js';

function fixture(lines=[{line_no:1,requested_wording:'ayam',quantity:'2',requested_uom:'CTN'}]){
  const database=new V1Database(':memory:');database.resetAndSeed();
  database.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('msg-v','conv-001','msg-v','INBOUND','text','order','demo-account',datetime('now'))").run();
  database.db.prepare("INSERT INTO work_items VALUES('wi-v','demo-account','conv-001','CUST-001','SALES_ORDER_REQUEST','DRAFTING',1,'order',NULL,NULL,NULL,NULL,'msg-v',datetime('now'),datetime('now'))").run();
  database.db.prepare("INSERT INTO order_drafts VALUES('draft-v','wi-v','demo-account','conv-001','CUST-001','CURRENT',1,'2026-09-20','SG-MAIN','SGD','msg-v',datetime('now'),datetime('now'))").run();
  database.db.prepare("INSERT INTO order_draft_revisions VALUES('rev-v','draft-v',1,0,'CREATE','AI',NULL,'msg-v','create','hash',?,datetime('now'))").run(JSON.stringify({lines,requestedDeliveryDate:'2026-09-20',warehouseId:'SG-MAIN',currency:'SGD'}));
  return database;
}

test('V2-VAL-001 validates multiple lines with exact totals and persisted evidence',async()=>{
  const db=fixture([{line_no:1,requested_wording:'ayam',quantity:'2',requested_uom:'CTN'},{line_no:2,requested_wording:'wings',quantity:'1.5',requested_uom:'CTN'}]);
  const result=await new OrderValidationService(db).validateDraft({draftId:'draft-v',revision:1});
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.data?.subtotalCents,15900);assert.equal(result.data?.grandTotalCents,15900);assert.equal(result.data?.lines[1].quantity,'1.5');assert.equal(result.data?.lines[1].baseQuantity,'9');assert.ok((result.data?.evidenceRefs.length??0)>=10);
  assert.equal((db.db.prepare('SELECT count(*) n FROM erp_evidence').get() as any).n,result.data?.evidenceRefs.length);assert.equal((db.db.prepare('SELECT count(*) n FROM v2_order_validations').get() as any).n,1);
});

test('V2-VAL-001 canonicalizes fractional and boundary decimal values without changing exact totals',async()=>{
  const db=fixture([{line_no:1,requested_wording:'wings',quantity:'1.50',requested_uom:'CTN'}]);
  db.db.prepare("UPDATE product_uom_conversions SET factor='6.0' WHERE id='conv-wings'").run();
  db.db.prepare("UPDATE stock_balances SET quantity_base='9.00' WHERE product_id='FCH-WING-2KG'").run();
  let result=await new OrderValidationService(db).validateDraft({draftId:'draft-v',revision:1});
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.data?.lines[0].quantity,'1.5');assert.equal(result.data?.lines[0].baseQuantity,'9');assert.equal(result.data?.lines[0].availableBaseQuantity,'9');assert.equal(result.data?.lines[0].subtotalCents,6300);

  const boundary=fixture([{line_no:1,requested_wording:'ayam',quantity:'2147483647.000',requested_uom:'CTN'}]);
  boundary.db.prepare("UPDATE stock_balances SET quantity_base='21474836470' WHERE product_id='FCH-WHOLE-12'").run();
  boundary.db.prepare("UPDATE customer_prices SET unit_price_cents=1 WHERE id='price-ayam'").run();
  result=await new OrderValidationService(boundary).validateDraft({draftId:'draft-v',revision:1});
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.data?.lines[0].quantity,'2147483647');assert.equal(result.data?.lines[0].baseQuantity,'21474836470');assert.equal(result.data?.lines[0].subtotalCents,2147483647);
});

test('V2-VAL-001 rejects a fractional subtotal that is not exactly representable in cents',async()=>{
  const db=fixture([{line_no:1,requested_wording:'ayam',quantity:'0.001',requested_uom:'CTN'}]);
  const result=await new OrderValidationService(db).validateDraft({draftId:'draft-v',revision:1});
  assert.equal(result.reasonCode,'TOTAL_NOT_EXACT_CENTS');
});

test('V2-VAL-001 fails closed for ambiguity, UOM, price, shortage, policy, and stale revision',async()=>{
  const ambiguous=fixture();ambiguous.db.prepare("INSERT INTO products VALUES('P-AMB','P-AMB','Ambiguous','PCS',1)").run();ambiguous.db.prepare("INSERT INTO product_aliases VALUES('a-amb','CUST-001','P-AMB','ayam',1,'test')").run();let r=await new OrderValidationService(ambiguous).validateDraft({draftId:'draft-v',revision:1});assert.equal(r.reasonCode,'PRODUCT_AMBIGUOUS');
  const uom=fixture([{line_no:1,requested_wording:'ayam',quantity:'2',requested_uom:'BAG'}]);r=await new OrderValidationService(uom).validateDraft({draftId:'draft-v',revision:1});assert.equal(r.reasonCode,'UOM_UNRESOLVED');
  const price=fixture();price.db.prepare("UPDATE customer_prices SET valid_to='2026-09-07' WHERE id='price-ayam'").run();r=await new OrderValidationService(price).validateForQuotation({draftId:'draft-v',revision:1});assert.equal(r.reasonCode,'PRICE_INVALID');
  const stock=fixture();stock.db.prepare("UPDATE stock_balances SET quantity_base='1' WHERE product_id='FCH-WHOLE-12'").run();r=await new OrderValidationService(stock).validateDraft({draftId:'draft-v',revision:1});assert.equal(r.reasonCode,'STOCK_SHORTAGE');
  const policy=fixture();policy.db.prepare("UPDATE customers SET credit_status='HOLD' WHERE id='CUST-001'").run();r=await new OrderValidationService(policy).validateDraft({draftId:'draft-v',revision:1});assert.equal(r.reasonCode,'CUSTOMER_POLICY_BLOCKED');
  const stale=fixture();r=await new OrderValidationService(stale).validateForQuotation({draftId:'draft-v',revision:2});assert.equal(r.reasonCode,'STALE_DRAFT_REVISION');
  const staleWork=fixture();staleWork.db.prepare("UPDATE work_items SET revision=2 WHERE id='wi-v'").run();r=await new OrderValidationService(staleWork).validateForQuotation({draftId:'draft-v',revision:1,expectedWorkItemRevision:1});assert.equal(r.reasonCode,'STALE_WORK_ITEM_REVISION');
});

test('quote-time validation rereads mutable ERP facts; prior validation is historical only',async()=>{
  const db=fixture();const service=new OrderValidationService(db);let r=await service.validateDraft({draftId:'draft-v',revision:1});assert.equal(r.status,'SUCCEEDED');
  db.db.prepare("UPDATE customer_prices SET unit_price_cents=5000 WHERE id='price-ayam'").run();r=await service.validateForQuotation({draftId:'draft-v',revision:1});assert.equal(r.status,'SUCCEEDED');assert.equal(r.data?.lines[0].unitPriceCents,5000);
  db.db.prepare("UPDATE stock_balances SET quantity_base='1' WHERE product_id='FCH-WHOLE-12'").run();r=await service.validateForQuotation({draftId:'draft-v',revision:1});assert.equal(r.reasonCode,'STOCK_SHORTAGE');
  db.db.prepare("UPDATE stock_balances SET quantity_base='820'").run();db.db.prepare("UPDATE customers SET credit_status='HOLD' WHERE id='CUST-001'").run();r=await service.validateForQuotation({draftId:'draft-v',revision:1});assert.equal(r.reasonCode,'CUSTOMER_POLICY_BLOCKED');
  assert.equal((db.db.prepare('SELECT count(*) n FROM v2_order_validations').get() as any).n,4);
});

test('V2-VAL-001 binds each line only to its own lookup evidence',async()=>{
  const db=fixture([{line_no:1,requested_wording:'ayam',quantity:'2',requested_uom:'CTN'},{line_no:2,requested_wording:'wings',quantity:'1.5',requested_uom:'CTN'}]);
  const result=await new OrderValidationService(db).validateDraft({draftId:'draft-v',revision:1});assert.equal(result.status,'SUCCEEDED');
  for(const line of result.data!.lines){assert.equal(line.evidenceRefs.length,5);const rows=db.db.prepare(`SELECT evidence_type,input_json,output_json FROM erp_evidence WHERE id IN (${line.evidenceRefs.map(()=>'?').join(',')})`).all(...line.evidenceRefs) as any[];assert.deepEqual(rows.map(row=>row.evidence_type).sort(),['product_resolution','uom_resolution','uom_conversion','customer_price','warehouse_stock'].sort());assert.ok(rows.every(row=>(row.input_json+row.output_json).includes(line.productId)));}
});

test('V2-VAL-001 persists blocked attempts and keeps validation history append-only',async()=>{
  const db=fixture([{line_no:1,requested_wording:'missing-product',quantity:'1',requested_uom:'CTN'}]);const result=await new OrderValidationService(db).validateDraft({draftId:'draft-v',revision:1});assert.equal(result.reasonCode,'PRODUCT_UNRESOLVED');
  const row=db.db.prepare('SELECT draft_id,draft_revision,mode,status,result_json FROM v2_order_validations').get() as any;assert.deepEqual([row.draft_id,row.draft_revision,row.mode,row.status],['draft-v',1,'DRAFT','BLOCKED']);assert.equal(JSON.parse(row.result_json).reasonCode,'PRODUCT_UNRESOLVED');
  assert.throws(()=>db.db.prepare("UPDATE v2_order_validations SET status='SUCCEEDED'").run(),/IMMUTABLE_V2_ORDER_VALIDATION/);assert.throws(()=>db.db.prepare('DELETE FROM v2_order_validations').run(),/IMMUTABLE_V2_ORDER_VALIDATION/);db.resetAndSeed();assert.equal((db.db.prepare('SELECT count(*) n FROM v2_order_validations').get() as any).n,0);
});

test('V2-VAL-001 records quote-time failures after prior success in historical order',async()=>{
  const db=fixture();const service=new OrderValidationService(db);assert.equal((await service.validateDraft({draftId:'draft-v',revision:1})).status,'SUCCEEDED');db.db.prepare("UPDATE stock_balances SET quantity_base='1' WHERE product_id='FCH-WHOLE-12'").run();const result=await service.validateForQuotation({draftId:'draft-v',revision:1});assert.equal(result.reasonCode,'STOCK_SHORTAGE');const rows=db.db.prepare('SELECT mode,status,result_json FROM v2_order_validations ORDER BY rowid').all() as any[];assert.deepEqual(rows.map(row=>[row.mode,row.status]),[['DRAFT','SUCCEEDED'],['QUOTE_TIME','BLOCKED']]);assert.equal(JSON.parse(rows[1].result_json).reasonCode,'STOCK_SHORTAGE');
});

test('V2-VAL-001 rejects ambiguous and invalid UOM conversion factors',async()=>{
  const duplicate=fixture();duplicate.db.prepare("INSERT INTO product_uom_conversions VALUES('conv-duplicate','FCH-WHOLE-12','CTN','PCS','10')").run();let result=await new OrderValidationService(duplicate).validateDraft({draftId:'draft-v',revision:1});assert.equal(result.reasonCode,'UOM_CONVERSION_AMBIGUOUS');const zero=fixture();zero.db.prepare("UPDATE product_uom_conversions SET factor='0' WHERE id='conv-ayam'").run();result=await new OrderValidationService(zero).validateDraft({draftId:'draft-v',revision:1});assert.equal(result.reasonCode,'UOM_CONVERSION_INVALID');const malformed=fixture();malformed.db.prepare("UPDATE product_uom_conversions SET factor='not-a-number' WHERE id='conv-ayam'").run();result=await new OrderValidationService(malformed).validateDraft({draftId:'draft-v',revision:1});assert.equal(result.reasonCode,'UOM_CONVERSION_INVALID');
});

test('V2-VAL-001 rejects malformed prices and aggregate arithmetic overflow',async()=>{
  const malformed=fixture();malformed.db.prepare("UPDATE customer_prices SET unit_price_cents=-1 WHERE id='price-ayam'").run();let result=await new OrderValidationService(malformed).validateDraft({draftId:'draft-v',revision:1});assert.equal(result.reasonCode,'PRICE_INVALID');const overflow=fixture([{line_no:1,requested_wording:'ayam',quantity:'1',requested_uom:'CTN'},{line_no:2,requested_wording:'wings',quantity:'1',requested_uom:'CTN'}]);overflow.db.prepare("UPDATE customer_prices SET unit_price_cents=2147483647 WHERE id IN ('price-ayam','price-wings')").run();result=await new OrderValidationService(overflow).validateDraft({draftId:'draft-v',revision:1});assert.equal(result.reasonCode,'TOTAL_OUT_OF_RANGE');
});
