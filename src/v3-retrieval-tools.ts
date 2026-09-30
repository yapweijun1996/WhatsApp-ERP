import type Database from 'better-sqlite3';
import {isProxy} from 'node:util/types';
import type {V3ConversationMemory, V3ConversationSection} from './v3-conversation-memory.js';
import {
  reopenV3RetrievalSource,
  type V3RetrievalHostAuthority,
  type V3RetrievalHostToken,
  type V3RetrievalIndexes,
  type V3RetrievalIndexEntry,
  type V3RetrievalScope,
} from './v3-retrieval-index.js';

export const V3_RETRIEVAL_TOOLS_CONTRACT_VERSION='V3-RET-004';
export const V3_RETRIEVAL_TOOLS_SCHEMA_VERSION=1;
export const V3_RETRIEVAL_TOOL_NAMES=Object.freeze([
  'conversation_recent',
  'conversation_search',
  'conversation_find_sections',
  'conversation_open_section',
  'conversation_get_message',
  'conversation_get_thread',
  'conversation_find_by_date',
] as const);

export type V3RetrievalToolName=typeof V3_RETRIEVAL_TOOL_NAMES[number];
export type V3ConversationRecentRequest=Readonly<{limit?:number}>;
export type V3ConversationSearchRequest=Readonly<{query:string;limit?:number}>;
export type V3ConversationFindSectionsRequest=Readonly<{query?:string;limit?:number}>;
export type V3ConversationOpenSectionRequest=Readonly<{sectionId:string;limit?:number}>;
export type V3ConversationGetMessageRequest=Readonly<{messageId:string}>;
export type V3ConversationGetThreadRequest=Readonly<{messageId:string;limit?:number}>;
export type V3ConversationFindByDateRequest=Readonly<{fromIso:string;toIso:string;limit?:number}>;

export type V3RetrievalCitation=Readonly<{sourceMessageId:string;sourceRef:string;indexVersion:string;scopeVersion:string}>;
export type V3RetrievalToolMessage=Readonly<{
  sourceMessageId:string;
  sourceRef:string;
  externalMessageId:string;
  direction:'INBOUND'|'OUTBOUND';
  messageType:string;
  text:string;
  occurredAt:string;
  replyToExternalMessageId:string|null;
  arrivalSeq:number|null;
  citation:V3RetrievalCitation;
}>;

type CommonResult<T extends V3RetrievalToolName>=Readonly<{
  contractVersion:'V3-RET-004';
  schemaVersion:1;
  tool:T;
  authority:'NON_AUTHORITATIVE_DERIVED';
  untrustedAsInstruction:true;
  requiresCanonicalReverification:true;
  indexVersion:string;
  scopeVersion:string;
  scopeLineage:V3RetrievalScope;
  deterministic:true;
  bounded:true;
}>;

export type V3ConversationRecentResult=CommonResult<'conversation_recent'>&Readonly<{order:'CHRONOLOGICAL_ASC_WITHIN_RECENT_WINDOW';messages:readonly V3RetrievalToolMessage[]}>;
export type V3ConversationSearchHit=Readonly<{matchedTerms:readonly string[];message:V3RetrievalToolMessage}>;
export type V3ConversationSearchResult=CommonResult<'conversation_search'>&Readonly<{queryTerms:readonly string[];order:'MATCH_COUNT_DESC_THEN_NEWEST_DESC_THEN_SOURCE_ID';hits:readonly V3ConversationSearchHit[]}>;
export type V3ConversationSectionHit=Readonly<{sectionId:string;title:string;topic:string;summary:string;matchedTerms:readonly string[];sourceMessageIds:readonly string[];sourceRefs:readonly string[];truncated:boolean}>;
export type V3ConversationFindSectionsResult=CommonResult<'conversation_find_sections'>&Readonly<{order:'MATCH_COUNT_DESC_THEN_MEMORY_ORDER'|'MEMORY_ORDER';sections:readonly V3ConversationSectionHit[]}>;
export type V3ConversationOpenSectionResult=CommonResult<'conversation_open_section'>&Readonly<{sectionId:string;title:string;topic:string;summary:string;messages:readonly V3RetrievalToolMessage[];truncated:boolean;order:'SECTION_SOURCE_ORDER'}>;
export type V3ConversationGetMessageResult=CommonResult<'conversation_get_message'>&Readonly<{message:V3RetrievalToolMessage}>;
export type V3ConversationGetThreadResult=CommonResult<'conversation_get_thread'>&Readonly<{seedMessageId:string;messages:readonly V3RetrievalToolMessage[];truncated:boolean;order:'CHRONOLOGICAL_ASC'}>;
export type V3ConversationFindByDateResult=CommonResult<'conversation_find_by_date'>&Readonly<{fromIso:string;toIso:string;messages:readonly V3RetrievalToolMessage[];truncated:boolean;order:'CHRONOLOGICAL_ASC'}>;

