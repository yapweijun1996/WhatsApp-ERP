import {randomUUID} from 'node:crypto';
import {V1Database} from './database.js';
import {canonicalSha256} from './v2-canonical.js';
import {type ActorType,type AuthorityRow,type WorkItemRow,WorkItemService,workspaceFail} from './v2-work-item.js';
import {OrderValidationService} from './v2-order-validation.js';
import type {OrderDraftService as OrderDraftServiceContract,OrderDraftLineContract} from './v2-domain-contracts.js';

export type DraftLineInput={lineNo:number;requestedWording:string;quantity:string|number;requestedUom:string;rowRemark?:string};
export type DraftInput={workItemId:string;accountId:string;conversationId:string;customerId:string;sourceMessageId?:string;requestedDeliveryDate?:string|null;warehouseId?:string|null;currency?:string|null;lines:DraftLineInput[];sourceOrderId?:string};
export type DraftRow={id:string;work_item_id:string;account_id:string;conversation_id:string;customer_id:string;status:'CURRENT'|'SUPERSEDED'|'CANCELLED';current_revision:number;requested_delivery_date?:string|null;warehouse_id?:string|null;currency?:string|null;source_message_id?:string|null;created_at:string;updated_at:string};
export type DraftMutationOptions={idempotencyKey:string;actorType?:ActorType;actorId?:string;sourceMessageId?:string;expectedDraftRevision:number;expectedWorkItemRevision:number};
const now=()=>new Date().toISOString(),uid=()=>randomUUID();
const terminal=new Set(['COMPLETED','CANCELLED','FAILED','HANDED_OFF']);
function jsonSafe<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T}

export function normalizeDate(value:string|null|undefined):string|null{
  if(value==null||value==='')return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))workspaceFail('DELIVERY_DATE_INVALID');
  const d=new Date(`${value}T00:00:00Z`);if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==value)workspaceFail('DELIVERY_DATE_INVALID');return value;
}
export function normalizeQuantity(value:string|number):string{
  const raw=String(value??'').trim();if(!/^\d+(?:\.\d{1,3})?$/.test(raw))workspaceFail('ORDER_LINE_INVALID');
  const [whole,f='']=raw.split('.'),i=BigInt(whole).toString(),fraction=f.replace(/0+$/,'');if(i==='0'&&!fraction)workspaceFail('ORDER_LINE_INVALID');
  const canonical=fraction?`${i}.${fraction}`:i;
  const scale=10n**BigInt(fraction.length),scaled=BigInt(i)*scale+BigInt(fraction||'0');
  const numeric=Number(canonical);
  if(scaled>BigInt(Number.MAX_SAFE_INTEGER)||!Number.isFinite(numeric)||String(numeric)!==canonical)workspaceFail('ORDER_QUANTITY_NOT_EXACT');
  return canonical;
}
export function normalizeDraftLines(lines:DraftLineInput[]){
  if(!Array.isArray(lines)||!lines.length)workspaceFail('ORDER_LINES_REQUIRED');
  const seen=new Set<number>();
  return lines.map(line=>{const lineNo=Number(line.lineNo),requestedWording=String(line.requestedWording??'').trim(),requestedUom=String(line.requestedUom??'').trim().toUpperCase();if(!Number.isInteger(lineNo)||lineNo<1||seen.has(lineNo))workspaceFail('LINE_NUMBER_INVALID');seen.add(lineNo);if(!requestedWording||!requestedUom)workspaceFail('ORDER_LINE_INVALID');return{lineNo,requestedWording,quantity:normalizeQuantity(line.quantity),requestedUom,rowRemark:String(line.rowRemark??'').trim()||null}}).sort((a,b)=>a.lineNo-b.lineNo);
}

export class OrderDraftService implements OrderDraftServiceContract{
  constructor(public readonly database=new V1Database(':memory:'),private readonly work=new WorkItemService(database)){}
  private get db(){return this.database.db}

  read(draftId:string){const d=this.db.prepare('SELECT * FROM order_drafts WHERE id=?').get(draftId) as DraftRow|undefined;if(!d)return;const lines=this.db.prepare('SELECT * FROM order_draft_lines WHERE draft_id=? ORDER BY line_no').all(draftId) as OrderDraftLineContract[];return{...d,lines,revisionRecord:this.db.prepare('SELECT * FROM order_draft_revisions WHERE draft_id=? AND revision=?').get(draftId,d.current_revision)}}
  currentForWorkItem(workItemId:string){return this.db.prepare("SELECT * FROM order_drafts WHERE work_item_id=? AND status='CURRENT'").get(workItemId) as DraftRow|undefined}
  readRevision(draftId:string,revision:number){const r=this.db.prepare('SELECT immutable_snapshot_json FROM order_draft_revisions WHERE draft_id=? AND revision=?').get(draftId,revision) as {immutable_snapshot_json:string}|undefined;return r?JSON.parse(r.immutable_snapshot_json):undefined}
  private hasRevisionKey(draftId:string,key:string){return Boolean(this.db.prepare('SELECT 1 FROM order_draft_revisions WHERE draft_id=? AND idempotency_key=?').get(draftId,key));}

