import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {V1Database} from '../src/database.js';
import {CommerceService} from '../src/commerce.js';
import {createMigrationApprovalAuthority} from '../src/migration-auth.js';
import {createRolloutApprovalAuthority} from '../src/rollout-auth.js';
import {V2RolloutService,V2_CAPABILITIES} from '../src/v2-rollout.js';
import {WorkspaceMigrationService} from '../src/v2-workspace-migration.js';
import {V2CanaryIngressRouter} from '../src/v2-canary-ingress-router.js';
import {AccountInquiryController,createAccountInquiryApprovalAuthority,registerAccountInquiryPolicy} from '../src/account-inquiry-policy.js';
import {V2TransportRuntime} from '../src/v2-transport-runtime.js';
import {deriveAgentDecisionIdentity} from '../src/v2-transport-contract-helpers.js';
import {createApp} from '../src/app.js';
import {SimulatedChannel,normalizeBaileysMessage} from '../src/channels.js';
const submitted=()=>({status:'submitted' as const,externalMessageId:'synthetic-provider-response',submittedAt:new Date().toISOString()});
const msg=(accountId:string,id='fresh-synthetic',sender='unverified-synthetic')=>({accountId,conversationId:'synthetic-external-chat',externalMessageId:id,channel:'whatsapp' as const,sender:{externalId:sender},type:'text' as const,text:'Synthetic customer consultation',occurredAt:new Date(Date.now()+10).toISOString()});
function setup(options:{model?:(text:string)=>Promise<string>;run?:(start:any,execute:any,context:any)=>Promise<any>;file?:string;existing?:boolean}={}){
 const migration=createMigrationApprovalAuthority(),approvals=createRolloutApprovalAuthority(),db=new V1Database(options.file??':memory:',migration,approvals);if(!options.existing)db.resetAndSeed();
 const binding=db.db.prepare('SELECT * FROM customer_channel_identities LIMIT 1').get() as any;
 const input={accountId:binding.channel_account_id,approvalRef:'synthetic-owner-receipt',subject:'synthetic-owner'},authority=createAccountInquiryApprovalAuthority();registerAccountInquiryPolicy(db,input,authority.issue(input),authority);
 const sent:any[]=[],channel={send:async(m:any)=>{sent.push(m);return submitted()},connect:async()=>{},disconnect:async()=>{},getStatus:async()=> 'connected' as const,onMessage:()=>{}};
 const commerce=new CommerceService(db,channel),rollout=new V2RolloutService(db,approvals);let controller!:AccountInquiryController,models=0,turns=0;
 const router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:true,outbound:commerce.outbound,verifyInquiryAdmission:(token,canonical)=>controller.verifyAdmission(token,canonical),prospectModel:async text=>{models++;return options.model?options.model(text):'Hello. How can I help?'},piHarness:{run:async(start:any,execute:any)=>{turns++;return options.run?options.run(start,execute,{db,binding,commerce,controller}):{status:'TERMINAL'}}} as any});
 controller=new AccountInquiryController(db,input.accountId,router,migration,rollout,approvals);controller.installReplyFence(channel);
 return{db,binding,input,authority,controller,router,commerce,rollout,rolloutApprovals:approvals,sent,counts:()=>({models,turns})};
}
test('registration is opaque, account-bound, idempotent and boot never manufactures approval',()=>{
 const db=new V1Database(':memory:');db.db.prepare('INSERT INTO channel_accounts VALUES(?,?,?,?,?,?)').run('synthetic-account','whatsapp','synthetic-owner-account','CONNECTED',new Date().toISOString(),new Date().toISOString());try{const input={accountId:'synthetic-account',approvalRef:'synthetic-ref',subject:'synthetic-owner'},a=createAccountInquiryApprovalAuthority();assert.throws(()=>registerAccountInquiryPolicy(db,input,{},a),/APPROVAL_REQUIRED/);assert.equal((db.db.prepare('SELECT count(*) n FROM account_inquiry_policies').get() as any).n,0);assert.throws(()=>a.issue({...input,accountId:'*'}),/APPROVAL_INVALID/);const token=a.issue(input);assert.throws(()=>registerAccountInquiryPolicy(db,{...input,accountId:'other'},token,a),/APPROVAL_REQUIRED/);const first=registerAccountInquiryPolicy(db,input,token,a);assert.deepEqual(registerAccountInquiryPolicy(db,input,token,a),first);db.db.prepare("UPDATE account_inquiry_policies SET status='REVOKED'").run();assert.throws(()=>registerAccountInquiryPolicy(db,input,token,a),/POLICY_CONFLICT/)}finally{db.db.close()}
});
test('fresh unknown contact gets public catalog Q&A without any customer binding or commerce grant',async()=>{
 const prompts:string[]=[],outputs=[JSON.stringify({tool:'list_public_catalog',limit:5}),JSON.stringify({reply:'Here are our products.',productIds:['FCH-WHOLE-12']})];const x=setup({model:async text=>{prompts.push(text);return outputs.shift()!}});try{
 const result=await x.controller.receiveFromChannel(msg(x.input.accountId)) as any;assert.equal(result.grounded,true);assert.equal(result.catalogCallCount,1);assert.equal(x.sent.length,1);assert.equal(x.sent[0].replyToExternalMessageId,'fresh-synthetic');assert.equal((x.db.db.prepare('SELECT count(*) n FROM customer_channel_identities').get() as any).n,1);assert.equal((x.db.db.prepare('SELECT customer_id FROM conversations WHERE external_conversation_id=?').get('synthetic-external-chat') as any).customer_id,null);assert.equal((x.db.db.prepare('SELECT count(*) n FROM workspace_authority').get() as any).n,0);assert.equal((x.db.db.prepare('SELECT count(*) n FROM v2_capability_rollouts').get() as any).n,0);assert.equal(x.counts().turns,0);assert.ok(prompts.every(p=>!p.includes(x.binding.customer_id)));assert.ok(prompts.every(p=>!p.includes('unit_price_cents')))
 }finally{x.db.db.close()}
});
test('wrong account, group, old message and forged token cannot reach model/provider',async()=>{
 const x=setup();try{const m=msg(x.input.accountId);await assert.rejects(x.controller.receiveFromChannel({...m,accountId:'wrong-account'}),/ACCOUNT_DENIED/);await assert.rejects(x.controller.receiveFromChannel({...m,conversationId:'synthetic@g.us'}),/DIRECT_CONTACT_REQUIRED/);await assert.rejects(x.controller.receiveFromChannel({...m,occurredAt:'2020-01-01T00:00:00Z'}),/FRESH_INPUT_REQUIRED/);await assert.rejects(x.router.receiveCanonicalForInquiry(x.router.canonicalize(m)!,{}),/ADMISSION_REQUIRED/);assert.deepEqual(x.counts(),{models:0,turns:0});assert.equal(x.sent.length,0)}finally{x.db.db.close()}
});
test('redelivery stays terminal across identity promotion; distinct verified input gets only exact seven V2 scopes',async()=>{
 const x=setup();try{const m=msg(x.input.accountId);await x.controller.receiveFromChannel(m);x.db.db.prepare('INSERT INTO customer_channel_identities VALUES(?,?,?,?,?,?)').run('synthetic-explicit-binding',x.binding.customer_id,m.accountId,m.channel,m.sender.externalId,null);
 assert.deepEqual(await x.controller.receiveFromChannel(m),{status:'INQUIRY_DUPLICATE_HELD'});assert.equal((x.db.db.prepare('SELECT count(*) n FROM workspace_authority').get() as any).n,0);
 await x.controller.receiveFromChannel({...m,externalMessageId:'fresh-verified',occurredAt:new Date(Date.now()+10).toISOString()});assert.equal(x.counts().turns,1);const c=x.router.canonicalize(m)!;const rows=x.db.db.prepare('SELECT capability,account_id,conversation_id FROM v2_capability_rollouts').all() as any[];assert.equal(rows.length,7);assert.deepEqual(rows.map(r=>r.capability).sort(),[...V2_CAPABILITIES].sort());assert.ok(rows.every(r=>r.account_id===m.accountId&&r.conversation_id===c.message.conversationId));assert.equal((x.db.db.prepare('SELECT count(*) n FROM customers').get() as any).n,1)
 }finally{x.db.db.close()}
});
test('imported existing message cannot be reclassified as fresh approved inquiry',async()=>{
 const x=setup();try{const m=msg(x.input.accountId),c=x.router.canonicalize(m)!;x.db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)').run('synthetic-old',c.message.conversationId,m.externalMessageId,'INBOUND','text','Synthetic old content',m.sender.externalId,m.accountId,m.occurredAt);await assert.rejects(x.controller.receiveFromChannel(m),/HISTORICAL_INPUT_DENIED/);assert.deepEqual(x.counts(),{models:0,turns:0});assert.equal(x.sent.length,0)}finally{x.db.db.close()}
});
test('revocation during model await prevents the reply and records a bounded failure',async()=>{
 let release!:()=>void;const wait=new Promise<void>(r=>{release=r});const x=setup({model:async()=>{await wait;return 'Hello. How can I help?'}});try{const pending=x.controller.receiveFromChannel(msg(x.input.accountId));assert.equal(x.counts().models,1);x.db.db.prepare("UPDATE account_inquiry_policies SET status='REVOKED'").run();release();await pending;assert.equal(x.sent.length,0);assert.deepEqual(x.db.db.prepare('SELECT state,error_code FROM account_inquiry_admissions').get(),{state:'FAILED',error_code:'INQUIRY_PROCESSING_FAILED'})}finally{x.db.db.close()}
});
test('admission persistence failure cannot allocate workspace authority or invoke model',async()=>{
 const x=setup();try{x.db.db.exec("CREATE TRIGGER synthetic_inquiry_ignore BEFORE INSERT ON account_inquiry_admissions BEGIN SELECT RAISE(IGNORE); END");await assert.rejects(x.controller.receiveFromChannel(msg(x.input.accountId,'verified',x.binding.external_id)),/ADMISSION_PERSISTENCE_REQUIRED/);assert.equal((x.db.db.prepare('SELECT count(*) n FROM workspace_authority').get() as any).n,0);assert.deepEqual(x.counts(),{models:0,turns:0});assert.equal(x.sent.length,0)}finally{x.db.db.close()}
});
test('verified handler cannot send to another recipient or outside current processing window',async()=>{
 const x=setup({run:async(start,_execute,context)=>{const external=(context.db.db.prepare('SELECT external_message_id FROM messages WHERE id=?').get(start.inboundMessageId) as any).external_message_id;await assert.rejects(context.commerce.outbound.send({accountId:start.accountId,clientMessageId:'bad-recipient',conversationId:'other-peer',text:'Synthetic',replyToExternalMessageId:external}),/PROVENANCE_REQUIRED/);await assert.rejects(context.commerce.outbound.send({accountId:'wrong-account',clientMessageId:'bad-account',conversationId:'synthetic-external-chat',text:'Synthetic',replyToExternalMessageId:external}),/ACCOUNT_DENIED/);await context.commerce.outbound.send({accountId:start.accountId,clientMessageId:'allowed-response',conversationId:'synthetic-external-chat',text:'Synthetic acknowledgement',replyToExternalMessageId:external});return{status:'TERMINAL'}}});try{await x.controller.receiveFromChannel(msg(x.input.accountId,'verified',x.binding.external_id));assert.equal(x.sent.length,1);await assert.rejects(x.commerce.outbound.send({...x.sent[0],clientMessageId:'proactive-outside-window'}),/PROVENANCE_REQUIRED/);assert.equal(x.sent.length,1)}finally{x.db.db.close()}
});
test('gateway failure remains bounded/observable and never binds prospect to a customer',async()=>{
 const x=setup({model:async()=>{throw Error('DEMO_GPT_ORIGIN_UNREGISTERED')}});try{const result=await x.controller.receiveFromChannel(msg(x.input.accountId)) as any;assert.match(result.routeOutcome,/GATEWAY_ORIGIN_UNREGISTERED/);assert.deepEqual(x.db.db.prepare('SELECT state,error_code FROM account_inquiry_admissions').get(),{state:'FAILED',error_code:'INQUIRY_PROCESSING_FAILED'});assert.equal((x.db.db.prepare('SELECT count(*) n FROM workspace_authority').get() as any).n,0);assert.equal((x.db.db.prepare('SELECT count(*) n FROM customer_channel_identities').get() as any).n,1)}finally{x.db.db.close()}
});
test('active app skips startup reconciliation and blocks HTTP simulation/reset; exposes truthful safe provider metadata',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-inquiry-app-')),file=join(dir,'synthetic.db');const x=setup({file});const account=x.input.accountId;x.db.db.close();const old={...process.env};process.env.ORDER_CHANNEL='simulated';process.env.DEMO_GPT_ENABLED='true';process.env.V2_CANARY_RUNTIME_ENABLED='true';const channel=new SimulatedChannel();const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN')};let created:ReturnType<typeof createApp>|undefined;try{created=createApp({dbFilename:file,channel,startupMode:'active',inquiryAccountId:account});await created.startupReady;assert.equal(channel.sendCount,0);assert.equal((await created.app.inject({method:'POST',url:'/api/simulated/inbound',payload:{text:'Synthetic'}})).statusCode,503);assert.equal((await created.app.inject({method:'POST',url:'/api/reset',payload:{}})).statusCode,503);const health=(await created.app.inject('/health')).json();assert.equal(health.inquiry.enabled,true);assert.equal(health.rollout.v2Traffic,'SCOPED');assert.equal(health.rollout.v3Shadow,'OFF');assert.equal(health.llm.provider,'demo-gpt');assert.equal(health.llm.model,'demo-fast');assert.equal(health.llm.runtime,'pi-harness-node');assert.equal(health.llm.billingMode,'managed-demo-gateway');assert.ok(!JSON.stringify(health).includes('Bearer'));assert.equal(channel.sendCount,0)}finally{if(created){await created.app.close();created.service.database.db.close()}globalThis.fetch=oldFetch;process.env=old;rmSync(dir,{recursive:true,force:true})}
});

