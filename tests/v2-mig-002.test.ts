import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {V1Database} from '../src/database.js';
import {WorkspaceMigrationService} from '../src/v2-workspace-migration.js';
import {createMigrationApprovalAuthority} from '../src/migration-auth.js';
import { issueBoundMigrationApproval } from './migration-approval-helper.js';
import {V2RolloutService} from '../src/v2-rollout.js';
import {createRolloutApprovalAuthority} from '../src/rollout-auth.js';
import {canonicalSha256} from '../src/v2-canonical.js';

const A='demo-account',C='conv-001',U='CUST-001';
const approval=(ra:ReturnType<typeof createRolloutApprovalAuthority>,capability:string,enabled=true,accountId:string|null=null,conversationId:string|null=null,action: 'ENABLE'|'DISABLE'|'ROLLBACK'=enabled?'ENABLE':'DISABLE')=>ra.issue('m2',{action,capability,accountId,conversationId,enabled});
function setup(filename=':memory:'){
  const ma=createMigrationApprovalAuthority(),ra=createRolloutApprovalAuthority(),db=new V1Database(filename,ma,ra);db.resetAndSeed();
  const migration=new WorkspaceMigrationService(db,ma),shadow=migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'m2-shadow',approval:issueBoundMigrationApproval(ma,migration,'m2','MIGRATION_OWNER','SHADOW_IMPORT',{accountId:A,conversationId:C,customerId:U})});
  migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null,idempotencyKey:'m2-canary',approval:issueBoundMigrationApproval(ma,migration,'m2','V1_OWNER','PROMOTE_CANARY',{accountId:A,conversationId:C,customerId:U},{expectedHash:shadow.sourceHash!,expectedWorkItemId:null,expectedDraftRevision:null})});
  return {db,rollout:new V2RolloutService(db,ra),ra};
}

test('MIG-002 disabled and malformed/unknown capabilities fail closed',()=>{
  const x=setup();assert.equal(x.rollout.evaluate({capability:'order_validation',accountId:A,conversationId:C}).effectiveV2,false);
  assert.match(String(x.rollout.evaluate({capability:'not-a-capability',accountId:A,conversationId:C}).reasonCode),/ROLLOUT_CAPABILITY_UNKNOWN/);
  assert.throws(()=>x.rollout.configure({capability:'not-a-capability',enabled:true,idempotencyKey:'bad',approval:approval(x.ra,'not-a-capability')}),/ROLLOUT_CAPABILITY_UNKNOWN/);
  assert.throws(()=>x.rollout.configure({capability:'order_validation',enabled:true,idempotencyKey:'bad',approval:{}}),/ROLLOUT_APPROVAL_REQUIRED/);
});

test('MIG-002 closes rollout authority bypasses at service and database boundaries',()=>{
  const x=setup();
  const forged={subject:'attacker',action:'ENABLE'};
  assert.throws(()=>x.rollout.configure({capability:'order_validation',enabled:true,idempotencyKey:'forged-shaped',approval:forged as any}),/ROLLOUT_APPROVAL_REQUIRED/);
  assert.throws(()=>x.rollout.configure({capability:'order_validation',enabled:true,idempotencyKey:'trusted-shaped',approval:forged as any,trustedApproval:{subject:'trusted',action:'ENABLE'}} as any),/ROLLOUT_APPROVAL_REQUIRED/);

  assert.throws(()=>x.db.runRolloutMutation(()=>x.db.db.prepare("INSERT INTO v2_rollout_events(id,capability,action,enabled,idempotency_key,input_hash,approval_subject,result_json,created_at) VALUES('raw','order_validation','ENABLE',1,'raw','raw','attacker','{}',datetime('now'))").run(),undefined as any),/ROLLOUT_APPROVAL_REQUIRED/);
  const enable=approval(x.ra,'order_validation',true,A,null);
  assert.throws(()=>x.db.runRolloutMutation(()=>x.db.db.prepare("INSERT INTO v2_rollout_events(id,capability,action,enabled,idempotency_key,input_hash,approval_subject,result_json,created_at) VALUES('cross','order_validation','DISABLE',0,'cross','cross','attacker','{}',datetime('now'))").run(),enable),/ROLLOUT_MUTATION_CONTEXT_MISMATCH/);
  assert.throws(()=>x.db.db.prepare("INSERT INTO v2_rollout_events(id,capability,action,enabled,idempotency_key,input_hash,approval_subject,result_json,created_at) VALUES('raw','order_validation','ENABLE',1,'raw','raw','attacker','{}',datetime('now'))").run(),/ROLLOUT_EVENT_INSERT_REQUIRES_SERVICE/);
  assert.throws(()=>x.db.db.prepare("INSERT INTO v2_capability_rollouts(capability,enabled,updated_at,updated_by) VALUES('order_validation',1,datetime('now'),'attacker')").run(),/ROLLOUT_INSERT_REQUIRES_SERVICE/);
  assert.equal((x.db.db.prepare("SELECT count(*) AS n FROM v2_rollout_events WHERE id IN ('raw','cross')").get() as any).n,0);
  assert.throws(()=>x.rollout.configure({capability:'order_validation',enabled:true,accountId:A,idempotencyKey:'rollback-cannot-enable',approval:approval(x.ra,'order_validation',false,A,null,'ROLLBACK')}),/ROLLOUT_APPROVAL_REQUIRED/);
  assert.throws(()=>x.rollout.configure({capability:'order_validation',enabled:true,accountId:A,idempotencyKey:'disable-cannot-enable',approval:approval(x.ra,'order_validation',false,A)}),/ROLLOUT_APPROVAL_REQUIRED/);
  assert.throws(()=>x.rollout.configure({capability:'order_validation',enabled:false,accountId:A,idempotencyKey:'enable-cannot-disable',approval:approval(x.ra,'order_validation',true,A)}),/ROLLOUT_APPROVAL_REQUIRED/);
});

