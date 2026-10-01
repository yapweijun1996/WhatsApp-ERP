import type Database from 'better-sqlite3';
/** Read-only account-scoped list; every label/preview comes from canonical rows. */
export function listConversations(db:Database.Database,accountId:string){
 return db.prepare(`SELECT co.id,co.customer_id customerId,co.status,co.last_message_at lastMessageAt,
 cu.name customerName,cu.code customerCode,cu.currency,
 (SELECT text FROM (SELECT m.text,m.occurred_at at,m.rowid seq FROM messages m WHERE m.conversation_id=co.id AND m.account_id=co.channel_account_id UNION ALL SELECT j.text,j.created_at at,j.rowid seq FROM conversation_reply_journal j WHERE j.conversation_id=co.id AND j.account_id=co.channel_account_id) ORDER BY at DESC,seq DESC LIMIT 1) preview,
 (SELECT m.sender_phone FROM messages m WHERE m.conversation_id=co.id AND m.account_id=co.channel_account_id AND m.direction='INBOUND' ORDER BY m.rowid DESC LIMIT 1) phone,
 (SELECT q.quotation_no FROM quotations q WHERE q.source_conversation_id=co.id ORDER BY q.rowid DESC LIMIT 1) quotationNo,
 (SELECT so.status FROM sales_orders so JOIN quotations q ON q.id=so.source_quotation_id WHERE q.source_conversation_id=co.id ORDER BY q.rowid DESC LIMIT 1) orderStatus
 FROM conversations co LEFT JOIN customers cu ON cu.id=co.customer_id WHERE co.channel_account_id=? ORDER BY co.last_message_at DESC,co.rowid DESC`).all(accountId);
}
export function selectedConversation(db:Database.Database,accountId:string,id:string){
 return db.prepare(`SELECT co.id,co.channel_account_id accountId,co.customer_id customerId,co.status,cu.name customerName,cu.code customerCode,cu.currency,cu.credit_status creditStatus,cu.default_warehouse_id warehouse,
 (SELECT m.sender_phone FROM messages m WHERE m.conversation_id=co.id AND m.account_id=co.channel_account_id AND m.direction='INBOUND' ORDER BY m.rowid DESC LIMIT 1) phone
 FROM conversations co LEFT JOIN customers cu ON cu.id=co.customer_id WHERE co.channel_account_id=? AND co.id=?`).get(accountId,id) as {id:string;accountId:string;customerId:string|null;phone:string|null}|undefined;
}