test('real V2 coordinator/executor under inquiry admission quotes, records explicit acceptance and persists DRAFT without staff posting',async()=>{
 const x=setup({run:async(start,execute,context)=>{
  const db=context.db,scope={accountId:start.accountId,conversationId:start.conversationId,customerId:context.binding.customer_id};const inbound=db.db.prepare('SELECT external_message_id FROM messages WHERE id=?').get(start.inboundMessageId) as any;const accepting=inbound.external_message_id==='synthetic-explicit-acceptance';
  const work=()=>db.db.prepare('SELECT * FROM work_items WHERE account_id=? AND conversation_id=?').get(scope.accountId,scope.conversationId) as any;const draft=()=>db.db.prepare('SELECT * FROM order_drafts WHERE account_id=? AND conversation_id=?').get(scope.accountId,scope.conversationId) as any;
  const customer=db.db.prepare('SELECT * FROM customers WHERE id=?').get(scope.customerId) as any;
  const steps=accepting?[()=>['record_customer_commitment',{...scope,inboundMessageId:start.inboundMessageId,commitment:'ACCEPT'}]]:[()=>['get_customer_context',scope],()=>['get_or_create_work_item',{...scope,goalSummary:'Synthetic verified inquiry order'}],()=>['create_order_draft',{...scope,workItemId:work().id,expectedWorkItemRevision:work().revision,warehouseId:customer.default_warehouse_id,currency:customer.currency,lines:[{lineNo:1,requestedWording:'ayam',quantity:'1',requestedUom:'CTN'}]}],()=>['validate_order_draft',{...scope,workItemId:work().id,draftId:draft().id,revision:draft().current_revision,expectedWorkItemRevision:work().revision}],()=>['prepare_quotation',{...scope,workItemId:work().id,draftId:draft().id,draftRevision:draft().current_revision,expectedWorkItemRevision:work().revision}],()=>['send_quotation',{...scope,quotationId:(db.db.prepare('SELECT id FROM quotations WHERE source_conversation_id=?').get(scope.conversationId) as any).id,customerMessage:'Review quotation {{quotation_number}} in {{currency}} {{total}}.'}]];
  let i=0;const transport={mode:'demo',id:'synthetic-inquiry-decisions',decide:async(o:any)=>{const next=steps[i++],base={turnId:o.turnId,sequence:o.sequence,...deriveAgentDecisionIdentity(o.turnId,o.sequence)};if(next){const [capabilityName,args]=next();return{kind:'tool_call',...base,capabilityName,capabilityVersion:'v1',arguments:args}}return{kind:'final_response',...base,responsePlan:{turnId:o.turnId,intent:'ACKNOWLEDGE',connectiveText:'Thank you.',factClaims:[],outboundPurpose:'acknowledgement'}}}} as any;
  return new V2TransportRuntime(db,{transport,execute,outbound:context.commerce.outbound}).run(start);
 }});
 try{const first=msg(x.input.accountId,'synthetic-order',x.binding.external_id);await x.controller.receiveFromChannel(first);const c=x.router.canonicalize(first)!;assert.equal(x.commerce.state(c.message.conversationId).quote?.status,'SENT');assert.equal(x.sent.length,1);assert.equal(x.sent[0].conversationId,first.conversationId);
 await x.controller.receiveFromChannel({...first,externalMessageId:'synthetic-explicit-acceptance',text:'OK confirm.',occurredAt:new Date(Date.now()+10).toISOString()});assert.equal(x.commerce.state(c.message.conversationId).so?.status,'DRAFT');assert.equal((x.db.db.prepare('SELECT count(*) n FROM quotation_acceptances').get() as any).n,1);assert.equal((x.db.db.prepare('SELECT count(*) n FROM staff_actions').get() as any).n,0);assert.equal((x.db.db.prepare("SELECT count(*) n FROM sales_orders s JOIN quotations q ON q.id=s.source_quotation_id WHERE q.source_conversation_id=? AND s.status!='DRAFT'").get(c.message.conversationId) as any).n,0);assert.equal((x.db.db.prepare("SELECT count(*) n FROM account_inquiry_admissions WHERE state='FAILED'").get() as any).n,0);assert.ok(x.sent.every(m=>m.accountId===first.accountId&&m.conversationId===first.conversationId))
 }finally{x.db.db.close()}
});
test('business inquiry replies are not limited by the separate opt-in three-attempt test budget',async()=>{
 const x=setup();try{for(let i=0;i<4;i++)await x.controller.receiveFromChannel(msg(x.input.accountId,'fresh-business-'+i));assert.equal(x.sent.length,4);assert.equal((x.db.db.prepare('SELECT count(*) n FROM controlled_test_send_budgets').get() as any).n,0)}finally{x.db.db.close()}
});
test('legacy incompatibility stays quarantined and fails visibly before customer model execution or broad grants',async()=>{
 const x=setup();try{const m=msg(x.input.accountId,'fresh-incompatible',x.binding.external_id),c=x.router.canonicalize(m)!;x.db.db.prepare('INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)').run('synthetic-bad-pending',x.binding.customer_id,'pending_order',c.message.conversationId,'{"synthetic":"incompatible"}',1,'synthetic-source',new Date().toISOString());await assert.rejects(x.controller.receiveFromChannel(m),/V2_WORKSPACE_INVALID|INQUIRY_WORKSPACE_NOT_READY|LEGACY_SOURCE_INVALID/);assert.equal(x.counts().turns,0);assert.equal(x.sent.length,0);assert.equal((x.db.db.prepare('SELECT count(*) n FROM v2_capability_rollouts').get() as any).n,0);assert.equal((x.db.db.prepare('SELECT state FROM account_inquiry_admissions').get() as any).state,'FAILED');assert.equal((x.db.db.prepare('SELECT authoritative_writer FROM workspace_authority').get() as any).authoritative_writer,'LEGACY')}finally{x.db.db.close()}
});

