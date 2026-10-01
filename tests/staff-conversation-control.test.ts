import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {V1Database} from '../src/database.js';
import {createStaffCapabilityAuthority} from '../src/staff-auth.js';
import {StaffConversationControl} from '../src/staff-conversation-control.js';
import {conversationMessageFeed} from '../src/conversation-message-feed.js';
import {createAccountInquiryApprovalAuthority,registerAccountInquiryPolicy,AccountInquiryController} from '../src/account-inquiry-policy.js';
import {createMigrationApprovalAuthority} from '../src/migration-auth.js';
import {createRolloutApprovalAuthority} from '../src/rollout-auth.js';
import {V2RolloutService} from '../src/v2-rollout.js';
import {V2CanaryIngressRouter} from '../src/v2-canary-ingress-router.js';
import {CommerceService} from '../src/commerce.js';
import {createApp} from '../src/app.js';
import {SimulatedChannel} from '../src/channels.js';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const scope={accountId:'demo-account',conversationId:'synthetic-staff-chat'};
const ack={status:'submitted' as const,externalMessageId:'synthetic-provider-ack',submittedAt:new Date().toISOString()};
function setup(file=':memory:',existing=false){
 const db=new V1Database(file);if(!existing){db.resetAndSeed();db.db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)').run(scope.conversationId,scope.accountId,'65000000001@s.whatsapp.net',null,'OPEN',new Date().toISOString());db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,account_id,occurred_at) VALUES(?,?,?,'INBOUND','text',?,?,?,?)").run('synthetic-sender-proof',scope.conversationId,'synthetic-sender-proof','Synthetic previous inbound','65000000001@s.whatsapp.net',scope.accountId,new Date().toISOString())}
 const authority=createStaffCapabilityAuthority(),capability=authority.issue('synthetic-staff'),other=authority.issue('other-staff');let enabled=true,inFlight=false;
 const control=new StaffConversationControl(db,authority.verify,{accountId:scope.accountId,enabled:()=>enabled,inFlight:()=>inFlight});
 const cmd=(id='synthetic-takeover',rev=0)=>({...scope,capability,idempotencyKey:id,expectedRevision:rev});
 return{db,authority,capability,other,control,cmd,setEnabled:(v:boolean)=>enabled=v,setInFlight:(v:boolean)=>inFlight=v};
}
test('takeover/resume require opaque staff authority, exact direct scope, ownership and revision; audit is immutable',()=>{
 const x=setup();try{
  assert.throws(()=>x.control.transition({...x.cmd(),capability:{subject:'synthetic-staff'},action:'TAKEOVER'}),/STAFF_SESSION_REQUIRED/);
  assert.throws(()=>x.control.transition({...x.cmd(),conversationId:'conv-001',action:'TAKEOVER'}),/DIRECT_CONVERSATION_REQUIRED/);
  assert.throws(()=>x.control.transition({...x.cmd(),accountId:'other',action:'TAKEOVER'}),/RUNTIME_UNAVAILABLE/);
  assert.equal(x.control.transition({...x.cmd(),action:'TAKEOVER'}).revision,1);assert.equal(x.control.transition({...x.cmd(),action:'TAKEOVER'}).revision,1);
  assert.throws(()=>x.control.transition({...x.cmd('same-key-other-payload',0),action:'RESUME'}),/REVISION_CONFLICT/);
  assert.throws(()=>x.control.transition({...x.cmd('resume-other',1),capability:x.other,action:'RESUME'}),/OWNER_REQUIRED/);
  assert.throws(()=>x.control.transition({...x.cmd('synthetic-takeover',0),action:'RESUME'}),/IDEMPOTENCY_CONFLICT/);
  const resumed=x.control.transition({...x.cmd('resume',1),action:'RESUME'});assert.equal(resumed.mode,'AI');assert.equal(resumed.revision,2);assert.equal(x.control.allowsAi(scope,0),false);assert.equal(x.control.allowsAi(scope,2),true);
  assert.throws(()=>x.db.db.prepare("UPDATE conversation_staff_control SET mode='HUMAN'").run(),/SERVICE_REQUIRED/);assert.throws(()=>x.db.db.prepare('DELETE FROM conversation_staff_events').run(),/AUDIT_IMMUTABLE/);
 }finally{x.db.db.close()}
});
test('staff send records intent/audit before exactly one provider attempt, verifies object identity and displays acknowledgement honestly',async()=>{
 const x=setup();try{
  x.control.transition({...x.cmd(),action:'TAKEOVER'});let calls=0;const input={...x.cmd('send-once',1),text:'Synthetic staff response'};
  const outbound={send:async(wire:any)=>{calls++;assert.equal(x.control.verifyManualWire(wire),true);assert.equal(x.control.verifyManualWire({...wire}),false);assert.equal((x.db.db.prepare("SELECT state FROM conversation_reply_journal").get() as any).state,'UNKNOWN');assert.equal((x.db.db.prepare("SELECT count(*) n FROM conversation_staff_events WHERE action='SEND'").get() as any).n,1);return ack}};
  const result=await x.control.send(input,outbound);assert.equal(result.deliveryState,'SUBMITTED');assert.equal(result.physicalDeliveryConfirmed,false);assert.equal((await x.control.send(input,outbound)).duplicate,true);assert.equal(calls,1);
  await assert.rejects(x.control.send({...input,text:'Different synthetic payload'},outbound),/IDEMPOTENCY_CONFLICT/);assert.equal(calls,1);
  const feed=conversationMessageFeed(x.db.db,scope.accountId,scope.conversationId);assert.equal(feed.messages.at(-1).from,'staff');assert.equal(feed.messages.at(-1).text,input.text);
 }finally{x.db.db.close()}
});
test('unresolved send survives restart, blocks new manual send/resume and never retries a duplicate',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-staff-chat-')),file=join(dir,'synthetic.db');let x=setup(file);let calls=0;const send={send:async()=>{calls++;throw Error('synthetic ambiguous provider')}};
 try{x.control.transition({...x.cmd(),action:'TAKEOVER'});assert.equal((await x.control.send({...x.cmd('ambiguous',1),text:'Synthetic staff response'},send)).deliveryState,'UNKNOWN');x.db.db.close();x=setup(file,true);
  assert.equal((await x.control.send({...x.cmd('ambiguous',1),text:'Synthetic staff response'},send)).deliveryState,'UNKNOWN');assert.equal(calls,1);
  await assert.rejects(x.control.send({...x.cmd('different',1),text:'Another reply'},send),/DELIVERY_UNRESOLVED/);assert.throws(()=>x.control.transition({...x.cmd('resume',1),action:'RESUME'}),/DELIVERY_UNRESOLVED/);
 }finally{x.db.db.close();rmSync(dir,{recursive:true,force:true})}
});
test('takeover may fence a busy AI turn but manual send and resume wait for the provider boundary to drain',async()=>{
 const x=setup();try{x.setInFlight(true);assert.equal(x.control.transition({...x.cmd(),action:'TAKEOVER'}).draining,true);await assert.rejects(x.control.send({...x.cmd('send',1),text:'Synthetic'}, {send:async()=>ack}),/DELIVERY_UNRESOLVED/);assert.throws(()=>x.control.transition({...x.cmd('resume',1),action:'RESUME'}),/DELIVERY_UNRESOLVED/);x.setInFlight(false);assert.equal(x.control.describe(scope,x.capability).canSend,true);x.setEnabled(false);assert.throws(()=>x.control.transition({...x.cmd('resume',1),action:'RESUME'}),/RUNTIME_UNAVAILABLE/)}finally{x.db.db.close()}
});
test('audit or journal persistence failure atomically rolls back staff intent and makes zero provider calls',async()=>{
 for(const table of ['conversation_staff_events','conversation_reply_journal']){const x=setup();try{x.control.transition({...x.cmd(),action:'TAKEOVER'});x.db.db.exec(`CREATE TRIGGER synthetic_ignore BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`);let calls=0;await assert.rejects(x.control.send({...x.cmd('send',1),text:'Synthetic'}, {send:async()=>{calls++;return ack}}),/PERSISTENCE_REQUIRED/);assert.equal(calls,0);assert.equal((x.db.db.prepare('SELECT count(*) n FROM conversation_reply_journal').get() as any).n,0);assert.equal((x.db.db.prepare("SELECT count(*) n FROM conversation_staff_events WHERE action='SEND'").get() as any).n,0)}finally{x.db.db.close()}}
});
function inquirySetup(model:(text:string)=>Promise<string>,run?:(start:any,execute:any)=>Promise<any>,file=':memory:',existing=false){
 const migration=createMigrationApprovalAuthority(),approvals=createRolloutApprovalAuthority(),db=new V1Database(file,migration,approvals);if(!existing)db.resetAndSeed();
 const registration={accountId:'demo-account',approvalRef:'synthetic-inquiry',subject:'synthetic-owner'},a=createAccountInquiryApprovalAuthority();registerAccountInquiryPolicy(db,registration,a.issue(registration),a);
 let controller!:AccountInquiryController;const staff=createStaffCapabilityAuthority(),capability=staff.issue('synthetic-staff'),control=new StaffConversationControl(db,staff.verify,{accountId:'demo-account',enabled:()=>true,inFlight:scope=>controller?.isInFlight(scope)??false});let calls=0;
 const channel={send:async()=>{calls++;return ack},connect:async()=>{},disconnect:async()=>{},getStatus:async()=> 'connected' as const,onMessage:()=>{}};
 const commerce=new CommerceService(db,channel),rollout=new V2RolloutService(db,approvals),router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:true,outbound:commerce.outbound,prospectModel:model,verifyInquiryAdmission:(token,canonical)=>controller.verifyAdmission(token,canonical),piHarness:run?{run} as any:undefined});
 controller=new AccountInquiryController(db,'demo-account',router,migration,rollout,approvals,control);controller.installReplyFence(channel);
 const incoming={accountId:'demo-account',conversationId:'65000000002@s.whatsapp.net',externalMessageId:'synthetic-fresh',channel:'whatsapp' as const,sender:{externalId:'65000000002@s.whatsapp.net',phone:'+65000000002'},type:'text' as const,text:'Synthetic greeting',occurredAt:new Date(Date.now()+10).toISOString()};
 return{db,controller,control,capability,router,incoming,commerce,calls:()=>calls};
}
test('takeover during model await blocks stale AI send; human inbound persists without model/grants; resume does not replay history',async()=>{
 let release!:()=>void,models=0;const barrier=new Promise<void>(r=>release=r);const x=inquirySetup(async()=>{models++;await barrier;return 'Synthetic AI reply'});
 try{const pending=x.controller.receiveFromChannel(x.incoming),canonical=x.router.canonicalize(x.incoming)!;const s={accountId:x.incoming.accountId,conversationId:canonical.message.conversationId};
  x.control.transition({...s,capability:x.capability,expectedRevision:0,idempotencyKey:'takeover',action:'TAKEOVER'});release();assert.equal((await pending as any).routeOutcome,'INQUIRY_ADMISSION_CHANGED');assert.equal(x.calls(),0);assert.equal((x.db.db.prepare('SELECT count(*) n FROM conversation_reply_journal').get() as any).n,0);
  const held={...x.incoming,externalMessageId:'synthetic-held',occurredAt:new Date(Date.now()+10).toISOString()};assert.equal((await x.controller.receiveFromChannel(held) as any).status,'STAFF_TAKEOVER_HELD');assert.equal(models,1);assert.equal((x.db.db.prepare('SELECT count(*) n FROM workspace_authority').get() as any).n,0);assert.equal((x.db.db.prepare('SELECT count(*) n FROM v2_capability_rollouts').get() as any).n,0);
  const result=await x.control.send({...s,capability:x.capability,expectedRevision:1,idempotencyKey:'staff-send',text:'Synthetic staff reply'},x.commerce.outbound);assert.equal(result.deliveryState,'SUBMITTED');assert.equal(x.calls(),1);
  x.control.transition({...s,capability:x.capability,expectedRevision:1,idempotencyKey:'resume',action:'RESUME'});assert.equal((await x.controller.receiveFromChannel(held) as any).status,'INQUIRY_DUPLICATE_HELD');assert.equal(models,1);assert.equal(x.calls(),1);
  await x.controller.receiveFromChannel({...x.incoming,externalMessageId:'synthetic-after-resume',occurredAt:new Date(Date.now()+10).toISOString()});assert.equal(models,2);assert.equal(x.calls(),2);
 }finally{x.db.db.close()}
});

