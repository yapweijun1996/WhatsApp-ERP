import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CHAT_ACTIONS,createStaffCapabilityAuthority,type StaffGrant} from '../src/staff-auth.js';
import {staffChatBootstrapFromEnv} from '../src/staff-chat-bootstrap.js';
import {StaffConversationControl} from '../src/staff-conversation-control.js';
import {V1Database} from '../src/database.js';
import {CommerceService} from '../src/commerce.js';
import {createApp} from '../src/app.js';
import {SimulatedChannel} from '../src/channels.js';
import {createAccountInquiryApprovalAuthority,registerAccountInquiryPolicy} from '../src/account-inquiry-policy.js';

const scope={accountId:'demo-account',conversationId:'synthetic-chat-authorized'};
const ack={status:'submitted' as const,externalMessageId:'synthetic-ack',submittedAt:new Date().toISOString()};
const grant=(expiresAt=Date.now()+60000):StaffGrant=>({role:'CHAT_ONLY',...scope,conversationIds:[scope.conversationId],actions:CHAT_ACTIONS,expiresAt});
function seed(db:V1Database,id=scope.conversationId,account=scope.accountId,external='65000000010@s.whatsapp.net'){
 db.db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)').run(id,account,external,null,'OPEN',new Date().toISOString());
 db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,account_id,occurred_at) VALUES(?,?,?,'INBOUND','text',?,?,?,?)").run(id+'-inbound',id,id+'-inbound','Synthetic inbound',external,account,new Date().toISOString());
}
function setup(connected?:()=>Promise<boolean>){
 const db=new V1Database(':memory:');db.resetAndSeed();seed(db);let now=Date.now();
 const authority=createStaffCapabilityAuthority(()=>now),capability=authority.issue('synthetic-chat-staff',grant(now+60000));
 const control=new StaffConversationControl(db,authority.verify,{accountId:scope.accountId,enabled:()=>true,inFlight:()=>false,connected});
 const cmd=(id='takeover',expectedRevision=0)=>({...scope,capability,idempotencyKey:id,expectedRevision});
 return{db,authority,capability,control,cmd,setNow:(v:number)=>now=v,now};
}
function evidence(db:V1Database){
 return Object.fromEntries(['conversation_staff_control','conversation_staff_events','conversation_reply_journal','sales_orders','staff_actions','stock_balances','workspace_authority','v2_capability_rollouts'].map(table=>[table,db.db.prepare(`SELECT * FROM ${table}`).all()]));
}

test('chat-only capabilities permit each scoped chat action, deny commercial/reset, and copy host configuration',()=>{
 const authority=createStaffCapabilityAuthority(),config=grant() as Extract<StaffGrant,{role:'CHAT_ONLY'}>;
 const ids=[scope.conversationId],actions=[...CHAT_ACTIONS];const capability=authority.issue('synthetic-chat-staff',{...config,conversationIds:ids,actions});ids.push('not-approved');actions.splice(0);
 for(const action of CHAT_ACTIONS){assert.equal(authority.verify(capability,action,scope),'synthetic-chat-staff');assert.equal(authority.verify(capability,action,{...scope,conversationId:'not-approved'}),undefined);assert.equal(authority.verify(capability,action,{...scope,accountId:'other'}),undefined);assert.equal(authority.verify(capability,action),undefined)}
 for(const action of ['POST','CONFIRM','DO','RESET'] as const)assert.equal(authority.verify(capability,action,scope),undefined);
 const description=authority.describe(capability);assert.equal(description.role,'CHAT_ONLY');description.permissions.push('POST');description.scope!.conversationIds.push('not-approved');assert.equal(authority.verify(capability,'POST'),undefined);assert.equal(authority.verify(capability,'CHAT_SEND',{...scope,conversationId:'not-approved'}),undefined);
 const broad=authority.issue('legacy-staff');for(const action of [...CHAT_ACTIONS,'POST','CONFIRM','DO','RESET'] as const)assert.equal(authority.verify(broad,action,scope),'legacy-staff');
});

test('each staff chat operation checks its own action permission',async t=>{
 for(const allowed of CHAT_ACTIONS)await t.test(allowed,async()=>{
  const x=setup();try{
   const partial=x.authority.issue('synthetic-chat-staff',{...grant(),role:'CHAT_ONLY',actions:[allowed]});
   const described=x.control.describe(scope,partial);assert.deepEqual(described.permissions,{send:allowed==='CHAT_SEND',takeover:allowed==='CHAT_TAKEOVER',resume:allowed==='CHAT_RESUME'});
   if(allowed!=='CHAT_TAKEOVER')assert.throws(()=>x.control.transition({...x.cmd(),capability:partial,action:'TAKEOVER'}),/PERMISSION_REQUIRED/);
   x.control.transition({...x.cmd(),action:'TAKEOVER'});
   if(allowed!=='CHAT_SEND')await assert.rejects(x.control.send({...x.cmd('send',1),capability:partial,text:'Synthetic'},{send:async()=>ack}),/PERMISSION_REQUIRED/);
   if(allowed!=='CHAT_RESUME')assert.throws(()=>x.control.transition({...x.cmd('resume',1),capability:partial,action:'RESUME'}),/PERMISSION_REQUIRED/);
  }finally{x.db.db.close()}
 });
});

