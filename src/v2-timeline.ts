import type Database from 'better-sqlite3';

export type TimelineEvent = Readonly<{
  id: string;
  kind: 'receive' | 'context' | 'action' | 'tool' | 'result' | 'reply' | 'handoff';
  actor: 'Customer' | 'AI Employee' | 'ERP' | 'Staff' | 'System';
  label: string;
  detail?: string;
  at: string;
}>;

const TOOL_LABELS: Record<string, string> = { resolve_customer: 'Customer identity checked', get_recent_orders: 'Previous orders checked', search_products: 'Product matched', resolve_uom: 'Unit of measure checked', convert_uom: 'Unit conversion checked', get_customer_price: 'Customer price checked', check_stock: 'Stock checked', get_customer_context: 'Customer context checked', get_order_history: 'Order history checked', validate_order_lines: 'Order details checked', create_sales_order_draft: 'Draft order prepared', request_human_handoff: 'Human handoff selected' };
const STAFF_LIFECYCLE_LABELS: Record<string, string> = {
  'Staff action POST completed.': 'Staff action POST completed.',
  'Staff action CONFIRM completed.': 'Staff action CONFIRM completed.',
  'Staff action DO completed.': 'Staff action DO completed.',
};

type AuditProjection = Pick<TimelineEvent, 'kind' | 'actor' | 'label' | 'detail'>;

export type TimelineAuthority = 'LEGACY' | 'V2';

/** The persisted migration marker is the only authority for the operational view. */
export function timelineAuthority(db: Database.Database, conversationId: string): TimelineAuthority {
  const row = db.prepare("SELECT migration_state,authoritative_writer FROM workspace_authority WHERE conversation_id=? AND work_item_type='SALES_ORDER_REQUEST'").get(conversationId) as {migration_state?: string; authoritative_writer?: string}|undefined;
  if (row?.authoritative_writer === 'V2' && ['V2_CANARY', 'V2_PRIMARY', 'LEGACY_RETIRED'].includes(String(row.migration_state))) return 'V2';
  return 'LEGACY';
}

/**
 * Audit payloads are untrusted, even when they were written by an internal
 * component. Only fixed summaries for known business events may reach the UI.
 * In particular, do not copy captures, error messages, or payload fields into
 * a label/detail: those can contain provider data or customer instructions.
 */
export function projectAudit(actorType: unknown, payloadJson: unknown): AuditProjection {
  const actor = actorType === 'ERP' ? 'ERP' : actorType === 'Staff' ? 'Staff' : actorType === 'AI Employee' ? 'AI Employee' : 'System';
  let text: unknown;
  try {
    const payload = JSON.parse(typeof payloadJson === 'string' ? payloadJson : 'null');
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) text = (payload as { text?: unknown }).text;
  } catch { /* malformed audit payloads are intentionally generic */ }

  if (typeof text !== 'string') return { kind: actor === 'ERP' ? 'tool' : 'result', actor, label: 'Business activity recorded' };
  const known = text.trim();
  if (known === 'Staff review required for this request.') return { kind: 'handoff', actor, label: 'Human handoff requested', detail: 'Staff review required' };
  if (/^Customer identified: .+\.$/.test(known)) return { kind: 'result', actor, label: 'Customer identity resolved' };
  if (/^Previous order found: .+\.$/.test(known)) return { kind: 'result', actor, label: 'Previous order checked' };
  if (/^Validated \d+ requested line\(s\): product, UOM, customer price and stock evidence are deterministic\.$/.test(known)) return { kind: 'result', actor, label: 'Order details validated' };
  if (/^Stock shortage detected for .+\.$/.test(known)) return { kind: 'tool', actor, label: 'Stock availability requires review' };
  if (/^Order intelligence failed closed: .+$/.test(known)) return { kind: 'tool', actor, label: 'Order lookup failed safely', detail: 'No commercial action taken' };
  if (/^Agent run failed safely: .+$/.test(known)) return { kind: 'result', actor, label: 'Agent run failed safely', detail: 'No commercial action taken' };
  if (known === 'Quotation sent; prior quote superseded atomically.') return { kind: 'result', actor, label: 'Quotation sent' };
  if (/^Quotation [A-Z0-9-]+ prepared with immutable ERP evidence\.$/.test(known)) return { kind: 'result', actor, label: 'Quotation prepared' };
  if (/^Quotation [A-Z0-9-]+ sent; prior quote superseded atomically\.$/.test(known)) return { kind: 'result', actor, label: 'Quotation sent' };
  if (known === 'Explicit acceptance recorded.') return { kind: 'result', actor, label: 'Customer acceptance recorded' };
  if (/^Draft Sales Order [A-Z0-9-]+ created\. STAFF ACTION REQUIRED\.$/.test(known)) return { kind: 'result', actor, label: 'Sales Order draft created', detail: 'Staff action required' };
  const staffLifecycleLabel = STAFF_LIFECYCLE_LABELS[known];
  if (staffLifecycleLabel !== undefined) return { kind: 'result', actor, label: staffLifecycleLabel };
  return { kind: actor === 'ERP' ? 'tool' : 'result', actor, label: 'Business activity recorded' };
}

