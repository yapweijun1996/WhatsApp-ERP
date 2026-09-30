import type Database from 'better-sqlite3';
import {canonicalSha256} from './v2-canonical.js';
import {validateV3ConversationMemory, type V3ConversationMemory} from './v3-conversation-memory.js';

export const V3_RETRIEVAL_INDEX_CONTRACT_VERSION = 'V3-RET-002';
export const V3_RETRIEVAL_INDEX_SCHEMA_VERSION = 1;
export const V3_RETRIEVAL_SCOPE_CONTRACT_VERSION = 'V3-RET-003';
export const V3_RETRIEVAL_SCOPE_VERSION = 1;
const V3_RETRIEVAL_OBJECT_ANNOTATION_CONTRACT_VERSION='V3-RET-002-OBJECT-ANNOTATION-001';

type SourceRow = {id:string;account_id:string;conversation_id:string;external_message_id:string;direction:string;message_type:string;text:string|null;occurred_at:string;reply_to_external_message_id:string|null;arrival_seq:number|null;raw_ref:string|null};
type Source = Readonly<{id:string;accountId:string;conversationId:string;externalMessageId:string;direction:string;messageType:string;text:string;occurredAt:string;replyToExternalMessageId:string|null;arrivalSeq:number|null;rawRef:string|null}>;
export type V3RetrievalAttachmentRef = Readonly<{attachmentId:string;sourceMessageId:string;sourceRef:string}>;
export type V3RetrievalIndexInput = Readonly<{memory:V3ConversationMemory;requestedScope?:V3RetrievalRequestedScope}>;
export type V3RetrievalScope = Readonly<{tenantId:string;accountId:string;channelAccountId:string;conversationId:string;customerId:string|null}>;
export type V3RetrievalRequestedScope = Readonly<Partial<V3RetrievalScope>>;
export type V3RetrievalIndexEntry = Readonly<{sourceMessageId:string;externalMessageId:string;occurredAt:string;arrivalSeq:number|null;sourceRef:string}>;
export type V3SemanticPosting = Readonly<{term:string;sourceMessageIds:readonly string[]}>;
export type V3EntityPosting = Readonly<{objectType:string;objectId:string;sourceMessageIds:readonly string[]}>;
export type V3SectionPosting = Readonly<{sectionId:string;sourceMessageIds:readonly string[]}>;
export type V3ReplyPosting = Readonly<{sourceMessageId:string;replyToExternalMessageId:string|null;replyToSourceMessageId:string|null;threadRootSourceMessageId:string|null;childSourceMessageIds:readonly string[]}>;
export type V3RetrievalIndexes = Readonly<{
  contractVersion:'V3-RET-002';schemaVersion:1;authority:'NON_AUTHORITATIVE_DERIVED';untrustedAsInstruction:true;requiresCanonicalReverification:true;
  accountId:string;conversationId:string;sourceMessageIds:readonly string[];memoryDerivationVersion:string;memoryProjectionHash:string;objectAnnotationContractVersion:string;objectAnnotationFingerprint:string;
  scope:V3RetrievalScope;scopeVersion:string;scopeAudit:Readonly<{contractVersion:'V3-RET-003';derivation:'HOST_AUTHENTICATED_PRINCIPAL_IMMUTABLE_AGENT_TURN_CANONICAL_DB';authoritative:false;deterministic:true}>;
  chronology:readonly V3RetrievalIndexEntry[];semantic:readonly V3SemanticPosting[];entities:readonly V3EntityPosting[];sections:readonly V3SectionPosting[];replies:readonly V3ReplyPosting[];
  attachmentRefs:readonly V3RetrievalAttachmentRef[];
  indexVersion:string;rebuildMetadata:Readonly<{mode:'DISPOSABLE_IN_MEMORY_REBUILD';deterministic:true;sourceContractVersion:string;sourceFingerprint:string;memoryDerivationVersion:string;memoryProjectionHash:string;objectAnnotationContractVersion:string;objectAnnotationFingerprint:string;indexFingerprint:string}>;
}>;
export type V3RetrievedSource = Readonly<{source:Source;sourceRef:string;indexVersion:string;authority:'NON_AUTHORITATIVE_DERIVED';requiresCanonicalReverification:true}>;