  private assertCanonicalAllowsDraftMutation(conversationId:string,allowSentQuoteEdit=false,workItemId?:string){
    if(this.work.canonicalCommitment(conversationId))workspaceFail('CANONICAL_COMMITMENT_HANDOFF');
    const draftQuote=this.db.prepare("SELECT 1 FROM quotations WHERE source_conversation_id=? AND status='DRAFT' LIMIT 1").get(conversationId);
    if(draftQuote)workspaceFail('CANONICAL_QUOTE_ACTION_REQUIRED');
    const quote=this.db.prepare("SELECT id,customer_id FROM quotations WHERE source_conversation_id=? AND status='SENT' ORDER BY rowid DESC LIMIT 1").get(conversationId) as {id:string;customer_id:string}|undefined;
    const unresolved=this.db.prepare("SELECT 1 FROM outbound_messages WHERE conversation_id=? AND status IN ('PENDING','UNKNOWN') LIMIT 1").get(conversationId);
    if(unresolved)workspaceFail('CANONICAL_QUOTE_ACTION_REQUIRED');
    if(quote && !allowSentQuoteEdit)workspaceFail('CANONICAL_QUOTE_ACTION_REQUIRED');
    if(quote && allowSentQuoteEdit && workItemId){
      const w=this.db.prepare('SELECT active_quotation_id,customer_id FROM work_items WHERE id=?').get(workItemId) as {active_quotation_id:string|null;customer_id:string}|undefined;
      if(w?.active_quotation_id && w.active_quotation_id!==quote.id)workspaceFail('CANONICAL_QUOTE_ACTION_REQUIRED');
      if(w&&w.customer_id!==quote.customer_id)workspaceFail('CANONICAL_QUOTE_ACTION_REQUIRED');
    }
  }

  private normalized(input:DraftInput,actor:ActorType){
    this.work.ensureScope(input.accountId,input.conversationId,input.customerId);
    const source=this.work.sourceMessage(input.accountId,input.conversationId,input.sourceMessageId,actor);
    return {source,delivery:normalizeDate(input.requestedDeliveryDate),lines:normalizeDraftLines(input.lines)};
  }

  private snapshot(draftId:string,w:WorkItemRow,input:DraftInput,revision:number,source:string|null,delivery:string|null,lines:ReturnType<typeof normalizeDraftLines>){
    return{id:draftId,work_item_id:w.id,account_id:input.accountId,conversation_id:input.conversationId,customer_id:input.customerId,status:'CURRENT' as const,current_revision:revision,requested_delivery_date:delivery,warehouse_id:input.warehouseId??null,currency:input.currency??null,source_message_id:source,sourceOrderId:input.sourceOrderId??null,sourceEvidenceRefs:input.sourceOrderId?[input.sourceOrderId]:[],lines:lines.map(x=>({line_no:x.lineNo,requested_wording:x.requestedWording,quantity:x.quantity,requested_uom:x.requestedUom,row_remark:x.rowRemark,resolved_product_id:null,resolved_uom:null,evidence_refs_json:null}))};
  }

