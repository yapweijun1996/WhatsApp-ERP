import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import {V1Database} from './database.js';
import type {EvidenceRef, OrderValidationService as OrderValidationServiceContract, ServiceResult} from './v2-domain-contracts.js';
import {canonicalJson} from './v2-canonical.js';
import {createHash} from 'node:crypto';

type Decimal={n:bigint;s:number};
type DraftRow={id:string;work_item_id:string;account_id:string;conversation_id:string;customer_id:string;status:string;current_revision:number;requested_delivery_date:string|null;warehouse_id:string|null;currency:string|null;source_message_id:string|null};
type DraftLine={line_no:number;requested_wording:string;quantity:string;requested_uom:string;row_remark:string|null};
type ValidationLine={lineNo:number;requestedWording:string;productId:string;stockCode:string;description:string;quantity:string;requestedUom:string;baseUom:string;baseQuantity:string;unitPriceCents:number;currency:string;subtotalCents:number;availableBaseQuantity:string;evidenceRefs:string[]};
export type OrderValidationData={draftId:string;draftRevision:number;validationId?:string;customer:{id:string;code:string;name:string;currency:string;warehouseId:string;creditStatus:string};history:Array<{id:string;salesOrderNo:string;date:string|null;grandTotalCents:number}>;warehouseId:string;currency:string;lines:ValidationLine[];subtotalCents:number;taxCents:number;grandTotalCents:number;validatedAt:string;evidenceRefs:string[];freshnessFingerprint?:string};

const now=()=>new Date().toISOString();
const fail=(reasonCode:string):never=>{throw new Error(reasonCode)};
function decimal(value:unknown):Decimal{
  const text=String(value).trim(); if(!/^\d+(?:\.\d+)?$/.test(text))fail('DECIMAL_INVALID');
  const [whole,fraction='']=text.split('.'); const raw=BigInt(whole+fraction); const scale=fraction.length;
  return scale===0?{n:raw,s:0}:{n:raw,s:scale};
}
function canonical(d:Decimal){
  let n=d.n,s=d.s;
  while(s>0&&n%10n===0n){n/=10n;s--}
  if(s===0)return String(n);
  const negative=n<0n, digits=(negative?-n:n).toString().padStart(s+1,'0');
  return `${negative?'-':''}${digits.slice(0,-s)}.${digits.slice(-s)}`;
}
function multiply(a:Decimal,b:Decimal):Decimal{return {n:a.n*b.n,s:a.s+b.s}}
function compare(a:Decimal,b:Decimal){const s=Math.max(a.s,b.s);const an=a.n*10n**BigInt(s-a.s),bn=b.n*10n**BigInt(s-b.s);return an<bn?-1:an>bn?1:0}
function cents(product:Decimal):number{if(product.s>0&&product.n%10n**BigInt(product.s)!==0n)fail('TOTAL_NOT_EXACT_CENTS');const n=product.n/10n**BigInt(product.s);if(n>2147483647n||n<0n)fail('TOTAL_OUT_OF_RANGE');return Number(n)}
function json(value:unknown){return JSON.stringify(value)??'null'}
const MAX_CENTS=2147483647n;

