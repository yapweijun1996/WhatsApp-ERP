/**
 * Host-owned V3 canary runtime composition for EVAL-005 (Goal-First Fast Track).
 *
 * Wires the existing V3 ORCH/FUL/Freshness seams onto V2PiHarness.runV3 using
 * only canonical DB state. Authority remains capped at SALES_ORDER.DRAFT.
 * No second outbound owner is introduced; OutboundMessageService is the sole send path.
 *
 * KNOWN P0 GAP: media bytes / attachment-extraction runtime is not yet present.
 * attachmentEvidence is therefore [] and retrievalCapabilities is []. Text/reply
 * canary is ready; multimodal EVAL-005 features are blocked until this is closed.
 */
import type Database from 'better-sqlite3';
import { AgentContextBuilder } from './v2-agent-context.js';
import { buildInboundBundle } from './v3-inbound-bundle.js';
import { V3GoalGraphStore } from './v3-goal-graph.js';
import { buildV3FreshnessVectorFromDatabase, type V3FreshnessVectorInput } from './v3-freshness-vector.js';
import { V3OrchestratorGoalReverifySession } from './v3-orchestrator-goal-reverify.js';
import {
  createV3CanaryRuntimeRunner,
  type V3CanaryRuntimeComposition,
  type V3CanaryHostContext,
} from './v3-live-canary-bridge.js';
import type { V2PiHarness } from './v2-pi-harness.js';
import type { V1Database } from './database.js';
import type { OutboundMessageService } from './outbound-message-service.js';
import type { AgentTurnStart } from './v2-agent-turn-coordinator.js';

export type { V3CanaryRuntimeComposition };
export { createV3CanaryRuntimeRunner };

type AnyContext = Record<string, any>;

function deriveFreshnessInput(
  db: Database.Database,
  ctx: AnyContext,
  accountId: string,
  conversationId: string,
  inboundMessageId: string,
): Omit<V3FreshnessVectorInput, 'authoritativeV2FreshnessFingerprint'> {
  const arrival = db.prepare(
    'SELECT i.message_id AS messageId, i.arrival_seq AS arrivalSeq FROM v2_inbox_items i WHERE i.account_id=? AND i.conversation_id=? AND i.message_id=?',
  ).get(accountId, conversationId, inboundMessageId) as {messageId: string; arrivalSeq: number} | undefined;
  if (!arrival) throw new Error('V3_CANARY_ARRIVAL_SCOPE_REQUIRED');
  const messageRefs = [{id: arrival.messageId, version: arrival.arrivalSeq}];
  const business = (value: any) => value ? [{id: value.id, revision: 1, status: value.status}] : [];
  return {
    identityScope: {
      accountId,
      conversationId,
      customerId: ctx.customerContext?.id ?? null,
      channelAccountId: accountId,
    },
    employeeProfile: {id: ctx.profile.id, version: ctx.profile.version},
    capabilityPolicy: {
      policyVersion: ctx.profile.version,
      availableCapabilities: ctx.availableCapabilities.map((c: any) => ({id: c.name, version: c.version})),
    },
    workItemOrderDraftRefs: {
      workItem: ctx.activeWorkItem
        ? {id: ctx.activeWorkItem.id, revision: ctx.activeWorkItem.revision, status: ctx.activeWorkItem.state}
        : null,
      orderDraft: ctx.orderDraft
        ? {id: ctx.orderDraft.id, revision: ctx.orderDraft.revision, status: ctx.orderDraft.status}
        : null,
    },
    canonicalBusiness: {
      quotations: business(ctx.activeQuotationSalesOrder?.quotation),
      acceptances: business(ctx.activeQuotationSalesOrder?.acceptance),
      outbound: business(ctx.activeQuotationSalesOrder?.outbound),
      salesOrders: business(ctx.activeQuotationSalesOrder?.salesOrder),
    },
    relevantErpEvidence: (ctx.relevantErpEvidenceAndPolicies?.validation?.evidence ?? [])
      .map((e: any) => ({sourceId: e.id, sourceVersion: e.sourceVersion, kind: e.type})),
    goalGraph: {version: null, dependencyRefs: []},
    attachmentExtraction: {version: null, dependencyRefs: []},
    retentionAccess: {version: 1, dependencyRefs: []},
    conversationBundle: {
      conversationRevision: messageRefs.length,
      bundleRevision: messageRefs.length,
      messageRefs,
    },
  };
}

