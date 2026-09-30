import type Database from 'better-sqlite3';
import {canonicalJson,canonicalSha256} from './v2-canonical.js';
import {redactContextText} from './v2-context-projection.js';

export const V3_CONVERSATION_MEMORY_CONTRACT_VERSION='V3-CTX-004';
export const V3_CONVERSATION_MEMORY_SCHEMA_VERSION=1;
export const V3_CONVERSATION_MEMORY_LIMITS=Object.freeze({title:160,topic:240,summary:4000,memory:6000,sections:100,messagesPerSection:200,messageRefs:200,sectionRefs:100,totalMessages:1000,id:256});

type SectionProposal=Readonly<{id:string;title:string;topic:string;summary:string;sourceMessageIds:readonly string[]}>;
export type ConversationMemoryDerivationProposal=Readonly<{sections:readonly SectionProposal[];rollingMemory:Readonly<{text:string;sourceMessageIds:readonly string[];sectionIds:readonly string[]}>}>;
export type ConversationMemoryBuildInput=Readonly<{accountId:string;conversationId:string;proposal:ConversationMemoryDerivationProposal}>;
export type V3ConversationSection=Readonly<{id:string;title:string;topic:string;summary:string;sourceMessageIds:readonly string[]}>;
export type V3RollingConversationMemory=Readonly<{text:string;sourceMessageIds:readonly string[];sectionIds:readonly string[]}>;
export type V3ConversationMemory=Readonly<{
 contractVersion:'V3-CTX-004';schemaVersion:1;authority:'NON_AUTHORITATIVE_DERIVED';untrustedAsInstruction:true;
 requiresCanonicalReverification:true;accountId:string;conversationId:string;sections:readonly V3ConversationSection[];
 rollingMemory:V3RollingConversationMemory;derivationVersion:string;projectionHash:string;
}>;
export type V3ConversationRawBubble=Readonly<{id:string;accountId:string;conversationId:string;externalMessageId:string;direction:string;messageType:string;text:string;occurredAt:string;replyToExternalMessageId:string|null;arrivalSeq:number|null;rawRef:string|null}>;
export type V3ConversationSectionNavigation=Readonly<{
 contractVersion:'V3-RET-001';authority:'NON_AUTHORITATIVE_DERIVED';untrustedAsInstruction:true;
 requiresCanonicalReverification:true;accountId:string;conversationId:string;sectionId:string;title:string;topic:string;summary:string;
 sourceMessageIds:readonly string[];rawMessages:readonly V3ConversationRawBubble[];sourceOrder:'arrival_seq_then_occurred_at_then_external_message_id_then_id';
}>;
export type V3ConversationMemoryValidation=Readonly<{memory:V3ConversationMemory;sourceEvidence:readonly V3ConversationRawBubble[]}>;

