import {isProxy} from 'node:util/types';
import {canonicalSha256} from './v2-canonical.js';
import {verifyV3AttachmentEvidence, type V3AttachmentEvidenceRecord} from './v3-attachment-evidence.js';
import {type V3AttachmentExtractionResult} from './v3-attachment-extraction.js';
import {type V3AttachmentSourceRecord} from './v3-attachment-source.js';
import {type V3RetrievalScope} from './v3-retrieval-index.js';

export const V3_ATTACHMENT_RETRIEVAL_CONTRACT_VERSION = 'V3-MM-004' as const;

type Extraction = V3AttachmentExtractionResult;
type Source = V3AttachmentSourceRecord;
type Scope = V3RetrievalScope;
type Citation = Readonly<{evidenceId:string;attachmentId:string;sourceMessageId:string;sourceRef:string;pageNumber:number|null;regionRef:string|null;timeRange:Readonly<{start:number;end:number}|null>;freshnessState:V3AttachmentEvidenceRecord['freshnessState']}>;
type Common = Readonly<{contractVersion:'V3-MM-004';schemaVersion:1;authority:'NON_AUTHORITATIVE_DERIVED';untrustedAsInstruction:true;grantsEffects:false;requiresCanonicalReverification:true;aiAuthorityCutoff:'SALES_ORDER.DRAFT';deterministic:true;bounded:true;scopeLineage:Scope}>;
export type V3AttachmentSearchRequest = Readonly<{query:string;limit?:number}>;
export type V3AttachmentReadRequest = Readonly<{evidenceId:string}>;
export type V3AttachmentSearchHit = Readonly<{evidenceId:string;attachmentId:string;extractionType:Extraction['extractionKind'];snippet:string;citation:Citation}>;
export type V3AttachmentReadResult = Common & Readonly<{tool:'attachment_read';evidenceId:string;attachmentId:string;extractionType:Extraction['extractionKind'];output:NonNullable<Extraction['output']>;citation:Citation}>;
export type V3AttachmentSearchResult = Common & Readonly<{tool:'attachment_search';queryTerms:readonly string[];order:'MATCH_COUNT_DESC_THEN_SOURCE_ID';hits:readonly V3AttachmentSearchHit[]}>;
export type V3AttachmentRetrieval = Readonly<{attachment_search(request:V3AttachmentSearchRequest):V3AttachmentSearchResult;attachment_read(request:V3AttachmentReadRequest):V3AttachmentReadResult}>;

const DEFAULT_LIMIT=10, MAX_LIMIT=20, MAX_QUERY=512, MAX_TERMS=24, MAX_SNIPPET=512;
const SCOPE_KEYS=['tenantId','accountId','channelAccountId','conversationId','customerId'] as const;
const EXTRACTION_KEYS=['contractVersion','schemaVersion','status','errorCode','adapterId','adapterVersion','mediaKind','extractionKind','source','output','outputFingerprint','evidence','authority','untrustedAsInstruction','grantsEffects','aiAuthorityCutoff','deterministic','bounded'] as const;
const OUTPUT_KEYS={text:['text'],description:['description'],table:['columns','rows']} as const;