function fail(code:string):never{throw new Error(`V3_RETRIEVAL_INDEX_INVALID:${code}`)}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value as Record<string,unknown>))freeze(child);Object.freeze(value)}return value}
function stringValue(value:unknown,code:string,max=256):string{if(typeof value!=='string'||value.trim()===''||value.length>max)fail(code);return value}
function uniqueIds(value:readonly string[],code:string):string[]{const ids=[...value];if(ids.some(id=>typeof id!=='string'||id.trim()===''||id.length>256)||new Set(ids).size!==ids.length)fail(code);return ids}
function compare(a:Source,b:Source):number{const aa=a.arrivalSeq,bb=b.arrivalSeq;if(aa!==null&&bb!==null&&aa!==bb)return aa-bb;return Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.externalMessageId.localeCompare(b.externalMessageId)||a.id.localeCompare(b.id)}
function terms(value:string):string[]{return [...new Set((value.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu)??[]))].sort()}
function sourceCandidate(row:SourceRow):Source{if(row.text===null)fail('SOURCE_MESSAGE_UNAVAILABLE');if(row.direction!=='INBOUND'&&row.direction!=='OUTBOUND')fail('SOURCE_MESSAGE_DIRECTION');if(!Number.isFinite(Date.parse(row.occurred_at)))fail('SOURCE_MESSAGE_TIME');return {id:row.id,accountId:row.account_id,conversationId:row.conversation_id,externalMessageId:row.external_message_id,direction:row.direction,messageType:row.message_type,text:row.text,occurredAt:row.occurred_at,replyToExternalMessageId:row.reply_to_external_message_id,arrivalSeq:row.arrival_seq,rawRef:row.raw_ref}}
function sourceIds(memory:V3ConversationMemory):string[]{const refs=[...memory.sections.flatMap(s=>s.sourceMessageIds),...memory.rollingMemory.sourceMessageIds];if(refs.some(id=>typeof id!=='string'||id.trim()===''||id.length>256))fail('SOURCE_MESSAGE_REFS');return [...new Set(refs)]}
function sourceRef(id:string):string{return `messages/${id}`}