test('takeover fences every subsequent V2 capability and queued reply, including after an already-started model wait',async()=>{
 let release!:()=>void,entered=false;const wait=new Promise<void>(r=>release=r);const x=inquirySetup(async()=>{throw Error('PROSPECT_MODEL_FORBIDDEN')},async(_start,execute)=>{entered=true;await wait;await assert.rejects(async()=>execute({id:'synthetic-old-action'}),/INQUIRY_ADMISSION_CHANGED/);return{status:'TERMINAL'}});
 try{x.db.db.prepare('INSERT INTO customer_channel_identities VALUES(?,?,?,?,?,?)').run('synthetic-known-staff-peer','CUST-001',x.incoming.accountId,'whatsapp',x.incoming.sender.externalId,x.incoming.sender.phone);const pending=x.controller.receiveFromChannel(x.incoming);await new Promise<void>(r=>setImmediate(r));assert.equal(entered,true);const c=x.router.canonicalize(x.incoming)!;const command={accountId:x.incoming.accountId,conversationId:c.message.conversationId,capability:x.capability,expectedRevision:0,idempotencyKey:'v2-takeover'};
  const before=(x.db.db.prepare('SELECT count(*) n FROM order_drafts').get() as any).n;x.control.transition({...command,action:'TAKEOVER'});assert.throws(()=>x.control.transition({...command,expectedRevision:1,idempotencyKey:'resume-before-drain',action:'RESUME'}),/DELIVERY_UNRESOLVED/);release();await pending;assert.equal(x.calls(),0);assert.equal((x.db.db.prepare('SELECT count(*) n FROM order_drafts').get() as any).n,before);
 }finally{x.db.db.close()}
});

