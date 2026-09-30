import assert from 'node:assert/strict';
import test from 'node:test';
import {createMigrationApprovalAuthority, type MigrationApprovalDescriptor} from '../src/migration-auth.js';
import {V3Mig003Control} from '../src/v3-mig-003-control.js';
import type {V3Mig002Evidence} from '../src/v3-mig-002-policy.js';

const evidence = (): V3Mig002Evidence => ({
  scope: {accountId: 'account-a', conversationId: 'conversation-a'},
  shadow: {configuredMode: 'SHADOW', effectiveMode: 'SHADOW', configuredScope: {accountId: 'account-a', conversationId: 'conversation-a'}},
  canonicalScope: {accountId: 'account-a', conversationId: 'conversation-a', verified: true},
  writer: {currentAuthoritativeWriter: 'V2', activeWriters: ['V2'], proposedCanaryWriter: 'V3', handoffContract: 'V2_TO_V3_EXPLICIT_SINGLE_WRITER', migrationState: 'V2_CANARY'},
  outbound: {soleOwner: 'OutboundMessageService', alternateOwners: [], providerSendPaths: 1},
  commerce: {canonicalOwner: 'V2_CANONICAL_COMMERCE', aiAuthorityCutoff: 'SALES_ORDER.DRAFT', postDraftCapabilitiesPresent: false},
  derivedState: {nonAuthoritative: true, rebuildable: true, scopeBound: true},
  runtime: {v3TrafficActive: false, v3RouteActive: false, providerTrafficEnabled: false},
});

const approval = (authority: ReturnType<typeof createMigrationApprovalAuthority>, action: 'PROMOTE_CANARY' | 'ROLLBACK') => authority.issue('owner-1', 'MIGRATION_OWNER', action, {
  accountId: 'account-a', conversationId: 'conversation-a', customerId: 'customer-bound-by-reviewed-evidence', expectedState: action === 'PROMOTE_CANARY' ? 'V2_CANARY' : 'V3_CANARY', expectedHash: 'V3-MIG-002:account-a:conversation-a', expectedRevision: 1, expectedWorkItemId: null, expectedDraftRevision: null, compatibilityConfirmed: true,
});

test('MIG-003 activation is owner-authorized, scoped, and single-writer', () => {
  const authority = createMigrationApprovalAuthority();
  const control = new V3Mig003Control(authority);
  assert.throws(() => control.activate({evidence: evidence(), approval: {} as object}), /ACTIVATION_APPROVAL_REQUIRED/);
  const activated = control.activate({evidence: evidence(), approval: approval(authority, 'PROMOTE_CANARY')});
  assert.deepEqual(activated, {contractVersion: 'V3-MIG-003', scope: {accountId: 'account-a', conversationId: 'conversation-a'}, mode: 'V3_CANARY', authoritativeWriter: 'V3', activeWriters: ['V3'], outboundOwner: 'OutboundMessageService'});
  assert.equal(control.route({accountId: 'account-b', conversationId: 'conversation-b'}), 'V2');
  assert.throws(() => control.activate({evidence: evidence(), approval: approval(authority, 'PROMOTE_CANARY')}), /ONE_WRITER_POLICY/);
});

test('MIG-003 rollback drill ignores/rebuilds only V3 derived state and preserves V2 evidence', () => {
  const authority = createMigrationApprovalAuthority();
  const control = new V3Mig003Control(authority);
  control.activate({evidence: evidence(), approval: approval(authority, 'PROMOTE_CANARY')});
  let rebuilt = 0;
  let receivedScope: unknown;
  const canonicalEvidence = {commerceEvidenceRef: 'commerce-evidence-1', outboundEvidenceRefs: ['outbound-evidence-1', 'outbound-evidence-2']} as const;
  const result = control.rollback({evidence: evidence(), approval: approval(authority, 'ROLLBACK'), canonicalEvidence, derivedState: {ignoreAndRebuild: scope => { rebuilt += 1; receivedScope = scope; }}});
  assert.equal(rebuilt, 1);
  assert.deepEqual(receivedScope, evidence().scope);
  assert.deepEqual(result.preservedCanonicalEvidence, canonicalEvidence);
  assert.equal(result.derivedStateAction, 'IGNORED_AND_REBUILT');
  assert.equal(control.route(evidence().scope), 'V2');
  assert.deepEqual(control.state(evidence().scope).activeWriters, ['V2']);
  assert.equal(result.state.outboundOwner, 'OutboundMessageService');
});

test('MIG-003 rejects rollback without canonical evidence or derived-state rebuild', () => {
  const authority = createMigrationApprovalAuthority();
  const control = new V3Mig003Control(authority);
  control.activate({evidence: evidence(), approval: approval(authority, 'PROMOTE_CANARY')});
  assert.throws(() => control.rollback({evidence: evidence(), approval: approval(authority, 'ROLLBACK'), canonicalEvidence: {commerceEvidenceRef: '', outboundEvidenceRefs: []}, derivedState: {ignoreAndRebuild: () => undefined}}), /CANONICAL_EVIDENCE_REQUIRED/);
  assert.throws(() => control.rollback({evidence: evidence(), approval: approval(authority, 'ROLLBACK'), canonicalEvidence: {commerceEvidenceRef: 'commerce-evidence-1', outboundEvidenceRefs: ['outbound-evidence-1']}, derivedState: {} as never}), /DERIVED_STATE_REBUILD_REQUIRED/);
});
