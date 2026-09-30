import {redactContextText} from './v2-context-projection.js';
import {canonicalJson,canonicalSha256} from './v2-canonical.js';

export const V3_CONTEXT_SNAPSHOT_CONTRACT_VERSION='V3-CTX-002';
export const V3_CONTEXT_SNAPSHOT_SCHEMA_VERSION=1;
export const MAX_V3_CONTEXT_SNAPSHOT_CHARS=65_536;

export type ContextSnapshotSourceRevisionRefs=Readonly<{
 turnId:string;accountId:string;conversationId:string;inboundMessageId:string;
 profileId:string;profileVersion:number;summaryVersion:number|null;workItemRevision:number|null;
 draftRevision:number|null;quotationId:string|null;salesOrderId:string|null;freshnessFingerprint:string;
}>;
export type ContextSnapshot=Readonly<{
 contractVersion:'V3-CTX-002';schemaVersion:1;contextSnapshotVersion:string;
 authority:'NON_AUTHORITATIVE_DERIVED';
 sourceRevisionRefs:ContextSnapshotSourceRevisionRefs;context:Readonly<Record<string,unknown>>;integrityHash:string;
}>;

function fail(code:string):never{throw new Error(`V3_CONTEXT_SNAPSHOT_INVALID:${code}`)}
function deepFreeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value as Record<string,unknown>))deepFreeze(child);Object.freeze(value)}return value}
function plainJson(value:unknown,redact=false,seen=new WeakSet<object>()):unknown{
 if(value===null||typeof value==='boolean'||typeof value==='number') {if(typeof value==='number'&&!Number.isFinite(value))fail('NUMBER');return value}
 if(typeof value==='string')return redact?redactContextText(value):value;
 if(typeof value!=='object'||seen.has(value))fail('PLAIN_JSON');
 seen.add(value);
 const isArray=Array.isArray(value);const proto=Object.getPrototypeOf(value);
 if((isArray&&proto!==Array.prototype)||(!isArray&&proto!==Object.prototype&&proto!==null))fail('PLAIN_JSON');
 const descriptors=Object.getOwnPropertyDescriptors(value);
 for(const descriptor of Object.values(descriptors))if(!('value' in descriptor))fail('PLAIN_JSON');
 if(isArray){
  const lengthDescriptor=descriptors.length;if(!lengthDescriptor||!('value' in lengthDescriptor)||typeof lengthDescriptor.value!=='number')fail('PLAIN_JSON');
  const result:unknown[]=new Array(lengthDescriptor.value);
  for(const key of Object.keys(value)){
   if(key==='length'||!/^\d+$/.test(key)||Number(key)>=lengthDescriptor.value)fail('PLAIN_JSON');
   result[Number(key)]=plainJson(descriptors[key].value,redact,seen);
  }
  seen.delete(value);return result;
 }
 const result:Record<string,unknown>={};for(const key of Object.keys(value)){const item=descriptors[key].value;if(item!==undefined)result[key]=plainJson(item,redact,seen)}seen.delete(value);return result;
}
function boundedRedacted(value:unknown):unknown{return plainJson(value,true)}
function requiredText(value:unknown,code:string):string{if(typeof value!=='string'||value.length===0||value.length>512)fail(code);return value}
function nullableRevision(value:unknown,code:string):number|null{if(value===null)return null;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)fail(code);return value}
function requiredRevision(value:unknown,code:string):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)fail(code);return value}
function sourceRefs(context:Record<string,unknown>):ContextSnapshotSourceRevisionRefs{
 const freshness=context.freshness as Record<string,unknown>|undefined;
 const profile=context.profile as Record<string,unknown>|undefined;
 const inbound=context.inboundMessageRef as Record<string,unknown>|undefined;
 const commerce=context.activeQuotationSalesOrder as Record<string,unknown>|undefined;
 const quotation=commerce?.quotation as Record<string,unknown>|null|undefined;
 const salesOrder=commerce?.salesOrder as Record<string,unknown>|null|undefined;
 if(!freshness||!profile||!inbound)fail('SOURCE_REFS');
 const refs={
  turnId:requiredText(context.turnId,'TURN_ID'),accountId:requiredText(context.accountId,'ACCOUNT_ID'),conversationId:requiredText(context.conversationId,'CONVERSATION_ID'),inboundMessageId:requiredText(freshness.inboundMessageId??inbound.id,'INBOUND_MESSAGE_ID'),
  profileId:requiredText(profile.id,'PROFILE_ID'),profileVersion:requiredRevision(profile.version,'PROFILE_VERSION'),
  summaryVersion:nullableRevision(freshness.summaryVersion,'SUMMARY_VERSION'),workItemRevision:nullableRevision(freshness.workItemRevision,'WORK_ITEM_REVISION'),draftRevision:nullableRevision(freshness.draftRevision,'DRAFT_REVISION'),
  quotationId:nullableText(freshness.quotationId??(quotation===null||quotation===undefined?null:quotation.id),'QUOTATION_ID'),salesOrderId:nullableText(freshness.salesOrderId??(salesOrder===null||salesOrder===undefined?null:salesOrder.id),'SALES_ORDER_ID'),freshnessFingerprint:requiredText(freshness.fingerprint,'FRESHNESS_FINGERPRINT'),
 };
 return deepFreeze(refs);
}
function nullableText(value:unknown,code:string):string|null{if(value===null||value===undefined)return null;return requiredText(value,code)}
function versionFor(refs:ContextSnapshotSourceRevisionRefs):string{return `${V3_CONTEXT_SNAPSHOT_CONTRACT_VERSION}:v${V3_CONTEXT_SNAPSHOT_SCHEMA_VERSION}:${canonicalSha256(refs)}`}
function unsigned(snapshot:Omit<ContextSnapshot,'integrityHash'>){return snapshot}