/** Digest only the mutable/canonical facts consumed by QUOTE_TIME validation. */
export function quoteValidationFreshnessFingerprint(db:Database.Database,draftId:string,revision:number,data:Pick<OrderValidationData,'warehouseId'|'currency'|'lines'>){
  const d=db.prepare('SELECT * FROM order_drafts WHERE id=? AND status=\'CURRENT\'').get(draftId) as any;
  if(!d||d.current_revision!==revision)throw Error('STALE_DRAFT_REVISION');
  const w=db.prepare('SELECT * FROM work_items WHERE id=?').get(d.work_item_id) as any;
  const c=db.prepare('SELECT * FROM conversations WHERE id=? AND channel_account_id=?').get(d.conversation_id,d.account_id) as any;
  const customer=db.prepare('SELECT * FROM customers WHERE id=?').get(d.customer_id) as any;
  const rev=db.prepare('SELECT immutable_snapshot_json FROM order_draft_revisions WHERE draft_id=? AND revision=?').get(draftId,revision) as any;
  const draftLines=db.prepare('SELECT * FROM order_draft_lines WHERE draft_id=? ORDER BY line_no').all(draftId);
  const ids=data.lines.map(line=>line.productId), uoms=[...new Set(data.lines.flatMap(line=>[line.requestedUom,line.baseUom]))];
  const products=ids.length?db.prepare(`SELECT * FROM products WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`).all(...ids):[];
  const conversions=ids.length?db.prepare(`SELECT * FROM product_uom_conversions WHERE product_id IN (${ids.map(()=>'?').join(',')}) ORDER BY product_id,from_uom,to_uom,id`).all(...ids):[];
  const prices=ids.length?db.prepare(`SELECT * FROM customer_prices WHERE customer_id=? AND product_id IN (${ids.map(()=>'?').join(',')}) ORDER BY product_id,uom,valid_from,id`).all(d.customer_id,...ids):[];
  const stock=ids.length?db.prepare(`SELECT * FROM stock_balances WHERE warehouse_id=? AND product_id IN (${ids.map(()=>'?').join(',')}) ORDER BY product_id`).all(data.warehouseId,...ids):[];
  const uomRows=uoms.length?db.prepare(`SELECT * FROM uoms WHERE code IN (${uoms.map(()=>'?').join(',')}) ORDER BY code`).all(...uoms):[];
  const history=db.prepare('SELECT id,sales_order_no,delivery_date,grand_total_cents FROM sales_orders WHERE customer_id=? ORDER BY posted_at DESC,rowid DESC LIMIT 5').all(d.customer_id);
  return createHash('sha256').update(canonicalJson({d,w,c,customer,rev,draftLines,products,conversions,prices,stock,uomRows,history,warehouseId:data.warehouseId,currency:data.currency,lines:data.lines})).digest('hex');
}

/** Phase 1B only: read-only deterministic validation over the existing ERP truth tables. */
export class OrderValidationService implements OrderValidationServiceContract{
  constructor(public readonly database=new V1Database(':memory:')){}
  private get db():Database.Database{return this.database.db}

