PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS document_sequences(document_type TEXT PRIMARY KEY,next_number INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS company_profile(profile_key TEXT NOT NULL,version INTEGER NOT NULL,display_name TEXT NOT NULL,description TEXT NOT NULL,services_json TEXT NOT NULL,product_categories_json TEXT NOT NULL,opening_hours TEXT NOT NULL,delivery_policy TEXT NOT NULL,payment_methods_json TEXT NOT NULL,returns_policy TEXT NOT NULL,warranty_policy TEXT NOT NULL,service_area TEXT NOT NULL,contact_instructions TEXT NOT NULL,is_demo INTEGER NOT NULL CHECK(is_demo=1),PRIMARY KEY(profile_key,version));
CREATE TABLE IF NOT EXISTS channel_accounts(id TEXT PRIMARY KEY,provider TEXT NOT NULL,external_account_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,channel_account_id TEXT NOT NULL,external_conversation_id TEXT NOT NULL,customer_id TEXT,status TEXT,last_message_at TEXT);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,external_message_id TEXT NOT NULL,direction TEXT NOT NULL,message_type TEXT NOT NULL,text TEXT,sender_external_id TEXT,sender_phone TEXT,reply_to_external_message_id TEXT,account_id TEXT NOT NULL,occurred_at TEXT NOT NULL,raw_ref TEXT,arrival_seq INTEGER,forwarding_json TEXT,UNIQUE(account_id,external_message_id));
CREATE UNIQUE INDEX IF NOT EXISTS messages_arrival_seq_unique ON messages(account_id,conversation_id,arrival_seq) WHERE arrival_seq IS NOT NULL;
CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,code TEXT UNIQUE,name TEXT NOT NULL,currency TEXT NOT NULL,credit_status TEXT,default_warehouse_id TEXT);
CREATE TABLE IF NOT EXISTS customer_channel_identities(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,channel_account_id TEXT NOT NULL,channel TEXT NOT NULL,external_id TEXT NOT NULL,phone TEXT,UNIQUE(channel_account_id,external_id));
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,stock_code TEXT UNIQUE,description TEXT NOT NULL,base_uom TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS product_aliases(id TEXT PRIMARY KEY,customer_id TEXT,product_id TEXT NOT NULL,alias TEXT NOT NULL,confidence REAL NOT NULL,source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS uoms(code TEXT PRIMARY KEY,description TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS product_uom_conversions(id TEXT PRIMARY KEY,product_id TEXT NOT NULL,from_uom TEXT NOT NULL,to_uom TEXT NOT NULL,factor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS warehouses(id TEXT PRIMARY KEY,code TEXT UNIQUE,name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_balances(product_id TEXT NOT NULL,warehouse_id TEXT NOT NULL,quantity_base TEXT NOT NULL,PRIMARY KEY(product_id,warehouse_id));
CREATE TABLE IF NOT EXISTS customer_prices(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,product_id TEXT NOT NULL,uom TEXT NOT NULL,unit_price_cents INTEGER NOT NULL,currency TEXT NOT NULL,valid_from TEXT NOT NULL,valid_to TEXT);
CREATE TABLE IF NOT EXISTS quotations(id TEXT PRIMARY KEY,quotation_no TEXT UNIQUE NOT NULL,customer_id TEXT NOT NULL,status TEXT NOT NULL,currency TEXT NOT NULL,quotation_date TEXT NOT NULL,valid_until TEXT NOT NULL,delivery_date TEXT,warehouse_id TEXT,remark TEXT,subtotal_cents INTEGER NOT NULL,tax_cents INTEGER NOT NULL,grand_total_cents INTEGER NOT NULL,source_conversation_id TEXT NOT NULL,source_message_id TEXT NOT NULL,sent_at TEXT,accepted_at TEXT,sent_snapshot_json TEXT,sent_snapshot_hash TEXT,sent_outbound_message_id TEXT,superseded_by_quotation_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_sent_quote ON quotations(source_conversation_id) WHERE status='SENT';
CREATE TABLE IF NOT EXISTS quotation_lines(id TEXT PRIMARY KEY,quotation_id TEXT NOT NULL,row_item_no INTEGER NOT NULL,product_id TEXT NOT NULL,stock_code TEXT NOT NULL,stock_description TEXT NOT NULL,row_item_remark TEXT,quantity TEXT NOT NULL,uom TEXT NOT NULL,unit_price_cents INTEGER NOT NULL,subtotal_cents INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS erp_evidence(id TEXT PRIMARY KEY,evidence_type TEXT NOT NULL,tool_call_id TEXT NOT NULL,lookup_key TEXT NOT NULL,input_json TEXT NOT NULL,output_json TEXT NOT NULL,observed_at TEXT NOT NULL,source_version TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS erp_evidence_v2_insert_guard BEFORE INSERT ON erp_evidence WHEN v2_validation_write_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'V2_ERP_EVIDENCE_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS erp_evidence_no_update BEFORE UPDATE ON erp_evidence WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ERP_EVIDENCE'); END;
CREATE TRIGGER IF NOT EXISTS erp_evidence_no_delete BEFORE DELETE ON erp_evidence WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ERP_EVIDENCE'); END;
CREATE TABLE IF NOT EXISTS grounding_provenance_links(id TEXT PRIMARY KEY,evidence_id TEXT NOT NULL,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,customer_id TEXT NOT NULL,draft_id TEXT,draft_revision INTEGER,quotation_id TEXT,acceptance_id TEXT,sales_order_id TEXT,link_type TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(evidence_id) REFERENCES erp_evidence(id));
CREATE INDEX IF NOT EXISTS grounding_provenance_scope_idx ON grounding_provenance_links(account_id,conversation_id,customer_id,evidence_id);
CREATE TRIGGER IF NOT EXISTS grounding_provenance_insert_guard BEFORE INSERT ON grounding_provenance_links WHEN v2_provenance_write_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'GROUNDING_PROVENANCE_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS grounding_provenance_no_update BEFORE UPDATE ON grounding_provenance_links WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_GROUNDING_PROVENANCE'); END;
CREATE TRIGGER IF NOT EXISTS grounding_provenance_no_delete BEFORE DELETE ON grounding_provenance_links WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_GROUNDING_PROVENANCE'); END;
CREATE TABLE IF NOT EXISTS quotation_line_evidence(quotation_line_id TEXT NOT NULL,evidence_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(quotation_line_id,evidence_id,role));
CREATE TABLE IF NOT EXISTS quotation_acceptances(id TEXT PRIMARY KEY,quotation_id TEXT NOT NULL UNIQUE,message_id TEXT NOT NULL UNIQUE,sender_external_id TEXT NOT NULL,accepted_at TEXT NOT NULL,evidence_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sales_orders(id TEXT PRIMARY KEY,sales_order_no TEXT UNIQUE NOT NULL,customer_id TEXT NOT NULL,status TEXT NOT NULL,currency TEXT NOT NULL,delivery_date TEXT,warehouse_id TEXT,remark TEXT,subtotal_cents INTEGER NOT NULL,tax_cents INTEGER NOT NULL,grand_total_cents INTEGER NOT NULL,source_quotation_id TEXT NOT NULL UNIQUE,source_acceptance_message_id TEXT NOT NULL,posted_at TEXT,confirmed_at TEXT);
CREATE TABLE IF NOT EXISTS sales_order_lines(id TEXT PRIMARY KEY,sales_order_id TEXT NOT NULL,source_quotation_line_id TEXT NOT NULL,row_item_no INTEGER NOT NULL,product_id TEXT NOT NULL,stock_code TEXT NOT NULL,stock_description TEXT NOT NULL,quantity TEXT NOT NULL,uom TEXT NOT NULL,unit_price_cents INTEGER NOT NULL,subtotal_cents INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbound_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,external_message_id TEXT,client_message_id TEXT UNIQUE NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,snapshot_hash TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL,attempt_count INTEGER NOT NULL,last_error TEXT,submitted_at TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbound_message_integrity(outbound_message_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,payload_version INTEGER NOT NULL CHECK(payload_version IN (0,1,2)),FOREIGN KEY(outbound_message_id) REFERENCES outbound_messages(id));
CREATE TABLE IF NOT EXISTS turn_outbound_dispositions(turn_id TEXT PRIMARY KEY,disposition TEXT NOT NULL CHECK(disposition IN ('RUNTIME_RESPONSE','CAPABILITY_OWNED_QUOTATION','HANDOFF_NO_CUSTOMER_MESSAGE','NONE')),purpose TEXT, outbound_message_id TEXT UNIQUE,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(turn_id) REFERENCES agent_turns(id),FOREIGN KEY(outbound_message_id) REFERENCES outbound_messages(id),CHECK((disposition='RUNTIME_RESPONSE' AND purpose IS NOT NULL AND outbound_message_id IS NULL) OR (disposition='CAPABILITY_OWNED_QUOTATION' AND purpose='quotation' AND outbound_message_id IS NULL) OR (disposition='HANDOFF_NO_CUSTOMER_MESSAGE' AND purpose='handoff' AND outbound_message_id IS NULL) OR (disposition='NONE' AND purpose='none' AND outbound_message_id IS NULL)));
CREATE TRIGGER IF NOT EXISTS turn_outbound_dispositions_insert_guard BEFORE INSERT ON turn_outbound_dispositions WHEN v2_outbound_mutation_authorized() <> 1 AND v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'TURN_OUTBOUND_DISPOSITION_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS turn_outbound_dispositions_no_update BEFORE UPDATE ON turn_outbound_dispositions WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TURN_OUTBOUND_DISPOSITION'); END;
CREATE TRIGGER IF NOT EXISTS turn_outbound_dispositions_no_delete BEFORE DELETE ON turn_outbound_dispositions WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TURN_OUTBOUND_DISPOSITION'); END;
CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_type TEXT NOT NULL,actor_id TEXT,evidence_ref TEXT,occurred_at TEXT NOT NULL,payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff_actions(id TEXT PRIMARY KEY,sales_order_id TEXT NOT NULL,action_type TEXT NOT NULL,staff_session_subject TEXT NOT NULL,customer_double_confirmed_at TEXT,evidence_ref TEXT,occurred_at TEXT NOT NULL,staff_post_idempotency_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS customer_order_memory(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,memory_type TEXT NOT NULL,key_text TEXT NOT NULL,value_json TEXT NOT NULL,confidence REAL NOT NULL,evidence_ref TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT);

-- V2-QUEUE-001: durable, provider-neutral conversation inbox authority.
CREATE TABLE IF NOT EXISTS v2_conversation_inbox(
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  next_arrival_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_arrival_seq > 0),
  processed_watermark INTEGER NOT NULL DEFAULT 0 CHECK(processed_watermark >= 0),
  lease_owner TEXT,
  lease_token TEXT,
  lease_item_id TEXT,
  lease_arrival_seq INTEGER,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
  lease_expires_at TEXT,
  lease_heartbeat_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id,conversation_id),
  FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS v2_inbox_items(
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  agent_turn_id TEXT,
  arrival_seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('QUEUED','PROCESSING','COMPLETED','SUPERSEDED')),
  side_effect_started INTEGER NOT NULL DEFAULT 0 CHECK(side_effect_started IN (0,1)),
  result_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,conversation_id,arrival_seq),
  FOREIGN KEY(message_id) REFERENCES messages(id),
  FOREIGN KEY(conversation_id) REFERENCES conversations(id),
  FOREIGN KEY(agent_turn_id) REFERENCES agent_turns(id)
);
CREATE INDEX IF NOT EXISTS v2_inbox_items_next_idx ON v2_inbox_items(account_id,conversation_id,state,arrival_seq);
CREATE TABLE IF NOT EXISTS v2_inbox_route_events(id TEXT PRIMARY KEY,inbox_item_id TEXT NOT NULL,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('RECLASSIFIED_TO_V1','BLOCKED')),reason TEXT NOT NULL,original_provider_message_id TEXT NOT NULL,original_external_message_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(inbox_item_id,action));

CREATE TRIGGER IF NOT EXISTS messages_arrival_seq_insert_guard
BEFORE INSERT ON messages WHEN NEW.arrival_seq IS NOT NULL AND v2_queue_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'V2_QUEUE_MESSAGE_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS messages_arrival_seq_update_guard
BEFORE UPDATE OF arrival_seq ON messages WHEN NEW.arrival_seq IS NOT OLD.arrival_seq AND v2_queue_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'V2_QUEUE_MESSAGE_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS v2_inbox_insert_guard
BEFORE INSERT ON v2_inbox_items WHEN v2_queue_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'V2_QUEUE_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS v2_inbox_update_guard
BEFORE UPDATE ON v2_inbox_items WHEN v2_queue_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V2_QUEUE_ITEM'); END;
CREATE TRIGGER IF NOT EXISTS v2_inbox_delete_guard
BEFORE DELETE ON v2_inbox_items WHEN v2_queue_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V2_QUEUE_ITEM'); END;
CREATE TRIGGER IF NOT EXISTS v2_inbox_state_insert_guard
BEFORE INSERT ON v2_conversation_inbox WHEN v2_queue_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'V2_QUEUE_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS v2_inbox_state_update_guard
BEFORE UPDATE ON v2_conversation_inbox WHEN v2_queue_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V2_QUEUE_STATE'); END;
CREATE TRIGGER IF NOT EXISTS v2_inbox_state_delete_guard
BEFORE DELETE ON v2_conversation_inbox WHEN v2_queue_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V2_QUEUE_STATE'); END;
CREATE TABLE IF NOT EXISTS agent_tool_calls(id TEXT PRIMARY KEY,agent_run_id TEXT NOT NULL,tool_name TEXT NOT NULL,input_json TEXT NOT NULL,output_json TEXT NOT NULL,status TEXT NOT NULL,occurred_at TEXT NOT NULL);

-- V2 workspace foundation. Additive only; V1 CommerceService does not read these tables.
CREATE TABLE IF NOT EXISTS work_items(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,customer_id TEXT NOT NULL,type TEXT NOT NULL CHECK(type='SALES_ORDER_REQUEST'),state TEXT NOT NULL CHECK(state IN ('OPEN','NEEDS_CLARIFICATION','DRAFTING','READY_TO_QUOTE','QUOTING','AWAITING_ACCEPTANCE','CHANGING','HANDED_OFF','COMPLETED','CANCELLED','FAILED')),revision INTEGER NOT NULL DEFAULT 1,goal_summary TEXT NOT NULL,active_order_draft_id TEXT,active_quotation_id TEXT,assigned_profile TEXT,blocking_reason TEXT,source_message_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_sales_order_request ON work_items(account_id,conversation_id,type) WHERE state NOT IN ('COMPLETED','CANCELLED','FAILED');
CREATE INDEX IF NOT EXISTS work_items_scope_idx ON work_items(account_id,conversation_id,type);
CREATE TABLE IF NOT EXISTS work_item_events(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,revision INTEGER NOT NULL,event_type TEXT NOT NULL,from_state TEXT,to_state TEXT NOT NULL,actor_type TEXT NOT NULL,actor_id TEXT,source_message_id TEXT,idempotency_key TEXT NOT NULL,normalized_input_hash TEXT NOT NULL,immutable_snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(work_item_id,revision),UNIQUE(work_item_id,idempotency_key),FOREIGN KEY(work_item_id) REFERENCES work_items(id));
CREATE TABLE IF NOT EXISTS order_drafts(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,customer_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('CURRENT','SUPERSEDED','CANCELLED')),current_revision INTEGER NOT NULL DEFAULT 0,requested_delivery_date TEXT,warehouse_id TEXT,currency TEXT,source_message_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(work_item_id) REFERENCES work_items(id));
CREATE UNIQUE INDEX IF NOT EXISTS one_current_order_draft_per_work_item ON order_drafts(work_item_id) WHERE status='CURRENT';
CREATE TABLE IF NOT EXISTS order_draft_lines(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL,line_no INTEGER NOT NULL,requested_wording TEXT NOT NULL,quantity TEXT NOT NULL,requested_uom TEXT NOT NULL,row_remark TEXT,resolved_product_id TEXT,resolved_uom TEXT,evidence_refs_json TEXT,UNIQUE(draft_id,line_no),FOREIGN KEY(draft_id) REFERENCES order_drafts(id));
CREATE TABLE IF NOT EXISTS order_draft_revisions(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL,revision INTEGER NOT NULL,base_revision INTEGER NOT NULL,action_type TEXT NOT NULL,actor_type TEXT NOT NULL,actor_id TEXT,source_message_id TEXT,idempotency_key TEXT NOT NULL,normalized_input_hash TEXT NOT NULL,immutable_snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(draft_id,revision),UNIQUE(draft_id,idempotency_key),FOREIGN KEY(draft_id) REFERENCES order_drafts(id));
CREATE INDEX IF NOT EXISTS order_draft_revisions_source_idx ON order_draft_revisions(source_message_id);
CREATE TABLE IF NOT EXISTS workspace_provenance_links(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,work_item_id TEXT NOT NULL,draft_id TEXT,draft_revision INTEGER,source_message_id TEXT,quotation_id TEXT,handoff_id TEXT,link_type TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(work_item_id) REFERENCES work_items(id),FOREIGN KEY(draft_id) REFERENCES order_drafts(id));
CREATE INDEX IF NOT EXISTS workspace_provenance_trace_idx ON workspace_provenance_links(work_item_id,draft_id,draft_revision);
CREATE TABLE IF NOT EXISTS v2_order_validations(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL,draft_revision INTEGER NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('DRAFT','QUOTE_TIME')),status TEXT NOT NULL,result_json TEXT NOT NULL,evidence_refs_json TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(draft_id) REFERENCES order_drafts(id));
CREATE INDEX IF NOT EXISTS v2_order_validations_revision_idx ON v2_order_validations(draft_id,draft_revision,created_at);
CREATE TRIGGER IF NOT EXISTS v2_order_validations_insert_guard BEFORE INSERT ON v2_order_validations WHEN v2_validation_write_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'V2_VALIDATION_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS v2_order_validations_no_update BEFORE UPDATE ON v2_order_validations WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V2_ORDER_VALIDATION'); END;
CREATE TRIGGER IF NOT EXISTS v2_order_validations_no_delete BEFORE DELETE ON v2_order_validations WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V2_ORDER_VALIDATION'); END;
CREATE TABLE IF NOT EXISTS workspace_authority(account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,work_item_type TEXT NOT NULL CHECK(work_item_type='SALES_ORDER_REQUEST'),migration_state TEXT NOT NULL CHECK(migration_state IN ('V1_ONLY','SHADOW_IMPORT','V2_CANARY','V2_PRIMARY','LEGACY_RETIRED')),authoritative_writer TEXT NOT NULL CHECK((migration_state IN ('V1_ONLY','SHADOW_IMPORT') AND authoritative_writer='LEGACY') OR (migration_state IN ('V2_CANARY','V2_PRIMARY','LEGACY_RETIRED') AND authoritative_writer='V2')),work_item_id TEXT,legacy_source_hash TEXT,legacy_schema_version TEXT,quarantine_reason TEXT,last_migration_event_id TEXT,revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(account_id,conversation_id,work_item_type));
CREATE INDEX IF NOT EXISTS workspace_authority_state_idx ON workspace_authority(migration_state,authoritative_writer);
CREATE TABLE IF NOT EXISTS workspace_migration_events(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,work_item_type TEXT NOT NULL CHECK(work_item_type='SALES_ORDER_REQUEST'),event_type TEXT NOT NULL,from_state TEXT,to_state TEXT NOT NULL,authoritative_writer TEXT NOT NULL,previous_event_id TEXT,work_item_id TEXT,draft_id TEXT,draft_revision INTEGER,legacy_source_hash TEXT,legacy_schema_version TEXT,idempotency_key TEXT NOT NULL,normalized_input_hash TEXT NOT NULL,immutable_snapshot_json TEXT NOT NULL,approval_subject TEXT,approval_action TEXT,created_at TEXT NOT NULL,UNIQUE(account_id,conversation_id,work_item_type,idempotency_key));
CREATE INDEX IF NOT EXISTS workspace_migration_trace_idx ON workspace_migration_events(account_id,conversation_id,created_at);

CREATE TRIGGER IF NOT EXISTS customer_order_memory_pending_retired_insert_guard BEFORE INSERT ON customer_order_memory
WHEN NEW.memory_type='pending_order' AND EXISTS(
  SELECT 1 FROM workspace_authority a JOIN conversations c ON c.id=a.conversation_id AND c.channel_account_id=a.account_id
  WHERE a.conversation_id=NEW.key_text AND a.migration_state='LEGACY_RETIRED' AND a.authoritative_writer='V2'
)
BEGIN SELECT RAISE(ABORT,'LEGACY_PENDING_ORDER_RETIRED'); END;
CREATE TRIGGER IF NOT EXISTS customer_order_memory_pending_retired_update_guard BEFORE UPDATE ON customer_order_memory
WHEN (NEW.memory_type='pending_order' OR OLD.memory_type='pending_order') AND (
  EXISTS(SELECT 1 FROM workspace_authority a JOIN conversations c ON c.id=a.conversation_id AND c.channel_account_id=a.account_id WHERE a.conversation_id=OLD.key_text AND a.migration_state='LEGACY_RETIRED' AND a.authoritative_writer='V2') OR
  EXISTS(SELECT 1 FROM workspace_authority a JOIN conversations c ON c.id=a.conversation_id AND c.channel_account_id=a.account_id WHERE a.conversation_id=NEW.key_text AND a.migration_state='LEGACY_RETIRED' AND a.authoritative_writer='V2')
)
BEGIN SELECT RAISE(ABORT,'LEGACY_PENDING_ORDER_RETIRED'); END;
CREATE TRIGGER IF NOT EXISTS customer_order_memory_pending_cleanup_delete_guard BEFORE DELETE ON customer_order_memory
WHEN OLD.memory_type='pending_order' AND v2_workspace_reset_authorized() <> 1
  AND EXISTS(
    SELECT 1 FROM workspace_authority a JOIN conversations c ON c.id=a.conversation_id AND c.channel_account_id=a.account_id
    WHERE a.conversation_id=OLD.key_text AND a.migration_state='LEGACY_RETIRED' AND a.authoritative_writer='V2'
  )
  AND NOT (
    v2_workspace_migration_authorized()=1 AND v2_workspace_migration_action()='CLEANUP_LEGACY' AND v2_workspace_migration_owner()='MIGRATION_OWNER'
    AND v2_workspace_migration_account() IS NOT NULL AND v2_workspace_migration_conversation() IS NOT NULL AND v2_workspace_migration_customer() IS NOT NULL
    AND OLD.key_text=v2_workspace_migration_conversation() AND OLD.customer_id=v2_workspace_migration_customer()
    AND EXISTS(SELECT 1 FROM workspace_authority a JOIN conversations c ON c.id=a.conversation_id AND c.channel_account_id=a.account_id
      WHERE a.account_id=v2_workspace_migration_account() AND a.conversation_id=OLD.key_text AND a.migration_state='LEGACY_RETIRED' AND a.authoritative_writer='V2')
  )
BEGIN SELECT RAISE(ABORT,'LEGACY_PENDING_ORDER_CLEANUP_REQUIRED'); END;

CREATE TRIGGER IF NOT EXISTS workspace_authority_insert_guard BEFORE INSERT ON workspace_authority
WHEN v2_workspace_authority_init_authorized() <> 1
BEGIN
  SELECT RAISE(ABORT,'WORKSPACE_AUTHORITY_INIT_REQUIRED');
END;
CREATE TRIGGER IF NOT EXISTS workspace_authority_insert_shape BEFORE INSERT ON workspace_authority
WHEN NEW.migration_state <> 'V1_ONLY' OR NEW.authoritative_writer <> 'LEGACY' OR NEW.last_migration_event_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'INVALID_WORKSPACE_AUTHORITY_INITIAL_STATE');
END;
CREATE TRIGGER IF NOT EXISTS workspace_authority_delete_guard BEFORE DELETE ON workspace_authority
WHEN v2_workspace_reset_authorized() <> 1
BEGIN
  SELECT RAISE(ABORT,'WORKSPACE_AUTHORITY_DELETE_FORBIDDEN');