test('global legacy capability defaults cannot substitute for exact conversation grants or override later revocation',async()=>{
 const x=setup();try{for(const capability of V2_CAPABILITIES){const intent={action:'ENABLE' as const,capability,accountId:null,conversationId:null,enabled:true};x.rollout.configure({capability,enabled:true,idempotencyKey:'synthetic-global-'+capability,approval:x.rolloutApprovals.issue('synthetic-owner',intent)})}
 const m=msg(x.input.accountId,'verified-scope',x.binding.external_id);await x.controller.receiveFromChannel(m);const c=x.router.canonicalize(m)!;assert.equal((x.db.db.prepare('SELECT count(*) n FROM v2_capability_rollouts WHERE account_id=? AND conversation_id=?').get(m.accountId,c.message.conversationId) as any).n,7);
 const intent={action:'DISABLE' as const,capability:'quotation',accountId:m.accountId,conversationId:c.message.conversationId,enabled:false};x.rollout.configure({...intent,idempotencyKey:'synthetic-exact-revoke',approval:x.rolloutApprovals.issue('synthetic-owner',intent)});
 await assert.rejects(x.controller.receiveFromChannel({...m,externalMessageId:'after-revocation',occurredAt:new Date(Date.now()+10).toISOString()}),/PERMISSION_REVOKED/);assert.equal(x.counts().turns,1);assert.equal((x.db.db.prepare("SELECT enabled FROM v2_capability_rollouts WHERE account_id=? AND conversation_id=? AND capability='quotation'").get(m.accountId,c.message.conversationId) as any).enabled,0)
 }finally{x.db.db.close()}
});
test('policy and duplicate hold survive a fresh database/controller process instance',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-inquiry-restart-')),file=join(dir,'synthetic.db');let x=setup({file});const m=msg(x.input.accountId,'persisted-admission');try{await x.controller.receiveFromChannel(m);x.db.db.close();x=setup({file,existing:true});assert.deepEqual(await x.controller.receiveFromChannel(m),{status:'INQUIRY_DUPLICATE_HELD'});assert.deepEqual(x.counts(),{models:0,turns:0});assert.equal(x.sent.length,0);await x.controller.receiveFromChannel({...m,externalMessageId:'fresh-after-restart',occurredAt:new Date(Date.now()+10).toISOString()});assert.equal(x.sent.length,1)}finally{x.db.db.close();rmSync(dir,{recursive:true,force:true})}
});

