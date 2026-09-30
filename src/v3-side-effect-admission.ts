import type Database from 'better-sqlite3';
import {canonicalSha256} from './v2-canonical.js';
import {validateV3FreshnessVector} from './v3-freshness-vector.js';
import {validateInboundBundle, type InboundBundle} from './v3-inbound-bundle.js';
import {validateContextSnapshot} from './v3-context-snapshot.js';
import {V1Database} from './database.js';

export const V3_SIDE_EFFECT_ADMISSION_CONTRACT_VERSION='V3-CP-004';
export type V3SideEffectAdmissionInput=Readonly<{
  bundle: unknown; context: unknown; freshnessVector: unknown; lease: unknown;
  arrivalSeq:number; owner:string; leaseToken:string; nowIso:string;
  actionId:string; actionSequence:number; capabilityName:string; capabilityVersion:string; argumentsHash:string;
}>;
export type V3SideEffectAdmissionResult=Readonly<{status:'ADMITTED';effectIdentity:string;itemId:string}>;

function fail(code:string):never{throw new Error(`V3_SIDE_EFFECT_ADMISSION_INVALID:${code}`)}
function text(v:unknown,code:string,max=512):string{if(typeof v!=='string'||v.trim()===''||v.length>max)fail(code);return v}
function positive(v:unknown,code:string):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<=0)fail(code);return v}
function exactKeys(value:unknown,keys:readonly string[],code:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail(code);
  const descriptors=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(value).length!==keys.length||Object.keys(descriptors).sort().join('|')!==[...keys].sort().join('|')||Object.values(descriptors).some(d=>!('value'in d)))fail(code);return value as Record<string,unknown>;
}
function effectIdentity(actionId:string,turnId:string,sequence:number,name:string,version:string,argsHash:string){return `V3-CP-004:effect:${canonicalSha256({actionId,turnId,sequence,capabilityName:name,capabilityVersion:version,argumentsHash:argsHash})}`}

/** Shadow-only admission. It may set the existing V2 side_effect_started bit, but creates no V3 record. */
export function admitV3SideEffect(database:V1Database,input:V3SideEffectAdmissionInput):V3SideEffectAdmissionResult{
  const safe=validateV3SideEffectAdmissionInput(input);
  const bundle=validateInboundBundle(safe.bundle), context=validateContextSnapshot(safe.context), vector=validateV3FreshnessVector(safe.freshnessVector);
  if(context.sourceRevisionRefs.accountId!==bundle.accountId||context.sourceRevisionRefs.conversationId!==bundle.conversationId||context.sourceRevisionRefs.turnId==='')fail('CONTEXT_SCOPE');
  if(vector.dependencies.identityScope.accountId!==bundle.accountId||vector.dependencies.identityScope.conversationId!==bundle.conversationId)fail('FRESHNESS_SCOPE');
  const arrivalSeq=safe.arrivalSeq, actionId=safe.actionId, sequence=safe.actionSequence;
  const name=safe.capabilityName, version=safe.capabilityVersion, argsHash=safe.argumentsHash;
  const action=database.db.prepare('SELECT a.*,t.account_id,t.conversation_id,t.profile_id FROM agent_actions a JOIN agent_turns t ON t.id=a.turn_id WHERE a.id=? AND a.sequence=?').get(actionId,sequence) as any;
  if(!action||action.capability_name!==name||action.capability_version!==version||action.arguments_hash!==argsHash)fail('EFFECT_IDENTITY');
  if(action.account_id!==bundle.accountId||action.conversation_id!==bundle.conversationId||action.turn_id!==context.sourceRevisionRefs.turnId)fail('EFFECT_SCOPE');
  const identity=effectIdentity(actionId,action.turn_id,sequence,name,version,argsHash);
  try{
    const result=database.queueAuthorizeV3SideEffect({accountId:bundle.accountId,conversationId:bundle.conversationId,arrivalSeq,turnId:action.turn_id,owner:safe.owner,token:safe.leaseToken,generation:0,now:safe.nowIso,bundleId:bundle.bundleId,bundleRevision:bundle.bundleRevision,conversationRevision:bundle.conversationRevisionAtBuild,contextSnapshotVersion:context.contextSnapshotVersion,freshnessVectorHash:vector.vectorHash,bundleMessageIds:[...bundle.messageIds],actionId,actionSequence:sequence,capabilityName:name,capabilityVersion:version,argumentsHash:argsHash,effectIdentity:identity,bundle:bundle,context, freshnessVector:vector, lease:safe.lease});
    if(result.status==='NEWER_INPUT_QUEUED')fail('NEWER_INPUT_QUEUED');
    return Object.freeze({status:'ADMITTED',effectIdentity:identity,itemId:String((result as any).item.id)});
  }catch(error){const message=String(error).replace(/^Error: /,'');if(message.startsWith('V3_'))fail(message);throw error}
}

export function validateV3SideEffectAdmissionInput(value:unknown):V3SideEffectAdmissionInput{
  const source=exactKeys(value,['bundle','context','freshnessVector','lease','arrivalSeq','owner','leaseToken','nowIso','actionId','actionSequence','capabilityName','capabilityVersion','argumentsHash'],'INPUT_SHAPE');
  return Object.freeze({bundle:source.bundle,context:source.context,freshnessVector:source.freshnessVector,lease:source.lease,arrivalSeq:positive(source.arrivalSeq,'ARRIVAL_SEQ'),owner:text(source.owner,'OWNER',160),leaseToken:text(source.leaseToken,'LEASE_TOKEN',160),nowIso:text(source.nowIso,'NOW',80),actionId:text(source.actionId,'ACTION_ID',160),actionSequence:positive(source.actionSequence,'ACTION_SEQUENCE'),capabilityName:text(source.capabilityName,'CAPABILITY_NAME'),capabilityVersion:text(source.capabilityVersion,'CAPABILITY_VERSION'),argumentsHash:text(source.argumentsHash,'ARGUMENTS_HASH',128)});
}