END;

CREATE TRIGGER IF NOT EXISTS workspace_migration_event_insert_guard BEFORE INSERT ON workspace_migration_events
WHEN v2_workspace_reset_authorized() <> 1
BEGIN
  SELECT CASE WHEN v2_workspace_migration_authorized() <> 1 THEN RAISE(ABORT,'WORKSPACE_MIGRATION_REQUIRED') END;
  SELECT CASE WHEN NEW.account_id<>v2_workspace_migration_account() OR NEW.conversation_id<>v2_workspace_migration_conversation() OR NEW.from_state<>v2_workspace_migration_expected_state() THEN RAISE(ABORT,'WORKSPACE_MIGRATION_DESCRIPTOR_MISMATCH') END;
  SELECT CASE WHEN NEW.approval_action IS NULL OR NEW.approval_action<>v2_workspace_migration_action()
    OR NEW.approval_subject IS NULL OR NEW.approval_subject<>v2_workspace_migration_subject()
    THEN RAISE(ABORT,'WORKSPACE_MIGRATION_APPROVAL_MISMATCH') END;
END;

CREATE TRIGGER IF NOT EXISTS workspace_authority_migration_guard BEFORE UPDATE ON workspace_authority
WHEN v2_workspace_reset_authorized() <> 1 AND (
  OLD.migration_state <> NEW.migration_state OR OLD.authoritative_writer <> NEW.authoritative_writer OR
  COALESCE(OLD.legacy_source_hash,'') <> COALESCE(NEW.legacy_source_hash,'') OR
  COALESCE(OLD.legacy_schema_version,'') <> COALESCE(NEW.legacy_schema_version,'') OR
  COALESCE(OLD.quarantine_reason,'') <> COALESCE(NEW.quarantine_reason,'') OR
  COALESCE(OLD.last_migration_event_id,'') <> COALESCE(NEW.last_migration_event_id,'') OR
  OLD.revision <> NEW.revision
)
BEGIN
  SELECT CASE WHEN v2_workspace_migration_authorized() <> 1 THEN RAISE(ABORT,'WORKSPACE_AUTHORITY_MIGRATION_REQUIRED') END;
  SELECT CASE WHEN OLD.account_id<>v2_workspace_migration_account() OR OLD.conversation_id<>v2_workspace_migration_conversation() OR OLD.migration_state<>v2_workspace_migration_expected_state() OR OLD.revision<>v2_workspace_migration_expected_revision() OR OLD.work_item_id IS NOT v2_workspace_migration_expected_work_item() THEN RAISE(ABORT,'WORKSPACE_MIGRATION_DESCRIPTOR_MISMATCH') END;
  SELECT CASE WHEN NEW.revision<>OLD.revision+1 THEN RAISE(ABORT,'WORKSPACE_MIGRATION_REVISION_REQUIRED') END;
  SELECT CASE WHEN NOT (
    (OLD.migration_state='V1_ONLY' AND NEW.migration_state='SHADOW_IMPORT' AND NEW.authoritative_writer='LEGACY'
      AND v2_workspace_migration_action()='SHADOW_IMPORT' AND v2_workspace_migration_owner()='MIGRATION_OWNER'
      AND (SELECT e.event_type FROM workspace_migration_events e WHERE e.id=NEW.last_migration_event_id) IN ('SHADOW_IMPORT','SHADOW_IMPORT_QUARANTINE')) OR
    (OLD.migration_state='SHADOW_IMPORT' AND NEW.migration_state='SHADOW_IMPORT' AND NEW.authoritative_writer='LEGACY'
      AND v2_workspace_migration_action()='SHADOW_IMPORT' AND v2_workspace_migration_owner()='MIGRATION_OWNER'
      AND (SELECT e.event_type FROM workspace_migration_events e WHERE e.id=NEW.last_migration_event_id) IN ('SHADOW_IMPORT','SHADOW_IMPORT_QUARANTINE')) OR
    (OLD.migration_state='SHADOW_IMPORT' AND NEW.migration_state='SHADOW_IMPORT' AND NEW.authoritative_writer='LEGACY'
      AND v2_workspace_migration_action()='PROMOTE_CANARY' AND v2_workspace_migration_owner()='V1_OWNER'
      AND (SELECT e.event_type FROM workspace_migration_events e WHERE e.id=NEW.last_migration_event_id)='PROMOTE_QUARANTINE') OR
    (OLD.migration_state='SHADOW_IMPORT' AND NEW.migration_state='V2_CANARY' AND NEW.authoritative_writer='V2'
      AND v2_workspace_migration_action()='PROMOTE_CANARY' AND v2_workspace_migration_owner()='V1_OWNER'
      AND (SELECT e.event_type FROM workspace_migration_events e WHERE e.id=NEW.last_migration_event_id)='PROMOTE_CANARY') OR
    (OLD.migration_state='V2_CANARY' AND NEW.migration_state='V2_CANARY' AND NEW.authoritative_writer='V2'
      AND v2_workspace_migration_action()='PROMOTE_PRIMARY' AND v2_workspace_migration_owner()='MIGRATION_OWNER'
      AND (SELECT e.event_type FROM workspace_migration_events e WHERE e.id=NEW.last_migration_event_id)='PROMOTE_PRIMARY_QUARANTINE') OR
    (OLD.migration_state='V2_CANARY' AND NEW.migration_state='V2_PRIMARY' AND NEW.authoritative_writer='V2'
      AND v2_workspace_migration_action()='PROMOTE_PRIMARY' AND v2_workspace_migration_owner()='MIGRATION_OWNER'
      AND (SELECT e.event_type FROM workspace_migration_events e WHERE e.id=NEW.last_migration_event_id)='PROMOTE_PRIMARY') OR
    (OLD.migration_state='V2_PRIMARY' AND NEW.migration_state='V2_PRIMARY' AND NEW.authoritative_writer='V2'
      AND v2_workspace_migration_action()='RETIRE_LEGACY' AND v2_workspace_migration_owner()='MIGRATION_OWNER'
      AND (SELECT e.event_type FROM workspace_migration_events e WHERE e.id=NEW.last_migration_event_id)='RETIRE_LEGACY_QUARANTINE') OR
    (OLD.migration_state='V2_PRIMARY' AND NEW.migration_state='LEGACY_RETIRED' AND NEW.authoritative_writer='V2'
      AND v2_workspace_migration_action()='RETIRE_LEGACY' AND v2_workspace_migration_owner()='MIGRATION_OWNER'
      AND (SELECT e.event_type FROM workspace_migration_events e WHERE e.id=NEW.last_migration_event_id)='RETIRE_LEGACY') OR
    (OLD.migration_state='LEGACY_RETIRED' AND NEW.migration_state='LEGACY_RETIRED' AND NEW.authoritative_writer='V2'
      AND v2_workspace_migration_action()='CLEANUP_LEGACY' AND v2_workspace_migration_owner()='MIGRATION_OWNER'
      AND (SELECT e.event_type FROM workspace_migration_events e WHERE e.id=NEW.last_migration_event_id)='LEGACY_CLEANUP') OR
    (OLD.migration_state IN ('V2_CANARY','V2_PRIMARY') AND NEW.migration_state='V1_ONLY' AND NEW.authoritative_writer='LEGACY'
      AND v2_workspace_migration_action()='ROLLBACK' AND v2_workspace_migration_owner()='V1_OWNER'
      AND (SELECT e.event_type FROM workspace_migration_events e WHERE e.id=NEW.last_migration_event_id)='ROLLBACK')
  ) THEN RAISE(ABORT,'INVALID_WORKSPACE_AUTHORITY_TRANSITION') END;
  SELECT CASE WHEN NEW.last_migration_event_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM workspace_migration_events e
    WHERE e.id=NEW.last_migration_event_id AND e.account_id=NEW.account_id AND e.conversation_id=NEW.conversation_id
      AND e.work_item_type=NEW.work_item_type AND COALESCE(e.from_state,'')=COALESCE(OLD.migration_state,'')
      AND e.to_state=NEW.migration_state AND e.authoritative_writer=NEW.authoritative_writer
      AND COALESCE(e.previous_event_id,'')=COALESCE(OLD.last_migration_event_id,'')
      AND e.approval_action=v2_workspace_migration_action()
      AND e.approval_subject=v2_workspace_migration_subject()
  ) THEN RAISE(ABORT,'WORKSPACE_MIGRATION_EVIDENCE_REQUIRED') END;
