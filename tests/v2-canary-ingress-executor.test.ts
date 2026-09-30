import assert from 'node:assert/strict';
import test from 'node:test';
import { V1Database } from '../src/database.js';
import { CommerceService } from '../src/commerce.js';
import { V2CanaryIngressRouter } from '../src/v2-canary-ingress-router.js';
import { V2CapabilityExecutor } from '../src/v2-capability-executor.js';
import { ConversationIngressPersistence } from '../src/v2-conversation-ingress-persistence.js';
import { V2RolloutService, V2_CAPABILITIES } from '../src/v2-rollout.js';
import { createRolloutApprovalAuthority } from '../src/rollout-auth.js';
import { createMigrationApprovalAuthority } from '../src/migration-auth.js';
import { WorkspaceMigrationService } from '../src/v2-workspace-migration.js';
import { issueBoundMigrationApproval } from './migration-approval-helper.js';

const input={channel:'whatsapp' as const,accountId:'demo-account',conversationId:'conv-001',externalMessageId:'canary-test-1',sender:{externalId:'+6591110001',phone:'+6591110001'},type:'text' as const,text:'hello',occurredAt:new Date().toISOString()};

test('injected legacy compatibility cannot enable semantic fallback outside NODE_ENV=test',async()=>{
  const old=process.env.NODE_ENV;
  process.env.NODE_ENV='production';
  try {
    const db=new V1Database(':memory:');db.resetAndSeed();const commerce=new CommerceService(db);const rollout=new V2RolloutService(db);
    let v1Calls=0;(commerce as any).inbound=async()=>{v1Calls++;return {}};
    const router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:false,outbound:commerce.outbound,allowLegacyFallback:true});
    await assert.rejects(()=>router.receive(input),/V2_RUNTIME_DISABLED_FAIL_CLOSED/);assert.equal(v1Calls,0);
  } finally { if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old; }
});

test('scoped test-only legacy compatibility remains available',async()=>{
  const old=process.env.NODE_ENV;process.env.NODE_ENV='test';
  try {
    const db=new V1Database(':memory:');db.resetAndSeed();const commerce=new CommerceService(db);const rollout=new V2RolloutService(db);
    let v1Calls=0;(commerce as any).inbound=async()=>{v1Calls++;return {status:'legacy-test'}};
    const router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:false,outbound:commerce.outbound,allowLegacyFallback:true});
    assert.deepEqual(await router.receive(input),{status:'legacy-test'});assert.equal(v1Calls,1);
  } finally { if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old; }
});

test('live inbound fails closed when V2 is disabled instead of invoking legacy semantic routing',async()=>{
  const db=new V1Database(':memory:');db.resetAndSeed();const commerce=new CommerceService(db);const rollout=new V2RolloutService(db);
  let v1Calls=0;(commerce as any).inbound=async()=>{v1Calls++;return {}};
  const router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:false,outbound:commerce.outbound});
  await assert.rejects(()=>router.receive(input),/V2_RUNTIME_DISABLED_FAIL_CLOSED/);
  assert.equal(v1Calls,0);
});

test('live inbound fails closed when the route is not authoritative instead of invoking legacy semantic routing',async()=>{
  const db=new V1Database(':memory:');db.resetAndSeed();const commerce=new CommerceService(db);const rollout=new V2RolloutService(db);
  let v1Calls=0;(commerce as any).inbound=async()=>{v1Calls++;return {}};
  const router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:true,outbound:commerce.outbound});
  await assert.rejects(()=>router.receive(input),/V2_ROUTE_NOT_AUTHORITATIVE_FAIL_CLOSED/);
  assert.equal(v1Calls,0);
});

test('production drain fails closed before reclassifying or replaying durable work',async()=>{
  const old=process.env.NODE_ENV;process.env.NODE_ENV='production';
  try {
    const db=new V1Database(':memory:');db.resetAndSeed();const commerce=new CommerceService(db);const rollout=new V2RolloutService(db);
    let replayCalls=0;(commerce as any).inboundCanonicalReplay=async()=>{replayCalls++;return {} };
    const router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:false,outbound:commerce.outbound,allowLegacyFallback:true});
    const queue=new (await import('../src/v2-queue.js')).V2QueueService(db);
    const queued=queue.enqueueInbound({accountId:'demo-account',conversationId:'conv-001',externalMessageId:'rollback-preserve',occurredAt:new Date().toISOString(),text:'legacy replay candidate'});
    await assert.rejects(()=>router.drainDisabledV2({accountId:'demo-account',conversationId:'conv-001'}),/V2_LEGACY_DRAIN_DISABLED_FAIL_CLOSED/);
    assert.equal(replayCalls,0);
    assert.equal(queue.read({accountId:'demo-account',conversationId:'conv-001'}).items.find(item=>item.id===queued.item.id)?.state,'QUEUED');
  } finally { if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old; }
});

