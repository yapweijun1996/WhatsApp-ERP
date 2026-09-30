/**
 * EVAL-005 targeted tests for V3 canary runtime composition.
 *
 * Tests: exact-scope V3 routing via existing Pi loop, non-canary scope stays V2,
 * invalid context fails closed, no dual outbound owner, authority invariant,
 * composition scope is never fabricated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { CommerceService } from '../src/commerce.js';
import { V2CanaryIngressRouter } from '../src/v2-canary-ingress-router.js';
import { V2QueueService } from '../src/v2-queue.js';
import { V2PiHarness } from '../src/v2-pi-harness.js';
import { OutboundMessageService } from '../src/outbound-message-service.js';
import { createV3CanaryComposition, createV3CanaryRuntimeRunner } from '../src/v3-canary-runtime-composition.js';
import { V3LiveCanaryBridge } from '../src/v3-live-canary-bridge.js';
import { V3Mig003Control } from '../src/v3-mig-003-control.js';
import { createMigrationApprovalAuthority } from '../src/migration-auth.js';
import type { V3Mig002Evidence } from '../src/v3-mig-002-policy.js';
import { SimulatedChannel } from '../src/channels.js';

const A = 'demo-account';
const C = 'conv-001';
const U = 'CUST-001';
const INBOUND_EXT_ID = 'eval005-inbound-1';
const INBOUND_MSG_ID = 'eval005-msg-1';

function setupDb() {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  // Insert a canonical inbound message
  db.db.prepare(
    "INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))"
  ).run(INBOUND_MSG_ID, C, INBOUND_EXT_ID, 'INBOUND', 'text', 'hello', '+6591110001', '+6591110001', A);
  // Enqueue the message so v2_inbox_items and v2_conversation_inbox exist
  const queue = new V2QueueService(db);
  queue.enqueueInbound({
    accountId: A,
    conversationId: C,
    externalMessageId: INBOUND_EXT_ID,
    messageId: INBOUND_MSG_ID,
    occurredAt: new Date().toISOString(),
    text: 'hello',
    senderExternalId: '+6591110001',
    senderPhone: '+6591110001',
  });
  return db;
}

function stubHarness(db: V1Database): V2PiHarness {
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(db, channel as any);
  return new V2PiHarness(db, {
    model: {invoke: async () => ({messages: [], stopReason: 'end_turn', usage: {inputTokens: 0, outputTokens: 0}})} as any,
    streamFn: async function*() {},
    outbound: commerce.outbound,
  });
}

function migrationEvidence(): V3Mig002Evidence {
  return {
    scope: {accountId: A, conversationId: C},
    shadow: {configuredMode: 'SHADOW', effectiveMode: 'SHADOW', configuredScope: {accountId: A, conversationId: C}},
    canonicalScope: {accountId: A, conversationId: C, verified: true},
    writer: {currentAuthoritativeWriter: 'V2', activeWriters: ['V2'], proposedCanaryWriter: 'V3', handoffContract: 'V2_TO_V3_EXPLICIT_SINGLE_WRITER', migrationState: 'V2_CANARY'},
    outbound: {soleOwner: 'OutboundMessageService', alternateOwners: [], providerSendPaths: 1},
    commerce: {canonicalOwner: 'V2_CANONICAL_COMMERCE', aiAuthorityCutoff: 'SALES_ORDER.DRAFT', postDraftCapabilitiesPresent: false},
    derivedState: {nonAuthoritative: true, rebuildable: true, scopeBound: true},
    runtime: {v3TrafficActive: false, v3RouteActive: false, providerTrafficEnabled: false},
  };
}

test('V3 composition builds valid host context from canonical DB state', () => {
  const db = setupDb();
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(db, channel as any);
  const harness = stubHarness(db);
  const composition = createV3CanaryComposition(db, harness, commerce.outbound);

  const ctx = composition.build({
    start: {
      accountId: A,
      conversationId: C,
      inboundMessageId: INBOUND_MSG_ID,
      profileId: 'sales-digital-employee',
      nowIso: new Date().toISOString(),
      timezone: 'Asia/Singapore',
    },
  });

  // Observation scope must match the turn scope
  assert.equal(ctx.observation.scope.accountId, A);
  assert.equal(ctx.observation.scope.conversationId, C);

  // InboundBundle must contain the queued message
  const bundle = ctx.observation.inboundBundle as any;
  assert.ok(Array.isArray(bundle.messageIds));
  assert.ok(bundle.messageIds.includes(INBOUND_MSG_ID));
  assert.equal(bundle.accountId, A);
  assert.equal(bundle.conversationId, C);

  // FreshnessVector must be host-derived with correct scope
  const vector = ctx.observation.freshnessVector as any;
  assert.equal(vector.authority, 'HOST_DERIVED_NON_AUTHORITATIVE_CONTEXT_INPUT');
  assert.equal(vector.dependencies.identityScope.accountId, A);
  assert.equal(vector.dependencies.identityScope.conversationId, C);

  // GoalGraph may be empty but must have correct scope
  const graph = ctx.observation.goalGraph as any;
  assert.equal(graph.scope.accountId, A);
  assert.equal(graph.scope.conversationId, C);
  assert.ok(Array.isArray(graph.goals));

  // No retrieval tools (P0 gap - expected)
  assert.deepEqual(ctx.observation.retrievalCapabilities, []);

  // No attachment evidence (P0 gap - expected)
  assert.deepEqual(ctx.observation.attachmentEvidence, []);

  // Fulfillment scope must match
  assert.equal(ctx.fulfillment.scope.accountId, A);
  assert.equal(ctx.fulfillment.scope.conversationId, C);
});

test('V3 composition fulfillment uses the exact same OutboundMessageService instance', () => {
  const db = setupDb();
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(db, channel as any);
  const harness = stubHarness(db);
  const outbound = commerce.outbound;
  const composition = createV3CanaryComposition(db, harness, outbound);

  const ctx = composition.build({
    start: {
      accountId: A,
      conversationId: C,
      inboundMessageId: INBOUND_MSG_ID,
      profileId: 'sales-digital-employee',
      nowIso: new Date().toISOString(),
      timezone: 'Asia/Singapore',
    },
  });

  // Must be the exact same OutboundMessageService instance — no dual owner
  assert.strictEqual(ctx.fulfillment.outbound, outbound);
  assert.ok(ctx.fulfillment.outbound instanceof OutboundMessageService);
});

test('V3 composition AI authority cutoff is SALES_ORDER.DRAFT via observation projection', async () => {
  const db = setupDb();
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(db, channel as any);
  const harness = stubHarness(db);
  const composition = createV3CanaryComposition(db, harness, commerce.outbound);

  const ctx = composition.build({
    start: {
      accountId: A,
      conversationId: C,
      inboundMessageId: INBOUND_MSG_ID,
      profileId: 'sales-digital-employee',
      nowIso: new Date().toISOString(),
      timezone: 'Asia/Singapore',
    },
  });

  // Projecting the observation must succeed and report SALES_ORDER.DRAFT authority cutoff
  const {projectV3OrchestratorObservation} = await import('../src/v3-orchestrator-observation.js');
  const projection = projectV3OrchestratorObservation(ctx.observation);
  assert.equal(projection.aiAuthorityCutoff, 'SALES_ORDER.DRAFT');
  assert.equal(projection.authority, 'NON_AUTHORITATIVE_CONTEXT_METADATA');
  assert.equal(projection.untrustedAsInstruction, true);
});

test('V3 composition fails closed when inbound message is not in v2_inbox_items', () => {
  const db = setupDb();
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(db, channel as any);
  const harness = stubHarness(db);
  const composition = createV3CanaryComposition(db, harness, commerce.outbound);

  // Use an inbound message that exists in messages but not in v2_inbox_items
  db.db.prepare(
    "INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,sender_phone,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))"
  ).run('unqueued-msg', C, 'unqueued-ext', 'INBOUND', 'text', 'test', '+6591110001', '+6591110001', A);

  // buildInboundBundle fails with MESSAGE_REF_SCOPE (message not in v2_inbox_items)
  // or deriveFreshnessInput fails with V3_CANARY_ARRIVAL_SCOPE_REQUIRED — both are
  // legitimate fail-closed codes; the exact one depends on build order.
  assert.throws(
    () => composition.build({
      start: {
        accountId: A,
        conversationId: C,
        inboundMessageId: 'unqueued-msg',
        profileId: 'sales-digital-employee',
        nowIso: new Date().toISOString(),
        timezone: 'Asia/Singapore',
      },
    }),
    /V3_CANARY_ARRIVAL_SCOPE_REQUIRED|V3_INBOUND_BUNDLE_INVALID:MESSAGE_REF_SCOPE/,
  );
});

test('V3 composition fails closed when inbound message does not exist at all', () => {
  const db = setupDb();
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(db, channel as any);
  const harness = stubHarness(db);
  const composition = createV3CanaryComposition(db, harness, commerce.outbound);

  assert.throws(
    () => composition.build({
      start: {
        accountId: A,
        conversationId: C,
        inboundMessageId: 'nonexistent-msg-id',
        profileId: 'sales-digital-employee',
        nowIso: new Date().toISOString(),
        timezone: 'Asia/Singapore',
      },
    }),
    /AGENT_CONTEXT_INVALID:INBOUND_MESSAGE_SCOPE|V3_CANARY_ARRIVAL_SCOPE_REQUIRED/,
  );
});

test('non-canary conversation scope remains V2 after V3 composition is wired', async () => {
  const db = setupDb();
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(db, channel as any);
  const harness = stubHarness(db);
  const composition = createV3CanaryComposition(db, harness, commerce.outbound);
  const runner = createV3CanaryRuntimeRunner(composition);

  const migAuthority = createMigrationApprovalAuthority();
  let v2Calls = 0;
  const bridge = new V3LiveCanaryBridge(new V3Mig003Control(migAuthority), {
    v2: {
      canonicalize: (input: any) => ({message: input, customerId: U}),
      receiveCanonical: async () => { v2Calls += 1; return 'v2-result'; },
    },
    runtimeRunner: runner,
  });

  // No activation: route is V2
  const result = await bridge.receive({
    channel: 'whatsapp', accountId: A, conversationId: C,
    externalMessageId: INBOUND_EXT_ID, sender: {externalId: '+6591110001'},
    type: 'text', text: 'hello', occurredAt: new Date().toISOString(),
  });
  assert.equal(result, 'v2-result');
  assert.equal(v2Calls, 1);
  // Admission trace shows V2 selected
  assert.equal(bridge.snapshot()[0]?.data.status, 'V2_SELECTED');
});

test('activated V3 scope routes through composition runner not legacy V2 path', async () => {
  const db = setupDb();
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(db, channel as any);
  const harness = stubHarness(db);
  const composition = createV3CanaryComposition(db, harness, commerce.outbound);
  const runner = createV3CanaryRuntimeRunner(composition);

  const migAuthority = createMigrationApprovalAuthority();
  let v2ReceiveCalls = 0;
  let runnerInvocations = 0;

  const bridge = new V3LiveCanaryBridge(new V3Mig003Control(migAuthority), {
    v2: {
      canonicalize: (input: any) => ({message: {...input, conversationId: C}, customerId: U}),
      receiveCanonical: async () => { v2ReceiveCalls += 1; return 'v2-result'; },
      receiveCanonicalWithRunner: async (_canonical: any, rr: any) => {
        runnerInvocations += 1;
        // Intercept: do not actually invoke the full Pi loop
        return {status: 'TERMINAL', reasonCode: 'PI_FINAL_PENDING_GROUNDING'};
      },
    },
    runtimeRunner: runner,
  });

  // Activate the exact scope (customerId must be the sentinel used by V3Mig003Control.expectedApproval)
  const evidence = migrationEvidence();
  const approval = migAuthority.issue('owner-1', 'MIGRATION_OWNER', 'PROMOTE_CANARY', {
    accountId: A, conversationId: C,
    customerId: 'customer-bound-by-reviewed-evidence',
    expectedState: 'V2_CANARY',
    expectedHash: 'V3-MIG-002:demo-account:conv-001',
    expectedRevision: 1,
    expectedWorkItemId: null, expectedDraftRevision: null,
    compatibilityConfirmed: true,
  });
  bridge.activate({evidence, approval});

  await bridge.receive({
    channel: 'whatsapp', accountId: A, conversationId: C,
    externalMessageId: INBOUND_EXT_ID, sender: {externalId: '+6591110001'},
    type: 'text', text: 'hello', occurredAt: new Date().toISOString(),
  });

  // V3 route was selected and the runtime runner was called
  assert.equal(runnerInvocations, 1);
  assert.equal(v2ReceiveCalls, 0);
  assert.equal(bridge.snapshot()[0]?.data.status, 'V3_CANARY_SELECTED');
});

test('composition fulfillment scope matches start scope exactly — no fabrication', () => {
  const db = setupDb();
  const channel = new SimulatedChannel();
  const commerce = new CommerceService(db, channel as any);
  const harness = stubHarness(db);
  const composition = createV3CanaryComposition(db, harness, commerce.outbound);

  const start = {
    accountId: A,
    conversationId: C,
    inboundMessageId: INBOUND_MSG_ID,
    profileId: 'sales-digital-employee',
    nowIso: new Date().toISOString(),
    timezone: 'Asia/Singapore',
  };
  const ctx = composition.build({start});

  // Observation and fulfillment scopes must be derived from start, not invented
  assert.equal(ctx.observation.scope.accountId, start.accountId);
  assert.equal(ctx.observation.scope.conversationId, start.conversationId);
  assert.equal(ctx.fulfillment.scope.accountId, start.accountId);
  assert.equal(ctx.fulfillment.scope.conversationId, start.conversationId);

  // Freshness vector scope must match too
  const vector = ctx.observation.freshnessVector as any;
  assert.equal(vector.dependencies.identityScope.accountId, start.accountId);
  assert.equal(vector.dependencies.identityScope.conversationId, start.conversationId);
});
