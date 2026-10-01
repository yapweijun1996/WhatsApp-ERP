import test from 'node:test';
import {createMigrationApprovalAuthority} from '../src/migration-auth.js';
import {WorkspaceMigrationService} from '../src/v2-workspace-migration.js';
import {issueBoundMigrationApproval} from './migration-approval-helper.js';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {CommerceService} from '../src/commerce.js';
import {V2RolloutService,V2_CAPABILITIES} from '../src/v2-rollout.js';
import {createRolloutApprovalAuthority} from '../src/rollout-auth.js';
import {V2CanaryIngressRouter,type ProspectReplyScope} from '../src/v2-canary-ingress-router.js';
const message=(accountId='test-account',conversationId='prospect-a',id='scope-1')=>({accountId,conversationId,externalMessageId:id,channel:'whatsapp' as const,sender:{externalId:'synthetic-sender',phone:'+6500000000'},type:'text' as const,text:'Synthetic catalog question',occurredAt:new Date().toISOString()});
function setup(scopes?:readonly ProspectReplyScope[]){const approvals=createRolloutApprovalAuthority();const db=new V1Database(':memory:',undefined,approvals);db.resetAndSeed();let models=0,sends=0,reads=0;const rollout=new V2RolloutService(db,approvals);const router=new V2CanaryIngressRouter(db,new CommerceService(db),rollout,{enabled:true,prospectReplyScopes:scopes,outbound:{send:async()=>{sends++;return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};}} as any,prospectModel:async()=>{models++;return 'Synthetic response'},prospectCatalog:{searchProducts:async()=>{reads++;return []},getProductDetail:async()=>{reads++;return null}} as any});return{db,approvals,rollout,router,counts:()=>({models,sends,reads})}}
test('customer rollout cannot authorize prospect replies; default denial persists intake and suppresses replay',async()=>{
 const x=setup();try{for(const capability of V2_CAPABILITIES)x.rollout.configure({capability,enabled:true,accountId:'demo-account',conversationId:'conv-001',idempotencyKey:'synthetic-'+capability,approval:x.approvals.issue('synthetic-owner',{action:'ENABLE',capability,accountId:'demo-account',conversationId:'conv-001',enabled:true})});
 const m=message();for(let i=0;i<2;i++){const result=await x.router.receive(m) as any;assert.equal(result.routeOutcome,'PROSPECT_OUTBOUND_SCOPE_REQUIRED');assert.equal(result.replySuppressed,true)}
 assert.deepEqual(x.counts(),{models:0,sends:0,reads:0});assert.equal((x.db.db.prepare('SELECT count(*) n FROM messages WHERE external_message_id=?').get(m.externalMessageId) as any).n,1);assert.equal((x.db.db.prepare("SELECT reply_state FROM prospect_reply_sequence WHERE account_id=? AND external_message_id=?").get(m.accountId,m.externalMessageId) as any).reply_state,'SUPPRESSED');assert.equal((x.db.db.prepare("SELECT count(*) n FROM inbound_route_audit WHERE route_outcome='PROSPECT_OUTBOUND_SCOPE_REQUIRED'").get() as any).n,1);assert.equal((x.db.db.prepare('SELECT count(*) n FROM customer_channel_identities WHERE external_id=?').get(m.sender.externalId) as any).n,0);
 }finally{x.db.db.close()}
});
test('only exact account/conversation gets fresh prospect reply; caller mutation cannot widen scope',async()=>{
 const scopes=[{accountId:'test-account',externalConversationId:'prospect-a'}],x=setup(scopes);try{scopes.push({accountId:'other-account',externalConversationId:'prospect-b'});await x.router.receive(message('test-account','prospect-b','scope-b'));await x.router.receive(message('other-account','prospect-a','scope-other'));await x.router.receive(message('other-account','prospect-b','scope-mutation'));assert.deepEqual(x.counts(),{models:0,sends:0,reads:0});await x.router.receive(message());assert.deepEqual(x.counts(),{models:1,sends:1,reads:0});await x.router.receive(message());assert.deepEqual(x.counts(),{models:1,sends:1,reads:0})}finally{x.db.db.close()}
});
test('later authorization never replays an inbound suppressed before approval',async()=>{
 const x=setup();try{const m=message();await x.router.receive(m);let sent=0,modeled=0;const approved=new V2CanaryIngressRouter(x.db,new CommerceService(x.db),x.rollout,{enabled:true,prospectReplyScopes:[{accountId:m.accountId,externalConversationId:m.conversationId}],outbound:{send:async()=>{sent++;return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};}} as any,prospectModel:async()=>{modeled++;return 'Synthetic response'}});await approved.receive(m);assert.equal(sent,0);assert.equal(modeled,0);await approved.receive(message('test-account','prospect-a','fresh-approved'));assert.equal(sent,1);assert.equal(modeled,1)}finally{x.db.db.close()}
});
test('wildcard and malformed prospect reply scope is rejected',()=>{for(const scopes of [[{accountId:'*',externalConversationId:'prospect-a'}],[{accountId:'test-account',externalConversationId:'*'}],[{accountId:'',externalConversationId:'prospect-a'}]])assert.throws(()=>setup(scopes),/PROSPECT_REPLY_SCOPE_INVALID/)});

