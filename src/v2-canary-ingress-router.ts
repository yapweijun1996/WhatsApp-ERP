import { randomUUID } from 'node:crypto';
import type { IncomingChannelMessage } from './channel-contract.js';
import { CommerceService } from './commerce.js';
import { V1Database } from './database.js';
import { V2QueueService } from './v2-queue.js';
import { V2RolloutService } from './v2-rollout.js';
import { V2_CAPABILITIES } from './v2-rollout.js';
import { AgentTurnCoordinator, type AgentTurnStart } from './v2-agent-turn-coordinator.js';
import { V2TransportRuntime } from './v2-transport-runtime.js';
import { V2CapabilityExecutor } from './v2-capability-executor.js';
import type { AgentModelTransport } from './v2-agent-model-transport.js';
import type { RuntimeOutboundOwner } from './v2-runtime-outbound.js';
import type { PiHarnessRunner } from './v2-pi-harness.js';
import { ConversationIngressPersistence } from './v2-conversation-ingress-persistence.js';
import { InboundAbuseGuard, PROSPECT_ABUSE_REPLIES, PROSPECT_SUSPICIOUS_REPLY } from './v2-inbound-abuse-guard.js';
import { ProspectSemanticRouter, type ProspectModelCaller } from './v2-prospect-semantic-router.js';
import { createPublicCatalogReader, type ProspectCatalogResult } from './v2-prospect-public-catalog.js';
import type { PublicCatalogReadContract } from './erp.js';
import type { IdentityState } from './v2-identity-resolver.js';
import type { OutgoingChannelMessage } from './channel-contract.js';

/** Audit prefix for a NORMAL prospect that fell back to the fixed onboarding reply. */
export const PROSPECT_AI_FALLBACK_PREFIX = 'PROSPECT_AI_FALLBACK_';
/** Audit suffix marking a fallback whose outbound reply was withheld by the cooldown. */
export const PROSPECT_AI_FALLBACK_SUPPRESSED_SUFFIX = '_SUPPRESSED';
/** Audit suffix marking a fallback withheld because a newer inbound already overtook it. */
export const PROSPECT_AI_FALLBACK_STALE_SUPPRESSED_SUFFIX = '_STALE_SUPPRESSED';
/** Cooldown between identical fallback replies to the same prospect conversation. */
export const PROSPECT_AI_FALLBACK_COOLDOWN_MS = 10 * 60 * 1000;
/** Audit outcome for a reply composed from retrieved public catalog evidence. */
export const PROSPECT_AI_CATALOG_GROUNDED_OUTCOME = 'PROSPECT_AI_ROUTED_CATALOG_GROUNDED';
/** Audit outcome for an honest no-match answer over an empty catalog result. */
export const PROSPECT_AI_CATALOG_NO_MATCH_OUTCOME = 'PROSPECT_AI_ROUTED_CATALOG_NO_MATCH';
/** Outcome for a provider redelivery whose reply was already decided and acted on. */
export const PROSPECT_DUPLICATE_DELIVERY_OUTCOME = 'PROSPECT_DUPLICATE_DELIVERY';

export type ProspectReplyScope = Readonly<{accountId:string;externalConversationId:string}>;
export type V2CanaryRouterOptions = { prospectReplyScopes?:readonly ProspectReplyScope[]; enabled?: boolean; transport?: AgentModelTransport; piHarness?: PiHarnessRunner; outbound: RuntimeOutboundOwner; owner?: string; timezone?: string; /** Explicitly test/demo-only V1 compatibility; never enable for live traffic. */ allowLegacyFallback?: boolean; /** Optional AI routing seam for NORMAL prospects. Fails closed to static onboarding reply when absent. */ prospectModel?: ProspectModelCaller; /** PUBLIC_CATALOG_READ surface for prospect discovery. Defaults to the canonical product source. */ prospectCatalog?: PublicCatalogReadContract };
export type CanonicalTurnRunner = (input: { start: AgentTurnStart; execute: (action: any, signal?: AbortSignal) => Promise<unknown> | unknown }) => Promise<unknown>;

