import {resolveVerifiedCustomerId} from './v2-identity-resolver.js';
import {createHash,randomUUID} from 'node:crypto'; import type Database from 'better-sqlite3';
import {V1Database} from './database.js'; import {DemoErpAdapter,type Evidence} from './erp.js'; import type {IncomingChannelMessage,WhatsAppChannelAdapter} from './channels.js';
import { OutboundMessageService } from './outbound-message-service.js';
import {PiOrderAgent, type OrderIntentResult, type InterpretedOrderLine} from './pi-agent.js'; import {normalizePhone} from './channels.js';
import type {VerifyStaffCapability} from './staff-auth.js';
import { CommitmentGuard, commitmentMessageRef, narrowCommitmentProposal } from './v2-commitment-guard.js';
import { commitAcceptedQuotation } from './v2-acceptance-commit.js';
import { WorkItemService } from './v2-work-item.js';
import { projectAudit, projectTimeline, type TimelineEvent } from './v2-timeline.js';
import { projectUiState, type UiState } from './v2-ui-state.js';
const now=()=>new Date().toISOString(),uuid=()=>randomUUID(),sha=(x:string)=>createHash('sha256').update(x).digest('hex');
export type CommerceState={id:string;customer:string;phone:string;messages:{from:string;text:string}[];activities:{actor:string;text:string;at:string}[];timeline:TimelineEvent[];uiState:UiState;quote?:any;so?:any;connection:'simulated'|'whatsapp-qr';staffActions:any[]};
type PendingOrder={customerId:string;accountId:string;sourceMessageId:string;senderExternalId:string;requestedDeliveryDate:string;lines:InterpretedOrderLine[]};
type ResolvedOrder={customer:Evidence;history:Evidence;lines:Array<{request:InterpretedOrderLine;product:Evidence;uom:Evidence;conversion:Evidence;price:Evidence;stock:Evidence;unitPriceCents:number;subtotalCents:number}>};
export type OrderSemanticAgent = { run(text:string): Promise<OrderIntentResult> };
export type OrderIntentHandler = (intent:OrderIntentResult)=>Promise<unknown>;
export type OrderSemanticAgentFactory = (handler:OrderIntentHandler,onEvent?:(event:{type:string;toolName?:string;args?:unknown;result?:unknown;isError?:boolean})=>void)=>OrderSemanticAgent;

