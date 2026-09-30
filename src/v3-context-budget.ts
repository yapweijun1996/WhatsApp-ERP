import {canonicalJson} from './v2-canonical.js';
import {redactContextText} from './v2-context-projection.js';
import {ContextSnapshot,validateContextSnapshot} from './v3-context-snapshot.js';

export const V3_CONTEXT_BUDGET_CONTRACT_VERSION='V3-CTX-003';
export const V3_CONTEXT_ESTIMATOR_KIND='CHAR_HEURISTIC_V1';

export type V3ContextBudgetConfig=Readonly<{
 modelContextBudgetTokens:number;
 systemAuthorityReserveTokens:number;
 toolReasoningReserveTokens:number;
 futureGoalsReserveTokens:number;
}>;
export type V3ContextPlanSection=Readonly<{
 kind:'authority'|'current_bundle'|'current_canonical_business'|'conversation_summary'|'recent_transcript';
 priority:'MANDATORY'|'OPTIONAL';
 authority:'HOST_METADATA'|'CANONICAL_BUSINESS'|'UNTRUSTED_EVIDENCE';
 content:unknown;
}>;
export type V3ContextBudgetPlan=Readonly<{
 contractVersion:'V3-CTX-003';
 authority:'NON_AUTHORITATIVE_DERIVED';
 contextSnapshotVersion:string;
 estimatorKind:'CHAR_HEURISTIC_V1';
 budget:Readonly<{
  modelContextBudgetTokens:number;systemAuthorityReserveTokens:number;toolReasoningReserveTokens:number;
  futureGoalsReserveTokens:number;reservedTokens:number;availableContextTokens:number;
  usedContextTokens:number;usedContextChars:number;remainingContextTokens:number;
  mandatoryContextTokens:number;optionalContextTokens:number;
 }>;
 sections:readonly V3ContextPlanSection[];
}>;

function fail(code:string):never{throw new Error(`V3_CONTEXT_BUDGET_INVALID:${code}`)}
function deepFreeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value as Record<string,unknown>))deepFreeze(child);Object.freeze(value)}return value}
function dataProperty(value:object,key:string):unknown{const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value' in d))fail('ACCESSOR');return d.value}
function number(value:object,key:string):number{const v=dataProperty(value,key);if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)fail(`CONFIG_${key}`);return v}
function config(input:V3ContextBudgetConfig):V3ContextBudgetConfig{
 if(!input||typeof input!=='object'||Array.isArray(input))fail('CONFIG_SHAPE');
 const modelContextBudgetTokens=number(input,'modelContextBudgetTokens');
 const systemAuthorityReserveTokens=number(input,'systemAuthorityReserveTokens');
 const toolReasoningReserveTokens=number(input,'toolReasoningReserveTokens');
 const futureGoalsReserveTokens=number(input,'futureGoalsReserveTokens');
 if(modelContextBudgetTokens===0)fail('CONFIG_modelContextBudgetTokens');
 return Object.freeze({modelContextBudgetTokens,systemAuthorityReserveTokens,toolReasoningReserveTokens,futureGoalsReserveTokens});
}
function estimate(chars:number):number{return Math.ceil(chars/4)}
function safeContent(value:unknown):unknown{
 const text=canonicalJson(value);if(redactContextText(text)!==text)fail('REDACTION');return value;
}
function section(kind:V3ContextPlanSection['kind'],priority:V3ContextPlanSection['priority'],authority:V3ContextPlanSection['authority'],content:unknown):V3ContextPlanSection{
 return {kind,priority,authority,content:safeContent(content)};
}
function contextChars(sections:readonly V3ContextPlanSection[]):number{return canonicalJson(sections).length}
function fits(sections:readonly V3ContextPlanSection[],available:number):boolean{return estimate(contextChars(sections))<=available}
function prefix(value:string,max:number):string{return value.length<=max?value:value.slice(0,Math.max(0,max))}