END;

CREATE TRIGGER IF NOT EXISTS work_item_events_no_update BEFORE UPDATE ON work_item_events WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WORK_ITEM_EVENT'); END;
CREATE TRIGGER IF NOT EXISTS work_item_events_no_delete BEFORE DELETE ON work_item_events WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WORK_ITEM_EVENT'); END;
CREATE TRIGGER IF NOT EXISTS order_draft_revisions_no_update BEFORE UPDATE ON order_draft_revisions WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DRAFT_REVISION'); END;
CREATE TRIGGER IF NOT EXISTS order_draft_revisions_no_delete BEFORE DELETE ON order_draft_revisions WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DRAFT_REVISION'); END;
CREATE TRIGGER IF NOT EXISTS workspace_migration_events_no_update BEFORE UPDATE ON workspace_migration_events WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WORKSPACE_MIGRATION_EVENT'); END;
CREATE TRIGGER IF NOT EXISTS workspace_migration_events_no_delete BEFORE DELETE ON workspace_migration_events WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WORKSPACE_MIGRATION_EVENT'); END;
CREATE TRIGGER IF NOT EXISTS workspace_provenance_no_update BEFORE UPDATE ON workspace_provenance_links WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WORKSPACE_PROVENANCE'); END;
CREATE TRIGGER IF NOT EXISTS workspace_provenance_no_delete BEFORE DELETE ON workspace_provenance_links WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WORKSPACE_PROVENANCE'); END;