test('missing, forged, cross-account, cross-conversation, expired and revoked capabilities have no chat effects',async t=>{
 for(const action of ['TAKEOVER','SEND','RESUME'] as const)for(const kind of ['missing','forged','account','conversation','expired','revoked'] as const)await t.test(`${action} ${kind}`,async()=>{
  const x=setup();try{
   if(action!=='TAKEOVER')x.control.transition({...x.cmd(),action:'TAKEOVER'});
   let capability:unknown=x.capability;
   if(kind==='missing')capability=undefined;if(kind==='forged')capability={subject:'synthetic-chat-staff',role:'CHAT_ONLY'};
   if(kind==='account')capability=x.authority.issue('synthetic-chat-staff',{...grant(),role:'CHAT_ONLY',accountId:'other'});
   if(kind==='conversation')capability=x.authority.issue('synthetic-chat-staff',{...grant(),role:'CHAT_ONLY',conversationIds:['other']});
   if(kind==='expired')x.setNow(x.now+60000);if(kind==='revoked')x.authority.revoke(x.capability);
   const before=evidence(x.db);let sends=0;const cmd={...x.cmd('denied',action==='TAKEOVER'?0:1),capability};
   if(action==='SEND')await assert.rejects(x.control.send({...cmd,text:'Synthetic'},{send:async()=>{sends++;return ack}}),/STAFF_(SESSION|CHAT_PERMISSION)_REQUIRED/);
   else assert.throws(()=>x.control.transition({...cmd,action}),/STAFF_(SESSION|CHAT_PERMISSION)_REQUIRED/);
   assert.deepEqual(evidence(x.db),before);assert.equal(sends,0);assert.equal(x.control.describe(scope,capability).canSend,false);
  }finally{x.db.db.close()}
 });
});

test('chat-only can take over, send once and resume; denied commercial commands leave orders, stock and audit unchanged',async()=>{
 const x=setup();try{
  x.control.transition({...x.cmd(),action:'TAKEOVER'});let sends=0;const outbound={send:async(wire:any)=>{assert.equal(x.control.verifyManualWire(wire),true);sends++;return ack}},input={...x.cmd('send',1),text:'Synthetic chat-only response'};
  assert.equal((await x.control.send(input,outbound)).deliveryState,'SUBMITTED');assert.equal((await x.control.send(input,outbound)).duplicate,true);assert.equal(sends,1);
  const commerce=new CommerceService(x.db,undefined,x.authority.verify),before=evidence(x.db);
  for(const action of ['post','confirm','do'] as const)assert.throws(()=>commerce.staff(action,x.capability,'denied-'+action,'Synthetic evidence','SO-000041'),/STAFF_PERMISSION_REQUIRED/);
  assert.deepEqual(evidence(x.db),before);
  assert.equal(x.control.transition({...x.cmd('resume',1),action:'RESUME'}).mode,'AI');
  x.authority.revoke(x.capability);const after=evidence(x.db);await assert.rejects(x.control.send(input,outbound),/SESSION_REQUIRED/);assert.deepEqual(evidence(x.db),after);assert.equal(sends,1);
 }finally{x.db.db.close()}
});

test('expiry/revocation during connection await denies without intent, audit or provider effects',async t=>{
 for(const kind of ['expiry','revocation'])await t.test(kind,async()=>{
  let release!:(v:boolean)=>void;const x=setup(()=>new Promise<boolean>(r=>release=r));try{
   x.control.transition({...x.cmd(),action:'TAKEOVER'});const before=evidence(x.db);let calls=0;
   const pending=x.control.send({...x.cmd('wait',1),text:'Synthetic'}, {send:async()=>{calls++;return ack}});
   if(kind==='expiry')x.setNow(x.now+60000);else x.authority.revoke(x.capability);release(true);
   await assert.rejects(pending,/SESSION_REQUIRED/);assert.deepEqual(evidence(x.db),before);assert.equal(calls,0);
  }finally{x.db.db.close()}
 });
});

