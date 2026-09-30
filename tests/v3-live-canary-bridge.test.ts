import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigrationApprovalAuthority } from '../src/migration-auth.js';
import { V3Mig003Control } from '../src/v3-mig-003-control.js';
import type { V3Mig002Evidence } from '../src/v3-mig-002-policy.js';
import { V3LiveCanaryBridge } from '../src/v3-live-canary-bridge.js';

const evidence = (): V3Mig002Evidence => ({
  scope: {accountId:'account-a', conversationId:'conversation-a'},
  shadow: {configuredMode:'SHADOW', effectiveMode:'SHADOW', configuredScope:{accountId:'account-a', conversationId:'conversation-a'}},
  canonicalScope: {accountId:'account-a', conversationId:'conversation-a', verified:true},
  writer: {currentAuthoritativeWriter:'V2', activeWriters:['V2'], proposedCanaryWriter:'V3', handoffContract:'V2_TO_V3_EXPLICIT_SINGLE_WRITER', migrationState:'V2_CANARY'},
  outbound: {soleOwner:'OutboundMessageService', alternateOwners:[], providerSendPaths:1},
  commerce: {canonicalOwner:'V2_CANONICAL_COMMERCE', aiAuthorityCutoff:'SALES_ORDER.DRAFT', postDraftCapabilitiesPresent:false},
  derivedState: {nonAuthoritative:true, rebuildable:true, scopeBound:true},
  runtime: {v3TrafficActive:false, v3RouteActive:false, providerTrafficEnabled:false},
});

const message = (conversationId = 'conversation-a') => ({channel:'whatsapp' as const, accountId:'account-a', conversationId, externalMessageId:`m-${conversationId}`, sender:{externalId:'sender'}, type:'text' as const, text:'hello', occurredAt:'2026-09-20T00:00:00.000Z'});

function approval(authority: ReturnType<typeof createMigrationApprovalAuthority>) {
  return authority.issue('owner-1','MIGRATION_OWNER','PROMOTE_CANARY', {
    accountId:'account-a', conversationId:'conversation-a', customerId:'customer-bound-by-reviewed-evidence', expectedState:'V2_CANARY',
    expectedHash:'V3-MIG-002:account-a:conversation-a', expectedRevision:1, expectedWorkItemId:null, expectedDraftRevision:null, compatibilityConfirmed:true,
  });
}

function v2(receive: (message: any) => Promise<unknown> = async () => 'v2', canonicalize = (input: any) => ({message: input, customerId: 'customer-a'})) {
  return {
    canonicalize,
    receiveCanonical: receive,
  };
}

test('live bridge is V2 by default and records bounded admission trace', async () => {
  let v2Calls = 0;
  const bridge = new V3LiveCanaryBridge(new V3Mig003Control(createMigrationApprovalAuthority()), {v2:v2(async () => {v2Calls += 1; return 'v2';})});
  assert.equal(await bridge.receive(message()), 'v2');
  assert.equal(v2Calls, 1);
  assert.equal(bridge.snapshot()[0]?.data.status, 'V2_SELECTED');
});

test('activated exact scope never falls back when V3 runtime composition is absent', async () => {
  const authority = createMigrationApprovalAuthority();
  const bridge = new V3LiveCanaryBridge(new V3Mig003Control(authority), {v2:v2()});
  bridge.activate({evidence:evidence(), approval:approval(authority)});
  await assert.rejects(() => bridge.receive(message()), /V3_RUNTIME_COMPOSITION_REQUIRED/);
  await assert.doesNotReject(() => bridge.receive(message('other-conversation')).then(value => { assert.equal(value, 'v2'); }));
  assert.equal(bridge.snapshot().at(-1)?.data.status, 'V2_SELECTED');
  assert.equal(bridge.snapshot().some(event => event.data.reasonCode === 'V3_RUNTIME_COMPOSITION_REQUIRED'), true);
});

