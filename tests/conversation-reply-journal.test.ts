import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {V1Database} from '../src/database.js';
import {ConversationReplyJournal} from '../src/conversation-reply-journal.js';
import {conversationMessageFeed} from '../src/conversation-message-feed.js';
import {CommerceService} from '../src/commerce.js';
import {V2CanaryIngressRouter} from '../src/v2-canary-ingress-router.js';
import {V2RolloutService} from '../src/v2-rollout.js';
import {createRolloutApprovalAuthority} from '../src/rollout-auth.js';
const input={clientMessageId:'synthetic-journal-reply',accountId:'demo-account',conversationId:'conv-001',source:'PROSPECT' as const,sourceMessageId:'synthetic-inbound',text:'Synthetic recorded reply'};
const ack={status:'submitted' as const,externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};
function db(file=':memory:'){const d=new V1Database(file);d.resetAndSeed();d.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)').run('synthetic-journal-source','conv-001',input.sourceMessageId,'INBOUND','text','Synthetic journal source','demo-account',new Date(Date.now()-100).toISOString());return d}
function prospect(d:V1Database,send:Function){const a=createRolloutApprovalAuthority();return new V2CanaryIngressRouter(d,new CommerceService(d),new V2RolloutService(d,a),{enabled:true,prospectReplyScopes:[{accountId:'demo-account',externalConversationId:'synthetic-fresh-chat'}],prospectModel:async()=> 'Synthetic grounded-free reply',outbound:{send} as any})}
const incoming={accountId:'demo-account',conversationId:'synthetic-fresh-chat',externalMessageId:'synthetic-live-inbound',channel:'whatsapp' as const,sender:{externalId:'synthetic-unlinked'},type:'text' as const,text:'Synthetic greeting',occurredAt:new Date(Date.now()-100).toISOString()};
test('prospect reply text is durable UNKNOWN before provider, then visible SUBMITTED without claiming delivery',async()=>{
 const d=db();try{let calls=0;const router=prospect(d,async(m:any)=>{calls++;const row=d.db.prepare('SELECT * FROM conversation_reply_journal').get() as any;assert.equal(row.state,'UNKNOWN');assert.equal(row.text,m.text);return ack});await router.receive(incoming);const canonical=router.canonicalize(incoming)!;const feed=conversationMessageFeed(d.db,incoming.accountId,canonical.message.conversationId);assert.equal(calls,1);assert.deepEqual(feed.messages.map(m=>m.from),['customer','ai']);assert.equal(feed.messages[1].text,'Synthetic grounded-free reply');assert.equal(feed.messages[1].deliveryState,'SUBMITTED');assert.equal(feed.replyHistoryNotice.physicalDeliveryConfirmed,false);await router.receive(incoming);assert.equal(calls,1);assert.equal((d.db.prepare('SELECT count(*) n FROM conversation_reply_journal').get() as any).n,1)}finally{d.db.close()}
});
test('journal insertion failure atomically preserves claim and makes zero provider calls',async()=>{
 const d=db();try{d.db.exec("CREATE TRIGGER synthetic_ignore_reply BEFORE INSERT ON conversation_reply_journal BEGIN SELECT RAISE(IGNORE); END");let sends=0;await assert.rejects(prospect(d,async()=>{sends++;return ack}).receive(incoming),/REPLY_INTENT_PERSISTENCE_REQUIRED/);assert.equal(sends,0);assert.equal((d.db.prepare('SELECT state FROM prospect_reply_delivery').get() as any).state,'CLAIMED');assert.equal((d.db.prepare('SELECT count(*) n FROM conversation_reply_journal').get() as any).n,0)}finally{d.db.close()}
});
test('fault after provider submission retains UNKNOWN text and never resends',async()=>{
 const d=db();try{d.db.exec("CREATE TRIGGER synthetic_fault_reply BEFORE UPDATE ON conversation_reply_journal WHEN NEW.state='SUBMITTED' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_DISPOSITION_FAILURE'); END");let sends=0;const r=prospect(d,async()=>{sends++;return ack});await r.receive(incoming);await r.receive(incoming);assert.equal(sends,1);const c=r.canonicalize(incoming)!;const feed=conversationMessageFeed(d.db,incoming.accountId,c.message.conversationId);assert.equal(feed.messages.at(-1).deliveryState,'UNKNOWN');assert.equal(feed.messages.at(-1).text,'Synthetic grounded-free reply');assert.equal((d.db.prepare('SELECT state FROM prospect_reply_delivery').get() as any).state,'UNKNOWN')}finally{d.db.close()}
});
test('provider failure is shown as failure, not a successful or automatically retried reply',async()=>{
 const d=db();try{let calls=0;const r=prospect(d,async()=>{calls++;return{status:'failed',retryable:false,errorCode:'SYNTHETIC_FAILURE'}});await r.receive(incoming);await r.receive(incoming);assert.equal(calls,1);assert.equal((d.db.prepare('SELECT state FROM conversation_reply_journal').get() as any).state,'FAILED')}finally{d.db.close()}
});
test('journal scope, payload and terminal state cannot be forged or rewritten',()=>{
 const d=db();try{const j=new ConversationReplyJournal(d);assert.throws(()=>j.claim({...input,accountId:'other-account'}),/CONVERSATION_SCOPE/);assert.equal(j.claim(input),true);assert.equal(j.claim(input),false);assert.throws(()=>j.claim({...input,text:'Different payload'}),/IDEMPOTENCY_CONFLICT/);assert.throws(()=>d.db.prepare("UPDATE conversation_reply_journal SET text='changed'").run(),/SERVICE_REQUIRED|PAYLOAD_IMMUTABLE/);assert.throws(()=>d.runOutboundMutation(()=>d.db.prepare("UPDATE conversation_reply_journal SET text='changed'").run()),/PAYLOAD_IMMUTABLE/);j.finalize(input.clientMessageId,ack);assert.throws(()=>d.runOutboundMutation(()=>d.db.prepare("UPDATE conversation_reply_journal SET state='UNKNOWN'").run()),/TERMINAL/);assert.equal(conversationMessageFeed(d.db,'other-account','conv-001').messages.length,0)}finally{d.db.close()}
});
test('durable unknown intent survives reopening and is held instead of replayed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-reply-journal-')),file=join(dir,'synthetic.db');let d=db(file);try{assert.equal(new ConversationReplyJournal(d).claim(input),true);d.db.close();d=new V1Database(file);assert.equal(new ConversationReplyJournal(d).claim(input),false);assert.equal(conversationMessageFeed(d.db,input.accountId,input.conversationId).messages.at(-1).deliveryState,'UNKNOWN')}finally{d.db.close();rmSync(dir,{recursive:true,force:true})}
});
test('pre-upgrade submission metadata is a notice, never invented reply text or a resend',()=>{
 const d=db();try{d.db.prepare("INSERT INTO prospect_reply_delivery VALUES(?,?,?,?,'SUBMITTED',?)").run('demo-account','old-provider-inbound','conv-001','old-client',new Date().toISOString());const before=(d.db.prepare('SELECT count(*) n FROM messages').get() as any).n;const feed=conversationMessageFeed(d.db,'demo-account','conv-001');assert.equal(feed.replyHistoryNotice.unrecordedSubmitted,1);assert.equal(feed.replyHistoryNotice.physicalDeliveryConfirmed,false);assert.equal(feed.messages.length,before);assert.ok(feed.messages.every(m=>m.from==='customer'));assert.equal((d.db.prepare('SELECT count(*) n FROM conversation_reply_journal').get() as any).n,0)}finally{d.db.close()}
});
test('malformed provider acknowledgement remains UNKNOWN rather than claiming submission',async()=>{
 const d=db();try{let calls=0;const r=prospect(d,async()=>{calls++;return{status:'submitted'}});await r.receive(incoming);await r.receive(incoming);assert.equal(calls,1);assert.equal((d.db.prepare('SELECT state FROM conversation_reply_journal').get() as any).state,'UNKNOWN');assert.equal((d.db.prepare('SELECT state FROM prospect_reply_delivery').get() as any).state,'UNKNOWN')}finally{d.db.close()}
});
