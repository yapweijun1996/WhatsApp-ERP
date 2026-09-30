import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluateV3Mig002CanaryEligibility, type V3Mig002Evidence} from '../src/v3-mig-002-policy.js';

const complete = (): V3Mig002Evidence => ({
  scope: {accountId: 'account-a', conversationId: 'conversation-a'},
  shadow: {configuredMode: 'SHADOW', effectiveMode: 'SHADOW', configuredScope: {accountId: 'account-a', conversationId: 'conversation-a'}},
  canonicalScope: {accountId: 'account-a', conversationId: 'conversation-a', verified: true},
  writer: {currentAuthoritativeWriter: 'V2', activeWriters: ['V2'], proposedCanaryWriter: 'V3', handoffContract: 'V2_TO_V3_EXPLICIT_SINGLE_WRITER', migrationState: 'V2_CANARY'},
  outbound: {soleOwner: 'OutboundMessageService', alternateOwners: [], providerSendPaths: 1},
  commerce: {canonicalOwner: 'V2_CANONICAL_COMMERCE', aiAuthorityCutoff: 'SALES_ORDER.DRAFT', postDraftCapabilitiesPresent: false},
  derivedState: {nonAuthoritative: true, rebuildable: true, scopeBound: true},
  runtime: {v3TrafficActive: false, v3RouteActive: false, providerTrafficEnabled: false},
});

test('MIG-002 defaults and incomplete evidence fail closed', () => {
  assert.equal(evaluateV3Mig002CanaryEligibility(undefined).status, 'INELIGIBLE');
  assert.deepEqual(evaluateV3Mig002CanaryEligibility({} as V3Mig002Evidence).reasonCodes, ['SCOPE_REQUIRED']);
});

test('MIG-002 exact account+conversation mismatch fails closed', () => {
  const evidence = complete();
  (evidence.shadow.configuredScope as any).conversationId = 'other-conversation';
  assert.deepEqual(evaluateV3Mig002CanaryEligibility(evidence).reasonCodes, ['SCOPE_MISMATCH']);
});

test('MIG-002 rejects dual writers and alternate outbound owners', () => {
  const evidence = complete();
  (evidence.writer as any).activeWriters = ['V2', 'V3'];
  (evidence.outbound as any).alternateOwners = ['V3Transport'];
  const result = evaluateV3Mig002CanaryEligibility(evidence);
  assert.equal(result.status, 'INELIGIBLE');
  assert.deepEqual(result.reasonCodes, ['DUAL_WRITER', 'ALTERNATE_OUTBOUND_OWNER']);
});

test('MIG-002 classifies complete structural evidence without activation', () => {
  const result = evaluateV3Mig002CanaryEligibility(complete());
  assert.equal(result.status, 'ELIGIBLE_TO_REQUEST_CANARY');
  assert.equal(result.canaryAuthorityGranted, false);
  assert.equal(result.activatesTraffic, false);
});

test('MIG-002 rejects any already-active V3 route, customer traffic, or provider traffic', () => {
  for (const field of ['v3TrafficActive', 'v3RouteActive', 'providerTrafficEnabled'] as const) {
    const evidence = complete();
    (evidence.runtime as any)[field] = true;
    const result = evaluateV3Mig002CanaryEligibility(evidence);
    assert.equal(result.status, 'INELIGIBLE');
    assert.deepEqual(result.reasonCodes, ['TRAFFIC_ALREADY_ACTIVE']);
    assert.equal(result.canaryAuthorityGranted, false);
    assert.equal(result.activatesTraffic, false);
  }
});

test('MIG-002 rejects authority beyond SALES_ORDER.DRAFT', () => {
  const evidence = complete();
  (evidence.commerce as any).aiAuthorityCutoff = 'SALES_ORDER.POSTED';
  assert.deepEqual(evaluateV3Mig002CanaryEligibility(evidence).reasonCodes, ['AI_AUTHORITY_WIDENED']);
});