-- V2 CTX-001 profile configuration. Profile data narrows registry access; it is never authorization by itself.
CREATE TABLE IF NOT EXISTS employee_profiles(id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>0),role TEXT NOT NULL,mission TEXT NOT NULL,tone TEXT NOT NULL,language_policy_json TEXT NOT NULL,capability_permissions_json TEXT NOT NULL,forbidden_commitments_json TEXT NOT NULL,escalation_rules_json TEXT NOT NULL,turn_budgets_json TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);

-- V2 CTX-002 derived, non-authoritative conversation summaries. Versions are append-only projections.
CREATE TABLE IF NOT EXISTS conversation_summaries(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),summary_text TEXT NOT NULL,source_message_ids_json TEXT NOT NULL,evidence_refs_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(account_id,conversation_id,version));
CREATE INDEX IF NOT EXISTS conversation_summaries_latest_idx ON conversation_summaries(account_id,conversation_id,version DESC);

-- V2 PI-001 operational provenance only. These tables never own commerce truth.
CREATE TABLE IF NOT EXISTS agent_turns(
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  inbound_message_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK(profile_version>0),
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('AWAITING_DECISION','RECONCILE_ACTION','TERMINAL')),
  context_fingerprint TEXT NOT NULL,
  context_snapshot_json TEXT NOT NULL,
  context_provenance_json TEXT NOT NULL,
  budget_provenance_json TEXT NOT NULL DEFAULT '{}',
  runtime_started_at TEXT,
  runtime_deadline_at TEXT,
  terminal_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(account_id,conversation_id,inbound_message_id),
  FOREIGN KEY(inbound_message_id) REFERENCES messages(id)
);
CREATE INDEX IF NOT EXISTS agent_turns_scope_idx ON agent_turns(account_id,conversation_id);

CREATE TABLE IF NOT EXISTS agent_actions(
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  capability_name TEXT NOT NULL,
  capability_version TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(turn_id,sequence),
  FOREIGN KEY(turn_id) REFERENCES agent_turns(id)
);
CREATE INDEX IF NOT EXISTS agent_actions_turn_idx ON agent_actions(turn_id,sequence);

CREATE TABLE IF NOT EXISTS agent_model_attempts(
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  attempt_kind TEXT NOT NULL CHECK(attempt_kind IN ('MODEL','REPAIR')),
  reason_code TEXT NOT NULL,
  observation_hash TEXT NOT NULL DEFAULT '',
  projection_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(turn_id,sequence),
  FOREIGN KEY(turn_id) REFERENCES agent_turns(id)
);
CREATE INDEX IF NOT EXISTS agent_model_attempts_turn_idx ON agent_model_attempts(turn_id,sequence);


