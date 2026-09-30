import {createHash, randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import {V1Database} from './database.js';
import {ContextProjectionService} from './v2-context-projection.js';
import {canonicalJson,canonicalSha256} from './v2-canonical.js';
import {authoritativeFreshnessFingerprint} from './v2-freshness.js';

export type QueueScope={accountId:string;conversationId:string};
export type EnqueueInboundInput=QueueScope&{externalMessageId:string;messageId?:string;messageType?:string;text?:string;senderExternalId?:string;senderPhone?:string;replyToExternalMessageId?:string|null;occurredAt:string;rawRef?:string|null};
export type QueueItem=Readonly<{id:string;messageId:string;accountId:string;conversationId:string;arrivalSeq:number;state:'QUEUED'|'PROCESSING'|'COMPLETED'|'SUPERSEDED';sideEffectStarted:boolean}>;
export type QueueLease=Readonly<QueueItem&{leaseOwner:string;leaseToken:string;leaseExpiresAt:string}>;

function fail(code:string):never{throw new Error(`V2_QUEUE_INVALID:${code}`)}
function text(v:unknown,code:string,max=512){if(typeof v!=='string'||v.trim()===''||v.length>max)fail(code);return v}
function iso(v:unknown,code:string){const s=text(v,code,80);if(!Number.isFinite(Date.parse(s)))fail(code);return s}
function leaseMs(v:unknown){if(!Number.isSafeInteger(v)||Number(v)<1000||Number(v)>300_000)fail('LEASE_BOUNDS');return Number(v)}
function hash(v:unknown){return createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex')}
function row(db:Database.Database,sql:string,...args:unknown[]):any{return db.prepare(sql).get(...args)}
function item(rowValue:any):QueueItem{return Object.freeze({id:String(rowValue.id),messageId:String(rowValue.message_id),accountId:String(rowValue.account_id),conversationId:String(rowValue.conversation_id),arrivalSeq:Number(rowValue.arrival_seq),state:rowValue.state,sideEffectStarted:Boolean(rowValue.side_effect_started)})}

/** V2-QUEUE-001 persistence boundary. It contains no model/provider waits or transport behavior. */
export class V2QueueService{
  private readonly projection:ContextProjectionService;
  constructor(private readonly database:V1Database){ this.projection=new ContextProjectionService(database.db); }
  private db(){return this.database.db}
  private scope(input:QueueScope):QueueScope{return{accountId:text(input.accountId,'ACCOUNT_ID'),conversationId:text(input.conversationId,'CONVERSATION_ID')}}
  enqueueInbound(input:EnqueueInboundInput){
    const s=this.scope(input),external=text(input.externalMessageId,'EXTERNAL_MESSAGE_ID'),occurredAt=iso(input.occurredAt,'OCCURRED_AT'),now=new Date().toISOString();
    const result=this.database.queueEnqueue({accountId:s.accountId,conversationId:s.conversationId,externalMessageId:external,messageId:text(input.messageId??randomUUID(),'MESSAGE_ID'),messageType:input.messageType??'text',text:input.text??null,senderExternalId:input.senderExternalId??null,senderPhone:input.senderPhone??null,replyToExternalMessageId:input.replyToExternalMessageId??null,occurredAt,rawRef:input.rawRef??null,now,itemId:randomUUID()}) as any;
    return Object.freeze({...result,item:item(result.item)});
  }
  bindAgentTurn(input:QueueScope&{arrivalSeq:number;turnId:string}){
    const s=this.scope(input),turnId=text(input.turnId,'TURN_ID',160);
    try{return item(this.database.queueBind({accountId:s.accountId,conversationId:s.conversationId,arrivalSeq:input.arrivalSeq,turnId,now:new Date().toISOString()}))}catch(error){const code=String(error).replace(/^Error: V2_QUEUE_/,'');fail(code)}
  }
  claimNext(input:QueueScope&{owner:string;leaseMs?:number;nowIso?:string}):QueueLease|null{
    const s=this.scope(input),owner=text(input.owner,'LEASE_OWNER',160),now=input.nowIso?iso(input.nowIso,'NOW'):new Date().toISOString(),duration=leaseMs(input.leaseMs??30_000),expires=new Date(Date.parse(now)+duration).toISOString();
    const token=randomUUID();let result:any;try{result=this.database.queueClaim({accountId:s.accountId,conversationId:s.conversationId,owner,now,expires,token})}catch(error){const code=String(error).replace(/^Error: V2_QUEUE_/,'');fail(code)}if(!result)return null;return Object.freeze({...item(result.row),leaseOwner:owner,leaseToken:token,leaseExpiresAt:expires});
  }
  heartbeat(input:QueueScope&{owner:string;leaseToken:string;leaseMs?:number;nowIso?:string}){
    const s=this.scope(input),owner=text(input.owner,'LEASE_OWNER',160),token=text(input.leaseToken,'LEASE_TOKEN',160),now=input.nowIso?iso(input.nowIso,'NOW'):new Date().toISOString(),expires=new Date(Date.parse(now)+leaseMs(input.leaseMs??30_000)).toISOString();
    try{this.database.queueHeartbeat({accountId:s.accountId,conversationId:s.conversationId,owner,token,now,expires});return Object.freeze({owner,token,expiresAt:expires})}catch(error){const code=String(error).replace(/^Error: V2_QUEUE_/,'');fail(code)}
  }
  private lease(s:QueueScope,owner:string,token:string,now:string,arrivalSeq?:number,itemId?:string){const state=row(this.db(),'SELECT * FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?',s.accountId,s.conversationId);if(!state||state.lease_owner!==owner||state.lease_token!==token||state.lease_item_id!==(itemId??state.lease_item_id)||Number(state.lease_arrival_seq)!==(arrivalSeq??Number(state.lease_arrival_seq))||!state.lease_expires_at||Date.parse(state.lease_expires_at)<=Date.parse(now))fail('LEASE_EXPIRED');return state}
  private freshness(s:QueueScope,current:any,input:any){
    if('expectedWorkItemRevision' in input||'expectedDraftRevision' in input||'expectedContextFingerprint' in input||'currentContextFingerprint' in input)return{ok:false,reasonCode:'CALLER_FRESHNESS_FORBIDDEN'};
    const turnId=text(input.turnId,'TURN_ID',160),turn=row(this.db(),'SELECT * FROM agent_turns WHERE id=?',turnId);if(!turn)fail('TURN_NOT_FOUND');if(turn.account_id!==s.accountId||turn.conversation_id!==s.conversationId||turn.inbound_message_id!==current.message_id)fail('TURN_SCOPE');if(current.agent_turn_id&&current.agent_turn_id!==turnId)fail('TURN_BINDING_CONFLICT');if(turn.status==='TERMINAL')fail('TURN_NOT_ACTIVE');
    let context:any;try{context=JSON.parse(turn.context_snapshot_json)}catch{fail('TURN_CONTEXT_INTEGRITY')};if(canonicalJson(context)!==turn.context_snapshot_json||canonicalSha256(context)!==turn.context_fingerprint)fail('TURN_CONTEXT_INTEGRITY');
    const profile=row(this.db(),'SELECT id,version,language_policy_json,capability_permissions_json,forbidden_commitments_json,escalation_rules_json,turn_budgets_json,active FROM employee_profiles WHERE id=?',turn.profile_id);if(!profile||!profile.active)fail('PROFILE_CHANGED');
    if(context.freshness?.fingerprint!==authoritativeFreshnessFingerprint(this.db(),s.accountId,s.conversationId,String(profile.id)))return{ok:false,reasonCode:'STALE_CONTEXT'};return{ok:true,turnId};
  }
  private check(s:QueueScope,input:any,now:string,mutate:boolean):any{
    const owner=text(input.owner,'LEASE_OWNER',160),token=text(input.leaseToken,'LEASE_TOKEN',160),current=row(this.db(),'SELECT * FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND arrival_seq=?',s.accountId,s.conversationId,input.arrivalSeq);if(!current)return{ok:false,reasonCode:'ITEM_NOT_PROCESSING'};const state=this.lease(s,owner,token,now,input.arrivalSeq,current.id);
    if(!current||current.state!=='PROCESSING')return{ok:false,reasonCode:'ITEM_NOT_PROCESSING'};
    text(input.turnId,'TURN_ID',160);const turnCheck=row(this.db(),'SELECT account_id,conversation_id,inbound_message_id,status FROM agent_turns WHERE id=?',input.turnId);if(!turnCheck)fail('TURN_NOT_FOUND');if(turnCheck.account_id!==s.accountId||turnCheck.conversation_id!==s.conversationId||turnCheck.inbound_message_id!==current.message_id)fail('TURN_SCOPE');
    const newer=Number(row(this.db(),"SELECT count(*) n FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND arrival_seq>? AND state='QUEUED'",s.accountId,s.conversationId,input.arrivalSeq)?.n??0)>0;
    if(!current.side_effect_started&&newer){if(mutate){const superseded=this.database.queueSupersedeExact({accountId:s.accountId,conversationId:s.conversationId,itemId:current.id,arrivalSeq:input.arrivalSeq,owner,token,now});if(!superseded)return this.check(s,input,now,false);}return{ok:false,reasonCode:'NEWER_INPUT_QUEUED'};}
    const freshness=this.freshness(s,current,input);if(!freshness.ok)return freshness;
    return{ok:true,reasonCode:'AUTHORIZED',item:item(current),state};
  }
  recheckBeforeSideEffect(input:QueueScope&{owner:string;leaseToken:string;arrivalSeq:number;turnId:string}){const s=this.scope(input),now=new Date().toISOString();return this.check(s,input,now,true);}
  markSideEffectStarted(input:QueueScope&{owner:string;leaseToken:string;arrivalSeq:number;turnId:string}){const s=this.scope(input),owner=text(input.owner,'LEASE_OWNER',160),token=text(input.leaseToken,'LEASE_TOKEN',160),turnId=text(input.turnId,'TURN_ID',160),now=new Date().toISOString();if('expectedWorkItemRevision' in input||'expectedDraftRevision' in input||'expectedContextFingerprint' in input||'currentContextFingerprint' in input)fail('CALLER_FRESHNESS_FORBIDDEN');try{const result:any=this.database.queueAuthorizeSideEffect({accountId:s.accountId,conversationId:s.conversationId,arrivalSeq:input.arrivalSeq,turnId,owner,token,now});if(result.status==='NEWER_INPUT_QUEUED')fail(result.status);return Object.freeze({...item(result),sideEffectStarted:true})}catch(error){const code=String(error).replace(/^Error: V2_QUEUE_/,'');fail(code)}}
  complete(input:QueueScope&{owner:string;leaseToken:string;arrivalSeq:number;result?:unknown}){const s=this.scope(input),owner=text(input.owner,'LEASE_OWNER',160),token=text(input.leaseToken,'LEASE_TOKEN',160),now=new Date().toISOString(),resultHash=input.result===undefined?null:hash(input.result),current=row(this.db(),'SELECT * FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND arrival_seq=?',s.accountId,s.conversationId,input.arrivalSeq);if(!current)fail('ITEM_NOT_FOUND');if(current.state==='COMPLETED'){if(current.result_hash===resultHash)return item(current);fail('COMPLETION_REPLAY_CONFLICT')}this.lease(s,owner,token,now,input.arrivalSeq,current.id);if(current.state!=='PROCESSING')fail('ITEM_NOT_PROCESSING');try{return item(this.database.queueComplete({accountId:s.accountId,conversationId:s.conversationId,itemId:current.id,arrivalSeq:input.arrivalSeq,owner,token,now,resultHash}))}catch(error){const code=String(error).replace(/^Error: V2_QUEUE_/,'');fail(code)}}
  shouldSuppressNonessentialReply(input:QueueScope&{arrivalSeq:number;runtimeOwned:boolean;essential:boolean}){if(!input.runtimeOwned||input.essential)return false;return Number(row(this.db(),"SELECT count(*) n FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND arrival_seq>? AND state='QUEUED'",input.accountId,input.conversationId,input.arrivalSeq)?.n??0)>0;}
  read(scope:QueueScope){const s=this.scope(scope),state=row(this.db(),'SELECT * FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?',s.accountId,s.conversationId),items=this.db().prepare('SELECT * FROM v2_inbox_items WHERE account_id=? AND conversation_id=? ORDER BY arrival_seq').all(s.accountId,s.conversationId) as any[];return Object.freeze({processedWatermark:Number(state?.processed_watermark??0),nextArrivalSeq:Number(state?.next_arrival_seq??1),leaseOwner:state?.lease_owner??null,leaseExpiresAt:state?.lease_expires_at??null,items:items.map(item)});}
  reclassifyUnclaimedForV1(scope?:{accountId?:string;conversationId?:string}){return this.database.queueReclassifyUnclaimedForV1(scope);}
  readReclassificationBlocks(scope?:{accountId?:string;conversationId?:string}){return [...this.database.queueReadReclassificationBlocks(scope),...this.database.queueReadProcessingBlocks(scope)];}
}
export {V2QueueService as ConversationQueueService};