test('legacy drain remains available only through the explicit test compatibility seam',async()=>{
  const old=process.env.NODE_ENV;process.env.NODE_ENV='test';
  try {
    const db=new V1Database(':memory:');db.resetAndSeed();const commerce=new CommerceService(db);const rollout=new V2RolloutService(db);
    let replayCalls=0;(commerce as any).inboundCanonicalReplay=async(message:any)=>{replayCalls++;return {status:'legacy-test',externalMessageId:message.externalMessageId}};
    const router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:false,outbound:commerce.outbound,allowLegacyFallback:true});
    const queue=new (await import('../src/v2-queue.js')).V2QueueService(db);
    queue.enqueueInbound({accountId:'demo-account',conversationId:'conv-001',externalMessageId:'test-replay',occurredAt:new Date().toISOString(),text:'legacy replay candidate'});
    const result=await router.drainDisabledV2({accountId:'demo-account',conversationId:'conv-001'});
    assert.equal(result.drained,1);assert.equal(replayCalls,1);
  } finally { if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old; }
});

test('V2 canary ingress fails closed on missing transport without invoking V1',async()=>{
  const migrationAuthority=createMigrationApprovalAuthority();const approvals=createRolloutApprovalAuthority();const db=new V1Database(':memory:',migrationAuthority,approvals);db.resetAndSeed();
  const commerce=new CommerceService(db);const rollout=new V2RolloutService(db,approvals);
  const migration=new WorkspaceMigrationService(db,migrationAuthority);const shadow=migration.shadowImport({accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',idempotencyKey:'canary-shadow',approval:issueBoundMigrationApproval(migrationAuthority,migration,'test','MIGRATION_OWNER','SHADOW_IMPORT',{accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001'})});
  migration.promoteCanary({accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',expectedLegacySourceHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null,idempotencyKey:'canary-promote',approval:issueBoundMigrationApproval(migrationAuthority,migration,'test','V1_OWNER','PROMOTE_CANARY',{accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001'},{expectedHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null})});
  for(const capability of V2_CAPABILITIES) rollout.configure({capability,enabled:true,idempotencyKey:`canary-${capability}`,approval:approvals.issue('test',{action:'ENABLE',capability,accountId:null,conversationId:null,enabled:true})});
  let v1Calls=0;(commerce as any).inbound=async()=>{v1Calls++;return {}};
  const router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:true,outbound:commerce.outbound});
  await assert.rejects(()=>router.receive(input),/V2_ROUTE_AGENT_RUNTIME_UNAVAILABLE/);
  assert.equal(v1Calls,0);assert.equal((db.db.prepare('SELECT count(*) n FROM v2_inbox_items').get() as any).n,0);
});

test('V2 canonical ingress rejects a persisted identity from a different channel',()=>{
  const db=new V1Database(':memory:');db.resetAndSeed();
  db.db.prepare("UPDATE customer_channel_identities SET channel='email' WHERE id='identity-001'").run();
  const persistence=new ConversationIngressPersistence(db);
  assert.throws(()=>persistence.resolve(input),/V2_CANONICAL_CHANNEL_CONFLICT/);
});

