import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {V1Database} from '../src/database.js';
import {canonicalSha256} from '../src/v2-canonical.js';
import {WorkspaceMigrationService} from '../src/v2-workspace-migration.js';
import {createMigrationApprovalAuthority} from '../src/migration-auth.js';
import {issueBoundMigrationApproval} from './migration-approval-helper.js';

const A='demo-account',C='conv-001',U='CUST-001';
function setup(filename=':memory:'){
  const auth=createMigrationApprovalAuthority(),db=new V1Database(filename,auth);db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))").run('mig003-msg',C,'mig003-msg','INBOUND','text','order','+6591110001','+6591110001',A);
  const migration=new WorkspaceMigrationService(db,auth),pending={customerId:U,accountId:A,sourceMessageId:'mig003-msg',senderExternalId:'+6591110001',requestedDeliveryDate:'2026-09-20',lines:[{query:'ayam',quantity:2,uom:'CTN'}]};
  db.db.prepare('INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)').run('pending-1',U,'pending_order',C,JSON.stringify(pending),1,'mig003-msg',new Date().toISOString());
  const scope={accountId:A,conversationId:C,customerId:U};
  return {db,migration,auth,pending,
    get shadow(){return issueBoundMigrationApproval(auth,migration,'migrator','MIGRATION_OWNER','SHADOW_IMPORT',scope)},
    get canary(){return issueBoundMigrationApproval(auth,migration,'v1','V1_OWNER','PROMOTE_CANARY',scope)},
    get primary(){return issueBoundMigrationApproval(auth,migration,'migrator','MIGRATION_OWNER','PROMOTE_PRIMARY',scope)},
    get retire(){return issueBoundMigrationApproval(auth,migration,'migrator','MIGRATION_OWNER','RETIRE_LEGACY',scope)},
    get cleanup(){return issueBoundMigrationApproval(auth,migration,'cleanup-owner','MIGRATION_OWNER','CLEANUP_LEGACY',scope)},
  };
}
function retired(x:ReturnType<typeof setup>){
  const s=x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'s',approval:x.shadow}),h=s.sourceHash!;
  x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:h,expectedWorkItemId:s.workItemId,expectedDraftRevision:s.draftRevision,idempotencyKey:'c',approval:x.canary});
  x.migration.promotePrimary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:h,idempotencyKey:'p',approval:x.primary});
  x.migration.retireLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:h,compatibilityConfirmed:true,idempotencyKey:'r',approval:x.retire});return h;
}

test('V2-MIG-003 cleans only scoped pending_order after retirement and records a chained event',()=>{
  const x=setup(),h=retired(x);
  x.db.db.prepare('INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)').run('other',U,'profile','other-key','{"keep":true}',1,null,new Date().toISOString());
  const cleanupApproval=x.cleanup;
  const result=x.migration.cleanupLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:h,idempotencyKey:'cleanup',approval:cleanupApproval});
  assert.equal(result.status,'CLEANED');assert.equal(x.db.db.prepare("SELECT 1 FROM customer_order_memory WHERE memory_type='pending_order' AND key_text=?").get(C),undefined);
  assert.ok(x.db.db.prepare("SELECT 1 FROM customer_order_memory WHERE memory_type='profile' AND key_text='other-key'").get());
  const event=x.db.db.prepare("SELECT event_type,from_state,to_state,previous_event_id,approval_action FROM workspace_migration_events WHERE event_type='LEGACY_CLEANUP'").get() as any;
  assert.equal(event.event_type,'LEGACY_CLEANUP');assert.equal(event.from_state,'LEGACY_RETIRED');assert.equal(event.to_state,'LEGACY_RETIRED');assert.equal(event.approval_action,'CLEANUP_LEGACY');assert.ok(event.previous_event_id);
  const replay=x.migration.cleanupLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:h,idempotencyKey:'cleanup',approval:cleanupApproval});assert.equal(replay.status,'CLEANED');assert.equal(replay.authority.last_migration_event_id,result.authority.last_migration_event_id);
});

test('V2-MIG-003 fails closed for approval, state, hash and scope mismatches',()=>{
  const x=setup(),h=retired(x);
  assert.throws(()=>x.migration.cleanupLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:h,idempotencyKey:'bad',approval:x.retire}),/MIGRATION_APPROVAL_REQUIRED/);
  const wrongHash=canonicalSha256(null),wrongHashApproval=issueBoundMigrationApproval(x.auth,x.migration,'cleanup-owner','MIGRATION_OWNER','CLEANUP_LEGACY',{accountId:A,conversationId:C,customerId:U},{expectedHash:wrongHash});
  assert.throws(()=>x.migration.cleanupLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:wrongHash,idempotencyKey:'hash',approval:wrongHashApproval}),/LEGACY_SOURCE_HASH_MISMATCH/);
  assert.throws(()=>x.migration.cleanupLegacy({accountId:A,conversationId:C,customerId:'wrong',expectedLegacySourceHash:h,idempotencyKey:'scope',approval:x.cleanup}),/CUSTOMER_SCOPE/);
  const y=setup(),s=y.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'ys',approval:y.shadow});assert.throws(()=>y.migration.cleanupLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:s.sourceHash!,idempotencyKey:'early',approval:y.cleanup}),/INVALID_MIGRATION_STATE/);
});