test('two fresh verified arrivals retain their own opaque admission while the conversation queue drains',async()=>{
 let release!:()=>void,turns=0;const wait=new Promise<void>(r=>release=r),executed:string[]=[];const x=inquirySetup(async()=>{throw Error('PROSPECT_MODEL_FORBIDDEN')},async(start,execute)=>{turns++;if(turns===1)await wait;const result=await execute({id:'synthetic-read-'+turns,capability:{name:'get_customer_context'},arguments:{accountId:start.accountId,conversationId:start.conversationId,customerId:'CUST-001'}});assert.ok(result);executed.push(start.inboundMessageId);return{status:'TERMINAL'}});
 try{x.db.db.prepare('INSERT INTO customer_channel_identities VALUES(?,?,?,?,?,?)').run('synthetic-known-double','CUST-001',x.incoming.accountId,'whatsapp',x.incoming.sender.externalId,x.incoming.sender.phone);const first=x.controller.receiveFromChannel(x.incoming);await new Promise<void>(r=>setImmediate(r));assert.equal(turns,1);const second=x.controller.receiveFromChannel({...x.incoming,externalMessageId:'synthetic-second-arrival',occurredAt:new Date(Date.now()+10).toISOString()});release();await Promise.all([first,second]);assert.equal(turns,2);assert.equal(executed.length,2);assert.equal(new Set(executed).size,2);assert.equal((x.db.db.prepare("SELECT count(*) n FROM v2_inbox_items WHERE state<>'COMPLETED'").get() as any).n,0)}finally{x.db.db.close()}
});
test('staff HTTP actions reject Access-only, cross-site, invalid scope and paused runtime without sending',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-staff-http-')),file=join(dir,'synthetic.db'),x=setup(file);x.db.db.close();const env={...process.env};process.env.ORDER_CHANNEL='simulated';process.env.NODE_ENV='test';
 const c=createApp({dbFilename:file,staffBootstrapCredential:'synthetic-test-only-bootstrap',channel:new SimulatedChannel(),startupMode:'active'});
 try{await c.startupReady;const url='/api/staff/chat/takeover',body={conversationId:scope.conversationId,expectedRevision:0,idempotencyKey:'http-takeover'};
  assert.equal((await c.app.inject({method:'POST',url,headers:{'cf-access-authenticated-user-email':'synthetic@example.invalid'},payload:body})).statusCode,401);
  const login=await c.app.inject({method:'POST',url:'/api/staff/session',headers:{authorization:'Bearer synthetic-test-only-bootstrap'},payload:{}}),cookie=String(login.headers['set-cookie']).split(';')[0];
  assert.equal((await c.app.inject({method:'POST',url,headers:{cookie},payload:body})).statusCode,403);
  assert.equal((await c.app.inject({method:'POST',url,headers:{cookie,'x-waerp-staff-action':'1','sec-fetch-site':'cross-site'},payload:body})).statusCode,403);
  assert.equal((await c.app.inject({method:'POST',url,headers:{cookie,'x-waerp-staff-action':'1'},payload:{...body,conversationId:'other-account'}})).statusCode,404);
  assert.equal((await c.app.inject({method:'POST',url,headers:{cookie,'x-waerp-staff-action':'1'},payload:body})).statusCode,503);assert.equal((c.channel as SimulatedChannel).sendCount,0);
 }finally{await c.app.close();c.service.database.db.close();process.env=env;rmSync(dir,{recursive:true,force:true})}
});