function scopeFailure():never{throw new Error('V3_RETRIEVAL_SCOPE_UNAVAILABLE')}
export type V3RetrievalHostPrincipal=Readonly<{subject:string;tenantId:string;channelAccountId:string}>;
type AuthorityData={db:Database.Database;tenantId:string;channelAccountId:string;turnId:string};
function safeObject(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype}
function safeString(value:unknown):value is string{return typeof value==='string'&&value.trim()!==''&&value.length<=256}
function assertData(value:unknown,seen=new WeakSet<object>()):void{if(value===null||typeof value==='string'||typeof value==='boolean')return;if(typeof value==='number'){if(!Number.isFinite(value))scopeFailure();return}if(typeof value!=='object'||seen.has(value))scopeFailure();seen.add(value);const array=Array.isArray(value),proto=Object.getPrototypeOf(value);if((array&&proto!==Array.prototype)||(!array&&proto!==Object.prototype))scopeFailure();const descriptors=Object.getOwnPropertyDescriptors(value);for(const key of Reflect.ownKeys(value)){if(array&&key==='length')continue;const d=descriptors[key as keyof typeof descriptors];if(!d||!('value' in d)||!d.enumerable)scopeFailure();if(array&&(!/^(0|[1-9][0-9]*)$/.test(String(key))||Number(key)>=value.length))scopeFailure();assertData(d.value,seen)}if(array&&Object.keys(value).length!==value.length)scopeFailure();seen.delete(value)}
function validateRequestedScope(value:unknown):V3RetrievalRequestedScope|undefined{
  if(value===undefined)return undefined;if(!safeObject(value))scopeFailure();
  const allowed=['tenantId','accountId','channelAccountId','conversationId','customerId'];
  for(const key of Reflect.ownKeys(value)){if(typeof key!=='string'||!allowed.includes(key))scopeFailure();const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value' in d)||!d.enumerable||(!safeString(d.value)&&d.value!==null))scopeFailure()}
  return value as V3RetrievalRequestedScope;
}
function deriveScope(data:AuthorityData):V3RetrievalScope{
  const turn=data.db.prepare('SELECT t.account_id AS accountId,t.conversation_id AS conversationId,t.inbound_message_id AS inboundMessageId,c.channel_account_id AS channelAccountId,c.customer_id AS customerId FROM agent_turns t LEFT JOIN conversations c ON c.id=t.conversation_id WHERE t.id=?').get(data.turnId) as {accountId:string;conversationId:string;inboundMessageId:string;channelAccountId:string;customerId:string|null}|undefined;
  if(!turn||turn.accountId!==data.channelAccountId||turn.channelAccountId!==data.channelAccountId||!data.db.prepare("SELECT 1 FROM messages WHERE id=? AND account_id=? AND conversation_id=? AND direction='INBOUND'").get(turn.inboundMessageId,data.channelAccountId,turn.conversationId)||!data.db.prepare('SELECT 1 FROM channel_accounts WHERE id=?').get(data.channelAccountId)|| (turn.customerId!==null&&!data.db.prepare('SELECT 1 FROM customers WHERE id=?').get(turn.customerId)))scopeFailure();
  return {tenantId:data.tenantId,accountId:data.channelAccountId,channelAccountId:data.channelAccountId,conversationId:turn.conversationId,customerId:turn.customerId};
}
export type V3RetrievalHostAuthority = Readonly<{
  issue(turnId:string): V3RetrievalHostToken;
}>;
export type V3RetrievalHostToken = object;
type AuthorityRegistryEntry={issued:WeakMap<object,AuthorityData>};
const authorityRegistry=new WeakMap<object,AuthorityRegistryEntry>();
export function createV3RetrievalHostAuthority(db:Database.Database, principal:V3RetrievalHostPrincipal):V3RetrievalHostAuthority{
  if(!safeObject(principal)||!safeString(principal.subject)||!safeString(principal.tenantId)||!safeString(principal.channelAccountId))scopeFailure();
  const principalKeys=Reflect.ownKeys(principal);
  if(principalKeys.length!==3||principalKeys.some(key=>typeof key!=='string'||!['subject','tenantId','channelAccountId'].includes(key)))scopeFailure();
  for(const key of principalKeys){const descriptor=Object.getOwnPropertyDescriptor(principal,key);if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)scopeFailure()}
  const binding=Object.freeze({subject:principal.subject,tenantId:principal.tenantId,channelAccountId:principal.channelAccountId});
  const authority= {
    issue(turnId:string):V3RetrievalHostToken{
      if(!safeString(turnId))scopeFailure();
      const data={db,tenantId:binding.tenantId,channelAccountId:binding.channelAccountId,turnId};
      deriveScope(data);
      const token=Object.freeze(Object.create(null)) as object;
      authorityRegistry.get(authority)!.issued.set(token,data);
      return token;
    }
  };
  authorityRegistry.set(authority, {issued:new WeakMap<object,AuthorityData>()});
  return Object.freeze(authority);
}
function authority(value:unknown,db:Database.Database,token:unknown):AuthorityData{
  if(!value||typeof value!=='object'||(typeof token!=='object'&&typeof token!=='function')||token===null)scopeFailure();
  const entry=authorityRegistry.get(value as object);
  const data=entry?.issued.get(token as object);
  if(!data||data.db!==db)scopeFailure();
  return data;
}
function scopeVersion(scope:V3RetrievalScope):string{return `${V3_RETRIEVAL_SCOPE_CONTRACT_VERSION}:v${V3_RETRIEVAL_SCOPE_VERSION}:${canonicalSha256(scope)}`}
function assertScopedCandidate(scope:V3RetrievalScope,source:Source):void{if(source.accountId!==scope.accountId||source.conversationId!==scope.conversationId)scopeFailure()}

