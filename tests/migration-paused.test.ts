import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';

test('paused migration never connects QR or reconciles outbound and rejects writes',async()=>{
 const saved={...process.env};const dir=mkdtempSync(join(tmpdir(),'waerp-paused-'));const auth=join(dir,'auth');
 process.env.ORDER_CHANNEL='whatsapp-qr';process.env.WHATSAPP_AUTH_DIR=auth;process.env.DEMO_GPT_ENABLED='false';process.env.V2_CANARY_RUNTIME_ENABLED='false';
 const {app,service,channel,startupReady}=createApp({dbFilename:':memory:',startupMode:'paused'});
 try{
  let reconciles=0;service.reconcileOutbound=async()=>{reconciles++};await startupReady;
  assert.equal(await channel.getStatus(),'disconnected');assert.equal(existsSync(auth),false);assert.equal(reconciles,0);
  const before=service.database.db.prepare('SELECT count(*) n FROM messages').get();
  let sends=0;channel.send=async()=>{sends++;throw Error('UNEXPECTED_SEND')};
  await (channel as any).handler({channel:'whatsapp',accountId:'test-only-account',externalMessageId:'paused-unknown-inbound',conversationId:'test-only-conversation',sender:{externalId:'test-only-unknown'},type:'text',text:'Synthetic test message',occurredAt:new Date().toISOString()});
  assert.equal(sends,0);assert.deepEqual(service.database.db.prepare('SELECT count(*) n FROM messages').get(),before);
  for(const url of ['/api/simulated/inbound','/api/staff/session','/api/staff/post','/api/reset']){
   const r=await app.inject({method:'POST',url,payload:{text:'Do not send'}});assert.equal(r.statusCode,503);assert.equal(r.json().error,'MIGRATION_RUNTIME_PAUSED');
  }
  assert.deepEqual(service.database.db.prepare('SELECT count(*) n FROM messages').get(),before);
  const health=(await app.inject('/health')).json();assert.equal(health.startupMode,'paused');assert.equal(health.modelMode,'deterministic');
  assert.equal((await app.inject('/api/state')).statusCode,200);
 }finally{await channel.disconnect();await app.close();service.database.db.close();process.env=saved;rmSync(dir,{recursive:true,force:true})}
});
