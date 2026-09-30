import type { CommerceService } from './commerce.js';
import type { ConversationService, EvidenceRef, QuotationService, ServiceResult, StaffCommitService } from './v2-domain-contracts.js';

type OutboundRow={id:string;status:string;last_error?:string|null;attempt_count:number;external_message_id?:string|null};
type QuoteRow={id:string;status:string;quotation_no:string;sent_outbound_message_id?:string|null};

function outboundEvidence(out:OutboundRow|undefined):EvidenceRef[]{return out?[{sourceId:out.id,sourceVersion:out.status}]:[]}
function quoteResult(q:QuoteRow|undefined,out:OutboundRow|undefined):ServiceResult<{id:string;status:string;quotationNo?:string}>{
  if(!q)return{status:'FAILED',evidence:outboundEvidence(out),stateChanges:[],reasonCode:'QUOTE_NOT_FOUND'};
  const data={id:q.id,status:q.status,quotationNo:q.quotation_no};
  if(q.status==='SENT'&&out?.status==='SUBMITTED')return{status:'SUCCEEDED',data,evidence:outboundEvidence(out),stateChanges:[{entity:'QUOTATION',to:'SENT',id:q.id}]};
  if(out?.status==='PENDING')return{status:'BLOCKED',data,evidence:outboundEvidence(out),stateChanges:[],reasonCode:'OUTBOUND_PENDING'};
  if(out?.status==='UNKNOWN')return{status:'BLOCKED',data,evidence:outboundEvidence(out),stateChanges:[],reasonCode:'OUTBOUND_RECONCILIATION_REQUIRED'};
  if(out?.status==='FAILED'&&String(out.last_error??'').startsWith('retryable:'))return{status:'RETRYABLE',data,evidence:outboundEvidence(out),stateChanges:[],reasonCode:'OUTBOUND_RETRYABLE_FAILURE',retryable:true};
  if(out?.status==='FAILED')return{status:'FAILED',data,evidence:outboundEvidence(out),stateChanges:[],reasonCode:'OUTBOUND_TERMINAL_FAILURE'};
  return{status:'BLOCKED',data,evidence:outboundEvidence(out),stateChanges:[],reasonCode:`QUOTE_NOT_SENT:${q.status}`};
}

/** Phase 0 exposes only V1 behavior that is genuinely delegated today. */
export type V1ServiceSeams={conversation:ConversationService;quotation:Pick<QuotationService,'send'|'reconcile'>;staffCommit:StaffCommitService};

export function createV1ServiceSeams(service:CommerceService):V1ServiceSeams{
  const latestOut=(qid:string)=>service.database.db.prepare('SELECT id,status,last_error,attempt_count,external_message_id FROM outbound_messages WHERE entity_id=? ORDER BY rowid DESC LIMIT 1').get(qid) as OutboundRow|undefined;
  const quote=(qid:string)=>service.database.db.prepare('SELECT id,status,quotation_no,sent_outbound_message_id FROM quotations WHERE id=?').get(qid) as QuoteRow|undefined;
  return{
    conversation:{receive:m=>service.inbound(m),read:async scope=>service.state(scope.conversationId)},
    quotation:{
      send:async id=>{try{const out=await service.sendQuote(id) as OutboundRow|undefined;return quoteResult(quote(id),out??latestOut(id))}catch(error){return{status:'FAILED',evidence:outboundEvidence(latestOut(id)),stateChanges:[],reasonCode:(error as Error).message}}},
      reconcile:async()=>{await service.reconcileOutbound();const unresolved=service.database.db.prepare("SELECT id,status,last_error,attempt_count,external_message_id FROM outbound_messages WHERE status IN ('PENDING','UNKNOWN') ORDER BY rowid LIMIT 1").get() as OutboundRow|undefined;if(unresolved)return{status:'BLOCKED',evidence:outboundEvidence(unresolved),stateChanges:[],reasonCode:'OUTBOUND_RECONCILIATION_REQUIRED'};const retryable=service.database.db.prepare("SELECT id,status,last_error,attempt_count,external_message_id FROM outbound_messages WHERE status='FAILED' AND last_error LIKE 'retryable:%' ORDER BY rowid DESC LIMIT 1").get() as OutboundRow|undefined;if(retryable)return{status:'RETRYABLE',evidence:outboundEvidence(retryable),stateChanges:[],reasonCode:'OUTBOUND_RETRYABLE_FAILURE',retryable:true};return{status:'SUCCEEDED',evidence:[],stateChanges:[]}}
    },
    staffCommit:{commit:async input=>service.staff(input.action,input.capability,input.idempotencyKey,input.evidence,input.salesOrderNo)}
  }
}
