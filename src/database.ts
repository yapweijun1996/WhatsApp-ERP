import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EmployeeProfileResolver,INITIAL_SALES_PROFILE_SEED,profileAuthorization} from './v2-employee-profile.js';
import {authorizeCapability} from './v2-capability-authorization.js';
import {canonicalJson,canonicalSha256} from './v2-canonical.js';
import {authoritativeFreshnessFingerprint} from './v2-freshness.js';
import {validateInboundBundle} from './v3-inbound-bundle.js';
import {validateContextSnapshot} from './v3-context-snapshot.js';
import {isCurrentReasoningLease,projectReasoningLease} from './v3-reasoning-lease.js';
import {buildV3FreshnessVectorFromDatabase,validateV3FreshnessVector} from './v3-freshness-vector.js';
import {type MigrationApprovalAuthority,type MigrationApproval,type MigrationAction,type MigrationOwner,type VerifiedMigrationApproval} from './migration-auth.js';
import {type RolloutApproval,type RolloutApprovalAuthority} from './rollout-auth.js';

export class V1Database{
  readonly db:Database.Database;
  #workspaceMigrationDepth=0;
  #workspaceMigrationApproval?:VerifiedMigrationApproval;
  #workspaceMigrationScope?: {accountId:string;conversationId:string;customerId:string};
  readonly #migrationApprovalAuthority?:MigrationApprovalAuthority;
  readonly #rolloutApprovalAuthority?:RolloutApprovalAuthority;
  #workspaceAuthorityInitDepth=0;
  #workspaceResetDepth=0;
  #agentTurnMigrationDepth=0;
  #v2ValidationWriteDepth=0;
  #provenanceWriteDepth=0;
  #commerceSealWriteDepth=0;
  #queueMutationDepth=0;
  #outboundMutationDepth=0;
  #rolloutMutationDepth=0;
  #rolloutMutationContext?: {capability:string;accountId:string|null;conversationId:string|null;enabled:number;action:string;subject:string};
  #v3WakeMutationDepth=0;
  #v3WakeMutationContext?: Record<string, unknown>;
  constructor(filename='order-intelligence.db',migrationApprovalAuthority?:MigrationApprovalAuthority,rolloutApprovalAuthority?:RolloutApprovalAuthority,readonly demoDataset: 'default'|'petshop' = process.env.DEMO_DATASET === 'petshop' ? 'petshop' : 'default'){
    this.#migrationApprovalAuthority=migrationApprovalAuthority;
    this.#rolloutApprovalAuthority=rolloutApprovalAuthority;
    this.db=new Database(filename);
    this.db.pragma('busy_timeout = 5000');
    this.db.function('v2_workspace_migration_authorized',()=>this.#workspaceMigrationDepth>0?1:0);
    this.db.function('v2_workspace_migration_action',()=>this.#workspaceMigrationApproval?.action??null);
    this.db.function('v2_workspace_migration_owner',()=>this.#workspaceMigrationApproval?.owner??null);
    this.db.function('v2_workspace_migration_subject',()=>this.#workspaceMigrationApproval?.subject??null);
    this.db.function('v2_workspace_migration_account',()=>this.#workspaceMigrationScope?.accountId??null);
    this.db.function('v2_workspace_migration_conversation',()=>this.#workspaceMigrationScope?.conversationId??null);
    this.db.function('v2_workspace_migration_customer',()=>this.#workspaceMigrationScope?.customerId??null);
    this.db.function('v2_workspace_migration_expected_state',()=>this.#workspaceMigrationApproval?.descriptor.expectedState??null);
    this.db.function('v2_workspace_migration_expected_hash',()=>this.#workspaceMigrationApproval?.descriptor.expectedHash??null);
    this.db.function('v2_workspace_migration_expected_revision',()=>this.#workspaceMigrationApproval?.descriptor.expectedRevision??null);
    this.db.function('v2_workspace_migration_expected_work_item',()=>this.#workspaceMigrationApproval?.descriptor.expectedWorkItemId??null);
    this.db.function('v2_workspace_authority_init_authorized',()=>this.#workspaceAuthorityInitDepth>0?1:0);
    this.db.function('v2_workspace_reset_authorized',()=>this.#workspaceResetDepth>0?1:0);
    this.db.function('v2_agent_turn_mutation_authorized',()=>this.#agentTurnMigrationDepth>0?1:0);
    this.db.function('v2_response_grounding_mutation_authorized',()=>0);
    this.db.function('v2_validation_write_authorized',()=>this.#v2ValidationWriteDepth>0?1:0);
    this.db.function('v2_provenance_write_authorized',()=>this.#provenanceWriteDepth>0?1:0);
    this.db.function('v2_commerce_seal_write_authorized',()=>this.#commerceSealWriteDepth>0?1:0);
    this.db.function('v2_queue_mutation_authorized',()=>this.#queueMutationDepth>0?1:0);
    this.db.function('v2_outbound_mutation_authorized',()=>this.#outboundMutationDepth>0?1:0);
    this.db.function('v2_rollout_mutation_authorized',()=>this.#rolloutMutationDepth>0?1:0);
    this.db.function('v2_rollout_mutation_capability',()=>this.#rolloutMutationContext?.capability??null);
    this.db.function('v2_rollout_mutation_account',()=>this.#rolloutMutationContext?.accountId??null);
    this.db.function('v2_rollout_mutation_conversation',()=>this.#rolloutMutationContext?.conversationId??null);
    this.db.function('v2_rollout_mutation_enabled',()=>this.#rolloutMutationContext?.enabled??null);
    this.db.function('v2_rollout_mutation_action',()=>this.#rolloutMutationContext?.action??null);
    this.db.function('v2_rollout_mutation_subject',()=>this.#rolloutMutationContext?.subject??null);
    this.db.function('v3_wake_mutation_authorized',()=>this.#v3WakeMutationDepth>0?1:0);
    for(const [name,key] of Object.entries({event_id:'wake_event_id',account:'account_id',conversation:'conversation_id',continuation:'continuation_id',id:'wake_id',wake_event:'wake_event_id',event_type:'event_type',attempt:'attempt_number',owner:'lease_owner',generation:'lease_generation',payload:'payload_json',hash:'event_hash',created:'created_at'})) this.db.function(`v3_wake_${name}`,()=>this.#v3WakeMutationContext?.[key]??null);
    this.#retryStartup(() => {
      this.db.pragma('journal_mode = WAL');
      const schemaSql=readFileSync(join(fileURLToPath(new URL('.',import.meta.url)),'../schema.sql'),'utf8');
      // The schema/approval-column migration and replacement of same-name
      // migration triggers must be one writer-locked unit. This also covers
      // a first open without introducing a nested transaction.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Add additive identity fields before schema.sql creates guarded indexes.
        try { this.db.exec('ALTER TABLE messages ADD COLUMN arrival_seq INTEGER'); } catch (error) { if (!String(error).includes('no such table') && !String(error).includes('duplicate column name')) throw error; }
        try { this.db.exec('ALTER TABLE messages ADD COLUMN forwarding_json TEXT'); } catch (error) { if (!String(error).includes('no such table') && !String(error).includes('duplicate column name')) throw error; }
        try { this.db.exec('ALTER TABLE workspace_migration_events ADD COLUMN approval_subject TEXT'); } catch (error) { if (!String(error).includes('no such table') && !String(error).includes('duplicate column name')) throw error; }
        try { this.db.exec('ALTER TABLE workspace_migration_events ADD COLUMN approval_action TEXT'); } catch (error) { if (!String(error).includes('no such table') && !String(error).includes('duplicate column name')) throw error; }
        try { this.db.exec('ALTER TABLE workspace_authority ADD COLUMN revision INTEGER NOT NULL DEFAULT 0'); } catch (error) { if (!String(error).includes('no such table') && !String(error).includes('duplicate column name')) throw error; }
        try { this.db.exec('ALTER TABLE v2_capability_rollouts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0'); } catch (error) { if (!String(error).includes('no such table') && !String(error).includes('duplicate column name')) throw error; }
        try { this.db.exec('ALTER TABLE v3_continuation_wake_events ADD COLUMN wake_event_id TEXT'); } catch (error) { if (!String(error).includes('no such table') && !String(error).includes('duplicate column name')) throw error; }
        try { this.db.exec('UPDATE v3_continuation_wake_events SET wake_event_id=wake_id WHERE wake_event_id IS NULL'); } catch (error) { if (!String(error).includes('no such table')) throw error; }
        for (const table of ['conversation_goal_events','conversation_goal_edges']) { try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`); } catch (error) { if (!String(error).includes('no such table') && !String(error).includes('duplicate column name')) throw error; } }
        try { this.db.exec("ALTER TABLE conversation_goal_edges ADD COLUMN edge_event_type TEXT NOT NULL DEFAULT 'ADDED'"); } catch (error) { if (!String(error).includes('no such table') && !String(error).includes('duplicate column name')) throw error; }
        this.db.exec(schemaSql);
        this.#migrateV3GoalRevisions();
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS conversation_goal_events_revision_uq ON conversation_goal_events(account_id,conversation_id,revision)');
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS conversation_goal_edges_revision_uq ON conversation_goal_edges(account_id,conversation_id,revision)');
        this.#refreshWorkspaceMigrationTriggers(schemaSql);
        this.#refreshLegacyPendingOrderTriggers(schemaSql);
        this.#refreshRolloutTriggers(schemaSql);
        this.db.exec('COMMIT');
      } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
      try { this.db.exec('ALTER TABLE v2_inbox_items ADD COLUMN agent_turn_id TEXT REFERENCES agent_turns(id)'); } catch (error) { if (!String(error).includes('duplicate column name')) throw error; }
      for (const column of [
        'ALTER TABLE v2_conversation_inbox ADD COLUMN lease_item_id TEXT',
        'ALTER TABLE v2_conversation_inbox ADD COLUMN lease_arrival_seq INTEGER',
        'ALTER TABLE v2_conversation_inbox ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0',
      ]) { try { this.db.exec(column); } catch (error) { if (!String(error).includes('duplicate column name')) throw error; } }
      for (const column of [
        "ALTER TABLE agent_model_attempts ADD COLUMN observation_hash TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE agent_model_attempts ADD COLUMN projection_hash TEXT NOT NULL DEFAULT ''",
      ]) { try { this.db.exec(column); } catch (error) { if (!String(error).includes('duplicate column name')) throw error; } }
      for (const column of [
        "ALTER TABLE agent_turns ADD COLUMN budget_provenance_json TEXT NOT NULL DEFAULT '{}'",
        'ALTER TABLE agent_turns ADD COLUMN runtime_started_at TEXT',
        'ALTER TABLE agent_turns ADD COLUMN runtime_deadline_at TEXT',
      ]) { try { this.db.exec(column); } catch (error) { if (!String(error).includes('duplicate column name')) throw error; } }
      this.ensureInitialEmployeeProfile();
      this.#installAgentTurnIdentityMigration();
    });
  }

  #retryStartup(operation:()=>void){
    for(let attempt=0;attempt<50;attempt++){
      try{return operation()}
      catch(error){
        const code=(error as {code?:unknown})?.code, message=String(error);
        if(code!=='SQLITE_BUSY'&&code!=='SQLITE_LOCKED'&&!/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(message))throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
    }
    throw Error('V1_DATABASE_STARTUP_RETRY_EXHAUSTED');
  }

  #refreshWorkspaceMigrationTriggers(schemaSql:string){
    const names=['workspace_migration_event_insert_guard','workspace_authority_migration_guard'] as const;
    const triggerSql=(name:string)=>{
      const marker=`CREATE TRIGGER IF NOT EXISTS ${name}`,start=schemaSql.indexOf(marker);
      if(start<0)throw Error(`WORKSPACE_MIGRATION_TRIGGER_SOURCE_MISSING:${name}`);
      const end=schemaSql.indexOf('\nEND;',start);
      if(end<0)throw Error(`WORKSPACE_MIGRATION_TRIGGER_SOURCE_INVALID:${name}`);
      return schemaSql.slice(start,end+5);
    };
    for(const name of names)this.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    for(const name of names)this.db.exec(triggerSql(name));
  }

  #refreshLegacyPendingOrderTriggers(schemaSql:string){
    const names=['customer_order_memory_pending_retired_insert_guard','customer_order_memory_pending_retired_update_guard','customer_order_memory_pending_cleanup_delete_guard'] as const;
    for(const name of names){
      const marker=`CREATE TRIGGER IF NOT EXISTS ${name}`,start=schemaSql.indexOf(marker);
      if(start<0)throw Error(`LEGACY_PENDING_TRIGGER_SOURCE_MISSING:${name}`);
      const end=schemaSql.indexOf('END;',start);
      if(end<0)throw Error(`LEGACY_PENDING_TRIGGER_SOURCE_INVALID:${name}`);
      this.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      this.db.exec(schemaSql.slice(start,end+5));
    }
  }

  #refreshRolloutTriggers(schemaSql:string){
    const names=['v2_capability_rollouts_insert_guard','v2_capability_rollouts_update_guard','v2_rollout_events_insert_guard','v2_capability_rollouts_context_guard','v2_capability_rollouts_update_context_guard','v2_rollout_events_context_guard','v2_capability_rollouts_conversation_account_insert','v2_capability_rollouts_conversation_account_update','v2_rollout_events_conversation_account_guard'] as const;
    for(const name of names){
      const marker=`CREATE TRIGGER IF NOT EXISTS ${name}`,start=schemaSql.indexOf(marker);
      if(start<0)throw Error(`ROLLOUT_TRIGGER_SOURCE_MISSING:${name}`);
      const end=schemaSql.indexOf('END;',start);
      if(end<0)throw Error(`ROLLOUT_TRIGGER_SOURCE_INVALID:${name}`);
      this.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      this.db.exec(schemaSql.slice(start,end+5));
    }
  }

  #installAgentTurnIdentityMigration(){
    for(let attempt=0;attempt<50;attempt++){
      try{
        this.db.exec('BEGIN IMMEDIATE');
        try{
          this.db.exec('DROP TRIGGER IF EXISTS agent_turns_identity_immutable');
          this.#backfillLegacyAgentTurnBudgets();
          this.db.exec(`CREATE TRIGGER agent_turns_identity_immutable BEFORE UPDATE ON agent_turns WHEN NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.conversation_id<>OLD.conversation_id OR NEW.inbound_message_id<>OLD.inbound_message_id OR NEW.profile_id<>OLD.profile_id OR NEW.profile_version<>OLD.profile_version OR NEW.timezone<>OLD.timezone OR NEW.context_fingerprint<>OLD.context_fingerprint OR NEW.context_snapshot_json<>OLD.context_snapshot_json OR NEW.context_provenance_json<>OLD.context_provenance_json OR NEW.budget_provenance_json<>OLD.budget_provenance_json OR NEW.runtime_started_at IS NOT OLD.runtime_started_at OR NEW.runtime_deadline_at IS NOT OLD.runtime_deadline_at BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_TURN_IDENTITY'); END;`);
          this.db.exec('COMMIT');
          return;
        }catch(error){try{this.db.exec('ROLLBACK')}catch{};throw error}
      }catch(error){
        const code=(error as {code?:unknown})?.code, message=String(error);
        if(code!=='SQLITE_BUSY'&&code!=='SQLITE_LOCKED'&&!/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(message))throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
    }
    throw Error('V1_AGENT_TURN_MIGRATION_RETRY_EXHAUSTED');
  }

  #backfillLegacyAgentTurnBudgets(){
    const rows=this.db.prepare("SELECT id,profile_id,profile_version,created_at FROM agent_turns WHERE budget_provenance_json='{}' OR runtime_started_at IS NULL OR runtime_deadline_at IS NULL").all() as Array<{id:string;profile_id:string;profile_version:number;created_at:string}>;
    if(rows.length===0)return;
    const strictFallback={maxModelTurns:1,maxCapabilityCalls:1,perCallTimeoutMs:1,turnTimeoutMs:1,maxRepairAttempts:0};
    this.#agentTurnMigrationDepth+=1;
    try{for(const row of rows){
      let turnBudgets=strictFallback;
      try{const profile=new EmployeeProfileResolver(this.db).resolve(row.profile_id);if(profile.version===row.profile_version)turnBudgets={...profile.turnBudgets}}catch{/* unknown legacy profile stays strict/fail-closed */}
      const parsed=Date.parse(row.created_at),startedMs=Number.isFinite(parsed)?parsed:0,startedAt=new Date(startedMs).toISOString(),deadlineAt=new Date(startedMs+turnBudgets.turnTimeoutMs).toISOString();
      this.db.prepare('UPDATE agent_turns SET budget_provenance_json=?,runtime_started_at=?,runtime_deadline_at=? WHERE id=?').run(JSON.stringify(turnBudgets),startedAt,deadlineAt,row.id);
      const actions=this.db.prepare('SELECT sequence,created_at FROM agent_actions WHERE turn_id=? ORDER BY sequence').all(row.id) as Array<{sequence:number;created_at:string}>;
      for(const action of actions)this.db.prepare("INSERT OR IGNORE INTO agent_model_attempts(id,turn_id,sequence,attempt_kind,reason_code,created_at) VALUES(?,?,?,?,?,?)").run(`legacy-model-${row.id}-${action.sequence}`,row.id,action.sequence,'MODEL','PI003_LEGACY_ACTION_LOWER_BOUND',action.created_at);
    }}finally{this.#agentTurnMigrationDepth-=1}
  }

  ensureInitialEmployeeProfile(){const profile=INITIAL_SALES_PROFILE_SEED,t=new Date().toISOString();this.db.prepare('INSERT OR IGNORE INTO employee_profiles(id,version,role,mission,tone,language_policy_json,capability_permissions_json,forbidden_commitments_json,escalation_rules_json,turn_budgets_json,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(profile.id,profile.version,profile.role,profile.mission,profile.tone,JSON.stringify(profile.languagePolicy),JSON.stringify(profile.permissions),JSON.stringify(profile.forbiddenCommitments),JSON.stringify(profile.escalationRules),JSON.stringify(profile.turnBudgets),profile.active?1:0,t,t)}
  ensureSeeded(){this.ensureInitialEmployeeProfile();if(!this.db.prepare('SELECT 1 FROM channel_accounts LIMIT 1').get())this.resetAndSeed()}
  /** Narrow DB capability used only by WorkspaceMigrationService. The opaque approval is checked before SQL authorization opens. */
  runWorkspaceMigration<T>(operation:()=>T,approval:MigrationApproval,action:MigrationAction,owner:MigrationOwner,scope?:{accountId:string;conversationId:string;customerId:string}):T{
    if(!scope)throw Error("MIGRATION_SCOPE_REQUIRED");
    const verified=this.#migrationApprovalAuthority?.verify(approval,action,owner);
    if(!verified)throw Error("MIGRATION_APPROVAL_REQUIRED");
    if(verified.descriptor.accountId!==scope.accountId||verified.descriptor.conversationId!==scope.conversationId||verified.descriptor.customerId!==scope.customerId)throw Error("MIGRATION_SCOPE_CUSTOMER_MISMATCH");
    return this.runImmediate(()=>{
      const canonical=this.db.prepare("SELECT c.customer_id FROM conversations c JOIN customers u ON u.id=c.customer_id WHERE c.id=? AND c.channel_account_id=?").get(scope.conversationId,scope.accountId) as {customer_id:string}|undefined;
      if(!canonical||canonical.customer_id!==scope.customerId)throw Error("MIGRATION_SCOPE_CUSTOMER_MISMATCH");
      const current=this.db.prepare("SELECT migration_state,revision,work_item_id FROM workspace_authority WHERE account_id=? AND conversation_id=? AND work_item_type=\x27SALES_ORDER_REQUEST\x27").get(scope.accountId,scope.conversationId) as {migration_state:string;revision:number;work_item_id:string|null}|undefined;
      if(!current||current.migration_state!==verified.descriptor.expectedState||current.revision!==verified.descriptor.expectedRevision||(current.work_item_id??null)!==(verified.descriptor.expectedWorkItemId??null))throw Error("MIGRATION_APPROVAL_STALE");
      if(action==="PROMOTE_CANARY"){const draft=current.work_item_id?this.db.prepare("SELECT current_revision FROM order_drafts WHERE work_item_id=? AND status=\x27CURRENT\x27").get(current.work_item_id) as {current_revision:number}|undefined:undefined;if((draft?.current_revision??null)!==(verified.descriptor.expectedDraftRevision??null))throw Error("MIGRATION_APPROVAL_STALE");}
      this.#workspaceMigrationDepth+=1;
      const prior=this.#workspaceMigrationApproval,priorScope=this.#workspaceMigrationScope;this.#workspaceMigrationApproval=verified;this.#workspaceMigrationScope=scope;
      try{return operation()}finally{this.#workspaceMigrationApproval=prior;this.#workspaceMigrationScope=priorScope;this.#workspaceMigrationDepth-=1}
    });
  }
  /** Narrow server capability for additive rollout configuration; the DB verifies the opaque capability itself. */
  runRolloutMutation<T>(operation:()=>T,approval:RolloutApproval):T{
    const verified=this.#rolloutApprovalAuthority?.verify(approval);
    if(!verified)throw Error('ROLLOUT_APPROVAL_REQUIRED');
    const mutationContext={capability:verified.capability,accountId:verified.accountId,conversationId:verified.conversationId,enabled:verified.enabled?1:0,action:verified.action,subject:verified.subject};
    this.#rolloutMutationDepth+=1;
    const prior=this.#rolloutMutationContext;this.#rolloutMutationContext=mutationContext;
    try{return this.runImmediate(operation)}finally{this.#rolloutMutationContext=prior;this.#rolloutMutationDepth-=1}
  }
  #queueMutation<T>(operation:()=>T):T{
    this.#queueMutationDepth+=1;
    try{return this.db.transaction(operation)()}finally{this.#queueMutationDepth-=1}
  }
  #queueImmediate<T>(operation:()=>T):T{
    this.#queueMutationDepth+=1;
    try{
      for(let attempt=0;attempt<50;attempt++){
        try{
          this.db.exec('BEGIN IMMEDIATE');
          const result=operation();
          this.db.exec('COMMIT');
          return result;
        }catch(error){
          try{this.db.exec('ROLLBACK')}catch{}
          const code=(error as {code?:unknown})?.code;
          const message=String(error);
          if(code!=='SQLITE_BUSY'&&code!=='SQLITE_LOCKED'&&!/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(message))throw error;
          // Independent SQLite connections may contend briefly. Retry the whole
          // fenced transaction so the caller never sees a raw lock failure.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
        }
      }
      throw Error('V2_QUEUE_RETRY_EXHAUSTED');
    }finally{this.#queueMutationDepth-=1}
  }
  /** Short server-owned write fence for async V2 prepare/commit paths. */
  runImmediate<T>(operation:()=>T):T{
    for(let attempt=0;attempt<50;attempt++){
      try{this.db.exec('BEGIN IMMEDIATE');const result=operation();this.db.exec('COMMIT');return result}
      catch(error){try{this.db.exec('ROLLBACK')}catch{};const code=(error as {code?:unknown})?.code;if(code!=='SQLITE_BUSY'&&code!=='SQLITE_LOCKED'&&!/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(String(error)))throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}
    }
    throw Error('V2_WRITE_RETRY_EXHAUSTED');
  }
  v3WakeReserve(input:{accountId:string;conversationId:string;continuationId:string;wakeId:string;wakeEventId:string;now:string}):{status:'NEW'|'DUPLICATE'|'BUDGET_EXHAUSTED'|'TERMINAL';attempt:number;leaseOwner:string|null;leaseGeneration:number|null}{
    return this.runImmediate(()=>{
      const base={accountId:input.accountId,conversationId:input.conversationId,continuationId:input.continuationId,wakeId:input.wakeId,wakeEventId:input.wakeEventId};
      const continuation=this.db.prepare('SELECT record_json FROM durable_continuations WHERE continuation_id=? AND account_id=? AND conversation_id=?').get(input.continuationId,input.accountId,input.conversationId) as {record_json:string}|undefined;
      if(!continuation) throw Error('V3_WAKE_CONTINUATION_SCOPE');
      const goal=this.db.prepare('SELECT goal_json FROM conversation_goal_events WHERE account_id=? AND conversation_id=? AND goal_id=(SELECT goal_id FROM durable_continuations WHERE continuation_id=?) ORDER BY revision DESC LIMIT 1').get(input.accountId,input.conversationId,input.continuationId) as {goal_json:string}|undefined;
      if(!goal) throw Error('V3_WAKE_GOAL_MISSING');
      let goalStatus:string;let maxAttempts:number;
      try { goalStatus=String((JSON.parse(goal.goal_json) as {status:string}).status); maxAttempts=Number((JSON.parse(continuation.record_json) as {budgetState:{maxAttempts:number}}).budgetState.maxAttempts); } catch { throw Error('V3_WAKE_INTEGRITY'); }
      if(['FULFILLED','SUPERSEDED','CANCELLED'].includes(goalStatus)) return {status:'TERMINAL',attempt:0,leaseOwner:null,leaseGeneration:null};
      const prior=this.db.prepare("SELECT attempt_number FROM v3_continuation_wake_events WHERE account_id=? AND conversation_id=? AND continuation_id=? AND wake_id=? AND event_type='ATTEMPT_RESERVED'").get(input.accountId,input.conversationId,input.continuationId,input.wakeId) as {attempt_number:number}|undefined;
      if(prior){const bound=this.db.prepare("SELECT lease_owner,lease_generation FROM v3_continuation_wake_events WHERE account_id=? AND conversation_id=? AND continuation_id=? AND wake_id=? AND event_type='LEASE_BOUND'").get(input.accountId,input.conversationId,input.continuationId,input.wakeId) as {lease_owner:string|null;lease_generation:number|null}|undefined;return {status:'DUPLICATE',attempt:Number(prior.attempt_number),leaseOwner:bound?.lease_owner??null,leaseGeneration:bound?.lease_generation??null};}
      const reserved=Number((this.db.prepare("SELECT count(*) AS n FROM v3_continuation_wake_events WHERE account_id=? AND conversation_id=? AND continuation_id=? AND event_type='ATTEMPT_RESERVED'").get(input.accountId,input.conversationId,input.continuationId) as {n:number}).n);
      let baseConsumed:number; try { const parsed=JSON.parse(continuation.record_json) as {attempt:number;budgetState:{consumed:number}}; baseConsumed=Math.max(Number(parsed.attempt),Number(parsed.budgetState.consumed)); } catch { throw Error('V3_WAKE_INTEGRITY'); }
      const attempt=baseConsumed+reserved+1;
      if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||attempt>maxAttempts)return {status:'BUDGET_EXHAUSTED',attempt:baseConsumed+reserved,leaseOwner:null,leaseGeneration:null};
      const row={wake_event_id:input.wakeEventId,account_id:input.accountId,conversation_id:input.conversationId,continuation_id:input.continuationId,wake_id:input.wakeId,event_type:'ATTEMPT_RESERVED',attempt_number:attempt,lease_owner:null,lease_generation:null,payload_json:canonicalJson({attempt,wakeEventId:input.wakeEventId}),event_hash:canonicalSha256({ ...base,attempt}),created_at:input.now};
      this.#v3WakeMutationDepth++;const old=this.#v3WakeMutationContext;this.#v3WakeMutationContext=row;try{this.db.prepare('INSERT INTO v3_continuation_wake_events(wake_event_id,account_id,conversation_id,continuation_id,wake_id,event_type,attempt_number,lease_owner,lease_generation,payload_json,event_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.wake_event_id,row.account_id,row.conversation_id,row.continuation_id,row.wake_id,row.event_type,row.attempt_number,row.lease_owner,row.lease_generation,row.payload_json,row.event_hash,row.created_at)}finally{this.#v3WakeMutationContext=old;this.#v3WakeMutationDepth--}
      return {status:'NEW',attempt,leaseOwner:null,leaseGeneration:null};
    });
  }
  v3WakeBindLease(input:{accountId:string;conversationId:string;continuationId:string;wakeId:string;attempt:number;owner:string;generation:number;now:string;bundle:unknown;context:unknown;freshnessVector:unknown}){
    return this.runImmediate(()=>{
      const exists=this.db.prepare("SELECT 1 FROM v3_continuation_wake_events WHERE account_id=? AND conversation_id=? AND continuation_id=? AND wake_id=? AND event_type='LEASE_BOUND'").get(input.accountId,input.conversationId,input.continuationId,input.wakeId);if(exists)return {status:'BOUND' as const};
      const reserved=this.db.prepare("SELECT attempt_number FROM v3_continuation_wake_events WHERE account_id=? AND conversation_id=? AND continuation_id=? AND wake_id=? AND event_type='ATTEMPT_RESERVED'").get(input.accountId,input.conversationId,input.continuationId,input.wakeId) as {attempt_number:number}|undefined;if(!reserved||Number(reserved.attempt_number)!==input.attempt)return {status:'STALE' as const};
      const continuation=this.db.prepare('SELECT record_json FROM durable_continuations WHERE continuation_id=? AND account_id=? AND conversation_id=?').get(input.continuationId,input.accountId,input.conversationId) as {record_json:string}|undefined;if(!continuation)return {status:'STALE' as const};let goalId:string;try{goalId=String((JSON.parse(continuation.record_json) as {goalId:string}).goalId)}catch{return {status:'STALE' as const}}
      const goal=this.db.prepare('SELECT goal_json FROM conversation_goal_events WHERE account_id=? AND conversation_id=? AND goal_id=? ORDER BY revision DESC LIMIT 1').get(input.accountId,input.conversationId,goalId) as {goal_json:string}|undefined;try{if(!goal||['FULFILLED','SUPERSEDED','CANCELLED'].includes(String((JSON.parse(goal.goal_json) as {status:string}).status)))return {status:'STALE' as const}}catch{return {status:'STALE' as const}}
      let bundle:any,snapshot:any,vector:any;try{bundle=validateInboundBundle(input.bundle);snapshot=validateContextSnapshot(input.context);vector=validateV3FreshnessVector(input.freshnessVector)}catch{return {status:'STALE' as const}}if(bundle.accountId!==input.accountId||bundle.conversationId!==input.conversationId||snapshot.sourceRevisionRefs.accountId!==input.accountId||snapshot.sourceRevisionRefs.conversationId!==input.conversationId)return {status:'STALE' as const};
      let rebuilt:any;try{rebuilt=buildV3FreshnessVectorFromDatabase(this.db,vector.dependencies)}catch{return {status:'STALE' as const}}if(rebuilt.vectorHash!==vector.vectorHash||snapshot.sourceRevisionRefs.freshnessFingerprint!==rebuilt.dependencies.authoritativeV2FreshnessFingerprint)return {status:'STALE' as const};
      const lease=projectReasoningLease(this.db,bundle,snapshot,input.now);if(lease.state!=='ACTIVE'||lease.ownerId!==input.owner||lease.generation!==input.generation||!lease.fencingToken)return {status:'STALE' as const};
      const row={wake_event_id:randomUUID(),account_id:input.accountId,conversation_id:input.conversationId,continuation_id:input.continuationId,wake_id:input.wakeId,event_type:'LEASE_BOUND',attempt_number:input.attempt,lease_owner:input.owner,lease_generation:input.generation,payload_json:canonicalJson({attempt:input.attempt,generation:input.generation,owner:input.owner}),event_hash:canonicalSha256({accountId:input.accountId,conversationId:input.conversationId,continuationId:input.continuationId,wakeId:input.wakeId,attempt:input.attempt,owner:input.owner,generation:input.generation,now:input.now}),created_at:input.now};this.#v3WakeMutationDepth++;const old=this.#v3WakeMutationContext;this.#v3WakeMutationContext=row;try{this.db.prepare('INSERT INTO v3_continuation_wake_events(wake_event_id,account_id,conversation_id,continuation_id,wake_id,event_type,attempt_number,lease_owner,lease_generation,payload_json,event_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.wake_event_id,row.account_id,row.conversation_id,row.continuation_id,row.wake_id,row.event_type,row.attempt_number,row.lease_owner,row.lease_generation,row.payload_json,row.event_hash,row.created_at)}finally{this.#v3WakeMutationContext=old;this.#v3WakeMutationDepth--}return {status:'BOUND' as const};
    });
  }
  #migrateV3GoalRevisions():void {
    const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversation_goal_events','conversation_goal_edges')").all() as Array<{name:string}>;
    if(tables.length<2) return;
    const rows=this.db.prepare("SELECT event_id AS id,account_id,conversation_id,created_at FROM conversation_goal_events UNION ALL SELECT edge_id,account_id,conversation_id,created_at FROM conversation_goal_edges ORDER BY account_id,conversation_id,created_at,id").all() as Array<{id:string;account_id:string;conversation_id:string;created_at:string}>;
    if(rows.some(row=>Number((this.db.prepare('SELECT revision FROM conversation_goal_events WHERE event_id=?').get(row.id) as any)?.revision??(this.db.prepare('SELECT revision FROM conversation_goal_edges WHERE edge_id=?').get(row.id) as any)?.revision??0)>0)) return;
    this.#workspaceResetDepth+=1;
    try { const event=this.db.prepare('UPDATE conversation_goal_events SET revision=? WHERE event_id=?'), edge=this.db.prepare('UPDATE conversation_goal_edges SET revision=? WHERE edge_id=?'); let revision=0, last=''; for(const row of rows){if(`${row.account_id}\0${row.conversation_id}`!==last){revision=0;last=`${row.account_id}\0${row.conversation_id}`} revision+=1; (this.db.prepare('SELECT 1 FROM conversation_goal_events WHERE event_id=?').get(row.id)?event:edge).run(revision,row.id);} } finally { this.#workspaceResetDepth-=1; }
  }
  /** Narrow service fence for creating the exclusive turn outbound owner row. */
  runOutboundMutation<T>(operation:()=>T):T{
    this.#outboundMutationDepth+=1;
    try{return operation()}finally{this.#outboundMutationDepth-=1}
  }
  queueEnqueue(input:{accountId:string;conversationId:string;externalMessageId:string;messageId:string;messageType:string;text:string|null;senderExternalId:string|null;senderPhone:string|null;replyToExternalMessageId:string|null;occurredAt:string;rawRef:string|null;now:string;itemId:string}){
    return this.#queueImmediate(()=>{
      this.db.prepare("INSERT OR IGNORE INTO v2_conversation_inbox(account_id,conversation_id,next_arrival_seq,processed_watermark,updated_at) SELECT ?,?,1,0,? WHERE EXISTS (SELECT 1 FROM conversations WHERE id=? AND channel_account_id=?)").run(input.accountId,input.conversationId,input.now,input.conversationId,input.accountId);
      const state=this.db.prepare('SELECT next_arrival_seq FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?').get(input.accountId,input.conversationId) as {next_arrival_seq:number}|undefined;
      if(!state) throw Error('V2_QUEUE_CONVERSATION_SCOPE');
      const duplicate=this.db.prepare('SELECT id,conversation_id,arrival_seq FROM messages WHERE account_id=? AND external_message_id=?').get(input.accountId,input.externalMessageId) as any;
      if(duplicate){ if(duplicate.conversation_id!==input.conversationId) throw Error('V2_QUEUE_DEDUP_SCOPE'); const existing=this.db.prepare('SELECT * FROM v2_inbox_items WHERE message_id=?').get(duplicate.id); if(existing) return {deduplicated:true,messageId:duplicate.id,arrivalSeq:Number((existing as any).arrival_seq),item:existing}; this.db.prepare('UPDATE messages SET arrival_seq=? WHERE id=? AND arrival_seq IS NULL').run(state.next_arrival_seq,duplicate.id); }
      else this.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,reply_to_external_message_id,account_id,occurred_at,raw_ref,arrival_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(input.messageId,input.conversationId,input.externalMessageId,'INBOUND',input.messageType,input.text,input.senderExternalId,input.senderPhone,input.replyToExternalMessageId,input.accountId,input.occurredAt,input.rawRef,state.next_arrival_seq);
      this.db.prepare('UPDATE v2_conversation_inbox SET next_arrival_seq=next_arrival_seq+1,revision=revision+1,updated_at=? WHERE account_id=? AND conversation_id=?').run(input.now,input.accountId,input.conversationId);
      const messageId=duplicate?.id??input.messageId; this.db.prepare('INSERT INTO v2_inbox_items(id,account_id,conversation_id,message_id,agent_turn_id,arrival_seq,state,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?,?,?)').run(input.itemId,input.accountId,input.conversationId,messageId,state.next_arrival_seq,'QUEUED',input.now,input.now);
      return {deduplicated:false,messageId,arrivalSeq:Number(state.next_arrival_seq),item:this.db.prepare('SELECT * FROM v2_inbox_items WHERE id=?').get(input.itemId)};
    });
  }
  queueReclassifyUnclaimedForV1(scope?:{accountId?:string;conversationId?:string}){return this.#queueImmediate(()=>{const where=['i.state=\'QUEUED\''];const args:any[]=[];if(scope?.accountId){where.push('i.account_id=?');args.push(scope.accountId)}if(scope?.conversationId){where.push('i.conversation_id=?');args.push(scope.conversationId)}const rows=this.db.prepare(`SELECT i.*,m.external_message_id,m.message_type,m.text,m.sender_external_id,m.sender_phone,m.reply_to_external_message_id,m.occurred_at,m.raw_ref FROM v2_inbox_items i JOIN messages m ON m.id=i.message_id WHERE ${where.join(' AND ')} ORDER BY i.arrival_seq`).all(...args) as any[];const replay:any[]=[];for(const row of rows){const reason=row.side_effect_started?'SIDE_EFFECT_STARTED':row.agent_turn_id?'TURN_BOUND_BEFORE_REPLAY':'SAFE_UNCLAIMED_REPLAY';const action=reason==='SAFE_UNCLAIMED_REPLAY'?'RECLASSIFIED_TO_V1':'BLOCKED';this.db.prepare('INSERT OR IGNORE INTO v2_inbox_route_events(id,inbox_item_id,account_id,conversation_id,action,reason,original_provider_message_id,original_external_message_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.id,row.account_id,row.conversation_id,action,reason,row.message_id,row.external_message_id,new Date().toISOString());if(action==='RECLASSIFIED_TO_V1'&&this.db.prepare("UPDATE v2_inbox_items SET state='SUPERSEDED',updated_at=? WHERE id=? AND state='QUEUED' AND side_effect_started=0 AND agent_turn_id IS NULL").run(new Date().toISOString(),row.id).changes===1)replay.push({accountId:row.account_id,conversationId:row.conversation_id,externalMessageId:row.external_message_id,occurredAt:row.occurred_at,type:row.message_type,text:row.text,sender:{externalId:row.sender_external_id,phone:row.sender_phone},replyToExternalMessageId:row.reply_to_external_message_id,media:row.raw_ref?{externalRef:row.raw_ref}:undefined});}return replay;});}
  queueReadReclassificationBlocks(scope?:{accountId?:string;conversationId?:string}){const where=['action=\'BLOCKED\''];const args:any[]=[];if(scope?.accountId){where.push('account_id=?');args.push(scope.accountId)}if(scope?.conversationId){where.push('conversation_id=?');args.push(scope.conversationId)}return this.db.prepare(`SELECT inbox_item_id AS itemId,account_id AS accountId,conversation_id AS conversationId,reason,original_external_message_id AS externalMessageId FROM v2_inbox_route_events WHERE ${where.join(' AND ')} ORDER BY created_at`).all(...args);}
  queueReadProcessingBlocks(scope?:{accountId?:string;conversationId?:string}){const where=["i.state='PROCESSING'"];const args:any[]=[];if(scope?.accountId){where.push('i.account_id=?');args.push(scope.accountId)}if(scope?.conversationId){where.push('i.conversation_id=?');args.push(scope.conversationId)}return this.db.prepare(`SELECT i.id AS itemId,i.account_id AS accountId,i.conversation_id AS conversationId,'PROCESSING_ITEM' AS reason,m.external_message_id AS externalMessageId FROM v2_inbox_items i JOIN messages m ON m.id=i.message_id WHERE ${where.join(' AND ')}`).all(...args);}
  queueBind(input:{accountId:string;conversationId:string;arrivalSeq:number;turnId:string;now:string}){return this.#queueMutation(()=>{const current=this.db.prepare('SELECT * FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND arrival_seq=?').get(input.accountId,input.conversationId,input.arrivalSeq) as any;if(!current)throw Error('V2_QUEUE_ITEM_NOT_FOUND');const turn=this.db.prepare('SELECT id,account_id,conversation_id,inbound_message_id FROM agent_turns WHERE id=?').get(input.turnId) as any;if(!turn)throw Error('V2_QUEUE_TURN_NOT_FOUND');if(turn.account_id!==input.accountId||turn.conversation_id!==input.conversationId||turn.inbound_message_id!==current.message_id)throw Error('V2_QUEUE_TURN_SCOPE');if(current.agent_turn_id&&current.agent_turn_id!==input.turnId)throw Error('V2_QUEUE_TURN_BINDING_CONFLICT');this.db.prepare('UPDATE v2_inbox_items SET agent_turn_id=?,updated_at=? WHERE id=? AND agent_turn_id IS NULL').run(input.turnId,input.now,current.id);return this.db.prepare('SELECT * FROM v2_inbox_items WHERE id=?').get(current.id);});}
  queueClaim(input:{accountId:string;conversationId:string;owner:string;now:string;expires:string;token:string}){return this.#queueMutation(()=>{this.db.prepare("INSERT OR IGNORE INTO v2_conversation_inbox(account_id,conversation_id,next_arrival_seq,processed_watermark,updated_at) SELECT ?,?,1,0,? WHERE EXISTS (SELECT 1 FROM conversations WHERE id=? AND channel_account_id=?)").run(input.accountId,input.conversationId,input.now,input.conversationId,input.accountId);const state=this.db.prepare('SELECT * FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?').get(input.accountId,input.conversationId) as any;if(!state)throw Error('V2_QUEUE_CONVERSATION_SCOPE');const busy=state.lease_owner&&state.lease_expires_at&&Date.parse(state.lease_expires_at)>Date.parse(input.now);if(busy)throw Error('V2_QUEUE_LEASE_BUSY');const candidate=this.db.prepare("SELECT * FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND state IN ('QUEUED','PROCESSING') AND arrival_seq>? ORDER BY arrival_seq LIMIT 1").get(input.accountId,input.conversationId,state.processed_watermark) as any;if(!candidate)return null;const generation=Number(state.lease_generation??0)+1;if(this.db.prepare('UPDATE v2_conversation_inbox SET lease_owner=?,lease_token=?,lease_item_id=?,lease_arrival_seq=?,lease_generation=?,lease_expires_at=?,lease_heartbeat_at=?,revision=revision+1,updated_at=? WHERE account_id=? AND conversation_id=? AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)').run(input.owner,input.token,candidate.id,candidate.arrival_seq,generation,input.expires,input.now,input.now,input.accountId,input.conversationId,input.now).changes!==1)throw Error('V2_QUEUE_LEASE_RACE');if(this.db.prepare("UPDATE v2_inbox_items SET state='PROCESSING',updated_at=? WHERE id=? AND account_id=? AND conversation_id=? AND arrival_seq=? AND state IN ('QUEUED','PROCESSING')").run(input.now,candidate.id,input.accountId,input.conversationId,candidate.arrival_seq).changes!==1)throw Error('V2_QUEUE_CLAIM_RACE');return {row:this.db.prepare('SELECT * FROM v2_inbox_items WHERE id=?').get(candidate.id),generation};});}
  queueHeartbeat(input:{accountId:string;conversationId:string;owner:string;token:string;now:string;expires:string}){return this.#queueMutation(()=>{const state=this.db.prepare('SELECT * FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?').get(input.accountId,input.conversationId) as any;if(!state||state.lease_owner!==input.owner||state.lease_token!==input.token||!state.lease_item_id||state.lease_arrival_seq===null||!state.lease_expires_at||Date.parse(state.lease_expires_at)<=Date.parse(input.now))throw Error('V2_QUEUE_LEASE_EXPIRED');if(this.db.prepare('UPDATE v2_conversation_inbox SET lease_expires_at=?,lease_heartbeat_at=?,revision=revision+1,updated_at=? WHERE account_id=? AND conversation_id=? AND lease_owner=? AND lease_token=? AND lease_item_id=? AND lease_arrival_seq=? AND lease_generation=? AND lease_expires_at>?').run(input.expires,input.now,input.now,input.accountId,input.conversationId,input.owner,input.token,state.lease_item_id,state.lease_arrival_seq,state.lease_generation,input.now).changes!==1)throw Error('V2_QUEUE_LEASE_FENCED');return true;});}
  /** Common locked admission preconditions shared by legacy V2 and CP-004. */
  #queueAuthorizeSideEffectLocked(input:{accountId:string;conversationId:string;arrivalSeq:number;turnId:string;owner:string;token:string;now:string}){
    const current=this.db.prepare('SELECT * FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND arrival_seq=?').get(input.accountId,input.conversationId,input.arrivalSeq) as any;
    if(!current||current.state!=='PROCESSING')throw Error('V2_QUEUE_ITEM_NOT_PROCESSING');
    const lease=this.db.prepare('SELECT * FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?').get(input.accountId,input.conversationId) as any;
    if(!lease||lease.lease_item_id!==current.id||Number(lease.lease_arrival_seq)!==input.arrivalSeq||lease.lease_owner!==input.owner||lease.lease_token!==input.token||!lease.lease_expires_at||Date.parse(lease.lease_expires_at)<=Date.parse(input.now))throw Error('V2_QUEUE_LEASE_FENCED');
    const turn=this.db.prepare('SELECT * FROM agent_turns WHERE id=?').get(input.turnId) as any;
    if(!turn)throw Error('V2_QUEUE_TURN_NOT_FOUND');
    if(turn.account_id!==input.accountId||turn.conversation_id!==input.conversationId||turn.inbound_message_id!==current.message_id)throw Error('V2_QUEUE_TURN_SCOPE');
    if(turn.status==='TERMINAL')throw Error('V2_QUEUE_TURN_NOT_ACTIVE');
    return {current,lease,turn};
  }
  queueAuthorizeSideEffect(input:{accountId:string;conversationId:string;arrivalSeq:number;turnId:string;owner:string;token:string;now:string}){
    return this.#queueImmediate(()=>{
      const {current,lease,turn}=this.#queueAuthorizeSideEffectLocked(input);
      let context:any;try{context=JSON.parse(turn.context_snapshot_json)}catch{throw Error('V2_QUEUE_TURN_CONTEXT_INTEGRITY')}
      if(canonicalJson(context)!==turn.context_snapshot_json||canonicalSha256(context)!==turn.context_fingerprint)throw Error('V2_QUEUE_TURN_CONTEXT_INTEGRITY');
      const profile=this.db.prepare('SELECT id,active FROM employee_profiles WHERE id=?').get(turn.profile_id) as any;
      if(!profile||!profile.active)throw Error('V2_QUEUE_PROFILE_CHANGED');
      if(context.freshness?.fingerprint!==authoritativeFreshnessFingerprint(this.db,input.accountId,input.conversationId,String(profile.id)))throw Error('V2_QUEUE_STALE_CONTEXT');
      const newer=Number((this.db.prepare("SELECT count(*) AS n FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND arrival_seq>? AND state='QUEUED'").get(input.accountId,input.conversationId,input.arrivalSeq) as any)?.n??0)>0;
      if(!current.side_effect_started&&newer){
        if(this.db.prepare("UPDATE v2_inbox_items SET state='SUPERSEDED',updated_at=? WHERE id=? AND account_id=? AND conversation_id=? AND arrival_seq=? AND state='PROCESSING' AND side_effect_started=0").run(input.now,current.id,input.accountId,input.conversationId,input.arrivalSeq).changes!==1)throw Error('V2_QUEUE_LEASE_FENCED');
        if(this.db.prepare('UPDATE v2_conversation_inbox SET processed_watermark=MAX(processed_watermark,?),lease_owner=NULL,lease_token=NULL,lease_item_id=NULL,lease_arrival_seq=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND conversation_id=? AND lease_owner=? AND lease_token=? AND lease_item_id=? AND lease_arrival_seq=? AND lease_generation=? AND lease_expires_at>?').run(input.arrivalSeq,input.now,input.accountId,input.conversationId,input.owner,input.token,current.id,input.arrivalSeq,lease.lease_generation,input.now).changes!==1)throw Error('V2_QUEUE_LEASE_FENCED');
        return {status:'NEWER_INPUT_QUEUED'};
      }
      if(this.db.prepare("UPDATE v2_inbox_items SET side_effect_started=1,agent_turn_id=?,updated_at=? WHERE id=? AND account_id=? AND conversation_id=? AND arrival_seq=? AND state='PROCESSING' AND side_effect_started=0 AND (agent_turn_id IS NULL OR agent_turn_id=?) AND EXISTS (SELECT 1 FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=? AND lease_owner=? AND lease_token=? AND lease_item_id=? AND lease_arrival_seq=? AND lease_generation=? AND lease_expires_at>?)").run(input.turnId,input.now,current.id,input.accountId,input.conversationId,input.arrivalSeq,input.turnId,input.accountId,input.conversationId,input.owner,input.token,current.id,input.arrivalSeq,lease.lease_generation,input.now).changes!==1)throw Error('V2_QUEUE_LEASE_FENCED');
      return this.db.prepare('SELECT * FROM v2_inbox_items WHERE id=?').get(current.id);
    });
  }
  /**
   * CP-004 admission descriptor.  This is deliberately a closed data input:
   * the V3 layer supplies no callback and this method remains the only write
   * fence which can set side_effect_started.
   */
  queueAuthorizeV3SideEffect(input:{accountId:string;conversationId:string;arrivalSeq:number;turnId:string;owner:string;token:string;generation:number;now:string;bundleId:string;bundleRevision:number;conversationRevision:number;contextSnapshotVersion:string;freshnessVectorHash:string;bundleMessageIds:string[];actionId:string;actionSequence:number;capabilityName:string;capabilityVersion:string;argumentsHash:string;effectIdentity:string;bundle:unknown;context:unknown;freshnessVector:unknown;lease:unknown}){
    return this.#queueImmediate(()=>{
      const {current,lease:queueLease,turn}=this.#queueAuthorizeSideEffectLocked(input);
      const action=this.db.prepare('SELECT * FROM agent_actions WHERE id=? AND turn_id=? AND sequence=?').get(input.actionId,input.turnId,input.actionSequence) as any;
      if(!action||action.capability_name!==input.capabilityName||action.capability_version!==input.capabilityVersion||action.arguments_hash!==input.argumentsHash)throw Error('V3_EFFECT_IDENTITY_INVALID');
      const actionIdentity=`V3-CP-004:effect:${canonicalSha256({actionId:action.id,turnId:action.turn_id,sequence:action.sequence,capabilityName:action.capability_name,capabilityVersion:action.capability_version,argumentsHash:action.arguments_hash})}`;
      if(actionIdentity!==input.effectIdentity)throw Error('V3_EFFECT_IDENTITY_INVALID');
      if(current.side_effect_started)throw Error('V3_RECONCILE_REQUIRED');
      if(this.db.prepare('SELECT 1 FROM agent_action_execution_events WHERE action_id=?').get(action.id))throw Error('V3_EFFECT_EXECUTION_UNCERTAIN');
      if(this.db.prepare('SELECT 1 FROM agent_action_results WHERE action_id=?').get(action.id))throw Error('V3_EFFECT_ALREADY_RESOLVED');
      let context:any;try{context=JSON.parse(turn.context_snapshot_json)}catch{throw Error('V2_QUEUE_TURN_CONTEXT_INTEGRITY')}
      if(canonicalJson(context)!==turn.context_snapshot_json||canonicalSha256(context)!==turn.context_fingerprint)throw Error('V2_QUEUE_TURN_CONTEXT_INTEGRITY');
      if(context.turnId!==input.turnId||context.accountId!==input.accountId||context.conversationId!==input.conversationId)throw Error('V3_CONTEXT_BINDING_INVALID');
      if(context.freshness?.fingerprint!==authoritativeFreshnessFingerprint(this.db,input.accountId,input.conversationId,String(turn.profile_id)))throw Error('V3_STALE_FRESHNESS');
      // All V3 authority is revalidated after BEGIN IMMEDIATE and before the CAS.
      const bundle=validateInboundBundle(input.bundle), snapshot=validateContextSnapshot(input.context), vector=validateV3FreshnessVector(input.freshnessVector);
      if(bundle.bundleId!==input.bundleId||bundle.bundleRevision!==input.bundleRevision||bundle.conversationRevisionAtBuild!==input.conversationRevision||bundle.accountId!==input.accountId||bundle.conversationId!==input.conversationId)throw Error('V3_BUNDLE_BINDING_INVALID');
      if(snapshot.contextSnapshotVersion!==input.contextSnapshotVersion||snapshot.sourceRevisionRefs.turnId!==input.turnId||snapshot.sourceRevisionRefs.accountId!==input.accountId||snapshot.sourceRevisionRefs.conversationId!==input.conversationId||snapshot.sourceRevisionRefs.profileId!==turn.profile_id||snapshot.sourceRevisionRefs.profileVersion!==turn.profile_version)throw Error('V3_CONTEXT_BINDING_INVALID');
      if(canonicalJson(snapshot.context)!==canonicalJson(context))throw Error('V3_CONTEXT_BINDING_INVALID');
      if(!isCurrentReasoningLease(this.db,input.lease,bundle,snapshot,input.now))throw Error('V3_LEASE_NOT_CURRENT');
      const lease= input.lease as any;
      if(lease.generation!==Number(queueLease.lease_generation)||lease.ownerId!==input.owner||lease.fencingToken!==input.token||lease.queueItemId!==current.id||lease.queueArrivalSeq!==input.arrivalSeq||lease.bundleId!==bundle.bundleId||lease.bundleRevision!==bundle.bundleRevision||lease.conversationRevision!==bundle.conversationRevisionAtBuild||lease.contextSnapshotVersion!==snapshot.contextSnapshotVersion)throw Error('V3_LEASE_BINDING_INVALID');
      if(vector.dependencies.identityScope.accountId!==input.accountId||vector.dependencies.identityScope.conversationId!==input.conversationId||vector.dependencies.conversationBundle.bundleRevision!==bundle.bundleRevision||vector.dependencies.conversationBundle.conversationRevision!==bundle.conversationRevisionAtBuild||vector.dependencies.conversationBundle.messageRefs.map((ref:any)=>ref.id).join('|')!==bundle.messageIds.join('|'))throw Error('V3_FRESHNESS_BINDING_INVALID');
      const rebuilt=buildV3FreshnessVectorFromDatabase(this.db,vector.dependencies);
      if(rebuilt.vectorHash!==vector.vectorHash||vector.vectorHash!==input.freshnessVectorHash)throw Error('V3_STALE_FRESHNESS');
      const profile=new EmployeeProfileResolver(this.db).resolve(String(turn.profile_id));
      let args:unknown;try{args=JSON.parse(action.arguments_json)}catch{throw Error('V3_ACTION_ARGUMENTS_INVALID')}
      authorizeCapability({name:input.capabilityName,arguments:args},{db:this.db,...profileAuthorization(profile),accountId:input.accountId,conversationId:input.conversationId,customerId:(this.db.prepare('SELECT customer_id FROM conversations WHERE id=? AND channel_account_id=?').get(input.conversationId,input.accountId) as any)?.customer_id,idempotencyKey:action.id});
      const newer=Number((this.db.prepare("SELECT count(*) AS n FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND arrival_seq>? AND state='QUEUED'").get(input.accountId,input.conversationId,input.arrivalSeq) as any)?.n??0)>0;
      if(newer){
        if(this.db.prepare("UPDATE v2_inbox_items SET state='SUPERSEDED',updated_at=? WHERE id=? AND state='PROCESSING' AND side_effect_started=0").run(input.now,current.id).changes!==1)throw Error('V2_QUEUE_LEASE_FENCED');
        this.db.prepare('UPDATE v2_conversation_inbox SET processed_watermark=MAX(processed_watermark,?),lease_owner=NULL,lease_token=NULL,lease_item_id=NULL,lease_arrival_seq=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND conversation_id=? AND lease_owner=? AND lease_token=? AND lease_item_id=? AND lease_arrival_seq=? AND lease_generation=? AND lease_expires_at>?').run(input.arrivalSeq,input.now,input.accountId,input.conversationId,input.owner,input.token,current.id,input.arrivalSeq,queueLease.lease_generation,input.now);
        return {status:'NEWER_INPUT_QUEUED'};
      }
      const bundleRows=this.db.prepare(`SELECT message_id FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND message_id IN (${input.bundleMessageIds.map(()=>'?').join(',')}) ORDER BY arrival_seq`).all(input.accountId,input.conversationId,...input.bundleMessageIds) as any[];
      if(bundleRows.length!==input.bundleMessageIds.length||bundleRows.some((row,index)=>row.message_id!==input.bundleMessageIds[index])||context.freshness?.inboundMessageId!==input.bundleMessageIds[input.bundleMessageIds.length-1])throw Error('V3_CONTEXT_BINDING_INVALID');
      const changed=this.db.prepare("UPDATE v2_inbox_items SET side_effect_started=1,agent_turn_id=?,updated_at=? WHERE id=? AND account_id=? AND conversation_id=? AND arrival_seq=? AND state='PROCESSING' AND side_effect_started=0 AND (agent_turn_id IS NULL OR agent_turn_id=?) AND EXISTS (SELECT 1 FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=? AND lease_owner=? AND lease_token=? AND lease_item_id=? AND lease_arrival_seq=? AND lease_generation=? AND lease_expires_at>?)").run(input.turnId,input.now,current.id,input.accountId,input.conversationId,input.arrivalSeq,input.turnId,input.accountId,input.conversationId,input.owner,input.token,current.id,input.arrivalSeq,queueLease.lease_generation,input.now);
      if(changed.changes!==1)throw Error('V2_QUEUE_LEASE_FENCED');
      return {status:'ADMITTED',item:this.db.prepare('SELECT * FROM v2_inbox_items WHERE id=?').get(current.id)};
    });
  }
  queueComplete(input:{accountId:string;conversationId:string;itemId:string;arrivalSeq:number;owner:string;token:string;now:string;resultHash:string|null}){return this.#queueImmediate(()=>{const lease=this.db.prepare('SELECT lease_generation FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=? AND lease_owner=? AND lease_token=? AND lease_item_id=? AND lease_arrival_seq=? AND lease_expires_at>?').get(input.accountId,input.conversationId,input.owner,input.token,input.itemId,input.arrivalSeq,input.now) as any;if(!lease)throw Error('V2_QUEUE_LEASE_FENCED');if(this.db.prepare("UPDATE v2_inbox_items SET state='COMPLETED',result_hash=?,updated_at=? WHERE id=? AND account_id=? AND conversation_id=? AND state='PROCESSING' AND side_effect_started IN (0,1)").run(input.resultHash,input.now,input.itemId,input.accountId,input.conversationId).changes!==1)throw Error('V2_QUEUE_LEASE_FENCED');if(this.db.prepare('UPDATE v2_conversation_inbox SET processed_watermark=MAX(processed_watermark,?),lease_owner=NULL,lease_token=NULL,lease_item_id=NULL,lease_arrival_seq=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND conversation_id=? AND lease_owner=? AND lease_token=? AND lease_item_id=? AND lease_arrival_seq=? AND lease_generation=? AND lease_expires_at>?').run(input.arrivalSeq,input.now,input.accountId,input.conversationId,input.owner,input.token,input.itemId,input.arrivalSeq,lease.lease_generation,input.now).changes!==1)throw Error('V2_QUEUE_LEASE_FENCED');return this.db.prepare('SELECT * FROM v2_inbox_items WHERE id=?').get(input.itemId);});}
  queueSupersedeExact(input:{accountId:string;conversationId:string;itemId:string;arrivalSeq:number;owner:string;token:string;now:string}){return this.#queueImmediate(()=>{const lease=this.db.prepare('SELECT lease_generation FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=? AND lease_owner=? AND lease_token=? AND lease_item_id=? AND lease_arrival_seq=? AND lease_expires_at>?').get(input.accountId,input.conversationId,input.owner,input.token,input.itemId,input.arrivalSeq,input.now) as any;if(!lease)throw Error('V2_QUEUE_LEASE_FENCED');const newer=Number((this.db.prepare("SELECT count(*) AS n FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND arrival_seq>? AND state='QUEUED'").get(input.accountId,input.conversationId,input.arrivalSeq) as any)?.n??0)>0;if(!newer)return false;if(this.db.prepare("UPDATE v2_inbox_items SET state='SUPERSEDED',updated_at=? WHERE id=? AND account_id=? AND conversation_id=? AND arrival_seq=? AND state='PROCESSING' AND side_effect_started=0").run(input.now,input.itemId,input.accountId,input.conversationId,input.arrivalSeq).changes!==1)throw Error('V2_QUEUE_LEASE_FENCED');if(this.db.prepare('UPDATE v2_conversation_inbox SET processed_watermark=MAX(processed_watermark,?),lease_owner=NULL,lease_token=NULL,lease_item_id=NULL,lease_arrival_seq=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,revision=revision+1,updated_at=? WHERE account_id=? AND conversation_id=? AND lease_owner=? AND lease_token=? AND lease_item_id=? AND lease_arrival_seq=? AND lease_generation=? AND lease_expires_at>?').run(input.arrivalSeq,input.now,input.accountId,input.conversationId,input.owner,input.token,input.itemId,input.arrivalSeq,lease.lease_generation,input.now).changes!==1)throw Error('V2_QUEUE_LEASE_FENCED');return true;});}
  /** Creates only the non-authoritative V1_ONLY/LEGACY default row; the INSERT trigger rejects raw callers and any stronger initial state. */
  ensureWorkspaceAuthority(accountId:string,conversationId:string,updatedAt:string){
    this.#workspaceAuthorityInitDepth+=1;
    try{return this.db.prepare("INSERT OR IGNORE INTO workspace_authority(account_id,conversation_id,work_item_type,migration_state,authoritative_writer,updated_at) VALUES(?,?,'SALES_ORDER_REQUEST','V1_ONLY','LEGACY',?)").run(accountId,conversationId,updatedAt)}finally{this.#workspaceAuthorityInitDepth-=1}
  }
  /** Server-owned V2 provenance write; callers cannot authorize raw SQL inserts. */
  insertV2ErpEvidence(row:{id:string;evidenceType:string;toolCallId:string;lookupKey:string;inputJson:string;outputJson:string;observedAt:string;sourceVersion:string}){
    this.#v2ValidationWriteDepth+=1;
    try{return this.db.prepare('INSERT INTO erp_evidence(id,evidence_type,tool_call_id,lookup_key,input_json,output_json,observed_at,source_version) VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.evidenceType,row.toolCallId,row.lookupKey,row.inputJson,row.outputJson,row.observedAt,row.sourceVersion)}finally{this.#v2ValidationWriteDepth-=1}
  }
  /** Server-owned ERP evidence write for the legacy quotation boundary. */
  insertErpEvidence(row:{id:string;evidenceType:string;toolCallId:string;lookupKey:string;inputJson:string;outputJson:string;observedAt:string;sourceVersion:string}){
    this.#v2ValidationWriteDepth+=1;
    try{return this.db.prepare('INSERT INTO erp_evidence(id,evidence_type,tool_call_id,lookup_key,input_json,output_json,observed_at,source_version) VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.evidenceType,row.toolCallId,row.lookupKey,row.inputJson,row.outputJson,row.observedAt,row.sourceVersion)}finally{this.#v2ValidationWriteDepth-=1}
  }
  /** Server-owned V2 validation history write; callers cannot authorize raw SQL inserts. */
  insertV2OrderValidation(row:{id:string;draftId:string;draftRevision:number;mode:'DRAFT'|'QUOTE_TIME';status:'SUCCEEDED'|'BLOCKED';resultJson:string;evidenceRefsJson:string;createdAt:string}){
    this.#v2ValidationWriteDepth+=1;
    try{return this.db.prepare('INSERT INTO v2_order_validations(id,draft_id,draft_revision,mode,status,result_json,evidence_refs_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.draftId,row.draftRevision,row.mode,row.status,row.resultJson,row.evidenceRefsJson,row.createdAt)}finally{this.#v2ValidationWriteDepth-=1}
  }
  insertGroundingProvenance(row:{evidenceId:string;accountId:string;conversationId:string;customerId:string;draftId?:string;draftRevision?:number;quotationId?:string;acceptanceId?:string;salesOrderId?:string;linkType:string;createdAt:string}){
    const evidence=this.db.prepare('SELECT id FROM erp_evidence WHERE id=?').get(row.evidenceId); if(!evidence) throw Error('GROUNDING_EVIDENCE_NOT_FOUND');
    const conversation=this.db.prepare('SELECT customer_id FROM conversations WHERE id=? AND channel_account_id=?').get(row.conversationId,row.accountId) as {customer_id:string}|undefined;
    if(!conversation||conversation.customer_id!==row.customerId) throw Error('GROUNDING_PROVENANCE_SCOPE');
    if((row.draftId===undefined)!==(row.draftRevision===undefined)) throw Error('GROUNDING_DRAFT_LINEAGE_REQUIRED');
    if(row.draftId!==undefined){const d=this.db.prepare("SELECT 1 FROM order_drafts WHERE id=? AND account_id=? AND conversation_id=? AND customer_id=? AND current_revision=?").get(row.draftId,row.accountId,row.conversationId,row.customerId,row.draftRevision);if(!d)throw Error('GROUNDING_DRAFT_LINEAGE_INVALID');}
    if(row.quotationId!==undefined){const q=this.db.prepare('SELECT 1 FROM quotations WHERE id=? AND source_conversation_id=? AND customer_id=?').get(row.quotationId,row.conversationId,row.customerId);if(!q)throw Error('GROUNDING_QUOTE_LINEAGE_INVALID');if(!this.db.prepare('SELECT 1 FROM quotation_line_evidence qle JOIN quotation_lines ql ON ql.id=qle.quotation_line_id WHERE ql.quotation_id=? AND qle.evidence_id=?').get(row.quotationId,row.evidenceId))throw Error('GROUNDING_QUOTE_EVIDENCE_UNBOUND');}
    if(row.acceptanceId!==undefined){const a=this.db.prepare('SELECT quotation_id FROM quotation_acceptances a JOIN quotations q ON q.id=a.quotation_id WHERE a.id=? AND q.source_conversation_id=? AND q.customer_id=?').get(row.acceptanceId,row.conversationId,row.customerId) as {quotation_id:string}|undefined;if(!a||row.quotationId!==undefined&&a.quotation_id!==row.quotationId)throw Error('GROUNDING_ACCEPTANCE_LINEAGE_INVALID');}
    if(row.salesOrderId!==undefined){const s=this.db.prepare('SELECT s.source_quotation_id FROM sales_orders s JOIN quotations q ON q.id=s.source_quotation_id WHERE s.id=? AND q.source_conversation_id=? AND q.customer_id=?').get(row.salesOrderId,row.conversationId,row.customerId) as {source_quotation_id:string}|undefined;if(!s||row.quotationId!==undefined&&s.source_quotation_id!==row.quotationId)throw Error('GROUNDING_SO_LINEAGE_INVALID');}
    const prior=this.db.prepare('SELECT draft_id,draft_revision,quotation_id,acceptance_id,sales_order_id FROM grounding_provenance_links WHERE evidence_id=?').all(row.evidenceId) as any[];
    if(row.draftId!==undefined&&prior.some(p=>p.draft_id!==row.draftId||p.draft_revision!==row.draftRevision))throw Error('GROUNDING_EVIDENCE_LINEAGE_CONFLICT');
    if(row.quotationId!==undefined&&prior.some(p=>p.quotation_id!==null&&p.quotation_id!==row.quotationId))throw Error('GROUNDING_EVIDENCE_LINEAGE_CONFLICT');
    this.#provenanceWriteDepth++;
    try{return this.db.prepare('INSERT INTO grounding_provenance_links(id,evidence_id,account_id,conversation_id,customer_id,draft_id,draft_revision,quotation_id,acceptance_id,sales_order_id,link_type,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.evidenceId,row.accountId,row.conversationId,row.customerId,row.draftId??null,row.draftRevision??null,row.quotationId??null,row.acceptanceId??null,row.salesOrderId??null,row.linkType,row.createdAt)}finally{this.#provenanceWriteDepth--}
  }
  insertCommercialIntegritySeal(row:{entityType:'QUOTATION'|'ACCEPTANCE'|'SALES_ORDER';entityId:string;accountId:string;conversationId:string;customerId:string;lineageId:string;payloadJson:string;payloadHash:string;sealedAt:string}){
    const lineage=row.entityType==='QUOTATION' ? this.db.prepare('SELECT 1 FROM quotations WHERE id=? AND source_conversation_id=? AND customer_id=? AND id=?').get(row.entityId,row.conversationId,row.customerId,row.lineageId) : row.entityType==='ACCEPTANCE' ? this.db.prepare('SELECT 1 FROM quotation_acceptances a JOIN quotations q ON q.id=a.quotation_id WHERE a.id=? AND q.source_conversation_id=? AND q.customer_id=? AND a.quotation_id=?').get(row.entityId,row.conversationId,row.customerId,row.lineageId) : this.db.prepare('SELECT 1 FROM sales_orders s JOIN quotations q ON q.id=s.source_quotation_id WHERE s.id=? AND q.source_conversation_id=? AND q.customer_id=? AND s.source_quotation_id=?').get(row.entityId,row.conversationId,row.customerId,row.lineageId);
    if(!lineage) throw Error('COMMERCIAL_SEAL_LINEAGE_INVALID');
    this.#commerceSealWriteDepth++;
    try{return this.db.prepare('INSERT INTO commercial_integrity_seals(id,entity_type,entity_id,account_id,conversation_id,customer_id,lineage_id,payload_json,payload_hash,sealed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.entityType,row.entityId,row.accountId,row.conversationId,row.customerId,row.lineageId,row.payloadJson,row.payloadHash,row.sealedAt)}finally{this.#commerceSealWriteDepth--}
  }
  takeDocumentNumber(documentType:'quotation'|'sales_order',prefix:'QT'|'SO'){
    const row=this.db.prepare('UPDATE document_sequences SET next_number=next_number+1 WHERE document_type=? RETURNING next_number-1 AS number').get(documentType) as {number:number}|undefined;
    if(!row)throw Error('DOCUMENT_SEQUENCE_MISSING');
    return `${prefix}-${String(row.number).padStart(6,'0')}`;
  }
  resetAndSeed(){this.#workspaceResetDepth+=1;try{return this.db.transaction(()=>{
    this.db.prepare('DELETE FROM grounding_verdicts').run(); this.db.prepare('DELETE FROM commercial_integrity_seals').run(); this.db.prepare('DELETE FROM grounding_provenance_links').run();
    this.#queueMutationDepth+=1;
    this.db.prepare('DELETE FROM v2_inbox_route_events').run();
    this.db.prepare('DELETE FROM v3_continuation_wake_events').run();
    for(const table of ['durable_continuations','conversation_goal_edges','conversation_goal_events','v2_inbox_items','v2_conversation_inbox','v2_rollout_events','v2_capability_rollouts','agent_response_plans','agent_action_execution_events','agent_repair_evidence','agent_model_attempt_evidence','agent_endpoint_traces','agent_model_attempts','agent_action_results','agent_actions','turn_outbound_dispositions','agent_turns','conversation_summaries','employee_profiles','company_profile','v2_order_validations','workspace_provenance_links','workspace_migration_events','order_draft_revisions','order_draft_lines','order_drafts','work_item_events','work_items','workspace_authority','audit_events','staff_actions','outbound_messages','sales_order_lines','sales_orders','quotation_acceptances','quotation_line_evidence','quotation_lines','quotations','erp_evidence','agent_tool_calls','agent_runs','customer_order_memory','customer_prices','stock_balances','product_uom_conversions','product_aliases','products','uoms','warehouses','prospect_identities','prospect_reply_sequence','prospect_catalog_evidence','inbound_route_audit','messages','customer_channel_identities','customers','conversations','channel_accounts','document_sequences'])this.db.prepare(`DELETE FROM ${table}`).run();
    const run=(sql:string)=>this.db.prepare(sql).run();
    const profile=INITIAL_SALES_PROFILE_SEED,profileNow=new Date().toISOString();
    this.db.prepare('INSERT INTO employee_profiles(id,version,role,mission,tone,language_policy_json,capability_permissions_json,forbidden_commitments_json,escalation_rules_json,turn_budgets_json,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(profile.id,profile.version,profile.role,profile.mission,profile.tone,JSON.stringify(profile.languagePolicy),JSON.stringify(profile.permissions),JSON.stringify(profile.forbiddenCommitments),JSON.stringify(profile.escalationRules),JSON.stringify(profile.turnBudgets),profile.active?1:0,profileNow,profileNow);
    run("INSERT INTO channel_accounts VALUES ('demo-account','simulated','demo-account','CONNECTED',datetime('now'),datetime('now'))");
    run("INSERT INTO conversations VALUES ('conv-001','demo-account','conv-001','CUST-001','OPEN',datetime('now'))");
    const petshop=this.demoDataset==='petshop';
    run(petshop ? "INSERT INTO customers VALUES ('CUST-001','CUST-001','Happy Paws Pet Cafe Sdn Bhd','MYR','OK','MY-MAIN')" : "INSERT INTO customers VALUES ('CUST-001','CUST-001','Sunrise Mini Mart Pte Ltd','SGD','OK','SG-MAIN')");
    run("INSERT INTO customer_channel_identities VALUES ('identity-001','CUST-001','demo-account','whatsapp','+6591110001','+6591110001')");
    run(petshop ? "INSERT INTO warehouses VALUES ('MY-MAIN','MY-MAIN','Demo main warehouse')" : "INSERT INTO warehouses VALUES ('SG-MAIN','SG-MAIN','Main warehouse')");
    const cp=petshop ? ['PawSmart Demo Pet Store (demo data)','Smart pet-care retailer specialising in app-connected feeding, hydration, litter and grooming devices.',JSON.stringify(['Product sales']),JSON.stringify(['Feeding','Hydration','Litter','Grooming']), 'Mon-Sat 10:00-19:00 MYT','Same-day courier in Klang Valley for orders confirmed before 14:00; 2-3 working days elsewhere in West Malaysia',JSON.stringify(['Online banking','credit/debit card','cash on delivery (Klang Valley)']),'7 days for unopened items','2-year limited warranty on smart devices','Malaysia (West)','Reply here on WhatsApp and a staff member will follow up'] : ['Demo Business (demo data)','General business profile; details are not available.',JSON.stringify([]),JSON.stringify([]),'Not available','Not available',JSON.stringify([]),'Not available','Not available','Not available','Contact the business for information'];
    this.db.prepare("INSERT INTO company_profile(profile_key,version,display_name,description,services_json,product_categories_json,opening_hours,delivery_policy,payment_methods_json,returns_policy,warranty_policy,service_area,contact_instructions,is_demo) VALUES ('active',1,?,?,?,?,?,?,?,?,?,?,?,1)").run(...cp);
    run(petshop ? "INSERT INTO uoms VALUES ('UNIT','Unit'),('PACK','Pack')" : "INSERT INTO uoms VALUES ('CTN','Carton')");
    run("INSERT INTO document_sequences VALUES ('quotation',1),('sales_order',52)");
    if(petshop){
      run("INSERT INTO products VALUES ('LITTER-AUTO-01','LITTER-AUTO-01','Smart Self-Cleaning Litter Box (App-Connected)','UNIT',1),('FEEDER-CAM-01','FEEDER-CAM-01','Smart Feeder with AI Camera, Dual Hopper','UNIT',1),('FEEDER-SOLO-01','FEEDER-SOLO-01','Smart Feeder Solo, Scheduled Portions','UNIT',1),('FOUNTAIN-UV-01','FOUNTAIN-UV-01','Smart Water Fountain with UV Sterilisation','UNIT',1),('FOUNTAIN-FILTER-01','FOUNTAIN-FILTER-01','Replacement Filter Pack (3-pack)','PACK',1),('DRYER-CABIN-01','DRYER-CABIN-01','Automatic Pet Drying Cabin','UNIT',1),('LITTER-BAG-01','LITTER-BAG-01','Litter Box Waste Bags (5 rolls)','PACK',1)");
      run("INSERT INTO product_aliases VALUES ('pub-lit',NULL,'LITTER-AUTO-01','litter box',1,'public'),('pub-feed',NULL,'FEEDER-CAM-01','feeder',1,'public'),('pub-fount',NULL,'FOUNTAIN-UV-01','fountain',1,'public'),('pub-dryer',NULL,'DRYER-CABIN-01','dryer',1,'public'),('pub-filter',NULL,'FOUNTAIN-FILTER-01','filter',1,'public')");
      run("INSERT INTO stock_balances VALUES ('LITTER-AUTO-01','MY-MAIN','12'),('FEEDER-CAM-01','MY-MAIN','20'),('FEEDER-SOLO-01','MY-MAIN','25'),('FOUNTAIN-UV-01','MY-MAIN','30'),('FOUNTAIN-FILTER-01','MY-MAIN','100'),('DRYER-CABIN-01','MY-MAIN','5'),('LITTER-BAG-01','MY-MAIN','60')");
      run("INSERT INTO customer_prices VALUES ('price-pet-1','CUST-001','LITTER-AUTO-01','UNIT',199900,'MYR','2026-01-01',NULL),('price-pet-2','CUST-001','FEEDER-CAM-01','UNIT',79900,'MYR','2026-01-01',NULL),('price-pet-3','CUST-001','FEEDER-SOLO-01','UNIT',39900,'MYR','2026-01-01',NULL),('price-pet-4','CUST-001','FOUNTAIN-UV-01','UNIT',25900,'MYR','2026-01-01',NULL),('price-pet-5','CUST-001','FOUNTAIN-FILTER-01','PACK',5900,'MYR','2026-01-01',NULL),('price-pet-6','CUST-001','DRYER-CABIN-01','UNIT',129900,'MYR','2026-01-01',NULL),('price-pet-7','CUST-001','LITTER-BAG-01','PACK',2500,'MYR','2026-01-01',NULL)");
    } else run("INSERT INTO products VALUES ('FCH-WHOLE-12','FCH-WHOLE-12','Frozen Whole Chicken 1.2kg x 10','PCS',1),('FRANK-RED-1KG','FRANK-RED-1KG','Red Label Chicken Frank 1kg x 10','PACK',1),('FCH-WING-2KG','FCH-WING-2KG','Frozen Chicken Wing 2kg x 6','PACK',1)");
    if(!petshop) run("INSERT INTO product_aliases VALUES ('alias-ayam','CUST-001','FCH-WHOLE-12','ayam',1,'customer'),('alias-red','CUST-001','FRANK-RED-1KG','red one',1,'customer'),('alias-wings','CUST-001','FCH-WING-2KG','wings',1,'customer')");
    // Public catalog vocabulary: customer_id NULL means the term belongs to no
    // customer, so it is safe for prospect discovery. Customer-scoped aliases are
    // matched only by the customer-scoped joins and never surface publicly.
    if(!petshop) run("INSERT INTO product_aliases VALUES ('alias-pub-ayam-1',NULL,'FCH-WHOLE-12','ayam',1,'public'),('alias-pub-ayam-2',NULL,'FRANK-RED-1KG','ayam',1,'public'),('alias-pub-ayam-3',NULL,'FCH-WING-2KG','ayam',1,'public'),('alias-pub-ji-1',NULL,'FCH-WHOLE-12','鸡',1,'public'),('alias-pub-ji-2',NULL,'FRANK-RED-1KG','鸡',1,'public'),('alias-pub-ji-3',NULL,'FCH-WING-2KG','鸡',1,'public')");
    if(!petshop) run("INSERT INTO product_uom_conversions VALUES ('conv-ayam','FCH-WHOLE-12','CTN','PCS','10'),('conv-red','FRANK-RED-1KG','CTN','PACK','10'),('conv-wings','FCH-WING-2KG','CTN','PACK','6')");
    if(!petshop){run("INSERT INTO stock_balances VALUES ('FCH-WHOLE-12','SG-MAIN','820'),('FRANK-RED-1KG','SG-MAIN','60'),('FCH-WING-2KG','SG-MAIN','144')");run("INSERT INTO customer_prices VALUES ('price-ayam','CUST-001','FCH-WHOLE-12','CTN',4800,'SGD','2026-01-01',NULL),('price-red','CUST-001','FRANK-RED-1KG','CTN',3650,'SGD','2026-01-01',NULL),('price-wings','CUST-001','FCH-WING-2KG','CTN',4200,'SGD','2026-01-01',NULL)");}
    run(petshop ? "INSERT INTO sales_orders VALUES ('so-seeded-041','SO-000041','CUST-001','POSTED','MYR','2026-09-01','MY-MAIN','Fictional demo history',199900,0,199900,'seeded-history-quote','seeded-history-acceptance','2026-09-01T10:00:00+08:00','2026-09-01T10:05:00+08:00')" : "INSERT INTO sales_orders VALUES ('so-seeded-041','SO-000041','CUST-001','POSTED','SGD','2026-09-01','SG-MAIN','Historical demo order',66250,0,66250,'seeded-history-quote','seeded-history-acceptance','2026-09-01T10:00:00+08:00','2026-09-01T10:05:00+08:00')");
    if(petshop) run("INSERT INTO sales_order_lines VALUES ('sol-seeded-041-1','so-seeded-041','seeded-history-1',1,'LITTER-AUTO-01','LITTER-AUTO-01','Smart Self-Cleaning Litter Box (App-Connected)','1','UNIT',199900,199900)");else run("INSERT INTO sales_order_lines VALUES ('sol-seeded-041-1','so-seeded-041','seeded-history-1',1,'FCH-WHOLE-12','FCH-WHOLE-12','Frozen Whole Chicken 1.2kg x 10','10','CTN',4800,48000),('sol-seeded-041-2','so-seeded-041','seeded-history-2',2,'FRANK-RED-1KG','FRANK-RED-1KG','Red Label Chicken Frank 1kg x 10','5','CTN',3650,18250)");
  })()}finally{this.#queueMutationDepth-=1;this.#workspaceResetDepth-=1}}
}
