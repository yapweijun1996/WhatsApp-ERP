/** V3-GOAL-004: shadow-only durable continuation records. */
import {canonicalJson, canonicalSha256} from './v2-canonical.js';
import type {V1Database} from './database.js';
import type Database from 'better-sqlite3';
import {buildV3FreshnessVectorFromDatabase, validateV3FreshnessVector, type V3FreshnessDependencyVector, type V3FreshnessVectorInput} from './v3-freshness-vector.js';

export const V3_CONTINUATION_CONTRACT_VERSION='V3-GOAL-004' as const;
export const V3_CONTINUATION_SCHEMA_VERSION=1 as const;
export const V3_CONTINUATION_AUTHORITY='NON_AUTHORITATIVE_SHADOW' as const;
export const V3_CONTINUATION_DISPOSITIONS=['STILL_IN_PROGRESS','WAITING_EXTERNAL'] as const;
export type V3ContinuationDisposition=typeof V3_CONTINUATION_DISPOSITIONS[number];
export const V3_CONTINUATION_STATES=['READY','RUNNING','WAITING','BLOCKED','COMPLETED','CANCELLED'] as const;
export type V3ContinuationState=typeof V3_CONTINUATION_STATES[number];
export const V3_CONTINUATION_TRIGGERS=['NEW_INBOUND','EXTRACTION_VERSION','OUTBOUND_RECONCILED','EXTERNAL_EVENT','DEADLINE','MANUAL_HANDOFF','OTHER_GOVERNED'] as const;
export type V3ContinuationTrigger=typeof V3_CONTINUATION_TRIGGERS[number];
export const V3_CONTINUATION_OWNER_TYPES=['AGENT','HOST','HUMAN'] as const;
export type V3ContinuationOwnerType=typeof V3_CONTINUATION_OWNER_TYPES[number];

export type V3DurableContinuation=Readonly<{
  contractVersion:typeof V3_CONTINUATION_CONTRACT_VERSION; schemaVersion:1; authority:typeof V3_CONTINUATION_AUTHORITY;
  continuationId:string; workItemId:string; goalId:string; accountId:string; conversationId:string;
  disposition:V3ContinuationDisposition; ownerType:V3ContinuationOwnerType; ownerId:string;
  state:V3ContinuationState; resumeTriggerType:V3ContinuationTrigger; resumeConditionRef:string;
  nextEligibleAt:string|null; deadlineAt:string|null; expectedFreshnessVectorRef:string;
  lastEvidenceRefs:readonly string[]; lastEffectRefs:readonly string[];
  attempt:number; budgetState:Readonly<{maxAttempts:number;consumed:number;deadlineAt:string|null}>;
  idempotencyKey:string; createdAt:string; updatedAt:string;
}>;
export type V3ContinuationHostCondition=Readonly<{accountId:string;conversationId:string;resumeTriggerType:V3ContinuationTrigger;condition:string}>;

