import test from 'node:test';
import assert from 'node:assert/strict';
import { CommerceService } from '../src/commerce.js';
import { SimulatedChannel } from '../src/channels.js';
import { scriptedSemanticAgentFactory, goldenOffer, prepareQuote } from './semantic-agent.js';

const message=(text:string,id:string)=>({channel:'whatsapp' as const,accountId:'demo-account',externalMessageId:id,conversationId:'conv-001',sender:{externalId:'+6591110001',phone:'+6591110001'},type:'text' as const,text,occurredAt:new Date().toISOString()});
const order='Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?';

async function sentQuote(){
  const channel=new SimulatedChannel(); await channel.connect();
  const service=new CommerceService(undefined,channel,undefined,scriptedSemanticAgentFactory([goldenOffer(),prepareQuote,{intent:'accept_quote',reason:'test decision'}])); service.resetAndSeed();
  await service.inbound(message(order,'val002-order')); await service.inbound(message('Yes please.','val002-prepare'));
  return service;
}

test('VAL-002 quote lines bind the required authentic, scoped ERP evidence roles',async()=>{
  const service=await sentQuote();
  const db=service.database.db;
  const quote=db.prepare("SELECT * FROM quotations WHERE status='SENT'").get() as any;
  const lines=db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no').all(quote.id) as any[];
  assert.equal(lines.length,2);
  for(const line of lines){
    const evidence=db.prepare(`SELECT qle.role,e.id,e.evidence_type,e.tool_call_id,e.lookup_key,e.input_json
      FROM quotation_line_evidence qle JOIN erp_evidence e ON e.id=qle.evidence_id WHERE qle.quotation_line_id=?`).all(line.id) as any[];
    for(const [role,type] of [['product','product'],['uom','uom'],['uom_conversion','uom_conversion'],['price','price'],['stock','stock']]){
      const rows=evidence.filter(row=>row.role===role&&row.evidence_type===type); assert.equal(rows.length,1,`${line.id}:${role}`);
      const row=rows[0]; assert.ok(db.prepare("SELECT 1 FROM agent_tool_calls WHERE id=? AND status='SUCCEEDED'").get(row.tool_call_id));
      assert.equal(row.lookup_key,requireHash(row.input_json));
      assert.ok(db.prepare('SELECT 1 FROM grounding_provenance_links WHERE evidence_id=? AND account_id=? AND conversation_id=? AND customer_id=? AND quotation_id=?').get(row.id,'demo-account','conv-001','CUST-001',quote.id));
    }
  }
});

test('VAL-002 explicit acceptance creates one Draft SO as an exact accepted quote copy, without ERP re-resolution',async()=>{
  const service=await sentQuote(); const db=service.database.db;
  const quoteBefore=db.prepare("SELECT * FROM quotations WHERE status='SENT'").get() as any;
  const quoteLinesBefore=db.prepare('SELECT row_item_no,product_id,stock_code,stock_description,quantity,uom,unit_price_cents,subtotal_cents FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no').all(quoteBefore.id);
  const snapshotBefore=quoteBefore.sent_snapshot_json;
  db.prepare("UPDATE customer_prices SET unit_price_cents=1 WHERE customer_id='CUST-001'").run();
  db.prepare("UPDATE stock_balances SET quantity_base=0 WHERE warehouse_id='SG-MAIN'").run();
  db.prepare("UPDATE products SET description='Mutated catalog description' WHERE id='FCH-WHOLE-12'").run();
  await service.inbound(message('OK confirm.','val002-accept'));
  assert.equal((db.prepare('SELECT count(*) AS n FROM sales_orders WHERE source_quotation_id=?').get(quoteBefore.id) as any).n,1);
  const so=db.prepare('SELECT * FROM sales_orders WHERE source_quotation_id=?').get(quoteBefore.id) as any;
  assert.equal(so.status,'DRAFT'); assert.deepEqual(db.prepare('SELECT customer_id,currency,delivery_date,warehouse_id,remark,subtotal_cents,tax_cents,grand_total_cents FROM sales_orders WHERE id=?').get(so.id),{customer_id:quoteBefore.customer_id,currency:quoteBefore.currency,delivery_date:quoteBefore.delivery_date,warehouse_id:quoteBefore.warehouse_id,remark:quoteBefore.remark,subtotal_cents:quoteBefore.subtotal_cents,tax_cents:quoteBefore.tax_cents,grand_total_cents:quoteBefore.grand_total_cents});
  const draftLines=db.prepare('SELECT row_item_no,product_id,stock_code,stock_description,quantity,uom,unit_price_cents,subtotal_cents FROM sales_order_lines WHERE sales_order_id=? ORDER BY row_item_no').all(so.id) as any[];
  assert.deepEqual(draftLines.map(line=>({...line,quantity:String(Number(line.quantity))})),quoteLinesBefore.map((line:any)=>({...line,quantity:String(Number(line.quantity))})));
  assert.equal((db.prepare('SELECT sent_snapshot_json FROM quotations WHERE id=?').get(quoteBefore.id) as any).sent_snapshot_json,snapshotBefore);
});

