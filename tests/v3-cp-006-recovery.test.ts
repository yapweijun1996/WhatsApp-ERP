import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverV3AdmittedEffect, recoverV3StalePlan, validateV3ControlPlaneRecovery} from '../src/v3-control-plane-recovery.js';

test('CP-006 aborts a pre-admission stale plan and deterministically requests rebuild/replan', () => {
  const first = recoverV3StalePlan({planId: 'plan-1', reason: 'NEWER_INPUT', currentBundleRevision: 8, currentContextSnapshotVersion: 'ctx-8'});
  const second = recoverV3StalePlan({planId: 'plan-1', reason: 'NEWER_INPUT', currentBundleRevision: 8, currentContextSnapshotVersion: 'ctx-8'});
  assert.deepEqual(first, second);
  assert.equal(first.decision, 'ABORT_REBUNDLE_REBUILD_REPLAN');
  assert.equal(first.replanIdentity.startsWith('V3-CP-006:replan:'), true);
  assert.equal('mayProviderAttempt' in first, false);
});

test('CP-006 post-admission completion is idempotent and never adds a provider path', () => {
  assert.equal(recoverV3AdmittedEffect({effectIdentity: 'effect-1', durableState: 'ADMITTED'}).decision, 'FINISH_IDEMPOTENTLY');
  assert.equal(recoverV3AdmittedEffect({effectIdentity: 'effect-1', durableState: 'SUBMITTED'}).decision, 'ALREADY_FINISHED');
  assert.equal(recoverV3AdmittedEffect({effectIdentity: 'effect-1', durableState: 'UNKNOWN'}).decision, 'RECONCILE_REQUIRED');
  assert.equal(recoverV3AdmittedEffect({effectIdentity: 'effect-1', durableState: 'UNKNOWN'}).mayProviderAttempt, false);
});

test('CP-006 fails closed on malformed or unauthorized recovery input', () => {
  assert.throws(() => recoverV3AdmittedEffect({effectIdentity: 'effect-1', durableState: 'BOGUS' as never}), /DURABLE_STATE/);
  assert.throws(() => recoverV3AdmittedEffect({effectIdentity: 'effect-1', durableState: 'UNKNOWN', extra: true} as never), /EFFECT_SHAPE/);
  assert.throws(() => recoverV3StalePlan({planId: 'plan-1', reason: 'yes' as never, currentBundleRevision: 1, currentContextSnapshotVersion: 'ctx'}), /REASON/);
  assert.throws(() => validateV3ControlPlaneRecovery({contractVersion: 'V3-CP-006', mayProviderAttempt: true}), /RESULT_AUTHORITY/);
});

test('CP-006 closes stale-plan inputs and never invokes accessors', () => {
  assert.throws(() => recoverV3StalePlan({planId: 'plan-1', reason: 'NEWER_INPUT', currentBundleRevision: 1, currentContextSnapshotVersion: 'ctx', extra: true} as never), /PLAN_SHAPE/);
  let invoked = false;
  const input: any = {planId: 'plan-1', reason: 'NEWER_INPUT', currentBundleRevision: 1, currentContextSnapshotVersion: 'ctx'};
  Object.defineProperty(input, 'reason', {get() { invoked = true; throw new Error('GETTER_INVOKED'); }, enumerable: true});
  assert.throws(() => recoverV3StalePlan(input), /PLAN_SHAPE/);
  assert.equal(invoked, false);
});

test('CP-006 validates closed recovery result shapes, values, authority, and accessors', () => {
  const plan = recoverV3StalePlan({planId: 'plan-1', reason: 'STALE_PLAN', currentBundleRevision: 1, currentContextSnapshotVersion: 'ctx'});
  const effect = recoverV3AdmittedEffect({effectIdentity: 'effect-1', durableState: 'UNKNOWN'});
  assert.deepEqual(validateV3ControlPlaneRecovery(plan), plan);
  assert.deepEqual(validateV3ControlPlaneRecovery(effect), effect);
  assert.throws(() => validateV3ControlPlaneRecovery({...plan, extra: true}), /RESULT_SHAPE/);
  assert.throws(() => validateV3ControlPlaneRecovery({contractVersion: 'V3-CP-006', decision: plan.decision, reason: plan.reason}), /RESULT_SHAPE/);
  assert.throws(() => validateV3ControlPlaneRecovery({...plan, decision: 'FINISH_IDEMPOTENTLY'}), /RESULT_DECISION/);
  assert.throws(() => validateV3ControlPlaneRecovery({...plan, reason: 'BOGUS'}), /RESULT_REASON/);
  assert.throws(() => validateV3ControlPlaneRecovery({...effect, mayProviderAttempt: undefined}), /RESULT_AUTHORITY/);
  assert.throws(() => validateV3ControlPlaneRecovery({...effect, mayProviderAttempt: true}), /RESULT_AUTHORITY/);
  assert.throws(() => validateV3ControlPlaneRecovery({...effect, decision: 'BOGUS'}), /RESULT_DECISION/);
  let invoked = false;
  const accessorResult: any = {...effect};
  Object.defineProperty(accessorResult, 'decision', {get() { invoked = true; throw new Error('GETTER_INVOKED'); }, enumerable: true});
  assert.throws(() => validateV3ControlPlaneRecovery(accessorResult), /RESULT_SHAPE/);
  assert.equal(invoked, false);
});