test('concurrent duplicate manual requests use one intent/provider call and keep changed payload denied',async()=>{
 const x=setup();let release!:(v:any)=>void;try{x.control.transition({...x.cmd(),action:'TAKEOVER'});let calls=0;const outbound={send:async()=>{calls++;return await new Promise<any>(r=>release=r)}};const input={...x.cmd('concurrent',1),text:'Synthetic staff reply'},first=x.control.send(input,outbound);assert.equal((await x.control.send(input,outbound)).deliveryState,'UNKNOWN');await assert.rejects(x.control.send({...input,text:'Changed'},outbound),/IDEMPOTENCY_CONFLICT/);release(ack);assert.equal((await first).deliveryState,'SUBMITTED');assert.equal(calls,1)}finally{x.db.db.close()}
});
test('two connections cannot both take over the same revision; stale revision cannot resume or send',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-staff-race-')),file=join(dir,'synthetic.db'),x=setup(file),y=setup(file,true);
 try{x.control.transition({...x.cmd(),action:'TAKEOVER'});assert.throws(()=>y.control.transition({...y.cmd('competing'),action:'TAKEOVER'}),/REVISION_CONFLICT/);await assert.rejects(y.control.send({...y.cmd('stale-send',0),text:'Synthetic'},{send:async()=>ack}),/REVISION_CONFLICT/);assert.equal((x.db.db.prepare('SELECT count(*) n FROM conversation_staff_events').get() as any).n,1)}finally{x.db.db.close();y.db.db.close();rmSync(dir,{recursive:true,force:true})}
});
test('post-provider disposition failure and malformed acknowledgements remain UNKNOWN with no resend',async()=>{
 for(const fault of [false,true]){const x=setup();try{x.control.transition({...x.cmd(),action:'TAKEOVER'});if(fault)x.db.db.exec("CREATE TRIGGER synthetic_fault BEFORE UPDATE ON conversation_reply_journal BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAULT'); END");let calls=0;const out={send:async()=>{calls++;return fault?ack:({status:'submitted'} as any)}};const input={...x.cmd('uncertain',1),text:'Synthetic'};assert.equal((await x.control.send(input,out)).deliveryState,'UNKNOWN');assert.equal((await x.control.send(input,out)).deliveryState,'UNKNOWN');assert.equal(calls,1)}finally{x.db.db.close()}}
});