export type V3RetrievalTools=Readonly<{
  conversation_recent(request:V3ConversationRecentRequest):V3ConversationRecentResult;
  conversation_search(request:V3ConversationSearchRequest):V3ConversationSearchResult;
  conversation_find_sections(request:V3ConversationFindSectionsRequest):V3ConversationFindSectionsResult;
  conversation_open_section(request:V3ConversationOpenSectionRequest):V3ConversationOpenSectionResult;
  conversation_get_message(request:V3ConversationGetMessageRequest):V3ConversationGetMessageResult;
  conversation_get_thread(request:V3ConversationGetThreadRequest):V3ConversationGetThreadResult;
  conversation_find_by_date(request:V3ConversationFindByDateRequest):V3ConversationFindByDateResult;
}>;

const DEFAULT_LIMIT=20, MAX_LIMIT=50, MAX_ID=256, MAX_QUERY=512, MAX_QUERY_TERMS=32, MAX_SECTION_CITATIONS=50, MAX_MESSAGE_TEXT=16_000, MAX_EXTERNAL_ID=512, MAX_MESSAGE_TYPE=128, MAX_TIME=64, MAX_SOURCE_REF=512, MAX_VERSION=256, MAX_SECTION_TITLE=160, MAX_SECTION_TOPIC=240, MAX_SECTION_SUMMARY=4_000;
const RFC3339=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;

function invalid(code:string):never{throw new Error(`V3_RETRIEVAL_TOOL_INVALID:${code}`)}
function unavailable():never{throw new Error('V3_RETRIEVAL_TOOL_UNAVAILABLE')}
function deepFreeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value as Record<string,unknown>))deepFreeze(child);if(!Object.isFrozen(value))Object.freeze(value)}return value}

