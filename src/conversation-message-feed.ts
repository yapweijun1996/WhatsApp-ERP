import type Database from 'better-sqlite3';
export function conversationMessageFeed(db:Database.Database,accountId:string,conversationId:string){
 const messages=(db.prepare('SELECT id,direction,text,message_type messageType,occurred_at occurredAt FROM messages WHERE conversation_id=? AND account_id=? ORDER BY rowid').all(conversationId,accountId) as any[]).map(m=>({...m,from:m.direction==='INBOUND'?'customer':'ai'}));
 const replies=(db.prepare('SELECT client_message_id id,text,source,state deliveryState,created_at occurredAt FROM conversation_reply_journal WHERE conversation_id=? AND account_id=? ORDER BY rowid').all(conversationId,accountId) as any[]).map(m=>({...m,direction:'OUTBOUND',messageType:'text',from:m.source==='STAFF'?'staff':'ai'}));
 const merged=[...messages,...replies].sort((a,b)=>(Date.parse(a.occurredAt)||0)-(Date.parse(b.occurredAt)||0));
 // Never invent/re-send historical reply text that was not retained pre-upgrade.
 const missing=db.prepare("SELECT COUNT(*) n FROM prospect_reply_delivery p WHERE p.account_id=? AND p.conversation_id=? AND p.state='SUBMITTED' AND NOT EXISTS(SELECT 1 FROM conversation_reply_journal j WHERE j.client_message_id=p.client_message_id)").get(accountId,conversationId) as {n:number};
 return {messages:merged,replyHistoryNotice:{unrecordedSubmitted:missing.n,physicalDeliveryConfirmed:false}};
}
