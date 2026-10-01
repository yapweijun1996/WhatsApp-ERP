import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
test('read-only conversation selection isolates account, customer, messages and trace without writes or reassignment',async()=>{
 const saved={...process.env};process.env.ORDER_CHANNEL='simulated';process.env.DEMO_GPT_ENABLED='false';process.env.V2_CANARY_RUNTIME_ENABLED='false';
 const {app,service}=createApp({dbFilename:':memory:',startupMode:'paused'});const db=service.database.db;
 try{
  db.prepare("UPDATE customers SET name='Synthetic Alpha' WHERE id='CUST-001'").run();
  db.prepare("INSERT INTO customers VALUES('synthetic-beta','BETA','Synthetic Beta','SGD','CLEAR','SG-MAIN')").run();
  db.prepare("INSERT INTO conversations VALUES('synthetic-beta-conv','demo-account','synthetic-beta-external','synthetic-beta','OPEN','2026-10-01T00:00:00Z')").run();
  db.prepare("INSERT INTO conversations VALUES('synthetic-other-conv','other-account','synthetic-other-external',NULL,'OPEN','2026-10-01T01:00:00Z')").run();
  db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run('synthetic-beta-message','synthetic-beta-conv','synthetic-beta-inbound','INBOUND','text','Synthetic Beta message','synthetic-sender','+6500000002','demo-account','2026-10-01T00:00:00Z');
  const before=db.prepare('SELECT id,customer_id FROM conversations ORDER BY id').all();const count=db.prepare('SELECT count(*) n FROM messages').get();
  const list=(await app.inject('/api/conversations')).json().conversations;
  assert.equal(list.some((c:any)=>c.id==='synthetic-other-conv'),false);assert.equal(list.find((c:any)=>c.id==='synthetic-beta-conv').customerName,'Synthetic Beta');
  const beta=await app.inject('/api/state?conversationId=synthetic-beta-conv');assert.equal(beta.statusCode,200);assert.equal(beta.json().customer,'Synthetic Beta');assert.equal(beta.json().phone,'+6500000002');assert.equal(beta.json().conversation.customerId,'synthetic-beta');assert.deepEqual(beta.json().messages.map((m:any)=>m.text),['Synthetic Beta message']);assert.equal(beta.json().quote,undefined);
  const alpha=(await app.inject('/api/state?conversationId=conv-001')).json();assert.equal(alpha.customer,'Synthetic Alpha');assert.equal(alpha.messages.some((m:any)=>m.text==='Synthetic Beta message'),false);
  for(const endpoint of ['/api/state','/api/agent-trace'])for(const id of ['synthetic-other-conv','missing-conversation'])assert.equal((await app.inject(endpoint+'?conversationId='+id)).statusCode,404);
  assert.deepEqual(db.prepare('SELECT id,customer_id FROM conversations ORDER BY id').all(),before);assert.deepEqual(db.prepare('SELECT count(*) n FROM messages').get(),count);
 }finally{await app.close();db.close();process.env=saved}
});