test('suppressed prospect redelivery cannot enter newly authorized customer workspace; fresh input can',async()=>{
 const approvals=createRolloutApprovalAuthority(),authority=createMigrationApprovalAuthority();const db=new V1Database(':memory:',authority,approvals);db.resetAndSeed();
 try{const rollout=new V2RolloutService(db,approvals);const router=new V2CanaryIngressRouter(db,new CommerceService(db),rollout,{enabled:true,outbound:{} as any});const m=message('demo-account','promotion-synthetic','denied-before-promotion');await router.receive(m);
 const customer=(db.db.prepare('SELECT id FROM customers LIMIT 1').get() as any).id;
 db.db.prepare('INSERT INTO customer_channel_identities VALUES(?,?,?,?,?,?)').run('synthetic-promotion-binding',customer,m.accountId,m.channel,m.sender.externalId,m.sender.phone);
 const canonical=router.canonicalize(m)!;assert.equal(canonical.customerId,customer);const scope={accountId:m.accountId,conversationId:canonical.message.conversationId,customerId:customer};const migration=new WorkspaceMigrationService(db,authority);const shadow=migration.shadowImport({...scope,idempotencyKey:'promotion-shadow',approval:issueBoundMigrationApproval(authority,migration,'synthetic-owner','MIGRATION_OWNER','SHADOW_IMPORT',scope)});
 migration.promoteCanary({...scope,expectedLegacySourceHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null,idempotencyKey:'promotion-canary',approval:issueBoundMigrationApproval(authority,migration,'synthetic-owner','V1_OWNER','PROMOTE_CANARY',scope,{expectedHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null})});
 for(const capability of V2_CAPABILITIES)rollout.configure({capability,enabled:true,accountId:scope.accountId,conversationId:scope.conversationId,idempotencyKey:'promotion-'+capability,approval:approvals.issue('synthetic-owner',{action:'ENABLE',capability,accountId:scope.accountId,conversationId:scope.conversationId,enabled:true})});
 let turns=0;const runner=async()=>{turns++;return{status:'TERMINAL'}};
 await router.receiveCanonicalWithRunner(canonical,runner);assert.equal(turns,0);assert.equal((db.db.prepare('SELECT count(*) n FROM v2_inbox_items').get() as any).n,0);assert.equal((db.db.prepare("SELECT count(*) n FROM inbound_route_audit WHERE route_outcome='PROSPECT_OUTBOUND_SCOPE_REQUIRED'").get() as any).n,1);
 const freshResult=await router.receiveCanonicalWithRunner(router.canonicalize({...m,externalMessageId:'fresh-after-promotion'})!,runner);assert.equal(turns,1,JSON.stringify(freshResult));
 }finally{db.db.close()}
});
test('concurrent prospect duplicates claim once before model await',async()=>{
 const x=setup([{accountId:'test-account',externalConversationId:'prospect-a'}]);try{let modeled=0,sent=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r});const router=new V2CanaryIngressRouter(x.db,new CommerceService(x.db),x.rollout,{enabled:true,prospectReplyScopes:[{accountId:'test-account',externalConversationId:'prospect-a'}],prospectModel:async()=>{modeled++;await gate;return 'Synthetic response'},outbound:{send:async()=>{sent++;return {status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()};}} as any});
 const a=router.receive(message()),b=router.receive(message());release();await Promise.all([a,b]);assert.equal(modeled,1);assert.equal(sent,1);
 }finally{x.db.db.close()}
});