test('authenticated PN and LID identities reuse only a uniquely matching existing phone/customer relationship',async()=>{
 for(const useLid of [false,true]){const x=setup();try{const phone=x.binding.phone as string;assert.ok(phone);const pn=phone.replace(/[^0-9]/g,'')+'@s.whatsapp.net';const jid=useLid?'999000111222@lid':pn;const raw={key:{remoteJid:jid,remoteJidAlt:useLid?pn:undefined,id:'synthetic-transport-'+useLid,fromMe:false},message:{conversation:'Synthetic verified inquiry'},messageTimestamp:Date.now()+10} as any;const incoming=normalizeBaileysMessage(raw,x.input.accountId)!;await x.controller.receiveFromChannel(incoming);const alias=x.db.db.prepare('SELECT customer_id FROM customer_channel_identities WHERE channel_account_id=? AND external_id=?').get(x.input.accountId,jid) as any;assert.equal(alias.customer_id,x.binding.customer_id);assert.equal(x.counts().turns,1);assert.equal((x.db.db.prepare('SELECT count(*) n FROM customers').get() as any).n,1)}finally{x.db.db.close()}}
});
test('ambiguous verified phone evidence never chooses a customer or grants commerce',async()=>{
 const x=setup();try{x.db.db.prepare('INSERT INTO customers VALUES(?,?,?,?,?,?)').run('synthetic-second-customer','SYNTHETIC-SECOND','Synthetic second','SGD','OK','SG-MAIN');x.db.db.prepare('INSERT INTO customer_channel_identities VALUES(?,?,?,?,?,?)').run('synthetic-ambiguous-phone','synthetic-second-customer',x.input.accountId,'whatsapp','synthetic-other-identity',x.binding.phone);const pn=x.binding.phone.replace(/[^0-9]/g,'')+'@s.whatsapp.net';const incoming=normalizeBaileysMessage({key:{remoteJid:pn,id:'synthetic-ambiguous-inbound',fromMe:false},message:{conversation:'Synthetic public question'},messageTimestamp:Date.now()+10} as any,x.input.accountId)!;await x.controller.receiveFromChannel(incoming);assert.equal((x.db.db.prepare('SELECT count(*) n FROM customer_channel_identities WHERE external_id=?').get(pn) as any).n,0);assert.equal((x.db.db.prepare('SELECT count(*) n FROM workspace_authority').get() as any).n,0);assert.equal(x.counts().turns,0);assert.equal(x.counts().models,1);assert.equal(x.sent.length,1)}finally{x.db.db.close()}
});