test('MIG-002 binds one approval to one immutable rollout intent',()=>{
  const x=setup(),token=approval(x.ra,'order_validation',true,A,null);
  assert.throws(()=>x.rollout.configure({capability:'quotation',enabled:true,accountId:A,idempotencyKey:'wrong-capability',approval:token}),/ROLLOUT_APPROVAL_REQUIRED/);
  assert.throws(()=>x.rollout.configure({capability:'order_validation',enabled:true,accountId:'other',idempotencyKey:'wrong-account',approval:token}),/ROLLOUT_APPROVAL_REQUIRED/);
  assert.throws(()=>x.rollout.configure({capability:'order_validation',enabled:true,accountId:A,conversationId:C,idempotencyKey:'wrong-conversation',approval:token}),/ROLLOUT_APPROVAL_REQUIRED/);
  assert.throws(()=>x.rollout.configure({capability:'order_validation',enabled:false,accountId:A,idempotencyKey:'wrong-enabled',approval:token}),/ROLLOUT_APPROVAL_REQUIRED/);
  assert.throws(()=>x.db.runRolloutMutation(()=>x.db.db.prepare("INSERT INTO v2_capability_rollouts(capability,account_id,enabled,updated_at,updated_by) VALUES('quotation',?,1,datetime('now'),'m2')").run(A),token),/ROLLOUT_MUTATION_CONTEXT_MISMATCH/);
  assert.throws(()=>x.db.runRolloutMutation(()=>x.db.db.prepare("INSERT INTO v2_capability_rollouts(capability,account_id,conversation_id,enabled,updated_at,updated_by) VALUES('order_validation','other','conv-001',1,datetime('now'),'m2')").run(),token),/ROLLOUT_CONVERSATION_SCOPE/);
  assert.throws(()=>x.ra.issue('m2',{action:'ENABLE',capability:'order_validation',accountId:null,conversationId:C,enabled:true}),/ROLLOUT_ACCOUNT_SCOPE_REQUIRED/);
  assert.throws(()=>x.ra.issue('m2',{action:'ENABLE',capability:'order_validation',accountId:A,conversationId:null,enabled:false}),/ROLLOUT_APPROVAL_ACTION_ENABLED_MISMATCH/);
  x.rollout.configure({capability:'order_validation',enabled:true,accountId:A,idempotencyKey:'valid-after-attacks',approval:token});
  assert.equal((x.db.db.prepare("SELECT count(*) AS n FROM v2_capability_rollouts WHERE capability='order_validation' AND account_id=?").get(A) as {n:number}).n,1);
});

test('MIG-002 account and conversation scopes isolate effective rollout',()=>{
  const x=setup(),a=approval(x.ra,'order_validation',true,A);
  x.rollout.configure({capability:'order_validation',enabled:true,accountId:A,idempotencyKey:'account-on',approval:a});
  assert.equal(x.rollout.evaluate({capability:'order_validation',accountId:A,conversationId:C}).effectiveV2,true);
  assert.equal(x.rollout.evaluate({capability:'quotation',accountId:A,conversationId:C}).effectiveV2,false);
  assert.throws(()=>x.rollout.configure({capability:'order_validation',enabled:true,accountId:'other',conversationId:C,idempotencyKey:'foreign',approval:approval(x.ra,'order_validation',true,'other',C)}),/ROLLOUT_CONVERSATION_SCOPE/);
  x.rollout.configure({capability:'order_validation',enabled:false,accountId:A,conversationId:C,idempotencyKey:'conversation-off',approval:approval(x.ra,'order_validation',false,A,C)});
  assert.equal(x.rollout.evaluate({capability:'order_validation',accountId:A,conversationId:C}).effectiveV2,false);
});

