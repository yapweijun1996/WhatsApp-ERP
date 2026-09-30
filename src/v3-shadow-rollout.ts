/** V3-MIG-001: host-owned shadow selection and content-free observation only. */

export const V3_SHADOW_MODES = ['OFF', 'SHADOW'] as const;
export type V3ShadowMode = typeof V3_SHADOW_MODES[number];
export type V3ShadowScope = Readonly<{ accountId: string; conversationId: string }>;
export type V3ShadowSelection = Readonly<{
  configuredMode: V3ShadowMode;
  effectiveMode: V3ShadowMode;
  configuredScope: Readonly<{ accountId: string | null; conversationId: string | null }> | null;
}>;
export type V3ShadowTelemetry = Readonly<{
  scope: V3ShadowScope;
  mode: V3ShadowMode;
  observations: number;
  completed: number;
  failed: number;
  lastEventKind: string | null;
}>;

type ScopeKey = Readonly<{ accountId: string | null; conversationId: string | null }>;
type StructuralObservation = Readonly<{
  eventKind: 'V2_RESULT';
  resultClass: 'TERMINAL' | 'FAIL_CLOSED' | 'UNKNOWN';
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_KINDS = new Set(['V2_RESULT']);
const key = (scope: ScopeKey) => `${scope.accountId ?? '*'}\u0000${scope.conversationId ?? '*'}`;
const validId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

function checkedScope(scope: ScopeKey): ScopeKey {
  if (scope.accountId !== null && !validId(scope.accountId)) throw Error('V3_MIG001_ACCOUNT_SCOPE_INVALID');
  if (scope.conversationId !== null && !validId(scope.conversationId)) throw Error('V3_MIG001_CONVERSATION_SCOPE_INVALID');
  if (scope.conversationId !== null && scope.accountId === null) throw Error('V3_MIG001_ACCOUNT_SCOPE_REQUIRED');
  return Object.freeze(scope);
}

function scopeKey(scope: V3ShadowScope): ScopeKey {
  if (!validId(scope.accountId) || !validId(scope.conversationId)) throw Error('V3_MIG001_SCOPE_INVALID');
  return Object.freeze({ accountId: scope.accountId, conversationId: scope.conversationId });
}

function configuredScope(scope: ScopeKey): Readonly<{ accountId: string | null; conversationId: string | null }> {
  return Object.freeze({ accountId: scope.accountId, conversationId: scope.conversationId });
}

/**
 * No database, provider, commerce, or outbound dependency is accepted here.
 * This is deliberately a process-local host seam until a separately approved
 * migration control plane exists.
 */
export class V3ShadowRollout {
  private readonly flags = new Map<string, { scope: ScopeKey; mode: V3ShadowMode }>();
  private readonly counters = new Map<string, { observations: number; completed: number; failed: number; lastEventKind: string | null }>();

  configure(scope: { accountId?: string; conversationId?: string }, mode: V3ShadowMode): void {
    if (!V3_SHADOW_MODES.includes(mode)) throw Error('V3_MIG001_MODE_INVALID');
    const normalized = checkedScope({ accountId: scope.accountId ?? null, conversationId: scope.conversationId ?? null });
    this.flags.set(key(normalized), { scope: normalized, mode });
  }

  select(scope: V3ShadowScope): V3ShadowSelection {
    const normalized = scopeKey(scope);
    const candidates = [
      this.flags.get(key(normalized)),
      this.flags.get(key({ accountId: normalized.accountId, conversationId: null })),
      this.flags.get(key({ accountId: null, conversationId: null })),
    ];
    const selected = candidates.find(Boolean);
    return Object.freeze({
      configuredMode: selected?.mode ?? 'OFF',
      effectiveMode: selected?.mode ?? 'OFF',
      configuredScope: selected ? configuredScope(selected.scope) : null,
    });
  }

  /** Executes a pure shadow callback, but always returns the already-produced V2 value. */
  runShadowOnly<T>(scope: V3ShadowScope, v2Result: T, callback: (observation: StructuralObservation) => unknown): T {
    const normalized = scopeKey(scope);
    const selection = this.select(scope);
    if (selection.effectiveMode !== 'SHADOW') return v2Result;
    const resultClass = typeof v2Result === 'object' && v2Result !== null && 'status' in v2Result
      ? ((v2Result as { status?: unknown }).status === 'TERMINAL' ? 'TERMINAL' : (v2Result as { status?: unknown }).status === 'FAIL_CLOSED' ? 'FAIL_CLOSED' : 'UNKNOWN')
      : 'UNKNOWN';
    const observation = Object.freeze({ eventKind: 'V2_RESULT' as const, resultClass });
    const current = this.counters.get(key(normalized)) ?? { observations: 0, completed: 0, failed: 0, lastEventKind: null };
    current.observations += 1;
    current.lastEventKind = observation.eventKind;
    try { callback(observation); current.completed += 1; } catch { current.failed += 1; }
    this.counters.set(key(normalized), current);
    return v2Result;
  }

  telemetry(scope: V3ShadowScope): V3ShadowTelemetry {
    const normalized = scopeKey(scope);
    const count = this.counters.get(key(normalized));
    return Object.freeze({ scope: Object.freeze({ accountId: scope.accountId, conversationId: scope.conversationId }), mode: this.select(scope).effectiveMode, observations: count?.observations ?? 0, completed: count?.completed ?? 0, failed: count?.failed ?? 0, lastEventKind: count?.lastEventKind ?? null });
  }
}