test('disconnected transport rejects a new manual intent but can still return an already-recorded outcome',async()=>{
 const x=setup();let connected=false,calls=0;const control=new StaffConversationControl(x.db,x.authority.verify,{accountId:scope.accountId,enabled:()=>true,inFlight:()=>false,connected:async()=>connected});
 try{control.transition({...x.cmd(),action:'TAKEOVER'});const input={...x.cmd('connection-fenced',1),text:'Synthetic staff response'},out={send:async()=>{calls++;return ack}};
  await assert.rejects(control.send(input,out),/CHANNEL_UNAVAILABLE/);assert.equal((x.db.db.prepare('SELECT count(*) n FROM conversation_reply_journal').get() as any).n,0);assert.equal(calls,0);
  connected=true;assert.equal((await control.send(input,out)).deliveryState,'SUBMITTED');connected=false;assert.equal((await control.send(input,out)).duplicate,true);assert.equal(calls,1);
 }finally{x.db.db.close()}
});

test('ignored human inbound/completion rolls back admission, survives restart and permits safe single redelivery',async()=>{
 for(const fault of ['message','completion']){
  const dir=mkdtempSync(join(tmpdir(),'waerp-staff-held-')),file=join(dir,'synthetic.db');let x=inquirySetup(async()=> 'Synthetic initial reply',undefined,file);
  try{await x.controller.receiveFromChannel(x.incoming);const canonical=x.router.canonicalize(x.incoming)!,s={accountId:x.incoming.accountId,conversationId:canonical.message.conversationId};x.control.transition({...s,capability:x.capability,expectedRevision:0,idempotencyKey:'held-takeover',action:'TAKEOVER'});
   const held={...x.incoming,externalMessageId:'synthetic-held-fault',occurredAt:new Date(Date.now()+10).toISOString()};
   x.db.db.exec(fault==='message'?"CREATE TRIGGER synthetic_held_fault BEFORE INSERT ON messages WHEN NEW.external_message_id='synthetic-held-fault' BEGIN SELECT RAISE(IGNORE); END":"CREATE TRIGGER synthetic_held_fault BEFORE UPDATE ON account_inquiry_admissions WHEN NEW.external_message_id='synthetic-held-fault' AND NEW.state='COMPLETED' BEGIN SELECT RAISE(IGNORE); END");
   await assert.rejects(x.controller.receiveFromChannel(held),/PERSISTENCE_REQUIRED/);assert.equal((x.db.db.prepare('SELECT count(*) n FROM account_inquiry_admissions WHERE external_message_id=?').get(held.externalMessageId) as any).n,0);assert.equal((x.db.db.prepare('SELECT count(*) n FROM messages WHERE external_message_id=?').get(held.externalMessageId) as any).n,0);assert.equal(x.controller.isInFlight(s),false);
   x.db.db.close();x=inquirySetup(async()=>{throw Error('HELD_MODEL_FORBIDDEN')},undefined,file,true);x.db.db.exec('DROP TRIGGER synthetic_held_fault');
   assert.equal((await x.controller.receiveFromChannel(held) as any).status,'STAFF_TAKEOVER_HELD');assert.equal((await x.controller.receiveFromChannel(held) as any).status,'INQUIRY_DUPLICATE_HELD');assert.equal((x.db.db.prepare('SELECT count(*) n FROM messages WHERE external_message_id=?').get(held.externalMessageId) as any).n,1);assert.equal((x.db.db.prepare('SELECT state FROM account_inquiry_admissions WHERE external_message_id=?').get(held.externalMessageId) as any).state,'COMPLETED');assert.equal(x.control.describe(s,x.capability).canSend,true);assert.equal(x.control.describe(s,x.capability).canResume,true);assert.equal(x.calls(),0);
  }finally{x.db.db.close();rmSync(dir,{recursive:true,force:true})}
 }
});
test('process crash after human admission but before inbound insert leaves no lost-message fence after SQLite recovery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-staff-crash-')),file=join(dir,'synthetic.db');let x=inquirySetup(async()=> 'Synthetic initial reply',undefined,file);
 try{await x.controller.receiveFromChannel(x.incoming);const c=x.router.canonicalize(x.incoming)!,s={accountId:x.incoming.accountId,conversationId:c.message.conversationId};x.control.transition({...s,capability:x.capability,expectedRevision:0,idempotencyKey:'crash-takeover',action:'TAKEOVER'});x.db.db.close();
  const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/staff-held-crash.ts',import.meta.url)),file],{stdio:'ignore',timeout:10000});assert.equal(child.status,86);
  x=inquirySetup(async()=>{throw Error('HELD_MODEL_FORBIDDEN')},undefined,file,true);assert.equal((x.db.db.prepare("SELECT count(*) n FROM account_inquiry_admissions WHERE external_message_id='synthetic-held-crash'").get() as any).n,0);assert.equal((x.db.db.prepare("SELECT count(*) n FROM messages WHERE external_message_id='synthetic-held-crash'").get() as any).n,0);assert.equal(x.controller.isInFlight(s),false);x.db.db.exec('DROP TRIGGER synthetic_crash');
  const held={...x.incoming,externalMessageId:'synthetic-held-crash',occurredAt:new Date(Date.now()+10).toISOString()};assert.equal((await x.controller.receiveFromChannel(held) as any).status,'STAFF_TAKEOVER_HELD');assert.equal((await x.controller.receiveFromChannel(held) as any).status,'INQUIRY_DUPLICATE_HELD');assert.equal(x.control.describe(s,x.capability).canSend,true);assert.equal(x.control.describe(s,x.capability).canResume,true);assert.equal(x.calls(),0);assert.equal((x.db.db.prepare('PRAGMA integrity_check').get() as any).integrity_check,'ok');
 }finally{try{x.db.db.close()}catch{}rmSync(dir,{recursive:true,force:true})}
});