test('manual provider fence rechecks live capability after intent reservation',async()=>{
 const x=setup();try{
  x.control.transition({...x.cmd(),action:'TAKEOVER'});let dispatched=0;
  const result=await x.control.send({...x.cmd('wire-revoked',1),text:'Synthetic'}, {send:async wire=>{assert.equal(x.control.verifyManualWire(wire),true);x.authority.revoke(x.capability);assert.equal(x.control.verifyManualWire(wire),false);if(x.control.verifyManualWire(wire))dispatched++;throw Error('Synthetic fenced before dispatch')}});
  assert.equal(dispatched,0);assert.equal(result.deliveryState,'UNKNOWN');assert.equal(result.control.authenticated,false);
 }finally{x.db.db.close()}
});

test('bootstrap configuration is explicit, bounded, secret-free in errors, and cannot request commerce actions',()=>{
 assert.equal(staffChatBootstrapFromEnv({}),undefined);
 const credential='synthetic-only-private-bootstrap',config={subject:'synthetic-owner',...scope,conversationIds:[scope.conversationId],expiresAt:'2030-01-01T00:00:00Z'};delete (config as any).conversationId;
 const environment={STAFF_CHAT_BOOTSTRAP_CREDENTIAL:credential,STAFF_CHAT_ACCESS_JSON:JSON.stringify(config)};
 assert.equal(staffChatBootstrapFromEnv(environment)!.accountId,scope.accountId);
 for(const value of [{}, {...config,conversationIds:['*']},{...config,conversationIds:[]},{...config,expiresAt:'invalid'},{...config,actions:['POST']}])assert.throws(()=>staffChatBootstrapFromEnv({...environment,STAFF_CHAT_ACCESS_JSON:JSON.stringify(value)}),/^Error: STAFF_CHAT_BOOTSTRAP_CONFIGURATION_INVALID$/);
 assert.throws(()=>staffChatBootstrapFromEnv({STAFF_CHAT_BOOTSTRAP_CREDENTIAL:credential}),/^Error: STAFF_CHAT_BOOTSTRAP_CONFIGURATION_INVALID$/);
 assert.throws(()=>createApp({staffBootstrapCredential:credential,staffChatBootstrap:{credential,subject:config.subject,accountId:scope.accountId,conversationIds:[scope.conversationId],expiresAt:Date.now()+60000}}),/STAFF_BOOTSTRAP_AMBIGUOUS/);
});

test('HTTP chat-only login permits scoped chat, denies commerce, CSRF and wrong scopes; logout revokes a waiting send',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-chat-only-http-')),file=join(dir,'synthetic.db'),db=new V1Database(file);db.resetAndSeed();seed(db);seed(db,'synthetic-not-approved',scope.accountId,'65000000011@s.whatsapp.net');
 const registration={accountId:scope.accountId,subject:'synthetic-owner',approvalRef:'synthetic-http-policy'},inquiry=createAccountInquiryApprovalAuthority();registerAccountInquiryPolicy(db,registration,inquiry.issue(registration),inquiry);db.db.close();
 const saved={...process.env};Object.assign(process.env,{NODE_ENV:'test',ORDER_CHANNEL:'simulated',V2_CANARY_RUNTIME_ENABLED:'true',DEMO_GPT_ENABLED:'true'});
 const channel=new SimulatedChannel(),c=createApp({dbFilename:file,channel,inquiryAccountId:scope.accountId,staffBootstrapCredential:'synthetic-only-broad',staffChatBootstrap:{credential:'synthetic-only-chat',subject:'synthetic-owner',accountId:scope.accountId,conversationIds:[scope.conversationId],expiresAt:Date.now()+60000}});
 try{
  await c.startupReady;
  const login=await c.app.inject({method:'POST',url:'/api/staff/session',headers:{authorization:'Bearer synthetic-only-chat'},payload:{role:'LEGACY_STAFF'}});
  assert.equal(login.statusCode,200);assert.equal(login.json().role,'CHAT_ONLY');assert.deepEqual(login.json().permissions,CHAT_ACTIONS);assert.equal(login.headers['cache-control'],'no-store');assert.equal(JSON.stringify(login.json()).includes('synthetic-only-chat'),false);
  const cookie=String(login.headers['set-cookie']).split(';')[0],headers={cookie,'x-waerp-staff-action':'1'},body={conversationId:scope.conversationId,expectedRevision:0,idempotencyKey:'http-takeover'};
  const before=evidence(c.service.database);
  for(const action of ['post','confirm','do']){const response=await c.app.inject({method:'POST',url:'/api/staff/'+action,headers:{cookie},payload:{salesOrderNo:'SO-000041',idempotencyKey:'denied-'+action,doubleConfirmationEvidence:'Synthetic'}});assert.equal(response.statusCode,403);assert.equal(response.json().error,'STAFF_PERMISSION_REQUIRED')}
  for(const site of ['cross-site','same-site'])assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/takeover',headers:{...headers,'sec-fetch-site':site},payload:body})).statusCode,403);
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/takeover',headers:{cookie},payload:body})).statusCode,403);
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/takeover',headers,payload:{...body,accountId:'other'}})).statusCode,400);
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/takeover',headers,payload:{...body,conversationId:'synthetic-not-approved'}})).statusCode,403);
  assert.deepEqual(evidence(c.service.database),before);assert.equal(channel.sendCount,0);
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/takeover',headers,payload:body})).statusCode,200);
  const sendBody={...body,expectedRevision:1,idempotencyKey:'http-send',text:'Synthetic authorized reply'};
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/send',headers,payload:sendBody})).json().deliveryState,'SUBMITTED');assert.equal(channel.sendCount,1);
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/send',headers,payload:sendBody})).json().duplicate,true);assert.equal(channel.sendCount,1);
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/resume',headers,payload:{...body,expectedRevision:1,idempotencyKey:'http-resume'}})).statusCode,200);
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/takeover',headers,payload:{...body,expectedRevision:2,idempotencyKey:'http-retake'}})).statusCode,200);
  const committed=evidence(c.service.database);let entered!:()=>void,release!:(v:'connected')=>void;const waiting=new Promise<void>(r=>entered=r);channel.getStatus=()=>{entered();return new Promise(r=>release=r)};
  const pending=c.app.inject({method:'POST',url:'/api/staff/chat/send',headers,payload:{...sendBody,expectedRevision:3,idempotencyKey:'http-revoked-wait'}});await waiting;
  await c.app.inject({method:'DELETE',url:'/api/staff/session',headers:{cookie}});release('connected');assert.equal((await pending).statusCode,401);assert.deepEqual(evidence(c.service.database),committed);assert.equal(channel.sendCount,1);
  assert.equal((await c.app.inject({url:'/api/staff/session',headers:{cookie}})).json().authenticated,false);
  assert.equal((await c.app.inject({method:'POST',url:'/api/staff/chat/resume',headers,payload:{...body,expectedRevision:3,idempotencyKey:'revoked-resume'}})).statusCode,401);
  const broad=await c.app.inject({method:'POST',url:'/api/staff/session',headers:{authorization:'Bearer synthetic-only-broad'}});assert.equal(broad.json().role,'LEGACY_STAFF');assert.ok(broad.json().permissions.includes('POST'));
 }finally{await c.app.close();c.service.database.db.close();process.env=saved;rmSync(dir,{recursive:true,force:true})}
});