  async validate(input:{draftId:string;revision:number;expectedWorkItemRevision?:number;mode?:'DRAFT'|'QUOTE_TIME';asOfDate?:string}):Promise<ServiceResult<OrderValidationData>>{
    const mode=input.mode??'DRAFT', evidence:EvidenceRef[]=[];
    let successfulValidationId:string|undefined;
    const persistAttempt=(status:'SUCCEEDED'|'BLOCKED',result:unknown,at:string)=>{
      try{const id=status==='SUCCEEDED'?(successfulValidationId??randomUUID()):randomUUID();if(status==='SUCCEEDED')successfulValidationId=id;this.database.insertV2OrderValidation({id,draftId:input.draftId,draftRevision:input.revision,mode,status,resultJson:json(result),evidenceRefsJson:json(evidence),createdAt:at});return true}catch{return false}
    };
    try{
      const draft=this.db.prepare('SELECT * FROM order_drafts WHERE id=? AND status=\'CURRENT\'').get(input.draftId) as DraftRow|undefined;
      if(!draft)throw Error('DRAFT_NOT_FOUND');
      if(draft.current_revision!==input.revision)fail('STALE_DRAFT_REVISION');
      const workItem=this.db.prepare('SELECT revision FROM work_items WHERE id=? AND account_id=? AND conversation_id=? AND customer_id=?').get(draft.work_item_id,draft.account_id,draft.conversation_id,draft.customer_id) as {revision:number}|undefined;
      if(!workItem)throw Error('WORK_ITEM_SCOPE');
      if(input.expectedWorkItemRevision!==undefined&&workItem.revision!==input.expectedWorkItemRevision)throw Error('STALE_WORK_ITEM_REVISION');
      const revision=this.db.prepare('SELECT immutable_snapshot_json FROM order_draft_revisions WHERE draft_id=? AND revision=?').get(input.draftId,input.revision) as {immutable_snapshot_json:string}|undefined;
      if(!revision)throw Error('DRAFT_REVISION_NOT_FOUND');
      const snapshot=JSON.parse(revision.immutable_snapshot_json) as {lines:DraftLine[];requestedDeliveryDate?:string|null;warehouseId?:string|null;currency?:string|null};
      const record=(type:string,key:unknown,output:unknown)=>{const id=randomUUID(),t=now();this.database.insertV2ErpEvidence({id,evidenceType:type,toolCallId:id,lookupKey:String(key),inputJson:json(key),outputJson:json(output),observedAt:t,sourceVersion:'v2-erp-sql-1'});this.database.insertGroundingProvenance({evidenceId:id,accountId:draft.account_id,conversationId:draft.conversation_id,customerId:draft.customer_id,draftId:draft.id,draftRevision:draft.current_revision,linkType:'V2_VALIDATION',createdAt:t});evidence.push({sourceId:id,sourceVersion:'v2-erp-sql-1',evidenceRefs:[id]});return id};
      const row=(type:string,key:unknown,query:()=>unknown,lineEvidence?:string[])=>{try{const output=query(),id=record(type,key,output);lineEvidence?.push(id);return output}catch(e){const id=record(type,key,{error:(e as Error).message});lineEvidence?.push(id);throw e}};
      const conversation=this.db.prepare('SELECT customer_id,channel_account_id FROM conversations WHERE id=? AND channel_account_id=?').get(draft.conversation_id,draft.account_id) as {customer_id:string|null;channel_account_id:string}|undefined;
      if(!conversation||conversation.customer_id!==draft.customer_id)fail('CUSTOMER_SCOPE');
      const customer=row('customer_eligibility',{customerId:draft.customer_id,accountId:draft.account_id},()=>this.db.prepare('SELECT id,code,name,currency,credit_status,default_warehouse_id FROM customers WHERE id=?').get(draft.customer_id) as any) as any;
      if(!customer)fail('CUSTOMER_UNRESOLVED');
      if(customer.credit_status!=='OK')fail('CUSTOMER_POLICY_BLOCKED');
      const warehouseId=snapshot.warehouseId??draft.warehouse_id??customer.default_warehouse_id;if(!warehouseId)fail('WAREHOUSE_UNRESOLVED');
      const warehouse=row('warehouse',{warehouseId},()=>this.db.prepare('SELECT id FROM warehouses WHERE id=?').get(warehouseId));if(!warehouse)fail('WAREHOUSE_UNRESOLVED');
      const currency=snapshot.currency??draft.currency??customer.currency;if(currency!==customer.currency)fail('CURRENCY_MISMATCH');
      const date=input.asOfDate??now().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail('VALIDATION_DATE_INVALID');
      if(snapshot.requestedDeliveryDate)record('draft_delivery',{draftId:draft.id,revision:input.revision},{requestedDeliveryDate:snapshot.requestedDeliveryDate});
      const history=row('order_history',{customerId:draft.customer_id,limit:5},()=>this.db.prepare('SELECT id,sales_order_no,delivery_date,grand_total_cents FROM sales_orders WHERE customer_id=? ORDER BY posted_at DESC,rowid DESC LIMIT 5').all(draft.customer_id)) as any[];
      const lines:ValidationLine[]=[];let subtotal=0n;
      for(const requested of snapshot.lines??[]){
        const query=requested.requested_wording.trim();if(!query)fail('PRODUCT_UNRESOLVED');
        const lineEvidence:string[]=[];
        const matches=row('product_resolution',{customerId:draft.customer_id,query},()=>this.db.prepare(`SELECT DISTINCT p.id,p.stock_code,p.description,p.base_uom,p.active FROM products p LEFT JOIN product_aliases a ON a.product_id=p.id AND a.customer_id=? WHERE p.active=1 AND (lower(p.stock_code)=lower(?) OR lower(a.alias)=lower(?) OR lower(p.description)=lower(?)) ORDER BY p.id`).all(draft.customer_id,query,query,query),lineEvidence) as any[];
        if(matches.length===0)fail('PRODUCT_UNRESOLVED');if(matches.length!==1)fail('PRODUCT_AMBIGUOUS');const product=matches[0];
        const quantity=decimal(requested.quantity),uom=requested.requested_uom.trim().toUpperCase(),base=String(product.base_uom).toUpperCase();
        const uomExists=row('uom_resolution',{productId:product.id,uom},()=>this.db.prepare('SELECT code FROM uoms WHERE code=?').get(uom)??(uom===base?{code:base}:undefined),lineEvidence);if(!uomExists)fail('UOM_UNRESOLVED');
        let factor:Decimal=decimal(1);
        if(uom===base)factor=decimal(1);
        else {
          const conversions=row('uom_conversion',{productId:product.id,fromUom:uom,toUom:base},()=>this.db.prepare('SELECT factor FROM product_uom_conversions WHERE product_id=? AND from_uom=? AND to_uom=? ORDER BY id').all(product.id,uom,base),lineEvidence) as Array<{factor:unknown}>;
          if(conversions.length===0)fail('UOM_CONVERSION_UNRESOLVED');
          if(conversions.length>1)fail('UOM_CONVERSION_AMBIGUOUS');
          try{factor=decimal(conversions[0].factor)}catch{fail('UOM_CONVERSION_INVALID')}
          if(factor.n<=0n)fail('UOM_CONVERSION_INVALID');
        }
        const baseQuantity=multiply(quantity,factor);
        const price=row('customer_price',{customerId:draft.customer_id,productId:product.id,uom,date},()=>this.db.prepare('SELECT id,unit_price_cents,currency,valid_from,valid_to FROM customer_prices WHERE customer_id=? AND product_id=? AND uom=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>=?) ORDER BY valid_from DESC,id DESC').all(draft.customer_id,product.id,uom,date,date),lineEvidence) as any[];
        if(price.length!==1)fail(price.length===0?'PRICE_INVALID':'PRICE_AMBIGUOUS');const p=price[0];if(p.currency!==currency||typeof p.unit_price_cents!=='number'||!Number.isSafeInteger(p.unit_price_cents)||p.unit_price_cents<0||BigInt(p.unit_price_cents)>MAX_CENTS)fail('PRICE_INVALID');
        const stock=row('warehouse_stock',{productId:product.id,warehouseId},()=>this.db.prepare('SELECT quantity_base FROM stock_balances WHERE product_id=? AND warehouse_id=?').get(product.id,warehouseId),lineEvidence) as {quantity_base:string}|undefined;
        if(!stock)throw Error('STOCK_UNRESOLVED');if(compare(baseQuantity,decimal(stock.quantity_base))>0)fail('STOCK_SHORTAGE');
        const lineSubtotal=cents(multiply(quantity,decimal(p.unit_price_cents)));subtotal+=BigInt(lineSubtotal);if(subtotal>MAX_CENTS)fail('TOTAL_OUT_OF_RANGE');
        lines.push({lineNo:requested.line_no,requestedWording:requested.requested_wording,productId:product.id,stockCode:product.stock_code,description:product.description,quantity:canonical(quantity),requestedUom:uom,baseUom:base,baseQuantity:canonical(baseQuantity),unitPriceCents:p.unit_price_cents,currency:p.currency,subtotalCents:lineSubtotal,availableBaseQuantity:canonical(decimal(stock.quantity_base)),evidenceRefs:lineEvidence});
      }
      if(subtotal>MAX_CENTS)fail('TOTAL_OUT_OF_RANGE');
      const data:OrderValidationData={draftId:draft.id,draftRevision:input.revision,customer:{id:customer.id,code:customer.code,name:customer.name,currency:customer.currency,warehouseId:customer.default_warehouse_id,creditStatus:customer.credit_status},history:history.map(h=>({id:h.id,salesOrderNo:h.sales_order_no,date:h.delivery_date,grandTotalCents:h.grand_total_cents})),warehouseId,currency,lines,subtotalCents:Number(subtotal),taxCents:0,grandTotalCents:Number(subtotal),validatedAt:now(),evidenceRefs:evidence.map(x=>x.sourceId)};
      data.freshnessFingerprint=quoteValidationFreshnessFingerprint(this.db,input.draftId,input.revision,data);
      successfulValidationId=randomUUID();
      data.validationId=successfulValidationId;
      if(!persistAttempt('SUCCEEDED',data,data.validatedAt))return{status:'BLOCKED',evidence,stateChanges:[],reasonCode:'VALIDATION_HISTORY_PERSIST_FAILED'};
      return{status:'SUCCEEDED',data,evidence,stateChanges:[]};
    }catch(error){
      const reasonCode=(error as Error).message;
      persistAttempt('BLOCKED',{status:'BLOCKED',reasonCode},now());
      return{status:'BLOCKED',evidence,stateChanges:[],reasonCode};
    }
  }
  validateForQuotation(input:{draftId:string;revision:number;expectedWorkItemRevision?:number}){return this.validate({...input,mode:'QUOTE_TIME'})}
  validateDraft(input:{draftId:string;revision:number}){return this.validate({...input,mode:'DRAFT'})}
}