test('enabled inquiry HTTP flow requires existing staff bootstrap and retains canonical scope for takeover/send/resume',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-staff-http-active-')),file=join(dir,'synthetic.db'),x=setup(file),a=createAccountInquiryApprovalAuthority(),registration={accountId:scope.accountId,approvalRef:'synthetic-http-approval',subject:'synthetic-owner'};registerAccountInquiryPolicy(x.db,registration,a.issue(registration),a);x.db.db.close();
 const env={...process.env};process.env.NODE_ENV='test';process.env.ORDER_CHANNEL='simulated';process.env.V2_CANARY_RUNTIME_ENABLED='true';process.env.DEMO_GPT_ENABLED='true';const fetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN')};const channel=new SimulatedChannel();
 const c=createApp({dbFilename:file,channel,inquiryAccountId:scope.accountId,staffBootstrapCredential:'synthetic-test-only-bootstrap'});
 try{await c.startupReady;const login=await c.app.inject({method:'POST',url:'/api/staff/session',headers:{authorization:'Bearer synthetic-test-only-bootstrap'},payload:{}}),cookie=String(login.headers['set-cookie']).split(';')[0],headers={cookie,'x-waerp-staff-action':'1'};
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/takeover',headers,payload:{conversationId:scope.conversationId,expectedRevision:0,idempotencyKey:'http-takeover'}})).statusCode,200);
  const request={conversationId:scope.conversationId,expectedRevision:1,idempotencyKey:'http-send',text:'Synthetic explicit staff response'};const result=await c.app.inject({method:'POST',url:'/api/staff/chat/send',headers,payload:request});assert.equal(result.statusCode,200);assert.equal(result.json().deliveryState,'SUBMITTED');assert.equal(channel.sendCount,1);
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/send',headers,payload:request})).json().duplicate,true);assert.equal(channel.sendCount,1);
  const state=(await c.app.inject({url:'/api/state?conversationId='+scope.conversationId,headers:{cookie}})).json();assert.equal(state.staffChat.mode,'HUMAN');assert.equal(state.messages.at(-1).from,'staff');
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/resume',headers,payload:{conversationId:scope.conversationId,expectedRevision:1,idempotencyKey:'http-resume'}})).statusCode,200);assert.equal(channel.sendCount,1);
 }finally{await c.app.close();c.service.database.db.close();process.env=env;globalThis.fetch=fetch;rmSync(dir,{recursive:true,force:true})}
});
