import type Database from 'better-sqlite3';
import { ContextProjectionService, type AuthoritativeStateProjection } from './v2-context-projection.js';
import { PILOT_BUDGET_CEILINGS, type EmployeeTurnBudgets } from './v2-employee-profile.js';

export type UiState = Readonly<{
  authority: Readonly<{ migrationState: string; workspaceWriter: 'LEGACY' | 'V2' }>;
  workspace: Readonly<{
    workItem: AuthoritativeStateProjection['workspace']['workItem'];
    draft: (AuthoritativeStateProjection['workspace']['draft'] & { validation: 'CURRENT' | 'HISTORICAL' | 'NONE' }) | null;
  }>;
  canonical: AuthoritativeStateProjection['canonicalCommerce'];
  evidence: AuthoritativeStateProjection['validation'];
  budget: Readonly<{
    limits: EmployeeTurnBudgets;
    usage: Readonly<{ modelAttempts: number; repairAttempts: number; capabilityCalls: number }>;
    turnStatus: string;
  }> | null;
  handoff: Readonly<{ active: boolean; reasonCode: string }>;
  boundary: Readonly<{ aiCutoff: 'SALES_ORDER.DRAFT'; staffOnly: readonly ['POST SALES ORDER', 'CONFIRM SALES ORDER', 'DO progression'] }>;
}>;

const SAFE_REASONS = new Set([
  'STAFF_REVIEW', 'HANDED_OFF', 'PI_BUDGET_EXHAUSTED_HANDOFF', 'PI_MAX_MODEL_TURNS', 'PI_MAX_CAPABILITY_CALLS',
  'PI_MAX_REPAIR_ATTEMPTS', 'OUTBOUND_RECONCILIATION_REQUIRED', 'OUTBOUND_PENDING', 'STOCK_SHORTAGE',
  'NEEDS_CLARIFICATION', 'GROUNDING_REJECTED', 'CANONICAL_COMMITMENT_HANDOFF',
]);
const BUDGET_KEYS = ['maxModelTurns','maxCapabilityCalls','perCallTimeoutMs','turnTimeoutMs','maxRepairAttempts'] as const;
function fail(code: string): never { throw new Error(`UI_STATE_INVALID:${code}`); }
function reasonCode(value: unknown): string { return typeof value === 'string' && SAFE_REASONS.has(value) ? value : 'STAFF_REVIEW'; }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); if (!Object.isFrozen(value)) Object.freeze(value); } return value; }
function parseBudget(raw: unknown): EmployeeTurnBudgets {
  if (typeof raw !== 'string' || raw.length > 2048) fail('BUDGET_PROVENANCE');
  let value: unknown; try { value = JSON.parse(raw); } catch { fail('BUDGET_PROVENANCE'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('BUDGET_PROVENANCE');
  const record = value as Record<string, unknown>, keys = Object.keys(record).sort(), expected = [...BUDGET_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key,index) => key !== expected[index])) fail('BUDGET_FIELDS');
  const positive = (name: keyof EmployeeTurnBudgets) => { const v=record[name]; if (!Number.isSafeInteger(v) || Number(v) <= 0) fail(`BUDGET_${name}`); return Number(v); };
  const repair = record.maxRepairAttempts; if (!Number.isSafeInteger(repair) || Number(repair) < 0) fail('BUDGET_maxRepairAttempts');
  const budget: EmployeeTurnBudgets = freeze({ maxModelTurns: positive('maxModelTurns'), maxCapabilityCalls: positive('maxCapabilityCalls'), perCallTimeoutMs: positive('perCallTimeoutMs'), turnTimeoutMs: positive('turnTimeoutMs'), maxRepairAttempts: Number(repair) });
  if (budget.perCallTimeoutMs > budget.turnTimeoutMs) fail('BUDGET_TIMEOUT_ORDER');
  for (const key of BUDGET_KEYS) if (budget[key] > PILOT_BUDGET_CEILINGS[key]) fail(`BUDGET_CEILING_${key}`);
  return budget;
}
function count(db: Database.Database, sql: string, turnId: string): number {
  const n = Number((db.prepare(sql).get(turnId) as { n?: number } | undefined)?.n ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) fail('USAGE_COUNT');
  return n;
}

/** Strictly read-only browser-safe operational state. No ledger JSON, provider data, capability payloads, or staff authority crosses this boundary. */
export function projectUiState(db: Database.Database, accountId: string, conversationId: string): UiState {
  const canonical = new ContextProjectionService(db).authoritativeState(accountId, conversationId);
  const authority = db.prepare("SELECT migration_state,authoritative_writer FROM workspace_authority WHERE account_id=? AND conversation_id=? AND work_item_type='SALES_ORDER_REQUEST'").get(accountId, conversationId) as { migration_state?: string; authoritative_writer?: string } | undefined;
  const migrationState = authority?.migration_state ?? 'V1_ONLY';
  const workspaceWriter = authority?.authoritative_writer === 'V2' ? 'V2' : 'LEGACY';
  const rawDraft = canonical.workspace.draft;
  const validation = canonical.validation;
  const draft = rawDraft ? { ...rawDraft, validation: validation ? (validation.draftRevision === rawDraft.revision ? 'CURRENT' as const : 'HISTORICAL' as const) : 'NONE' as const } : null;
  const turn = db.prepare('SELECT id,status,terminal_reason,budget_provenance_json FROM agent_turns WHERE account_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 1').get(accountId, conversationId) as { id: string; status: string; terminal_reason?: string | null; budget_provenance_json: string } | undefined;
  const budget = turn ? freeze({
    limits: parseBudget(turn.budget_provenance_json),
    usage: freeze({
      modelAttempts: count(db,'SELECT count(*) n FROM agent_model_attempts WHERE turn_id=?',turn.id),
      repairAttempts: count(db,"SELECT count(*) n FROM agent_model_attempts WHERE turn_id=? AND attempt_kind='REPAIR'",turn.id),
      capabilityCalls: count(db,'SELECT count(*) n FROM agent_actions WHERE turn_id=?',turn.id),
    }),
    turnStatus: turn.status,
  }) : null;
  const workReason = reasonCode(canonical.workspace.workItem?.blockingReason);
  const turnReason = reasonCode(turn?.terminal_reason);
  const handoffActive = canonical.workspace.workItem?.state === 'HANDED_OFF' || turn?.terminal_reason?.includes('HANDOFF') === true;
  return freeze({
    authority: { migrationState, workspaceWriter },
    workspace: { workItem: canonical.workspace.workItem, draft },
    canonical: canonical.canonicalCommerce,
    evidence: validation,
    budget,
    handoff: { active: handoffActive, reasonCode: handoffActive ? (turnReason !== 'STAFF_REVIEW' ? turnReason : workReason) : 'STAFF_REVIEW' },
    boundary: { aiCutoff: 'SALES_ORDER.DRAFT', staffOnly: ['POST SALES ORDER', 'CONFIRM SALES ORDER', 'DO progression'] },
  });
}
