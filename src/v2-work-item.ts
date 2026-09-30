import {randomUUID} from 'node:crypto';
import {V1Database} from './database.js';
import {canonicalSha256} from './v2-canonical.js';
import type {WorkItemService as WorkItemServiceContract} from './v2-domain-contracts.js';

export type WorkspaceState='OPEN'|'NEEDS_CLARIFICATION'|'DRAFTING'|'READY_TO_QUOTE'|'QUOTING'|'AWAITING_ACCEPTANCE'|'CHANGING'|'HANDED_OFF'|'COMPLETED'|'CANCELLED'|'FAILED';
export type ActorType='CUSTOMER'|'AI'|'STAFF'|'SYSTEM';
export type WorkItemRow={id:string;account_id:string;conversation_id:string;customer_id:string;type:'SALES_ORDER_REQUEST';state:WorkspaceState;revision:number;goal_summary:string;active_order_draft_id?:string|null;active_quotation_id?:string|null;assigned_profile?:string|null;blocking_reason?:string|null;source_message_id?:string|null;created_at:string;updated_at:string};
export type AuthorityRow={account_id:string;conversation_id:string;work_item_type:'SALES_ORDER_REQUEST';migration_state:'V1_ONLY'|'SHADOW_IMPORT'|'V2_CANARY'|'V2_PRIMARY'|'LEGACY_RETIRED';authoritative_writer:'LEGACY'|'V2';work_item_id?:string|null;legacy_source_hash?:string|null;legacy_schema_version?:string|null;quarantine_reason?:string|null;last_migration_event_id?:string|null;revision:number;updated_at:string};
const now=()=>new Date().toISOString(),uid=()=>randomUUID();
export function workspaceFail(code:string):never{throw new Error(code)}

const transitions:Record<WorkspaceState,WorkspaceState[]>= {
  OPEN:['NEEDS_CLARIFICATION','DRAFTING','READY_TO_QUOTE','CHANGING','HANDED_OFF','CANCELLED','FAILED'],
  NEEDS_CLARIFICATION:['OPEN','DRAFTING','HANDED_OFF','CANCELLED','FAILED'],
  DRAFTING:['OPEN','NEEDS_CLARIFICATION','READY_TO_QUOTE','CHANGING','HANDED_OFF','CANCELLED','FAILED'],
  READY_TO_QUOTE:['DRAFTING','QUOTING','HANDED_OFF','CANCELLED','FAILED'],
  QUOTING:['AWAITING_ACCEPTANCE','CHANGING','HANDED_OFF','FAILED'],
  AWAITING_ACCEPTANCE:['CHANGING','COMPLETED','HANDED_OFF','FAILED'],
  CHANGING:['DRAFTING','READY_TO_QUOTE','QUOTING','HANDED_OFF','CANCELLED','FAILED'],
  HANDED_OFF:['OPEN','CANCELLED','FAILED'],COMPLETED:[],CANCELLED:[],FAILED:[]
};

export class WorkItemService implements WorkItemServiceContract{
  constructor(public readonly database=new V1Database(':memory:')){}
  private get db(){return this.database.db}

  ensureScope(accountId:string,conversationId:string,customerId?:string){
    const r=this.db.prepare('SELECT customer_id FROM conversations WHERE id=? AND channel_account_id=?').get(conversationId,accountId) as {customer_id:string|null}|undefined;
    if(!r)workspaceFail('CONVERSATION_SCOPE');
    if(customerId&&r.customer_id!==customerId)workspaceFail('CUSTOMER_SCOPE');
    return r;
  }

  sourceMessage(accountId:string,conversationId:string,source:string|undefined|null,actor:ActorType){
    if(!source){if(actor!=='SYSTEM')workspaceFail('SOURCE_MESSAGE_REQUIRED');return null}
    const r=this.db.prepare(`SELECT id FROM messages WHERE account_id=? AND conversation_id=? AND (id=? OR external_message_id=?) ${actor==='SYSTEM'?'':'AND direction=\'INBOUND\''}`).get(accountId,conversationId,source,source) as {id:string}|undefined;
    if(!r)workspaceFail('SOURCE_MESSAGE_SCOPE');
    return r.id;
  }

