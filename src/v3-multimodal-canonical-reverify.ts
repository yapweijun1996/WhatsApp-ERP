import {isProxy} from 'node:util/types';
import {V1Database} from './database.js';
import {OrderValidationService} from './v2-order-validation.js';
import type {V3AttachmentReadResult} from './v3-attachment-retrieval.js';
import type {V3RetrievalScope} from './v3-retrieval-index.js';

export const V3_MULTIMODAL_CANONICAL_REVERIFY_CONTRACT_VERSION='V3-MM-006' as const;
type Scope=V3RetrievalScope;
type PriceClaim=Readonly<{kind:'PRICE';draftId:string;draftRevision:number;lineNo:number;productId:string;unitPriceCents:number}>;
type StockClaim=Readonly<{kind:'STOCK';draftId:string;draftRevision:number;lineNo:number;available:boolean}>;
type StatusClaim=Readonly<{kind:'STATUS';objectType:'QUOTATION'|'SALES_ORDER';objectId:string;status:string}>;
export type V3HistoricalMediaClaim=PriceClaim|StockClaim|StatusClaim;
export type V3MultimodalCanonicalReverifyResult=Readonly<{
  contractVersion:typeof V3_MULTIMODAL_CANONICAL_REVERIFY_CONTRACT_VERSION;schemaVersion:1;
  authority:'HOST_REVERIFIED_CANONICAL_ERP';historicalAuthority:'NON_AUTHORITATIVE_DERIVED';
  untrustedHistoricalMedia:true;grantsEffects:false;requiresSideEffectAdmission:true;aiAuthorityCutoff:'SALES_ORDER.DRAFT';
  verdict:'CURRENT_ERP_MATCH'|'REPLAN_REQUIRED';reasonCode:'MATCH'|'HISTORICAL_MEDIA_CONFLICT'|'HISTORICAL_EVIDENCE_STALE'|'CANONICAL_REVERIFY_REQUIRED';
  historicalEvidenceRef:Readonly<{evidenceId:string;attachmentId:string;sourceMessageId:string}>;
  canonicalEvidenceRefs:readonly string[];mayUseForConsequentialDecision:boolean;
}>;
const SCOPE_KEYS=['tenantId','accountId','channelAccountId','conversationId','customerId'] as const;
function fail(code:string):never{throw new Error(`V3_MM006_INVALID:${code}`)}
function plain(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)&&!isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype}
function data(value:unknown,code:string,allowed?:readonly string[]):Record<string,unknown>{if(!plain(value))fail(code);const keys=Reflect.ownKeys(value);if(allowed&&(keys.length!==allowed.length||keys.some(k=>typeof k!=='string'||!allowed.includes(k))))fail(code);for(const key of keys){if(typeof key!=='string')fail(code);const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!('value'in d))fail(code)}return value}
function text(value:unknown,code:string,max=512):string{if(typeof value!=='string'||value.trim()===''||Buffer.byteLength(value,'utf8')>max)fail(code);return value}
function int(value:unknown,code:string,min=0):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min)fail(code);return value}
function bool(value:unknown,code:string):boolean{if(typeof value!=='boolean')fail(code);return value}
function scope(value:unknown):Scope{const c=data(value,'SCOPE',SCOPE_KEYS);for(const key of SCOPE_KEYS){if(key==='customerId'){if(c[key]!==null)text(c[key],'SCOPE')}else text(c[key],'SCOPE')}return c as Scope}
function freeze<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value as Record<string,unknown>))freeze(child);Object.freeze(value)}return value}
function attachment(read:V3AttachmentReadResult):Scope{
  const c=data(read,'ATTACHMENT_READ');
  if(c.contractVersion!=='V3-MM-004'||c.schemaVersion!==1||c.authority!=='NON_AUTHORITATIVE_DERIVED'||c.untrustedAsInstruction!==true||c.grantsEffects!==false||c.requiresCanonicalReverification!==true||c.aiAuthorityCutoff!=='SALES_ORDER.DRAFT'||c.deterministic!==true||c.bounded!==true||c.tool!=='attachment_read')fail('ATTACHMENT_CONTRACT');
  const expected=scope(c.scopeLineage);text(c.evidenceId,'EVIDENCE_ID');text(c.attachmentId,'ATTACHMENT_ID');
  const citation=data(c.citation,'CITATION');if(citation.evidenceId!==c.evidenceId||citation.attachmentId!==c.attachmentId)fail('CITATION_BINDING');text(citation.sourceMessageId,'SOURCE_MESSAGE_ID');
  if(!['CURRENT','STALE','SUPERSEDED','INVALIDATED'].includes(String(citation.freshnessState)))fail('EVIDENCE_FRESHNESS');
  return expected;
}
function claim(value:unknown):V3HistoricalMediaClaim{
  const c=data(value,'CLAIM');
  if(c.kind==='PRICE'){const keys=['kind','draftId','draftRevision','lineNo','productId','unitPriceCents'];data(value,'PRICE_CLAIM',keys);return {kind:'PRICE',draftId:text(c.draftId,'DRAFT_ID'),draftRevision:int(c.draftRevision,'DRAFT_REVISION',1),lineNo:int(c.lineNo,'LINE_NO',1),productId:text(c.productId,'PRODUCT_ID'),unitPriceCents:int(c.unitPriceCents,'PRICE')}}
  if(c.kind==='STOCK'){const keys=['kind','draftId','draftRevision','lineNo','available'];data(value,'STOCK_CLAIM',keys);return {kind:'STOCK',draftId:text(c.draftId,'DRAFT_ID'),draftRevision:int(c.draftRevision,'DRAFT_REVISION',1),lineNo:int(c.lineNo,'LINE_NO',1),available:bool(c.available,'AVAILABLE')}}
  if(c.kind==='STATUS'){const keys=['kind','objectType','objectId','status'];data(value,'STATUS_CLAIM',keys);if(c.objectType!=='QUOTATION'&&c.objectType!=='SALES_ORDER')fail('OBJECT_TYPE');return {kind:'STATUS',objectType:c.objectType,objectId:text(c.objectId,'OBJECT_ID'),status:text(c.status,'STATUS',120)}}
  fail('CLAIM_KIND');
}
function assertCanonicalScope(database:V1Database,expected:Scope):void{
  const row=database.db.prepare('SELECT c.channel_account_id AS accountId,c.id AS conversationId,c.customer_id AS customerId FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id WHERE c.id=? AND c.channel_account_id=?').get(expected.conversationId,expected.accountId) as {accountId:string;conversationId:string;customerId:string|null}|undefined;
  if(!row||row.accountId!==expected.accountId||expected.channelAccountId!==expected.accountId||row.conversationId!==expected.conversationId||row.customerId!==expected.customerId)fail('CANONICAL_SCOPE');
}
function assertDraftScope(database:V1Database,expected:Scope,draftId:string,revision:number):'CURRENT'|'STALE'{
  const row=database.db.prepare("SELECT id,account_id AS accountId,conversation_id AS conversationId,customer_id AS customerId,current_revision AS revision FROM order_drafts WHERE id=? AND status='CURRENT'").get(draftId) as {id:string;accountId:string;conversationId:string;customerId:string;revision:number}|undefined;
  if(!row||row.accountId!==expected.accountId||row.conversationId!==expected.conversationId||row.customerId!==expected.customerId)fail('DRAFT_SCOPE');
  return row.revision===revision?'CURRENT':'STALE';
}
function base(read:V3AttachmentReadResult){return {contractVersion:V3_MULTIMODAL_CANONICAL_REVERIFY_CONTRACT_VERSION,schemaVersion:1 as const,authority:'HOST_REVERIFIED_CANONICAL_ERP' as const,historicalAuthority:'NON_AUTHORITATIVE_DERIVED' as const,untrustedHistoricalMedia:true as const,grantsEffects:false as const,requiresSideEffectAdmission:true as const,aiAuthorityCutoff:'SALES_ORDER.DRAFT' as const,historicalEvidenceRef:{evidenceId:read.evidenceId,attachmentId:read.attachmentId,sourceMessageId:read.citation.sourceMessageId}}}
function decision(read:V3AttachmentReadResult,match:boolean,reason:'HISTORICAL_MEDIA_CONFLICT'|'CANONICAL_REVERIFY_REQUIRED',refs:readonly string[]=[]):V3MultimodalCanonicalReverifyResult{return freeze({...base(read),verdict:match?'CURRENT_ERP_MATCH' as const:'REPLAN_REQUIRED' as const,reasonCode:match?'MATCH' as const:reason,canonicalEvidenceRefs:Object.freeze([...refs]),mayUseForConsequentialDecision:match})}
/** Host-only MM-006 gate. Caller-supplied canonical ERP values are never accepted. */
export async function reverifyV3HistoricalMediaForConsequentialDecision(database:V1Database,input:Readonly<{attachmentRead:V3AttachmentReadResult;claim:V3HistoricalMediaClaim}>):Promise<V3MultimodalCanonicalReverifyResult>{
  if(!(database instanceof V1Database)||Object.getPrototypeOf(database)!==V1Database.prototype)fail('HOST_DATABASE');
  const i=data(input,'INPUT',['attachmentRead','claim']),read=i.attachmentRead as V3AttachmentReadResult,expected=attachment(read),c=claim(i.claim);
  assertCanonicalScope(database,expected);
  if(read.citation.freshnessState!=='CURRENT')return freeze({...base(read),verdict:'REPLAN_REQUIRED',reasonCode:'HISTORICAL_EVIDENCE_STALE',canonicalEvidenceRefs:Object.freeze([] as string[]),mayUseForConsequentialDecision:false});
  if(c.kind==='PRICE'||c.kind==='STOCK'){
    if(assertDraftScope(database,expected,c.draftId,c.draftRevision)==='STALE')return decision(read,false,'CANONICAL_REVERIFY_REQUIRED');
    const current=await new OrderValidationService(database).validateDraft({draftId:c.draftId,revision:c.draftRevision});
    if(current.status!=='SUCCEEDED'||!current.data){
      if(c.kind==='STOCK'&&c.available===true&&current.reasonCode==='STOCK_SHORTAGE')return decision(read,false,'HISTORICAL_MEDIA_CONFLICT',current.evidence.map(e=>e.sourceId));
      return decision(read,false,'CANONICAL_REVERIFY_REQUIRED',current.evidence.map(e=>e.sourceId));
    }
    const line=current.data.lines.find(line=>line.lineNo===c.lineNo);if(!line)return decision(read,false,'CANONICAL_REVERIFY_REQUIRED',current.data.evidenceRefs);
    const match=c.kind==='PRICE'?(line.productId===c.productId&&line.unitPriceCents===c.unitPriceCents):c.available===true;
    return decision(read,match,'HISTORICAL_MEDIA_CONFLICT',current.data.evidenceRefs);
  }
  const row=c.objectType==='QUOTATION'
    ? database.db.prepare('SELECT q.id,q.status FROM quotations q WHERE q.id=? AND q.source_conversation_id=? AND q.customer_id=?').get(c.objectId,expected.conversationId,expected.customerId)
    : database.db.prepare('SELECT so.id,so.status FROM sales_orders so JOIN quotations q ON q.id=so.source_quotation_id WHERE so.id=? AND q.source_conversation_id=? AND so.customer_id=? AND q.customer_id=?').get(c.objectId,expected.conversationId,expected.customerId,expected.customerId);
  if(!row||!plain(row))return decision(read,false,'CANONICAL_REVERIFY_REQUIRED');
  const status=text((row as Record<string,unknown>).status,'CURRENT_STATUS',120);
  return decision(read,status===c.status,'HISTORICAL_MEDIA_CONFLICT');
}