export function quotationCommercialSealPayload(db:Database.Database,quotationId:string,snapshotJson:string){
 const lines=db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no').all(quotationId);
 const evidence=db.prepare(`SELECT qle.quotation_line_id,qle.evidence_id,qle.role FROM quotation_line_evidence qle JOIN quotation_lines ql ON ql.id=qle.quotation_line_id WHERE ql.quotation_id=? ORDER BY qle.quotation_line_id,qle.evidence_id,qle.role`).all(quotationId);
 const evidenceContent=db.prepare(`SELECT qle.quotation_line_id,qle.evidence_id,qle.role,e.evidence_type,e.tool_call_id,e.lookup_key,e.input_json,e.output_json,e.observed_at,e.source_version FROM quotation_line_evidence qle JOIN quotation_lines ql ON ql.id=qle.quotation_line_id JOIN erp_evidence e ON e.id=qle.evidence_id WHERE ql.quotation_id=? ORDER BY qle.quotation_line_id,qle.evidence_id,qle.role`).all(quotationId);
 const toolCalls=db.prepare(`SELECT DISTINCT a.id,a.agent_run_id,a.tool_name,a.input_json,a.output_json,a.status,a.occurred_at FROM agent_tool_calls a JOIN erp_evidence e ON e.tool_call_id=a.id JOIN quotation_line_evidence qle ON qle.evidence_id=e.id JOIN quotation_lines ql ON ql.id=qle.quotation_line_id WHERE ql.quotation_id=? ORDER BY a.id`).all(quotationId);
 return JSON.stringify({snapshot:snapshotJson,lines,evidence,evidenceContent,toolCalls});
}
function verifyV2Quotation(db:Database.Database,q:any,accountId:string,conversationId:string,s:any){
 const seal=db.prepare("SELECT * FROM commercial_integrity_seals WHERE entity_type='QUOTATION' AND entity_id=? AND account_id=? AND conversation_id=? AND customer_id=? AND lineage_id=?").get(q.id,accountId,conversationId,q.customer_id,q.id) as any;
 if(!seal||sha(seal.payload_json)!==seal.payload_hash||quotationCommercialSealPayload(db,q.id,q.sent_snapshot_json)!==seal.payload_json)throw Error('QUOTE_INTEGRITY_INVALID');
 const v=db.prepare("SELECT * FROM v2_order_validations WHERE id=? AND draft_id=? AND draft_revision=? AND mode='QUOTE_TIME' AND status='SUCCEEDED'").get(s.sourceValidationId,s.sourceDraftId,s.sourceDraftRevision) as any;if(!v)throw Error('QUOTE_INTEGRITY_INVALID');
 let r:any,refs:any[];try{r=JSON.parse(v.result_json);refs=JSON.parse(v.evidence_refs_json)}catch{throw Error('QUOTE_INTEGRITY_INVALID')};const ids=refs.map(x=>typeof x==='string'?x:x?.sourceId);if(!r.data)r.data=r;
 if(!Array.isArray(s.validationEvidenceRefs)||JSON.stringify([...ids].sort())!==JSON.stringify([...s.validationEvidenceRefs].sort())||r?.validationId!==s.sourceValidationId)throw Error('QUOTE_INTEGRITY_INVALID');
 const roles:Record<string,string>={customer_eligibility:'customer',product_resolution:'product',uom_resolution:'uom',uom_conversion:'uom_conversion',customer_price:'price',warehouse_stock:'stock',order_history:'order_history',warehouse:'warehouse',draft_delivery:'delivery'};const ev=new Map<string,any>();
 for(const id of ids){const e=db.prepare('SELECT * FROM erp_evidence WHERE id=?').get(id) as any;if(!e||e.source_version!=='v2-erp-sql-1'||ev.has(id)||!db.prepare('SELECT 1 FROM grounding_provenance_links WHERE evidence_id=? AND account_id=? AND conversation_id=? AND customer_id=? AND draft_id=? AND draft_revision=? AND quotation_id=?').get(id,accountId,conversationId,q.customer_id,s.sourceDraftId,s.sourceDraftRevision,q.id))throw Error('QUOTE_INTEGRITY_INVALID');ev.set(id,e)}
 const lines=db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no').all(q.id) as any[];if(lines.length!==s.lines.length||lines.length!==r.data.lines.length||!lines.length)throw Error('QUOTE_INTEGRITY_INVALID');
 lines.forEach((l,i)=>{const x=s.lines[i],vline=r.data.lines[i];if(vline.lineNo!==l.row_item_no||vline.productId!==l.product_id||vline.stockCode!==l.stock_code||vline.description!==l.stock_description||String(vline.quantity)!==String(l.quantity)||vline.requestedUom!==l.uom||vline.unitPriceCents!==l.unit_price_cents||vline.subtotalCents!==l.subtotal_cents||x.rowItemNo!==l.row_item_no||x.productId!==l.product_id||x.stockCode!==l.stock_code||x.description!==l.stock_description||x.rowItemRemark!==l.row_item_remark||String(x.quantity)!==String(l.quantity)||x.uom!==l.uom||x.unitPriceCents!==l.unit_price_cents||x.subtotalCents!==l.subtotal_cents)throw Error('QUOTE_INTEGRITY_INVALID');const b=db.prepare('SELECT evidence_id,role FROM quotation_line_evidence WHERE quotation_line_id=?').all(l.id) as any[];if(b.length!==ids.length||b.some(z=>!ev.has(z.evidence_id)||roles[ev.get(z.evidence_id).evidence_type]!==z.role)||ids.some(id=>!b.some(z=>z.evidence_id===id)))throw Error('QUOTE_INTEGRITY_INVALID')});return s;
}
export class CommerceService{
 readonly database:V1Database; private readonly db:Database.Database; private adapter?:WhatsAppChannelAdapter; private erp:DemoErpAdapter; private readonly conversationLocks=new Map<string,Promise<void>>();
 readonly outbound: OutboundMessageService;
 constructor(database=new V1Database(':memory:'),adapter?:WhatsAppChannelAdapter,private readonly verifyStaffCapability:VerifyStaffCapability=()=>undefined,private readonly semanticAgentFactory:OrderSemanticAgentFactory=(handler,onEvent)=>new PiOrderAgent(handler,onEvent)){this.database=database;this.db=database.db;this.adapter=adapter;this.erp=new DemoErpAdapter(this.db);this.commitmentGuard=new CommitmentGuard(this.db);this.outbound=new OutboundMessageService(database,adapter,input=>this.finalizeQuotationSubmission(input),(q,accountId,conversationId)=>{this.verifyAcceptedQuotationIntegrity(q,accountId,conversationId);});}
 private readonly commitmentGuard: CommitmentGuard;
 setAdapter(a:WhatsAppChannelAdapter){this.adapter=a;this.outbound.setAdapter(a)} setCrashAfterSubmittedBeforeFinalize(v=true){this.outbound.setCrashAfterSubmittedBeforeFinalize(v)}
 resetAndSeed(){this.database.resetAndSeed()} ensureSeeded(){this.database.ensureSeeded()}
 private audit(c:string,actor:string,text:string){this.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?,?)').run(uuid(),'CONVERSATION',c,'ACTIVITY',actor,null,null,now(),JSON.stringify({text}));if(actor==='Customer'&&text==='Explicit acceptance recorded.'){const q=this.db.prepare("SELECT * FROM quotations WHERE source_conversation_id=? AND status='ACCEPTED' ORDER BY rowid DESC LIMIT 1").get(c) as any;const account=(this.db.prepare('SELECT channel_account_id FROM conversations WHERE id=?').get(c) as any)?.channel_account_id;if(q&&account&&!this.db.prepare("SELECT 1 FROM commercial_integrity_seals WHERE entity_type='ACCEPTANCE' AND entity_id=(SELECT id FROM quotation_acceptances WHERE quotation_id=? )").get(q.id))this.sealAccepted(q,account,c)}}
 private channelDestination(c:string){return this.db.prepare('SELECT channel_account_id,external_conversation_id FROM conversations WHERE id=?').get(c) as any}
 private outMessage(c:string,t:string){const destination=this.channelDestination(c);if(!destination)return;const externalMessageId='ai-'+uuid();this.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)').run(uuid(),c,externalMessageId,'OUTBOUND','text',t,destination.channel_account_id,now());this.audit(c,'AI Employee',t);if((this.adapter as any)?.unofficial)void this.outbound.send({accountId:destination.channel_account_id,clientMessageId:externalMessageId,conversationId:destination.external_conversation_id,text:t}).catch(()=>undefined);}
 private clarify(c:string,t:string){this.outMessage(c,t)}
 private normalizeRequestedLines(lines:InterpretedOrderLine[]|undefined){
  if(!lines?.length)throw Error('ORDER_LINES_REQUIRED');
  return lines.map(line=>{
   const query=String(line.query??'').trim();const uom=String(line.uom??'').trim().toUpperCase();const quantity=Number(line.quantity);
   if(!query||!uom||!Number.isFinite(quantity)||quantity<=0||Math.abs(quantity*1000-Math.round(quantity*1000))>1e-9)throw Error('ORDER_LINE_INVALID');
   return {query,quantity,uom,rowItemRemark:line.rowItemRemark?.trim()||undefined};
  });
 }
 private makePendingOrder(c:string,m:IncomingChannelMessage,customerId:string,intent:OrderIntentResult):PendingOrder{
  const lines=this.normalizeRequestedLines(intent.lines);
  const requestedDeliveryDate=String(intent.requestedDeliveryDate??'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(requestedDeliveryDate)||Number.isNaN(Date.parse(`${requestedDeliveryDate}T00:00:00Z`)))throw Error('DELIVERY_DATE_REQUIRED');
  return {customerId,accountId:m.accountId,sourceMessageId:m.externalMessageId,senderExternalId:m.sender.externalId,requestedDeliveryDate,lines};
 }
 private savePendingOrder(c:string,pending:PendingOrder){
  this.db.transaction(()=>{this.db.prepare("DELETE FROM customer_order_memory WHERE customer_id=? AND memory_type='pending_order' AND key_text=?").run(pending.customerId,c);this.db.prepare('INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)').run(uuid(),pending.customerId,'pending_order',c,JSON.stringify(pending),1,pending.sourceMessageId,now())})();
 }
 private loadPendingOrder(c:string,customerId:string):PendingOrder|undefined{
  const row=this.db.prepare("SELECT value_json FROM customer_order_memory WHERE customer_id=? AND memory_type='pending_order' AND key_text=? ORDER BY rowid DESC LIMIT 1").get(customerId,c) as any;
  if(!row)return undefined;try{return JSON.parse(row.value_json) as PendingOrder}catch{return undefined}
 }
 private clearPendingOrder(c:string,customerId:string){this.db.prepare("DELETE FROM customer_order_memory WHERE customer_id=? AND memory_type='pending_order' AND key_text=?").run(customerId,c)}
 private async loggedErpCall<T extends Evidence|Evidence[]>(agentRunId:string,name:string,input:Record<string,unknown>,call:(toolCallId:string)=>Promise<T>):Promise<T>{
  const toolCallId=uuid();
  try{const result=await call(toolCallId);this.db.prepare('INSERT INTO agent_tool_calls VALUES(?,?,?,?,?,?,?)').run(toolCallId,agentRunId,name,JSON.stringify(input),JSON.stringify(result),'SUCCEEDED',now());return result}
  catch(error){this.db.prepare('INSERT INTO agent_tool_calls VALUES(?,?,?,?,?,?,?)').run(toolCallId,agentRunId,name,JSON.stringify(input),JSON.stringify({error:(error as Error).message}),'FAILED',now());throw error}
 }
 private async resolveOrder(pending:PendingOrder,agentRunId:string):Promise<ResolvedOrder>{
  const customer=await this.loggedErpCall(agentRunId,'resolve_customer',{accountId:pending.accountId,sender:pending.senderExternalId},id=>this.erp.resolveCustomer(pending.senderExternalId,pending.sourceMessageId,pending.accountId,id));
  if(customer.output.customerId!==pending.customerId)throw Error('CUSTOMER_EVIDENCE_MISMATCH');
  const history=(await this.loggedErpCall(agentRunId,'get_recent_orders',{customerId:pending.customerId,limit:5},id=>this.erp.getRecentOrders(pending.customerId,5,id)))[0];
  const date=now().slice(0,10);const lines:ResolvedOrder['lines']=[];
  for(const request of pending.lines){
   const products=await this.loggedErpCall(agentRunId,'search_products',{customerId:pending.customerId,query:request.query},id=>this.erp.searchProducts(pending.customerId,request.query,id));if(products.length!==1)throw Error('PRODUCT_AMBIGUOUS');const product=products[0];
   const productId=String(product.output.productId),baseUom=String(product.output.baseUom);
   const uom=await this.loggedErpCall(agentRunId,'resolve_uom',{productId,expression:request.uom},id=>this.erp.resolveUom(productId,request.uom,id));
   const conversion=await this.loggedErpCall(agentRunId,'convert_uom',{productId,quantity:request.quantity,fromUom:request.uom,toUom:baseUom},id=>this.erp.convertUom(productId,request.quantity,request.uom,baseUom,id));
   const price=await this.loggedErpCall(agentRunId,'get_customer_price',{customerId:pending.customerId,productId,quantity:request.quantity,uom:request.uom,date},id=>this.erp.getCustomerPrice(pending.customerId,productId,request.quantity,request.uom,date,id));
   const stock=await this.loggedErpCall(agentRunId,'check_stock',{productId,warehouseId:String(customer.output.warehouseId),quantity:request.quantity,uom:request.uom},id=>this.erp.checkStock(productId,String(customer.output.warehouseId),request.quantity,request.uom,id));
   const unitPriceCents=Number(price.output.unitPriceCents),subtotalCents=Math.round(request.quantity*unitPriceCents);lines.push({request,product,uom,conversion,price,stock,unitPriceCents,subtotalCents});
  }
  return {customer,history,lines};
 }
 private async withConversationLock<T>(key:string,operation:()=>Promise<T>):Promise<T>{
  const previous=this.conversationLocks.get(key)??Promise.resolve();
  const run=previous.catch(()=>undefined).then(operation);
  const tail=run.then(()=>undefined,()=>undefined);
  this.conversationLocks.set(key,tail);
  try{return await run}finally{if(this.conversationLocks.get(key)===tail)this.conversationLocks.delete(key)}
 }
 async inbound(m:IncomingChannelMessage){return this.withConversationLock(`${m.accountId}|${m.conversationId}`,()=>this.inboundUnlocked(m,false))}
 /** Explicit rollback replay of an already canonicalized inbound; it never inserts a second message. */
 async inboundCanonicalReplay(m:IncomingChannelMessage){return this.withConversationLock(`${m.accountId}|${m.conversationId}`,()=>this.inboundUnlocked(m,true))}
 private async inboundUnlocked(m:IncomingChannelMessage, replay=false){
  const duplicate=this.db.prepare('SELECT conversation_id FROM messages WHERE account_id=? AND external_message_id=?').get(m.accountId,m.externalMessageId) as any;
  if(duplicate&&!replay)return this.state(duplicate.conversation_id);

  let conversation=this.db.prepare('SELECT * FROM conversations WHERE id=? AND channel_account_id=?').get(m.conversationId,m.accountId) as any;
  if(!conversation)conversation=this.db.prepare('SELECT * FROM conversations WHERE channel_account_id=? AND external_conversation_id=?').get(m.accountId,m.conversationId) as any;

  const resolvedCustomerId=resolveVerifiedCustomerId(this.db,m);
  // An existing conversation never changes customer from sender/config alone.
  const identity=resolvedCustomerId&&(!conversation?.customer_id||conversation.customer_id===resolvedCustomerId)
    ? this.db.prepare('SELECT c.*,i.external_id,i.phone FROM customer_channel_identities i JOIN customers c ON c.id=i.customer_id WHERE i.channel_account_id=? AND i.external_id=? AND i.customer_id=?').get(m.accountId,m.sender.externalId,resolvedCustomerId) as any
    : undefined;

  if(!conversation){
    const id=`conv-${createHash('sha256').update(`${m.accountId}|${m.conversationId}`).digest('hex').slice(0,24)}`;
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)').run(id,m.accountId,m.conversationId,identity?.id??null,'OPEN',m.occurredAt);
    conversation=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as any;
  } else if(!conversation.customer_id&&identity){
    this.db.prepare('UPDATE conversations SET customer_id=? WHERE id=? AND customer_id IS NULL').run(identity.id,conversation.id);
    conversation={...conversation,customer_id:identity.id};
  }

  const canonicalConversationId=conversation.id;
  m={...m,conversationId:canonicalConversationId};
  if(!replay)this.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,reply_to_external_message_id,account_id,occurred_at,raw_ref,forwarding_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(uuid(),canonicalConversationId,m.externalMessageId,'INBOUND',m.type,m.text??null,m.sender.externalId,m.sender.phone??null,m.replyToExternalMessageId??null,m.accountId,m.occurredAt,m.media?.externalRef??null,m.forwarding?JSON.stringify(m.forwarding):null);
  this.db.prepare('UPDATE conversations SET last_message_at=? WHERE id=?').run(m.occurredAt,canonicalConversationId);

  if(!identity){
    this.clarify(canonicalConversationId,'Please reply from the linked customer account so I can identify you.');
    return this.state(canonicalConversationId);
  }
  if(m.type!=='text'){
    this.clarify(canonicalConversationId,'I can’t interpret media yet. Please send the order details as text.');
    return this.state(canonicalConversationId);
  }

  const active=this.db.prepare("SELECT * FROM quotations WHERE source_conversation_id=? AND status='SENT'").get(canonicalConversationId) as any;
  if(active&&new Date(active.valid_until).getTime()<=Date.now()){
    this.db.prepare("UPDATE quotations SET status='EXPIRED' WHERE id=? AND status='SENT'").run(active.id);
    active.status='EXPIRED';
  }

  const runId=uuid();
  this.db.prepare('INSERT INTO agent_runs VALUES(?,?,?,?,?)').run(runId,canonicalConversationId,'RUNNING',now(),null);
  const agent=this.semanticAgentFactory(async (intent:OrderIntentResult)=>{
    if(intent.intent==='offer_quote'){
      let pending:PendingOrder;
      try{pending=this.makePendingOrder(canonicalConversationId,m,identity.id,intent)}catch(error){this.clarify(canonicalConversationId,(error as Error).message==='DELIVERY_DATE_REQUIRED'?'Please provide the requested delivery date before I prepare a quotation.':'Please provide clear product, quantity and UOM details.');return {intent:'clarify'}}
      try{
        const resolved=await this.resolveOrder(pending,runId);const unavailable=resolved.lines.filter(line=>!Boolean(line.stock.output.available));
        if(unavailable.length){this.audit(canonicalConversationId,'ERP',`Stock shortage detected for ${unavailable.map(line=>String(line.product.output.stockCode)).join(', ')}.`);this.clarify(canonicalConversationId,'Some requested stock is currently short. Please adjust the order before I prepare a quotation.');return {intent:'clarify'}}
        this.savePendingOrder(canonicalConversationId,pending);
        this.audit(canonicalConversationId,'AI Employee',`Customer identified: ${String(resolved.customer.output.name)}.`);
        const orders=(resolved.history.output.orders as any[]|undefined)??[];if(orders[0])this.audit(canonicalConversationId,'ERP',`Previous order found: ${orders[0].salesOrderNo}.`);
        this.audit(canonicalConversationId,'ERP',`Validated ${resolved.lines.length} requested line(s): product, UOM, customer price and stock evidence are deterministic.`);
        if(active)await this.createQuote(canonicalConversationId,pending,runId);else this.clarify(canonicalConversationId,'Stock is available. Shall I prepare a quotation?');
      }catch(error){this.audit(canonicalConversationId,'ERP',`Order intelligence failed closed: ${(error as Error).message}`);this.clarify(canonicalConversationId,'I could not resolve the order safely. Please clarify the product, quantity or UOM.');}
    } else if(intent.intent==='prepare_quote'){
      if(active)this.clarify(canonicalConversationId,'An active quotation exists. Please reply “OK confirm” to accept it.');
      else{const pending=this.loadPendingOrder(canonicalConversationId,identity.id);if(!pending)this.clarify(canonicalConversationId,'Please send the order details first so I can validate them against ERP.');else try{await this.createQuote(canonicalConversationId,pending,runId)}catch(error){if((error as Error).message==='OUTBOUND_RECONCILIATION_REQUIRED')this.clarify(canonicalConversationId,'A previous quotation send is still being reconciled. I will not send another quotation until it is resolved.');else throw error}}
    } else if(intent.intent==='accept_quote'){
      const messageId=commitmentMessageRef(this.db,m); const guard=messageId ? this.commitmentGuard.authorize(narrowCommitmentProposal({kind:'ACCEPT'},{accountId:m.accountId,conversationId:canonicalConversationId,inboundMessageId:messageId})) : undefined;
      const canonicalQuote=guard?.quoteRef?.id ? this.db.prepare('SELECT * FROM quotations WHERE id=?').get(guard.quoteRef.id) : undefined;
      if(guard?.outcome==='APPLIED'&&guard.reasonCode==='ACCEPTED'&&canonicalQuote)this.accept(m,canonicalQuote,guard);
      else this.clarify(canonicalConversationId,'Please explicitly confirm the active quotation with “OK confirm”.');
    } else if(intent.intent==='reject_quote'){
      const messageId=commitmentMessageRef(this.db,m); if(messageId)this.commitmentGuard.authorize(narrowCommitmentProposal({kind:'REJECT'},{accountId:m.accountId,conversationId:canonicalConversationId,inboundMessageId:messageId}));
    } else this.clarify(canonicalConversationId,'Please send a text order, or explicitly confirm the active quotation with “OK confirm”.');
    return {intent:intent.intent};
  }, event=>{
    if(event.type==='tool_execution_end')this.db.prepare('INSERT INTO agent_tool_calls VALUES(?,?,?,?,?,?,?)').run(uuid(),runId,event.toolName,JSON.stringify(event.result??{}),JSON.stringify(event.result??{}),'SUCCEEDED',now());
  });

  try{
    await agent.run(m.text??'');
    if(this.outbound.hasPending(canonicalConversationId))throw Error('INJECTED_CRASH_AFTER_SUBMITTED');
    this.db.prepare("UPDATE agent_runs SET status='SUCCEEDED',completed_at=? WHERE id=?").run(now(),runId);
  }catch(error){
    const message=(error as Error).message;
    this.db.prepare("UPDATE agent_runs SET status='FAILED',completed_at=? WHERE id=?").run(now(),runId);
    if(message==='INJECTED_CRASH_AFTER_SUBMITTED')throw error;
    this.audit(canonicalConversationId,'AI Employee',`Agent run failed safely: ${message}`);
    this.clarify(canonicalConversationId,'I could not safely interpret that request. Please clarify the order.');
  }
  if(this.outbound.hasPending(canonicalConversationId))throw Error('INJECTED_CRASH_AFTER_SUBMITTED');
  return this.state(canonicalConversationId);
 }
 private evidence(qline:string,e:Evidence,role:string,scope:{accountId:string;conversationId:string;customerId:string;quotationId:string}){const id=uuid(),inputJson=JSON.stringify(e.input),toolCallId=e.toolCallId;if(!toolCallId)throw Error('ERP_EVIDENCE_TOOL_CALL_REQUIRED');this.database.insertErpEvidence({id,evidenceType:e.type,toolCallId,lookupKey:sha(inputJson),inputJson,outputJson:JSON.stringify(e.output),observedAt:e.observedAt,sourceVersion:e.sourceVersion});this.db.prepare('INSERT INTO quotation_line_evidence VALUES(?,?,?)').run(qline,id,role);this.database.insertGroundingProvenance({evidenceId:id,...scope,linkType:'V1_QUOTATION',createdAt:now()})}
 private quotationSealPayload(quotationId:string,snapshotJson:string){return quotationCommercialSealPayload(this.db,quotationId,snapshotJson)}
 private verifyAcceptedQuotationIntegrity(q:any,accountId:string,conversationId:string){
  if(!q?.sent_snapshot_json||!q.sent_snapshot_hash||sha(q.sent_snapshot_json)!==q.sent_snapshot_hash)throw Error('QUOTE_INTEGRITY_INVALID');
  let marker:any;try{marker=JSON.parse(q.sent_snapshot_json)}catch{throw Error('QUOTE_INTEGRITY_INVALID')};if(marker?.sourceDraftId&&marker?.sourceValidationId)return verifyV2Quotation(this.db,q,accountId,conversationId,marker);
  const seal=this.db.prepare("SELECT * FROM commercial_integrity_seals WHERE entity_type='QUOTATION' AND entity_id=? AND account_id=? AND conversation_id=? AND customer_id=? AND lineage_id=?").get(q.id,accountId,conversationId,q.customer_id,q.id) as any;
  if(!seal||sha(seal.payload_json)!==seal.payload_hash||this.quotationSealPayload(q.id,q.sent_snapshot_json)!==seal.payload_json)throw Error('QUOTE_INTEGRITY_INVALID');
  const snapshot=JSON.parse(q.sent_snapshot_json) as any;
  if(snapshot.quotationNo!==q.quotation_no||snapshot.customerId!==q.customer_id||snapshot.warehouseId!==q.warehouse_id||snapshot.currency!==q.currency||snapshot.deliveryDate!==q.delivery_date||snapshot.remark!==q.remark||snapshot.subtotalCents!==q.subtotal_cents||snapshot.taxCents!==q.tax_cents||snapshot.grandTotalCents!==q.grand_total_cents||!Array.isArray(snapshot.lines))throw Error('QUOTE_INTEGRITY_INVALID');
  const lines=this.db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no').all(q.id) as any[];
  if(!lines.length||lines.length!==snapshot.lines.length)throw Error('QUOTE_INTEGRITY_INVALID');
  const requiredRoles:{[key:string]:string}={customer:'customer',product:'product',uom:'uom',uom_conversion:'uom_conversion',price:'price',stock:'stock',order_history:'order_history'};
  for(const [index,line] of lines.entries()){
   const frozen=snapshot.lines[index];
   if(frozen.rowItemNo!==line.row_item_no||frozen.productId!==line.product_id||frozen.stockCode!==line.stock_code||frozen.description!==line.stock_description||frozen.rowItemRemark!==line.row_item_remark||String(frozen.quantity)!==String(line.quantity)||frozen.uom!==line.uom||frozen.unitPriceCents!==line.unit_price_cents||frozen.subtotalCents!==line.subtotal_cents)throw Error('QUOTE_INTEGRITY_INVALID');
   const evidence=this.db.prepare(`SELECT qle.role,e.id,e.evidence_type,e.tool_call_id,e.lookup_key,e.input_json,e.output_json FROM quotation_line_evidence qle JOIN erp_evidence e ON e.id=qle.evidence_id WHERE qle.quotation_line_id=?`).all(line.id) as any[];
   for(const [role,type] of Object.entries(requiredRoles)){
    const rows=evidence.filter(row=>row.role===role&&row.evidence_type===type);
    if(rows.length!==1)throw Error('QUOTE_INTEGRITY_INVALID');
    const row=rows[0];
    const call=this.db.prepare("SELECT tool_name,input_json,output_json FROM agent_tool_calls WHERE id=? AND status='SUCCEEDED'").get(row.tool_call_id) as any;
    if(!call||row.lookup_key!==sha(row.input_json)||!this.db.prepare('SELECT 1 FROM grounding_provenance_links WHERE evidence_id=? AND account_id=? AND conversation_id=? AND customer_id=? AND quotation_id=?').get(row.id,accountId,conversationId,q.customer_id,q.id))throw Error('QUOTE_INTEGRITY_INVALID');
    let input:any,output:any,callInput:any,callOutput:any;
    try{input=JSON.parse(row.input_json);output=JSON.parse(row.output_json);callInput=JSON.parse(call.input_json);callOutput=JSON.parse(call.output_json)}catch{throw Error('QUOTE_INTEGRITY_INVALID')}
    const callEvidence=Array.isArray(callOutput)?callOutput.find((candidate:any)=>candidate?.toolCallId===row.tool_call_id):callOutput;
    if(JSON.stringify(input)!==JSON.stringify(callEvidence?.input)||JSON.stringify(output)!==JSON.stringify(callEvidence?.output)||callEvidence?.toolCallId!==row.tool_call_id||callEvidence?.type!==row.evidence_type||JSON.stringify(callInput)!==call.input_json)throw Error('QUOTE_INTEGRITY_INVALID');
    const expectedTool={customer:'resolve_customer',product:'search_products',uom:'resolve_uom',uom_conversion:'convert_uom',price:'get_customer_price',stock:'check_stock',order_history:'get_recent_orders'}[role];
    if(call.tool_name!==expectedTool)throw Error('QUOTE_INTEGRITY_INVALID');
    if(role==='customer'&&(!output.customerId||String(output.customerId)!==q.customer_id||String(output.warehouseId)!==String(q.warehouse_id))||role==='product'&&(!['productId','stockCode','description'].every(key=>String(output[key]??'')===String(line[key==='productId'?'product_id':key==='stockCode'?'stock_code':'stock_description']??'')))||role==='uom'&&(String(output.productId)!==String(line.product_id)||String(output.requestedUom)!==String(line.uom))||role==='uom_conversion'&&(String(output.productId)!==String(line.product_id)||String(output.fromUom)!==String(line.uom)||String(output.quantity)!==String(line.quantity))||role==='price'&&(String(output.customerId)!==q.customer_id||String(output.productId)!==String(line.product_id)||String(output.uom)!==String(line.uom)||Number(output.unitPriceCents)!==Number(line.unit_price_cents))||role==='stock'&&(String(output.productId)!==String(line.product_id)||String(output.warehouseId)!==String(q.warehouse_id)||String(output.uom)!==String(line.uom))||role==='order_history'&&String(input.customerId)!==q.customer_id)throw Error('QUOTE_INTEGRITY_INVALID');
    if(role==='price'&&(String(input.customerId)!==q.customer_id||String(input.productId)!==String(line.product_id)||String(input.uom)!==String(line.uom))||role==='stock'&&(String(input.productId)!==String(line.product_id)||String(input.warehouseId)!==String(q.warehouse_id)||String(input.uom)!==String(line.uom)))throw Error('QUOTE_INTEGRITY_INVALID');
  }
  return snapshot;
 }
 }
 private async createQuote(c:string,pending:PendingOrder,agentRunId:string){
  if(this.outbound.hasUnresolvedQuotation(c))throw Error('OUTBOUND_RECONCILIATION_REQUIRED');
  const resolved=await this.resolveOrder(pending,agentRunId);const unavailable=resolved.lines.filter(line=>!Boolean(line.stock.output.available));if(unavailable.length)throw Error('STOCK_SHORTAGE');
  const qid=uuid(),subtotal=resolved.lines.reduce((sum,line)=>sum+line.subtotalCents,0);let qno='',snapshotJson='';
  this.db.transaction(()=>{
    qno=this.database.takeDocumentNumber('quotation','QT');
    const quotationDate=now(),validUntil=new Date(Date.now()+604800000).toISOString();
    const snapshot={quotationNo:qno,quotationDate,validUntil,customerId:pending.customerId,customerName:resolved.customer.output.name,warehouseId:resolved.customer.output.warehouseId,currency:'SGD',deliveryDate:pending.requestedDeliveryDate,remark:null,lines:resolved.lines.map((line,index)=>({rowItemNo:index+1,productId:line.product.output.productId,stockCode:line.product.output.stockCode,description:line.product.output.description,rowItemRemark:line.request.rowItemRemark??null,quantity:line.request.quantity,uom:line.request.uom,unitPriceCents:line.unitPriceCents,subtotalCents:line.subtotalCents,availableBase:line.stock.output.availableBase,availableUom:Number(line.stock.output.availableBase)/Number(line.stock.output.factor??1)})),subtotalCents:subtotal,taxCents:0,grandTotalCents:subtotal};
    snapshotJson=JSON.stringify(snapshot);
    this.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,delivery_date,warehouse_id,remark,subtotal_cents,tax_cents,grand_total_cents,source_conversation_id,source_message_id,sent_snapshot_json,sent_snapshot_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(qid,qno,pending.customerId,'DRAFT','SGD',quotationDate,validUntil,pending.requestedDeliveryDate,resolved.customer.output.warehouseId,null,subtotal,0,subtotal,c,pending.sourceMessageId,snapshotJson,sha(snapshotJson));
    for(const [index,line] of resolved.lines.entries()){
      const lineId=uuid();this.db.prepare('INSERT INTO quotation_lines VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(lineId,qid,index+1,line.product.output.productId,line.product.output.stockCode,line.product.output.description,line.request.rowItemRemark??null,String(line.request.quantity),line.request.uom,line.unitPriceCents,line.subtotalCents);
      for(const [e,role] of [[resolved.customer,'customer'],[line.product,'product'],[line.uom,'uom'],[line.conversion,'uom_conversion'],[line.price,'price'],[line.stock,'stock'],[resolved.history,'order_history']] as [Evidence,string][])this.evidence(lineId,e,role,{accountId:pending.accountId,conversationId:c,customerId:pending.customerId,quotationId:qid});
    }
    const sealPayload=this.quotationSealPayload(qid,snapshotJson);this.database.insertCommercialIntegritySeal({entityType:'QUOTATION',entityId:qid,accountId:pending.accountId,conversationId:c,customerId:pending.customerId,lineageId:qid,payloadJson:sealPayload,payloadHash:sha(sealPayload),sealedAt:now()});
  })();
  this.audit(c,'AI Employee',`Quotation ${qno} prepared with immutable ERP evidence.`);
  const result=await this.sendQuoteUnlocked(qid);const status=(this.db.prepare('SELECT status FROM quotations WHERE id=?').get(qid) as any)?.status;if(status==='SENT')this.clearPendingOrder(c,pending.customerId);return result;
 }
 async sendQuote(qid:string){
  const q=this.db.prepare('SELECT id,source_conversation_id FROM quotations WHERE id=?').get(qid) as any;if(!q)throw Error('QUOTE_NOT_FOUND');
  return this.outbound.sendQuotation(qid);
 }
 private async sendQuoteUnlocked(qid:string){ return this.outbound.sendQuotation(qid); }
 private finalizeQuotationSubmission(input:{quotationId:string;outboundId:string;externalMessageId:string;submittedAt:string}){
  const q=this.db.prepare('SELECT * FROM quotations WHERE id=?').get(input.quotationId) as any;
  if(!q||q.status!=='DRAFT')throw Error('INVALID_QUOTE_TRANSITION');
  const old=this.db.prepare("SELECT * FROM quotations WHERE source_conversation_id=? AND status='SENT'").get(q.source_conversation_id) as any;
  if(old&&old.id!==q.id)this.db.prepare("UPDATE quotations SET status='SUPERSEDED',superseded_by_quotation_id=? WHERE id=? AND status='SENT'").run(q.id,old.id);
  const moved=this.db.prepare("UPDATE quotations SET status='SENT',sent_at=?,sent_outbound_message_id=? WHERE id=? AND status='DRAFT'").run(input.submittedAt,input.externalMessageId,q.id);if(moved.changes!==1)throw Error('INVALID_QUOTE_TRANSITION');
  const snapshot=JSON.parse(q.sent_snapshot_json) as any;
  const wi=this.db.prepare('SELECT * FROM work_items WHERE active_order_draft_id=? AND account_id=(SELECT channel_account_id FROM conversations WHERE id=?) AND conversation_id=?').get(snapshot.sourceDraftId,q.source_conversation_id,q.source_conversation_id) as any;
  if(wi)new WorkItemService(this.database).bindSentQuotation({workItemId:wi.id,accountId:wi.account_id,conversationId:wi.conversation_id,customerId:wi.customer_id,draftId:snapshot.sourceDraftId,quotationId:q.id,expectedRevision:wi.revision,idempotencyKey:`quote-sent:${q.id}`});
  this.audit(q.source_conversation_id,'AI Employee',`Quotation ${q.quotation_no} sent; prior quote superseded atomically.`);
 }
 async reconcileOutbound(){ return this.outbound.reconcile(); }
  private accept(m:IncomingChannelMessage,q:any,authorization?:any){const messageId=commitmentMessageRef(this.db,m);const guard=authorization??(messageId?this.commitmentGuard.authorize(narrowCommitmentProposal({kind:'ACCEPT'},{accountId:m.accountId,conversationId:m.conversationId,inboundMessageId:messageId})):undefined);if(!guard||guard.outcome!=='APPLIED'||guard.reasonCode!=='ACCEPTED'||!messageId)return;const canonicalQuote=this.db.prepare('SELECT * FROM quotations WHERE id=?').get(guard.quoteRef?.id) as any;if(!canonicalQuote||canonicalQuote.status!=='SENT')return;commitAcceptedQuotation({db:this.db,quotationId:canonicalQuote.id,inboundMessageId:messageId,verifyQuotationIntegrity:(quote,accountId,conversationId)=>this.verifyAcceptedQuotationIntegrity(quote,accountId,conversationId),audit:(conversationId,actor,text)=>this.audit(conversationId,actor,text)});}
 public acceptV2(inboundMessageId:string){const row=this.db.prepare("SELECT * FROM messages WHERE id=? AND direction='INBOUND'").get(inboundMessageId) as any;if(!row)throw Error('INBOUND_NOT_PERSISTED');this.accept({channel:'whatsapp',accountId:row.account_id,conversationId:row.conversation_id,externalMessageId:row.external_message_id,sender:{externalId:row.sender_external_id,phone:row.sender_phone},type:row.message_type,text:row.text,occurredAt:row.occurred_at,replyToExternalMessageId:row.reply_to_external_message_id} as IncomingChannelMessage,undefined);}
  private sealAccepted(q:any,accountId:string,conversationId:string){const acceptance=this.db.prepare('SELECT * FROM quotation_acceptances WHERE quotation_id=?').get(q.id) as any;const so=this.db.prepare('SELECT * FROM sales_orders WHERE source_quotation_id=?').get(q.id) as any;if(!acceptance||!so)return;const aPayload=JSON.stringify({quotationId:q.id,messageId:acceptance.message_id,senderExternalId:acceptance.sender_external_id,acceptedAt:acceptance.accepted_at,evidenceJson:acceptance.evidence_json});this.database.insertCommercialIntegritySeal({entityType:'ACCEPTANCE',entityId:acceptance.id,accountId,conversationId,customerId:q.customer_id,lineageId:q.id,payloadJson:aPayload,payloadHash:sha(aPayload),sealedAt:acceptance.accepted_at});const sPayload=JSON.stringify({quotationId:q.id,customerId:so.customer_id,currency:so.currency,deliveryDate:so.delivery_date,warehouseId:so.warehouse_id,remark:so.remark,subtotalCents:so.subtotal_cents,taxCents:so.tax_cents,grandTotalCents:so.grand_total_cents,lines:this.db.prepare('SELECT * FROM sales_order_lines WHERE sales_order_id=? ORDER BY row_item_no').all(so.id)});this.database.insertCommercialIntegritySeal({entityType:'SALES_ORDER',entityId:so.id,accountId,conversationId,customerId:so.customer_id,lineageId:q.id,payloadJson:sPayload,payloadHash:sha(sPayload),sealedAt:acceptance.accepted_at})}
 staff(action:'post'|'confirm'|'do',capability:unknown,key:string,doubleConfirmationEvidence:string|undefined,salesOrderNo:string){
  const staffSubject=this.verifyStaffCapability(capability);if(!staffSubject)throw Error('STAFF_AUTH_REQUIRED');
  if(!salesOrderNo?.trim())throw Error('SALES_ORDER_REQUIRED');
  const so=this.db.prepare("SELECT * FROM sales_orders WHERE sales_order_no=? AND status IN ('DRAFT','POSTED','CONFIRMED','DO_READY')").get(salesOrderNo) as any;
  if(!so)throw Error('NO_DRAFT');
  const prior=this.db.prepare('SELECT * FROM staff_actions WHERE sales_order_id=? AND action_type=? AND staff_post_idempotency_key=?').get(so.id,action,key);
  if(prior)return this.db.prepare('SELECT * FROM sales_orders WHERE id=?').get(so.id);
  if(action==='post'&&(!doubleConfirmationEvidence||!doubleConfirmationEvidence.trim()))throw Error('DOUBLE_CONFIRMATION_REQUIRED');

  this.db.transaction(()=>{
    if(action==='post'){
      if(so.status!=='DRAFT')throw Error('INVALID_TRANSITION');
      const lines=this.db.prepare('SELECT * FROM sales_order_lines WHERE sales_order_id=? ORDER BY product_id,row_item_no').all(so.id) as any[];
      const required=new Map<string,number>();
      for(const line of lines){
        const conversion=this.db.prepare('SELECT factor FROM product_uom_conversions WHERE product_id=? AND from_uom=? AND to_uom=(SELECT base_uom FROM products WHERE id=?)').get(line.product_id,line.uom,line.product_id) as any;
        const factor=conversion?Number(conversion.factor):1;
        const need=Number(line.quantity)*factor;
        required.set(line.product_id,(required.get(line.product_id)??0)+need);
      }
      for(const [productId,need] of [...required.entries()].sort(([a],[b])=>a.localeCompare(b))){
        const stock=this.db.prepare('SELECT quantity_base FROM stock_balances WHERE product_id=? AND warehouse_id=?').get(productId,so.warehouse_id) as any;
        if(!stock||Number(stock.quantity_base)<need)throw Error('STOCK_SHORTAGE');
      }
      for(const [productId,need] of [...required.entries()].sort(([a],[b])=>a.localeCompare(b))){
        this.db.prepare('UPDATE stock_balances SET quantity_base=quantity_base-? WHERE product_id=? AND warehouse_id=?').run(need,productId,so.warehouse_id);
      }
      this.db.prepare("UPDATE sales_orders SET status='POSTED',posted_at=? WHERE id=?").run(now(),so.id);
    }else if(action==='confirm'){
      if(so.status!=='POSTED')throw Error('INVALID_TRANSITION');
      this.db.prepare("UPDATE sales_orders SET status='CONFIRMED',confirmed_at=? WHERE id=?").run(now(),so.id);
    }else{
      if(so.status!=='CONFIRMED')throw Error('INVALID_TRANSITION');
      this.db.prepare("UPDATE sales_orders SET status='DO_READY' WHERE id=?").run(so.id);
    }
    this.db.prepare('INSERT INTO staff_actions VALUES(?,?,?,?,?,?,?,?)').run(uuid(),so.id,action,staffSubject,action==='post'?now():null,action==='post'?doubleConfirmationEvidence:'staff-evidence',now(),key);
    const source=this.db.prepare('SELECT source_conversation_id FROM quotations WHERE id=?').get(so.source_quotation_id) as any;
    this.audit(source?.source_conversation_id??'conv-001','Staff',`Staff action ${action.toUpperCase()} completed.`);
  })();
  return this.db.prepare('SELECT * FROM sales_orders WHERE id=?').get(so.id);
 }
 latestConversationId(){return (this.db.prepare('SELECT conversation_id FROM messages ORDER BY rowid DESC LIMIT 1').get() as any)?.conversation_id??'conv-001'}
 state(c='conv-001'):CommerceState{
  const customer=this.db.prepare('SELECT cu.name,ci.phone FROM conversations co LEFT JOIN customers cu ON cu.id=co.customer_id LEFT JOIN customer_channel_identities ci ON ci.customer_id=cu.id AND ci.channel_account_id=co.channel_account_id WHERE co.id=?').get(c) as any;
  const messages=(this.db.prepare('SELECT direction,text FROM messages WHERE conversation_id=? ORDER BY rowid').all(c) as any[]).map(x=>({from:x.direction==='INBOUND'?'customer':'ai',text:String(x.text??'')}));
  const q=this.db.prepare('SELECT * FROM quotations WHERE source_conversation_id=? ORDER BY rowid DESC LIMIT 1').get(c) as any;
  const so=q&&this.db.prepare('SELECT * FROM sales_orders WHERE source_quotation_id=?').get(q.id) as any;
  const acceptance=q&&this.db.prepare('SELECT qa.accepted_at,m.external_message_id,m.text FROM quotation_acceptances qa JOIN messages m ON m.id=qa.message_id WHERE qa.quotation_id=?').get(q.id) as any;
  const timeline=projectTimeline(this.db,c);
  const accountId=(this.db.prepare('SELECT channel_account_id FROM conversations WHERE id=?').get(c) as {channel_account_id?:string}|undefined)?.channel_account_id??'demo-account';
  const uiState=projectUiState(this.db,accountId,c);
  // Keep the V1 field shape, but make it the same safe projection used by the
  // operational timeline. Audit payload text is never a UI data source.
  const activities=(this.db.prepare("SELECT actor_type,payload_json,occurred_at FROM audit_events WHERE entity_type='CONVERSATION' AND entity_id=? ORDER BY rowid").all(c) as any[]).map(x=>{const projection=projectAudit(x.actor_type,x.payload_json);return {actor:projection.actor,text:projection.detail?`${projection.label}: ${projection.detail}`:projection.label,at:x.occurred_at}});
  const snapshot=q?.sent_snapshot_json?JSON.parse(q.sent_snapshot_json):undefined;
  const lines=q?(this.db.prepare('SELECT * FROM quotation_lines WHERE quotation_id=? ORDER BY row_item_no').all(q.id) as any[]).map((line,index)=>{
    const frozen=snapshot?.lines?.[index];
    return {rowItemNo:line.row_item_no,stockCode:line.stock_code,description:line.stock_description,rowItemRemark:line.row_item_remark??'—',quantity:Number(line.quantity),uom:line.uom,unitPrice:line.unit_price_cents/100,subtotal:line.subtotal_cents/100,available:frozen?.availableUom??null,availableStock:frozen?.availableUom??null};
  }):[];
  return {id:c,customer:customer?.name??'',phone:customer?.phone??'',messages,activities,timeline,uiState,quote:q?{no:q.quotation_no,status:q.status,lines,total:q.grand_total_cents/100,deliveryDate:q.delivery_date,sourceMessageId:q.source_message_id}:undefined,so:so?{no:so.sales_order_no,status:so.status,quoteNo:q.quotation_no,total:so.grand_total_cents/100,deliveryDate:so.delivery_date,acceptanceEvidence:acceptance?{text:String(acceptance.text??''),externalMessageId:acceptance.external_message_id,acceptedAt:acceptance.accepted_at}:undefined}:undefined,connection:(this.adapter as any)?.unofficial?'whatsapp-qr':'simulated',staffActions:so?this.db.prepare('SELECT action_type,occurred_at,evidence_ref FROM staff_actions WHERE sales_order_id=?').all(so.id):[]};
 }
}