test('selected V3 scope uses the shared queue runtime runner without a legacy runner', async () => {
  const authority = createMigrationApprovalAuthority();
  let runnerCalls = 0;
  const bridge = new V3LiveCanaryBridge(new V3Mig003Control(authority), {
    v2: {
      ...v2(),
      receiveCanonicalWithRunner: async (_canonical, runner) => {
        runnerCalls += 1;
        const result = await runner({
          start: {accountId: 'account-a', conversationId: 'conversation-a', inboundMessageId: 'durable-inbound-1', profileId: 'sales-digital-employee', nowIso: '2026-09-20T00:00:00.000Z', timezone: 'Asia/Singapore'},
          execute: async () => undefined,
        });
        return result;
      },
    },
    runtimeRunner: async ({start}) => ({status: 'TERMINAL', inboundMessageId: start.inboundMessageId}),
  });
  bridge.activate({evidence: evidence(), approval: approval(authority)});
  assert.deepEqual(await bridge.receive(message()), {status: 'TERMINAL', inboundMessageId: 'durable-inbound-1'});
  assert.equal(runnerCalls, 1);
});

test('runner result is content-free traced and scope remains exact', async () => {
  const authority = createMigrationApprovalAuthority();
  const bridge = new V3LiveCanaryBridge(new V3Mig003Control(authority), {v2:v2(), runner:async () => ({status:'TERMINAL', secret:'must-not-be-traced'})});
  bridge.activate({evidence:evidence(), approval:approval(authority)});
  assert.deepEqual(await bridge.receive(message()), {status:'TERMINAL', secret:'must-not-be-traced'});
  const effect = bridge.snapshot().at(-1)!;
  assert.equal(effect.kind, 'effects');
  assert.equal('secret' in effect.data, false);
  assert.equal(effect.data.authorityCutoff, 'SALES_ORDER.DRAFT');
});

test('raw provider conversation id is canonicalized before the V3 route decision', async () => {
  const authority = createMigrationApprovalAuthority();
  let runnerInput: any;
  const bridge = new V3LiveCanaryBridge(new V3Mig003Control(authority), {
    v2: v2(async () => 'v2', input => ({message:{...input, conversationId:'conversation-a'}, customerId:'customer-a'})),
    runner: async input => { runnerInput = input; return 'canonical-v3'; },
  });
  bridge.activate({evidence:evidence(), approval:approval(authority)});
  await assert.equal(await bridge.receive(message('provider-jid')), 'canonical-v3');
  // The server-derived canonical id, rather than the provider JID, selects MIG-003.
  assert.equal(runnerInput.conversationId, 'conversation-a');
  assert.equal(bridge.snapshot()[0]?.scope.conversationId, 'conversation-a');
});

test('pre-route canonicalization continues through V2 once without duplicate persistence', async () => {
  let canonicalizeCalls = 0;
  let canonicalIngressCalls = 0;
  let receivedConversationId = '';
  const bridge = new V3LiveCanaryBridge(new V3Mig003Control(createMigrationApprovalAuthority()), {
    v2: v2(async canonical => {
      canonicalIngressCalls += 1;
      receivedConversationId = canonical.message.conversationId;
      return 'v2';
    }, input => {
      canonicalizeCalls += 1;
      return {message:{...input, conversationId:'canonical-conversation'}, customerId:'customer-a'};
    }),
  });
  assert.equal(await bridge.receive(message('provider-jid')), 'v2');
  assert.equal(canonicalizeCalls, 1);
  assert.equal(canonicalIngressCalls, 1);
  assert.equal(receivedConversationId, 'canonical-conversation');
});

test('unresolved identity fails closed before any V3 or V2 route decision', async () => {
  let v2Calls = 0;
  const bridge = new V3LiveCanaryBridge(new V3Mig003Control(createMigrationApprovalAuthority()), {
    v2: v2(async () => { v2Calls += 1; return 'must-not-run'; }, () => undefined),
  });
  await assert.rejects(() => bridge.receive(message('provider-jid')), /V2_CANONICAL_INGRESS_REQUIRED/);
  assert.equal(v2Calls, 0);
});
