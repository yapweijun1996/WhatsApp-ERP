import type Database from 'better-sqlite3';
import {listCapabilities} from './v2-capability-registry.js';
import {ContextProjectionService,redactContextText} from './v2-context-projection.js';
import {EmployeeProfileResolver,INITIAL_SALES_PROFILE_ID} from './v2-employee-profile.js';
import {buildGroundingReferenceProjection} from './v2-grounding-references.js';
import {authoritativeFreshnessFingerprint} from './v2-freshness.js';

export const MAX_AGENT_CONTEXT_CHARS=65_536;
export type AgentContextInput={turnId:string;accountId:string;conversationId:string;inboundMessageId:string;profileId?:string;nowIso:string;timezone:string};

function fail(code:string):never{throw new Error(`AGENT_CONTEXT_INVALID:${code}`)}
function text(v:unknown,code:string,max=512){if(typeof v!=='string'||v.trim().length===0||v.length>max)fail(code);return v}
function safe(v:string,max=2000){const r=redactContextText(v);return r.length<=max?r:r.slice(0,max)}
function deepFreeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v as Record<string,unknown>))deepFreeze(child);if(!Object.isFrozen(v))Object.freeze(v)}return v}
function clone<T>(v:T):T{return JSON.parse(JSON.stringify(v)) as T}
function validTime(iso:string,timezone:string){
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(iso);
 if(!match||!Number.isFinite(Date.parse(iso)))fail('CURRENT_TIME');
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]);
 if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)fail('CURRENT_TIME');
 try{new Intl.DateTimeFormat('en-SG',{timeZone:timezone}).format(new Date(iso))}catch{fail('TIMEZONE')}
}

export class AgentContextBuilder{
 private readonly projection:ContextProjectionService;private readonly profiles:EmployeeProfileResolver;
 constructor(private readonly db:Database.Database){this.projection=new ContextProjectionService(db);this.profiles=new EmployeeProfileResolver(db)}
 build(input:AgentContextInput){
  const turnId=text(input.turnId,'TURN_ID',160),accountId=text(input.accountId,'ACCOUNT_ID',160),conversationId=text(input.conversationId,'CONVERSATION_ID',160),inboundMessageId=text(input.inboundMessageId,'INBOUND_MESSAGE_ID',160),nowIso=text(input.nowIso,'NOW',80),timezone=text(input.timezone,'TIMEZONE',120);validTime(nowIso,timezone);
  return this.db.transaction(()=>{
   const inbound=this.db.prepare("SELECT id,occurred_at FROM messages WHERE id=? AND account_id=? AND conversation_id=? AND direction='INBOUND'").get(inboundMessageId,accountId,conversationId) as {id:string;occurred_at:string}|undefined;if(!inbound)fail('INBOUND_MESSAGE_SCOPE');
   const profile=input.profileId===undefined?this.profiles.resolve():this.profiles.resolve(input.profileId),transcript=this.projection.recentTranscript(accountId,conversationId,inboundMessageId),summary=this.projection.latestSummary(accountId,conversationId),state=this.projection.authoritativeState(accountId,conversationId);
   if(state.workspace.workItem?.activeQuotationId&&state.workspace.workItem.activeQuotationId!==state.canonicalCommerce.quotation?.id)fail('WORK_ITEM_QUOTATION_POINTER');
   const permissionSet=new Set(profile.permissions);const availableCapabilities=listCapabilities().filter(c=>permissionSet.has(c.permission.identifier)).map(c=>deepFreeze({name:c.name,version:c.version,purpose:c.name,inputSchema:clone(c.inputSchema),sideEffect:c.sideEffect,timeoutMs:c.timeout.perCallMs,idempotencyRequired:c.idempotency.required,outboundDisposition:c.outbound.disposition,evidenceMode:c.evidence.mode,groundingMode:c.grounding.mode}));
   const recentTranscript=deepFreeze({...transcript,messages:transcript.messages.map(m=>deepFreeze({...m,text:safe(m.text,1000)}))});
   const conversationSummary=summary?deepFreeze({...summary,summaryText:safe(summary.summaryText,4000)}):null;
   const work=state.workspace.workItem;const activeWorkItem=work?deepFreeze({...work,authoritativeForCommerce:false as const,untrustedAsInstruction:true as const,source:'WORK_ITEM' as const,goalSummary:safe(work.goalSummary,1000),blockingReason:work.blockingReason?safe(work.blockingReason,512):null}):null;
   const customer=state.customer;const customerContext=customer?deepFreeze({...customer,code:safe(customer.code,512),name:safe(customer.name,1000),currency:safe(customer.currency,80),creditStatus:customer.creditStatus?safe(customer.creditStatus,120):null,warehouseId:customer.warehouseId?safe(customer.warehouseId,160):null}):null;
   const unresolvedQuestions=activeWorkItem&&(activeWorkItem.state==='NEEDS_CLARIFICATION'||activeWorkItem.blockingReason)?[deepFreeze({source:'WORK_ITEM' as const,reasonCode:activeWorkItem.blockingReason??'NEEDS_CLARIFICATION',untrustedAsInstruction:true as const})]:[];
   const groundingReferences=buildGroundingReferenceProjection(this.db,accountId,conversationId);
   const context=deepFreeze({
    turnId,accountId,conversationId,inboundMessageRef:{id:inbound.id,occurredAt:inbound.occurred_at},
    profile:{id:profile.id,version:profile.version,role:safe(profile.role,120),mission:safe(profile.mission,2000),tone:safe(profile.tone,240),languagePolicy:{mode:profile.languagePolicy.mode,fallbackLocale:safe(profile.languagePolicy.fallbackLocale,40)},permissions:[...profile.permissions].sort(),turnBudgets:clone(profile.turnBudgets),authority:'CONFIG_ONLY' as const},
    recentTranscript,conversationSummary,
    customerContext,
    activeWorkItem,orderDraft:state.workspace.draft,
    activeQuotationSalesOrder:state.canonicalCommerce,
    relevantErpEvidenceAndPolicies:{validation:state.validation,profilePolicies:{forbiddenCommitments:profile.forbiddenCommitments.map(x=>safe(x,512)),escalationRules:profile.escalationRules.map(x=>safe(x,512)),authority:'CONFIG_ONLY' as const}},
    groundingReferences,
    availableCapabilities,unresolvedQuestions,
    handoff:{active:activeWorkItem?.state==='HANDED_OFF',reasonCode:activeWorkItem?.state==='HANDED_OFF'?(activeWorkItem.blockingReason??'HANDED_OFF'):null},
    currentTime:{iso:nowIso,timezone},
    freshness:{builtAt:nowIso,summaryVersion:summary?.version??null,workItemRevision:state.workspace.workItem?.revision??null,draftRevision:state.workspace.draft?.revision??null,quotationId:state.canonicalCommerce.quotation?.id??null,salesOrderId:state.canonicalCommerce.salesOrder?.id??null,inboundMessageId,fingerprint:authoritativeFreshnessFingerprint(this.db,accountId,conversationId,profile.id)},
   });
   if(JSON.stringify(context).length>MAX_AGENT_CONTEXT_CHARS)fail('CONTEXT_SIZE');return context;
  })();
 }
}