function closedRequest(value:unknown,allowed:readonly string[]):Record<string,unknown>{
  let proto:object|null,keys:PropertyKey[],descriptors:PropertyDescriptorMap;
  try{if(value===null||typeof value!=='object'||Array.isArray(value)||isProxy(value))invalid('REQUEST_SHAPE');proto=Object.getPrototypeOf(value);keys=Reflect.ownKeys(value);descriptors=Object.getOwnPropertyDescriptors(value)}catch{invalid('REQUEST_SHAPE')}
  if(proto!==Object.prototype)invalid('REQUEST_SHAPE');
  const out:Record<string,unknown>={};
  for(const key of keys){if(typeof key!=='string'||!allowed.includes(key))invalid('REQUEST_FIELD');const d=descriptors[key];if(!d||!('value' in d)||!d.enumerable)invalid('REQUEST_FIELD');out[key]=d.value}
  return out;
}
function limitValue(value:unknown):number{if(value===undefined)return DEFAULT_LIMIT;if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>MAX_LIMIT)invalid('LIMIT');return value}
function idValue(value:unknown):string{if(typeof value!=='string'||value.trim()===''||Buffer.byteLength(value,'utf8')>MAX_ID)invalid('ID');return value}
function tokenize(value:string):string[]{return [...new Set((value.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu)??[]))].sort()}
function queryTerms(value:unknown,optional=false):string[]{
  if(value===undefined&&optional)return [];
  if(typeof value!=='string'||value.trim()===''||Buffer.byteLength(value,'utf8')>MAX_QUERY)invalid('QUERY');
  const terms=tokenize(value);
  if(terms.length===0||terms.length>MAX_QUERY_TERMS)invalid('QUERY_TERMS');
  return terms;
}
function timestamp(value:unknown,code:string):bigint{
  if(typeof value!=='string'||value.length>MAX_TIME)invalid(code);
  const m=RFC3339.exec(value);if(!m)invalid(code);
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),hour=Number(m[4]),minute=Number(m[5]),second=Number(m[6]);
  if(year<1||year>9999||month<1||month>12||hour>23||minute>59||second>59)invalid(code);
  const days=new Date(Date.UTC(year,month,0)).getUTCDate();if(day<1||day>days)invalid(code);
  let offsetMinutes=0;if(m[8]!=='Z'){const oh=Number(m[9]),om=Number(m[10]);if(oh>23||om>59)invalid(code);offsetMinutes=(m[8].startsWith('+')?1:-1)*(oh*60+om)}
  const base=new Date(0);base.setUTCFullYear(year,month-1,day);base.setUTCHours(hour,minute,second,0);const localMs=base.getTime();if(!Number.isFinite(localMs))invalid(code);
  const fraction=(m[7]??'').padEnd(9,'0');const nanos=fraction===''?0n:BigInt(fraction);
  return BigInt(localMs-offsetMinutes*60_000)*1_000_000n+nanos;
}
function boundedResultString(value:string,code:string,max:number,allowEmpty=false):string{if(Buffer.byteLength(value,'utf8')>max||(!allowEmpty&&value.trim()===''))invalid(code);return value}
function directionValue(value:string):'INBOUND'|'OUTBOUND'{if(value!=='INBOUND'&&value!=='OUTBOUND')invalid('DIRECTION');return value}
function boundedScope(scope:V3RetrievalScope):V3RetrievalScope{
  return {tenantId:boundedResultString(scope.tenantId,'SCOPE_ID_SIZE',MAX_ID),accountId:boundedResultString(scope.accountId,'SCOPE_ID_SIZE',MAX_ID),channelAccountId:boundedResultString(scope.channelAccountId,'SCOPE_ID_SIZE',MAX_ID),conversationId:boundedResultString(scope.conversationId,'SCOPE_ID_SIZE',MAX_ID),customerId:scope.customerId===null?null:boundedResultString(scope.customerId,'SCOPE_ID_SIZE',MAX_ID)};
}
function sameIds(a:readonly string[],b:readonly string[]):boolean{return a.length===b.length&&a.every((id,i)=>id===b[i])}
function compareOccurredExact(a:V3RetrievalIndexEntry,b:V3RetrievalIndexEntry):number{
  const at=timestamp(a.occurredAt,'INDEX_TIME'),bt=timestamp(b.occurredAt,'INDEX_TIME');
  if(at<bt)return -1;if(at>bt)return 1;
  return a.externalMessageId.localeCompare(b.externalMessageId)||a.sourceMessageId.localeCompare(b.sourceMessageId);
}
function canonicalChronology(entries:readonly V3RetrievalIndexEntry[]):V3RetrievalIndexEntry[]{
  const sequenced=entries.filter(entry=>entry.arrivalSeq!==null).sort((a,b)=>a.arrivalSeq! - b.arrivalSeq! || compareOccurredExact(a,b));
  const unsequenced=entries.filter(entry=>entry.arrivalSeq===null).sort(compareOccurredExact);
  const out:V3RetrievalIndexEntry[]=[];let u=0;
  for(const sequencedEntry of sequenced){
    while(u<unsequenced.length&&compareOccurredExact(unsequenced[u]!,sequencedEntry)<=0)out.push(unsequenced[u++]!);
    out.push(sequencedEntry);
  }
  while(u<unsequenced.length)out.push(unsequenced[u++]!);
  return out;
}