/** Sole inbound dispatcher. Routing is server-owned and decided before any V2 claim. */
export class V2CanaryIngressRouter {
  private readonly prospectReplyScopeKeys:ReadonlySet<string>;
  private readonly queue: V2QueueService;
  private readonly executor: V2CapabilityExecutor;
  private readonly enabled: boolean;
  private readonly legacyFallbackEnabled: boolean;
  private readonly ingressPersistence: ConversationIngressPersistence;
  private readonly abuseGuard: InboundAbuseGuard;
  /** The only ERP surface a prospect turn can reach: two bound public catalog reads. */
  private readonly prospectCatalog: PublicCatalogReadContract;
  private readonly drains = new Map<string, Promise<Map<string, unknown>>>();

  constructor(private readonly database: V1Database, private readonly commerce: CommerceService, private readonly rollout: V2RolloutService, private readonly options: V2CanaryRouterOptions) {
    const scopes=options.prospectReplyScopes??[];
    if(!Array.isArray(scopes)||scopes.length>1000)throw Error('PROSPECT_REPLY_SCOPE_INVALID');
    this.prospectReplyScopeKeys=new Set(scopes.map(s=>{if(!s||typeof s.accountId!=='string'||typeof s.externalConversationId!=='string'||!s.accountId.trim()||!s.externalConversationId.trim()||s.accountId.length>200||s.externalConversationId.length>200||s.accountId.includes('*')||s.externalConversationId.includes('*'))throw Error('PROSPECT_REPLY_SCOPE_INVALID');return JSON.stringify([s.accountId,s.externalConversationId])}));
    this.queue = new V2QueueService(database);
    this.executor = new V2CapabilityExecutor(database, commerce);
    this.ingressPersistence = new ConversationIngressPersistence(database);
    this.abuseGuard = new InboundAbuseGuard(database.db);
    this.prospectCatalog = options.prospectCatalog ?? createPublicCatalogReader(database.db);
    this.enabled = options.enabled ?? /^(1|true|yes)$/i.test(process.env.V2_CANARY_RUNTIME_ENABLED ?? 'false');
    // This compatibility seam is physically unavailable to live runtimes.
    this.legacyFallbackEnabled = process.env.NODE_ENV === 'test' && options.allowLegacyFallback === true;
  }

  async receive(input: IncomingChannelMessage): Promise<unknown> {
    if (!this.enabled) {
      if (this.legacyFallbackEnabled) return this.commerce.inbound(input);
      throw Error('V2_RUNTIME_DISABLED_FAIL_CLOSED');
    }
    const canonical = this.canonicalize(input);
    if (!canonical) {
      if (this.legacyFallbackEnabled && this.authorityFor(input.accountId, input.conversationId)?.authoritative_writer !== 'V2') return this.commerce.inbound(input);
      throw Error('V2_CANONICAL_INGRESS_REQUIRED');
    }
    return this.receiveCanonical(canonical);
  }

  /** Host-owned continuation for callers that already performed ingress canonicalization. */
  async receiveCanonical(canonical: NonNullable<ReturnType<ConversationIngressPersistence['resolve']>>): Promise<unknown> {
    return this.receiveCanonicalWithRunner(canonical);
  }