/** Read-only, allowlisted UI projection; model/provider payloads never reach the view. */
export function projectTimeline(db: Database.Database, conversationId: string): TimelineEvent[] {
  const events: Array<TimelineEvent & { order: number }> = []; let order=0;
  const authority=timelineAuthority(db, conversationId);
  // IDs are deliberately local presentation sequence IDs. Durable/provider IDs
  // are useful for joins, but are not UI data.
  const add=(event:Omit<TimelineEvent,'id'>,_source:string)=>events.push({...event,id:`timeline-${order}`,order:order++});
  const messages=db.prepare('SELECT id,direction,occurred_at FROM messages WHERE conversation_id=? ORDER BY rowid').all(conversationId) as any[];
  for(const message of messages) add({kind:message.direction==='INBOUND'?'receive':'reply',actor:message.direction==='INBOUND'?'Customer':'AI Employee',label:message.direction==='INBOUND'?'Customer message received':'Customer reply sent',at:message.occurred_at},`${message.direction}-${message.id}`);
  if(authority==='LEGACY'){
    const runs=db.prepare('SELECT id,started_at FROM agent_runs WHERE conversation_id=? ORDER BY rowid').all(conversationId) as any[];
    for(const run of runs){ add({kind:'context',actor:'AI Employee',label:'Context loaded',detail:'Bounded conversation context prepared',at:run.started_at},`context-${run.id}`); const tools=db.prepare('SELECT id,tool_name,status,occurred_at FROM agent_tool_calls WHERE agent_run_id=? ORDER BY rowid').all(run.id) as any[]; for(const tool of tools){ add({kind:'action',actor:'AI Employee',label:TOOL_LABELS[tool.tool_name]??'ERP lookup selected',at:tool.occurred_at},`action-${tool.id}`); add({kind:'tool',actor:'ERP',label:tool.status==='SUCCEEDED'?'ERP lookup completed':'ERP lookup failed safely',detail:tool.status==='SUCCEEDED'?undefined:'No commercial action taken',at:tool.occurred_at},`tool-${tool.id}`); add({kind:'result',actor:'AI Employee',label:tool.status==='SUCCEEDED'?'Lookup result recorded':'Safe failure recorded',at:tool.occurred_at},`result-${tool.id}`); }}
  }
  const audits=db.prepare("SELECT id,actor_type,payload_json,occurred_at FROM audit_events WHERE entity_type='CONVERSATION' AND entity_id=? ORDER BY rowid").all(conversationId) as any[];
  for(const audit of audits){ add({...projectAudit(audit.actor_type, audit.payload_json),at:audit.occurred_at},`audit-${audit.id}`); }
  const workItems=db.prepare("SELECT e.id,e.actor_type,e.to_state,e.created_at FROM work_item_events e JOIN work_items w ON w.id=e.work_item_id WHERE w.conversation_id=? ORDER BY e.created_at,e.revision").all(conversationId) as any[];
  for(const event of workItems) if(event.to_state==='HANDED_OFF') add({kind:'handoff',actor:event.actor_type==='STAFF'?'Staff':'AI Employee',label:'Human handoff requested',detail:'Staff review required',at:event.created_at},`handoff-${event.id}`);

  // V2 is projected from durable ledgers, never from their JSON payloads.
  const canonicalOutboundExternalIds = new Set(
    (db.prepare("SELECT external_message_id FROM messages WHERE conversation_id=? AND direction='OUTBOUND' AND external_message_id IS NOT NULL").all(conversationId) as Array<{external_message_id: string}>).map(message => message.external_message_id),
  );
  const turns=authority==='V2' ? db.prepare('SELECT id,inbound_message_id,created_at FROM agent_turns WHERE conversation_id=? ORDER BY created_at,rowid').all(conversationId) as any[] : [];
  for(const turn of turns){
    const inbound=db.prepare('SELECT occurred_at FROM messages WHERE id=?').get(turn.inbound_message_id) as any;
    add({kind:'context',actor:'AI Employee',label:'Context loaded',detail:'Bounded conversation context prepared',at:turn.created_at},`v2-context-${turn.id}`);
    const actions=db.prepare('SELECT id,sequence,capability_name,created_at FROM agent_actions WHERE turn_id=? ORDER BY sequence').all(turn.id) as any[];
    for(const action of actions){
      add({kind:'action',actor:'AI Employee',label:TOOL_LABELS[action.capability_name]??'ERP lookup selected',at:action.created_at},`v2-action-${action.id}`);
      const result=db.prepare('SELECT created_at,result_json FROM agent_action_results WHERE action_id=?').get(action.id) as any;
      if(result){
        let succeeded=false; try { const parsed=JSON.parse(result.result_json); succeeded=parsed?.status==='SUCCEEDED'; } catch { /* generic safe failure */ }
        add({kind:'tool',actor:'ERP',label:succeeded?'ERP lookup completed':'ERP lookup failed safely',detail:succeeded?undefined:'No commercial action taken',at:result.created_at},`v2-tool-${action.id}`);
        add({kind:'result',actor:'AI Employee',label:succeeded?'Lookup result recorded':'Safe failure recorded',at:result.created_at},`v2-result-${action.id}`);
      }
    }
    const disposition=db.prepare('SELECT disposition,purpose,created_at FROM turn_outbound_dispositions WHERE turn_id=?').get(turn.id) as any;
    if(disposition?.disposition==='HANDOFF_NO_CUSTOMER_MESSAGE') add({kind:'handoff',actor:'AI Employee',label:'Human handoff requested',detail:'Staff review required',at:disposition.created_at},`v2-handoff-${turn.id}`);
    const outbound=db.prepare("SELECT o.id,o.created_at,o.status,o.external_message_id FROM outbound_messages o WHERE o.entity_type='TURN_RESPONSE' AND o.entity_id=? ORDER BY o.rowid").all(turn.id) as any[];
    for(const message of outbound){
      // A submitted V2 response may also be recorded in the canonical message
      // ledger by the channel ingestion path. Provider correlation is durable;
      // do not suppress older outbound rows that lack that correlation.
      if(message.external_message_id && canonicalOutboundExternalIds.has(message.external_message_id)) continue;
      add({kind:'reply',actor:'AI Employee',label:message.status==='SUBMITTED'?'Customer reply sent':'Customer reply queued',at:message.created_at},`v2-reply-${message.id}`);
    }
    // Keep the receive event sourced from messages, but ensure a V2 turn with a
    // missing legacy message cannot manufacture customer content in the view.
    void inbound;
  }
  return events.sort((a,b)=>a.at.localeCompare(b.at)||a.order-b.order).map(({order:_,...event})=>event);
}