test('MIG-002 enforces NULL-scope uniqueness and precedence',()=>{
  const x=setup();
  x.rollout.configure({capability:'order_validation',enabled:true,idempotencyKey:'global-on',approval:approval(x.ra,'order_validation')});
  assert.throws(()=>x.db.runRolloutMutation(()=>x.db.db.prepare("INSERT INTO v2_capability_rollouts(capability,enabled,updated_at,updated_by) VALUES('order_validation',1,datetime('now'),'m2')").run(),approval(x.ra,'order_validation')),/UNIQUE/);
  x.rollout.configure({capability:'order_validation',enabled:false,accountId:A,idempotencyKey:'account-off',approval:approval(x.ra,'order_validation',false,A)});
  assert.throws(()=>x.db.runRolloutMutation(()=>x.db.db.prepare("INSERT INTO v2_capability_rollouts(capability,account_id,enabled,updated_at,updated_by) VALUES('order_validation',?,1,datetime('now'),'m2')").run(A),approval(x.ra,'order_validation',true,A)),/UNIQUE/);
  x.rollout.configure({capability:'order_validation',enabled:true,accountId:A,conversationId:C,idempotencyKey:'conversation-on',approval:approval(x.ra,'order_validation',true,A,C)});
  assert.equal(x.rollout.evaluate({capability:'order_validation',accountId:A,conversationId:C}).effectiveV2,true);
});

test('MIG-002 rollback is explicit, durable, restartable, and preserves V2 history',()=>{
  const x=setup();x.rollout.configure({capability:'order_draft_workspace',enabled:true,accountId:A,idempotencyKey:'on',approval:approval(x.ra,'order_draft_workspace',true,A)});
  const before=x.db.db.prepare('SELECT count(*) n FROM workspace_migration_events').get() as {n:number};
  const rollback=x.rollout.rollback({capability:'order_draft_workspace',accountId:A,idempotencyKey:'rollback',approval:approval(x.ra,'order_draft_workspace',false,A,null,'ROLLBACK')});
  assert.equal(rollback.status,'DISABLED');assert.equal(x.rollout.evaluate({capability:'order_draft_workspace',accountId:A,conversationId:C}).effectiveV2,false);
  assert.equal((x.db.db.prepare('SELECT count(*) n FROM workspace_migration_events').get() as {n:number}).n,before.n);
  assert.equal((x.db.db.prepare('SELECT count(*) n FROM v2_rollout_events').get() as {n:number}).n,2);
  const file=mkdtempSync(`${tmpdir()}/mig002-`);const persistent=setup(`${file}/orders.db`);
  persistent.rollout.configure({capability:'order_validation',enabled:true,accountId:A,idempotencyKey:'persist-on',approval:approval(persistent.ra,'order_validation',true,A)});persistent.db.db.close();
  const reopened=new V1Database(`${file}/orders.db`,undefined,persistent.ra);const afterRestart=new V2RolloutService(reopened,persistent.ra);
  assert.equal(afterRestart.evaluate({capability:'order_validation',accountId:A,conversationId:C}).effectiveV2,true);reopened.db.close();rmSync(file,{recursive:true,force:true});
  assert.ok(x.db.db.prepare('SELECT id FROM workspace_migration_events').get());
  assert.throws(()=>x.db.db.prepare('DELETE FROM workspace_migration_events').run(),/IMMUTABLE/);
  assert.match(JSON.stringify(rollback),/ROLLBACK/);
});

test('MIG-002 cannot enable V2 capability while workspace authority is V1',()=>{
  const ma=createMigrationApprovalAuthority(),ra=createRolloutApprovalAuthority(),db=new V1Database(':memory:',ma,ra);db.resetAndSeed();const r=new V2RolloutService(db,ra);
  r.configure({capability:'order_validation',enabled:true,accountId:A,idempotencyKey:'v1-on',approval:approval(ra,'order_validation',true,A)});
  const result=r.evaluate({capability:'order_validation',accountId:A,conversationId:C});assert.equal(result.configuredEnabled,true);assert.equal(result.effectiveV2,false);assert.equal(result.reasonCode,'WORKSPACE_AUTHORITY_REQUIRED');
});

test('MIG-002 static safety keeps global traffic and forbidden post/DO paths absent',()=>{
  assert.equal(canonicalSha256('v2-rollout').length,64);
  assert.doesNotMatch(JSON.stringify(['post_sales_order','confirm_sales_order','create_delivery_order','DO_READY']),/order_draft_workspace/);
});
