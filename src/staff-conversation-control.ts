import {createHash} from 'node:crypto';
import {V1Database} from './database.js';
import type {VerifyStaffCapability} from './staff-auth.js';
import type {OutgoingChannelMessage,ChannelSendResult} from './channel-contract.js';
import {ConversationReplyJournal,replyTextHash} from './conversation-reply-journal.js';

type Scope={accountId:string;conversationId:string};
type Control={mode:'AI'|'HUMAN';revision:number;subject:string|null};
type Command=Scope&{capability:unknown;expectedRevision:number;idempotencyKey:string};
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const identifier=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);

/** Staff capability and canonical direct recipient are required independently of Access. */
export class StaffConversationControl {
 private readonly permits=new WeakMap<object,{scope:Scope;subject:string;revision:number}>();
 constructor(private readonly database:V1Database,private readonly verifyStaff:VerifyStaffCapability,
  private readonly runtime:{accountId?:string;enabled:()=>boolean;inFlight:(scope:Scope)=>boolean;connected?:()=>Promise<boolean>}){}
 snapshot(scope:Scope):Control {
  const row=this.database.db.prepare('SELECT mode,revision,subject FROM conversation_staff_control WHERE account_id=? AND conversation_id=?').get(scope.accountId,scope.conversationId) as Control|undefined;
  return row??{mode:'AI',revision:0,subject:null};
 }
 allowsAi(scope:Scope,revision:number){const c=this.snapshot(scope);return c.mode==='AI'&&c.revision===revision;}
 private destination(scope:Scope){
  if(!this.runtime.enabled()||scope.accountId!==this.runtime.accountId)throw Error('STAFF_CHAT_RUNTIME_UNAVAILABLE');
  const row=this.database.db.prepare("SELECT c.external_conversation_id FROM conversations c JOIN channel_accounts a ON a.id=c.channel_account_id WHERE c.id=? AND c.channel_account_id=? AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.account_id=c.channel_account_id AND m.direction='INBOUND' AND m.sender_external_id=c.external_conversation_id)").get(scope.conversationId,scope.accountId) as {external_conversation_id:string}|undefined;
  if(!row||!/^\d{5,20}(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(row.external_conversation_id))throw Error('STAFF_CHAT_DIRECT_CONVERSATION_REQUIRED');
  return row.external_conversation_id;
 }
 private unresolved(scope:Scope){return Boolean(this.database.db.prepare("SELECT 1 FROM conversation_reply_journal WHERE account_id=? AND conversation_id=? AND state='UNKNOWN' UNION ALL SELECT 1 FROM outbound_messages WHERE conversation_id=? AND status IN ('PENDING','UNKNOWN') LIMIT 1").get(scope.accountId,scope.conversationId,scope.conversationId));}
 describe(scope:Scope,capability?:unknown){
  const c=this.snapshot(scope),subject=this.verifyStaff(capability);let available=true;try{this.destination(scope)}catch{available=false}
  const draining=this.runtime.inFlight(scope),unresolved=this.unresolved(scope);
  return {...c,available,authenticated:Boolean(subject),owned:Boolean(subject&&c.subject===subject),draining,unresolved,
   canTakeover:Boolean(available&&subject&&c.mode==='AI'),canResume:Boolean(available&&subject&&c.mode==='HUMAN'&&c.subject===subject&&!draining&&!unresolved),
   canSend:Boolean(available&&subject&&c.mode==='HUMAN'&&c.subject===subject&&!draining&&!unresolved)};
 }
 private checked(input:Command){
  const subject=this.verifyStaff(input.capability);if(!subject)throw Error('STAFF_SESSION_REQUIRED');
  if(!identifier(input.idempotencyKey)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw Error('STAFF_CHAT_COMMAND_INVALID');
  this.destination(input);return subject;
 }
 private event(input:Command,subject:string,action:string,text?:string){
  const hash=digest([input.accountId,input.conversationId,subject,action,input.expectedRevision,text??null]);
  const event=this.database.db.prepare('SELECT * FROM conversation_staff_events WHERE account_id=? AND command_id=?').get(input.accountId,input.idempotencyKey) as any;
  if(event&&event.command_hash!==hash)throw Error('STAFF_CHAT_IDEMPOTENCY_CONFLICT');
  return {hash,event};
 }
 transition(input:Command&{action:'TAKEOVER'|'RESUME'}){
  const subject=this.checked(input);if(!['TAKEOVER','RESUME'].includes(input.action))throw Error('STAFF_CHAT_COMMAND_INVALID');
  return this.database.runImmediate(()=>this.database.runOutboundMutation(()=>{
   this.destination(input);const {hash,event}=this.event(input,subject,input.action);if(event)return this.describe(input,input.capability);
   const current=this.snapshot(input);if(current.revision!==input.expectedRevision)throw Error('STAFF_CHAT_REVISION_CONFLICT');
   if(input.action==='TAKEOVER'&&current.mode!=='AI')throw Error('STAFF_CHAT_ALREADY_OWNED');
   if(input.action==='RESUME'&&(current.mode!=='HUMAN'||current.subject!==subject))throw Error('STAFF_CHAT_OWNER_REQUIRED');
   if(input.action==='RESUME'&&(this.runtime.inFlight(input)||this.unresolved(input)))throw Error('STAFF_CHAT_DELIVERY_UNRESOLVED');
   const mode=input.action==='TAKEOVER'?'HUMAN':'AI',owner=mode==='HUMAN'?subject:null,revision=current.revision+1,at=new Date().toISOString();
   const changed=current.revision===0?this.database.db.prepare('INSERT INTO conversation_staff_control VALUES(?,?,?,?,?,?)').run(input.accountId,input.conversationId,mode,revision,owner,at):this.database.db.prepare('UPDATE conversation_staff_control SET mode=?,revision=?,subject=?,updated_at=? WHERE account_id=? AND conversation_id=? AND revision=?').run(mode,revision,owner,at,input.accountId,input.conversationId,current.revision);
   if(changed.changes!==1||this.snapshot(input).revision!==revision)throw Error('STAFF_CHAT_CONTROL_PERSISTENCE_REQUIRED');
   this.record(input,subject,input.action,hash,revision,null,at);
   return this.describe(input,input.capability);
  }));
 }
 private record(input:Command,subject:string,action:string,hash:string,revision:number,client:string|null,at:string){
  const row=this.database.db.prepare('INSERT INTO conversation_staff_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.accountId,input.idempotencyKey,input.conversationId,subject,action,hash,input.expectedRevision,revision,client,at);
  if(row.changes!==1||!this.database.db.prepare('SELECT 1 FROM conversation_staff_events WHERE account_id=? AND command_id=? AND command_hash=?').get(input.accountId,input.idempotencyKey,hash))throw Error('STAFF_CHAT_AUDIT_PERSISTENCE_REQUIRED');
 }
 private owned(input:Command,subject:string){const c=this.snapshot(input);if(c.mode!=='HUMAN'||c.subject!==subject)throw Error('STAFF_CHAT_OWNER_REQUIRED');if(c.revision!==input.expectedRevision)throw Error('STAFF_CHAT_REVISION_CONFLICT');return c;}
 /** Only the exact host-created wire object receives a short-lived permit. */
 verifyManualWire(wire:OutgoingChannelMessage){
  const permit=this.permits.get(wire);if(!permit)return false;
  try{
   const c=this.snapshot(permit.scope);if(c.mode!=='HUMAN'||c.subject!==permit.subject||c.revision!==permit.revision||this.runtime.inFlight(permit.scope))return false;
   if(wire.accountId!==permit.scope.accountId||wire.conversationId!==this.destination(permit.scope)||wire.attachments||wire.replyToExternalMessageId)return false;
   const row=this.database.db.prepare("SELECT text_hash FROM conversation_reply_journal WHERE client_message_id=? AND account_id=? AND conversation_id=? AND source='STAFF' AND state='UNKNOWN'").get(wire.clientMessageId,permit.scope.accountId,permit.scope.conversationId) as {text_hash:string}|undefined;
   return row?.text_hash===replyTextHash(wire.text);
  }catch{return false}
 }
 async send(input:Command&{text:string},outbound:{send:(message:OutgoingChannelMessage)=>Promise<ChannelSendResult>}){
  // Snapshot text/command fields before any async provider work.
  input={...input};const subject=this.checked(input);if(typeof input.text!=='string'||!input.text.trim()||input.text.length>4000)throw Error('STAFF_CHAT_TEXT_INVALID');
  const connected=this.runtime.connected?await this.runtime.connected():true;
  const text=input.text,client='staff-'+digest([input.accountId,input.idempotencyKey]),journal=new ConversationReplyJournal(this.database);
  const prepared=this.database.runImmediate(()=>this.database.runOutboundMutation(()=>{
   this.destination(input);const {hash,event}=this.event(input,subject,'SEND',text);
   if(event)return {duplicate:true,destination:null};
   if(!connected)throw Error('STAFF_CHAT_CHANNEL_UNAVAILABLE');
   this.owned(input,subject);if(this.runtime.inFlight(input)||this.unresolved(input))throw Error('STAFF_CHAT_DELIVERY_UNRESOLVED');
   const at=new Date().toISOString();this.record(input,subject,'SEND',hash,input.expectedRevision,client,at);
   // Journal.claim opens its own transaction, so create the same guarded intent
   // atomically with the staff audit inside this existing writer transaction.
   const inserted=this.database.db.prepare("INSERT INTO conversation_reply_journal VALUES(?,?,?,?,?,?,?,'UNKNOWN',NULL,?,?)").run(client,input.accountId,input.conversationId,'STAFF',input.idempotencyKey,text,replyTextHash(text),at,at);
   if(inserted.changes!==1||!this.database.db.prepare('SELECT 1 FROM conversation_reply_journal WHERE client_message_id=?').get(client))throw Error('STAFF_CHAT_INTENT_PERSISTENCE_REQUIRED');
   this.database.db.prepare('UPDATE conversations SET last_message_at=CASE WHEN julianday(last_message_at) IS NULL OR julianday(last_message_at)<=julianday(?) THEN ? ELSE last_message_at END WHERE id=? AND channel_account_id=?').run(at,at,input.conversationId,input.accountId);
   return {duplicate:false,destination:this.destination(input)};
  }));
  if(!prepared.duplicate){
   const wire=Object.freeze({accountId:input.accountId,conversationId:prepared.destination!,clientMessageId:client,text});
   this.permits.set(wire,{scope:{accountId:input.accountId,conversationId:input.conversationId},subject,revision:input.expectedRevision});
   try{const result=await outbound.send(wire);journal.finalize(client,result)}catch{/* Provider/persistence ambiguity stays UNKNOWN. Never auto-retry. */}finally{this.permits.delete(wire)}
  }
  const disposition=this.database.db.prepare('SELECT state deliveryState FROM conversation_reply_journal WHERE client_message_id=?').get(client) as {deliveryState:string}|undefined;
  if(!disposition)throw Error('STAFF_CHAT_INTENT_REQUIRED');
  return {...disposition,clientMessageId:client,duplicate:prepared.duplicate,physicalDeliveryConfirmed:false,control:this.describe(input,input.capability)};
 }
}