test('ambiguous send is held durably across router restart without another model or send',async()=>{
 const x=setup();try{let models=0,sends=0;const scopes=[{accountId:'test-account',externalConversationId:'prospect-a'}];const options={enabled:true,prospectReplyScopes:scopes,prospectModel:async()=>{models++;return 'Synthetic response'},outbound:{send:async()=>{sends++;throw Error('synthetic crash after possible provider submission')}} as any};
 await new V2CanaryIngressRouter(x.db,new CommerceService(x.db),x.rollout,options).receive(message());
 const ledger=x.db.db.prepare('SELECT state,client_message_id FROM prospect_reply_delivery').get() as any;assert.equal(ledger.state,'UNKNOWN');assert.match(ledger.client_message_id,/^prospect-[a-f0-9]{64}$/);
 await new V2CanaryIngressRouter(x.db,new CommerceService(x.db),x.rollout,options).receive(message());assert.equal(models,1);assert.equal(sends,1);assert.equal((x.db.db.prepare('SELECT state FROM prospect_reply_delivery').get() as any).state,'UNKNOWN');
 await new V2CanaryIngressRouter(x.db,new CommerceService(x.db),x.rollout,options).receive(message('test-account','prospect-a','distinct-new-message'));assert.equal(models,2);assert.equal(sends,2);
 }finally{x.db.db.close()}
});
test('crash after claim is held for review without automatic inference or outbound replay',async()=>{
 const x=setup([{accountId:'test-account',externalConversationId:'prospect-a'}]);try{const m=message();const c=x.router.canonicalize(m)!;x.db.db.prepare("INSERT INTO prospect_reply_delivery VALUES(?,?,?,?,?,?)").run(m.accountId,m.externalMessageId,c.message.conversationId,'prospect-synthetic-claimed','CLAIMED',new Date().toISOString());await x.router.receive(m);assert.deepEqual(x.counts(),{models:0,sends:0,reads:0});assert.equal((x.db.db.prepare('SELECT state FROM prospect_reply_delivery').get() as any).state,'CLAIMED')}finally{x.db.db.close()}
});

test('crash after provider submission before disposition leaves UNKNOWN and never resends',async()=>{
 const x=setup();try{let sends=0;const options={enabled:true,prospectReplyScopes:[{accountId:'test-account',externalConversationId:'prospect-a'}],prospectModel:async()=> 'Synthetic response',outbound:{send:async()=>{sends++;return{status:'submitted',externalMessageId:'synthetic-provider-id',submittedAt:new Date().toISOString()}}} as any};
 x.db.db.exec("CREATE TRIGGER synthetic_crash_before_disposition BEFORE UPDATE ON prospect_reply_delivery WHEN NEW.state='SUBMITTED' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CRASH'); END");
 await assert.rejects(new V2CanaryIngressRouter(x.db,new CommerceService(x.db),x.rollout,options).receive(message()),/SYNTHETIC_CRASH/);assert.equal((x.db.db.prepare('SELECT state FROM prospect_reply_delivery').get() as any).state,'UNKNOWN');
 x.db.db.exec('DROP TRIGGER synthetic_crash_before_disposition');await new V2CanaryIngressRouter(x.db,new CommerceService(x.db),x.rollout,options).receive(message());assert.equal(sends,1);
 }finally{x.db.db.close()}
});
