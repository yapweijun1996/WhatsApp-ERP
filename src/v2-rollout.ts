import {randomUUID} from 'node:crypto';
import {V1Database} from './database.js';
import {canonicalSha256} from './v2-canonical.js';
import {workspaceFail,type AuthorityRow} from './v2-work-item.js';
import type {RolloutApproval,RolloutAction,RolloutApprovalAuthority,RolloutIntent} from './rollout-auth.js';

export const V2_CAPABILITIES=Object.freeze(['customer_context','order_history','order_draft_workspace','order_validation','quotation','commitment','sales_order_draft'] as const);
export type V2Capability=typeof V2_CAPABILITIES[number];
type Scope={accountId?:string;conversationId?:string};
type Row={capability:string;account_id:string|null;conversation_id:string|null;enabled:number;updated_at:string;updated_by:string;revision:number};
const now=()=>new Date().toISOString();
const valid=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);

function capability(value:unknown):V2Capability{if(typeof value!=='string'||!(V2_CAPABILITIES as readonly string[]).includes(value))workspaceFail('ROLLOUT_CAPABILITY_UNKNOWN');return value as V2Capability;}
function scope(scope:Scope){
  if(scope.conversationId!==undefined&&!valid(scope.conversationId))workspaceFail('ROLLOUT_CONVERSATION_SCOPE_INVALID');
  if(scope.accountId!==undefined&&!valid(scope.accountId))workspaceFail('ROLLOUT_ACCOUNT_SCOPE_INVALID');
  if(scope.conversationId!==undefined&&scope.accountId===undefined)workspaceFail('ROLLOUT_ACCOUNT_SCOPE_REQUIRED');
  return scope;
}