type Row={continuation_id:string;account_id:string;conversation_id:string;work_item_id:string;goal_id:string;record_json:string;record_hash:string;idempotency_key:string;created_at:string;updated_at:string};
type Mutation={depth:number;row?:Record<string,unknown>};
const mutations=new WeakMap<Database.Database,Mutation>();
const fail=(code:string):never=>{throw Error(`V3_CONTINUATION_INVALID:${code}`)};
const text=(v:unknown,c:string):string=>{if(typeof v!=='string'||v.trim()===''||v.length>512)fail(c);return v as string};
const one=<T extends string>(a:readonly T[],v:unknown,c:string)=>{if(!a.includes(v as T))fail(c);return v as T};
function exact(v:unknown,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('INPUT_SHAPE');const object=v as object,allowed=new Set([...keys,...optional]),out:Record<string,unknown>={};for(const raw of Reflect.ownKeys(object)){if(typeof raw!=='string'||!allowed.has(raw))fail('INPUT_SHAPE');const key=raw as string,d=Object.getOwnPropertyDescriptor(object,key);if(!d||!d.enumerable||!('value'in d))fail('INPUT_SHAPE');out[key]=(d as PropertyDescriptor&{value:unknown}).value}for(const k of keys)if(!Object.prototype.hasOwnProperty.call(out,k))fail('INPUT_SHAPE');return out}
function stamp(v:unknown,c:string):string{const s=text(v,c);if(new Date(s).toISOString()!==s)fail(c);return s}
function ids(v:unknown,c:string):readonly string[]{if(!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype||v.length>256)fail(c);const a=v as unknown[],keys=Reflect.ownKeys(a);for(const key of keys){if(key==='length')continue;if(typeof key!=='string'||!/^\d+$/.test(key)||Number(key)>=a.length||String(Number(key))!==key)fail(c)}const result:string[]=[];for(let i=0;i<a.length;i++){const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d||!d.enumerable||!('value'in d))fail(c);const x=text((d as PropertyDescriptor&{value:unknown}).value,`${c}_ITEM`);if(result.includes(x))fail(`${c}_DUPLICATE`);result.push(x)}return Object.freeze(result)}
export function v3FreshnessVectorRef(vector:V3FreshnessDependencyVector):string{return `v3:freshness-vector:${vector.vectorHash}`}
export function v3ResumeConditionRef(input:V3ContinuationHostCondition):string{const x=parseHostCondition(input);return `v3:resume-condition:${canonicalSha256(x)}`}
function parseHostCondition(value:unknown):V3ContinuationHostCondition{const x=exact(value,['accountId','conversationId','resumeTriggerType','condition']);return Object.freeze({accountId:text(x.accountId,'CONDITION_ACCOUNT'),conversationId:text(x.conversationId,'CONDITION_CONVERSATION'),resumeTriggerType:one(V3_CONTINUATION_TRIGGERS,x.resumeTriggerType,'CONDITION_TRIGGER'),condition:text(x.condition,'CONDITION')})}
function parse(value:unknown):V3DurableContinuation{const x=exact(value,['continuationId','workItemId','goalId','accountId','conversationId','disposition','ownerType','ownerId','state','resumeTriggerType','resumeConditionRef','nextEligibleAt','deadlineAt','expectedFreshnessVectorRef','lastEvidenceRefs','lastEffectRefs','attempt','budgetState','idempotencyKey','createdAt','updatedAt'],['contractVersion','schemaVersion','authority']);
  if((x.contractVersion!==undefined&&x.contractVersion!==V3_CONTINUATION_CONTRACT_VERSION)||(x.schemaVersion!==undefined&&x.schemaVersion!==1)||(x.authority!==undefined&&x.authority!==V3_CONTINUATION_AUTHORITY))fail('VERSION_OR_AUTHORITY');
  const next=x.nextEligibleAt===null?null:stamp(x.nextEligibleAt,'NEXT_ELIGIBLE_AT'),deadline=x.deadlineAt===null?null:stamp(x.deadlineAt,'DEADLINE_AT'),created=stamp(x.createdAt,'CREATED_AT'),updated=stamp(x.updatedAt,'UPDATED_AT');
  if(new Date(updated).getTime()<new Date(created).getTime())fail('TIMESTAMP_ORDER');
  if(deadline&&new Date(deadline).getTime()<new Date(created).getTime())fail('DEADLINE_ORDER');
  if(!Number.isSafeInteger(x.attempt as number)||(x.attempt as number)<0)fail('ATTEMPT');
  const b=exact(x.budgetState,['maxAttempts','consumed','deadlineAt']);if(!Number.isSafeInteger(b.maxAttempts)||Number(b.maxAttempts)<1||!Number.isSafeInteger(b.consumed)||Number(b.consumed)<0||Number(b.consumed)>Number(b.maxAttempts))fail('BUDGET');
  const budgetDeadline=b.deadlineAt===null?null:stamp(b.deadlineAt,'BUDGET_DEADLINE');
  if(x.disposition==='WAITING_EXTERNAL'&&x.state!=='WAITING')fail('WAITING_STATE');
  if(x.disposition==='STILL_IN_PROGRESS'&&!['READY','RUNNING'].includes(x.state as string))fail('IN_PROGRESS_STATE');
  if(x.resumeTriggerType==='MANUAL_HANDOFF'&&x.ownerType!=='HUMAN')fail('HANDOFF_OWNER');
  if((x.attempt as number)>Number(b.consumed)||((x.state==='READY'||x.state==='RUNNING'||x.state==='WAITING')&&Number(b.consumed)>=Number(b.maxAttempts)))fail('BUDGET_EXHAUSTED');
  if((deadline===null)!==(budgetDeadline===null)||deadline!==budgetDeadline)fail('BUDGET_DEADLINE_MISMATCH');
  if(next&&deadline&&new Date(next).getTime()>new Date(deadline).getTime())fail('NEXT_ELIGIBLE_AFTER_DEADLINE');
  const result=Object.freeze({contractVersion:V3_CONTINUATION_CONTRACT_VERSION,schemaVersion:1,authority:V3_CONTINUATION_AUTHORITY,continuationId:text(x.continuationId,'CONTINUATION_ID'),workItemId:text(x.workItemId,'WORK_ITEM_ID'),goalId:text(x.goalId,'GOAL_ID'),accountId:text(x.accountId,'ACCOUNT'),conversationId:text(x.conversationId,'CONVERSATION'),disposition:one(V3_CONTINUATION_DISPOSITIONS,x.disposition,'DISPOSITION'),ownerType:one(V3_CONTINUATION_OWNER_TYPES,x.ownerType,'OWNER_TYPE'),ownerId:text(x.ownerId,'OWNER_ID'),state:one(V3_CONTINUATION_STATES,x.state,'STATE'),resumeTriggerType:one(V3_CONTINUATION_TRIGGERS,x.resumeTriggerType,'TRIGGER'),resumeConditionRef:text(x.resumeConditionRef,'CONDITION_REF'),nextEligibleAt:next,deadlineAt:deadline,expectedFreshnessVectorRef:text(x.expectedFreshnessVectorRef,'FRESHNESS_REF'),lastEvidenceRefs:ids(x.lastEvidenceRefs,'EVIDENCE_REFS'),lastEffectRefs:ids(x.lastEffectRefs,'EFFECT_REFS'),attempt:x.attempt as number,budgetState:Object.freeze({maxAttempts:b.maxAttempts as number,consumed:b.consumed as number,deadlineAt:budgetDeadline}),idempotencyKey:text(x.idempotencyKey,'IDEMPOTENCY_KEY'),createdAt:created,updatedAt:updated}) as V3DurableContinuation;
  return result;}