test('VAL-002 acceptance fails closed when a sent quote loses a required line evidence binding',async()=>{
  const service=await sentQuote(); const db=service.database.db;
  const quote=db.prepare("SELECT * FROM quotations WHERE status='SENT'").get() as any;
  const line=db.prepare('SELECT id FROM quotation_lines WHERE quotation_id=? LIMIT 1').get(quote.id) as any;
  db.prepare("DELETE FROM quotation_line_evidence WHERE quotation_line_id=? AND role='price'").run(line.id);
  await service.inbound(message('OK confirm.','val002-missing-price'));
  assert.equal((db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status,'SENT');
  assert.equal((db.prepare('SELECT count(*) AS n FROM sales_orders').get() as any).n,1); // seeded historical order only
  assert.equal((db.prepare('SELECT count(*) AS n FROM quotation_acceptances WHERE quotation_id=?').get(quote.id) as any).n,0);
});

test('VAL-002 acceptance fails closed when live quote rows and snapshot are forged with a self-consistent hash',async()=>{
  const service=await sentQuote(); const db=service.database.db;
  const quote=db.prepare("SELECT * FROM quotations WHERE status='SENT'").get() as any;
  const line=db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no LIMIT 1').get(quote.id) as any;
  db.prepare("UPDATE quotation_lines SET stock_description=?,unit_price_cents=?,subtotal_cents=? WHERE id=?").run('Forged chicken',1,1,line.id);
  const snapshot=JSON.parse(quote.sent_snapshot_json); snapshot.lines[0].description='Forged chicken'; snapshot.lines[0].unitPriceCents=1; snapshot.lines[0].subtotalCents=1;
  const sentSnapshotJson=JSON.stringify(snapshot);
  db.prepare('UPDATE quotations SET sent_snapshot_json=?,sent_snapshot_hash=? WHERE id=?').run(sentSnapshotJson,requireHash(sentSnapshotJson),quote.id);
  await service.inbound(message('OK confirm.','val002-forged-live-rows'));
  assert.equal((db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status,'SENT');
  assert.equal((db.prepare('SELECT count(*) AS n FROM quotation_acceptances WHERE quotation_id=?').get(quote.id) as any).n,0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sales_orders WHERE source_quotation_id=?').get(quote.id) as any).n,0);
});

test('VAL-002 acceptance fails closed when mutable tool-call output no longer matches immutable ERP evidence',async()=>{
  const service=await sentQuote(); const db=service.database.db;
  const quote=db.prepare("SELECT * FROM quotations WHERE status='SENT'").get() as any;
  const line=db.prepare('SELECT id FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no LIMIT 1').get(quote.id) as any;
  const evidence=db.prepare(`SELECT e.tool_call_id FROM quotation_line_evidence qle JOIN erp_evidence e ON e.id=qle.evidence_id WHERE qle.quotation_line_id=? AND qle.role='price'`).get(line.id) as any;
  db.prepare('UPDATE agent_tool_calls SET output_json=? WHERE id=?').run('{}',evidence.tool_call_id);
  await service.inbound(message('OK confirm.','val002-tampered-tool-call'));
  assert.equal((db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status,'SENT');
  assert.equal((db.prepare('SELECT count(*) AS n FROM sales_orders WHERE source_quotation_id=?').get(quote.id) as any).n,0);
});

test('VAL-002 acceptance fails closed when ERP evidence and its tool call are coherently tampered',async()=>{
  const service=await sentQuote(); const db=service.database.db;
  const quote=db.prepare("SELECT * FROM quotations WHERE status='SENT'").get() as any;
  const line=db.prepare('SELECT id FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no LIMIT 1').get(quote.id) as any;
  const evidence=db.prepare(`SELECT e.id,e.tool_call_id FROM quotation_line_evidence qle JOIN erp_evidence e ON e.id=qle.evidence_id WHERE qle.quotation_line_id=? AND qle.role='price'`).get(line.id) as any;
  // Test-only harness: emulate a coordinated privileged mutation of both mutable ledgers.
  db.function('v2_workspace_reset_authorized',()=>1);
  db.prepare('UPDATE erp_evidence SET output_json=? WHERE id=?').run(JSON.stringify({customerId:'CUST-001',productId:'FCH-WHOLE-12',uom:'CTN',unitPriceCents:1}),evidence.id);
  db.prepare('UPDATE agent_tool_calls SET output_json=? WHERE id=?').run(JSON.stringify({toolCallId:evidence.tool_call_id,type:'price',input:{customerId:'CUST-001',productId:'FCH-WHOLE-12',quantity:10,uom:'CTN',date:new Date().toISOString().slice(0,10)},output:{customerId:'CUST-001',productId:'FCH-WHOLE-12',uom:'CTN',unitPriceCents:1}}),evidence.tool_call_id);
  await service.inbound(message('OK confirm.','val002-coherent-tamper'));
  assert.equal((db.prepare('SELECT status FROM quotations WHERE id=?').get(quote.id) as any).status,'SENT');
  assert.equal((db.prepare('SELECT count(*) AS n FROM quotation_acceptances WHERE quotation_id=?').get(quote.id) as any).n,0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sales_orders WHERE source_quotation_id=?').get(quote.id) as any).n,0);
});

test('VAL-002 preserves numeric quantity in the durable sent snapshot',async()=>{
  const service=await sentQuote(); const db=service.database.db;
  const quote=db.prepare("SELECT sent_snapshot_json FROM quotations WHERE status='SENT'").get() as any;
  const snapshot=JSON.parse(quote.sent_snapshot_json);
  assert.equal(typeof snapshot.lines[0].quantity,'number');
  assert.deepEqual(snapshot.lines.map((line:any)=>line.quantity),[10,5]);
});

function requireHash(input:string){
  return createHash('sha256').update(input).digest('hex');
}

import { createHash } from 'node:crypto';