function canonicalEntities(db:Database.Database,accountId:string,conversationId:string,sources:Map<string,Source>,customerId:string|null):V3EntityPosting[]{
  if(customerId===null)return [];
  const candidates:Array<{objectType:string;objectId:string;sourceMessageId:string}> = [];
  const add=(objectType:string,rows:unknown[])=>{for(const row of rows as Array<{id:string;source_message_id:string}>){if(sources.has(row.source_message_id))candidates.push({objectType,objectId:row.id,sourceMessageId:row.source_message_id})}};
  add('WORK_ITEM',db.prepare("SELECT id,source_message_id FROM work_items WHERE account_id=? AND conversation_id=? AND customer_id=? AND source_message_id IS NOT NULL ORDER BY id").all(accountId,conversationId,customerId));
  add('ORDER_DRAFT',db.prepare("SELECT id,source_message_id FROM order_drafts WHERE account_id=? AND conversation_id=? AND customer_id=? AND source_message_id IS NOT NULL ORDER BY id").all(accountId,conversationId,customerId));
  add('QUOTATION',db.prepare("SELECT id,source_message_id FROM quotations WHERE source_conversation_id=? AND customer_id=? AND source_message_id IS NOT NULL ORDER BY id").all(conversationId,customerId));
  add('QUOTATION_ACCEPTANCE',db.prepare("SELECT a.id,a.message_id AS source_message_id FROM quotation_acceptances a JOIN quotations q ON q.id=a.quotation_id WHERE q.source_conversation_id=? AND q.customer_id=? ORDER BY a.id").all(conversationId,customerId));
  add('SALES_ORDER',db.prepare("SELECT so.id,so.source_acceptance_message_id AS source_message_id FROM sales_orders so JOIN quotations q ON q.id=so.source_quotation_id JOIN quotation_acceptances a ON a.quotation_id=q.id AND a.message_id=so.source_acceptance_message_id WHERE q.source_conversation_id=? AND q.customer_id=? AND so.customer_id=? ORDER BY so.id").all(conversationId,customerId,customerId));
  return candidates.sort((a,b)=>a.objectType.localeCompare(b.objectType)||a.objectId.localeCompare(b.objectId)||a.sourceMessageId.localeCompare(b.sourceMessageId)).map(({objectType,objectId,sourceMessageId})=>({objectType,objectId,sourceMessageIds:[sourceMessageId]}));
}