  create(input:DraftInput,opts:{idempotencyKey:string;actorType?:ActorType;actorId?:string;expectedWorkItemRevision:number}){
    if(!opts.idempotencyKey)workspaceFail('IDEMPOTENCY_KEY_REQUIRED');
    this.work.requireV2Writer(input.accountId,input.conversationId);const actor=opts.actorType??'AI';const {source,delivery,lines}=this.normalized(input,actor);
    return this.db.transaction(()=>{
      const w=this.db.prepare('SELECT * FROM work_items WHERE id=? AND account_id=? AND conversation_id=? AND customer_id=?').get(input.workItemId,input.accountId,input.conversationId,input.customerId) as WorkItemRow|undefined;if(!w)workspaceFail('WORK_ITEM_SCOPE');if(terminal.has(w.state))workspaceFail('WORK_ITEM_NOT_CURRENT');
      this.assertCanonicalAllowsDraftMutation(w.conversation_id);
      const actionType=input.sourceOrderId?'REUSE_PREVIOUS_ORDER':'CREATE';
      const h=canonicalSha256({actionType,workItemId:w.id,expectedWorkItemRevision:opts.expectedWorkItemRevision,sourceMessageId:source,sourceOrderId:input.sourceOrderId??null,actorType:actor,actorId:opts.actorId??null,requestedDeliveryDate:delivery,warehouseId:input.warehouseId??null,currency:input.currency??null,lines});
      const prior=this.db.prepare('SELECT r.* FROM order_draft_revisions r JOIN order_drafts d ON d.id=r.draft_id WHERE d.work_item_id=? AND r.idempotency_key=?').get(w.id,opts.idempotencyKey) as any;if(prior){if(prior.normalized_input_hash!==h)workspaceFail('IDEMPOTENCY_CONFLICT');return JSON.parse(prior.immutable_snapshot_json)}
      if(this.currentForWorkItem(w.id))workspaceFail('DRAFT_ALREADY_EXISTS');if(w.revision!==opts.expectedWorkItemRevision)workspaceFail('STALE_WORK_ITEM_REVISION');
      const draftId=uid(),revision=1,t=now(),snap=this.snapshot(draftId,w,input,revision,source,delivery,lines);
      this.db.prepare('INSERT INTO order_drafts(id,work_item_id,account_id,conversation_id,customer_id,status,current_revision,requested_delivery_date,warehouse_id,currency,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(draftId,w.id,input.accountId,input.conversationId,input.customerId,'CURRENT',revision,delivery,input.warehouseId??null,input.currency??null,source,t,t);
      for(const x of snap.lines)this.db.prepare('INSERT INTO order_draft_lines(id,draft_id,line_no,requested_wording,quantity,requested_uom,row_remark,resolved_product_id,resolved_uom,evidence_refs_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid(),draftId,x.line_no,x.requested_wording,x.quantity,x.requested_uom,x.row_remark,null,null,null);
      this.db.prepare('INSERT INTO order_draft_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),draftId,revision,0,actionType,actor,opts.actorId??null,source,opts.idempotencyKey,h,JSON.stringify(snap),t);
      this.work.attachDraft(w,draftId,{expectedRevision:opts.expectedWorkItemRevision,idempotencyKey:`${opts.idempotencyKey}:attach`,actorType:actor,actorId:opts.actorId,sourceMessageId:source});
      this.db.prepare('INSERT INTO workspace_provenance_links VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid(),input.accountId,input.conversationId,w.id,draftId,revision,source,w.active_quotation_id??null,null,'DRAFT_REVISION',t);
      return snap;
    })();
  }

  private mutate(draftId:string,build:()=>Omit<DraftInput,'workItemId'|'accountId'|'conversationId'|'customerId'>,opts:DraftMutationOptions,actionType:string,allowSentQuoteEdit=false,allowEmpty=false,sourceOrderId:string|null=null,actionContext:unknown=null,afterDraftWrite?:()=>void){
    if(!opts.idempotencyKey)workspaceFail('IDEMPOTENCY_KEY_REQUIRED');
    const d=this.db.prepare('SELECT * FROM order_drafts WHERE id=?').get(draftId) as DraftRow|undefined;if(!d)workspaceFail('DRAFT_NOT_FOUND');if(d.status!=='CURRENT')workspaceFail('DRAFT_NOT_CURRENT');
    this.work.requireV2Writer(d.account_id,d.conversation_id);const actor=opts.actorType??'AI';const source=this.work.sourceMessage(d.account_id,d.conversation_id,opts.sourceMessageId,actor);
    const h=canonicalSha256({actionType,actionContext,draftId,expectedDraftRevision:opts.expectedDraftRevision,expectedWorkItemRevision:opts.expectedWorkItemRevision,sourceMessageId:source,sourceOrderId,actorType:actor,actorId:opts.actorId??null});
    const prior=this.db.prepare('SELECT * FROM order_draft_revisions WHERE draft_id=? AND idempotency_key=?').get(draftId,opts.idempotencyKey) as any;
    if(prior){if(prior.normalized_input_hash!==h)workspaceFail('IDEMPOTENCY_CONFLICT');return JSON.parse(prior.immutable_snapshot_json)}
    return this.db.transaction(()=>{
      const w=this.db.prepare('SELECT * FROM work_items WHERE id=? AND account_id=? AND conversation_id=? AND customer_id=?').get(d.work_item_id,d.account_id,d.conversation_id,d.customer_id) as WorkItemRow|undefined;if(!w)workspaceFail('WORK_ITEM_SCOPE');if(terminal.has(w.state))workspaceFail('WORK_ITEM_NOT_CURRENT');this.assertCanonicalAllowsDraftMutation(w.conversation_id,allowSentQuoteEdit,w.id);
      const input=build(),full={...input,sourceMessageId:opts.sourceMessageId,workItemId:d.work_item_id,accountId:d.account_id,conversationId:d.conversation_id,customerId:d.customer_id};const normalized=allowEmpty&&input.lines.length===0?{source,delivery:normalizeDate(input.requestedDeliveryDate),lines:[]}:this.normalized(full,actor);const {delivery,lines}=normalized;
      const current=this.db.prepare("SELECT * FROM order_drafts WHERE id=? AND status='CURRENT'").get(draftId) as DraftRow|undefined;if(!current)workspaceFail('DRAFT_NOT_CURRENT');if(current.current_revision!==opts.expectedDraftRevision)workspaceFail('STALE_DRAFT_REVISION');if(w.revision!==opts.expectedWorkItemRevision)workspaceFail('STALE_WORK_ITEM_REVISION');
      if(!allowEmpty&&!lines.length)workspaceFail('ORDER_LINES_REQUIRED');
      const revision=current.current_revision+1,t=now(),snap={...this.snapshot(draftId,w,full,revision,source,delivery,lines),sourceOrderId,sourceEvidenceRefs:sourceOrderId?[sourceOrderId]:[]};
      const c=this.db.prepare('UPDATE order_drafts SET current_revision=?,requested_delivery_date=?,warehouse_id=?,currency=?,source_message_id=?,updated_at=? WHERE id=? AND current_revision=?').run(revision,delivery,full.warehouseId??null,full.currency??null,source,t,draftId,current.current_revision);if(c.changes!==1)workspaceFail('STALE_DRAFT_REVISION');
      this.db.prepare('DELETE FROM order_draft_lines WHERE draft_id=?').run(draftId);for(const x of snap.lines)this.db.prepare('INSERT INTO order_draft_lines(id,draft_id,line_no,requested_wording,quantity,requested_uom,row_remark,resolved_product_id,resolved_uom,evidence_refs_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid(),draftId,x.line_no,x.requested_wording,x.quantity,x.requested_uom,x.row_remark,null,null,null);
      this.db.prepare('INSERT INTO order_draft_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),draftId,revision,current.current_revision,actionType,actor,opts.actorId??null,source,opts.idempotencyKey,h,JSON.stringify(snap),t);
      this.db.prepare('INSERT INTO workspace_provenance_links VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid(),d.account_id,d.conversation_id,w.id,draftId,revision,source,w.active_quotation_id??null,null,'DRAFT_REVISION',t);
      afterDraftWrite?.();
      return snap;
    })();
  }

  update(draftId:string,input:Omit<DraftInput,'workItemId'|'accountId'|'conversationId'|'customerId'>,opts:DraftMutationOptions){return this.mutate(draftId,()=>input,{...opts,sourceMessageId:opts.sourceMessageId??input.sourceMessageId},'SNAPSHOT_REPLACE',false,false,null,input);}

  addLine(draftId:string,line:DraftLineInput,opts:DraftMutationOptions){const d=this.db.prepare('SELECT id FROM order_drafts WHERE id=?').get(draftId);if(!d)workspaceFail('DRAFT_NOT_FOUND');return this.mutate(draftId,()=>{const current=this.read(draftId);if(!current)workspaceFail('DRAFT_NOT_FOUND');if(current.lines?.some(x=>x.line_no===line.lineNo))workspaceFail('LINE_IDENTITY_AMBIGUOUS');return{sourceMessageId:opts.sourceMessageId,requestedDeliveryDate:current.requested_delivery_date,warehouseId:current.warehouse_id,currency:current.currency,lines:[...(current.lines??[]).map(x=>({lineNo:x.line_no,requestedWording:x.requested_wording,quantity:x.quantity,requestedUom:x.requested_uom,rowRemark:x.row_remark??undefined})),line]};},opts,'ADD_LINE',true,false,null,line);}

  changeLine(draftId:string,lineNo:number,change:Partial<Omit<DraftLineInput,'lineNo'>>,opts:DraftMutationOptions){const d=this.db.prepare('SELECT id FROM order_drafts WHERE id=?').get(draftId);if(!d)workspaceFail('DRAFT_NOT_FOUND');return this.mutate(draftId,()=>{const current=this.read(draftId);if(!current)workspaceFail('DRAFT_NOT_FOUND');const old=current.lines?.find(x=>x.line_no===lineNo);if(!old)workspaceFail('LINE_NOT_FOUND');return{sourceMessageId:opts.sourceMessageId,requestedDeliveryDate:current.requested_delivery_date,warehouseId:current.warehouse_id,currency:current.currency,lines:(current.lines??[]).map(x=>x.line_no===lineNo?{lineNo,requestedWording:change.requestedWording??x.requested_wording,quantity:change.quantity??x.quantity,requestedUom:change.requestedUom??x.requested_uom,rowRemark:change.rowRemark??x.row_remark??undefined}:{lineNo:x.line_no,requestedWording:x.requested_wording,quantity:x.quantity,requestedUom:x.requested_uom,rowRemark:x.row_remark??undefined})};},opts,'CHANGE_LINE',true,false,null,{lineNo,change});}

  removeLine(draftId:string,lineNo:number,opts:DraftMutationOptions){const d=this.db.prepare('SELECT id FROM order_drafts WHERE id=?').get(draftId);if(!d)workspaceFail('DRAFT_NOT_FOUND');return this.mutate(draftId,()=>{const current=this.read(draftId);if(!current)workspaceFail('DRAFT_NOT_FOUND');if(!(current.lines??[]).some(x=>x.line_no===lineNo))workspaceFail('LINE_NOT_FOUND');return{sourceMessageId:opts.sourceMessageId,requestedDeliveryDate:current.requested_delivery_date,warehouseId:current.warehouse_id,currency:current.currency,lines:(current.lines??[]).filter(x=>x.line_no!==lineNo).map(x=>({lineNo:x.line_no,requestedWording:x.requested_wording,quantity:x.quantity,requestedUom:x.requested_uom,rowRemark:x.row_remark??undefined}))};},opts,'REMOVE_LINE',true,true,null,lineNo);}

  setDeliveryRequest(draftId:string,requestedDeliveryDate:string|null,opts:DraftMutationOptions){const d=this.db.prepare('SELECT id FROM order_drafts WHERE id=?').get(draftId);if(!d)workspaceFail('DRAFT_NOT_FOUND');return this.mutate(draftId,()=>{const current=this.read(draftId);if(!current)workspaceFail('DRAFT_NOT_FOUND');return{sourceMessageId:opts.sourceMessageId,requestedDeliveryDate,warehouseId:current.warehouse_id,currency:current.currency,lines:(current.lines??[]).map(x=>({lineNo:x.line_no,requestedWording:x.requested_wording,quantity:x.quantity,requestedUom:x.requested_uom,rowRemark:x.row_remark??undefined}))};},opts,'SET_DELIVERY_REQUEST',true,true,null,{requestedDeliveryDate});}

  reusePreviousOrder(input:{workItemId:string;accountId:string;conversationId:string;customerId:string;previousSalesOrderId:string;sourceMessageId?:string;requestedDeliveryDate?:string|null;warehouseId?:string|null;currency?:string|null},opts:{idempotencyKey:string;actorType?:ActorType;actorId?:string;expectedWorkItemRevision:number}){
    this.work.ensureScope(input.accountId,input.conversationId,input.customerId);const scopedWork=this.db.prepare('SELECT id FROM work_items WHERE id=? AND account_id=? AND conversation_id=? AND customer_id=?').get(input.workItemId,input.accountId,input.conversationId,input.customerId) as {id:string}|undefined;if(!scopedWork)workspaceFail('WORK_ITEM_SCOPE');
    const actor=opts.actorType??'AI',source=this.work.sourceMessage(input.accountId,input.conversationId,input.sourceMessageId,actor),delivery=normalizeDate(input.requestedDeliveryDate),warehouseId=input.warehouseId??null,currency=input.currency??null;
    const prior=this.db.prepare('SELECT r.immutable_snapshot_json FROM order_draft_revisions r JOIN order_drafts d ON d.id=r.draft_id WHERE d.work_item_id=? AND r.idempotency_key=?').get(input.workItemId,opts.idempotencyKey) as {immutable_snapshot_json:string}|undefined;
    if(prior){
      const snapshot=JSON.parse(prior.immutable_snapshot_json) as any;
      const sameRequest=snapshot.sourceOrderId===input.previousSalesOrderId&&snapshot.account_id===input.accountId&&snapshot.conversation_id===input.conversationId&&snapshot.customer_id===input.customerId&&snapshot.source_message_id===source&&snapshot.requested_delivery_date===delivery&&snapshot.warehouse_id===warehouseId&&snapshot.currency===currency;
      if(!sameRequest)workspaceFail('IDEMPOTENCY_CONFLICT');
      return snapshot;
    }
    const order=this.db.prepare('SELECT id FROM sales_orders WHERE id=? AND customer_id=?').get(input.previousSalesOrderId,input.customerId);if(!order)workspaceFail('REUSE_SOURCE_NOT_FOUND');
    const lines=this.db.prepare('SELECT row_item_no AS lineNo,stock_description AS requestedWording,quantity, uom AS requestedUom FROM sales_order_lines WHERE sales_order_id=? ORDER BY row_item_no').all(input.previousSalesOrderId) as DraftLineInput[];if(!lines.length)workspaceFail('REUSE_SOURCE_EMPTY');
    return this.create({...input,sourceOrderId:input.previousSalesOrderId,requestedDeliveryDate:delivery,warehouseId,currency,lines},{...opts});
  }

  private assertValidationCanonical(draftId:string,expectedDraftRevision:number,expectedWorkItemRevision:number){
    const d=this.db.prepare("SELECT * FROM order_drafts WHERE id=? AND status='CURRENT'").get(draftId) as DraftRow|undefined;if(!d)workspaceFail('DRAFT_NOT_FOUND');
    const w=this.db.prepare('SELECT * FROM work_items WHERE id=? AND account_id=? AND conversation_id=? AND customer_id=?').get(d.work_item_id,d.account_id,d.conversation_id,d.customer_id) as WorkItemRow|undefined;if(!w)workspaceFail('WORK_ITEM_SCOPE');
    if(w.revision!==expectedWorkItemRevision)workspaceFail('STALE_WORK_ITEM_REVISION');
    if(d.current_revision!==expectedDraftRevision)workspaceFail('STALE_DRAFT_REVISION');
    if(this.work.canonicalCommitment(d.conversation_id))workspaceFail('CANONICAL_COMMITMENT_HANDOFF');
    if(this.db.prepare("SELECT 1 FROM quotations WHERE source_conversation_id=? AND status='DRAFT' LIMIT 1").get(d.conversation_id))workspaceFail('CANONICAL_QUOTE_ACTION_REQUIRED');
    const sent=this.db.prepare("SELECT customer_id FROM quotations WHERE source_conversation_id=? AND status='SENT' ORDER BY rowid DESC LIMIT 1").get(d.conversation_id) as {customer_id:string}|undefined;
    if(sent&&sent.customer_id!==d.customer_id)workspaceFail('CANONICAL_QUOTE_ACTION_REQUIRED');
    if(this.db.prepare("SELECT 1 FROM outbound_messages WHERE conversation_id=? AND status IN ('PENDING','UNKNOWN') LIMIT 1").get(d.conversation_id))workspaceFail('CANONICAL_QUOTE_ACTION_REQUIRED');
    return {d,w};
  }

  async validate(draftId:string,opts:{idempotencyKey:string;actorType?:ActorType;actorId?:string;sourceMessageId?:string;expectedDraftRevision:number;expectedWorkItemRevision:number}){
    if(!opts.idempotencyKey)workspaceFail('IDEMPOTENCY_KEY_REQUIRED');
    const d=this.db.prepare("SELECT * FROM order_drafts WHERE id=? AND status='CURRENT'").get(draftId) as DraftRow|undefined;if(!d)workspaceFail('DRAFT_NOT_FOUND');
    this.work.requireV2Writer(d.account_id,d.conversation_id);const actor=opts.actorType??'AI';const source=this.work.sourceMessage(d.account_id,d.conversation_id,opts.sourceMessageId,actor);const h=canonicalSha256({actionType:'VALIDATE',draftId,expectedDraftRevision:opts.expectedDraftRevision,expectedWorkItemRevision:opts.expectedWorkItemRevision,sourceMessageId:source,actorType:actor,actorId:opts.actorId??null});
    const prior=this.db.prepare('SELECT immutable_snapshot_json FROM order_draft_revisions WHERE draft_id=? AND idempotency_key=?').get(draftId,opts.idempotencyKey) as {immutable_snapshot_json:string}|undefined;
    if(prior){const stored=JSON.parse(prior.immutable_snapshot_json);if(stored.validationHash!==h)workspaceFail('IDEMPOTENCY_CONFLICT');return stored.validationResult;}
    const {w}=this.assertValidationCanonical(draftId,opts.expectedDraftRevision,opts.expectedWorkItemRevision);
    const result=await new OrderValidationService(this.database).validate({draftId,revision:opts.expectedDraftRevision,expectedWorkItemRevision:opts.expectedWorkItemRevision,mode:'DRAFT'});
    // Canonicalize before both durable storage and the first response. This also
    // removes undefined optional properties so replay is structurally identical.
    const durableResult=jsonSafe(result);
    const committed=this.db.transaction(()=>{
      const finalState=this.assertValidationCanonical(draftId,opts.expectedDraftRevision,opts.expectedWorkItemRevision);
      const old=this.readRevision(draftId,opts.expectedDraftRevision);if(!old)workspaceFail('DRAFT_REVISION_NOT_FOUND');
      const revision=opts.expectedDraftRevision+1,t=now();const snap={...old,id:draftId,current_revision:revision,source_message_id:source,validationHash:h,validationResult:durableResult,validationEvidenceRefs:durableResult.evidence.map(x=>x.sourceId)};
      const changed=this.db.prepare('UPDATE order_drafts SET current_revision=?,source_message_id=?,updated_at=? WHERE id=? AND current_revision=?').run(revision,source,t,draftId,opts.expectedDraftRevision);if(changed.changes!==1)workspaceFail('STALE_DRAFT_REVISION');
      this.db.prepare('INSERT INTO order_draft_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),draftId,revision,opts.expectedDraftRevision,'VALIDATE',actor,opts.actorId??null,source,opts.idempotencyKey,h,JSON.stringify(snap),t);
      this.db.prepare('INSERT INTO workspace_provenance_links VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid(),finalState.d.account_id,finalState.d.conversation_id,finalState.w.id,draftId,revision,source,finalState.w.active_quotation_id??null,null,'DRAFT_VALIDATION',t);
      return durableResult;
    })();
    return committed;
  }

  prepareRequote(draftId:string,opts:DraftMutationOptions){
    const d=this.read(draftId);if(!d)workspaceFail('DRAFT_NOT_FOUND');
    const actor=opts.actorType??'AI',source=this.work.sourceMessage(d.account_id,d.conversation_id,opts.sourceMessageId,actor);
    const replayHash=canonicalSha256({actionType:'PREPARE_REQUOTE',actionContext:null,draftId,expectedDraftRevision:opts.expectedDraftRevision,expectedWorkItemRevision:opts.expectedWorkItemRevision,sourceMessageId:source,sourceOrderId:null,actorType:actor,actorId:opts.actorId??null});
    const prior=this.db.prepare('SELECT normalized_input_hash,immutable_snapshot_json FROM order_draft_revisions WHERE draft_id=? AND idempotency_key=?').get(draftId,opts.idempotencyKey) as any;
    if(prior){if(prior.normalized_input_hash!==replayHash)workspaceFail('IDEMPOTENCY_CONFLICT');return JSON.parse(prior.immutable_snapshot_json)}
    const quote=this.db.prepare("SELECT id,status FROM quotations WHERE source_conversation_id=? AND status='SENT' ORDER BY rowid DESC LIMIT 1").get(d.conversation_id) as {id:string;status:string}|undefined;
    if(!quote)workspaceFail('ACTIVE_SENT_QUOTE_REQUIRED');
    const quoteCustomer=this.db.prepare('SELECT customer_id FROM quotations WHERE id=?').get(quote.id) as {customer_id:string}|undefined;if(quoteCustomer?.customer_id!==d.customer_id)workspaceFail('CANONICAL_QUOTE_ACTION_REQUIRED');
    const w=this.work.read(d.work_item_id);if(!w)workspaceFail('WORK_ITEM_SCOPE');if(w.revision!==opts.expectedWorkItemRevision)workspaceFail('STALE_WORK_ITEM_REVISION');if(!['OPEN','DRAFTING','AWAITING_ACCEPTANCE','QUOTING'].includes(w.state)){const prior=this.db.prepare('SELECT 1 FROM order_draft_revisions WHERE draft_id=? AND idempotency_key=?').get(draftId,opts.idempotencyKey);if(!prior)workspaceFail('INVALID_WORK_ITEM_TRANSITION');}
    const revised=this.mutate(draftId,()=>({sourceMessageId:opts.sourceMessageId,requestedDeliveryDate:d.requested_delivery_date,warehouseId:d.warehouse_id,currency:d.currency,lines:(d.lines??[]).map(x=>({lineNo:x.line_no,requestedWording:x.requested_wording,quantity:x.quantity,requestedUom:x.requested_uom,rowRemark:x.row_remark??undefined}))}),opts,'PREPARE_REQUOTE',true,true,null,null,()=>{if(w.state!=='CHANGING')this.work.transition({workItemId:w.id,accountId:w.account_id,conversationId:w.conversation_id,to:'CHANGING',expectedRevision:opts.expectedWorkItemRevision,idempotencyKey:`${opts.idempotencyKey}:state`,actorType:actor,actorId:opts.actorId,sourceMessageId:opts.sourceMessageId,reason:'REQUOTE_PREPARATION_REQUIRED'});});
    return revised;
  }

  /** Migration-only shadow projection. It never changes workspace authority. */
  projectShadow(input:Omit<DraftInput,'workItemId'>,opts:{idempotencyKey:string;sourceHash:string}){
    const a=this.work.getAuthority(input.accountId,input.conversationId) as AuthorityRow;if(a.authoritative_writer!=='LEGACY'||!['V1_ONLY','SHADOW_IMPORT'].includes(a.migration_state))workspaceFail('SHADOW_IMPORT_NOT_ALLOWED');
    const {source,delivery,lines}=this.normalized({...input,workItemId:a.work_item_id??''},'SYSTEM');
    return this.db.transaction(()=>{
      let w=this.work.active(input.accountId,input.conversationId);const t=now();
      if(!w){w={id:uid(),account_id:input.accountId,conversation_id:input.conversationId,customer_id:input.customerId,type:'SALES_ORDER_REQUEST',state:'DRAFTING',revision:1,goal_summary:'Customer sales order request',active_order_draft_id:null,active_quotation_id:null,assigned_profile:null,blocking_reason:null,source_message_id:source,created_at:t,updated_at:t};this.db.prepare('INSERT INTO work_items VALUES(@id,@account_id,@conversation_id,@customer_id,@type,@state,@revision,@goal_summary,@active_order_draft_id,@active_quotation_id,@assigned_profile,@blocking_reason,@source_message_id,@created_at,@updated_at)').run(w);const wh=canonicalSha256({kind:'SHADOW_WORK_ITEM_CREATE',sourceHash:opts.sourceHash});this.db.prepare('INSERT INTO work_item_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),w.id,1,'SHADOW_CREATE',null,'DRAFTING','SYSTEM',null,source,`${opts.idempotencyKey}:work`,wh,JSON.stringify(w),t);}
      const d=this.currentForWorkItem(w.id),draftId=d?.id??uid(),revision=(d?.current_revision??0)+1;const snap=this.snapshot(draftId,w,{...input,workItemId:w.id},revision,source,delivery,lines);const h=canonicalSha256({actionType:'SHADOW_IMPORT',sourceHash:opts.sourceHash,sourceMessageId:source,requestedDeliveryDate:delivery,warehouseId:input.warehouseId??null,currency:input.currency??null,lines});const prior=d?this.db.prepare('SELECT * FROM order_draft_revisions WHERE draft_id=? AND idempotency_key=?').get(d.id,opts.idempotencyKey) as any:undefined;if(prior){if(prior.normalized_input_hash!==h)workspaceFail('IDEMPOTENCY_CONFLICT');return{workItem:w,draft:JSON.parse(prior.immutable_snapshot_json)}}const latest=d?this.db.prepare('SELECT normalized_input_hash,immutable_snapshot_json FROM order_draft_revisions WHERE draft_id=? ORDER BY revision DESC LIMIT 1').get(d.id) as any:undefined;if(latest?.normalized_input_hash===h)return{workItem:w,draft:JSON.parse(latest.immutable_snapshot_json)};
      if(!d)this.db.prepare('INSERT INTO order_drafts(id,work_item_id,account_id,conversation_id,customer_id,status,current_revision,requested_delivery_date,warehouse_id,currency,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(draftId,w.id,input.accountId,input.conversationId,input.customerId,'CURRENT',revision,delivery,input.warehouseId??null,input.currency??null,source,t,t);else this.db.prepare('UPDATE order_drafts SET current_revision=?,requested_delivery_date=?,warehouse_id=?,currency=?,source_message_id=?,updated_at=? WHERE id=?').run(revision,delivery,input.warehouseId??null,input.currency??null,source,t,draftId);
      this.db.prepare('DELETE FROM order_draft_lines WHERE draft_id=?').run(draftId);for(const x of snap.lines)this.db.prepare('INSERT INTO order_draft_lines(id,draft_id,line_no,requested_wording,quantity,requested_uom,row_remark,resolved_product_id,resolved_uom,evidence_refs_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid(),draftId,x.line_no,x.requested_wording,x.quantity,x.requested_uom,x.row_remark,null,null,null);this.db.prepare('INSERT INTO order_draft_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),draftId,revision,d?.current_revision??0,'SHADOW_IMPORT','SYSTEM',null,source,opts.idempotencyKey,h,JSON.stringify(snap),t);
      if(!w.active_order_draft_id){const next={...w,active_order_draft_id:draftId,revision:w.revision+1,updated_at:t};this.db.prepare('UPDATE work_items SET active_order_draft_id=?,revision=?,updated_at=? WHERE id=?').run(draftId,next.revision,t,w.id);const ah=canonicalSha256({kind:'SHADOW_ATTACH',draftId,sourceHash:opts.sourceHash});this.db.prepare('INSERT INTO work_item_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),w.id,next.revision,'SHADOW_ATTACH',w.state,w.state,'SYSTEM',null,source,`${opts.idempotencyKey}:attach`,ah,JSON.stringify(next),t);w=next;}
      this.db.prepare('INSERT INTO workspace_provenance_links VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid(),input.accountId,input.conversationId,w.id,draftId,revision,source,null,null,'SHADOW_DRAFT_REVISION',t);
      return{workItem:w,draft:snap};
    })();
  }
}