function fail(code:string):never{throw new Error(`V3_CONVERSATION_MEMORY_INVALID:${code}`)}
function deepFreeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value as Record<string,unknown>))deepFreeze(child);if(!Object.isFrozen(value))Object.freeze(value)}return value}
function plain(value:unknown,seen=new WeakSet<object>()):unknown{
 if(value===null||typeof value==='boolean'||typeof value==='number'){if(typeof value==='number'&&!Number.isFinite(value))fail('PLAIN_JSON');return value}
 if(typeof value==='string')return value;
 if(typeof value!=='object'||seen.has(value))fail('PLAIN_JSON');seen.add(value);
 const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
 if((array&&proto!==Array.prototype)||(!array&&proto!==Object.prototype&&proto!==null))fail('PLAIN_JSON');
 const descriptors=Object.getOwnPropertyDescriptors(value);
 for(const d of Object.values(descriptors))if(!('value' in d))fail('ACCESSOR');
 if(array){const length=descriptors.length?.value;if(typeof length!=='number'||!Number.isSafeInteger(length)||length<0)fail('PLAIN_JSON');const out:unknown[]=new Array(length);for(const key of Object.keys(value)){if(key==='length'||!/^[0-9]+$/.test(key)||Number(key)>=length)fail('PLAIN_JSON');out[Number(key)]=plain(descriptors[key].value,seen)}seen.delete(value);return out}
 const out:Record<string,unknown>={};for(const key of Object.keys(value)){const item=descriptors[key].value;if(item!==undefined)out[key]=plain(item,seen)}seen.delete(value);return out;
}
function text(value:unknown,code:string,max:number):string{if(typeof value!=='string'||value.trim().length===0||value.length>max)fail(code);return value}
function refs(value:unknown,code:string,max:number):string[]{if(!Array.isArray(value)||value.length>max)fail(code);const result=value.map(id=>text(id,code,V3_CONVERSATION_MEMORY_LIMITS.id));if(new Set(result).size!==result.length)fail(`${code}_DUPLICATE`);return result}
function redacted(value:string):string{const result=redactContextText(value);if(result.length>V3_CONVERSATION_MEMORY_LIMITS.memory)fail('MEMORY_SIZE');return result}
function proposal(value:unknown):ConversationMemoryDerivationProposal{
 const p=plain(value) as Record<string,unknown>;if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['sections','rollingMemory'].includes(k)))fail('PROPOSAL_SHAPE');
 if(!Array.isArray(p.sections)||p.sections.length>V3_CONVERSATION_MEMORY_LIMITS.sections)fail('SECTIONS');
 const sections=p.sections.map((raw,position)=>{const s=raw as Record<string,unknown>;if(!s||Array.isArray(s)||Object.keys(s).some(k=>!['id','title','topic','summary','sourceMessageIds'].includes(k)))fail(`SECTION_${position}_SHAPE`);const sourceMessageIds=refs(s.sourceMessageIds,'SECTION_MESSAGE_REFS',V3_CONVERSATION_MEMORY_LIMITS.messagesPerSection);if(sourceMessageIds.length===0)fail('SECTION_MESSAGE_REFS');return {id:text(s.id,'SECTION_ID',V3_CONVERSATION_MEMORY_LIMITS.id),title:redactContextText(text(s.title,'SECTION_TITLE',V3_CONVERSATION_MEMORY_LIMITS.title)),topic:redactContextText(text(s.topic,'SECTION_TOPIC',V3_CONVERSATION_MEMORY_LIMITS.topic)),summary:redactContextText(text(s.summary,'SECTION_SUMMARY',V3_CONVERSATION_MEMORY_LIMITS.summary)),sourceMessageIds} as SectionProposal});
 if(new Set(sections.map(s=>s.id)).size!==sections.length)fail('SECTION_ID_DUPLICATE');
 const m=p.rollingMemory as Record<string,unknown>;if(!m||Array.isArray(m)||Object.keys(m).some(k=>!['text','sourceMessageIds','sectionIds'].includes(k)))fail('MEMORY_SHAPE');
 const sourceMessageIds=refs(m.sourceMessageIds,'MEMORY_MESSAGE_REFS',V3_CONVERSATION_MEMORY_LIMITS.messageRefs),sectionIds=refs(m.sectionIds,'MEMORY_SECTION_REFS',V3_CONVERSATION_MEMORY_LIMITS.sectionRefs);if(sourceMessageIds.length===0&&sectionIds.length===0)fail('MEMORY_PROVENANCE');
 return {sections,rollingMemory:{text:redacted(text(m.text,'MEMORY_TEXT',V3_CONVERSATION_MEMORY_LIMITS.memory)),sourceMessageIds,sectionIds}};
}

type SourceRow={id:string;account_id:string;conversation_id:string;direction:string;message_type:string;text:string|null;occurred_at:string;external_message_id:string;reply_to_external_message_id:string|null;arrival_seq:number|null;raw_ref:string|null};
function occurredTime(row:SourceRow):number{const time=Date.parse(row.occurred_at);if(!Number.isFinite(time))fail('SOURCE_MESSAGE_TIME');return time}
function compareSource(a:SourceRow,b:SourceRow):number{
 if(a.arrival_seq!==null&&b.arrival_seq!==null&&a.arrival_seq!==b.arrival_seq)return a.arrival_seq-b.arrival_seq;
 return occurredTime(a)-occurredTime(b)||a.external_message_id.localeCompare(b.external_message_id)||a.id.localeCompare(b.id);
}

function sourceEvidence(rows:Iterable<SourceRow>):V3ConversationRawBubble[]{
 return [...rows].sort(compareSource).map(row=>({id:row.id,accountId:row.account_id,conversationId:row.conversation_id,externalMessageId:row.external_message_id,direction:row.direction,messageType:row.message_type,text:row.text??'',occurredAt:row.occurred_at,replyToExternalMessageId:row.reply_to_external_message_id,arrivalSeq:row.arrival_seq,rawRef:row.raw_ref}));
}

function memoryCandidate(memory:V3ConversationMemory):Record<string,unknown>{
 return {contractVersion:memory.contractVersion,schemaVersion:memory.schemaVersion,accountId:memory.accountId,conversationId:memory.conversationId,sections:memory.sections,rollingMemory:memory.rollingMemory};
}