class V3RetrievalIndexService {
  private readonly auth:AuthorityData;
  constructor(private readonly db:Database.Database,hostAuthority:V3RetrievalHostAuthority,token:unknown){this.auth=authority(hostAuthority,db,token)}
  build(input:V3RetrievalIndexInput):V3RetrievalIndexes{
    if(!safeObject(input))scopeFailure();
    const keys=Reflect.ownKeys(input);if(keys.some(k=>typeof k!=='string'||!['memory','requestedScope'].includes(k)))scopeFailure();
    for(const key of keys){const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!('value' in d)||!d.enumerable)scopeFailure()}
    const accountId=this.auth.channelAccountId,scope=deriveScope(this.auth),conversationId=scope.conversationId;
    const requested=validateRequestedScope((input as Record<string,unknown>).requestedScope);
    if(requested)for(const key of ['tenantId','accountId','channelAccountId','conversationId','customerId'] as const)if(Object.prototype.hasOwnProperty.call(requested,key)&&requested[key]!==scope[key])scopeFailure();
    const memory=input.memory;assertData(memory);
    if(memory.accountId!==accountId||memory.conversationId!==conversationId)scopeFailure();
    if(memory.contractVersion!=='V3-CTX-004'||memory.schemaVersion!==1||memory.authority!=='NON_AUTHORITATIVE_DERIVED'||memory.untrustedAsInstruction!==true||memory.requiresCanonicalReverification!==true)fail('MEMORY_CONTRACT');
    if(!this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND channel_account_id=?').get(conversationId,accountId))fail('CONVERSATION_SCOPE');
    const validated=validateV3ConversationMemory(this.db,{accountId,conversationId,memory}),ids=sourceIds(memory),sources=new Map<string,Source>();
    for(const id of ids){const row=this.db.prepare('SELECT id,account_id,conversation_id,external_message_id,direction,message_type,text,occurred_at,reply_to_external_message_id,arrival_seq,raw_ref FROM messages WHERE id=? AND account_id=? AND conversation_id=?').get(id,accountId,conversationId) as SourceRow|undefined;if(!row)scopeFailure();const source=sourceCandidate(row);assertScopedCandidate(scope,source);sources.set(id,source)}
    const chronology=[...sources.values()].sort(compare).map(s=>({sourceMessageId:s.id,externalMessageId:s.externalMessageId,occurredAt:s.occurredAt,arrivalSeq:s.arrivalSeq,sourceRef:sourceRef(s.id)}));
    const semanticMap=new Map<string,string[]>();for(const s of sources.values())for(const term of terms(s.text)){const posting=semanticMap.get(term)??[];posting.push(s.id);semanticMap.set(term,posting)}
    const semantic=[...semanticMap].sort(([a],[b])=>a.localeCompare(b)).map(([term,sourceMessageIds])=>({term,sourceMessageIds:sourceMessageIds.sort((a,b)=>compare(sources.get(a)!,sources.get(b)!))}));
    if(Object.prototype.hasOwnProperty.call(input,'objectRefs'))fail('OBJECT_ANNOTATION_CALLER_INPUT_FORBIDDEN');
    const customerRow=this.db.prepare('SELECT customer_id FROM conversations WHERE id=? AND channel_account_id=?').get(conversationId,accountId) as {customer_id:string|null};
    const entities=canonicalEntities(this.db,accountId,conversationId,sources,customerRow.customer_id);
    const sections=memory.sections.map(section=>({sectionId:section.id,sourceMessageIds:[...section.sourceMessageIds]})).sort((a,b)=>a.sectionId.localeCompare(b.sectionId));
    const byExternal=new Map<string,Source>();for(const s of sources.values()){if(byExternal.has(s.externalMessageId))fail('REPLY_EXTERNAL_ID_AMBIGUOUS');byExternal.set(s.externalMessageId,s)}
    const rootFor=(start:Source):string|null=>{const seen=new Set<string>();let current=start;while(current.replyToExternalMessageId){if(seen.has(current.id))fail('REPLY_CYCLE');seen.add(current.id);const parent=byExternal.get(current.replyToExternalMessageId);if(!parent)return null;current=parent}return current.id};
    const replies=[...sources.values()].sort(compare).map(s=>{const target=s.replyToExternalMessageId?byExternal.get(s.replyToExternalMessageId):undefined;const children=[...sources.values()].filter(child=>child.replyToExternalMessageId===s.externalMessageId).sort(compare).map(child=>child.id);return {sourceMessageId:s.id,replyToExternalMessageId:s.replyToExternalMessageId,replyToSourceMessageId:target?.id??null,threadRootSourceMessageId:rootFor(s),childSourceMessageIds:children}});
    const attachments=[...sources.values()].filter(s=>s.rawRef!==null&&s.rawRef.trim()!=='').map(s=>({attachmentId:'raw-ref:'+s.id,sourceMessageId:s.id,sourceRef:s.rawRef!}));
    const objectAnnotationFingerprint=canonicalSha256(entities),sourceFingerprint=canonicalSha256({accountId,conversationId,sources:[...sources.values()].sort(compare)}),scopeVersionValue=scopeVersion(scope),scopeAudit={contractVersion:V3_RETRIEVAL_SCOPE_CONTRACT_VERSION as 'V3-RET-003',derivation:'HOST_AUTHENTICATED_PRINCIPAL_IMMUTABLE_AGENT_TURN_CANONICAL_DB' as const,authoritative:false as const,deterministic:true as const},body={contractVersion:V3_RETRIEVAL_INDEX_CONTRACT_VERSION as 'V3-RET-002',schemaVersion:V3_RETRIEVAL_INDEX_SCHEMA_VERSION as 1,accountId,conversationId,scope,scopeVersion:scopeVersionValue,scopeAudit,sourceMessageIds:ids,memoryDerivationVersion:validated.memory.derivationVersion,memoryProjectionHash:validated.memory.projectionHash,objectAnnotationContractVersion:V3_RETRIEVAL_OBJECT_ANNOTATION_CONTRACT_VERSION,objectAnnotationFingerprint,chronology,semantic,entities,sections,replies,attachmentRefs:attachments};
    const indexVersion=`${V3_RETRIEVAL_INDEX_CONTRACT_VERSION}:v${V3_RETRIEVAL_INDEX_SCHEMA_VERSION}:${canonicalSha256(body)}`,indexFingerprint=canonicalSha256({...body,indexVersion});
    return freeze({...body,authority:'NON_AUTHORITATIVE_DERIVED' as const,untrustedAsInstruction:true as const,requiresCanonicalReverification:true as const,indexVersion,rebuildMetadata:{mode:'DISPOSABLE_IN_MEMORY_REBUILD' as const,deterministic:true as const,sourceContractVersion:'V3-CTX-004',sourceFingerprint,memoryDerivationVersion:validated.memory.derivationVersion,memoryProjectionHash:validated.memory.projectionHash,objectAnnotationContractVersion:V3_RETRIEVAL_OBJECT_ANNOTATION_CONTRACT_VERSION,objectAnnotationFingerprint,indexFingerprint}});
  }
  reopenSource(index:V3RetrievalIndexes,sourceMessageId:string,currentMemory:V3ConversationMemory):V3RetrievedSource{
    const id=stringValue(sourceMessageId,'SOURCE_MESSAGE_ID');if(index.contractVersion!==V3_RETRIEVAL_INDEX_CONTRACT_VERSION||index.schemaVersion!==1||index.authority!=='NON_AUTHORITATIVE_DERIVED'||index.untrustedAsInstruction!==true||index.requiresCanonicalReverification!==true)fail('INDEX_CONTRACT');if(!index.sourceMessageIds.includes(id))scopeFailure();
    const scope=deriveScope(this.auth);if(index.scopeVersion!==scopeVersion(scope)||JSON.stringify(index.scope)!==JSON.stringify(scope)||!index.scopeAudit||index.scopeAudit.contractVersion!==V3_RETRIEVAL_SCOPE_CONTRACT_VERSION||index.scopeAudit.derivation!=='HOST_AUTHENTICATED_PRINCIPAL_IMMUTABLE_AGENT_TURN_CANONICAL_DB'||index.scopeAudit.authoritative!==false||index.scopeAudit.deterministic!==true)scopeFailure();
    const body={contractVersion:index.contractVersion,schemaVersion:index.schemaVersion,accountId:index.accountId,conversationId:index.conversationId,scope:index.scope,scopeVersion:index.scopeVersion,scopeAudit:index.scopeAudit,sourceMessageIds:index.sourceMessageIds,memoryDerivationVersion:index.memoryDerivationVersion,memoryProjectionHash:index.memoryProjectionHash,objectAnnotationContractVersion:index.objectAnnotationContractVersion,objectAnnotationFingerprint:index.objectAnnotationFingerprint,chronology:index.chronology,semantic:index.semantic,entities:index.entities,sections:index.sections,replies:index.replies,attachmentRefs:index.attachmentRefs};
    if(!currentMemory)fail('INDEX_PROVENANCE');
    const validatedMemory=validateV3ConversationMemory(this.db,{accountId:index.accountId,conversationId:index.conversationId,memory:currentMemory}).memory;
    if(validatedMemory.derivationVersion!==index.memoryDerivationVersion||validatedMemory.projectionHash!==index.memoryProjectionHash)fail('MEMORY_STALE');
    const currentMemorySourceIds=sourceIds(validatedMemory);
    if(currentMemorySourceIds.length!==index.sourceMessageIds.length||currentMemorySourceIds.some((sourceId,position)=>sourceId!==index.sourceMessageIds[position]))fail('INDEX_SOURCE_SET');
    if(index.indexVersion!==`${V3_RETRIEVAL_INDEX_CONTRACT_VERSION}:v${V3_RETRIEVAL_INDEX_SCHEMA_VERSION}:${canonicalSha256(body)}`||index.rebuildMetadata.indexFingerprint!==canonicalSha256({...body,indexVersion:index.indexVersion}))fail('INDEX_PROVENANCE');
    const row=this.db.prepare('SELECT id,account_id,conversation_id,external_message_id,direction,message_type,text,occurred_at,reply_to_external_message_id,arrival_seq,raw_ref FROM messages WHERE id=? AND account_id=? AND conversation_id=?').get(id,index.accountId,index.conversationId) as SourceRow|undefined;if(!row)scopeFailure();const source=sourceCandidate(row);assertScopedCandidate(scope,source);const expected=index.rebuildMetadata.sourceFingerprint;
    const currentSources=new Map(index.sourceMessageIds.map(sourceId=>{const r=this.db.prepare('SELECT id,account_id,conversation_id,external_message_id,direction,message_type,text,occurred_at,reply_to_external_message_id,arrival_seq,raw_ref FROM messages WHERE id=? AND account_id=? AND conversation_id=?').get(sourceId,index.accountId,index.conversationId) as SourceRow|undefined;if(!r)scopeFailure();const candidate=sourceCandidate(r);assertScopedCandidate(scope,candidate);return [sourceId,candidate] as const}));
    const current=canonicalSha256({accountId:index.accountId,conversationId:index.conversationId,sources:[...currentSources.values()].sort(compare)});if(expected!==current)fail('INDEX_STALE');
    const customerRow=this.db.prepare('SELECT customer_id FROM conversations WHERE id=? AND channel_account_id=?').get(index.conversationId,index.accountId) as {customer_id:string|null}|undefined;if(!customerRow)fail('CONVERSATION_SCOPE');
    const currentEntities=canonicalEntities(this.db,index.accountId,index.conversationId,currentSources,customerRow.customer_id);if(canonicalSha256(currentEntities)!==index.objectAnnotationFingerprint)fail('INDEX_STALE_ENTITIES');
    return freeze({source,sourceRef:sourceRef(id),indexVersion:index.indexVersion,authority:'NON_AUTHORITATIVE_DERIVED' as const,requiresCanonicalReverification:true as const});
  }
}
export function buildV3RetrievalIndexes(db:Database.Database,hostAuthority:V3RetrievalHostAuthority,token:V3RetrievalHostToken,input:V3RetrievalIndexInput):V3RetrievalIndexes{return new V3RetrievalIndexService(db,hostAuthority,token).build(input)}
export function reopenV3RetrievalSource(db:Database.Database,hostAuthority:V3RetrievalHostAuthority,token:V3RetrievalHostToken,index:V3RetrievalIndexes,sourceMessageId:string,currentMemory:V3ConversationMemory):V3RetrievedSource{return new V3RetrievalIndexService(db,hostAuthority,token).reopenSource(index,sourceMessageId,currentMemory)}
