import {createHash} from 'node:crypto';
import {V1Database} from './database.js';
import type {ChannelSendResult} from './channel-contract.js';
export const replyTextHash=(text:string)=>createHash('sha256').update(text).digest('hex');
type Intent={clientMessageId:string;accountId:string;conversationId:string;source:'PROSPECT'|'STAFF';sourceMessageId?:string;text:string};
/** Host-owned delivery journal; only the existing OutboundMessageService sends. */
export class ConversationReplyJournal{
 constructor(private readonly database:V1Database){}
 claim(input:Intent,beforeInsert?:()=>void){
  const copy={} as Record<string,unknown>;for(const key of ['clientMessageId','accountId','conversationId','source','sourceMessageId','text']){const d=Object.getOwnPropertyDescriptor(input,key);if(d&&!('value' in d))throw Error('REPLY_INTENT_INVALID');copy[key]=d?.value}
  if(!['PROSPECT','STAFF'].includes(String(copy.source))||['clientMessageId','accountId','conversationId'].some(k=>typeof copy[k]!=='string'||!(copy[k] as string).length||(copy[k] as string).length>512)||typeof copy.text!=='string'||(copy.sourceMessageId!==undefined&&typeof copy.sourceMessageId!=='string'))throw Error('REPLY_INTENT_INVALID');
  input=Object.freeze(copy) as Intent;
  if(!input.text||input.text.length>16000)throw Error('REPLY_TEXT_INVALID');
  return this.database.runImmediate(()=>this.database.runOutboundMutation(()=>{
   const db=this.database.db;
   if(!db.prepare('SELECT 1 FROM conversations WHERE id=? AND channel_account_id=?').get(input.conversationId,input.accountId))throw Error('REPLY_CONVERSATION_SCOPE');
   if(input.source==='PROSPECT'&&!db.prepare("SELECT 1 FROM messages WHERE external_message_id=? AND account_id=? AND conversation_id=? AND direction='INBOUND'").get(input.sourceMessageId,input.accountId,input.conversationId))throw Error('REPLY_INBOUND_PROVENANCE_REQUIRED');
   const existing=db.prepare('SELECT text_hash,account_id,conversation_id,source,source_message_id FROM conversation_reply_journal WHERE client_message_id=?').get(input.clientMessageId) as any;
   if(existing){if(existing.text_hash!==replyTextHash(input.text)||existing.account_id!==input.accountId||existing.conversation_id!==input.conversationId||existing.source!==input.source||existing.source_message_id!==(input.sourceMessageId??null))throw Error('REPLY_IDEMPOTENCY_CONFLICT');return false}
   beforeInsert?.();
   const at=new Date().toISOString();const inserted=db.prepare("INSERT INTO conversation_reply_journal VALUES(?,?,?,?,?,?,?,'UNKNOWN',NULL,?,?)").run(input.clientMessageId,input.accountId,input.conversationId,input.source,input.sourceMessageId??null,input.text,replyTextHash(input.text),at,at);
   if(inserted.changes!==1||!db.prepare('SELECT 1 FROM conversation_reply_journal WHERE client_message_id=? AND text_hash=?').get(input.clientMessageId,replyTextHash(input.text)))throw Error('REPLY_INTENT_PERSISTENCE_REQUIRED');
   db.prepare('UPDATE conversations SET last_message_at=CASE WHEN julianday(last_message_at) IS NULL OR julianday(last_message_at)<=julianday(?) THEN ? ELSE last_message_at END WHERE id=? AND channel_account_id=?').run(at,at,input.conversationId,input.accountId);
   return true;
  }));
 }
 finalize(clientMessageId:string,result:ChannelSendResult|undefined){
  const acknowledged=result?.status==='submitted'&&typeof result.externalMessageId==='string'&&result.externalMessageId.length>0&&result.externalMessageId.length<=512&&Number.isFinite(Date.parse(result.submittedAt));
  const state=acknowledged?'SUBMITTED':result?.status==='failed'?'FAILED':'UNKNOWN';
  this.database.runImmediate(()=>this.database.runOutboundMutation(()=>{
   const db=this.database.db;const row=db.prepare('SELECT state FROM conversation_reply_journal WHERE client_message_id=?').get(clientMessageId) as {state:string}|undefined;if(!row)throw Error('REPLY_INTENT_REQUIRED');
   if(row.state!== 'UNKNOWN'){if(row.state!==state)throw Error('REPLY_DISPOSITION_CONFLICT');return}
   const changed=db.prepare("UPDATE conversation_reply_journal SET state=?,provider_message_id=?,updated_at=? WHERE client_message_id=? AND state='UNKNOWN'").run(state,acknowledged&&result?.status==='submitted'?result.externalMessageId:null,new Date().toISOString(),clientMessageId);
   const observed=db.prepare('SELECT state FROM conversation_reply_journal WHERE client_message_id=?').get(clientMessageId) as {state:string}|undefined;
   if(changed.changes!==1||observed?.state!==state)throw Error('REPLY_DISPOSITION_PERSISTENCE_REQUIRED');
  }));
  return state;
 }
}
