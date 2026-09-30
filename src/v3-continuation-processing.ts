/** V3-GOAL-005: shadow-only continuation wake/resume processing. */
import type Database from 'better-sqlite3';
import {canonicalSha256} from './v2-canonical.js';
import {V1Database} from './database.js';
import {V2QueueService} from './v2-queue.js';
import {validateInboundBundle, type InboundBundle} from './v3-inbound-bundle.js';
import {projectReasoningLease, type ActiveReasoningLease} from './v3-reasoning-lease.js';
import {validateContextSnapshot, type ContextSnapshot} from './v3-context-snapshot.js';
import {buildV3FreshnessVectorFromDatabase, validateV3FreshnessVector, type V3FreshnessDependencyVector, type V3FreshnessVectorInput} from './v3-freshness-vector.js';
import {V3DurableContinuationStore, V3_CONTINUATION_TRIGGERS, v3FreshnessVectorRef, v3ResumeConditionRef, type V3ContinuationTrigger, type V3ContinuationHostCondition, type V3DurableContinuation} from './v3-durable-continuation.js';

export type V3ContinuationWake = Readonly<{
  accountId: string; conversationId: string; continuationId: string;
  resumeTriggerType: V3ContinuationTrigger; condition: string;
  nowIso: string; ownerId: string; leaseMs?: number;
  wakeEventId: string;
  bundle: InboundBundle; context: ContextSnapshot; freshnessVector: V3FreshnessDependencyVector;
}>;

export type V3ContinuationDecision = Readonly<{
  contractVersion: 'V3-GOAL-005'; authority: 'NON_AUTHORITATIVE_SHADOW';
  wakeId: string; continuationId: string; accountId: string; conversationId: string;
  disposition: 'RESUME_AUTHORIZED' | 'NON_EFFECT_HANDOFF' | 'NON_EFFECT_PENDING' | 'NON_EFFECT_REJECTED';
  reasonCode: 'LEASE_REACQUIRED' | 'DUPLICATE_WAKE' | 'MANUAL_HANDOFF' | 'DEADLINE_EXHAUSTED' | 'BUDGET_EXHAUSTED' | 'NOT_ELIGIBLE' | 'LEASE_UNAVAILABLE' | 'STALE_FRESHNESS' | 'STALE_CONTEXT' | 'INVALID_WAKE';
  lease: ActiveReasoningLease | null; currentFreshnessVectorHash: string | null; contextSnapshotVersion: string | null;
}>;

