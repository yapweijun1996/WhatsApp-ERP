import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {canonicalJson} from './v2-canonical.js';

type Row=Record<string,unknown>;
const rows=(db:Database.Database,sql:string,...args:unknown[])=>db.prepare(sql).all(...args) as Row[];
const one=(db:Database.Database,sql:string,...args:unknown[])=>db.prepare(sql).get(...args) as Row|undefined;
const inClause=(values:string[])=>values.length?`(${values.map(()=>'?').join(',')})`:'(NULL)';
const strings=(values:unknown[])=>[...new Set(values.filter((v):v is string=>typeof v==='string'&&v.trim()!=='').map(v=>v.trim()))];

/**
 * Server-owned authorization input.  This deliberately contains complete
 * mutable rows (and therefore never enters model context); callers receive
 * only its stable digest.
 */
export function authoritativeFreshnessFingerprint(db:Database.Database,accountId:string,conversationId:string,profileId:string,excludeOutboundMessageId?:string){
  const conversation=one(db,'SELECT * FROM conversations WHERE id=? AND channel_account_id=?',conversationId,accountId);
  if(!conversation)throw new Error('FRESHNESS_CONVERSATION_SCOPE');
  const customerId=conversation.customer_id as string|null;
  const customer=customerId?one(db,'SELECT * FROM customers WHERE id=?',customerId):null;
  const channelIdentity=customerId?rows(db,'SELECT * FROM customer_channel_identities WHERE channel_account_id=? AND customer_id=? ORDER BY id',accountId,customerId):[];
  const workItems=rows(db,"SELECT * FROM work_items WHERE account_id=? AND conversation_id=? ORDER BY id",accountId,conversationId);
  const draftIds=workItems.map(r=>r.active_order_draft_id).filter((v):v is string=>typeof v==='string');
  const drafts=draftIds.length?rows(db,`SELECT * FROM order_drafts WHERE account_id=? AND conversation_id=? AND id IN (${draftIds.map(()=>'?').join(',')}) ORDER BY id`,accountId,conversationId,...draftIds):[];
  const draftLines=drafts.length?rows(db,`SELECT * FROM order_draft_lines WHERE draft_id IN (${drafts.map(()=>'?').join(',')}) ORDER BY draft_id,line_no`,...drafts.map(r=>r.id)):[];
  const quotations=rows(db,'SELECT * FROM quotations WHERE source_conversation_id=? ORDER BY id',conversationId);
  const quotationIds=quotations.map(r=>r.id as string);
  const quotationLines=quotationIds.length?rows(db,`SELECT * FROM quotation_lines WHERE quotation_id IN (${quotationIds.map(()=>'?').join(',')}) ORDER BY quotation_id,row_item_no`,...quotationIds):[];
  const acceptances=quotationIds.length?rows(db,`SELECT * FROM quotation_acceptances WHERE quotation_id IN (${quotationIds.map(()=>'?').join(',')}) ORDER BY quotation_id,id`,...quotationIds):[];
  const salesOrders=quotationIds.length?rows(db,`SELECT * FROM sales_orders WHERE source_quotation_id IN (${quotationIds.map(()=>'?').join(',')}) ORDER BY source_quotation_id,id`,...quotationIds):[];
  const salesOrderIds=salesOrders.map(r=>r.id as string);
  const salesOrderLines=salesOrderIds.length?rows(db,`SELECT * FROM sales_order_lines WHERE sales_order_id IN (${salesOrderIds.map(()=>'?').join(',')}) ORDER BY sales_order_id,row_item_no`,...salesOrderIds):[];
  const outbound=excludeOutboundMessageId
    ? rows(db,"SELECT * FROM outbound_messages WHERE conversation_id=? AND entity_type<>'DELIVERY_UNIT' ORDER BY id",conversationId)
    : rows(db,'SELECT * FROM outbound_messages WHERE conversation_id=? ORDER BY id',conversationId);
  const draftIdSet=new Set(drafts.map(r=>r.id));
  const validations=rows(db,'SELECT * FROM v2_order_validations WHERE draft_id IN (SELECT id FROM order_drafts WHERE account_id=? AND conversation_id=?) ORDER BY draft_id,id',accountId,conversationId);
  const validationEvidence=rows(db,'SELECT * FROM erp_evidence WHERE id IN (SELECT DISTINCT CASE WHEN j.type=\'object\' THEN json_extract(j.value,\'$.sourceId\') ELSE j.value END FROM v2_order_validations v JOIN order_drafts d ON d.id=v.draft_id JOIN json_each(v.evidence_refs_json) j WHERE d.account_id=? AND d.conversation_id=?) ORDER BY id',accountId,conversationId);
  const profile=one(db,'SELECT * FROM employee_profiles WHERE id=?',profileId);
  if(!profile)throw new Error('FRESHNESS_PROFILE_MISSING');
  const requestedWording=[...new Set(draftLines.map(r=>String(r.requested_wording??'').trim().toLowerCase()).filter(Boolean))];
  const requestedUoms=strings(draftLines.map(r=>r.requested_uom));
  const resolvedUoms=strings(draftLines.map(r=>r.resolved_uom));
  const productIds=strings([
    ...draftLines.map(r=>r.resolved_product_id),
    ...quotationLines.map(r=>r.product_id),...salesOrderLines.map(r=>r.product_id),
  ]);
  const validationProductIds:string[]=[],validationStockCodes:string[]=[],validationUoms:string[]=[],validationWarehouseIds:string[]=[];
  for(const validation of validations){
    let result:any;try{result=JSON.parse(String(validation.result_json))}catch{throw new Error('FRESHNESS_VALIDATION_RESULT_JSON')}
    const data=result&&typeof result==='object'&&result.data&&typeof result.data==='object'?result.data:{};
    if(typeof data.warehouseId==='string')validationWarehouseIds.push(data.warehouseId);
    if(Array.isArray(data.lines))for(const line of data.lines){
      if(!line||typeof line!=='object')continue;
      if(typeof line.productId==='string')validationProductIds.push(line.productId);
      if(typeof line.stockCode==='string')validationStockCodes.push(line.stockCode);
      if(typeof line.requestedUom==='string')validationUoms.push(line.requestedUom);
      if(typeof line.baseUom==='string')validationUoms.push(line.baseUom);
    }
  }
  const validationProducts=validationStockCodes.length?rows(db,`SELECT id FROM products WHERE lower(stock_code) IN ${inClause(validationStockCodes.map(v=>v.toLowerCase()))} ORDER BY id`,...validationStockCodes.map(v=>v.toLowerCase())):[];
  productIds.push(...validationProductIds,...validationProducts.map(r=>String(r.id)));
  const scopedProductIds=strings(productIds);
  const matchedAliases=requestedWording.length?rows(db,`SELECT * FROM product_aliases WHERE customer_id=? AND lower(alias) IN ${inClause(requestedWording)} ORDER BY id`,customerId,...requestedWording):[];
  const aliasProductIds=matchedAliases.map(r=>String(r.product_id));
  scopedProductIds.push(...aliasProductIds);
  const allProductIds=strings(scopedProductIds);
  const products=rows(db,`SELECT * FROM products WHERE id IN ${inClause(allProductIds)} OR lower(stock_code) IN ${inClause(requestedWording)} OR lower(description) IN ${inClause(requestedWording)} ORDER BY id`,...allProductIds,...requestedWording,...requestedWording);
  const derivedProductIds=strings([...allProductIds,...products.map(r=>r.id)]);
  const baseUoms=products.filter(r=>derivedProductIds.includes(String(r.id))).map(r=>r.base_uom);
  const derivedUoms=strings([...requestedUoms,...resolvedUoms,...validationUoms,...baseUoms]);
  const warehouseIds=strings([customer?.default_warehouse_id,...drafts.map(r=>r.warehouse_id),...quotations.map(r=>r.warehouse_id),...salesOrders.map(r=>r.warehouse_id),...validationWarehouseIds]);
  const erp={
    products,
    productAliases:matchedAliases,
    uoms:rows(db,`SELECT * FROM uoms WHERE code IN ${inClause(derivedUoms)} ORDER BY code`,...derivedUoms),
    productUomConversions:rows(db,`SELECT * FROM product_uom_conversions WHERE product_id IN ${inClause(derivedProductIds)} ORDER BY product_id,from_uom,to_uom,id`,...derivedProductIds),
    warehouses:rows(db,`SELECT * FROM warehouses WHERE id IN ${inClause(warehouseIds)} ORDER BY id`,...warehouseIds),
    stockBalances:rows(db,`SELECT * FROM stock_balances WHERE product_id IN ${inClause(derivedProductIds)} AND warehouse_id IN ${inClause(warehouseIds)} ORDER BY product_id,warehouse_id`,...derivedProductIds,...warehouseIds),
    customerPrices:customerId?rows(db,`SELECT * FROM customer_prices WHERE customer_id=? AND product_id IN ${inClause(derivedProductIds)} ORDER BY product_id,uom,valid_from,id`,customerId,...derivedProductIds):[],
    customerOrderMemory:customerId?rows(db,'SELECT * FROM customer_order_memory WHERE customer_id=? ORDER BY id',customerId):[],
  };
  const vector={conversation,customer,channelIdentity,workItems,drafts:drafts.filter(r=>draftIdSet.has(r.id as string)),draftLines,erp,canonical:{quotations,quotationLines,acceptances,salesOrders,salesOrderLines,outbound},validation:{validations,validationEvidence},profile};
  return createHash('sha256').update(canonicalJson(vector)).digest('hex');
}