/** Durable, capability-scoped rollout authority. Effective V2 is always the intersection of this table and MIG-001 authority. */
export class V2RolloutService{
  constructor(public readonly database:V1Database,private readonly approvals:RolloutApprovalAuthority){ }
  private get db(){return this.database.db}
  private verify(a:RolloutApproval,intent:RolloutIntent){const v=this.approvals.verify(a,intent);if(!v)workspaceFail('ROLLOUT_APPROVAL_REQUIRED');return v}
  private ensureScope(s:Scope){
    scope(s);
    if(s.conversationId){const row=this.db.prepare('SELECT channel_account_id FROM conversations WHERE id=?').get(s.conversationId) as {channel_account_id:string}|undefined;if(!row||row.channel_account_id!==s.accountId)workspaceFail('ROLLOUT_CONVERSATION_SCOPE');}
  }
  private key(s:Scope){return [s.accountId??null,s.conversationId??null] as const}
  private authority(accountId:string,conversationId:string):AuthorityRow|undefined{return this.db.prepare("SELECT * FROM workspace_authority WHERE account_id=? AND conversation_id=? AND work_item_type='SALES_ORDER_REQUEST'").get(accountId,conversationId) as AuthorityRow|undefined}
  private configured(name:V2Capability,s:Scope){
    const rows=this.db.prepare('SELECT * FROM v2_capability_rollouts WHERE capability=? AND ((account_id IS NULL AND conversation_id IS NULL) OR (account_id=? AND conversation_id IS NULL) OR (account_id=? AND conversation_id=?)) ORDER BY CASE WHEN conversation_id IS NOT NULL THEN 3 WHEN account_id IS NOT NULL THEN 2 ELSE 1 END DESC').all(name,s.accountId??null,s.accountId??null,s.conversationId??null) as Row[];
    return rows[0]??null;
  }
  configure(input:{capability:unknown;enabled:boolean;accountId?:string;conversationId?:string;idempotencyKey:string;approval:RolloutApproval}){
    return this.mutate(input,input.enabled?'ENABLE':'DISABLE');
  }
  /** First inquiry grant only: never UPDATE/re-enable an exact existing row.
   * Validation and conditional insert share the SQLite writer transaction. */
  enableIfAbsent(input:{capability:unknown;accountId:string;conversationId:string;idempotencyKey:string;approval:RolloutApproval},validateCurrent:()=>void){
    const name=capability(input.capability),s=scope(input);
    if(!s.accountId||!s.conversationId)workspaceFail('ROLLOUT_EXACT_SCOPE_REQUIRED');
    if(!valid(input.idempotencyKey))workspaceFail('ROLLOUT_IDEMPOTENCY_REQUIRED');
    const approval=this.verify(input.approval,{action:'ENABLE',capability:name,accountId:s.accountId,conversationId:s.conversationId,enabled:true});
    const inputHash=canonicalSha256({name,accountId:s.accountId,conversationId:s.conversationId,enabled:true,idempotencyKey:input.idempotencyKey,action:'ENABLE',initialOnly:true});
    return this.database.runRolloutMutation(()=>{
      this.ensureScope(s);
      validateCurrent();
      const authority=this.authority(s.accountId!,s.conversationId!);
      if(!authority||authority.authoritative_writer!=='V2'||authority.quarantine_reason||!['V2_CANARY','V2_PRIMARY','LEGACY_RETIRED'].includes(authority.migration_state))workspaceFail('WORKSPACE_AUTHORITY_REQUIRED');
      const key=this.key(s),existing=this.db.prepare('SELECT enabled FROM v2_capability_rollouts WHERE capability=? AND account_id IS ? AND conversation_id IS ?').get(name,...key) as {enabled:number}|undefined;
      if(existing?.enabled===0)workspaceFail('ROLLOUT_EXPLICIT_DISABLE');
      if(existing?.enabled===1)return {status:'ALREADY_ENABLED',capability:name};
      const prior=this.db.prepare('SELECT input_hash FROM v2_rollout_events WHERE idempotency_key=?').get(input.idempotencyKey) as {input_hash:string}|undefined;
      if(prior)workspaceFail(prior.input_hash===inputHash?'ROLLOUT_INITIAL_GRANT_MISSING':'ROLLOUT_IDEMPOTENCY_CONFLICT');
      const t=now();
      const inserted=this.db.prepare('INSERT INTO v2_capability_rollouts(capability,account_id,conversation_id,enabled,updated_at,updated_by) SELECT ?,?,?,1,?,? WHERE NOT EXISTS(SELECT 1 FROM v2_capability_rollouts WHERE capability=? AND account_id IS ? AND conversation_id IS ?)').run(name,...key,t,approval.subject,name,...key);
      const observed=this.db.prepare('SELECT enabled FROM v2_capability_rollouts WHERE capability=? AND account_id IS ? AND conversation_id IS ?').get(name,...key) as {enabled:number}|undefined;
      if(inserted.changes!==1||observed?.enabled!==1)workspaceFail('ROLLOUT_INITIAL_GRANT_PERSISTENCE_REQUIRED');
      const result={status:'ENABLED',capability:name,scope:{accountId:key[0],conversationId:key[1]},configuredEnabled:true,action:'ENABLE'};
      this.db.prepare('INSERT INTO v2_rollout_events(id,capability,account_id,conversation_id,action,enabled,idempotency_key,input_hash,approval_subject,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),name,...key,'ENABLE',1,input.idempotencyKey,inputHash,approval.subject,JSON.stringify(result),t);
      return result;
    },input.approval);
  }
  private mutate(input:{capability:unknown;enabled:boolean;accountId?:string;conversationId?:string;idempotencyKey:string;approval:RolloutApproval},action:RolloutAction){
    const name=capability(input.capability);const s=scope({accountId:input.accountId,conversationId:input.conversationId});this.ensureScope(s);if(typeof input.enabled!=='boolean')workspaceFail('ROLLOUT_ENABLED_INVALID');if(!valid(input.idempotencyKey))workspaceFail('ROLLOUT_IDEMPOTENCY_REQUIRED');
    const approval=this.verify(input.approval,{action,capability:name,accountId:s.accountId??null,conversationId:s.conversationId??null,enabled:input.enabled});const inputHash=canonicalSha256({name,...s,enabled:input.enabled,idempotencyKey:input.idempotencyKey,action});
    return this.database.runRolloutMutation(()=>{
      const prior=this.db.prepare('SELECT result_json,input_hash FROM v2_rollout_events WHERE idempotency_key=?').get(input.idempotencyKey) as {result_json:string;input_hash:string}|undefined;if(prior){if(prior.input_hash!==inputHash)workspaceFail('ROLLOUT_IDEMPOTENCY_CONFLICT');return JSON.parse(prior.result_json)}
      const t=now(),key=this.key(s),existing=this.db.prepare('SELECT revision FROM v2_capability_rollouts WHERE capability=? AND account_id IS ? AND conversation_id IS ?').get(name,key[0],key[1]) as {revision:number}|undefined;
      if(existing){const changed=this.db.prepare('UPDATE v2_capability_rollouts SET enabled=?,updated_at=?,updated_by=?,revision=revision+1 WHERE capability=? AND account_id IS ? AND conversation_id IS ? AND revision=?').run(input.enabled?1:0,t,approval.subject,name,key[0],key[1],existing.revision);if(changed.changes!==1)workspaceFail('ROLLOUT_CONFLICT');}
      else this.db.prepare('INSERT INTO v2_capability_rollouts(capability,account_id,conversation_id,enabled,updated_at,updated_by) VALUES(?,?,?,?,?,?)').run(name,key[0],key[1],input.enabled?1:0,t,approval.subject);
      const result={status:input.enabled?'ENABLED':'DISABLED',capability:name,scope:{accountId:key[0],conversationId:key[1]},configuredEnabled:input.enabled,action};
      this.db.prepare('INSERT INTO v2_rollout_events(id,capability,account_id,conversation_id,action,enabled,idempotency_key,input_hash,approval_subject,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),name,key[0],key[1],action,input.enabled?1:0,input.idempotencyKey,inputHash,approval.subject,JSON.stringify(result),t);return result;
    },input.approval);
  }
  rollback(input:{capability:unknown;accountId?:string;conversationId?:string;idempotencyKey:string;approval:RolloutApproval}){
    const name=capability(input.capability);const s=scope({accountId:input.accountId,conversationId:input.conversationId});this.ensureScope(s);
    return this.mutate({capability:name,enabled:false,...s,idempotencyKey:input.idempotencyKey,approval:input.approval},'ROLLBACK');
  }
  evaluate(input:{capability:unknown;accountId:string;conversationId:string}){
    let name:V2Capability;try{name=capability(input.capability);this.ensureScope(input);}catch(error){return {capability:typeof input.capability==='string'?input.capability:null,configuredEnabled:false,effectiveV2:false,reasonCode:(error as Error).message};}
    const configured=this.configured(name,input),authority=this.authority(input.accountId,input.conversationId),authorized=Boolean(authority&&authority.authoritative_writer==='V2'&&['V2_CANARY','V2_PRIMARY','LEGACY_RETIRED'].includes(authority.migration_state)&&!authority.quarantine_reason);
    return {capability:name,configuredEnabled:Boolean(configured?.enabled),effectiveV2:Boolean(configured?.enabled&&authorized),scope:configured?{accountId:configured.account_id,conversationId:configured.conversation_id}:null,workspaceAuthority:authority?{migrationState:authority.migration_state,authoritativeWriter:authority.authoritative_writer}:null,reasonCode:configured?.enabled?(authorized?'EFFECTIVE_V2':'WORKSPACE_AUTHORITY_REQUIRED'):'ROLLOUT_DISABLED'};
  }
  telemetry(input:{accountId:string;conversationId:string}){return V2_CAPABILITIES.map(cap=>this.evaluate({capability:cap,...input}));}
}