test('V2-MIG-003 blocks raw SQL deletion and reintroduction after retirement',()=>{
  const x=setup(),h=retired(x);assert.throws(()=>x.db.db.prepare("DELETE FROM customer_order_memory WHERE memory_type='pending_order' AND key_text=?").run(C),/LEGACY_PENDING_ORDER_CLEANUP_REQUIRED/);
  x.migration.cleanupLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:h,idempotencyKey:'cleanup',approval:x.cleanup});
  assert.throws(()=>x.db.db.prepare('INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)').run('reintroduced',U,'pending_order',C,'{}',1,null,new Date().toISOString()),/LEGACY_PENDING_ORDER_RETIRED/);
});

test('V2-MIG-003 keys retirement guards by authoritative conversation, not customer_id',()=>{
  const x=setup();x.db.db.prepare('INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)').run('attacker-existing','OTHER-CUSTOMER','pending_order',C,'{}',1,null,new Date().toISOString());retired(x);
  const insert=()=>x.db.db.prepare('INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)').run('attacker', 'OTHER-CUSTOMER','pending_order',C,'{}',1,null,new Date().toISOString());
  assert.throws(insert,/LEGACY_PENDING_ORDER_RETIRED/);
  x.db.db.prepare('INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)').run('unrelated','OTHER-CUSTOMER','profile','unrelated-key','{}',1,null,new Date().toISOString());
  assert.throws(()=>x.db.db.prepare("UPDATE customer_order_memory SET memory_type='pending_order',key_text=? WHERE id='unrelated'").run(C),/LEGACY_PENDING_ORDER_RETIRED/);
  assert.throws(()=>x.db.db.prepare("DELETE FROM customer_order_memory WHERE id='attacker-existing'").run(),/LEGACY_PENDING_ORDER_CLEANUP_REQUIRED/);
});

test('V2-MIG-003 binds raw cleanup SQL to the approved conversation and customer',()=>{
  const x=setup();
  x.db.db.prepare('INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)').run('mismatched-pending','OTHER-CUSTOMER','pending_order',C,'{}',1,null,new Date().toISOString());
  const h=retired(x);
  assert.throws(()=>x.db.runWorkspaceMigration(()=>x.db.db.prepare("DELETE FROM customer_order_memory WHERE memory_type='pending_order' AND key_text=?").run(C),x.cleanup,'CLEANUP_LEGACY','MIGRATION_OWNER'),/MIGRATION_SCOPE_REQUIRED/);
  let opened=false;
  assert.throws(()=>x.db.runWorkspaceMigration(()=>{opened=true;return x.db.db.prepare("DELETE FROM customer_order_memory WHERE memory_type='pending_order' AND key_text=?").run(C)},x.cleanup,'CLEANUP_LEGACY','MIGRATION_OWNER',{accountId:A,conversationId:C,customerId:'OTHER-CUSTOMER'}),/MIGRATION_SCOPE_CUSTOMER_MISMATCH/);
  assert.equal(opened,false);
  assert.throws(()=>x.db.db.prepare("DELETE FROM customer_order_memory WHERE customer_id=? AND memory_type='pending_order' AND key_text=?").run('OTHER-CUSTOMER',C),/LEGACY_PENDING_ORDER_CLEANUP_REQUIRED/);
  x.migration.cleanupLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:h,idempotencyKey:'cleanup-scoped',approval:x.cleanup});
});

test('V2-MIG-003 replaces stale customer memory guards on reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'waerp-mig003-upgrade-')),file=join(dir,'existing.sqlite');
  try{
    const x=setup(file);retired(x);x.db.db.exec("DROP TRIGGER customer_order_memory_pending_retired_insert_guard; CREATE TRIGGER customer_order_memory_pending_retired_insert_guard BEFORE INSERT ON customer_order_memory BEGIN SELECT 1; END;");x.db.db.close();
    const reopened=new V1Database(file,createMigrationApprovalAuthority());
    assert.throws(()=>reopened.db.prepare('INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)').run('stale-bypass','OTHER-CUSTOMER','pending_order',C,'{}',1,null,new Date().toISOString()),/LEGACY_PENDING_ORDER_RETIRED/);
    reopened.db.close();
  }finally{rmSync(dir,{recursive:true,force:true})}
});