export function validateV3ConversationMemory(db:Database.Database,input:{accountId:string;conversationId:string;memory:V3ConversationMemory}):V3ConversationMemoryValidation{
 const accountId=text(input.accountId,'ACCOUNT_ID',V3_CONVERSATION_MEMORY_LIMITS.id),conversationId=text(input.conversationId,'CONVERSATION_ID',V3_CONVERSATION_MEMORY_LIMITS.id),memory=input.memory;
 if(memory.accountId!==accountId||memory.conversationId!==conversationId)fail('MEMORY_SCOPE');
 if(memory.contractVersion!=='V3-CTX-004'||memory.schemaVersion!==1||memory.authority!=='NON_AUTHORITATIVE_DERIVED'||memory.untrustedAsInstruction!==true||memory.requiresCanonicalReverification!==true)fail('MEMORY_CONTRACT');
 if(!db.prepare('SELECT 1 FROM conversations WHERE id=? AND channel_account_id=?').get(conversationId,accountId))fail('CONVERSATION_SCOPE');
 const allIds=[...memory.sections.flatMap(section=>section.sourceMessageIds),...memory.rollingMemory.sourceMessageIds],uniqueIds=[...new Set(allIds)];
 const rows=new Map<string,SourceRow>();
 for(const id of uniqueIds){const row=db.prepare('SELECT id,account_id,conversation_id,direction,message_type,text,occurred_at,external_message_id,reply_to_external_message_id,arrival_seq,raw_ref FROM messages WHERE id=? AND account_id=? AND conversation_id=?').get(id,accountId,conversationId) as SourceRow|undefined;if(!row)fail('SOURCE_MESSAGE_SCOPE');if(row.text===null)fail('SOURCE_MESSAGE_UNAVAILABLE');if(row.direction!=='INBOUND'&&row.direction!=='OUTBOUND')fail('SOURCE_MESSAGE_DIRECTION');occurredTime(row);rows.set(id,row)}
 if(uniqueIds.length>V3_CONVERSATION_MEMORY_LIMITS.totalMessages)fail('SOURCE_MESSAGE_COUNT');
 for(const section of memory.sections){const selected=section.sourceMessageIds.map(id=>rows.get(id)!);for(let i=1;i<selected.length;i++)if(compareSource(selected[i-1],selected[i])>=0)fail('SOURCE_MESSAGE_ORDER')}
 const sectionIds=new Set(memory.sections.map(section=>section.id));for(const id of memory.rollingMemory.sectionIds)if(!sectionIds.has(id))fail('SECTION_REF_SCOPE');
 const evidence=sourceEvidenceForRows(rows),expectedDerivation=`${V3_CONVERSATION_MEMORY_CONTRACT_VERSION}:v${V3_CONVERSATION_MEMORY_SCHEMA_VERSION}:${canonicalSha256({contract:V3_CONVERSATION_MEMORY_CONTRACT_VERSION,sourceEvidence:evidence,proposal:memoryCandidate(memory)})}`;
 const expectedProjection=canonicalSha256({...memoryCandidate(memory),authority:'NON_AUTHORITATIVE_DERIVED',untrustedAsInstruction:true,requiresCanonicalReverification:true,derivationVersion:memory.derivationVersion});
 if(memory.derivationVersion!==expectedDerivation||memory.projectionHash!==expectedProjection)fail('SECTION_PROVENANCE');
 return {memory,sourceEvidence:evidence};
}