function fail(code:string):never{throw new Error(`V3_ATTACHMENT_RETRIEVAL_INVALID:${code}`)}
function plain(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)&&!isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype}
function frozen(value:unknown,seen=new WeakSet<object>()):boolean{if(value===null||typeof value!=='object')return true;if(isProxy(value)||seen.has(value)||!Object.isFrozen(value))return false;seen.add(value);for(const child of Object.values(value as Record<string,unknown>))if(!frozen(child,seen))return false;seen.delete(value);return true}
function closed(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!plain(value)||!frozen(value))fail('IMMUTABLE_INPUT');const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail('CLOSED_INPUT');for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!('value'in d))fail('ACCESSOR')}return value}
function text(value:unknown,code:string,max=512):string{if(typeof value!=='string'||value.trim()===''||Buffer.byteLength(value,'utf8')>max)fail(code);return value}
function scope(value:unknown):Scope{const c=closed(value,SCOPE_KEYS);for(const key of SCOPE_KEYS)if(key==='customerId'?c[key]!==null:text(c[key],'SCOPE')){}return c as Scope}
function sameScope(a:Scope,b:Scope):boolean{return SCOPE_KEYS.every(key=>a[key]===b[key])}
function terms(value:string):string[]{return [...new Set((value.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu)??[]))].sort()}
function request(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!plain(value)||isProxy(value))fail('REQUEST_SHAPE');const own=Reflect.ownKeys(value);if(own.some(k=>typeof k!=='string'||!keys.includes(k)))fail('REQUEST_FIELD');for(const key of own){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!('value'in d))fail('REQUEST_ACCESSOR')}return value}
function sourceValid(source:Source, expected:Scope):void{closed(source,['contractVersion','schemaVersion','authority','untrustedAsInstruction','grantsEffects','aiAuthorityCutoff','deterministic','bounded','scope','attachmentId','sourceMessageId','sourceRef','mimeType','byteLength','contentSha256','recordFingerprint']);if(source.contractVersion!=='V3-MM-001'||source.schemaVersion!==1||source.authority!=='NON_AUTHORITATIVE_DERIVED'||source.untrustedAsInstruction!==true||source.grantsEffects!==false||source.aiAuthorityCutoff!=='SALES_ORDER.DRAFT'||source.deterministic!==true||source.bounded!==true||!sameScope(scope(source.scope),expected)||typeof source.byteLength!=='number'||!Number.isSafeInteger(source.byteLength)||source.byteLength<1||!/^[a-f0-9]{64}$/.test(source.contentSha256)||source.recordFingerprint!==canonicalSha256((({recordFingerprint:_ignored,...body})=>body)(source)))fail('SOURCE_INTEGRITY')}
function outputText(output:NonNullable<Extraction['output']>):string{if('text'in output)return output.text;if('description'in output)return output.description;return `${output.columns.join(' ')} ${output.rows.map(row=>row.join(' ')).join(' ')}`}
function validateExtraction(extraction:Extraction,source:Source,expected:Scope):V3AttachmentEvidenceRecord{closed(extraction,EXTRACTION_KEYS);if(extraction.contractVersion!=='V3-MM-003'||extraction.schemaVersion!==1||extraction.status!=='SUCCEEDED'||extraction.authority!=='NON_AUTHORITATIVE_DERIVED'||extraction.untrustedAsInstruction!==true||extraction.grantsEffects!==false||extraction.aiAuthorityCutoff!=='SALES_ORDER.DRAFT'||extraction.deterministic!==true||extraction.bounded!==true||!extraction.output||extraction.outputFingerprint!==canonicalSha256(extraction.output)||!extraction.evidence)fail('EXTRACTION_INTEGRITY');const sourceRef=extraction.source;if(!plain(sourceRef)||!frozen(sourceRef)||sourceRef.attachmentId!==source.attachmentId||sourceRef.sourceMessageId!==source.sourceMessageId||sourceRef.sourceRef!==source.sourceRef||sourceRef.sourceFingerprint!==source.recordFingerprint)fail('SOURCE_COHERENCE');const evidence=extraction.evidence;verifyV3AttachmentEvidence(evidence,source);if(!sameScope(scope(evidence.scope),expected)||evidence.evidenceId!==extraction.evidence.evidenceId||evidence.extractionType!==extraction.extractionKind)fail('EVIDENCE_COHERENCE');return evidence}
function citation(evidence:V3AttachmentEvidenceRecord):Citation{return {evidenceId:evidence.evidenceId,attachmentId:evidence.attachmentId,sourceMessageId:evidence.sourceMessageId,sourceRef:evidence.sourceRef,pageNumber:evidence.pageNumber,regionRef:evidence.regionRef,timeRange:evidence.timeRange,freshnessState:evidence.freshnessState}}
function common(scopeLineage:Scope):Common{return {contractVersion:'V3-MM-004',schemaVersion:1,authority:'NON_AUTHORITATIVE_DERIVED',untrustedAsInstruction:true,grantsEffects:false,requiresCanonicalReverification:true,aiAuthorityCutoff:'SALES_ORDER.DRAFT',deterministic:true,bounded:true,scopeLineage}}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value as Record<string,unknown>))freeze(child);Object.freeze(value)}return value}

export function createV3AttachmentRetrieval(hostScope:Scope,sources:readonly Source[],extractions:readonly Extraction[]):V3AttachmentRetrieval{
  if(!frozen(hostScope)||!frozen(sources)||!frozen(extractions))fail('IMMUTABLE_INPUT');const expected=scope(hostScope), sourceById=new Map<string,Source>();
  for(const source of sources){sourceValid(source,expected);if(sourceById.has(source.attachmentId))fail('DUPLICATE_ATTACHMENT');sourceById.set(source.attachmentId,source)}
  const records=extractions.map(extraction=>{const attachmentId=extraction.source.attachmentId;const source=sourceById.get(attachmentId);if(!source)fail('SOURCE_MISSING');const evidence=validateExtraction(extraction,source,expected);return {extraction,evidence,source,text:outputText(extraction.output!)}});
  const byEvidence=new Map(records.map(record=>[record.evidence.evidenceId,record]));if(byEvidence.size!==records.length)fail('DUPLICATE_EVIDENCE');
  const api={
    attachment_search(input:V3AttachmentSearchRequest):V3AttachmentSearchResult{const r=request(input,['query','limit']);const query=text(r.query,'QUERY',MAX_QUERY), queryTerms=terms(query);if(queryTerms.length===0||queryTerms.length>MAX_TERMS)fail('QUERY_TERMS');const limit=r.limit===undefined?DEFAULT_LIMIT:r.limit;if(typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>MAX_LIMIT)fail('LIMIT');const ranked=records.map(record=>{const haystack=terms(`${record.text} ${record.source.sourceRef} ${record.evidence.extractionType}`);const matched=queryTerms.filter(term=>haystack.includes(term));return {record,score:matched.length}}).filter(hit=>hit.score>0).sort((a,b)=>b.score-a.score||a.record.evidence.sourceMessageId.localeCompare(b.record.evidence.sourceMessageId)||a.record.evidence.evidenceId.localeCompare(b.record.evidence.evidenceId)).slice(0,limit);const hits=ranked.map(({record})=>({evidenceId:record.evidence.evidenceId,attachmentId:record.source.attachmentId,extractionType:record.extraction.extractionKind,snippet:record.text.slice(0,MAX_SNIPPET),citation:citation(record.evidence)}));return freeze({...common(expected),tool:'attachment_search' as const,queryTerms,order:'MATCH_COUNT_DESC_THEN_SOURCE_ID' as const,hits})},
    attachment_read(input:V3AttachmentReadRequest):V3AttachmentReadResult{const r=request(input,['evidenceId']);const id=text(r.evidenceId,'EVIDENCE_ID');const record=byEvidence.get(id);if(!record)throw new Error('V3_ATTACHMENT_RETRIEVAL_UNAVAILABLE');return freeze({...common(expected),tool:'attachment_read' as const,evidenceId:id,attachmentId:record.source.attachmentId,extractionType:record.extraction.extractionKind,output:record.extraction.output!,citation:citation(record.evidence)})}
  };
  return Object.freeze(api);
}