test('V2 executor emits the exact registered customer and history field names',async()=>{
  const db=new V1Database(':memory:');db.resetAndSeed();const commerce=new CommerceService(db);const executor=new V2CapabilityExecutor(db,commerce);
  const base={accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001'};
  const customer=await executor.execute({id:'ctx',capability:{name:'get_customer_context',version:'v1'} as any,arguments:base} as any) as any;
  assert.equal(customer.data.customerId,'CUST-001');assert.equal('id' in customer.data,false);
  const history=await executor.execute({id:'history',capability:{name:'get_order_history',version:'v1'} as any,arguments:base} as any) as any;
  assert.ok(Array.isArray(history.data.orders));for(const order of history.data.orders)assert.equal('deliveryDate' in order,false);
});

test('V2 canary router drains an expired pre-side-effect item and processes the newly arrived bound turn',async()=>{
  const { V2QueueService } = await import('../src/v2-queue.js');
  const { AgentTurnCoordinator } = await import('../src/v2-agent-turn-coordinator.js');
  const migrationAuthority=createMigrationApprovalAuthority();const approvals=createRolloutApprovalAuthority();const db=new V1Database(':memory:',migrationAuthority,approvals);db.resetAndSeed();
  const commerce=new CommerceService(db);const rollout=new V2RolloutService(db,approvals);const migration=new WorkspaceMigrationService(db,migrationAuthority);
  const shadow=migration.shadowImport({accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',idempotencyKey:'drain-shadow',approval:issueBoundMigrationApproval(migrationAuthority,migration,'test','MIGRATION_OWNER','SHADOW_IMPORT',{accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001'})});
  migration.promoteCanary({accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',expectedLegacySourceHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null,idempotencyKey:'drain-promote',approval:issueBoundMigrationApproval(migrationAuthority,migration,'test','V1_OWNER','PROMOTE_CANARY',{accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001'},{expectedHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null})});
  for(const capability of V2_CAPABILITIES) rollout.configure({capability,enabled:true,idempotencyKey:`drain-${capability}`,approval:approvals.issue('test',{action:'ENABLE',capability,accountId:null,conversationId:null,enabled:true})});

  const queue=new V2QueueService(db);
  const old=queue.enqueueInbound({accountId:'demo-account',conversationId:'conv-001',externalMessageId:'stale-old',occurredAt:'2026-09-11T00:00:00Z',text:'old'});
  const oldTurn=new AgentTurnCoordinator(db).start({accountId:'demo-account',conversationId:'conv-001',inboundMessageId:old.item.messageId,profileId:'sales-digital-employee',nowIso:'2026-09-11T00:00:00Z',timezone:'Asia/Singapore'});
  queue.bindAgentTurn({accountId:'demo-account',conversationId:'conv-001',arrivalSeq:old.item.arrivalSeq,turnId:oldTurn.turnId});
  queue.claimNext({accountId:'demo-account',conversationId:'conv-001',owner:'stale-worker',leaseMs:1000,nowIso:'2026-09-11T00:00:00Z'});

  const ran:string[]=[];
  const piHarness={
    describe:()=>({engine:'test'}),
    run:async(start:any)=>{ran.push(start.inboundMessageId);return {turnId:'fake',status:'TERMINAL',reasonCode:'PI_FINAL_PENDING_GROUNDING',responsePlan:null,projection:{}} as any;},
  };
  const router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:true,piHarness,outbound:commerce.outbound,owner:'router-drain-test'});
  const fresh={...input,externalMessageId:'fresh-new',text:'hello after stale lease',occurredAt:new Date().toISOString()};
  await router.receive(fresh);
  const items=db.db.prepare("SELECT arrival_seq,state,side_effect_started,message_id FROM v2_inbox_items ORDER BY arrival_seq").all() as any[];
  assert.deepEqual(items.map(x=>[x.arrival_seq,x.state,x.side_effect_started]),[[1,'SUPERSEDED',0],[2,'COMPLETED',1]]);
  assert.deepEqual(ran,[items[1].message_id]);
  const state=db.db.prepare("SELECT processed_watermark,lease_owner FROM v2_conversation_inbox WHERE account_id='demo-account' AND conversation_id='conv-001'").get() as any;
  assert.equal(state.processed_watermark,2);assert.equal(state.lease_owner,null);
});

test('injected runtime runner receives each durable start while a newer receive joins the same drain',async()=>{
  const migrationAuthority=createMigrationApprovalAuthority();const approvals=createRolloutApprovalAuthority();const db=new V1Database(':memory:',migrationAuthority,approvals);db.resetAndSeed();
  const commerce=new CommerceService(db);const rollout=new V2RolloutService(db,approvals);const migration=new WorkspaceMigrationService(db,migrationAuthority);
  const shadow=migration.shadowImport({accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',idempotencyKey:'runner-shadow',approval:issueBoundMigrationApproval(migrationAuthority,migration,'test','MIGRATION_OWNER','SHADOW_IMPORT',{accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001'})});
  migration.promoteCanary({accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001',expectedLegacySourceHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null,idempotencyKey:'runner-promote',approval:issueBoundMigrationApproval(migrationAuthority,migration,'test','V1_OWNER','PROMOTE_CANARY',{accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001'},{expectedHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null})});
  for(const capability of V2_CAPABILITIES) rollout.configure({capability,enabled:true,idempotencyKey:`runner-${capability}`,approval:approvals.issue('test',{action:'ENABLE',capability,accountId:null,conversationId:null,enabled:true})});
  const router=new V2CanaryIngressRouter(db,commerce,rollout,{enabled:true,outbound:commerce.outbound,owner:'runner-drain-test'});
  const oldCanonical=router.canonicalize({...input,externalMessageId:'runner-old',text:'old'});assert(oldCanonical);
  const newCanonical=router.canonicalize({...input,externalMessageId:'runner-new',text:'new'});assert(newCanonical);
  const seen:string[]=[];let newerPromise:Promise<unknown>|undefined;
  const runner=async ({start}:any)=>{
    seen.push(start.inboundMessageId);
    if(seen.length===1)newerPromise=router.receiveCanonicalWithRunner(newCanonical!,runner);
    return {status:'TERMINAL',reasonCode:'PI_FINAL_PENDING_GROUNDING'};
  };
  await router.receiveCanonicalWithRunner(oldCanonical,runner);assert(newerPromise);await newerPromise;
  const durable=db.db.prepare('SELECT message_id FROM v2_inbox_items ORDER BY arrival_seq').all() as {message_id:string}[];
  assert.deepEqual(seen,durable.map(row=>row.message_id));
});
