import test from 'node:test';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {createMigrationApprovalAuthority} from '../src/migration-auth.js';
import {createRolloutApprovalAuthority} from '../src/rollout-auth.js';
import {WorkspaceMigrationService} from '../src/v2-workspace-migration.js';
import {canonicalSha256} from '../src/v2-canonical.js';
import {V2RolloutService} from '../src/v2-rollout.js';

test('migration approval descriptors reject cross-account and cross-intent replay',()=>{
  const authority=createMigrationApprovalAuthority();
  const token=authority.issue('owner','MIGRATION_OWNER','SHADOW_IMPORT',{accountId:'a',conversationId:'c',customerId:'u',expectedState:'V1_ONLY',expectedHash:'h',expectedRevision:3,expectedWorkItemId:null,expectedDraftRevision:null,compatibilityConfirmed:null});
  const descriptor={accountId:'a',conversationId:'c',customerId:'u',expectedState:'V1_ONLY',expectedHash:'h',expectedRevision:3,expectedWorkItemId:null,expectedDraftRevision:null,compatibilityConfirmed:null};
  assert.ok(authority.verify(token,'SHADOW_IMPORT','MIGRATION_OWNER',descriptor));
  assert.equal(authority.verify(token,'SHADOW_IMPORT','MIGRATION_OWNER',{...descriptor,accountId:'b'}),undefined);
  assert.equal(authority.verify(token,'PROMOTE_PRIMARY','MIGRATION_OWNER',descriptor),undefined);
});

test('migration approval issuance rejects partial bindings and verification rejects every intent field mismatch',()=>{
  const authority=createMigrationApprovalAuthority();
  assert.throws(()=>authority.issue('owner','MIGRATION_OWNER','SHADOW_IMPORT',{accountId:'a',conversationId:'c',customerId:'u',expectedState:'V1_ONLY',expectedHash:'h',expectedRevision:1} as any),/MIGRATION_APPROVAL_DESCRIPTOR_REQUIRED/);
  const binding={accountId:'a',conversationId:'c',customerId:'u',expectedState:'V1_ONLY',expectedHash:'h',expectedRevision:1,expectedWorkItemId:'w',expectedDraftRevision:2,compatibilityConfirmed:true};
  const token=authority.issue('owner','MIGRATION_OWNER','PROMOTE_CANARY',binding);
  for(const key of Object.keys(binding) as (keyof typeof binding)[]){const altered={...binding,[key]:key==='expectedRevision'?99:key==='expectedDraftRevision'?3:key==='compatibilityConfirmed'?false:key==='expectedWorkItemId'?'other':key==='expectedHash'?'other-h':key==='expectedState'?'V2_PRIMARY':key==='customerId'?'other-u':key==='conversationId'?'other-c':'other-a'};assert.equal(authority.verify(token,'PROMOTE_CANARY','V1_OWNER',altered as any),undefined);}
});

test('rollout mutation is serialized and idempotent under the immediate write fence',()=>{
  const migration=createMigrationApprovalAuthority(),rolloutAuth=createRolloutApprovalAuthority();
  const db=new V1Database(':memory:',migration,rolloutAuth);db.resetAndSeed();
  const rollout=new V2RolloutService(db,rolloutAuth);
  const approval=rolloutAuth.issue('staff',{action:'ENABLE',capability:'order_validation',accountId:'demo-account',conversationId:null,enabled:true});
  const first=rollout.configure({capability:'order_validation',enabled:true,accountId:'demo-account',idempotencyKey:'same',approval});
  const replay=rollout.configure({capability:'order_validation',enabled:true,accountId:'demo-account',idempotencyKey:'same',approval});
  assert.deepEqual(replay,first);
  assert.equal((db.db.prepare('SELECT revision FROM v2_capability_rollouts WHERE capability=? AND account_id=?').get('order_validation','demo-account') as {revision:number}).revision,0);
  assert.equal((db.db.prepare('SELECT count(*) n FROM v2_rollout_events WHERE idempotency_key=?').get('same') as {n:number}).n,1);
});

test('migration database fence rejects a descriptor that became stale before the write transaction',()=>{
  const authority=createMigrationApprovalAuthority(),db=new V1Database(':memory:',authority);db.resetAndSeed();
  const migration=new WorkspaceMigrationService(db,authority);
  const scope={accountId:'demo-account',conversationId:'conv-001',customerId:'CUST-001'};
  const stale=authority.issue('owner','MIGRATION_OWNER','SHADOW_IMPORT',{...scope,expectedState:'V1_ONLY',expectedHash:'ignored-by-db-fence',expectedRevision:0,expectedWorkItemId:null,expectedDraftRevision:null,compatibilityConfirmed:null});
  const live=authority.issue('owner','MIGRATION_OWNER','SHADOW_IMPORT',{...scope,expectedState:'V1_ONLY',expectedHash:canonicalSha256(null),expectedRevision:0,expectedWorkItemId:null,expectedDraftRevision:null,compatibilityConfirmed:null});
  migration.shadowImport({...scope,idempotencyKey:'advance-state',approval:live});
  assert.throws(()=>db.runWorkspaceMigration(()=>true,stale,'SHADOW_IMPORT','MIGRATION_OWNER',scope),/MIGRATION_APPROVAL_STALE/);
});
