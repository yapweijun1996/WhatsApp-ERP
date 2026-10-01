import type {IncomingChannelMessage,OutgoingChannelMessage,ChannelAdapter} from './channel-contract.js';
import {V1Database} from './database.js';
import type {CanonicalIngress} from './v2-conversation-ingress-persistence.js';
import type {V2CanaryIngressRouter} from './v2-canary-ingress-router.js';
import {WorkspaceMigrationService} from './v2-workspace-migration.js';
import {V2RolloutService,V2_CAPABILITIES} from './v2-rollout.js';
import type {MigrationApprovalAuthority,MigrationAction,MigrationOwner} from './migration-auth.js';
import type {RolloutApprovalAuthority} from './rollout-auth.js';
import {canonicalSha256} from './v2-canonical.js';

type Policy={account_id:string;approval_ref:string;subject:string;activated_at:string;revision:number;status:'APPROVED'|'REVOKED'};
export type InquiryApprovalInput=Readonly<{accountId:string;approvalRef:string;subject:string}>;
const valid=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/.test(v);
function approvalSnapshot(input:InquiryApprovalInput){const copy={} as Record<string,string>;for(const key of ['accountId','approvalRef','subject'] as const){const descriptor=input&&Object.getOwnPropertyDescriptor(input,key);const value=descriptor&&'value' in descriptor?descriptor.value:undefined;if(!valid(value))throw Error('INQUIRY_APPROVAL_INVALID');copy[key]=value}return Object.freeze(copy) as InquiryApprovalInput}
/** Host-owned opaque registration approval. No HTTP/request-label issuer. */
export function createAccountInquiryApprovalAuthority(){
  const issued=new WeakMap<object,InquiryApprovalInput>();
  return {issue(input:InquiryApprovalInput){const copy=approvalSnapshot(input);const token=Object.freeze({});issued.set(token,copy);return token},verify(token:object,input:InquiryApprovalInput){const value=issued.get(token);return value&&value.accountId===input.accountId&&value.approvalRef===input.approvalRef&&value.subject===input.subject}};
}
/** Call only in the reviewed, owner-authorized activation operation. Never on app boot. */
export function registerAccountInquiryPolicy(database:V1Database,input:InquiryApprovalInput,token:object,authority:ReturnType<typeof createAccountInquiryApprovalAuthority>){
  input=approvalSnapshot(input);
  if(!authority.verify(token,input))throw Error('INQUIRY_REGISTRATION_APPROVAL_REQUIRED');
  return database.runImmediate(()=>{
    const db=database.db;
    if(!db.prepare('SELECT 1 FROM channel_accounts WHERE id=?').get(input.accountId))throw Error('INQUIRY_CANONICAL_ACCOUNT_REQUIRED');
    db.prepare("INSERT OR IGNORE INTO account_inquiry_policies(account_id,approval_ref,subject,activated_at,revision,status,boundary) VALUES(?,?,?,?,1,'APPROVED','SALES_ORDER.DRAFT')")
      .run(input.accountId,input.approvalRef,input.subject,new Date().toISOString());
    const row=db.prepare('SELECT * FROM account_inquiry_policies WHERE account_id=?').get(input.accountId) as Policy|undefined;
    if(!row||row.approval_ref!==input.approvalRef||row.subject!==input.subject||row.status!=='APPROVED')throw Error('INQUIRY_POLICY_CONFLICT');
    return row;
  });
}
type Active={canonical:CanonicalIngress;revision:number;startedAt:string};
export class AccountInquiryController {
  private readonly admissions=new WeakMap<object,Active>();
  private readonly active=new Map<string,Active>();
  constructor(private readonly database:V1Database,private readonly accountId:string,
    private readonly router:V2CanaryIngressRouter,private readonly migrationAuthority:MigrationApprovalAuthority,
    private readonly rollout:V2RolloutService,private readonly rolloutAuthority:RolloutApprovalAuthority){
    if(!valid(accountId))throw Error('INQUIRY_ACCOUNT_REQUIRED');
    if(!this.policy())throw Error('INQUIRY_POLICY_REQUIRED');
  }
  private key(account:string,message:string){return JSON.stringify([account,message])}
  private policy(){return this.database.db.prepare("SELECT p.* FROM account_inquiry_policies p JOIN channel_accounts a ON a.id=p.account_id WHERE p.account_id=? AND p.status='APPROVED' AND p.boundary='SALES_ORDER.DRAFT'").get(this.accountId) as Policy|undefined}
  verifyAdmission(token:unknown,canonical:CanonicalIngress){
    if(!token||typeof token!=='object')return false;
    const value=this.admissions.get(token);const p=this.policy();
    return Boolean(value&&p&&p.revision===value.revision&&value.canonical.message.accountId===canonical.message.accountId&&value.canonical.message.conversationId===canonical.message.conversationId&&value.canonical.message.externalMessageId===canonical.message.externalMessageId&&value.canonical.customerId===canonical.customerId);
  }
  /** Only the app's actual normalized channel callback calls this method. */
  async receiveFromChannel(input:IncomingChannelMessage){
    if(input.channel!=='whatsapp')throw Error('INQUIRY_CHANNEL_REQUIRED');
    const p=this.policy();
    if(!p||input.accountId!==this.accountId)throw Error('INQUIRY_ACCOUNT_DENIED');
    if(/@(g\.us|broadcast|newsletter)$/.test(input.conversationId))throw Error('INQUIRY_DIRECT_CONTACT_REQUIRED');
    const occurred=Date.parse(input.occurredAt);
    if(!Number.isFinite(occurred)||occurred<Date.parse(p.activated_at)||occurred>Date.now()+300000)throw Error('INQUIRY_FRESH_INPUT_REQUIRED');
    const db=this.database.db;
    if(db.prepare('SELECT 1 FROM account_inquiry_admissions WHERE account_id=? AND external_message_id=?').get(input.accountId,input.externalMessageId))return {status:'INQUIRY_DUPLICATE_HELD'};
    // Never register pre-existing imported/paused/suppressed messages as fresh.
    if(db.prepare('SELECT 1 FROM messages WHERE account_id=? AND external_message_id=?').get(input.accountId,input.externalMessageId))throw Error('INQUIRY_HISTORICAL_INPUT_DENIED');
    this.adoptExistingVerifiedPhoneAlias(input);
    const canonical=this.router.canonicalize(input)!;
    const value:Active={canonical,revision:p.revision,startedAt:new Date().toISOString()};
    const claim=this.database.runImmediate(()=>{
      const current=this.policy();if(!current||current.revision!==p.revision)throw Error('INQUIRY_POLICY_CHANGED');
      return db.prepare("INSERT OR IGNORE INTO account_inquiry_admissions(account_id,external_message_id,conversation_id,customer_id,policy_revision,occurred_at,admitted_at,state) VALUES(?,?,?,?,?,?,?,'ADMITTED')")
        .run(input.accountId,input.externalMessageId,canonical.message.conversationId,canonical.customerId,p.revision,input.occurredAt,value.startedAt).changes;
    });
    if(claim!==1){if(!db.prepare('SELECT 1 FROM account_inquiry_admissions WHERE account_id=? AND external_message_id=?').get(input.accountId,input.externalMessageId))throw Error('INQUIRY_ADMISSION_PERSISTENCE_REQUIRED');return {status:'INQUIRY_DUPLICATE_HELD'}}
    const token=Object.freeze({});this.admissions.set(token,value);const key=this.key(input.accountId,input.externalMessageId);this.active.set(key,value);
    try{
      if(canonical.customerId!==null)this.ensureVerifiedWorkspace(canonical,p);
      if(!this.verifyAdmission(token,canonical))throw Error('INQUIRY_POLICY_CHANGED');
      const result=await this.router.receiveCanonicalForInquiry(canonical,token);
      const delivery=db.prepare('SELECT state FROM prospect_reply_delivery WHERE account_id=? AND external_message_id=?').get(input.accountId,input.externalMessageId) as {state:string}|undefined;
      const failed=!this.policy()||delivery?.state==='UNKNOWN'||['FAIL_CLOSED','FAILED','HANDOFF'].includes((result as any)?.status)||String((result as any)?.routeOutcome??'').startsWith('PROSPECT_AI_FALLBACK_');
      db.prepare('UPDATE account_inquiry_admissions SET state=?,error_code=? WHERE account_id=? AND external_message_id=?').run(failed?'FAILED':'COMPLETED',failed?'INQUIRY_PROCESSING_FAILED':null,input.accountId,input.externalMessageId);
      return result;
    }catch(error){
      // Bounded failure code; no provider errors/customer text/credentials in status.
      db.prepare("UPDATE account_inquiry_admissions SET state='FAILED',error_code='INQUIRY_PROCESSING_FAILED' WHERE account_id=? AND external_message_id=?").run(input.accountId,input.externalMessageId);
      throw error;
    }finally{this.active.delete(key);this.admissions.delete(token)}
  }
  private adoptExistingVerifiedPhoneAlias(input:IncomingChannelMessage){
    // The controller is reached only from authenticated, normalized direct
    // channel ingress. Phone comes from transport identity, never message text.
    if(input.sender.externalId!==input.conversationId||!/@(s\.whatsapp\.net|lid)$/.test(input.sender.externalId))return;
    const digits=(value:string|undefined)=>value?.replace(/[^0-9]/g,'')??'';
    const phone=digits(input.sender.phone);if(!/^[0-9]{5,20}$/.test(phone))return;
    if(input.sender.externalId.endsWith('@s.whatsapp.net')&&digits(input.sender.externalId.split('@')[0].replace(/:\d+$/,''))!==phone)return;
    this.database.runImmediate(()=>{
      const db=this.database.db;
      const rows=db.prepare("SELECT customer_id,phone,external_id FROM customer_channel_identities WHERE channel_account_id=? AND channel='whatsapp'").all(input.accountId) as Array<{customer_id:string;phone:string|null;external_id:string}>;
      const matches=rows.filter(r=>{const stored=r.phone??(/^\+?[0-9]{5,20}$/.test(r.external_id)?r.external_id:r.external_id.endsWith('@s.whatsapp.net')?r.external_id.split('@')[0].replace(/:\d+$/,''):undefined);return digits(stored??undefined)===phone});
      const customers=new Set(matches.map(r=>r.customer_id));
      if(customers.size!==1)return; // Unknown or ambiguous: public catalog only.
      const customerId=[...customers][0]!;
      if(!db.prepare('SELECT 1 FROM customers WHERE id=?').get(customerId))return;
      const existing=db.prepare('SELECT customer_id FROM customer_channel_identities WHERE channel_account_id=? AND external_id=?').get(input.accountId,input.sender.externalId) as {customer_id:string}|undefined;
      if(existing&&existing.customer_id!==customerId)throw Error('INQUIRY_CANONICAL_IDENTITY_CONFLICT');
      db.prepare('INSERT OR IGNORE INTO customer_channel_identities VALUES(?,?,?,?,?,?)').run('inquiry-alias-'+canonicalSha256([input.accountId,input.sender.externalId]).slice(0,24),customerId,input.accountId,input.channel,input.sender.externalId,input.sender.phone);
      const observed=db.prepare('SELECT customer_id,channel FROM customer_channel_identities WHERE channel_account_id=? AND external_id=?').get(input.accountId,input.sender.externalId) as {customer_id:string;channel:string}|undefined;
      if(observed?.customer_id!==customerId||observed.channel!==input.channel)throw Error('INQUIRY_IDENTITY_PERSISTENCE_REQUIRED');
    });
  }
  private ensureVerifiedWorkspace(canonical:CanonicalIngress,p:Policy){
    const scope={accountId:canonical.message.accountId,conversationId:canonical.message.conversationId,customerId:canonical.customerId!};
    // Recheck canonical relation; never create an identity binding here.
    const binding=this.database.db.prepare('SELECT 1 FROM customer_channel_identities WHERE channel_account_id=? AND external_id=? AND customer_id=? AND channel=?')
      .get(scope.accountId,canonical.message.sender.externalId,scope.customerId,canonical.message.channel);
    if(!binding)throw Error('INQUIRY_VERIFIED_IDENTITY_REQUIRED');
    const migration=new WorkspaceMigrationService(this.database,this.migrationAuthority);
    const issue=(action:MigrationAction,owner:MigrationOwner)=>{
      const a=migration.getAuthority(scope.accountId,scope.conversationId);
      const raw=this.database.db.prepare("SELECT value_json FROM customer_order_memory WHERE customer_id=? AND memory_type='pending_order' AND key_text=? ORDER BY rowid DESC LIMIT 1").get(scope.customerId,scope.conversationId) as {value_json:string}|undefined;
      let source:unknown=null;if(raw){try{source=JSON.parse(raw.value_json)}catch{source=raw.value_json}}
      const expectedHash=action==='SHADOW_IMPORT'?canonicalSha256(source):a.legacy_source_hash??'';
      const draft=a.work_item_id?this.database.db.prepare("SELECT current_revision FROM order_drafts WHERE work_item_id=? AND status='CURRENT'").get(a.work_item_id) as {current_revision:number}|undefined:undefined;
      return this.migrationAuthority.issue(p.subject,owner,action,{...scope,expectedState:a.migration_state,expectedHash,expectedRevision:a.revision,expectedWorkItemId:a.work_item_id??null,expectedDraftRevision:action==='PROMOTE_CANARY'?draft?.current_revision??null:null,compatibilityConfirmed:null});
    };
    let a=migration.getAuthority(scope.accountId,scope.conversationId);
    const prefix='inquiry-'+canonicalSha256([p.approval_ref,scope]).slice(0,32);
    if(a.migration_state==='V1_ONLY'){migration.shadowImport({...scope,idempotencyKey:prefix+'-shadow',approval:issue('SHADOW_IMPORT','MIGRATION_OWNER')});a=migration.getAuthority(scope.accountId,scope.conversationId)}
    if(a.migration_state==='SHADOW_IMPORT'&&!a.quarantine_reason){const draft=a.work_item_id?this.database.db.prepare("SELECT current_revision FROM order_drafts WHERE work_item_id=? AND status='CURRENT'").get(a.work_item_id) as {current_revision:number}|undefined:undefined;migration.promoteCanary({...scope,expectedLegacySourceHash:a.legacy_source_hash??'',expectedWorkItemId:a.work_item_id??null,expectedDraftRevision:draft?.current_revision??null,idempotencyKey:prefix+'-canary',approval:issue('PROMOTE_CANARY','V1_OWNER')});a=migration.getAuthority(scope.accountId,scope.conversationId)}
    if(a.authoritative_writer!=='V2'||a.quarantine_reason||!['V2_CANARY','V2_PRIMARY','LEGACY_RETIRED'].includes(a.migration_state))throw Error('INQUIRY_WORKSPACE_NOT_READY');
    for(const capability of V2_CAPABILITIES){
      const exact=this.database.db.prepare('SELECT enabled FROM v2_capability_rollouts WHERE capability=? AND account_id=? AND conversation_id=?').get(capability,scope.accountId,scope.conversationId) as {enabled:number}|undefined;
      if(exact?.enabled===0)throw Error('INQUIRY_WORKSPACE_PERMISSION_REVOKED');
      if(exact?.enabled===1)continue;
      const intent={action:'ENABLE' as const,capability,accountId:scope.accountId,conversationId:scope.conversationId,enabled:true};
      this.rollout.enableIfAbsent({...intent,idempotencyKey:prefix+'-'+capability,approval:this.rolloutAuthority.issue(p.subject,intent)},()=>{
        // Re-read inside the first-grant writer transaction, not from the
        // earlier absence/authority snapshot. Concurrent revocations win.
        const current=this.policy();if(!current||current.revision!==p.revision)throw Error('INQUIRY_POLICY_CHANGED');
        if(!this.database.db.prepare('SELECT 1 FROM conversations c JOIN customer_channel_identities i ON i.customer_id=c.customer_id AND i.channel_account_id=c.channel_account_id WHERE c.id=? AND c.channel_account_id=? AND c.customer_id=? AND i.external_id=? AND i.channel=?').get(scope.conversationId,scope.accountId,scope.customerId,canonical.message.sender.externalId,canonical.message.channel))throw Error('INQUIRY_VERIFIED_IDENTITY_REQUIRED');
        const authority=this.database.db.prepare("SELECT revision,work_item_id,authoritative_writer,migration_state,quarantine_reason FROM workspace_authority WHERE account_id=? AND conversation_id=? AND work_item_type='SALES_ORDER_REQUEST'").get(scope.accountId,scope.conversationId) as typeof a|undefined;
        if(!authority||authority.revision!==a.revision||authority.work_item_id!==a.work_item_id||authority.authoritative_writer!=='V2'||authority.quarantine_reason||authority.migration_state!==a.migration_state)throw Error('INQUIRY_WORKSPACE_AUTHORITY_CHANGED');
      });
    }
    if(!V2_CAPABILITIES.every(capability=>this.rollout.evaluate({capability,accountId:scope.accountId,conversationId:scope.conversationId}).effectiveV2))throw Error('INQUIRY_WORKSPACE_PERMISSION_REQUIRED');
  }
  installReplyFence(channel:ChannelAdapter){
    const send=channel.send.bind(channel);
    channel.send=async(message:OutgoingChannelMessage)=>{
      const policy=this.policy();if(!policy||message.accountId!==this.accountId)throw Error('INQUIRY_REPLY_ACCOUNT_DENIED');
      const current=[...this.active.values()].filter(v=>v.revision===policy.revision&&v.canonical.message.accountId===message.accountId);
      const match=current.find(v=>{
        const c=this.database.db.prepare('SELECT external_conversation_id FROM conversations WHERE id=? AND channel_account_id=?').get(v.canonical.message.conversationId,message.accountId) as {external_conversation_id:string}|undefined;
        if(c?.external_conversation_id!==message.conversationId)return false;
        if(v.canonical.customerId&&!this.database.db.prepare('SELECT 1 FROM conversations c JOIN customer_channel_identities i ON i.customer_id=c.customer_id AND i.channel_account_id=c.channel_account_id WHERE c.id=? AND c.channel_account_id=? AND c.customer_id=? AND i.external_id=?').get(v.canonical.message.conversationId,message.accountId,v.canonical.customerId,v.canonical.message.sender.externalId))return false;
        if(message.replyToExternalMessageId)return message.replyToExternalMessageId===v.canonical.message.externalMessageId;
        // Quotations must have a newly-created trusted outbound intent in the
        // current handling window; imported/ambiguous historical intent is held.
        return Boolean(v.canonical.customerId&&this.database.db.prepare("SELECT 1 FROM outbound_messages o JOIN quotations q ON q.id=o.entity_id WHERE o.client_message_id=? AND o.entity_type='QUOTATION' AND o.conversation_id=? AND q.customer_id=? AND o.created_at>=?")
          .get(message.clientMessageId,v.canonical.message.conversationId,v.canonical.customerId,v.startedAt));
      });
      if(!match)throw Error('INQUIRY_CURRENT_REPLY_PROVENANCE_REQUIRED');
      return send(message);
    };
  }
  describe(){const p=this.policy();return {enabled:Boolean(p),boundary:'SALES_ORDER.DRAFT',prospectAccess:'PUBLIC_CATALOG_ONLY',counts:this.database.db.prepare('SELECT state,count(*) AS count FROM account_inquiry_admissions WHERE account_id=? GROUP BY state').all(this.accountId)}};
}