  /** V3 host-only continuation: same enqueue/claim/lease/drain path, with a
   * scoped runtime override selected before the queue is claimed. */
  async receiveCanonicalWithRunner(canonical: NonNullable<ReturnType<ConversationIngressPersistence['resolve']>>, runner?: CanonicalTurnRunner): Promise<unknown> {
    if (!this.enabled) throw Error('V2_RUNTIME_DISABLED_FAIL_CLOSED');
    const { message, customerId } = canonical;

    // Prospect path: no verified customer binding. Cannot access V2 workspace or ERP.
    if (customerId === null) {
      return this.handleProspect(canonical);
    }

    const route = this.route(message.accountId, message.conversationId, customerId);
    if (route === 'LEGACY') {
      if (this.legacyFallbackEnabled) return this.commerce.inbound(message);
      throw Error('V2_ROUTE_NOT_AUTHORITATIVE_FAIL_CLOSED');
    }
    if (route === 'BLOCKED') throw Error('V2_ROUTE_NOT_READY');
    if (!runner && !this.options.piHarness && (!this.options.transport || typeof this.options.transport.decide !== 'function')) throw Error('V2_ROUTE_AGENT_RUNTIME_UNAVAILABLE');
    const queued = this.queue.enqueueInbound({ accountId:message.accountId, conversationId:message.conversationId, externalMessageId:message.externalMessageId, occurredAt:message.occurredAt, messageType:message.type, text:message.text, senderExternalId:message.sender.externalId, senderPhone:message.sender.phone, replyToExternalMessageId:message.replyToExternalMessageId, rawRef:message.media?.externalRef });
    if (queued.deduplicated) return this.commerce.state(message.conversationId);
    const start: AgentTurnStart = { accountId:message.accountId, conversationId:message.conversationId, inboundMessageId:queued.item.messageId, profileId:'sales-digital-employee', nowIso:new Date().toISOString(), timezone:this.options.timezone ?? 'Asia/Singapore' };
    const turn = new AgentTurnCoordinator(this.database).start(start);
    this.queue.bindAgentTurn({ accountId:message.accountId, conversationId:message.conversationId, arrivalSeq:queued.item.arrivalSeq, turnId:turn.turnId });
    const outcomes = await this.drainConversation(message.accountId, message.conversationId, runner);
    return outcomes.get(turn.turnId) ?? this.commerce.state(message.conversationId);
  }

