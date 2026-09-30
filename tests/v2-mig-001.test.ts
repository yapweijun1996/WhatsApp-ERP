import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';
import {V1Database} from '../src/database.js';
import {canonicalSha256} from '../src/v2-canonical.js';
import {WorkspaceMigrationService} from '../src/v2-workspace-migration.js';
import {createMigrationApprovalAuthority} from '../src/migration-auth.js';
import {issueBoundMigrationApproval} from './migration-approval-helper.js';

const A='demo-account', C='conv-001', U='CUST-001';
function setup(){
  const authority=createMigrationApprovalAuthority();
  const db=new V1Database(':memory:',authority);db.resetAndSeed();
  db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))").run('mig-msg',C,'mig-msg','INBOUND','text','order','+6591110001','+6591110001',A);
  const migration=new WorkspaceMigrationService(db,authority);
  const scope={accountId:A,conversationId:C,customerId:U};
  return {db,migration,authority,
    get migrationApproval(){return issueBoundMigrationApproval(authority,migration,'migrator-1','MIGRATION_OWNER','SHADOW_IMPORT',scope)},
    get primaryApproval(){return issueBoundMigrationApproval(authority,migration,'migrator-1','MIGRATION_OWNER','PROMOTE_PRIMARY',scope)},
    get otherPrimaryApproval(){return issueBoundMigrationApproval(authority,migration,'migrator-2','MIGRATION_OWNER','PROMOTE_PRIMARY',scope)},
    get retireApproval(){return issueBoundMigrationApproval(authority,migration,'migrator-1','MIGRATION_OWNER','RETIRE_LEGACY',scope)},
    get rollbackApproval(){return issueBoundMigrationApproval(authority,migration,'v1-1','V1_OWNER','ROLLBACK',scope)},
    get v1Approval(){return issueBoundMigrationApproval(authority,migration,'v1-1','V1_OWNER','PROMOTE_CANARY',scope)},
  };
}

test('V2-MIG-001 completes one-writer sequence and records verified approvals',()=>{
  const x=setup();
  const shadow=x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'s',approval:x.migrationApproval});
  const hash=canonicalSha256(null);
  assert.equal(shadow.authority.migration_state,'SHADOW_IMPORT');
  const canary=x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:hash,idempotencyKey:'c',approval:x.v1Approval});
  assert.equal(canary.authority.migration_state,'V2_CANARY');
  assert.equal(x.migration.promotePrimary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:hash,idempotencyKey:'p',approval:x.primaryApproval}).authority.migration_state,'V2_PRIMARY');
  const retireApproval=x.retireApproval;
  const retired=x.migration.retireLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:hash,compatibilityConfirmed:true,idempotencyKey:'r',approval:retireApproval});
  assert.equal(retired.authority.migration_state,'LEGACY_RETIRED');
  assert.equal(retired.authority.authoritative_writer,'V2');
  const events=x.db.db.prepare('SELECT approval_subject,approval_action FROM workspace_migration_events ORDER BY rowid').all() as Array<{approval_subject:string;approval_action:string}>;
  assert.deepEqual(events.map(e=>e.approval_action),['SHADOW_IMPORT','PROMOTE_CANARY','PROMOTE_PRIMARY','RETIRE_LEGACY']);
  assert.equal(x.migration.retireLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:hash,compatibilityConfirmed:true,idempotencyKey:'r',approval:retireApproval}).authority.migration_state,'LEGACY_RETIRED');
});