test('a second connection exact DISABLE racing the first inquiry grant is never overwritten',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'waerp-inquiry-revoke-race-')),file=join(dir,'synthetic.db'),x=setup({file});
 const approvals=createRolloutApprovalAuthority(),other=new V1Database(file,undefined,approvals),revoker=new V2RolloutService(other,approvals);
 let raced=false;
 const inject=(original:Function)=>(input:any,...rest:any[])=>{
  if(!raced){raced=true;const intent={action:'DISABLE' as const,capability:input.capability,accountId:input.accountId,conversationId:input.conversationId,enabled:false};revoker.configure({...intent,idempotencyKey:'synthetic-racing-disable',approval:approvals.issue('synthetic-revoker',intent)})}
  return original(input,...rest);
 };
 x.rollout.configure=inject(x.rollout.configure.bind(x.rollout)) as any;
 const initial=(x.rollout as any).enableIfAbsent;if(initial)(x.rollout as any).enableIfAbsent=inject(initial.bind(x.rollout));
 try{await assert.rejects(x.controller.receiveFromChannel(msg(x.input.accountId,'synthetic-revoke-race',x.binding.external_id)),/PERMISSION_REVOKED|EXPLICIT_DISABLE/);assert.equal(raced,true);assert.equal((other.db.prepare('SELECT enabled FROM v2_capability_rollouts').get() as any).enabled,0);assert.equal((other.db.prepare("SELECT count(*) n FROM v2_rollout_events WHERE action='ENABLE'").get() as any).n,0);assert.equal(x.counts().turns,0);assert.equal(x.sent.length,0);assert.equal((x.db.db.prepare('SELECT state FROM account_inquiry_admissions').get() as any).state,'FAILED')}
 finally{other.db.close();x.db.db.close();rmSync(dir,{recursive:true,force:true})}
});

