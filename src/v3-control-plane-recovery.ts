import {canonicalSha256} from './v2-canonical.js';

export const V3_CONTROL_PLANE_RECOVERY_CONTRACT_VERSION = 'V3-CP-006';

export type V3PlanRecovery = Readonly<{
  contractVersion: typeof V3_CONTROL_PLANE_RECOVERY_CONTRACT_VERSION;
  decision: 'ABORT_REBUNDLE_REBUILD_REPLAN';
  reason: 'STALE_PLAN' | 'NEWER_INPUT' | 'INVALIDATED_DEPENDENCY';
  previousPlanId: string;
  replanIdentity: string;
}>;

export type V3AdmittedEffectRecovery = Readonly<{
  contractVersion: typeof V3_CONTROL_PLANE_RECOVERY_CONTRACT_VERSION;
  decision: 'FINISH_IDEMPOTENTLY' | 'RECONCILE_REQUIRED' | 'ALREADY_FINISHED' | 'TERMINAL_FAILURE';
  effectIdentity: string;
  mayProviderAttempt: false;
}>;

type RecoveryReason = V3PlanRecovery['reason'];
type DurableEffectState = 'ADMITTED' | 'PENDING' | 'UNKNOWN' | 'SUBMITTED' | 'FAILED_RETRYABLE' | 'FAILED_TERMINAL';

function fail(code: string): never { throw new Error(`V3_CP006_INVALID:${code}`); }
function text(value: unknown, code: string, max = 256): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) fail(code);
  return value;
}
function exactKeys(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || Object.keys(descriptors).sort().join('|') !== [...keys].sort().join('|') || Object.values(descriptors).some((d) => !('value' in d))) fail(code);
  return value as Record<string, unknown>;
}

/**
 * Shadow-only control-plane projection. It does not claim a lease, rebuild data,
 * invoke a model, mutate ERP, or send through a channel. V2 owns those effects.
 */
export function recoverV3StalePlan(input: Readonly<{planId: string; reason: RecoveryReason; currentBundleRevision: number; currentContextSnapshotVersion: string}>): V3PlanRecovery {
  const source = exactKeys(input, ['planId', 'reason', 'currentBundleRevision', 'currentContextSnapshotVersion'], 'PLAN_SHAPE');
  const planId = text(source.planId, 'PLAN_ID');
  const reason = text(source.reason, 'REASON') as RecoveryReason;
  if (!['STALE_PLAN', 'NEWER_INPUT', 'INVALIDATED_DEPENDENCY'].includes(reason)) fail('REASON');
  const revision = source.currentBundleRevision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) fail('BUNDLE_REVISION');
  const context = text(source.currentContextSnapshotVersion, 'CONTEXT_VERSION');
  return Object.freeze({
    contractVersion: V3_CONTROL_PLANE_RECOVERY_CONTRACT_VERSION,
    decision: 'ABORT_REBUNDLE_REBUILD_REPLAN', reason, previousPlanId: planId,
    replanIdentity: `${V3_CONTROL_PLANE_RECOVERY_CONTRACT_VERSION}:replan:${canonicalSha256({planId, reason, currentBundleRevision: revision, context})}`,
  });
}

/**
 * Post-admission recovery is deliberately transport-neutral: an admitted
 * effect is finished through the existing V2 owner or reconciled before any
 * possible retry. UNKNOWN never authorizes a blind provider resend.
 */
export function recoverV3AdmittedEffect(input: Readonly<{effectIdentity: string; durableState: DurableEffectState}>): V3AdmittedEffectRecovery {
  const source = exactKeys(input, ['effectIdentity', 'durableState'], 'EFFECT_SHAPE');
  const effectIdentity = text(source.effectIdentity, 'EFFECT_IDENTITY', 512);
  const state = text(source.durableState, 'DURABLE_STATE') as DurableEffectState;
  if (!['ADMITTED', 'PENDING', 'UNKNOWN', 'SUBMITTED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'].includes(state)) fail('DURABLE_STATE');
  const decision = state === 'SUBMITTED' ? 'ALREADY_FINISHED' : state === 'UNKNOWN' ? 'RECONCILE_REQUIRED' : state === 'FAILED_TERMINAL' ? 'TERMINAL_FAILURE' : 'FINISH_IDEMPOTENTLY';
  return Object.freeze({contractVersion: V3_CONTROL_PLANE_RECOVERY_CONTRACT_VERSION, decision, effectIdentity, mayProviderAttempt: false});
}

export function validateV3ControlPlaneRecovery(value: unknown): V3PlanRecovery | V3AdmittedEffectRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('RESULT_SHAPE');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const isAdmitted = Object.prototype.hasOwnProperty.call(descriptors, 'mayProviderAttempt') || Object.prototype.hasOwnProperty.call(descriptors, 'effectIdentity');
  if (isAdmitted) {
    if ('mayProviderAttempt' in descriptors && 'value' in descriptors.mayProviderAttempt && descriptors.mayProviderAttempt.value === true) fail('RESULT_AUTHORITY');
    const item = exactKeys(value, ['contractVersion', 'decision', 'effectIdentity', 'mayProviderAttempt'], 'RESULT_SHAPE');
    if (item.contractVersion !== V3_CONTROL_PLANE_RECOVERY_CONTRACT_VERSION) fail('RESULT_AUTHORITY');
    if (!['FINISH_IDEMPOTENTLY', 'RECONCILE_REQUIRED', 'ALREADY_FINISHED', 'TERMINAL_FAILURE'].includes(item.decision as string)) fail('RESULT_DECISION');
    text(item.effectIdentity, 'RESULT_EFFECT_IDENTITY', 512);
    if (item.mayProviderAttempt !== false) fail('RESULT_AUTHORITY');
    return value as V3AdmittedEffectRecovery;
  }
  const item = exactKeys(value, ['contractVersion', 'decision', 'reason', 'previousPlanId', 'replanIdentity'], 'RESULT_SHAPE');
  if (item.contractVersion !== V3_CONTROL_PLANE_RECOVERY_CONTRACT_VERSION) fail('RESULT_AUTHORITY');
  if (item.decision !== 'ABORT_REBUNDLE_REBUILD_REPLAN') fail('RESULT_DECISION');
  if (!['STALE_PLAN', 'NEWER_INPUT', 'INVALIDATED_DEPENDENCY'].includes(item.reason as string)) fail('RESULT_REASON');
  text(item.previousPlanId, 'RESULT_PLAN_ID');
  text(item.replanIdentity, 'RESULT_REPLAN_IDENTITY', 512);
  return value as V3PlanRecovery;
}