test('V2-MIG-001 rejects forged or cross-owner approvals and illegal transitions',()=>{
  const x=setup();
  assert.throws(()=>x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'bad',approval:{subject:'migration-service',owner:'MIGRATION_OWNER'} as object}),/MIGRATION_APPROVAL_REQUIRED/);
  const shadow=x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'s',approval:x.migrationApproval});
  assert.throws(()=>x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:canonicalSha256(null),idempotencyKey:'bad-owner',approval:x.migrationApproval}),/MIGRATION_APPROVAL_REQUIRED/);
  assert.throws(()=>x.migration.promotePrimary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:canonicalSha256(null),idempotencyKey:'early',approval:x.primaryApproval}),/INVALID_MIGRATION_STATE/);
  x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,idempotencyKey:'c',approval:x.v1Approval});
  assert.throws(()=>x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,idempotencyKey:'again',approval:x.v1Approval}),/INVALID_MIGRATION_STATE/);
});

test('V2-MIG-001 quarantines mismatch and same-key replay is stable',()=>{
  const x=setup();
  const shadow=x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'s',approval:x.migrationApproval});
  x.db.db.prepare("INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)").run('legacy',U,'pending_order',C,JSON.stringify({customerId:U,accountId:A,sourceMessageId:'mig-msg',senderExternalId:'+6591110001',requestedDeliveryDate:'2026-09-20',lines:[{query:'ayam',quantity:2,uom:'CTN'}]}),1,'mig-msg',new Date().toISOString());
  const canaryApproval=x.v1Approval;
  assert.throws(()=>x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,idempotencyKey:'q',approval:canaryApproval}),/SHADOW_HASH_MISMATCH/);
  const result=x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,idempotencyKey:'q',approval:canaryApproval});
  assert.equal(result.status,'QUARANTINED');assert.equal(result.authority.quarantine_reason,'SHADOW_HASH_MISMATCH');
  assert.deepEqual(x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,idempotencyKey:'q',approval:canaryApproval}),result);
  assert.throws(()=>x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:'different-input',idempotencyKey:'q',approval:canaryApproval}),/IDEMPOTENCY_CONFLICT/);
});

test('V2-MIG-001 requires explicit approval at every owner-gated transition',()=>{
  const x=setup(), hash=canonicalSha256(null), noApproval=(input:object)=>input as any;
  assert.throws(()=>x.migration.shadowImport(noApproval({accountId:A,conversationId:C,customerId:U,idempotencyKey:'missing-shadow'})),/MIGRATION_APPROVAL_REQUIRED/);
  const shadow=x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'approved-shadow',approval:x.migrationApproval});
  assert.throws(()=>x.migration.promoteCanary(noApproval({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:hash,idempotencyKey:'missing-canary'})),/MIGRATION_APPROVAL_REQUIRED/);
  x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:hash,idempotencyKey:'approved-canary',approval:x.v1Approval});
  assert.throws(()=>x.migration.promotePrimary(noApproval({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:hash,idempotencyKey:'missing-primary'})),/MIGRATION_APPROVAL_REQUIRED/);
  x.migration.promotePrimary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:hash,idempotencyKey:'approved-primary',approval:x.primaryApproval});
  assert.throws(()=>x.migration.retireLegacy(noApproval({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:hash,compatibilityConfirmed:true,idempotencyKey:'missing-retire'})),/MIGRATION_APPROVAL_REQUIRED/);
  x.migration.retireLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:hash,compatibilityConfirmed:true,idempotencyKey:'approved-retire',approval:x.retireApproval});

  const rollback=setup(), rollbackShadow=rollback.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'rollback-shadow',approval:rollback.migrationApproval});
  rollback.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:rollbackShadow.sourceHash!,idempotencyKey:'rollback-canary',approval:rollback.v1Approval});
  assert.throws(()=>rollback.migration.rollback(noApproval({accountId:A,conversationId:C,customerId:U,idempotencyKey:'missing-rollback'})),/MIGRATION_APPROVAL_REQUIRED/);
});