-- Operator-safe Demo endpoint observability. This is diagnostic evidence only and never commerce authority.
CREATE TABLE IF NOT EXISTS agent_endpoint_traces(
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  attempt_sequence INTEGER NOT NULL CHECK(attempt_sequence>0),
  attempt_kind TEXT NOT NULL CHECK(attempt_kind IN ('MODEL','REPAIR')),
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('SUCCEEDED','FAILED')),
  error_code TEXT,
  latency_ms INTEGER NOT NULL CHECK(latency_ms>=0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens>=0),
  created_at TEXT NOT NULL,
  UNIQUE(turn_id,attempt_sequence),
  FOREIGN KEY(turn_id,attempt_sequence) REFERENCES agent_model_attempts(turn_id,sequence)
);
CREATE INDEX IF NOT EXISTS agent_endpoint_traces_turn_idx ON agent_endpoint_traces(turn_id,attempt_sequence);
CREATE TRIGGER IF NOT EXISTS agent_endpoint_traces_scope_guard BEFORE INSERT ON agent_endpoint_traces WHEN NOT EXISTS(
  SELECT 1 FROM agent_model_attempts a WHERE a.turn_id=NEW.turn_id AND a.sequence=NEW.attempt_sequence AND a.attempt_kind=NEW.attempt_kind
) BEGIN SELECT RAISE(ABORT,'AGENT_ENDPOINT_TRACE_SCOPE'); END;
CREATE TRIGGER IF NOT EXISTS agent_endpoint_traces_no_update BEFORE UPDATE ON agent_endpoint_traces WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_ENDPOINT_TRACE'); END;
CREATE TRIGGER IF NOT EXISTS agent_endpoint_traces_no_delete BEFORE DELETE ON agent_endpoint_traces WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_ENDPOINT_TRACE'); END;

CREATE TABLE IF NOT EXISTS agent_model_attempt_evidence(
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  attempt_kind TEXT NOT NULL CHECK(attempt_kind IN ('MODEL','REPAIR')),
  observation_hash TEXT NOT NULL,
  projection_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('VALID','REPAIR_PENDING')),
  created_at TEXT NOT NULL,
  UNIQUE(turn_id,sequence,phase),
  FOREIGN KEY(turn_id) REFERENCES agent_turns(id),
  FOREIGN KEY(turn_id,sequence) REFERENCES agent_model_attempts(turn_id,sequence)
);
CREATE INDEX IF NOT EXISTS agent_model_attempt_evidence_latest_idx ON agent_model_attempt_evidence(turn_id,sequence);

CREATE TABLE IF NOT EXISTS agent_repair_evidence(
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  decision_sequence INTEGER NOT NULL CHECK(decision_sequence>0),
  event_sequence INTEGER NOT NULL CHECK(event_sequence>0),
  observation_hash TEXT NOT NULL,
  projection_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('PENDING','RESERVED','VALID','FAILED','COMMITTED')),
  created_at TEXT NOT NULL,
  UNIQUE(turn_id,event_sequence),
  FOREIGN KEY(turn_id) REFERENCES agent_turns(id)
);
CREATE INDEX IF NOT EXISTS agent_repair_evidence_latest_idx ON agent_repair_evidence(turn_id,event_sequence DESC);

CREATE TABLE IF NOT EXISTS agent_action_execution_events(
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  outcome TEXT NOT NULL CHECK(outcome IN ('TIMEOUT','CANCELLED')),
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(turn_id) REFERENCES agent_turns(id),
  FOREIGN KEY(action_id) REFERENCES agent_actions(id)
);
CREATE INDEX IF NOT EXISTS agent_action_execution_events_turn_idx ON agent_action_execution_events(turn_id,sequence);

CREATE TABLE IF NOT EXISTS agent_response_plans(
  turn_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(turn_id) REFERENCES agent_turns(id)
);
CREATE TRIGGER IF NOT EXISTS agent_response_plans_insert_guard BEFORE INSERT ON agent_response_plans WHEN v2_agent_turn_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'AGENT_RESPONSE_PLAN_INSERT_REQUIRES_COORDINATOR'); END;
CREATE TRIGGER IF NOT EXISTS agent_response_plans_no_update BEFORE UPDATE ON agent_response_plans WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_RESPONSE_PLAN'); END;
CREATE TRIGGER IF NOT EXISTS agent_response_plans_no_delete BEFORE DELETE ON agent_response_plans WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_RESPONSE_PLAN'); END;

CREATE TABLE IF NOT EXISTS grounding_verdicts(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),plan_hash TEXT NOT NULL,authority_fingerprint TEXT NOT NULL,verdict TEXT NOT NULL CHECK(verdict IN ('PASS','REJECT')),verdict_json TEXT NOT NULL,verdict_hash TEXT NOT NULL,verified_at TEXT NOT NULL,FOREIGN KEY(turn_id) REFERENCES agent_turns(id),UNIQUE(turn_id,sequence));
CREATE INDEX IF NOT EXISTS grounding_verdicts_latest_idx ON grounding_verdicts(turn_id,sequence DESC);
CREATE TRIGGER IF NOT EXISTS grounding_verdicts_insert_guard BEFORE INSERT ON grounding_verdicts WHEN v2_response_grounding_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'GROUNDING_INSERT_REQUIRES_GUARD'); END;
CREATE TRIGGER IF NOT EXISTS grounding_verdicts_no_update BEFORE UPDATE ON grounding_verdicts WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_GROUNDING_VERDICT'); END;
CREATE TRIGGER IF NOT EXISTS grounding_verdicts_no_delete BEFORE DELETE ON grounding_verdicts WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_GROUNDING_VERDICT'); END;
CREATE TABLE IF NOT EXISTS commercial_integrity_seals(id TEXT PRIMARY KEY,entity_type TEXT NOT NULL CHECK(entity_type IN ('QUOTATION','ACCEPTANCE','SALES_ORDER')),entity_id TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,customer_id TEXT NOT NULL,lineage_id TEXT NOT NULL,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,sealed_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS commercial_seals_insert_guard BEFORE INSERT ON commercial_integrity_seals WHEN v2_commerce_seal_write_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'COMMERCIAL_SEAL_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS commercial_seals_no_update BEFORE UPDATE ON commercial_integrity_seals WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_COMMERCIAL_SEAL'); END;
CREATE TRIGGER IF NOT EXISTS commercial_seals_no_delete BEFORE DELETE ON commercial_integrity_seals WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_COMMERCIAL_SEAL'); END;

CREATE TABLE IF NOT EXISTS agent_action_results(
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  result_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(turn_id,sequence),
  FOREIGN KEY(turn_id) REFERENCES agent_turns(id),
  FOREIGN KEY(action_id) REFERENCES agent_actions(id)
);
CREATE INDEX IF NOT EXISTS agent_action_results_turn_idx ON agent_action_results(turn_id,sequence);