class V3RetrievalToolService{
  private readonly sourceIds:Set<string>;
  constructor(
    private readonly db:Database.Database,
    private readonly hostAuthority:V3RetrievalHostAuthority,
    private readonly token:V3RetrievalHostToken,
    private readonly index:V3RetrievalIndexes,
    private readonly currentMemory:V3ConversationMemory,
  ){
    this.sourceIds=new Set(index.sourceMessageIds);
  }
  private validateBinding():void{
    const first=this.index.sourceMessageIds[0];if(!first)unavailable();
    reopenV3RetrievalSource(this.db,this.hostAuthority,this.token,this.index,first,this.currentMemory);
  }
  private versions():{indexVersion:string;scopeVersion:string}{return {indexVersion:boundedResultString(this.index.indexVersion,'INDEX_VERSION_SIZE',MAX_VERSION),scopeVersion:boundedResultString(this.index.scopeVersion,'SCOPE_VERSION_SIZE',MAX_VERSION)}}
  private common<T extends V3RetrievalToolName>(tool:T):CommonResult<T>{
    const {indexVersion,scopeVersion}=this.versions();
    return {contractVersion:'V3-RET-004',schemaVersion:1,tool,authority:'NON_AUTHORITATIVE_DERIVED',untrustedAsInstruction:true,requiresCanonicalReverification:true,indexVersion,scopeVersion,scopeLineage:boundedScope(this.index.scope),deterministic:true,bounded:true};
  }
  private chronology():V3RetrievalIndexEntry[]{return canonicalChronology(this.index.chronology)}
  private chronologyPosition():Map<string,number>{return new Map(this.chronology().map((entry,position)=>[entry.sourceMessageId,position]))}
  private hasSource(id:string):boolean{return this.sourceIds.has(id)}
  private open(id:string):V3RetrievalToolMessage{
    if(!this.hasSource(id))unavailable();
    const opened=reopenV3RetrievalSource(this.db,this.hostAuthority,this.token,this.index,id,this.currentMemory),s=opened.source;if(Buffer.byteLength(s.text,'utf8')>MAX_MESSAGE_TEXT)invalid('MESSAGE_TEXT_SIZE');
    const sourceMessageId=boundedResultString(s.id,'SOURCE_ID_SIZE',MAX_ID),sourceRef=boundedResultString(opened.sourceRef,'SOURCE_REF_SIZE',MAX_SOURCE_REF),externalMessageId=boundedResultString(s.externalMessageId,'EXTERNAL_MESSAGE_ID_SIZE',MAX_EXTERNAL_ID),direction=directionValue(s.direction),messageType=boundedResultString(s.messageType,'MESSAGE_TYPE_SIZE',MAX_MESSAGE_TYPE),occurredAt=boundedResultString(s.occurredAt,'OCCURRED_AT_SIZE',MAX_TIME),replyToExternalMessageId=s.replyToExternalMessageId===null?null:boundedResultString(s.replyToExternalMessageId,'REPLY_EXTERNAL_MESSAGE_ID_SIZE',MAX_EXTERNAL_ID),{indexVersion,scopeVersion}=this.versions();
    return {sourceMessageId,sourceRef,externalMessageId,direction,messageType,text:s.text,occurredAt,replyToExternalMessageId,arrivalSeq:s.arrivalSeq,citation:{sourceMessageId,sourceRef,indexVersion,scopeVersion}};
  }
  private section(sectionId:string):{memory:V3ConversationSection;indexIds:readonly string[]}{
    const memory=this.currentMemory.sections.find(s=>s.id===sectionId),posting=this.index.sections.find(s=>s.sectionId===sectionId);
    if(!memory||!posting||!sameIds(memory.sourceMessageIds,posting.sourceMessageIds))unavailable();
    return {memory,indexIds:posting.sourceMessageIds};
  }
  recent(request:V3ConversationRecentRequest):V3ConversationRecentResult{
    this.validateBinding();const r=closedRequest(request,['limit']),limit=limitValue(r.limit),selected=this.chronology().slice(-limit),messages=selected.map(e=>this.open(e.sourceMessageId));
    return deepFreeze({...this.common('conversation_recent'),order:'CHRONOLOGICAL_ASC_WITHIN_RECENT_WINDOW' as const,messages});
  }
  search(request:V3ConversationSearchRequest):V3ConversationSearchResult{
    this.validateBinding();const r=closedRequest(request,['query','limit']),terms=queryTerms(r.query),limit=limitValue(r.limit),wanted=new Set(terms),matches=new Map<string,Set<string>>();
    for(const posting of this.index.semantic)if(wanted.has(posting.term))for(const id of posting.sourceMessageIds){if(!this.hasSource(id))unavailable();const set=matches.get(id)??new Set<string>();set.add(posting.term);matches.set(id,set)}
    const positions=this.chronologyPosition();
    const ranked=[...matches].map(([id,set])=>({id,matchedTerms:[...set].sort()})).sort((a,b)=>(b.matchedTerms.length-a.matchedTerms.length)||(positions.get(b.id)!-positions.get(a.id)!)||a.id.localeCompare(b.id)).slice(0,limit);
    const hits=ranked.map(hit=>({matchedTerms:hit.matchedTerms,message:this.open(hit.id)}));
    return deepFreeze({...this.common('conversation_search'),queryTerms:terms,order:'MATCH_COUNT_DESC_THEN_NEWEST_DESC_THEN_SOURCE_ID' as const,hits});
  }
  findSections(request:V3ConversationFindSectionsRequest):V3ConversationFindSectionsResult{
    this.validateBinding();const r=closedRequest(request,['query','limit']),limit=limitValue(r.limit),terms=queryTerms(r.query,true),querying=r.query!==undefined;
    const ranked=this.currentMemory.sections.map((section,memoryOrder)=>{const {indexIds}=this.section(section.id),sectionTerms=new Set(tokenize(`${section.title} ${section.topic} ${section.summary}`));const matchedTerms=querying?terms.filter(term=>sectionTerms.has(term)):[];return {section,indexIds,memoryOrder,matchedTerms}}).filter(x=>!querying||x.matchedTerms.length>0).sort((a,b)=>querying?(b.matchedTerms.length-a.matchedTerms.length||a.memoryOrder-b.memoryOrder):a.memoryOrder-b.memoryOrder).slice(0,limit);
    const sections=ranked.map(({section,indexIds,matchedTerms})=>{const ids=indexIds.slice(0,MAX_SECTION_CITATIONS),opened=ids.map(id=>this.open(id));return {sectionId:boundedResultString(section.id,'SECTION_ID_SIZE',MAX_ID),title:boundedResultString(section.title,'SECTION_TITLE_SIZE',MAX_SECTION_TITLE),topic:boundedResultString(section.topic,'SECTION_TOPIC_SIZE',MAX_SECTION_TOPIC),summary:boundedResultString(section.summary,'SECTION_SUMMARY_SIZE',MAX_SECTION_SUMMARY),matchedTerms,sourceMessageIds:opened.map(message=>message.sourceMessageId),sourceRefs:opened.map(message=>message.sourceRef),truncated:indexIds.length>ids.length}});
    return deepFreeze({...this.common('conversation_find_sections'),order:querying?'MATCH_COUNT_DESC_THEN_MEMORY_ORDER' as const:'MEMORY_ORDER' as const,sections});
  }
  openSection(request:V3ConversationOpenSectionRequest):V3ConversationOpenSectionResult{
    this.validateBinding();const r=closedRequest(request,['sectionId','limit']),sectionId=idValue(r.sectionId),limit=limitValue(r.limit),{memory,indexIds}=this.section(sectionId),ids=indexIds.slice(0,limit),messages=ids.map(id=>this.open(id));
    return deepFreeze({...this.common('conversation_open_section'),sectionId:boundedResultString(sectionId,'SECTION_ID_SIZE',MAX_ID),title:boundedResultString(memory.title,'SECTION_TITLE_SIZE',MAX_SECTION_TITLE),topic:boundedResultString(memory.topic,'SECTION_TOPIC_SIZE',MAX_SECTION_TOPIC),summary:boundedResultString(memory.summary,'SECTION_SUMMARY_SIZE',MAX_SECTION_SUMMARY),messages,truncated:indexIds.length>ids.length,order:'SECTION_SOURCE_ORDER' as const});
  }
  getMessage(request:V3ConversationGetMessageRequest):V3ConversationGetMessageResult{
    this.validateBinding();const r=closedRequest(request,['messageId']),messageId=idValue(r.messageId);if(!this.hasSource(messageId))unavailable();return deepFreeze({...this.common('conversation_get_message'),message:this.open(messageId)});
  }
  getThread(request:V3ConversationGetThreadRequest):V3ConversationGetThreadResult{
    this.validateBinding();const r=closedRequest(request,['messageId','limit']),seed=idValue(r.messageId),limit=limitValue(r.limit);if(!this.hasSource(seed))unavailable();
    const postings=new Map(this.index.replies.map(p=>[p.sourceMessageId,p]));if(!postings.has(seed))unavailable();const seen=new Set<string>(),queue=[seed];
    while(queue.length){const id=queue.shift()!;if(seen.has(id))continue;if(!this.hasSource(id))unavailable();const posting=postings.get(id);if(!posting)unavailable();seen.add(id);if(posting.replyToSourceMessageId)queue.push(posting.replyToSourceMessageId);for(const child of posting.childSourceMessageIds)queue.push(child)}
    const positions=this.chronologyPosition();
    const ordered=[...seen].sort((a,b)=>positions.get(a)!-positions.get(b)!||a.localeCompare(b)),ids=ordered.slice(0,limit),messages=ids.map(id=>this.open(id));
    return deepFreeze({...this.common('conversation_get_thread'),seedMessageId:seed,messages,truncated:ordered.length>ids.length,order:'CHRONOLOGICAL_ASC' as const});
  }
  findByDate(request:V3ConversationFindByDateRequest):V3ConversationFindByDateResult{
    this.validateBinding();const r=closedRequest(request,['fromIso','toIso','limit']),from=timestamp(r.fromIso,'FROM_ISO'),to=timestamp(r.toIso,'TO_ISO'),limit=limitValue(r.limit);if(from>to)invalid('DATE_RANGE');
    const eligible=this.chronology().filter(entry=>{const t=timestamp(entry.occurredAt,'INDEX_TIME');return t>=from&&t<=to}),selected=eligible.slice(0,limit),messages=selected.map(e=>this.open(e.sourceMessageId));
    return deepFreeze({...this.common('conversation_find_by_date'),fromIso:r.fromIso as string,toIso:r.toIso as string,messages,truncated:eligible.length>selected.length,order:'CHRONOLOGICAL_ASC' as const});
  }
}

export function createV3RetrievalTools(db:Database.Database,hostAuthority:V3RetrievalHostAuthority,token:V3RetrievalHostToken,index:V3RetrievalIndexes,currentMemory:V3ConversationMemory):V3RetrievalTools{
  const service=new V3RetrievalToolService(db,hostAuthority,token,index,currentMemory);
  return Object.freeze({
    conversation_recent:(request)=>service.recent(request),
    conversation_search:(request)=>service.search(request),
    conversation_find_sections:(request)=>service.findSections(request),
    conversation_open_section:(request)=>service.openSection(request),
    conversation_get_message:(request)=>service.getMessage(request),
    conversation_get_thread:(request)=>service.getThread(request),
    conversation_find_by_date:(request)=>service.findByDate(request),
  });
}