test('V2-MIG-001 approvals are process-local, bounded, and evidence never persists the token',()=>{
  const x=setup(), foreign=createMigrationApprovalAuthority(), foreignToken=issueBoundMigrationApproval(foreign,x.migration,'foreign','MIGRATION_OWNER','SHADOW_IMPORT',{accountId:A,conversationId:C,customerId:U});
  assert.throws(()=>x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'foreign',approval:foreignToken}),/MIGRATION_APPROVAL_REQUIRED/);
  const shadow=x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'bounded',approval:x.migrationApproval});
  const event=x.db.db.prepare('SELECT immutable_snapshot_json,approval_subject,approval_action FROM workspace_migration_events WHERE idempotency_key=?').get('bounded') as any;
  assert.equal(event.approval_subject,'migrator-1'); assert.equal(event.approval_action,'SHADOW_IMPORT');
  assert.ok(String(event.immutable_snapshot_json).length<2048);
  assert.ok(!String(event.immutable_snapshot_json).includes('MIGRATION_OWNER'));
  assert.deepEqual(JSON.parse(event.immutable_snapshot_json).approval,{subject:'migrator-1',action:'SHADOW_IMPORT'});
  assert.equal(shadow.authority.migration_state,'SHADOW_IMPORT');
});

test('V2-MIG-001 requires external authority and exposes no issuer',()=>{
  const db=new V1Database(':memory:'); db.resetAndSeed();
  assert.throws(()=>new WorkspaceMigrationService(db,undefined as any),/MIGRATION_APPROVAL_AUTHORITY_REQUIRED/);
  const authority=createMigrationApprovalAuthority(), boundDb=new V1Database(':memory:',authority), migration=new WorkspaceMigrationService(boundDb,authority);
  assert.equal('issueApproval' in migration,false);
  assert.equal(typeof (migration as any).issueApproval,'undefined');
  assert.equal(typeof authority.issue,'function');
});

test('V2-MIG-001 database gate rejects arbitrary callbacks and raw SQL without the bound approval',()=>{
  const authority=createMigrationApprovalAuthority(), db=new V1Database(':memory:',authority); db.resetAndSeed();
  const migration=new WorkspaceMigrationService(db,authority); migration.getAuthority('demo-account','conv-001');
  const raw=()=>db.db.prepare("UPDATE workspace_authority SET migration_state='SHADOW_IMPORT',authoritative_writer='LEGACY' WHERE account_id='demo-account' AND conversation_id='conv-001'").run();
  assert.throws(()=>db.runWorkspaceMigration(raw as any,{} as object,'SHADOW_IMPORT','MIGRATION_OWNER',{accountId:A,conversationId:C,customerId:U}),/MIGRATION_APPROVAL_REQUIRED/);
  assert.equal((db.db.prepare("SELECT migration_state FROM workspace_authority WHERE account_id='demo-account' AND conversation_id='conv-001'").get() as any).migration_state,'V1_ONLY');
  const scope={accountId:A,conversationId:C,customerId:U};
  const v1Token=issueBoundMigrationApproval(authority,migration,'owner','V1_OWNER','PROMOTE_CANARY',scope);
  const migrationToken=issueBoundMigrationApproval(authority,migration,'owner','MIGRATION_OWNER','SHADOW_IMPORT',scope);
  assert.throws(()=>db.runWorkspaceMigration(raw as any,v1Token,'SHADOW_IMPORT','MIGRATION_OWNER',scope),/MIGRATION_APPROVAL_REQUIRED/);
  assert.throws(()=>db.runWorkspaceMigration(raw as any,migrationToken,'PROMOTE_CANARY','MIGRATION_OWNER',scope),/MIGRATION_APPROVAL_REQUIRED/);
  assert.throws(()=>db.runWorkspaceMigration(raw as any,migrationToken,'SHADOW_IMPORT','V1_OWNER',scope),/MIGRATION_APPROVAL_REQUIRED/);
  const foreignAuthority=createMigrationApprovalAuthority(), foreign=issueBoundMigrationApproval(foreignAuthority,migration,'owner','MIGRATION_OWNER','SHADOW_IMPORT',scope);
  assert.throws(()=>db.runWorkspaceMigration(raw as any,foreign,'SHADOW_IMPORT','MIGRATION_OWNER',scope),/MIGRATION_APPROVAL_REQUIRED/);
});

