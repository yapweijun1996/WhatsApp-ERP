/** V3-MIG-003: owner-authorized, process-local canary and rollback control. */

import {evaluateV3Mig002CanaryEligibility, type V3Mig002Evidence} from './v3-mig-002-policy.js';
import type {MigrationApproval, MigrationApprovalAuthority} from './migration-auth.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const scopeKey = (accountId: string, conversationId: string) => `${accountId}\u0000${conversationId}`;
const validId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

export type V3Mig003Scope = Readonly<{accountId: string; conversationId: string}>;
export type V3Mig003CanonicalEvidence = Readonly<{
  commerceEvidenceRef: string;
  outboundEvidenceRefs: readonly string[];
}>;
export type V3Mig003DerivedState = Readonly<{
  ignoreAndRebuild: (scope: V3Mig003Scope) => void;
}>;
export type V3Mig003State = Readonly<{
  contractVersion: 'V3-MIG-003';
  scope: V3Mig003Scope;
  mode: 'V2' | 'V3_CANARY' | 'V3_ROLLED_BACK';
  authoritativeWriter: 'V2' | 'V3';
  activeWriters: readonly ('V2' | 'V3')[];
  outboundOwner: 'OutboundMessageService';
}>;
export type V3Mig003RollbackResult = Readonly<{
  state: V3Mig003State;
  derivedStateAction: 'IGNORED_AND_REBUILT';
  preservedCanonicalEvidence: V3Mig003CanonicalEvidence;
}>;

function requireScope(scope: V3Mig003Scope): V3Mig003Scope {
  if (!scope || !validId(scope.accountId) || !validId(scope.conversationId)) throw Error('V3_MIG003_SCOPE_REQUIRED');
  return Object.freeze({accountId: scope.accountId, conversationId: scope.conversationId});
}

function requireCanonicalEvidence(value: V3Mig003CanonicalEvidence): V3Mig003CanonicalEvidence {
  if (!value || !validId(value.commerceEvidenceRef) || !Array.isArray(value.outboundEvidenceRefs) || value.outboundEvidenceRefs.length === 0 || value.outboundEvidenceRefs.some(ref => !validId(ref))) throw Error('V3_MIG003_CANONICAL_EVIDENCE_REQUIRED');
  return Object.freeze({commerceEvidenceRef: value.commerceEvidenceRef, outboundEvidenceRefs: Object.freeze([...value.outboundEvidenceRefs])});
}

function expectedApproval(evidence: V3Mig002Evidence, action: 'PROMOTE_CANARY' | 'ROLLBACK') {
  return {
    accountId: evidence.scope.accountId,
    conversationId: evidence.scope.conversationId,
    customerId: 'customer-bound-by-reviewed-evidence',
    expectedState: action === 'PROMOTE_CANARY' ? evidence.writer.migrationState : 'V3_CANARY',
    expectedHash: `V3-MIG-002:${evidence.scope.accountId}:${evidence.scope.conversationId}`,
    expectedRevision: 1,
    expectedWorkItemId: null,
    expectedDraftRevision: null,
    compatibilityConfirmed: true,
  };
}

/**
 * This seam owns only scoped control state. It never invokes ERP, an adapter,
 * OutboundMessageService, or a second worker. V3 derived state is disposable;
 * canonical V2 commerce/outbound evidence is carried through unchanged.
 */
export class V3Mig003Control {
  private readonly states = new Map<string, V3Mig003State>();

  constructor(private readonly approvals: MigrationApprovalAuthority) {}

  state(scope: V3Mig003Scope): V3Mig003State {
    const normalized = requireScope(scope);
    return this.states.get(scopeKey(normalized.accountId, normalized.conversationId)) ?? Object.freeze({
      contractVersion: 'V3-MIG-003' as const,
      scope: normalized,
      mode: 'V2' as const,
      authoritativeWriter: 'V2' as const,
      activeWriters: Object.freeze(['V2'] as const),
      outboundOwner: 'OutboundMessageService' as const,
    });
  }

  route(scope: V3Mig003Scope): 'V2' | 'V3_CANARY' {
    return this.state(scope).mode === 'V3_CANARY' ? 'V3_CANARY' : 'V2';
  }

  activate(input: {evidence: V3Mig002Evidence; approval: MigrationApproval}): V3Mig003State {
    const eligibility = evaluateV3Mig002CanaryEligibility(input?.evidence);
    if (eligibility.status !== 'ELIGIBLE_TO_REQUEST_CANARY' || !eligibility.scope) throw Error(`V3_MIG003_ACTIVATION_INELIGIBLE:${eligibility.reasonCodes.join(',')}`);
    const evidence = input.evidence;
    const expected = expectedApproval(evidence, 'PROMOTE_CANARY');
    const approval = this.approvals.verify(input.approval, 'PROMOTE_CANARY', 'MIGRATION_OWNER', expected);
    if (!approval) throw Error('V3_MIG003_ACTIVATION_APPROVAL_REQUIRED');
    const current = this.state(evidence.scope);
    if (current.activeWriters.length !== 1 || current.authoritativeWriter !== 'V2' || current.mode === 'V3_CANARY') throw Error('V3_MIG003_ONE_WRITER_POLICY');
    const next = Object.freeze({contractVersion: 'V3-MIG-003' as const, scope: current.scope, mode: 'V3_CANARY' as const, authoritativeWriter: 'V3' as const, activeWriters: Object.freeze(['V3'] as const), outboundOwner: 'OutboundMessageService' as const});
    this.states.set(scopeKey(current.scope.accountId, current.scope.conversationId), next);
    return next;
  }

  rollback(input: {evidence: V3Mig002Evidence; approval: MigrationApproval; canonicalEvidence: V3Mig003CanonicalEvidence; derivedState: V3Mig003DerivedState}): V3Mig003RollbackResult {
    const evidence = input?.evidence;
    const scope = requireScope(evidence?.scope);
    const current = this.state(scope);
    const approval = this.approvals.verify(input.approval, 'ROLLBACK', 'MIGRATION_OWNER', expectedApproval(evidence, 'ROLLBACK'));
    if (!approval) throw Error('V3_MIG003_ROLLBACK_APPROVAL_REQUIRED');
    if (current.mode !== 'V3_CANARY' || current.activeWriters.length !== 1 || current.authoritativeWriter !== 'V3') throw Error('V3_MIG003_ROLLBACK_STATE_INVALID');
    const canonicalEvidence = requireCanonicalEvidence(input.canonicalEvidence);
    if (!input.derivedState || typeof input.derivedState.ignoreAndRebuild !== 'function') throw Error('V3_MIG003_DERIVED_STATE_REBUILD_REQUIRED');
    input.derivedState.ignoreAndRebuild(scope);
    const next = Object.freeze({contractVersion: 'V3-MIG-003' as const, scope, mode: 'V3_ROLLED_BACK' as const, authoritativeWriter: 'V2' as const, activeWriters: Object.freeze(['V2'] as const), outboundOwner: 'OutboundMessageService' as const});
    this.states.set(scopeKey(scope.accountId, scope.conversationId), next);
    return Object.freeze({state: next, derivedStateAction: 'IGNORED_AND_REBUILT' as const, preservedCanonicalEvidence: canonicalEvidence});
  }
}