test('expired chat bootstrap and unconfigured role fail closed; chat session cannot reset the synthetic database',async()=>{
 const saved={...process.env};Object.assign(process.env,{NODE_ENV:'test',ORDER_CHANNEL:'simulated'});
 for(const expired of [true,false]){
  const c=createApp({dbFilename:':memory:',staffChatBootstrap:{credential:'synthetic-chat',subject:'synthetic-staff',accountId:scope.accountId,conversationIds:[scope.conversationId],expiresAt:Date.now()+(expired?-1:60000)}});
  try{await c.startupReady;const before=evidence(c.service.database),login=await c.app.inject({method:'POST',url:'/api/staff/session',headers:{authorization:'Bearer synthetic-chat'}});assert.equal(login.statusCode,expired?401:200);
   if(!expired){const cookie=String(login.headers['set-cookie']).split(';')[0];assert.equal((await c.app.inject({method:'POST',url:'/api/reset',headers:{cookie}})).statusCode,401)}
   assert.deepEqual(evidence(c.service.database),before);assert.equal((c.channel as SimulatedChannel).sendCount,0);
  }finally{await c.app.close();c.service.database.db.close()}
 }
 process.env=saved;
});

test('chat-only concurrent commands retain one provider attempt and reject stale revision/changed payload',async()=>{
 const x=setup();try{
  x.control.transition({...x.cmd(),action:'TAKEOVER'});
  assert.throws(()=>x.control.transition({...x.cmd('competing-takeover'),action:'TAKEOVER'}),/REVISION_CONFLICT/);
  let release!:(value:typeof ack)=>void,calls=0;const out={send:async()=>{calls++;return await new Promise<typeof ack>(r=>release=r)}},input={...x.cmd('concurrent-chat',1),text:'Synthetic'};
  const first=x.control.send(input,out);assert.equal((await x.control.send(input,out)).deliveryState,'UNKNOWN');
  await assert.rejects(x.control.send({...input,text:'Changed'},out),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(x.control.send({...x.cmd('stale',0),text:'Synthetic'},out),/REVISION_CONFLICT/);
  assert.throws(()=>x.control.transition({...x.cmd('stale-resume',0),action:'RESUME'}),/REVISION_CONFLICT/);
  release(ack);assert.equal((await first).deliveryState,'SUBMITTED');assert.equal(calls,1);
  assert.equal((x.db.db.prepare("SELECT count(*) n FROM conversation_staff_events WHERE action='SEND'").get() as any).n,1);
 }finally{x.db.db.close()}
});