test('V2-MIG-001 binds opaque approvals to the exact migration action',()=>{
  const x=setup();
  assert.throws(()=>x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'wrong-action',approval:x.v1Approval}),/MIGRATION_APPROVAL_REQUIRED/);
  assert.throws(()=>x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:canonicalSha256(null),idempotencyKey:'wrong-owner-action',approval:x.migrationApproval}),/MIGRATION_APPROVAL_REQUIRED/);
  assert.throws(()=>x.migration.promotePrimary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:canonicalSha256(null),idempotencyKey:'wrong-primary-action',approval:x.retireApproval}),/MIGRATION_APPROVAL_REQUIRED/);
});

test('V2-MIG-001 database gate blocks a PROMOTE_CANARY token from forging rollback SQL',()=>{
  const x=setup(),shadow=x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'attack-shadow',approval:x.migrationApproval});
  x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,idempotencyKey:'attack-canary',approval:x.v1Approval});
  const insert=x.db.db.prepare(`INSERT INTO workspace_migration_events
    (id,account_id,conversation_id,work_item_type,event_type,from_state,to_state,authoritative_writer,previous_event_id,work_item_id,draft_id,draft_revision,legacy_source_hash,legacy_schema_version,idempotency_key,normalized_input_hash,immutable_snapshot_json,approval_subject,approval_action,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rawRollback=()=>{
    insert.run('forged-rollback',A,C,'SALES_ORDER_REQUEST','ROLLBACK','V2_CANARY','V1_ONLY','LEGACY',null,null,null,null,null,'customer_order_memory.pending_order.v1','forged-rollback','{}','{}','v1-1','PROMOTE_CANARY',new Date().toISOString());
    x.db.db.prepare("UPDATE workspace_authority SET migration_state='V1_ONLY',authoritative_writer='LEGACY',last_migration_event_id='forged-rollback' WHERE account_id=? AND conversation_id=? AND work_item_type='SALES_ORDER_REQUEST'").run(A,C);
  };
  assert.throws(()=>x.db.runWorkspaceMigration(rawRollback,x.v1Approval,'PROMOTE_CANARY','V1_OWNER',{accountId:A,conversationId:C,customerId:U}),/INVALID_WORKSPACE_AUTHORITY_TRANSITION|WORKSPACE_MIGRATION_EVIDENCE_REQUIRED|WORKSPACE_MIGRATION_REVISION_REQUIRED/);
  assert.equal(x.migration.getAuthority(A,C).migration_state,'V2_CANARY');

  const forgedApprovalEvent=()=>insert.run('forged-action',A,C,'SALES_ORDER_REQUEST','ROLLBACK','V2_CANARY','V1_ONLY','LEGACY',null,null,null,null,null,'customer_order_memory.pending_order.v1','forged-action','{}','{}','v1-1','ROLLBACK',new Date().toISOString());
  assert.throws(()=>x.db.runWorkspaceMigration(forgedApprovalEvent,x.v1Approval,'PROMOTE_CANARY','V1_OWNER',{accountId:A,conversationId:C,customerId:U}),/WORKSPACE_MIGRATION_APPROVAL_MISMATCH/);
});

test('V2-MIG-001 binds replay identity and preserves compatibility baseline while quarantined',()=>{
  const x=setup(),shadow=x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'identity-shadow',approval:x.migrationApproval});
  const canary=x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,idempotencyKey:'identity-canary',approval:x.v1Approval});
  const same={accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,idempotencyKey:'identity-canary-replay',approval:x.primaryApproval};
  x.migration.promotePrimary({...same,idempotencyKey:'identity-primary'});
  assert.throws(()=>x.migration.promotePrimary({...same,idempotencyKey:'identity-primary',approval:x.otherPrimaryApproval}),/IDEMPOTENCY_CONFLICT/);
  const z=setup(),zs=z.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'primary-shadow',approval:z.migrationApproval});
  z.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:zs.sourceHash!,idempotencyKey:'primary-canary',approval:z.v1Approval});
  const replayKey={accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:zs.sourceHash!,idempotencyKey:'identity-primary-replay',approval:z.primaryApproval};
  z.db.db.prepare("INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)").run('fresh-mismatch',U,'pending_order',C,'not-json',1,'mig-msg',new Date().toISOString());
  assert.throws(()=>z.migration.promotePrimary(replayKey),/LEGACY_COMPATIBILITY_MISMATCH/);
  const authority=z.migration.getAuthority(A,C),event=z.db.db.prepare("SELECT immutable_snapshot_json FROM workspace_migration_events WHERE event_type='PROMOTE_PRIMARY_QUARANTINE'").get() as {immutable_snapshot_json:string};
  assert.equal(authority.migration_state,'V2_CANARY');assert.equal(authority.authoritative_writer,'V2');assert.equal(authority.legacy_source_hash,zs.sourceHash);assert.equal(authority.quarantine_reason,'LEGACY_COMPATIBILITY_MISMATCH');
  const snapshot=JSON.parse(event.immutable_snapshot_json);assert.equal(snapshot.sourceHash,zs.sourceHash);assert.equal(snapshot.observedSourceHash,canonicalSha256('not-json'));assert.equal(snapshot.error,'LEGACY_COMPATIBILITY_MISMATCH');assert.equal(snapshot.observedError,'LEGACY_SOURCE_INVALID');
  assert.deepEqual(z.migration.promotePrimary(replayKey),JSON.parse(event.immutable_snapshot_json));
  assert.throws(()=>z.migration.promotePrimary({...replayKey,idempotencyKey:'blocked-after-quarantine',approval:z.primaryApproval}),/WORKSPACE_QUARANTINED/);
  const y=setup(),ys=y.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'retire-shadow',approval:y.migrationApproval});
  y.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:ys.sourceHash!,idempotencyKey:'retire-canary',approval:y.v1Approval});
  y.migration.promotePrimary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:ys.sourceHash!,idempotencyKey:'retire-primary',approval:y.primaryApproval});
  y.db.db.prepare("INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)").run('retire-fresh-mismatch',U,'pending_order',C,'not-json',1,'mig-msg',new Date().toISOString());
  assert.throws(()=>y.migration.retireLegacy({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:ys.sourceHash!,compatibilityConfirmed:true,idempotencyKey:'retire-quarantine',approval:y.retireApproval}),/LEGACY_COMPATIBILITY_MISMATCH/);
  assert.equal(y.migration.getAuthority(A,C).migration_state,'V2_PRIMARY');assert.equal(y.migration.getAuthority(A,C).legacy_source_hash,ys.sourceHash);assert.equal(y.migration.getAuthority(A,C).quarantine_reason,'LEGACY_COMPATIBILITY_MISMATCH');
});


test('V2-MIG-001 replaces stale migration triggers when opening an existing database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'waerp-mig001-upgrade-')),file=join(dir,'existing.sqlite'),authority=createMigrationApprovalAuthority();
  try{
    let db=new V1Database(file,authority);db.resetAndSeed();
    db.db.exec(`DROP TRIGGER workspace_migration_event_insert_guard;
      DROP TRIGGER workspace_authority_migration_guard;
      CREATE TRIGGER workspace_migration_event_insert_guard BEFORE INSERT ON workspace_migration_events BEGIN SELECT 1; END;
      CREATE TRIGGER workspace_authority_migration_guard BEFORE UPDATE ON workspace_authority BEGIN SELECT 1; END;`);
    db.db.close();
    db=new V1Database(file,authority);
    const eventSql=String((db.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='workspace_migration_event_insert_guard'").get() as any).sql);
    const authoritySql=String((db.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='workspace_authority_migration_guard'").get() as any).sql);
    assert.match(eventSql,/WORKSPACE_MIGRATION_APPROVAL_MISMATCH/);
    assert.match(authoritySql,/v2_workspace_migration_action\(\)/);
    assert.match(authoritySql,/v2_workspace_migration_owner\(\)/);
    assert.doesNotMatch(authoritySql,/OLD\.migration_state=NEW\.migration_state AND OLD\.authoritative_writer=NEW\.authoritative_writer\) OR/);
    db.db.close();
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test('V2-MIG-001 upgrade writer lock closes the stale-trigger race',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'waerp-mig001-race-')),file=join(dir,'existing.sqlite');
  try{
    const db=new V1Database(file);db.resetAndSeed();new WorkspaceMigrationService(db,createMigrationApprovalAuthority()).getAuthority(A,C);
    const insert=db.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,account_id,occurred_at) VALUES(?,?,?,?,?,?,?)");
    db.db.exec('BEGIN');for(let i=0;i<150000;i++)insert.run(`upgrade-msg-${i}`,C,`upgrade-ext-${i}`,'INBOUND','text',A,'2026-09-11T00:00:00.000Z');db.db.exec('COMMIT');
    db.db.exec(`DROP TRIGGER workspace_migration_event_insert_guard;
      DROP TRIGGER workspace_authority_migration_guard;
      CREATE TRIGGER workspace_migration_event_insert_guard BEFORE INSERT ON workspace_migration_events BEGIN SELECT 1; END;
      CREATE TRIGGER workspace_authority_migration_guard BEFORE UPDATE ON workspace_authority BEGIN SELECT 1; END;`);db.db.close();
    const prep=new Database(file);prep.exec('DROP INDEX messages_arrival_seq_unique');prep.close();
    const worker=new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{const {register}=await import('tsx/esm/api');register();parentPort.postMessage('ready');await new Promise(resolve=>parentPort.once('message',resolve));const {V1Database}=await import(workerData.module);const db=new V1Database(workerData.file);db.db.close();parentPort.postMessage('opened')})().catch(error=>parentPort.postMessage({error:String(error)}));
    `,{eval:true,workerData:{file,module:pathToFileURL(join(process.cwd(),'src/database.ts')).href}});
    await new Promise((resolve,reject)=>{worker.once('message',message=>message==='ready'?resolve(message):reject(Error(String(message))));worker.once('error',reject)});
    worker.postMessage('upgrade');
    const contender=new Database(file);contender.pragma('busy_timeout = 0');let busySeen=false;
    const until=Date.now()+5000;
    while(Date.now()<until&&!busySeen){try{contender.exec('BEGIN IMMEDIATE');contender.exec('ROLLBACK')}catch(error){if(/SQLITE_BUSY|database is locked/i.test(String(error)))busySeen=true;else throw error}}
    assert.equal(busySeen,true,'contender must observe the upgrader BEGIN IMMEDIATE lock');contender.close();
    const opened=await new Promise<any>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});assert.equal(opened,'opened');
    const upgraded=new Database(file);const sql=String((upgraded.prepare("SELECT sql FROM sqlite_master WHERE name='workspace_authority_migration_guard'").get() as any).sql);assert.match(sql,/v2_workspace_migration_action\(\)/);assert.match(sql,/v2_workspace_migration_owner\(\)/);assert.equal((upgraded.prepare("SELECT quarantine_reason FROM workspace_authority LIMIT 1").get() as any).quarantine_reason,null);upgraded.close();await worker.terminate();
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test('V2-MIG-001 rollback fails closed when the canonical source sender is null',()=>{
  const x=setup();
  x.db.db.prepare("INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)").run('legacy-original',U,'pending_order',C,JSON.stringify({customerId:U,accountId:A,sourceMessageId:'mig-msg',senderExternalId:'+6591110001',requestedDeliveryDate:'2026-09-20',lines:[{query:'ayam',quantity:2,uom:'CTN'}]}),1,'mig-msg',new Date().toISOString());
  const shadow=x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'rollback-null-shadow',approval:x.migrationApproval});
  x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,expectedWorkItemId:shadow.workItemId,expectedDraftRevision:shadow.draftRevision,idempotencyKey:'rollback-null-canary',approval:x.v1Approval});
  x.db.db.prepare("UPDATE messages SET sender_external_id=NULL WHERE id='mig-msg'").run();
  const before=x.db.db.prepare("SELECT id,value_json FROM customer_order_memory WHERE customer_id=? AND memory_type='pending_order' AND key_text=?").get(U,C) as any;
  assert.throws(()=>x.migration.rollback({accountId:A,conversationId:C,customerId:U,idempotencyKey:'rollback-null-sender',approval:x.rollbackApproval}),/ROLLBACK_SOURCE_SENDER_IDENTITY_REQUIRED/);
  assert.equal(x.migration.getAuthority(A,C).migration_state,'V2_CANARY');
  assert.deepEqual(x.db.db.prepare("SELECT id,value_json FROM customer_order_memory WHERE customer_id=? AND memory_type='pending_order' AND key_text=?").get(U,C),before);
  assert.doesNotMatch(String(before.value_json),/"senderExternalId":null/);
});