function mutation(db:Database.Database){let m=mutations.get(db);if(m)return m;m={depth:0};db.function('v3_continuation_mutation_authorized',()=>m!.depth>0?1:0);for(const [n,k] of [['id','continuation_id'],['account','account_id'],['conversation','conversation_id'],['work','work_item_id'],['goal','goal_id'],['json','record_json'],['hash','record_hash'],['idem','idempotency_key'],['created','created_at'],['updated','updated_at']] as const)db.function(`v3_continuation_${n}`,()=>m!.row?.[k]??null);mutations.set(db,m);return m;}
export function validateV3DurableContinuation(value:unknown){return parse(value)}
export function buildV3DurableContinuation(input:Omit<V3DurableContinuation,'contractVersion'|'schemaVersion'|'authority'>){return parse(input)}
export class V3DurableContinuationStore{
  #m:Mutation;constructor(private readonly database:V1Database){this.#m=mutation(database.db)}
  create(input:unknown,freshnessProof:unknown,conditionProof:unknown){
    const value=parse(input),condition=parseHostCondition(conditionProof),json=canonicalJson(value),hash=canonicalSha256(value);
    if(condition.accountId!==value.accountId||condition.conversationId!==value.conversationId||condition.resumeTriggerType!==value.resumeTriggerType||v3ResumeConditionRef(condition)!==value.resumeConditionRef)fail('CONDITION_SCOPE');
    return this.database.runImmediate(()=>{
      const replay=this.database.db.prepare('SELECT * FROM durable_continuations WHERE continuation_id=? OR idempotency_key=?').all(value.continuationId,value.idempotencyKey) as Row[];
      if(replay.length){if(replay.length===1&&replay[0]!.continuation_id===value.continuationId&&replay[0]!.idempotency_key===value.idempotencyKey&&replay[0]!.record_json===json&&replay[0]!.record_hash===hash)return replay[0]!;fail('IDEMPOTENCY_CONFLICT')}
      const supplied=validateV3FreshnessVector(freshnessProof),deps=supplied.dependencies;
      const {authoritativeV2FreshnessFingerprint:_,...withoutFingerprint}=deps;
      const current=buildV3FreshnessVectorFromDatabase(this.database.db,withoutFingerprint as Omit<V3FreshnessVectorInput,'authoritativeV2FreshnessFingerprint'>);
      if(current.vectorHash!==supplied.vectorHash||value.expectedFreshnessVectorRef!==v3FreshnessVectorRef(current))fail('FRESHNESS_STALE');
      const scope=this.database.db.prepare('SELECT customer_id FROM conversations WHERE id=? AND channel_account_id=?').get(value.conversationId,value.accountId) as {customer_id:string|null}|undefined;if(!scope)fail('SCOPE');
      const work=this.database.db.prepare("SELECT id FROM work_items WHERE id=? AND account_id=? AND conversation_id=? AND customer_id IS ? AND state NOT IN ('COMPLETED','CANCELLED','FAILED')").get(value.workItemId,value.accountId,value.conversationId,scope!.customer_id);if(!work)fail('WORK_ITEM_SCOPE');
      const goalRow=this.database.db.prepare('SELECT goal_json FROM conversation_goal_events WHERE account_id=? AND conversation_id=? AND goal_id=? ORDER BY revision DESC LIMIT 1').get(value.accountId,value.conversationId,value.goalId) as {goal_json:string}|undefined;if(!goalRow)fail('GOAL_NOT_FOUND');const currentGoal=parseGoalStatus(goalRow!.goal_json);if(value.disposition==='WAITING_EXTERNAL'&&currentGoal!=='WAITING_EXTERNAL')fail('GOAL_STATUS');if(value.disposition==='STILL_IN_PROGRESS'&&currentGoal!=='IN_PROGRESS'&&currentGoal!=='OPEN')fail('GOAL_STATUS');
      for(const [kind,refs] of [['evidence',value.lastEvidenceRefs],['effect',value.lastEffectRefs]] as const)for(const ref of refs){const match=new RegExp(`^${kind}:([^:]+)$`).exec(ref);if(!match)fail('REFERENCE_UNKNOWN');const id=match![1]!;if(kind==='evidence'&&!this.database.db.prepare('SELECT 1 FROM erp_evidence e JOIN grounding_provenance_links p ON p.evidence_id=e.id WHERE e.id=? AND p.account_id=? AND p.conversation_id=?').get(id,value.accountId,value.conversationId))fail('EVIDENCE_SCOPE');if(kind==='effect'&&!this.database.db.prepare('SELECT 1 FROM agent_action_results r JOIN agent_turns t ON t.id=r.turn_id WHERE r.id=? AND t.account_id=? AND t.conversation_id=?').get(id,value.accountId,value.conversationId))fail('EFFECT_SCOPE')}
      const row={continuation_id:value.continuationId,account_id:value.accountId,conversation_id:value.conversationId,work_item_id:value.workItemId,goal_id:value.goalId,record_json:json,record_hash:hash,idempotency_key:value.idempotencyKey,created_at:value.createdAt,updated_at:value.updatedAt};this.#m.depth++;this.#m.row=row;try{this.database.db.prepare('INSERT INTO durable_continuations(continuation_id,account_id,conversation_id,work_item_id,goal_id,record_json,record_hash,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.continuation_id,row.account_id,row.conversation_id,row.work_item_id,row.goal_id,row.record_json,row.record_hash,row.idempotency_key,row.created_at,row.updated_at)}finally{this.#m.row=undefined;this.#m.depth--}return row;
    });
  }
  get(scope:unknown,id:unknown){const bound=exact(scope,['accountId','conversationId']);const accountId=text(bound.accountId,'ACCOUNT'),conversationId=text(bound.conversationId,'CONVERSATION'),continuationId=text(id,'CONTINUATION_ID');const row=this.database.db.prepare('SELECT * FROM durable_continuations WHERE account_id=? AND conversation_id=? AND continuation_id=?').get(accountId,conversationId,continuationId) as Row|undefined;if(!row)return null;let parsed:unknown;try{parsed=JSON.parse(row.record_json)}catch{fail('INTEGRITY')}if(canonicalSha256(parsed)!==row.record_hash)fail('INTEGRITY');const value=parse(parsed);if(value.accountId!==accountId||value.conversationId!==conversationId||value.workItemId!==row.work_item_id||value.goalId!==row.goal_id)fail('INTEGRITY');return value;}
  validateFulfillmentReference(input:{accountId:string;conversationId:string;goalId:string;continuationId:string;disposition:V3ContinuationDisposition}){
    const value=this.get({accountId:input.accountId,conversationId:input.conversationId},input.continuationId);
    if(!value) fail('NOT_FOUND');
    const resolved=value as V3DurableContinuation;
    if(resolved.goalId!==input.goalId||resolved.disposition!==input.disposition) fail('FULFILLMENT_MISMATCH');
    const scope=this.database.db.prepare('SELECT customer_id FROM conversations WHERE id=? AND channel_account_id=?').get(input.conversationId,input.accountId) as {customer_id:string|null}|undefined;
    if(!scope) fail('SCOPE');
    const work=this.database.db.prepare("SELECT id FROM work_items WHERE id=? AND account_id=? AND conversation_id=? AND customer_id IS ? AND state NOT IN ('COMPLETED','CANCELLED','FAILED')").get(resolved.workItemId,input.accountId,input.conversationId,scope!.customer_id);
    if(!work) fail('FULFILLMENT_WORK_ITEM');
    const goalRow=this.database.db.prepare('SELECT goal_json FROM conversation_goal_events WHERE account_id=? AND conversation_id=? AND goal_id=? ORDER BY revision DESC LIMIT 1').get(input.accountId,input.conversationId,input.goalId) as {goal_json:string}|undefined;
    if(!goalRow) fail('FULFILLMENT_GOAL');
    const status=parseGoalStatus(goalRow!.goal_json);
    if(resolved.disposition==='WAITING_EXTERNAL'&&status!=='WAITING_EXTERNAL') fail('FULFILLMENT_GOAL_STATUS');
    if(resolved.disposition==='STILL_IN_PROGRESS'&&status!=='OPEN'&&status!=='IN_PROGRESS') fail('FULFILLMENT_GOAL_STATUS');
    return resolved;
  }
}
function parseGoalStatus(json:string){try{const x=JSON.parse(json);if(!x||typeof x.status!=='string')fail('GOAL_INTEGRITY');return x.status as string}catch(e){if(e instanceof Error&&e.message.startsWith('V3_CONTINUATION_INVALID:'))throw e;fail('GOAL_INTEGRITY')}}
