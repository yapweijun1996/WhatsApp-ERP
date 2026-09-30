import test from 'node:test';
import assert from 'node:assert/strict';
import {isV3WakeRuntimeResumeAuthorized} from '../src/v3-orchestrator-wake-resume.js';
import {projectV3OrchestratorObservation} from '../src/v3-orchestrator-observation.js';
import {V1Database} from '../src/database.js';
import {V2QueueService} from '../src/v2-queue.js';
import {buildInboundBundle} from '../src/v3-inbound-bundle.js';
import {buildV3FreshnessVector} from '../src/v3-freshness-vector.js';

const decision = (disposition: string, reasonCode: string) => ({disposition, reasonCode}) as any;

test('ORCH-004 first completed wake resumes the same runtime path', () => {
  assert.equal(isV3WakeRuntimeResumeAuthorized(decision('RESUME_AUTHORIZED', 'LEASE_REACQUIRED')), true);
});

test('ORCH-004 invalidated wake does not resume runtime work', () => {
  assert.equal(isV3WakeRuntimeResumeAuthorized(decision('NON_EFFECT_REJECTED', 'NOT_ELIGIBLE')), false);
});

test('ORCH-004 non-authorized wake does not resume runtime work', () => {
  assert.equal(isV3WakeRuntimeResumeAuthorized(decision('NON_EFFECT_PENDING', 'LEASE_UNAVAILABLE')), false);
});

test('ORCH-004 duplicate wake does not create duplicate runtime work', () => {
  assert.equal(isV3WakeRuntimeResumeAuthorized(decision('RESUME_AUTHORIZED', 'DUPLICATE_WAKE')), false);
});

test('ORCH-004 attachment observation is bounded, untrusted, and non-authoritative', () => {
  const db = new V1Database(':memory:'); db.resetAndSeed();
  const queue = new V2QueueService(db); const message = queue.enqueueInbound({accountId: 'demo-account', conversationId: 'conv-001', externalMessageId: 'orch004-message', occurredAt: '2030-01-01T00:00:00.000Z', text: 'attachment'});
  const inboundBundle = buildInboundBundle(db.db, {accountId: 'demo-account', conversationId: 'conv-001', messageIds: [message.messageId], bundleRevision: 1, hardCapAt: '2030-01-01T00:00:03.000Z', closedAt: '2030-01-01T00:00:01.000Z', closeReason: 'QUIET_WINDOW'});
  const freshnessVector = buildV3FreshnessVector({identityScope: {accountId: 'demo-account', conversationId: 'conv-001', customerId: 'CUST-001', channelAccountId: 'demo-account'}, employeeProfile: {id: 'p', version: 1}, capabilityPolicy: {policyVersion: 1, availableCapabilities: []}, workItemOrderDraftRefs: {workItem: null, orderDraft: null}, canonicalBusiness: {quotations: [], acceptances: [], outbound: [], salesOrders: []}, relevantErpEvidence: [], goalGraph: {version: null, dependencyRefs: []}, attachmentExtraction: {version: 1, dependencyRefs: []}, retentionAccess: {version: 1, dependencyRefs: []}, conversationBundle: {conversationRevision: inboundBundle.conversationRevisionAtBuild, bundleRevision: 1, messageRefs: [{id: message.messageId, version: 1}]}, authoritativeV2FreshnessFingerprint: 'v2'});
  const observation = projectV3OrchestratorObservation({
    scope: {accountId: 'demo-account', conversationId: 'conv-001'},
    inboundBundle,
    goalGraph: {scope: {accountId: 'demo-account', conversationId: 'conv-001'}, goals: [], edges: []},
    freshnessVector,
    retrievalCapabilities: [],
    attachmentEvidence: [{evidenceId: 'e', attachmentId: 'att', sourceMessageId: 'm', sourceRef: 'media://att', mediaType: 'AUDIO', extractionType: 'TRANSCRIPT', extractionVersion: 'v1', pageNumber: null, regionRef: null, timeRange: null, freshnessState: 'CURRENT', trustClass: 'UNTRUSTED_CUSTOMER_EVIDENCE'}],
  } as any);
  assert.equal(observation.authority, 'NON_AUTHORITATIVE_CONTEXT_METADATA');
  assert.equal(observation.untrustedAsInstruction, true);
  assert.equal(observation.attachmentEvidence[0]?.trustClass, 'UNTRUSTED_CUSTOMER_EVIDENCE');
  assert.equal((observation as any).attachmentEvidence[0]?.output, undefined);
});