  /** Prospect handler: persist inbound, run abuse guard, send zero-token or onboarding reply.
   * OutboundMessageService is sole sender. No ERP or workspace access. */
  private async handleProspect(canonical: NonNullable<ReturnType<ConversationIngressPersistence['resolve']>>): Promise<unknown> {
    const { message } = canonical;
    const identityState: IdentityState = canonical.identityState ?? 'UNKNOWN';
    const db = this.database.db;

    // Persist inbound message without arrival_seq (no V2 queue for prospects).
    const isDuplicate = db.prepare(
      'SELECT 1 FROM messages WHERE account_id=? AND external_message_id=?'
    ).get(message.accountId, message.externalMessageId);

    if (!isDuplicate) {
      db.prepare(
        `INSERT OR IGNORE INTO messages(id,conversation_id,external_message_id,direction,message_type,text,
         sender_external_id,sender_phone,reply_to_external_message_id,account_id,occurred_at,raw_ref,forwarding_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        randomUUID(), message.conversationId, message.externalMessageId, 'INBOUND',
        message.type, message.text ?? null, message.sender.externalId, message.sender.phone ?? null,
        message.replyToExternalMessageId ?? null, message.accountId, message.occurredAt,
        message.media?.externalRef ?? null, message.forwarding ? JSON.stringify(message.forwarding) : null
      );
    }

    // Durable per-conversation arrival order for this prospect inbound. Recorded
    // before any model call so a later reply decision can compare itself against
    // provider arrival order rather than model completion order.
    const inboundSeq = this.admitProspectInbound(message.accountId, message.conversationId, message.externalMessageId, message.occurredAt);

    // A customer rollout is not prospect authorization. Fail closed before any
    // model/catalog/abuse reply; preserve intake evidence without a historical send.
    const destination=db.prepare('SELECT external_conversation_id FROM conversations WHERE id=? AND channel_account_id=?').get(message.conversationId,message.accountId) as {external_conversation_id:string}|undefined;
    if(!destination||!this.prospectReplyScopeKeys.has(JSON.stringify([message.accountId,destination.external_conversation_id]))){
      this.recordProspectReplyState(message.accountId,message.externalMessageId,'SUPPRESSED');
      db.prepare(`INSERT INTO inbound_route_audit(id,account_id,conversation_id,external_message_id,identity_state,abuse_state,route_outcome,occurred_at)
        SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM inbound_route_audit WHERE account_id=? AND external_message_id=? AND route_outcome='PROSPECT_OUTBOUND_SCOPE_REQUIRED')`)
        .run(randomUUID(),message.accountId,message.conversationId,message.externalMessageId,identityState,'NOT_EVALUATED','PROSPECT_OUTBOUND_SCOPE_REQUIRED',message.occurredAt,message.accountId,message.externalMessageId);
      return {status:'PROSPECT_PAUSED',identityState,routeOutcome:'PROSPECT_OUTBOUND_SCOPE_REQUIRED',replySuppressed:true,catalogCallCount:0,grounded:false,groundedProductIds:[]};
    }

    // Deterministic abuse guard (zero model calls).
    const abuse = this.abuseGuard.evaluate(message.accountId, message.sender.externalId, message.occurredAt);
    const abuseState = abuse.state;

    // A provider redelivery whose reply decision was already made and acted on
    // must not re-run the model, re-read the public catalog, or re-send. Only a
    // terminal disposition short-circuits: a still-PENDING admission is treated
    // as in-flight or crashed work and is retried, keeping the same fail-open
    // posture as the fallback cooldown. No audit row is written, so a redelivery
    // can never clear that cooldown.
    if (this.prospectReplyIsTerminal(message.accountId, message.externalMessageId)) {
      return {
        status: 'PROSPECT_HANDLED', identityState, abuseState,
        routeOutcome: PROSPECT_DUPLICATE_DELIVERY_OUTCOME, replySuppressed: true,
        catalogCallCount: 0, grounded: false, groundedProductIds: [],
      };
    }

    // Determine reply and route outcome by abuse state.
    // BLOCKED/COOLDOWN: zero model calls, fixed reply.
    // SUSPICIOUS: explicit bounded warning, no model tokens consumed.
    // NORMAL: AI semantic routing seam; fails closed to static onboarding if model unavailable.
    let replyText: string;
    let routeOutcome: string;
    let suppressReply = false;
    let catalogCalls: readonly ProspectCatalogResult[] = [];
    let groundedProductIds: readonly string[] = [];
    let grounded = false;

    if (abuseState === 'BLOCKED') {
      replyText = PROSPECT_ABUSE_REPLIES.BLOCKED;
      routeOutcome = 'PROSPECT_BLOCKED';
    } else if (abuseState === 'COOLDOWN') {
      replyText = PROSPECT_ABUSE_REPLIES.COOLDOWN;
      routeOutcome = 'PROSPECT_COOLDOWN';
    } else if (abuseState === 'SUSPICIOUS') {
      replyText = PROSPECT_SUSPICIOUS_REPLY;
      routeOutcome = 'PROSPECT_SUSPICIOUS';
    } else {
      // NORMAL: invoke AI semantic routing seam.
      // ProspectSemanticRouter enforces capability isolation by construction:
      // prospectModel is a plain text function with no ERP executor access. The
      // bounded public catalog reader is held by the router, not the model, so a
      // lookup is always a host-performed allowlisted read.
      const semanticRouter = new ProspectSemanticRouter(this.options.prospectModel, this.prospectCatalog);
      const routing = await semanticRouter.route(message.text ?? '', undefined);
      replyText = routing.reply;
      catalogCalls = routing.catalogCalls;
      groundedProductIds = routing.groundedProductIds;
      grounded = routing.grounded;
      if (routing.routedByAI) {
        routeOutcome = catalogCalls.length === 0
          ? 'PROSPECT_AI_ROUTED'
          : groundedProductIds.length > 0
          ? PROSPECT_AI_CATALOG_GROUNDED_OUTCOME
          : PROSPECT_AI_CATALOG_NO_MATCH_OUTCOME;
      } else {
        // Bounded, closed-set reason code so a gateway outage is visibly distinct
        // from a healthy prospect accept in the audit trail.
        routeOutcome = `${PROSPECT_AI_FALLBACK_PREFIX}${routing.fallbackReason ?? 'MODEL_ERROR'}`;
        // Deterministic, zero-model spam guard: the fallback text is a single
        // fixed string, so repeating it within the cooldown adds nothing.
        // The inbound message and its audit row are still persisted.
        if (this.fallbackReplyIsOnCooldown(message.accountId, message.conversationId, message.occurredAt)) {
          routeOutcome = `${routeOutcome}${PROSPECT_AI_FALLBACK_SUPPRESSED_SUFFIX}`;
          suppressReply = true;
        }
        // Freshness fence, evaluated independently of the cooldown and immediately
        // before the send decision: a generic fallback for this message must never
        // land after a newer inbound in the same conversation was already answered.
        // Both suffixes can appear so the two suppression causes stay distinguishable.
        if (this.newerProspectInboundExists(message.accountId, message.conversationId, inboundSeq)) {
          routeOutcome = `${routeOutcome}${PROSPECT_AI_FALLBACK_STALE_SUPPRESSED_SUFFIX}`;
          suppressReply = true;
        }
      }
    }

    // Audit route outcome (no chain-of-thought stored).
    try {
      db.prepare(
        `INSERT INTO inbound_route_audit(id,account_id,conversation_id,external_message_id,identity_state,abuse_state,route_outcome,occurred_at)
         VALUES(?,?,?,?,?,?,?,?)`
      ).run(
        randomUUID(), message.accountId, message.conversationId, message.externalMessageId,
        identityState, abuseState, routeOutcome, message.occurredAt
      );
    } catch { /* audit is non-critical */ }

    // Bounded catalog evidence: which query ran, what came back, and whether the
    // reply was composed from it. No model reasoning is recorded.
    this.recordProspectCatalogEvidence(message, catalogCalls, grounded, groundedProductIds);

    // Look up external conversation ID for outbound delivery.
    const dest = db.prepare(
      'SELECT external_conversation_id FROM conversations WHERE id=?'
    ).get(message.conversationId) as { external_conversation_id: string } | undefined;

    // OutboundMessageService is sole sender. Best-effort: no adapter is acceptable for tests.
    if (dest && !suppressReply) {
      const outbound = this.options.outbound as any;
      if (typeof outbound.send === 'function') {
        const outMsg: OutgoingChannelMessage = {
          accountId: message.accountId,
          clientMessageId: `prospect-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          conversationId: dest.external_conversation_id,
          text: replyText,
        };
        try { await outbound.send(outMsg); } catch { /* no adapter or send failure: diagnostic only */ }
      }
    }

    this.recordProspectReplyState(message.accountId, message.externalMessageId, suppressReply ? 'SUPPRESSED' : 'SENT');

    return {
      status: 'PROSPECT_HANDLED', identityState, abuseState, routeOutcome, replySuppressed: suppressReply,
      catalogCallCount: catalogCalls.length, grounded, groundedProductIds,
    };
  }

  /**
   * Durable, bounded observability for a prospect catalog turn.
   *
   * One row per performed lookup, keyed by the provider message id so a
   * redelivery cannot duplicate evidence. Only tool arguments and the projected
   * safe catalog fields are stored — never model reasoning, and never a
   * customer-scoped value, because none is reachable on this path.
   */
  private recordProspectCatalogEvidence(
    message: IncomingChannelMessage,
    calls: readonly ProspectCatalogResult[],
    grounded: boolean,
    groundedProductIds: readonly string[],
  ): void {
    if (calls.length === 0) return;
    const observedAt = new Date().toISOString();
    const groundedIdsJson = JSON.stringify([...groundedProductIds]);
    for (const [index, call] of calls.entries()) {
      try {
        this.database.db.prepare(
          `INSERT OR IGNORE INTO prospect_catalog_evidence(id,account_id,conversation_id,external_message_id,call_seq,
           tool_name,query_text,limit_value,result_count,product_ids_json,items_json,grounded,grounded_product_ids_json,observed_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          randomUUID(), message.accountId, message.conversationId, message.externalMessageId, index + 1,
          call.tool, call.query, call.limit, call.items.length,
          JSON.stringify(call.items.map(item => item.productId)), JSON.stringify(call.items),
          grounded ? 1 : 0, groundedIdsJson, observedAt,
        );
      } catch { /* catalog evidence is diagnostic only */ }
    }
  }

  /**
   * Records this prospect inbound in the durable per-conversation arrival order
   * and returns its sequence. Allocation is a single atomic statement, and the
   * primary key is the provider message id, so a redelivery recovers its
   * original sequence instead of being admitted as newer traffic.
   *
   * Returns undefined only if the row cannot be read back; the caller then skips
   * the freshness fence, matching the fail-open posture of the cooldown guard.
   */
  private admitProspectInbound(accountId: string, conversationId: string, externalMessageId: string, occurredAt: string): number | undefined {
    const db = this.database.db;
    try {
      db.prepare(
        `INSERT OR IGNORE INTO prospect_reply_sequence(account_id,conversation_id,external_message_id,inbound_seq,admitted_at,reply_state)
         SELECT ?,?,?,COALESCE((SELECT MAX(inbound_seq) FROM prospect_reply_sequence WHERE account_id=? AND conversation_id=?),0)+1,?,'PENDING'`
      ).run(accountId, conversationId, externalMessageId, accountId, conversationId, occurredAt);
    } catch { /* ordering evidence is best-effort; read-back below decides */ }
    const row = db.prepare(
      'SELECT inbound_seq FROM prospect_reply_sequence WHERE account_id=? AND external_message_id=? AND conversation_id=?'
    ).get(accountId, externalMessageId, conversationId) as { inbound_seq: number } | undefined;
    return row?.inbound_seq;
  }

  /**
   * Durable freshness fence for a generic prospect fallback.
   *
   * True when the same conversation already holds a persisted inbound provider
   * message that arrived after this one. Scoped by account and conversation, so
   * traffic in another conversation can never suppress this one, and joined to
   * `messages` so the answer rests on persisted inbound evidence rather than the
   * sequence row alone.
   */
  private newerProspectInboundExists(accountId: string, conversationId: string, inboundSeq: number | undefined): boolean {
    if (inboundSeq === undefined) return false;
    const row = this.database.db.prepare(
      `SELECT 1 AS newer FROM prospect_reply_sequence s
       JOIN messages m ON m.account_id=s.account_id AND m.external_message_id=s.external_message_id
       WHERE s.account_id=? AND s.conversation_id=? AND s.inbound_seq>?
         AND m.conversation_id=s.conversation_id AND m.direction='INBOUND'
       LIMIT 1`
    ).get(accountId, conversationId, inboundSeq) as { newer: number } | undefined;
    return row !== undefined;
  }

  /**
   * True when this provider message already reached a terminal reply disposition
   * in a previous delivery. Read from the same durable admission row the
   * freshness fence uses, so no second source of ordering truth is introduced.
   */
  private prospectReplyIsTerminal(accountId: string, externalMessageId: string): boolean {
    const row = this.database.db.prepare(
      'SELECT reply_state FROM prospect_reply_sequence WHERE account_id=? AND external_message_id=?'
    ).get(accountId, externalMessageId) as { reply_state: string } | undefined;
    return row?.reply_state === 'SENT' || row?.reply_state === 'SUPPRESSED';
  }

  /** Durable disposition of this inbound's reply. Only a PENDING admission moves. */
  private recordProspectReplyState(accountId: string, externalMessageId: string, state: 'SENT' | 'SUPPRESSED'): void {
    try {
      this.database.db.prepare(
        "UPDATE prospect_reply_sequence SET reply_state=? WHERE account_id=? AND external_message_id=? AND reply_state='PENDING'"
      ).run(state, accountId, externalMessageId);
    } catch { /* disposition evidence is diagnostic only */ }
  }

  /**
   * Deterministic cooldown for the fixed AI-fallback reply. Zero model calls.
   *
   * Suppresses only when the most recent *delivered* fallback for this
   * conversation is inside the cooldown window and nothing else was routed
   * since. A later AI-routed or abuse-state outcome clears the cooldown, so a
   * recovered gateway resumes replying immediately.
   *
   * Fails open (sends) on unparsable or out-of-order timestamps: an extra reply
   * is preferable to silence.
   */
  private fallbackReplyIsOnCooldown(accountId: string, conversationId: string, occurredAt: string): boolean {
    const nowMs = Date.parse(occurredAt);
    if (!Number.isFinite(nowMs)) return false;
    const latestAt = (clause: string): number | undefined => {
      const row = this.database.db.prepare(
        `SELECT occurred_at FROM inbound_route_audit
         WHERE account_id=? AND conversation_id=? AND ${clause}
         ORDER BY occurred_at DESC LIMIT 1`
      ).get(accountId, conversationId) as { occurred_at: string } | undefined;
      const parsed = row ? Date.parse(row.occurred_at) : NaN;
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const delivered = `route_outcome LIKE '${PROSPECT_AI_FALLBACK_PREFIX}%' AND route_outcome NOT LIKE '%${PROSPECT_AI_FALLBACK_SUPPRESSED_SUFFIX}'`;
    const lastDeliveredAt = latestAt(delivered);
    if (lastDeliveredAt === undefined) return false;
    const lastOtherAt = latestAt(`route_outcome NOT LIKE '${PROSPECT_AI_FALLBACK_PREFIX}%'`);
    if (lastOtherAt !== undefined && lastOtherAt > lastDeliveredAt) return false;
    const elapsed = nowMs - lastDeliveredAt;
    return elapsed >= 0 && elapsed < PROSPECT_AI_FALLBACK_COOLDOWN_MS;
  }

  private async drainConversation(accountId:string, conversationId:string, runner?: CanonicalTurnRunner):Promise<Map<string, unknown>> {
    const key=`${accountId}\u0000${conversationId}`;
    const prior=this.drains.get(key) ?? Promise.resolve(new Map<string, unknown>());
    const next=prior.catch(()=>new Map<string, unknown>()).then(async()=>{
      const outcomes=new Map<string, unknown>();
      for(;;){
        let lease;
        try { lease=this.queue.claimNext({ accountId,conversationId,owner:this.options.owner ?? 'v2-canary-router' }); }
        catch(error){ if(String(error).includes('LEASE_BUSY')) break; throw error; }
        if(!lease) break;
        const row=this.database.db.prepare('SELECT agent_turn_id,message_id FROM v2_inbox_items WHERE id=?').get(lease.id) as {agent_turn_id:string|null;message_id:string}|undefined;
        if(!row?.agent_turn_id){
          try { this.queue.complete({accountId,conversationId,owner:lease.leaseOwner,leaseToken:lease.leaseToken,arrivalSeq:lease.arrivalSeq,result:{status:'FAIL_CLOSED',reasonCode:'V2_QUEUE_TURN_UNBOUND'}}); } catch { /* durable recovery */ }
          continue;
        }
        const turnRow=this.database.db.prepare('SELECT id,inbound_message_id,profile_id,timezone FROM agent_turns WHERE id=?').get(row.agent_turn_id) as {id:string;inbound_message_id:string;profile_id:string;timezone:string}|undefined;
        if(!turnRow){
          try { this.queue.complete({accountId,conversationId,owner:lease.leaseOwner,leaseToken:lease.leaseToken,arrivalSeq:lease.arrivalSeq,result:{status:'FAIL_CLOSED',reasonCode:'V2_QUEUE_TURN_NOT_FOUND'}}); } catch { /* durable recovery */ }
          continue;
        }
        const claimedStart:AgentTurnStart={accountId,conversationId,inboundMessageId:turnRow.inbound_message_id,profileId:turnRow.profile_id,nowIso:new Date().toISOString(),timezone:turnRow.timezone};
        try {
          try { this.queue.markSideEffectStarted({accountId,conversationId,owner:lease.leaseOwner,leaseToken:lease.leaseToken,arrivalSeq:lease.arrivalSeq,turnId:turnRow.id}); }
          catch(error){ if(String(error).includes('NEWER_INPUT_QUEUED')) continue; throw error; }
          const execute=(action:any,signal?:AbortSignal)=>this.executor.execute(action,signal);
          await this.emitPresence('sendPresenceComposing',conversationId);
          try {
            const outcome:any=runner
              ? await runner({start:claimedStart, execute})
              : this.options.piHarness
              ? await this.options.piHarness.run(claimedStart,execute)
              : await new V2TransportRuntime(this.database,{transport:this.options.transport!,execute,outbound:this.options.outbound}).run(claimedStart);
            outcomes.set(turnRow.id,outcome);
            this.queue.complete({accountId,conversationId,owner:lease.leaseOwner,leaseToken:lease.leaseToken,arrivalSeq:lease.arrivalSeq,result:{status:outcome.status,reasonCode:outcome.reasonCode}});
          } finally {
            await this.emitPresence('sendPresencePaused',conversationId);
          }
        } catch(error){
          try { this.queue.complete({accountId,conversationId,owner:lease.leaseOwner,leaseToken:lease.leaseToken,arrivalSeq:lease.arrivalSeq,result:{status:'FAIL_CLOSED',reasonCode:(error as Error).message}}); } catch { /* durable recovery owns it */ }
          outcomes.set(turnRow.id,{status:'FAIL_CLOSED',reasonCode:(error as Error).message});
        }
      }
      return outcomes;
    });
    this.drains.set(key,next);
    try { return await next; } finally { if(this.drains.get(key)===next)this.drains.delete(key); }
  }

  /** Host-invoked rollback recovery. Only durable, never-claimed items are replayed by V1. */
  async drainDisabledV2(scope?: { accountId?: string; conversationId?: string }) {
    if (!this.legacyFallbackEnabled) throw Error('V2_LEGACY_DRAIN_DISABLED_FAIL_CLOSED');
    const items = this.queue.reclassifyUnclaimedForV1(scope);
    const results = [];
    for (const item of items) results.push(await this.commerce.inboundCanonicalReplay(item));
    return { drained: results.length, blocked: this.queue.readReclassificationBlocks(scope) };
  }

  private async emitPresence(kind:'sendPresenceComposing'|'sendPresencePaused', conversationId:string): Promise<void> {
    const fn = this.options.outbound[kind];
    if (!fn) return;
    try { await fn.call(this.options.outbound, conversationId); } catch { /* transport UX only */ }
  }

  private authorityFor(accountId:string, conversationId:string) {
    return this.database.db.prepare("SELECT migration_state,authoritative_writer,quarantine_reason FROM workspace_authority WHERE account_id=? AND conversation_id IN (?,COALESCE((SELECT id FROM conversations WHERE channel_account_id=? AND external_conversation_id=? LIMIT 1),'')) AND work_item_type='SALES_ORDER_REQUEST'").get(accountId,conversationId,accountId,conversationId) as {migration_state:string;authoritative_writer:string;quarantine_reason:string|null}|undefined;
  }

  private route(accountId:string, conversationId:string, customerId:string|null): 'V2'|'LEGACY'|'BLOCKED' {
    if (!this.enabled) return 'BLOCKED';
    const authority = this.authorityFor(accountId,conversationId);
    if (!authority || authority.authoritative_writer !== 'V2') return 'LEGACY';
    if (!customerId || authority.quarantine_reason || !['V2_CANARY','V2_PRIMARY','LEGACY_RETIRED'].includes(authority.migration_state)) return 'BLOCKED';
    return V2_CAPABILITIES.every(capability => this.rollout.evaluate({ capability, accountId, conversationId }).effectiveV2) ? 'V2' : 'BLOCKED';
  }

  canonicalize(input:IncomingChannelMessage){ return this.ingressPersistence.resolve(input); }
}
