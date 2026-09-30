import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { projectUiState } from '../src/v2-ui-state.js';
import { WorkspaceMigrationService } from '../src/v2-workspace-migration.js';
import { canonicalSha256 } from '../src/v2-canonical.js';
import { AgentTurnCoordinator } from '../src/v2-agent-turn-coordinator.js';
import { createMigrationApprovalAuthority } from '../src/migration-auth.js';
import { issueBoundMigrationApproval } from './migration-approval-helper.js';

const A='demo-account', C='conv-001', U='CUST-001';
function fixture(authority?:ReturnType<typeof createMigrationApprovalAuthority>){ const d=new V1Database(':memory:',authority); d.resetAndSeed(); return d; }
function inbound(d:V1Database,id='ui002-in'){ d.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(id,C,id,'INBOUND','text','safe customer message',A,'2026-09-11T00:00:00Z'); }

test('UI-002 V1 fallback keeps canonical commerce and staff boundary',()=>{
  const d=fixture(); const state=projectUiState(d.db,A,C);
  assert.equal(state.authority.migrationState,'V1_ONLY'); assert.equal(state.workspace.workItem,null); assert.equal(state.budget,null);
  assert.equal(state.canonical.authoritative,true); assert.deepEqual(state.boundary.staffOnly,['POST SALES ORDER','CONFIRM SALES ORDER','DO progression']);
});

test('UI-002 canary projects workspace, current/historical evidence, budget and bounded handoff',()=>{
  const authority=createMigrationApprovalAuthority(); const d=fixture(authority); inbound(d); const migration=new WorkspaceMigrationService(d,authority);
  migration.shadowImport({accountId:A,conversationId:C,customerId:U,idempotencyKey:'ui002-shadow',approval:issueBoundMigrationApproval(authority,migration,'ui-test','MIGRATION_OWNER','SHADOW_IMPORT',{accountId:A,conversationId:C,customerId:U})});
  migration.promoteCanary({accountId:A,conversationId:C,customerId:U,expectedLegacySourceHash:canonicalSha256(null),idempotencyKey:'ui002-promote',approval:issueBoundMigrationApproval(authority,migration,'ui-test','V1_OWNER','PROMOTE_CANARY',{accountId:A,conversationId:C,customerId:U},{expectedHash:canonicalSha256(null),expectedWorkItemId:null,expectedDraftRevision:null})});
  d.db.prepare("INSERT INTO work_items VALUES('ui002-wi',?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(A,C,U,'SALES_ORDER_REQUEST','DRAFTING',4,'safe goal','ui002-draft',null,null,null,'m1','2026-09-11','2026-09-11');
  d.db.prepare("INSERT INTO order_drafts VALUES('ui002-draft','ui002-wi',?,?,?,'CURRENT',2,NULL,'SG-MAIN','SGD','m1','2026-09-11','2026-09-11')").run(A,C,U);
  d.insertV2ErpEvidence({id:'ui002-ev',evidenceType:'stock',toolCallId:'private-tool',lookupKey:'private-lookup',inputJson:'{"token":"secret"}',outputJson:'{"password":"secret"}',observedAt:'2026-09-11',sourceVersion:'erp-v2'});
  d.insertV2OrderValidation({id:'ui002-val',draftId:'ui002-draft',draftRevision:1,mode:'DRAFT',status:'SUCCEEDED',resultJson:'{"secret":"hidden"}',evidenceRefsJson:'["ui002-ev"]',createdAt:'2026-09-11'});
  const turn=new AgentTurnCoordinator(d).start({accountId:A,conversationId:C,inboundMessageId:'ui002-in',profileId:'sales-digital-employee',nowIso:'2026-09-11T00:00:01Z',timezone:'UTC'});
  const state=projectUiState(d.db,A,C);
  assert.equal(state.authority.workspaceWriter,'V2'); assert.equal(state.workspace.workItem?.revision,4); assert.equal(state.workspace.draft?.validation,'HISTORICAL');
  assert.equal(state.evidence?.evidence[0].id,'ui002-ev'); assert.equal(state.budget?.usage.modelAttempts,0); assert.equal(state.budget?.limits.maxModelTurns,8);
  assert.equal(state.handoff.active,false); assert.equal(turn.status,'AWAITING_DECISION');
  const historicalJson=JSON.stringify(state); for(const secret of ['private-tool','private-lookup','password','hidden']) assert.equal(historicalJson.includes(secret),false,secret);

  d.insertV2OrderValidation({id:'ui002-val-current',draftId:'ui002-draft',draftRevision:2,mode:'DRAFT',status:'SUCCEEDED',resultJson:'{\"secret\":\"still-hidden\"}',evidenceRefsJson:'[\"ui002-ev\"]',createdAt:'2026-09-11T00:00:02Z'});
  const current=projectUiState(d.db,A,C); assert.equal(current.workspace.draft?.validation,'CURRENT'); assert.equal(current.evidence?.status,'SUCCEEDED');
  d.db.prepare("UPDATE work_items SET state='HANDED_OFF',revision=5,blocking_reason='STAFF_REVIEW' WHERE id='ui002-wi'").run();
  const handed=projectUiState(d.db,A,C); assert.equal(handed.handoff.active,true); assert.equal(handed.handoff.reasonCode,'STAFF_REVIEW');
});

test('UI-002 projection stays read-only and fails closed for corrupt budget provenance',()=>{
  const d=fixture(); inbound(d,'ui002-readonly'); const coordinator=new AgentTurnCoordinator(d);
  const turn=coordinator.start({accountId:A,conversationId:C,inboundMessageId:'ui002-readonly',profileId:'sales-digital-employee',nowIso:'2026-09-11T00:00:01Z',timezone:'UTC'});
  assert.doesNotThrow(()=>projectUiState(d.db,A,C));
  assert.throws(()=>d.db.prepare("INSERT INTO agent_actions(id,turn_id,sequence,capability_name,capability_version,arguments_json,arguments_hash,created_at) VALUES('forged-ui',?,1,'lookup_customer','v1','{}','x','now')").run(turn.turnId),/AGENT_ACTION_INSERT_REQUIRES_COORDINATOR/);
  d.db.prepare('PRAGMA ignore_check_constraints=ON').run();
  assert.throws(()=>d.db.prepare("UPDATE agent_turns SET budget_provenance_json='{}' WHERE id=?").run(turn.turnId),/IMMUTABLE_AGENT_TURN_IDENTITY|IMMUTABLE_AGENT_TURN/);
  assert.equal(projectUiState(d.db,A,C).budget?.limits.maxModelTurns,8);
});