const fail = (code: string): never => { throw new Error(`V3_CONTINUATION_PROCESSING_INVALID:${code}`); };
const text = (v: unknown, code: string, max = 512): string => { if (typeof v !== 'string' || v.trim() === '' || v.length > max) fail(code); return v as string; };
const trigger = (v: unknown): V3ContinuationTrigger => { if (!V3_CONTINUATION_TRIGGERS.includes(v as V3ContinuationTrigger)) fail('TRIGGER'); return v as V3ContinuationTrigger; };
const exact = (v: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) fail('INPUT_SHAPE');
  const out: Record<string, unknown> = {}, descriptors = Object.getOwnPropertyDescriptors(v as object);
  if (Reflect.ownKeys(v as object).some((key) => typeof key !== 'string' || !([...keys, ...optional]).includes(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) fail('INPUT_SHAPE');
  for (const key of [...keys, ...optional]) { const d = descriptors[key]; if (!d) continue; if (!d.enumerable || !('value' in d)) fail('INPUT_SHAPE'); out[key] = (d as PropertyDescriptor & {value: unknown}).value; }
  return out;
};
const iso = (v: unknown): string => { const value = text(v, 'NOW', 80); if (!Number.isFinite(Date.parse(value))) fail('NOW'); return value; };
const frozen = <T>(v: T): T => { if (v && typeof v === 'object') { for (const child of Object.values(v as Record<string, unknown>)) frozen(child); Object.freeze(v as object); } return v; };

function wakeInput(input: unknown): V3ContinuationWake {
  const x = exact(input, ['accountId','conversationId','continuationId','resumeTriggerType','condition','nowIso','ownerId','wakeEventId','bundle','context','freshnessVector'], ['leaseMs']);
  const leaseMs = x.leaseMs === undefined ? 30_000 : x.leaseMs;
  if (!Number.isSafeInteger(leaseMs) || Number(leaseMs) < 1_000 || Number(leaseMs) > 300_000) fail('LEASE_BOUNDS');
  const resumeTriggerType = trigger(x.resumeTriggerType);
  // DEADLINE wakes carry no Host condition proof. The scheduler's authenticated
  // scope and the persisted deadline are the only facts used for this path.
  const condition = resumeTriggerType === 'DEADLINE'
    ? (typeof x.condition === 'string' && x.condition.length <= 512 ? x.condition : fail('CONDITION'))
    : text(x.condition, 'CONDITION');
  return {accountId: text(x.accountId, 'ACCOUNT_ID'), conversationId: text(x.conversationId, 'CONVERSATION_ID'), continuationId: text(x.continuationId, 'CONTINUATION_ID'), resumeTriggerType, condition, nowIso: iso(x.nowIso), ownerId: text(x.ownerId, 'OWNER_ID', 160), wakeEventId: text(x.wakeEventId, 'WAKE_EVENT_ID', 160), leaseMs: Number(leaseMs), bundle: validateInboundBundle(x.bundle), context: validateContextSnapshot(x.context), freshnessVector: validateV3FreshnessVector(x.freshnessVector)};
}

function decision(wake: V3ContinuationWake, continuation: V3DurableContinuation, disposition: V3ContinuationDecision['disposition'], reasonCode: V3ContinuationDecision['reasonCode'], lease: ActiveReasoningLease | null, vectorHash: string | null, contextVersion: string | null): V3ContinuationDecision {
  return frozen({contractVersion: 'V3-GOAL-005', authority: 'NON_AUTHORITATIVE_SHADOW', wakeId: wakeIdentity(wake, continuation), continuationId: continuation.continuationId, accountId: wake.accountId, conversationId: wake.conversationId, disposition, reasonCode, lease, currentFreshnessVectorHash: vectorHash, contextSnapshotVersion: contextVersion});
}
function wakeIdentity(wake: V3ContinuationWake, continuation: V3DurableContinuation): string { return canonicalSha256({accountId: wake.accountId, conversationId: wake.conversationId, continuationId: continuation.continuationId, wakeEventId: wake.wakeEventId, resumeTriggerType: wake.resumeTriggerType, ...(wake.resumeTriggerType === 'DEADLINE' ? {} : {condition: wake.condition})}); }

export class V3ContinuationProcessor {
  private readonly store: V3DurableContinuationStore;
  private readonly queue: V2QueueService;
  constructor(private readonly database: V1Database) { this.store = new V3DurableContinuationStore(database); this.queue = new V2QueueService(database); }

  process(input: unknown): V3ContinuationDecision {
    let wake: V3ContinuationWake;
    try { wake = wakeInput(input); } catch { throw new Error('V3_CONTINUATION_PROCESSING_INVALID:INVALID_WAKE'); }
    const continuation = this.store.get({accountId: wake.accountId, conversationId: wake.conversationId}, wake.continuationId);
    if (!continuation) throw new Error('V3_CONTINUATION_PROCESSING_INVALID:CONTINUATION_NOT_FOUND');
    const now = Date.parse(wake.nowIso);
    const goalRow = this.database.db.prepare('SELECT goal_json FROM conversation_goal_events WHERE account_id=? AND conversation_id=? AND goal_id=? ORDER BY revision DESC LIMIT 1').get(wake.accountId, wake.conversationId, continuation.goalId) as {goal_json:string}|undefined;
    try { if (goalRow && ['FULFILLED','SUPERSEDED','CANCELLED'].includes(String((JSON.parse(goalRow.goal_json) as {status:string}).status))) return decision(wake, continuation, 'NON_EFFECT_REJECTED', 'NOT_ELIGIBLE', null, null, null); } catch { return decision(wake, continuation, 'NON_EFFECT_REJECTED', 'NOT_ELIGIBLE', null, null, null); }
    // A deadline wake is a Host timer signal, not a resume-condition proof.
    // It can only produce the terminal bounded disposition once the persisted
    // deadline has elapsed; it never reaches lease acquisition or effects.
    if (wake.resumeTriggerType === 'DEADLINE') {
      if (!continuation.deadlineAt || now < Date.parse(continuation.deadlineAt)) return decision(wake, continuation, 'NON_EFFECT_REJECTED', 'INVALID_WAKE', null, null, null);
      return decision(wake, continuation, 'NON_EFFECT_HANDOFF', 'DEADLINE_EXHAUSTED', null, null, null);
    }
    const condition: V3ContinuationHostCondition = {accountId: wake.accountId, conversationId: wake.conversationId, resumeTriggerType: wake.resumeTriggerType, condition: wake.condition};
    if (continuation.resumeTriggerType !== wake.resumeTriggerType || continuation.resumeConditionRef !== v3ResumeConditionRef(condition)) return decision(wake, continuation, 'NON_EFFECT_REJECTED', 'INVALID_WAKE', null, null, null);
    if (continuation.ownerType === 'HUMAN' || continuation.resumeTriggerType === 'MANUAL_HANDOFF') return decision(wake, continuation, 'NON_EFFECT_HANDOFF', 'MANUAL_HANDOFF', null, null, null);
    if (continuation.deadlineAt && now >= Date.parse(continuation.deadlineAt)) return decision(wake, continuation, 'NON_EFFECT_HANDOFF', 'DEADLINE_EXHAUSTED', null, null, null);
    if (continuation.nextEligibleAt && now < Date.parse(continuation.nextEligibleAt)) return decision(wake, continuation, 'NON_EFFECT_PENDING', 'NOT_ELIGIBLE', null, null, null);
    if (continuation.expectedFreshnessVectorRef !== v3FreshnessVectorRef(wake.freshnessVector)) return decision(wake, continuation, 'NON_EFFECT_REJECTED', 'STALE_FRESHNESS', null, null, null);
    const deps = wake.freshnessVector.dependencies; const {authoritativeV2FreshnessFingerprint: _, ...withoutFingerprint} = deps;
    let current: V3FreshnessDependencyVector;
    try { current = buildV3FreshnessVectorFromDatabase(this.database.db, withoutFingerprint as Omit<V3FreshnessVectorInput, 'authoritativeV2FreshnessFingerprint'>); } catch { return decision(wake, continuation, 'NON_EFFECT_REJECTED', 'STALE_FRESHNESS', null, null, null); }
    if (current.vectorHash !== wake.freshnessVector.vectorHash || wake.context.sourceRevisionRefs.freshnessFingerprint !== current.dependencies.authoritativeV2FreshnessFingerprint) return decision(wake, continuation, 'NON_EFFECT_REJECTED', 'STALE_FRESHNESS', null, current.vectorHash, wake.context.contextSnapshotVersion);
    if (wake.bundle.accountId !== wake.accountId || wake.bundle.conversationId !== wake.conversationId || wake.context.sourceRevisionRefs.accountId !== wake.accountId || wake.context.sourceRevisionRefs.conversationId !== wake.conversationId) return decision(wake, continuation, 'NON_EFFECT_REJECTED', 'STALE_CONTEXT', null, current.vectorHash, wake.context.contextSnapshotVersion);
    const wakeId = wakeIdentity(wake, continuation);
    const receipt = this.database.v3WakeReserve({accountId: wake.accountId, conversationId: wake.conversationId, continuationId: continuation.continuationId, wakeId, wakeEventId: wake.wakeEventId, now: wake.nowIso});
    if (receipt.status === 'TERMINAL') return decision(wake, continuation, 'NON_EFFECT_REJECTED', 'NOT_ELIGIBLE', null, current.vectorHash, wake.context.contextSnapshotVersion);
    if (receipt.status === 'BUDGET_EXHAUSTED') return decision(wake, continuation, 'NON_EFFECT_HANDOFF', 'BUDGET_EXHAUSTED', null, current.vectorHash, wake.context.contextSnapshotVersion);
    if (receipt.status === 'DUPLICATE' && receipt.leaseGeneration !== null) {
      const state = this.database.db.prepare('SELECT lease_owner,lease_generation,lease_token,lease_expires_at FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?').get(wake.accountId, wake.conversationId) as {lease_owner:string|null;lease_generation:number|null;lease_token:string|null;lease_expires_at:string|null}|undefined;
      if (state?.lease_owner === receipt.leaseOwner && Number(state.lease_generation) === receipt.leaseGeneration && state.lease_token && state.lease_expires_at && Date.parse(state.lease_expires_at) > now) {
        const duplicateLease = projectReasoningLease(this.database.db, wake.bundle, wake.context, wake.nowIso);
        if (duplicateLease.state === 'ACTIVE' && duplicateLease.ownerId === wake.ownerId) return decision(wake, continuation, 'RESUME_AUTHORIZED', 'DUPLICATE_WAKE', duplicateLease, current.vectorHash, wake.context.contextSnapshotVersion);
      }
      return decision(wake, continuation, 'NON_EFFECT_PENDING', 'LEASE_UNAVAILABLE', null, current.vectorHash, wake.context.contextSnapshotVersion);
    }
    let claimed: ReturnType<V2QueueService['claimNext']> = null;
    try { claimed = this.queue.claimNext({accountId: wake.accountId, conversationId: wake.conversationId, owner: wake.ownerId, leaseMs: wake.leaseMs, nowIso: wake.nowIso}); } catch (error) { if (!String(error).includes('LEASE_BUSY')) throw error; }
    let lease: ActiveReasoningLease | null = null;
    if (claimed) lease = projectReasoningLease(this.database.db, wake.bundle, wake.context, wake.nowIso);
    else {
      const state = this.database.db.prepare('SELECT lease_owner,lease_expires_at FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?').get(wake.accountId, wake.conversationId) as {lease_owner: string|null; lease_expires_at: string|null}|undefined;
      if (state?.lease_owner === wake.ownerId && state.lease_expires_at && Date.parse(state.lease_expires_at) > now) lease = projectReasoningLease(this.database.db, wake.bundle, wake.context, wake.nowIso);
    }
    // A NEW reservation has already consumed this event's durable slot.  If
    // the V2 lease is busy, this exact Host event remains retryable and must
    // bind the same attempt later; budget exhaustion is reported only by the
    // reservation transaction for a distinct event that cannot reserve.
    if (!lease || lease.state !== 'ACTIVE' || lease.ownerId !== wake.ownerId || !lease.fencingToken) return decision(wake, continuation, 'NON_EFFECT_PENDING', 'LEASE_UNAVAILABLE', null, current.vectorHash, wake.context.contextSnapshotVersion);
    const bound = this.database.v3WakeBindLease({accountId: wake.accountId, conversationId: wake.conversationId, continuationId: continuation.continuationId, wakeId, attempt: receipt.attempt, owner: wake.ownerId, generation: lease.generation, now: wake.nowIso, bundle: wake.bundle, context: wake.context, freshnessVector: wake.freshnessVector});
    if (bound.status !== 'BOUND') return decision(wake, continuation, 'NON_EFFECT_REJECTED', 'STALE_FRESHNESS', null, current.vectorHash, wake.context.contextSnapshotVersion);
    return decision(wake, continuation, 'RESUME_AUTHORIZED', claimed ? 'LEASE_REACQUIRED' : 'DUPLICATE_WAKE', lease, current.vectorHash, wake.context.contextSnapshotVersion);
  }
}

export const processV3ContinuationWake = (database: V1Database, input: unknown): V3ContinuationDecision => new V3ContinuationProcessor(database).process(input);