export function buildContextSnapshot(v2Context:Readonly<Record<string,unknown>>):ContextSnapshot{
 const context=boundedRedacted(v2Context) as Record<string,unknown>;const refs=sourceRefs(context);const contextSnapshotVersion=versionFor(refs);
 const candidate={contractVersion:V3_CONTEXT_SNAPSHOT_CONTRACT_VERSION as 'V3-CTX-002',schemaVersion:V3_CONTEXT_SNAPSHOT_SCHEMA_VERSION as 1,contextSnapshotVersion,authority:'NON_AUTHORITATIVE_DERIVED' as const,sourceRevisionRefs:refs,context};
 const integrityHash=canonicalSha256(unsigned(candidate));const json=canonicalJson({...candidate,integrityHash});if(json.length>MAX_V3_CONTEXT_SNAPSHOT_CHARS)fail('SIZE');
 return deepFreeze({...candidate,integrityHash});
}

export function validateContextSnapshot(value:unknown):ContextSnapshot{
 if(!value||typeof value!=='object'||Array.isArray(value))fail('SHAPE');const snapshot=plainJson(value) as Record<string,unknown>;
 if(snapshot.contractVersion!==V3_CONTEXT_SNAPSHOT_CONTRACT_VERSION||snapshot.schemaVersion!==V3_CONTEXT_SNAPSHOT_SCHEMA_VERSION||snapshot.authority!=='NON_AUTHORITATIVE_DERIVED')fail('VERSION_OR_AUTHORITY');
 if(typeof snapshot.contextSnapshotVersion!=='string'||typeof snapshot.integrityHash!=='string'||!snapshot.context||typeof snapshot.context!=='object'||Array.isArray(snapshot.context))fail('SHAPE');
 const context=snapshot.context as Record<string,unknown>;const safeContext=boundedRedacted(context) as Record<string,unknown>;if(canonicalJson(safeContext)!==canonicalJson(context))fail('REDACTION');const refs=sourceRefs(context);if(canonicalJson(refs)!==canonicalJson(snapshot.sourceRevisionRefs)||versionFor(refs)!==snapshot.contextSnapshotVersion)fail('SOURCE_REFS');
 const candidate={contractVersion:snapshot.contractVersion as 'V3-CTX-002',schemaVersion:1 as const,contextSnapshotVersion:snapshot.contextSnapshotVersion,authority:'NON_AUTHORITATIVE_DERIVED' as const,sourceRevisionRefs:refs,context:safeContext};
 if(canonicalSha256(candidate)!==snapshot.integrityHash||canonicalJson({...candidate,integrityHash:snapshot.integrityHash}).length>MAX_V3_CONTEXT_SNAPSHOT_CHARS)fail('INTEGRITY');
 return deepFreeze({...candidate,integrityHash:snapshot.integrityHash});
}

export function replayContextSnapshot(snapshot:unknown,currentV2Context:Readonly<Record<string,unknown>>):{snapshot:ContextSnapshot;stale:boolean;equal:boolean}{
 const valid=validateContextSnapshot(snapshot);const current=sourceRefs(boundedRedacted(currentV2Context) as Record<string,unknown>);const equal=canonicalJson(valid.sourceRevisionRefs)===canonicalJson(current);return {snapshot:valid,stale:!equal,equal};
}

export const isContextSnapshotStale=(snapshot:unknown,currentV2Context:Readonly<Record<string,unknown>>):boolean=>replayContextSnapshot(snapshot,currentV2Context).stale;