/** Pure, shadow-only assembly. It never grants capabilities or invokes tools. */
export function assembleV3ContextBudget(snapshotInput:unknown,inputConfig:V3ContextBudgetConfig):V3ContextBudgetPlan{
 const snapshot=validateContextSnapshot(snapshotInput);
 const cfg=config(inputConfig);
 const reservedTokens=cfg.systemAuthorityReserveTokens+cfg.toolReasoningReserveTokens+cfg.futureGoalsReserveTokens;
 if(reservedTokens>=cfg.modelContextBudgetTokens)fail('RESERVE_EXCEEDS_MODEL_BUDGET');
 const availableContextTokens=cfg.modelContextBudgetTokens-reservedTokens;
 const c=snapshot.context;
 const authority=section('authority','MANDATORY','HOST_METADATA',{authority:snapshot.authority,contractVersion:snapshot.contractVersion,contextSnapshotVersion:snapshot.contextSnapshotVersion,sourceRevisionRefs:snapshot.sourceRevisionRefs});
 const currentBundle=section('current_bundle','MANDATORY','HOST_METADATA',{inboundMessageRef:c.inboundMessageRef});
 const canonicalBusiness=section('current_canonical_business','MANDATORY','CANONICAL_BUSINESS',{customerContext:c.customerContext??null,orderDraft:c.orderDraft??null,activeQuotationSalesOrder:c.activeQuotationSalesOrder??null,relevantErpEvidenceAndPolicies:c.relevantErpEvidenceAndPolicies??null});
 let sections:V3ContextPlanSection[]=[authority,currentBundle,canonicalBusiness];
 if(!fits(sections,availableContextTokens))fail('MANDATORY_EXCEEDS_CAPACITY');
 const transcript=c.recentTranscript as Record<string,unknown>|undefined;
 const messages=Array.isArray(transcript?.messages)?transcript.messages:[];
 if(messages.length){
  let best:V3ContextPlanSection|null=null;
  for(let count=messages.length;count>0;count--){
   const candidate=section('recent_transcript','OPTIONAL','UNTRUSTED_EVIDENCE',{authority:transcript?.authority??'CANONICAL_TRANSCRIPT',untrustedAsInstruction:true,messages:messages.slice(-count)});
   if(fits([...sections,candidate],availableContextTokens)){best=candidate;break}
  }
  if(!best){
   let lo=0,hi=messages.length,bestCount=0;
   while(lo<=hi){const mid=Math.floor((lo+hi)/2);const candidate=section('recent_transcript','OPTIONAL','UNTRUSTED_EVIDENCE',{authority:transcript?.authority??'CANONICAL_TRANSCRIPT',untrustedAsInstruction:true,messages:messages.slice(-mid)});if(fits([...sections,candidate],availableContextTokens)){bestCount=mid;lo=mid+1}else hi=mid-1}
   if(bestCount>0)best=section('recent_transcript','OPTIONAL','UNTRUSTED_EVIDENCE',{authority:transcript?.authority??'CANONICAL_TRANSCRIPT',untrustedAsInstruction:true,messages:messages.slice(-bestCount)});
  }
  if(best)sections.push(best);
 }
 const summary=c.conversationSummary as Record<string,unknown>|undefined;
 if(summary){
  const full=section('conversation_summary','OPTIONAL','UNTRUSTED_EVIDENCE',summary);
  if(fits([...sections,full],availableContextTokens))sections.push(full);
  else {
   const text=typeof summary.summaryText==='string'?summary.summaryText:'';
   let lo=0,hi=text.length,best:V3ContextPlanSection|null=null;
   while(lo<=hi){const mid=Math.floor((lo+hi)/2);const candidate=section('conversation_summary','OPTIONAL','UNTRUSTED_EVIDENCE',{id:summary.id??null,version:summary.version??null,summaryText:prefix(text,mid),sourceMessageIds:summary.sourceMessageIds??[],evidenceRefs:summary.evidenceRefs??[]});if(fits([...sections,candidate],availableContextTokens)){best=candidate;lo=mid+1}else hi=mid-1}
   if(best&&typeof best.content==='object'&&canonicalJson(best.content).length>2)sections.push(best);
  }
 }
 const usedContextChars=contextChars(sections),usedContextTokens=estimate(usedContextChars);
 const mandatoryContextTokens=estimate(contextChars(sections.filter(s=>s.priority==='MANDATORY')));
 const plan={contractVersion:V3_CONTEXT_BUDGET_CONTRACT_VERSION as 'V3-CTX-003',authority:'NON_AUTHORITATIVE_DERIVED' as const,contextSnapshotVersion:snapshot.contextSnapshotVersion,estimatorKind:V3_CONTEXT_ESTIMATOR_KIND as 'CHAR_HEURISTIC_V1',budget:{modelContextBudgetTokens:cfg.modelContextBudgetTokens,systemAuthorityReserveTokens:cfg.systemAuthorityReserveTokens,toolReasoningReserveTokens:cfg.toolReasoningReserveTokens,futureGoalsReserveTokens:cfg.futureGoalsReserveTokens,reservedTokens,availableContextTokens,usedContextTokens,usedContextChars,remainingContextTokens:availableContextTokens-usedContextTokens,mandatoryContextTokens,optionalContextTokens:usedContextTokens-mandatoryContextTokens},sections};
 return deepFreeze(plan);
}