test('V2-MIG-001 rollback rejects malformed canonical source identities before legacy replacement',()=>{
  for(const [label,column,value,code] of [
    ['sender whitespace','sender_external_id','   ','ROLLBACK_SOURCE_SENDER_IDENTITY_REQUIRED'],
    ['source whitespace','external_message_id','\t\n','ROLLBACK_SOURCE_MESSAGE_IDENTITY_REQUIRED'],
    ['sender oversize','sender_external_id','s'.repeat(513),'ROLLBACK_SOURCE_SENDER_IDENTITY_REQUIRED'],
    ['source oversize','external_message_id','m'.repeat(513),'ROLLBACK_SOURCE_MESSAGE_IDENTITY_REQUIRED'],
  ] as const){
    const x=setup();x.db.db.prepare("INSERT INTO customer_order_memory VALUES(?,?,?,?,?,?,?,?)").run('legacy-original',U,'pending_order',C,JSON.stringify({customerId:U,accountId:A,sourceMessageId:'mig-msg',senderExternalId:'+6591110001',requestedDeliveryDate:'2026-09-20',lines:[{query:'ayam',quantity:2,uom:'CTN'}]}),1,'mig-msg',new Date().toISOString());
    const shadow=x.migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:`rollback-invalid-${label}-shadow`,approval:x.migrationApproval});
    x.migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:shadow.sourceHash!,expectedWorkItemId:shadow.workItemId,expectedDraftRevision:shadow.draftRevision,idempotencyKey:`rollback-invalid-${label}-canary`,approval:x.v1Approval});
    x.db.db.prepare(`UPDATE messages SET ${column}=? WHERE id='mig-msg'`).run(value);
    const before=x.db.db.prepare("SELECT id,value_json FROM customer_order_memory WHERE customer_id=? AND memory_type='pending_order' AND key_text=?").get(U,C),events=x.db.db.prepare('SELECT count(*) n FROM workspace_migration_events').get() as {n:number};
    assert.throws(()=>x.migration.rollback({accountId:A,conversationId:C,customerId:U,idempotencyKey:`rollback-invalid-${label}`,approval:x.rollbackApproval}),new RegExp(code));
    assert.deepEqual(x.db.db.prepare("SELECT id,value_json FROM customer_order_memory WHERE customer_id=? AND memory_type='pending_order' AND key_text=?").get(U,C),before);assert.equal((x.db.db.prepare('SELECT count(*) n FROM workspace_migration_events').get() as {n:number}).n,events.n);assert.equal(x.migration.getAuthority(A,C).migration_state,'V2_CANARY');
  }
});