export class V3ConversationMemoryService{
 constructor(private readonly db:Database.Database){}
 build(input:ConversationMemoryBuildInput):V3ConversationMemory{
  const safeInput=plain(input) as Record<string,unknown>;if(!safeInput||typeof safeInput!=='object'||Array.isArray(safeInput)||Object.keys(safeInput).some(k=>!['accountId','conversationId','proposal'].includes(k)))fail('INPUT_SHAPE');
  const accountId=text(safeInput.accountId,'ACCOUNT_ID',V3_CONVERSATION_MEMORY_LIMITS.id),conversationId=text(safeInput.conversationId,'CONVERSATION_ID',V3_CONVERSATION_MEMORY_LIMITS.id);
  if(!this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND channel_account_id=?').get(conversationId,accountId))fail('CONVERSATION_SCOPE');
  const p=proposal(safeInput.proposal), allIds=[...p.sections.flatMap(s=>s.sourceMessageIds),...p.rollingMemory.sourceMessageIds], uniqueIds=[...new Set(allIds)];
  const rows=new Map<string,SourceRow>();for(const id of uniqueIds){const row=this.db.prepare('SELECT id,account_id,conversation_id,direction,message_type,text,occurred_at,external_message_id,reply_to_external_message_id,arrival_seq,raw_ref FROM messages WHERE id=? AND account_id=? AND conversation_id=?').get(id,accountId,conversationId) as SourceRow|undefined;if(!row)fail('SOURCE_MESSAGE_SCOPE');if(row.text===null)fail('SOURCE_MESSAGE_UNAVAILABLE');if(row.direction!=='INBOUND'&&row.direction!=='OUTBOUND')fail('SOURCE_MESSAGE_DIRECTION');if(typeof row.occurred_at!=='string'||row.occurred_at.length===0)fail('SOURCE_MESSAGE_TIME');occurredTime(row);rows.set(id,row)}
  if(uniqueIds.length>V3_CONVERSATION_MEMORY_LIMITS.totalMessages)fail('SOURCE_MESSAGE_COUNT');
  for(const section of p.sections){const selected=section.sourceMessageIds.map(id=>rows.get(id)!);for(let i=1;i<selected.length;i++)if(compareSource(selected[i-1],selected[i])>=0)fail('SOURCE_MESSAGE_ORDER')}
  const sectionIds=new Set(p.sections.map(s=>s.id));for(const id of p.rollingMemory.sectionIds)if(!sectionIds.has(id))fail('SECTION_REF_SCOPE');
  const sourceEvidence=sourceEvidenceForRows(rows);
  const sanitized={contractVersion:V3_CONVERSATION_MEMORY_CONTRACT_VERSION,schemaVersion:V3_CONVERSATION_MEMORY_SCHEMA_VERSION,accountId,conversationId,sections:p.sections,rollingMemory:p.rollingMemory};
  const derivationVersion=`${V3_CONVERSATION_MEMORY_CONTRACT_VERSION}:v${V3_CONVERSATION_MEMORY_SCHEMA_VERSION}:${canonicalSha256({contract:V3_CONVERSATION_MEMORY_CONTRACT_VERSION,sourceEvidence,proposal:sanitized})}`;
  const candidate={...sanitized,contractVersion:V3_CONVERSATION_MEMORY_CONTRACT_VERSION as 'V3-CTX-004',schemaVersion:V3_CONVERSATION_MEMORY_SCHEMA_VERSION as 1,authority:'NON_AUTHORITATIVE_DERIVED' as const,untrustedAsInstruction:true as const,requiresCanonicalReverification:true as const,derivationVersion};
  const projectionHash=canonicalSha256(candidate);return deepFreeze({...candidate,projectionHash});
 }
 openSection(input:{accountId:string;conversationId:string;memory:V3ConversationMemory;sectionId:string}):V3ConversationSectionNavigation{
  const safeInput=plain(input) as Record<string,unknown>;if(!safeInput||typeof safeInput!=='object'||Array.isArray(safeInput)||Object.keys(safeInput).some(k=>!['accountId','conversationId','memory','sectionId'].includes(k)))fail('NAVIGATION_INPUT_SHAPE');
  const accountId=text(safeInput.accountId,'ACCOUNT_ID',V3_CONVERSATION_MEMORY_LIMITS.id),conversationId=text(safeInput.conversationId,'CONVERSATION_ID',V3_CONVERSATION_MEMORY_LIMITS.id),sectionId=text(safeInput.sectionId,'SECTION_ID',V3_CONVERSATION_MEMORY_LIMITS.id);
  if(accountId!==input.memory.accountId||conversationId!==input.memory.conversationId)fail('NAVIGATION_SCOPE');
  if(input.memory.contractVersion!=='V3-CTX-004'||input.memory.schemaVersion!==1||input.memory.authority!=='NON_AUTHORITATIVE_DERIVED'||input.memory.untrustedAsInstruction!==true||input.memory.requiresCanonicalReverification!==true)fail('NAVIGATION_MEMORY_CONTRACT');
  const section=input.memory.sections.find(candidate=>candidate.id===sectionId);if(!section)fail('SECTION_NOT_FOUND');
  const conversation=this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND channel_account_id=?').get(conversationId,accountId);if(!conversation)fail('CONVERSATION_SCOPE');
  const validated=validateV3ConversationMemory(this.db,{accountId,conversationId,memory:input.memory});
  const rows=new Map(validated.sourceEvidence.map(source=>[source.id,source]));
  const rawMessages=section.sourceMessageIds.map(id=>rows.get(id)!);if(rawMessages.some(row=>row.text===null))fail('SOURCE_MESSAGE_UNAVAILABLE');
  return deepFreeze({contractVersion:'V3-RET-001',authority:'NON_AUTHORITATIVE_DERIVED',untrustedAsInstruction:true,requiresCanonicalReverification:true,accountId,conversationId,sectionId:section.id,title:section.title,topic:section.topic,summary:section.summary,sourceMessageIds:[...section.sourceMessageIds],rawMessages,sourceOrder:'arrival_seq_then_occurred_at_then_external_message_id_then_id'});
 }
}
function sourceEvidenceForRows(rows:Map<string,SourceRow>):V3ConversationRawBubble[]{return sourceEvidence(rows.values())}
export function buildV3ConversationMemory(db:Database.Database,input:ConversationMemoryBuildInput):V3ConversationMemory{return new V3ConversationMemoryService(db).build(input)}
export function reopenV3ConversationSection(db:Database.Database,input:{accountId:string;conversationId:string;memory:V3ConversationMemory;sectionId:string}):V3ConversationSectionNavigation{return new V3ConversationMemoryService(db).openSection(input)}