CREATE TRIGGER IF NOT EXISTS agent_turns_insert_guard BEFORE INSERT ON agent_turns WHEN v2_agent_turn_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'AGENT_TURN_INSERT_REQUIRES_COORDINATOR'); END;
CREATE TRIGGER IF NOT EXISTS agent_turns_identity_immutable BEFORE UPDATE ON agent_turns WHEN NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.conversation_id<>OLD.conversation_id OR NEW.inbound_message_id<>OLD.inbound_message_id OR NEW.profile_id<>OLD.profile_id OR NEW.profile_version<>OLD.profile_version OR NEW.timezone<>OLD.timezone OR NEW.context_fingerprint<>OLD.context_fingerprint OR NEW.context_snapshot_json<>OLD.context_snapshot_json OR NEW.context_provenance_json<>OLD.context_provenance_json OR NEW.budget_provenance_json<>OLD.budget_provenance_json OR NEW.runtime_started_at IS NOT OLD.runtime_started_at OR NEW.runtime_deadline_at IS NOT OLD.runtime_deadline_at BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_TURN_IDENTITY'); END;
CREATE TRIGGER IF NOT EXISTS agent_turns_no_update BEFORE UPDATE ON agent_turns WHEN v2_workspace_reset_authorized() <> 1 AND v2_agent_turn_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_TURN'); END;
CREATE TRIGGER IF NOT EXISTS agent_turns_no_delete BEFORE DELETE ON agent_turns WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_TURN'); END;
CREATE TRIGGER IF NOT EXISTS agent_actions_insert_guard BEFORE INSERT ON agent_actions WHEN v2_agent_turn_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'AGENT_ACTION_INSERT_REQUIRES_COORDINATOR'); END;
CREATE TRIGGER IF NOT EXISTS agent_actions_no_update BEFORE UPDATE ON agent_actions WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_ACTION'); END;
CREATE TRIGGER IF NOT EXISTS agent_actions_no_delete BEFORE DELETE ON agent_actions WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_ACTION'); END;
CREATE TRIGGER IF NOT EXISTS agent_action_results_insert_guard BEFORE INSERT ON agent_action_results WHEN v2_agent_turn_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'AGENT_ACTION_RESULT_INSERT_REQUIRES_COORDINATOR'); END;
CREATE TRIGGER IF NOT EXISTS agent_action_results_scope_guard BEFORE INSERT ON agent_action_results WHEN NOT EXISTS(SELECT 1 FROM agent_actions a WHERE a.id=NEW.action_id AND a.turn_id=NEW.turn_id AND a.sequence=NEW.sequence) BEGIN SELECT RAISE(ABORT,'AGENT_ACTION_RESULT_SCOPE'); END;
CREATE TRIGGER IF NOT EXISTS agent_action_results_no_update BEFORE UPDATE ON agent_action_results WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_ACTION_RESULT'); END;
CREATE TRIGGER IF NOT EXISTS agent_action_results_no_delete BEFORE DELETE ON agent_action_results WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_ACTION_RESULT'); END;
CREATE TRIGGER IF NOT EXISTS agent_model_attempts_insert_guard BEFORE INSERT ON agent_model_attempts WHEN v2_agent_turn_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'AGENT_MODEL_ATTEMPT_INSERT_REQUIRES_COORDINATOR'); END;
CREATE TRIGGER IF NOT EXISTS agent_model_attempts_no_update BEFORE UPDATE ON agent_model_attempts WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_MODEL_ATTEMPT'); END;
CREATE TRIGGER IF NOT EXISTS agent_model_attempts_no_delete BEFORE DELETE ON agent_model_attempts WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_MODEL_ATTEMPT'); END;
CREATE TRIGGER IF NOT EXISTS agent_model_attempt_evidence_insert_guard BEFORE INSERT ON agent_model_attempt_evidence WHEN v2_agent_turn_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'AGENT_MODEL_ATTEMPT_EVIDENCE_INSERT_REQUIRES_COORDINATOR'); END;
CREATE TRIGGER IF NOT EXISTS agent_model_attempt_evidence_scope_guard BEFORE INSERT ON agent_model_attempt_evidence WHEN NOT EXISTS(SELECT 1 FROM agent_model_attempts a WHERE a.turn_id=NEW.turn_id AND a.sequence=NEW.sequence AND a.attempt_kind=NEW.attempt_kind) BEGIN SELECT RAISE(ABORT,'AGENT_MODEL_ATTEMPT_EVIDENCE_SCOPE'); END;
CREATE TRIGGER IF NOT EXISTS agent_model_attempt_evidence_no_update BEFORE UPDATE ON agent_model_attempt_evidence WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_MODEL_ATTEMPT_EVIDENCE'); END;
CREATE TRIGGER IF NOT EXISTS agent_model_attempt_evidence_no_delete BEFORE DELETE ON agent_model_attempt_evidence WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_MODEL_ATTEMPT_EVIDENCE'); END;
CREATE TRIGGER IF NOT EXISTS agent_repair_evidence_insert_guard BEFORE INSERT ON agent_repair_evidence WHEN v2_agent_turn_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'AGENT_REPAIR_EVIDENCE_INSERT_REQUIRES_COORDINATOR'); END;
CREATE TRIGGER IF NOT EXISTS agent_repair_evidence_no_update BEFORE UPDATE ON agent_repair_evidence WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_REPAIR_EVIDENCE'); END;
CREATE TRIGGER IF NOT EXISTS agent_repair_evidence_no_delete BEFORE DELETE ON agent_repair_evidence WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_REPAIR_EVIDENCE'); END;
CREATE TRIGGER IF NOT EXISTS agent_action_execution_events_insert_guard BEFORE INSERT ON agent_action_execution_events WHEN v2_agent_turn_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'AGENT_ACTION_EXECUTION_EVENT_INSERT_REQUIRES_COORDINATOR'); END;
CREATE TRIGGER IF NOT EXISTS agent_action_execution_events_scope_guard BEFORE INSERT ON agent_action_execution_events WHEN NOT EXISTS(SELECT 1 FROM agent_actions a WHERE a.id=NEW.action_id AND a.turn_id=NEW.turn_id AND a.sequence=NEW.sequence) BEGIN SELECT RAISE(ABORT,'AGENT_ACTION_EXECUTION_EVENT_SCOPE'); END;
CREATE TRIGGER IF NOT EXISTS agent_action_execution_events_no_update BEFORE UPDATE ON agent_action_execution_events WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_ACTION_EXECUTION_EVENT'); END;
CREATE TRIGGER IF NOT EXISTS agent_action_execution_events_no_delete BEFORE DELETE ON agent_action_execution_events WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AGENT_ACTION_EXECUTION_EVENT'); END;
CREATE TABLE IF NOT EXISTS v2_capability_rollouts(
  capability TEXT NOT NULL,
  account_id TEXT,
  conversation_id TEXT,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(capability,account_id,conversation_id),
  CHECK((account_id IS NULL AND conversation_id IS NULL) OR account_id IS NOT NULL),
  FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS v2_capability_rollouts_scope_idx ON v2_capability_rollouts(capability,account_id,conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS v2_capability_rollouts_global_unique ON v2_capability_rollouts(capability) WHERE account_id IS NULL AND conversation_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS v2_capability_rollouts_account_unique ON v2_capability_rollouts(capability,account_id) WHERE account_id IS NOT NULL AND conversation_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS v2_capability_rollouts_conversation_unique ON v2_capability_rollouts(capability,account_id,conversation_id) WHERE account_id IS NOT NULL AND conversation_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS v2_capability_rollouts_scope_shape_insert BEFORE INSERT ON v2_capability_rollouts WHEN NEW.account_id IS NULL AND NEW.conversation_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'ROLLOUT_ACCOUNT_SCOPE_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS v2_capability_rollouts_scope_shape_update BEFORE UPDATE ON v2_capability_rollouts WHEN NEW.account_id IS NULL AND NEW.conversation_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'ROLLOUT_ACCOUNT_SCOPE_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS v2_capability_rollouts_conversation_account_insert BEFORE INSERT ON v2_capability_rollouts WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND channel_account_id=NEW.account_id) BEGIN SELECT RAISE(ABORT,'ROLLOUT_CONVERSATION_SCOPE'); END;
CREATE TRIGGER IF NOT EXISTS v2_capability_rollouts_conversation_account_update BEFORE UPDATE ON v2_capability_rollouts WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND channel_account_id=NEW.account_id) BEGIN SELECT RAISE(ABORT,'ROLLOUT_CONVERSATION_SCOPE'); END;
CREATE TABLE IF NOT EXISTS v2_rollout_events(
  id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  account_id TEXT,
  conversation_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('ENABLE','DISABLE','ROLLBACK')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  idempotency_key TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  approval_subject TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS v2_rollout_events_scope_idx ON v2_rollout_events(capability,account_id,conversation_id,created_at);
CREATE TRIGGER IF NOT EXISTS v2_capability_rollouts_insert_guard BEFORE INSERT ON v2_capability_rollouts WHEN v2_rollout_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'ROLLOUT_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS v2_capability_rollouts_update_guard BEFORE UPDATE ON v2_capability_rollouts WHEN v2_rollout_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'ROLLOUT_UPDATE_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS v2_rollout_events_insert_guard BEFORE INSERT ON v2_rollout_events WHEN v2_rollout_mutation_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'ROLLOUT_EVENT_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS v2_capability_rollouts_context_guard BEFORE INSERT ON v2_capability_rollouts WHEN v2_rollout_mutation_authorized()=1 AND (NEW.capability<>v2_rollout_mutation_capability() OR NEW.account_id IS NOT v2_rollout_mutation_account() OR NEW.conversation_id IS NOT v2_rollout_mutation_conversation() OR NEW.enabled<>v2_rollout_mutation_enabled() OR NEW.updated_by<>v2_rollout_mutation_subject() OR (v2_rollout_mutation_action()='ENABLE' AND NEW.enabled<>1) OR (v2_rollout_mutation_action() IN ('DISABLE','ROLLBACK') AND NEW.enabled<>0)) BEGIN SELECT RAISE(ABORT,'ROLLOUT_MUTATION_CONTEXT_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS v2_capability_rollouts_update_context_guard BEFORE UPDATE ON v2_capability_rollouts WHEN v2_rollout_mutation_authorized()=1 AND (NEW.capability<>v2_rollout_mutation_capability() OR NEW.account_id IS NOT v2_rollout_mutation_account() OR NEW.conversation_id IS NOT v2_rollout_mutation_conversation() OR NEW.enabled<>v2_rollout_mutation_enabled() OR NEW.updated_by<>v2_rollout_mutation_subject() OR (v2_rollout_mutation_action()='ENABLE' AND NEW.enabled<>1) OR (v2_rollout_mutation_action() IN ('DISABLE','ROLLBACK') AND NEW.enabled<>0)) BEGIN SELECT RAISE(ABORT,'ROLLOUT_MUTATION_CONTEXT_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS v2_rollout_events_conversation_account_guard BEFORE INSERT ON v2_rollout_events WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND channel_account_id=NEW.account_id) BEGIN SELECT RAISE(ABORT,'ROLLOUT_CONVERSATION_SCOPE'); END;
CREATE TRIGGER IF NOT EXISTS v2_rollout_events_context_guard BEFORE INSERT ON v2_rollout_events WHEN v2_rollout_mutation_authorized()=1 AND (NEW.capability<>v2_rollout_mutation_capability() OR NEW.account_id IS NOT v2_rollout_mutation_account() OR NEW.conversation_id IS NOT v2_rollout_mutation_conversation() OR NEW.enabled<>v2_rollout_mutation_enabled() OR NEW.action<>v2_rollout_mutation_action() OR NEW.approval_subject<>v2_rollout_mutation_subject() OR (NEW.action='ENABLE' AND NEW.enabled<>1) OR (NEW.action IN ('DISABLE','ROLLBACK') AND NEW.enabled<>0)) BEGIN SELECT RAISE(ABORT,'ROLLOUT_MUTATION_CONTEXT_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS v2_capability_rollouts_no_delete BEFORE DELETE ON v2_capability_rollouts WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V2_ROLLOUT'); END;
CREATE TRIGGER IF NOT EXISTS v2_rollout_events_no_update BEFORE UPDATE ON v2_rollout_events WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V2_ROLLOUT_EVENT'); END;
CREATE TRIGGER IF NOT EXISTS v2_rollout_events_no_delete BEFORE DELETE ON v2_rollout_events WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V2_ROLLOUT_EVENT'); END;

-- V3-GOAL-002: shadow-only, descriptive Goal Graph history. These tables are
-- additive and intentionally have no foreign keys into commerce authority.
CREATE TABLE IF NOT EXISTS conversation_goal_events(
  event_id TEXT PRIMARY KEY CHECK(length(trim(event_id))>0),
  account_id TEXT NOT NULL CHECK(length(trim(account_id))>0),
  conversation_id TEXT NOT NULL CHECK(length(trim(conversation_id))>0),
  goal_id TEXT NOT NULL CHECK(length(trim(goal_id))>0),
  event_type TEXT NOT NULL CHECK(event_type IN ('CREATED','UPDATED','SUPERSEDED','CANCELLED')),
  goal_json TEXT NOT NULL CHECK(length(trim(goal_json))>0),
  goal_hash TEXT NOT NULL CHECK(length(trim(goal_hash))>0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key))>0),
  created_at TEXT NOT NULL CHECK(length(trim(created_at))>0),
  revision INTEGER NOT NULL CHECK(revision>0),
  UNIQUE(account_id,conversation_id,revision),
  FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS conversation_goal_events_scope_idx ON conversation_goal_events(account_id,conversation_id,goal_id,revision,event_id);
CREATE TRIGGER IF NOT EXISTS conversation_goal_events_scope_guard BEFORE INSERT ON conversation_goal_events
WHEN NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND channel_account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'V3_GOAL_EVENT_SCOPE'); END;
CREATE TRIGGER IF NOT EXISTS conversation_goal_events_insert_guard BEFORE INSERT ON conversation_goal_events
WHEN v3_goal_event_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'V3_GOAL_EVENT_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS conversation_goal_events_context_guard BEFORE INSERT ON conversation_goal_events
WHEN v3_goal_event_mutation_authorized()=1 AND (NEW.event_id IS NOT v3_goal_event_id() OR NEW.account_id IS NOT v3_goal_event_account() OR NEW.conversation_id IS NOT v3_goal_event_conversation() OR NEW.goal_id IS NOT v3_goal_event_goal() OR NEW.event_type IS NOT v3_goal_event_type() OR NEW.goal_json IS NOT v3_goal_event_json() OR NEW.goal_hash IS NOT v3_goal_event_hash() OR NEW.idempotency_key IS NOT v3_goal_event_idempotency() OR NEW.created_at IS NOT v3_goal_event_created_at() OR NEW.revision IS NOT v3_goal_event_revision())
BEGIN SELECT RAISE(ABORT,'V3_GOAL_EVENT_MUTATION_CONTEXT_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS conversation_goal_events_no_update BEFORE UPDATE ON conversation_goal_events
WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V3_GOAL_EVENT'); END;
CREATE TRIGGER IF NOT EXISTS conversation_goal_events_no_delete BEFORE DELETE ON conversation_goal_events
WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V3_GOAL_EVENT'); END;

CREATE TABLE IF NOT EXISTS conversation_goal_edges(
  edge_id TEXT PRIMARY KEY CHECK(length(trim(edge_id))>0),
  account_id TEXT NOT NULL CHECK(length(trim(account_id))>0),
  conversation_id TEXT NOT NULL CHECK(length(trim(conversation_id))>0),
  from_goal_id TEXT NOT NULL CHECK(length(trim(from_goal_id))>0),
  to_goal_id TEXT NOT NULL CHECK(length(trim(to_goal_id))>0),
  edge_type TEXT NOT NULL CHECK(edge_type IN ('PARENT','DEPENDENCY','RELATED')),
  edge_event_type TEXT NOT NULL CHECK(edge_event_type IN ('ADDED','REMOVED')),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key))>0),
  created_at TEXT NOT NULL CHECK(length(trim(created_at))>0),
  revision INTEGER NOT NULL CHECK(revision>0),
  FOREIGN KEY(conversation_id) REFERENCES conversations(id),
  CHECK(from_goal_id<>to_goal_id)
);
CREATE INDEX IF NOT EXISTS conversation_goal_edges_scope_idx ON conversation_goal_edges(account_id,conversation_id,from_goal_id,edge_type,to_goal_id,revision);
CREATE TRIGGER IF NOT EXISTS conversation_goal_edges_scope_guard BEFORE INSERT ON conversation_goal_edges
WHEN NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND channel_account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'V3_GOAL_EDGE_SCOPE'); END;
CREATE TRIGGER IF NOT EXISTS conversation_goal_edges_insert_guard BEFORE INSERT ON conversation_goal_edges
WHEN v3_goal_edge_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'V3_GOAL_EDGE_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS conversation_goal_edges_context_guard BEFORE INSERT ON conversation_goal_edges
WHEN v3_goal_edge_mutation_authorized()=1 AND (NEW.edge_id IS NOT v3_goal_edge_id() OR NEW.account_id IS NOT v3_goal_edge_account() OR NEW.conversation_id IS NOT v3_goal_edge_conversation() OR NEW.from_goal_id IS NOT v3_goal_edge_from() OR NEW.to_goal_id IS NOT v3_goal_edge_to() OR NEW.edge_type IS NOT v3_goal_edge_type() OR NEW.edge_event_type IS NOT v3_goal_edge_event_type() OR NEW.idempotency_key IS NOT v3_goal_edge_idempotency() OR NEW.created_at IS NOT v3_goal_edge_created_at() OR NEW.revision IS NOT v3_goal_edge_revision())
BEGIN SELECT RAISE(ABORT,'V3_GOAL_EDGE_MUTATION_CONTEXT_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS conversation_goal_edges_no_update BEFORE UPDATE ON conversation_goal_edges
WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V3_GOAL_EDGE'); END;
CREATE TRIGGER IF NOT EXISTS conversation_goal_edges_no_delete BEFORE DELETE ON conversation_goal_edges
WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V3_GOAL_EDGE'); END;

-- V3-GOAL-004: shadow-only durable continuation records. The JSON record is
-- immutable and derived; GOAL-005 owns wake/resume processing later.
CREATE TABLE IF NOT EXISTS durable_continuations(
  continuation_id TEXT PRIMARY KEY CHECK(length(trim(continuation_id))>0),
  account_id TEXT NOT NULL CHECK(length(trim(account_id))>0),
  conversation_id TEXT NOT NULL CHECK(length(trim(conversation_id))>0),
  work_item_id TEXT NOT NULL CHECK(length(trim(work_item_id))>0),
  goal_id TEXT NOT NULL CHECK(length(trim(goal_id))>0),
  record_json TEXT NOT NULL CHECK(length(trim(record_json))>0),
  record_hash TEXT NOT NULL CHECK(length(trim(record_hash))>0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key))>0),
  created_at TEXT NOT NULL CHECK(length(trim(created_at))>0),
  updated_at TEXT NOT NULL CHECK(length(trim(updated_at))>0),
  UNIQUE(account_id,conversation_id,goal_id,record_hash),
  FOREIGN KEY(conversation_id) REFERENCES conversations(id),
  FOREIGN KEY(work_item_id) REFERENCES work_items(id)
);
CREATE INDEX IF NOT EXISTS durable_continuations_scope_idx ON durable_continuations(account_id,conversation_id,goal_id,updated_at);
CREATE TRIGGER IF NOT EXISTS durable_continuations_scope_guard BEFORE INSERT ON durable_continuations
WHEN NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND channel_account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'V3_CONTINUATION_SCOPE'); END;
CREATE TRIGGER IF NOT EXISTS durable_continuations_insert_guard BEFORE INSERT ON durable_continuations
WHEN v3_continuation_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'V3_CONTINUATION_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS durable_continuations_context_guard BEFORE INSERT ON durable_continuations
WHEN v3_continuation_mutation_authorized()=1 AND (NEW.continuation_id IS NOT v3_continuation_id() OR NEW.account_id IS NOT v3_continuation_account() OR NEW.conversation_id IS NOT v3_continuation_conversation() OR NEW.work_item_id IS NOT v3_continuation_work() OR NEW.goal_id IS NOT v3_continuation_goal() OR NEW.record_json IS NOT v3_continuation_json() OR NEW.record_hash IS NOT v3_continuation_hash() OR NEW.idempotency_key IS NOT v3_continuation_idem() OR NEW.created_at IS NOT v3_continuation_created() OR NEW.updated_at IS NOT v3_continuation_updated())
BEGIN SELECT RAISE(ABORT,'V3_CONTINUATION_MUTATION_CONTEXT_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS durable_continuations_no_update BEFORE UPDATE ON durable_continuations
WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V3_CONTINUATION'); END;
CREATE TRIGGER IF NOT EXISTS durable_continuations_no_delete BEFORE DELETE ON durable_continuations
WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V3_CONTINUATION'); END;

-- V3-GOAL-005: append-only wake receipts. This is an attempt/idempotency
-- ledger only; V2 remains the sole lease authority.
CREATE TABLE IF NOT EXISTS v3_continuation_wake_events(
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  wake_event_id TEXT NOT NULL CHECK(length(trim(wake_event_id))>0),
  account_id TEXT NOT NULL CHECK(length(trim(account_id))>0),
  conversation_id TEXT NOT NULL CHECK(length(trim(conversation_id))>0),
  continuation_id TEXT NOT NULL CHECK(length(trim(continuation_id))>0),
  wake_id TEXT NOT NULL CHECK(length(trim(wake_id))>0),
  event_type TEXT NOT NULL CHECK(event_type IN ('ATTEMPT_RESERVED','LEASE_BOUND')),
  attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
  lease_owner TEXT,
  lease_generation INTEGER,
  payload_json TEXT NOT NULL CHECK(length(trim(payload_json))>0),
  event_hash TEXT NOT NULL CHECK(length(trim(event_hash))>0),
  created_at TEXT NOT NULL CHECK(length(trim(created_at))>0),
  FOREIGN KEY(continuation_id) REFERENCES durable_continuations(continuation_id),
  UNIQUE(account_id,conversation_id,continuation_id,wake_event_id,event_type)
);
CREATE INDEX IF NOT EXISTS v3_continuation_wake_events_scope_idx ON v3_continuation_wake_events(account_id,conversation_id,continuation_id,event_seq);
CREATE UNIQUE INDEX IF NOT EXISTS v3_continuation_wake_events_event_id_idx ON v3_continuation_wake_events(account_id,conversation_id,continuation_id,wake_event_id,event_type);
CREATE TRIGGER IF NOT EXISTS v3_continuation_wake_events_scope_guard BEFORE INSERT ON v3_continuation_wake_events
WHEN NOT EXISTS(SELECT 1 FROM durable_continuations WHERE continuation_id=NEW.continuation_id AND account_id=NEW.account_id AND conversation_id=NEW.conversation_id)
BEGIN SELECT RAISE(ABORT,'V3_WAKE_SCOPE'); END;
CREATE TRIGGER IF NOT EXISTS v3_continuation_wake_events_insert_guard BEFORE INSERT ON v3_continuation_wake_events
WHEN v3_wake_mutation_authorized() <> 1
BEGIN SELECT RAISE(ABORT,'V3_WAKE_INSERT_REQUIRES_SERVICE'); END;
CREATE TRIGGER IF NOT EXISTS v3_continuation_wake_events_context_guard BEFORE INSERT ON v3_continuation_wake_events
WHEN v3_wake_mutation_authorized()=1 AND (NEW.wake_event_id IS NOT v3_wake_event_id() OR NEW.account_id IS NOT v3_wake_account() OR NEW.conversation_id IS NOT v3_wake_conversation() OR NEW.continuation_id IS NOT v3_wake_continuation() OR NEW.wake_id IS NOT v3_wake_id() OR NEW.event_type IS NOT v3_wake_event_type() OR NEW.attempt_number IS NOT v3_wake_attempt() OR NEW.lease_owner IS NOT v3_wake_owner() OR NEW.lease_generation IS NOT v3_wake_generation() OR NEW.payload_json IS NOT v3_wake_payload() OR NEW.event_hash IS NOT v3_wake_hash() OR NEW.created_at IS NOT v3_wake_created())
BEGIN SELECT RAISE(ABORT,'V3_WAKE_MUTATION_CONTEXT_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS v3_continuation_wake_events_no_update BEFORE UPDATE ON v3_continuation_wake_events
WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V3_WAKE_EVENT'); END;
CREATE TRIGGER IF NOT EXISTS v3_continuation_wake_events_no_delete BEFORE DELETE ON v3_continuation_wake_events
WHEN v2_workspace_reset_authorized() <> 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_V3_WAKE_EVENT'); END;
CREATE VIEW IF NOT EXISTS v3_continuation_wake_current AS
SELECT e.* FROM v3_continuation_wake_events e
WHERE e.event_seq=(SELECT MAX(x.event_seq) FROM v3_continuation_wake_events x WHERE x.account_id=e.account_id AND x.conversation_id=e.conversation_id AND x.continuation_id=e.continuation_id AND x.wake_id=e.wake_id);

-- Additive unknown/prospect identity tracking. Separate from customer_channel_identities.
-- UNKNOWN = first contact; PROSPECT = returning contact with no customer binding.
CREATE TABLE IF NOT EXISTS prospect_identities(
  id TEXT PRIMARY KEY,
  channel_account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  phone TEXT,
  display_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(channel_account_id, external_id)
);
CREATE INDEX IF NOT EXISTS prospect_identities_lookup_idx ON prospect_identities(channel_account_id, external_id);

-- Non-authoritative inbound route audit. Diagnostic only; no commerce triggers.
CREATE TABLE IF NOT EXISTS inbound_route_audit(
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  identity_state TEXT NOT NULL,
  abuse_state TEXT NOT NULL,
  route_outcome TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inbound_route_audit_scope_idx ON inbound_route_audit(account_id, conversation_id, occurred_at);

-- Durable per-conversation arrival sequence for prospect/unknown inbound.
-- Prospects never enter the V2 queue, so messages.arrival_seq is unavailable to
-- them. This table is the ordering source of truth used to fence a stale
-- prospect reply before it is sent: ordering follows provider arrival, never
-- model completion order. One row per provider delivery, so a redelivery
-- recovers its original sequence instead of being treated as newer traffic.
CREATE TABLE IF NOT EXISTS prospect_reply_sequence(
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  inbound_seq INTEGER NOT NULL,
  admitted_at TEXT NOT NULL,
  reply_state TEXT NOT NULL CHECK(reply_state IN ('PENDING','SENT','SUPPRESSED')),
  PRIMARY KEY(account_id, external_message_id),
  UNIQUE(account_id, conversation_id, inbound_seq)
);
CREATE INDEX IF NOT EXISTS prospect_reply_sequence_scope_idx ON prospect_reply_sequence(account_id, conversation_id, inbound_seq);

-- Bounded PUBLIC_CATALOG_READ evidence for prospect/unknown turns. Diagnostic
-- only; no commerce triggers and never part of quotation/order provenance.
-- Records which catalog query ran, which products came back, and whether the
-- customer-visible reply was composed from that evidence. Model reasoning is
-- never stored: only the tool arguments and the returned safe catalog fields.
CREATE TABLE IF NOT EXISTS prospect_catalog_evidence(
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  call_seq INTEGER NOT NULL,
  tool_name TEXT NOT NULL CHECK(tool_name IN ('search_public_catalog','list_public_catalog')),
  query_text TEXT,
  limit_value INTEGER NOT NULL,
  result_count INTEGER NOT NULL,
  product_ids_json TEXT NOT NULL,
  items_json TEXT NOT NULL,
  grounded INTEGER NOT NULL DEFAULT 0,
  grounded_product_ids_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL,
  UNIQUE(account_id, external_message_id, call_seq)
);
CREATE INDEX IF NOT EXISTS prospect_catalog_evidence_scope_idx ON prospect_catalog_evidence(account_id, conversation_id, observed_at);

-- Single durable prospect processing claim. UNKNOWN includes crash-after-send
-- ambiguity and must never be automatically replayed without provider evidence.
CREATE TABLE IF NOT EXISTS prospect_reply_delivery(
 account_id TEXT NOT NULL,external_message_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
 client_message_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('CLAIMED','UNKNOWN','SUBMITTED','SUPPRESSED')),
 updated_at TEXT NOT NULL,PRIMARY KEY(account_id,external_message_id)
);

-- Opt-in host controlled-test provider attempts. No automatic reset/refund.
CREATE TABLE IF NOT EXISTS controlled_test_send_budgets(
 policy_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,account_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,recipient TEXT NOT NULL,used_attempts INTEGER NOT NULL CHECK(used_attempts BETWEEN 0 AND 3),
 UNIQUE(account_id,recipient)
);
CREATE TABLE IF NOT EXISTS controlled_test_send_attempts(
 policy_id TEXT NOT NULL REFERENCES controlled_test_send_budgets(policy_id),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
 client_message_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('UNKNOWN','SUBMITTED','FAILED')),attempted_at TEXT NOT NULL,
 PRIMARY KEY(policy_id,ordinal)
);