test('first grant rechecks policy, canonical binding and workspace authority inside its writer transaction',async()=>{
 for(const change of ['policy','identity','workspace'] as const){
  const dir=mkdtempSync(join(tmpdir(),'waerp-inquiry-stale-grant-')),file=join(dir,'synthetic.db'),x=setup({file});
  const migration=createMigrationApprovalAuthority(),other=new V1Database(file,migration);let injected=false;
  const original=x.rollout.enableIfAbsent.bind(x.rollout);
  x.rollout.enableIfAbsent=(input,validate)=>{
   if(!injected){injected=true;
    if(change==='policy')other.db.prepare("UPDATE account_inquiry_policies SET status='REVOKED'").run();
    if(change==='identity')other.db.prepare('DELETE FROM customer_channel_identities').run();
    if(change==='workspace'){const service=new WorkspaceMigrationService(other,migration),a=service.getAuthority(input.accountId,input.conversationId),scope={accountId:input.accountId,conversationId:input.conversationId,customerId:x.binding.customer_id};const approval=migration.issue('synthetic-revoker','V1_OWNER','ROLLBACK',{...scope,expectedState:a.migration_state,expectedHash:a.legacy_source_hash??'',expectedRevision:a.revision,expectedWorkItemId:a.work_item_id??null,expectedDraftRevision:null,compatibilityConfirmed:null});service.rollback({...scope,idempotencyKey:'synthetic-concurrent-rollback',approval})}
   }
   return original(input,()=>{assert.equal(x.db.db.inTransaction,true);validate()});
  };
  try{await assert.rejects(x.controller.receiveFromChannel(msg(x.input.accountId,'synthetic-stale-'+change,x.binding.external_id)),/POLICY_CHANGED|VERIFIED_IDENTITY_REQUIRED|WORKSPACE_AUTHORITY_CHANGED/);assert.equal(injected,true);assert.equal((other.db.prepare('SELECT count(*) n FROM v2_capability_rollouts').get() as any).n,0);assert.equal(x.counts().turns,0);assert.equal(x.sent.length,0);assert.equal((x.db.db.prepare('SELECT state FROM account_inquiry_admissions').get() as any).state,'FAILED')}
  finally{other.db.close();x.db.db.close();rmSync(dir,{recursive:true,force:true})}
 }
});