function buildHostContext(
  database: V1Database,
  outbound: OutboundMessageService,
  start: AgentTurnStart,
): V3CanaryHostContext {
  const {accountId, conversationId, inboundMessageId, profileId, nowIso, timezone} = start;
  const db = database.db;

  // V2 context — synchronous since better-sqlite3 is synchronous.
  const ctx: AnyContext = new AgentContextBuilder(db).build({
    turnId: inboundMessageId,
    accountId,
    conversationId,
    inboundMessageId,
    profileId,
    nowIso,
    timezone,
  });

  // InboundBundle: single-message via V2 queue drain (CHANNEL_SEMANTICS).
  const now = new Date().toISOString();
  const bundle = buildInboundBundle(db, {
    accountId,
    conversationId,
    messageIds: [inboundMessageId],
    bundleRevision: 1,
    hardCapAt: now,
    closedAt: now,
    closeReason: 'CHANNEL_SEMANTICS',
    processingState: 'PROCESSING',
  });

  const scope = {accountId, conversationId};
  const goalGraphStore = new V3GoalGraphStore(database);

  // GoalGraph: empty is legitimate for a fresh conversation.
  // readGoalGraph returns scope objects via Object.create(null) (from the store's
  // exact() helper). projectV3OrchestratorObservation requires Object.prototype on
  // all nested data objects, so normalize through JSON to restore plain prototypes.
  const goalGraph = JSON.parse(JSON.stringify(goalGraphStore.readGoalGraph(scope)));

  // FreshnessVector: derived exclusively from canonical DB + V2 context.
  const freshnessInput = deriveFreshnessInput(db, ctx, accountId, conversationId, inboundMessageId);
  const freshnessVector = buildV3FreshnessVectorFromDatabase(db, freshnessInput);

  // GoalReverify: refresh re-reads DB for goal state changes during the turn.
  const goalReverifySession = new V3OrchestratorGoalReverifySession(database, {
    scope,
    initial: {goalGraph, freshnessVector},
    refresh: () => {
      const freshCtx: AnyContext = new AgentContextBuilder(db).build({
        turnId: inboundMessageId,
        accountId,
        conversationId,
        inboundMessageId,
        profileId,
        nowIso: new Date().toISOString(),
        timezone,
      });
      return {
        goalGraph: JSON.parse(JSON.stringify(goalGraphStore.readGoalGraph(scope))),
        freshnessVector: buildV3FreshnessVectorFromDatabase(
          db,
          deriveFreshnessInput(db, freshCtx, accountId, conversationId, inboundMessageId),
        ),
      };
    },
  });

  // replyToExternalMessageId: inbound message's external id for WhatsApp reply threading.
  const msgRow = db.prepare("SELECT external_message_id FROM messages WHERE id=? AND account_id=? AND direction='INBOUND'")
    .get(inboundMessageId, accountId) as {external_message_id: string} | undefined;

  return {
    observation: {
      scope,
      inboundBundle: bundle,
      goalGraph,
      freshnessVector,
      retrievalCapabilities: [],   // No retrieval index: P0 gap for full EVAL-005
      attachmentEvidence: [],      // No extraction runtime: P0 gap for multimodal EVAL-005
    },
    goalReverify: goalReverifySession,
    fulfillment: {
      scope,
      goalGraphStore,
      outbound,
      ...(msgRow?.external_message_id ? {replyToExternalMessageId: msgRow.external_message_id} : {}),
    },
  };
}

/**
 * Creates a V3CanaryRuntimeComposition from existing V2 infrastructure.
 * piHarness.runV3 remains the sole Pi loop; no duplicate agent is created.
 */
export function createV3CanaryComposition(
  database: V1Database,
  piHarness: V2PiHarness,
  outbound: OutboundMessageService,
): V3CanaryRuntimeComposition {
  return {
    pi: piHarness,
    build: ({start}: {start: AgentTurnStart}) => buildHostContext(database, outbound, start),
  };
}