  getAuthority(accountId:string,conversationId:string):AuthorityRow{
    this.ensureScope(accountId,conversationId);
    let a=this.db.prepare("SELECT * FROM workspace_authority WHERE account_id=? AND conversation_id=? AND work_item_type='SALES_ORDER_REQUEST'").get(accountId,conversationId) as AuthorityRow|undefined;
    if(!a){
      this.database.ensureWorkspaceAuthority(accountId,conversationId,now());
      a=this.db.prepare("SELECT * FROM workspace_authority WHERE account_id=? AND conversation_id=? AND work_item_type='SALES_ORDER_REQUEST'").get(accountId,conversationId) as AuthorityRow;
    }
    return a;
  }

  requireV2Writer(accountId:string,conversationId:string){
    const a=this.getAuthority(accountId,conversationId);
    if(a.authoritative_writer!=='V2'||!['V2_CANARY','V2_PRIMARY','LEGACY_RETIRED'].includes(a.migration_state))workspaceFail('V2_WRITES_NOT_AUTHORIZED');
    if(a.quarantine_reason)workspaceFail('WORKSPACE_QUARANTINED');
    return a;
  }

  read(id:string){return this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id) as WorkItemRow|undefined}

  active(accountId:string,conversationId:string){return this.db.prepare("SELECT * FROM work_items WHERE account_id=? AND conversation_id=? AND type='SALES_ORDER_REQUEST' AND state NOT IN ('COMPLETED','CANCELLED','FAILED')").get(accountId,conversationId) as WorkItemRow|undefined}

  canonicalCommitment(conversationId:string){
    const row=this.db.prepare("SELECT q.id quotation_id,q.status,s.id sales_order_id,s.status sales_order_status FROM quotations q LEFT JOIN sales_orders s ON s.source_quotation_id=q.id WHERE q.source_conversation_id=? AND (q.status='ACCEPTED' OR s.id IS NOT NULL) ORDER BY q.rowid DESC LIMIT 1").get(conversationId) as any;
    return row;
  }

  private openCommerce(conversationId:string){
    const quote=this.db.prepare("SELECT 1 FROM quotations WHERE source_conversation_id=? AND status IN ('DRAFT','SENT','ACCEPTED') LIMIT 1").get(conversationId);
    const out=this.db.prepare("SELECT 1 FROM outbound_messages WHERE conversation_id=? AND status IN ('PENDING','UNKNOWN') LIMIT 1").get(conversationId);
    return Boolean(quote||out);
  }

  getOrCreate(input:{accountId:string;conversationId:string;customerId:string;sourceMessageId?:string;goalSummary?:string;idempotencyKey:string;actorType?:ActorType;actorId?:string}){
    if(!input.idempotencyKey)workspaceFail('IDEMPOTENCY_KEY_REQUIRED');
    this.ensureScope(input.accountId,input.conversationId,input.customerId);
    this.requireV2Writer(input.accountId,input.conversationId);
    const actor=input.actorType??'AI',goal=String(input.goalSummary??'').trim()||'Customer sales order request';
    const prior=this.db.prepare("SELECT e.* FROM work_item_events e JOIN work_items w ON w.id=e.work_item_id WHERE w.account_id=? AND w.conversation_id=? AND e.idempotency_key=? LIMIT 1").get(input.accountId,input.conversationId,input.idempotencyKey) as any;
    if(prior){const replaySource=this.sourceMessage(input.accountId,input.conversationId,input.sourceMessageId,actor);const replayHash=canonicalSha256({kind:'CREATE',accountId:input.accountId,conversationId:input.conversationId,customerId:input.customerId,sourceMessageId:replaySource,goalSummary:goal,actorType:actor,actorId:input.actorId??null});if(prior.normalized_input_hash!==replayHash)workspaceFail('IDEMPOTENCY_CONFLICT');return JSON.parse(prior.immutable_snapshot_json) as WorkItemRow}
    const existing=this.active(input.accountId,input.conversationId);if(existing)return existing;
    if(this.openCommerce(input.conversationId))workspaceFail('CANONICAL_WORKSPACE_RECONCILIATION_REQUIRED');
    const source=this.sourceMessage(input.accountId,input.conversationId,input.sourceMessageId,actor),h=canonicalSha256({kind:'CREATE',accountId:input.accountId,conversationId:input.conversationId,customerId:input.customerId,sourceMessageId:source,goalSummary:goal,actorType:actor,actorId:input.actorId??null});
    const execute=()=>{
      const t=now();const row:WorkItemRow={id:uid(),account_id:input.accountId,conversation_id:input.conversationId,customer_id:input.customerId,type:'SALES_ORDER_REQUEST',state:'OPEN',revision:1,goal_summary:goal,active_order_draft_id:null,active_quotation_id:null,assigned_profile:null,blocking_reason:null,source_message_id:source,created_at:t,updated_at:t};
      this.db.prepare('INSERT INTO work_items VALUES(@id,@account_id,@conversation_id,@customer_id,@type,@state,@revision,@goal_summary,@active_order_draft_id,@active_quotation_id,@assigned_profile,@blocking_reason,@source_message_id,@created_at,@updated_at)').run(row);
      this.db.prepare('INSERT INTO work_item_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),row.id,1,'CREATE',null,'OPEN',actor,input.actorId??null,source,input.idempotencyKey,h,JSON.stringify(row),t);
      this.db.prepare("UPDATE workspace_authority SET work_item_id=?,updated_at=? WHERE account_id=? AND conversation_id=? AND work_item_type='SALES_ORDER_REQUEST'").run(row.id,t,input.accountId,input.conversationId);
      this.db.prepare('INSERT INTO workspace_provenance_links VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid(),input.accountId,input.conversationId,row.id,null,null,source,null,null,'WORK_ITEM_CREATE',t);
      return row;
    };
    return this.db.inTransaction?execute():this.db.transaction(execute)();
  }

  transition(input:{workItemId:string;accountId:string;conversationId:string;to:WorkspaceState;expectedRevision:number;idempotencyKey:string;actorType:ActorType;actorId?:string;sourceMessageId?:string;reason?:string}){
    if(!input.idempotencyKey)workspaceFail('IDEMPOTENCY_KEY_REQUIRED');
    this.requireV2Writer(input.accountId,input.conversationId);
    const source=this.sourceMessage(input.accountId,input.conversationId,input.sourceMessageId,input.actorType),h=canonicalSha256({...input,sourceMessageId:source});
    const prior=this.db.prepare('SELECT * FROM work_item_events WHERE work_item_id=? AND idempotency_key=?').get(input.workItemId,input.idempotencyKey) as any;
    if(prior){if(prior.normalized_input_hash!==h)workspaceFail('IDEMPOTENCY_CONFLICT');return JSON.parse(prior.immutable_snapshot_json) as WorkItemRow}
    const execute=()=>{
      const w=this.db.prepare('SELECT * FROM work_items WHERE id=? AND account_id=? AND conversation_id=?').get(input.workItemId,input.accountId,input.conversationId) as WorkItemRow|undefined;
      if(!w)workspaceFail('WORK_ITEM_SCOPE');if(w.revision!==input.expectedRevision)workspaceFail('STALE_WORK_ITEM_REVISION');if(!transitions[w.state].includes(input.to))workspaceFail('INVALID_WORK_ITEM_TRANSITION');
      if(this.canonicalCommitment(w.conversation_id)&&!(input.actorType==='SYSTEM'&&['COMPLETED','HANDED_OFF'].includes(input.to)))workspaceFail('CANONICAL_COMMITMENT_HANDOFF');
      const revision=w.revision+1,t=now(),updated={...w,state:input.to,revision,blocking_reason:input.reason??null,updated_at:t};
      const c=this.db.prepare('UPDATE work_items SET state=?,revision=?,blocking_reason=?,updated_at=? WHERE id=? AND revision=?').run(input.to,revision,input.reason??null,t,w.id,w.revision);if(c.changes!==1)workspaceFail('STALE_WORK_ITEM_REVISION');
      this.db.prepare('INSERT INTO work_item_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),w.id,revision,'TRANSITION',w.state,input.to,input.actorType,input.actorId??null,source,input.idempotencyKey,h,JSON.stringify(updated),t);
      this.db.prepare('INSERT INTO workspace_provenance_links VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid(),w.account_id,w.conversation_id,w.id,w.active_order_draft_id??null,null,source,w.active_quotation_id??null,null,'WORK_ITEM_TRANSITION',t);
      return updated as WorkItemRow;
    };
    return this.db.inTransaction?execute():this.db.transaction(execute)();
  }

  attachDraft(w:WorkItemRow,draftId:string,input:{expectedRevision:number;idempotencyKey:string;actorType:ActorType;actorId?:string;sourceMessageId:string|null}){
    this.requireV2Writer(w.account_id,w.conversation_id);
    const h=canonicalSha256({kind:'ATTACH_DRAFT',workItemId:w.id,draftId,...input});
    const prior=this.db.prepare('SELECT * FROM work_item_events WHERE work_item_id=? AND idempotency_key=?').get(w.id,input.idempotencyKey) as any;
    if(prior){if(prior.normalized_input_hash!==h)workspaceFail('IDEMPOTENCY_CONFLICT');return JSON.parse(prior.immutable_snapshot_json) as WorkItemRow}
    if(w.revision!==input.expectedRevision)workspaceFail('STALE_WORK_ITEM_REVISION');
    const revision=w.revision+1,t=now(),updated={...w,active_order_draft_id:draftId,revision,updated_at:t};
    const c=this.db.prepare('UPDATE work_items SET active_order_draft_id=?,revision=?,updated_at=? WHERE id=? AND revision=?').run(draftId,revision,t,w.id,w.revision);if(c.changes!==1)workspaceFail('STALE_WORK_ITEM_REVISION');
    this.db.prepare('INSERT INTO work_item_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),w.id,revision,'ATTACH_DRAFT',w.state,w.state,input.actorType,input.actorId??null,input.sourceMessageId,input.idempotencyKey,h,JSON.stringify(updated),t);
    this.db.prepare('INSERT INTO workspace_provenance_links VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid(),w.account_id,w.conversation_id,w.id,draftId,null,input.sourceMessageId,w.active_quotation_id??null,null,'WORK_ITEM_ATTACH_DRAFT',t);
    return updated as WorkItemRow;
  }

  bindSentQuotation(input:{workItemId:string;accountId:string;conversationId:string;customerId:string;draftId:string;quotationId:string;expectedRevision:number;idempotencyKey:string}){
    this.requireV2Writer(input.accountId,input.conversationId);
    const prior=this.db.prepare('SELECT * FROM work_item_events WHERE work_item_id=? AND idempotency_key=?').get(input.workItemId,input.idempotencyKey) as any;
    const h=canonicalSha256({kind:'BIND_SENT_QUOTATION',...input});
    if(prior){if(prior.normalized_input_hash!==h)workspaceFail('IDEMPOTENCY_CONFLICT');return JSON.parse(prior.immutable_snapshot_json) as WorkItemRow}
    const execute=()=>{
      const w=this.db.prepare('SELECT * FROM work_items WHERE id=? AND account_id=? AND conversation_id=? AND customer_id=?').get(input.workItemId,input.accountId,input.conversationId,input.customerId) as WorkItemRow|undefined;
      const d=this.db.prepare("SELECT id,work_item_id,account_id,conversation_id,customer_id FROM order_drafts WHERE id=? AND status='CURRENT'").get(input.draftId) as any;
      const q=this.db.prepare("SELECT id,customer_id,source_conversation_id,status FROM quotations WHERE id=? AND status='SENT'").get(input.quotationId) as any;
      if(!w||!d||!q||d.work_item_id!==input.workItemId||d.account_id!==input.accountId||d.conversation_id!==input.conversationId||d.customer_id!==input.customerId||q.customer_id!==input.customerId||q.source_conversation_id!==input.conversationId)workspaceFail('CANONICAL_QUOTE_SCOPE');
      if(w.active_order_draft_id!==input.draftId||w.revision!==input.expectedRevision)workspaceFail('STALE_WORK_ITEM_REVISION');
      if(!['OPEN','DRAFTING','CHANGING','QUOTING','READY_TO_QUOTE','AWAITING_ACCEPTANCE'].includes(w.state))workspaceFail('INVALID_WORK_ITEM_TRANSITION');
      if(w.active_quotation_id===input.quotationId&&w.state==='AWAITING_ACCEPTANCE')return w;
      const updated={...w,active_quotation_id:input.quotationId,state:'AWAITING_ACCEPTANCE' as const,revision:w.revision+1,updated_at:now()};
      if(this.db.prepare("UPDATE work_items SET active_quotation_id=?,state='AWAITING_ACCEPTANCE',revision=?,updated_at=? WHERE id=? AND revision=?").run(input.quotationId,updated.revision,updated.updated_at,w.id,w.revision).changes!==1)workspaceFail('STALE_WORK_ITEM_REVISION');
      this.db.prepare('INSERT INTO work_item_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),w.id,updated.revision,'BIND_SENT_QUOTATION',w.state,updated.state,'SYSTEM',null,null,input.idempotencyKey,h,JSON.stringify(updated),updated.updated_at);
      this.db.prepare('INSERT INTO workspace_provenance_links VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uid(),w.account_id,w.conversation_id,w.id,input.draftId,null,null,input.quotationId,null,'WORK_ITEM_QUOTATION_SENT',updated.updated_at);
      return updated;
    };
    return this.db.inTransaction ? execute() : this.database.runImmediate(execute);
  }
}