test('ignored first-grant insert and aborted approval event cannot report or leave an enabled grant',async()=>{
 for(const fault of ['ignore-insert','abort-event'] as const){const x=setup();try{
  if(fault==='ignore-insert')x.db.db.exec("CREATE TRIGGER synthetic_ignore_initial_grant BEFORE INSERT ON v2_capability_rollouts BEGIN SELECT RAISE(IGNORE); END");
  else x.db.db.exec("CREATE TRIGGER synthetic_abort_initial_event BEFORE INSERT ON v2_rollout_events BEGIN SELECT RAISE(ABORT,'SYNTHETIC_EVENT_FAULT'); END");
  await assert.rejects(x.controller.receiveFromChannel(msg(x.input.accountId,'synthetic-grant-fault-'+fault,x.binding.external_id)),/INITIAL_GRANT_PERSISTENCE_REQUIRED|SYNTHETIC_EVENT_FAULT/);
  assert.equal((x.db.db.prepare('SELECT count(*) n FROM v2_capability_rollouts').get() as any).n,0);assert.equal((x.db.db.prepare('SELECT count(*) n FROM v2_rollout_events').get() as any).n,0);assert.equal(x.counts().turns,0);assert.equal(x.sent.length,0);assert.equal((x.db.db.prepare('SELECT state FROM account_inquiry_admissions').get() as any).state,'FAILED');
 }finally{x.db.db.close()}}
});
