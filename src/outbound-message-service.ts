import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { ChannelReconcileResult, ChannelSendResult, ChatPresenceState, OutgoingChannelMessage, WhatsAppChannelAdapter } from './channel-contract.js';
import { V1Database } from './database.js';
import { canonicalJson, canonicalSha256 } from './v2-canonical.js';
import { isFreshGroundingAuthorization, ResponseGroundingGuard, type FreshGroundingAuthorization } from './v2-response-grounding.js';
import { validateGroundedResponsePlan, validateNaturalCustomerText, type GroundedResponsePlan } from './v2-grounded-response-plan.js';
import { quotationPdfAttachment, normalizeFrozenQuotationSnapshot, validateQuotationPdfAttachment, MAX_QUOTATION_PDF_BYTES, type FrozenQuotationSnapshot } from './quotation-pdf.js';
import { authoritativeFreshnessFingerprint } from './v2-freshness.js';

const now = () => new Date().toISOString();

const V2_QUOTATION_PLACEHOLDERS = ['{{quotation_number}}', '{{currency}}', '{{total}}'] as const;

/** Host-owned delivery semantics. A model-provided purpose is descriptive only;
 * it is never used to select a provider operation or grant dispatch authority. */
const V3_DELIVERY_TYPES = new Set(['TEXT_BUBBLE', 'CAPTION', 'PDF', 'DOCUMENT']);
const V3_TEXT_TYPES = new Set(['TEXT_BUBBLE', 'CAPTION']);
const FUL003_DOMAIN = 'FUL-003:DELIVERY_UNIT_IDENTITY';

export function ful003DeliveryIdentity(turnId: string, deliveryUnitId: string) {
  const identity = canonicalSha256({ domain: FUL003_DOMAIN, turnId, deliveryUnitId });
  return { clientMessageId: `delivery-FUL-003-${identity}`, entityId: `delivery-unit-FUL-003-${identity}` };
}

export type V3DeliveryUnitSendInput = Readonly<{
  accountId: string;
  conversationId: string;
  turnId: string;
  plan: GroundedResponsePlan;
  replyToExternalMessageId?: string;
  /** Legacy callers may still carry this field, but callbacks are forbidden and
   * are never invoked. Admission is Host-owned below. */
  admitDeliveryUnit?: unknown;
  [key: string]: unknown;
}>;

/** V2 quotation wording is authored by Pi. These are the only host substitutions
 * permitted: exact values read from the immutable quotation row. */
export function renderV2QuotationTemplate(template: unknown, quotation: { quotation_no: string; currency: string; grand_total_cents: number }): string {
  if (typeof template !== 'string' || template.length === 0 || template.length > 1000 || template.trim().length === 0 || template.includes('\u0000')) throw Error('V2_QUOTATION_MESSAGE_INVALID');
  for (const placeholder of V2_QUOTATION_PLACEHOLDERS) if (template.split(placeholder).length !== 2) throw Error('V2_QUOTATION_FACT_PLACEHOLDER_REQUIRED');
  const unknownPlaceholderText = V2_QUOTATION_PLACEHOLDERS.reduce((text, placeholder) => text.split(placeholder).join(''), template);
  if (unknownPlaceholderText.includes('{{') || unknownPlaceholderText.includes('}}')) throw Error('V2_QUOTATION_PLACEHOLDER_INVALID');
  const facts: Record<string, string> = {
    '{{quotation_number}}': quotation.quotation_no,
    '{{currency}}': quotation.currency,
    '{{total}}': (quotation.grand_total_cents / 100).toFixed(2),
  };
  const rendered = V2_QUOTATION_PLACEHOLDERS.reduce((text, placeholder) => text.replace(placeholder, facts[placeholder]), template);
  const authoredWording = rendered.replace(quotation.quotation_no, '').replace(quotation.currency, '').replace((quotation.grand_total_cents / 100).toFixed(2), '').trim();
  if (!authoredWording) throw Error('V2_QUOTATION_MESSAGE_WORDING_REQUIRED');
  return rendered;
}

export type QuotationSubmittedFinalizer = (input: {
  quotationId: string;
  outboundId: string;
  externalMessageId: string;
  submittedAt: string;
}) => void;

/** Owns durable outbound intent, provider calls, and recovery. Commerce supplies
 * only the trusted quotation finalizer because it owns quotation lifecycle. */
export class OutboundMessageService {
  private adapter?: WhatsAppChannelAdapter;
  private crashAfterSubmitted = false;
  private readonly conversationLocks = new Map<string, Promise<void>>();

  constructor(private readonly database: V1Database, adapter?: WhatsAppChannelAdapter, private readonly finalizeQuotation?: QuotationSubmittedFinalizer, private readonly verifyQuotationIntegrity?: (quotation: any, accountId: string, conversationId: string) => unknown) {
    this.adapter = adapter;
    this.normalizeLegacyQuotationPayloads();
  }

  setAdapter(adapter: WhatsAppChannelAdapter) { this.adapter = adapter; }
  setCrashAfterSubmittedBeforeFinalize(value = true) { this.crashAfterSubmitted = value; }
  hasUnresolvedQuotation(conversationId: string) { return Boolean(this.db.prepare("SELECT 1 FROM outbound_messages WHERE conversation_id=? AND entity_type='QUOTATION' AND status IN ('PENDING','UNKNOWN')").get(conversationId)); }
  hasPending(conversationId: string) { return Boolean(this.db.prepare("SELECT 1 FROM outbound_messages WHERE conversation_id=? AND status='PENDING'").get(conversationId)); }

  private get db(): Database.Database { return this.database.db; }
  private destination(conversationId: string) { return this.db.prepare('SELECT channel_account_id,external_conversation_id FROM conversations WHERE id=?').get(conversationId) as any; }
  private async withConversationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.conversationLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.conversationLocks.set(key, tail);
    try { return await run; } finally { if (this.conversationLocks.get(key) === tail) this.conversationLocks.delete(key); }
  }

  /** Generic V2 contract entry point. OUT-002 will add runtime-owned message
   * policy; quotation sends use sendQuotation below and remain V1-compatible. */
  async send(message: OutgoingChannelMessage) {
    if (!this.adapter) throw Error('CHANNEL_ADAPTER_REQUIRED');
    return this.adapter.send(message);
  }

  /** Transport UX only. Never durable, never affects the exactly-once business
   * outbound path: any adapter/provider failure here is swallowed. */
  async sendPresenceComposing(conversationId: string): Promise<void> { return this.sendChatPresence(conversationId, 'composing'); }
  async sendPresencePaused(conversationId: string): Promise<void> { return this.sendChatPresence(conversationId, 'paused'); }
  private async sendChatPresence(conversationId: string, state: ChatPresenceState): Promise<void> {
    if (!this.adapter?.sendChatPresence) return;
    const destination = this.destination(conversationId);
    if (!destination) return;
    try { await this.adapter.sendChatPresence({ conversationId: destination.external_conversation_id, state }); }
    catch { /* presence is transport UX only; must never affect business delivery */ }
  }

  /** Sends only host-rendered, freshly grounded runtime output. Model plans and
   * provider payloads cannot cross this boundary. */
  async sendTurnResponse(input: { authorization: FreshGroundingAuthorization; replyToExternalMessageId?: string }) {
    if (!isFreshGroundingAuthorization(input?.authorization)) throw Error('FRESH_GROUNDING_AUTHORIZATION_REQUIRED');
    const verdict = input.authorization.verdict;
    const turn = this.db.prepare('SELECT id,account_id,conversation_id,inbound_message_id FROM agent_turns WHERE id=?').get(verdict.turnId) as any;
    if (!turn) throw Error('TURN_NOT_FOUND');
    const inbound = this.db.prepare("SELECT external_message_id FROM messages WHERE id=? AND account_id=? AND conversation_id=? AND direction='INBOUND'").get(turn.inbound_message_id, turn.account_id, turn.conversation_id) as any;
    if (!inbound) throw Error('TURN_INBOUND_SCOPE');
    if (input.replyToExternalMessageId && !this.db.prepare("SELECT 1 FROM messages WHERE external_message_id=? AND account_id=? AND conversation_id=? AND direction='INBOUND'").get(input.replyToExternalMessageId, turn.account_id, turn.conversation_id)) throw Error('TURN_REPLY_SCOPE');
    if (!['customer_reply', 'clarification', 'handoff', 'acknowledgement'].includes(verdict.outboundPurpose)) throw Error('OUTBOUND_PURPOSE');
    const destination = this.destination(turn.conversation_id);
    if (!destination || destination.channel_account_id !== turn.account_id) throw Error('CHANNEL_DESTINATION_REQUIRED');
    return this.withConversationLock(`${destination.channel_account_id}|${destination.external_conversation_id}`, () => this.sendTurnResponseUnlocked(turn, inbound.external_message_id, verdict, input.replyToExternalMessageId));
  }

  /**
   * FUL-003: persist and deliver each validated plan unit through this service.
   * outbound_messages is the effect ledger; client_message_id is the stable
   * per-turn/per-unit effect identity. Units are intentionally processed in
   * plan order. Attachment refs have no transport authority: without a
   * Host-resolved generic attachment payload they are durably failed before
   * any provider call.
   */
  async sendDeliveryUnits(input: V3DeliveryUnitSendInput) {
    if (!input || !this.adapter) throw Error('CHANNEL_ADAPTER_REQUIRED');
    if (typeof input.admitDeliveryUnit === 'function') throw Error('DELIVERY_ADMISSION_CALLBACK_FORBIDDEN');
    if (!input.plan || input.plan.turnId !== input.turnId) throw Error('DELIVERY_PLAN_TURN_MISMATCH');
    const turn = this.db.prepare("SELECT t.id,t.account_id,t.conversation_id,t.inbound_message_id FROM agent_turns t JOIN messages m ON m.id=t.inbound_message_id AND m.account_id=t.account_id AND m.conversation_id=t.conversation_id AND m.direction='INBOUND' WHERE t.id=? AND t.account_id=? AND t.conversation_id=?").get(input.turnId, input.accountId, input.conversationId) as any;
    if (!turn) throw Error('DELIVERY_TURN_SCOPE');
    const stored = this.db.prepare('SELECT plan_json,plan_hash FROM agent_response_plans WHERE turn_id=?').get(turn.id) as any;
    if (!stored) throw Error('DELIVERY_RESPONSE_PLAN_REQUIRED');
    const validatedPlan = validateGroundedResponsePlan(input.plan, input.turnId);
    if (canonicalJson(validatedPlan) !== stored.plan_json) throw Error('DELIVERY_PLAN_NOT_STORED');
    const disposition = this.db.prepare('SELECT disposition,purpose,payload_hash FROM turn_outbound_dispositions WHERE turn_id=?').get(turn.id) as any;
    if (!disposition || disposition.disposition !== 'RUNTIME_RESPONSE' || disposition.purpose !== validatedPlan.outboundPurpose || disposition.payload_hash !== stored.plan_hash) throw Error('DELIVERY_OUTBOUND_DISPOSITION_REQUIRED');
    const destination = this.destination(input.conversationId);
    if (!destination || destination.channel_account_id !== input.accountId) throw Error('CHANNEL_DESTINATION_REQUIRED');
    if (input.replyToExternalMessageId && !this.db.prepare("SELECT 1 FROM messages WHERE external_message_id=? AND account_id=? AND conversation_id=? AND direction='INBOUND'").get(input.replyToExternalMessageId, input.accountId, input.conversationId)) throw Error('DELIVERY_REPLY_SCOPE');
    const units = input.plan.deliveryUnits ?? [];
    return this.withConversationLock(`${input.accountId}|${destination.external_conversation_id}`, async () => {
      const results: any[] = [];
      for (const unit of units) {
        if (!V3_DELIVERY_TYPES.has(unit.unitType)) throw Error('DELIVERY_UNIT_TYPE_UNSUPPORTED');
        results.push(await this.sendDeliveryUnit(input, unit, destination.external_conversation_id));
        const result = results[results.length - 1];
        if (result.status !== 'SUBMITTED') break;
      }
      return results;
    });
  }

  private async sendDeliveryUnit(input: V3DeliveryUnitSendInput, unit: NonNullable<GroundedResponsePlan['deliveryUnits']>[number], externalConversationId: string) {
    const identity = ful003DeliveryIdentity(input.turnId, unit.deliveryUnitId);
    const client = identity.clientMessageId;
    const payload = JSON.stringify({
      deliveryUnitId: unit.deliveryUnitId,
      unitType: unit.unitType,
      text: unit.text,
      attachmentRef: unit.attachmentRef,
      replyToExternalMessageId: input.replyToExternalMessageId,
    });
    const hash = canonicalSha256(canonicalJson(JSON.parse(payload)));
    let out = this.db.prepare("SELECT * FROM outbound_messages WHERE entity_type='DELIVERY_UNIT' AND entity_id=? AND client_message_id=?").get(identity.entityId, client) as any;
    if (out) {
      if (out.snapshot_hash !== hash || out.payload_json !== payload) throw Error('DELIVERY_UNIT_REPLAY_CONFLICT');
      if (['SUBMITTED', 'PENDING', 'UNKNOWN'].includes(out.status)) return out;
      if (out.status === 'FAILED' && (!String(out.last_error ?? '').startsWith('retryable:') || Number(out.attempt_count) >= 2)) return out;
    }
    let ownsAttempt = false;
    const claimed = this.database.runImmediate(() => {
      const entityId = identity.entityId;
      const current = this.db.prepare("SELECT * FROM outbound_messages WHERE entity_type='DELIVERY_UNIT' AND entity_id=? AND client_message_id=?").get(entityId, client) as any;
      if (current) {
        if (current.snapshot_hash !== hash || current.payload_json !== payload) throw Error('DELIVERY_UNIT_REPLAY_CONFLICT');
        if (current.status === 'PLANNED') return { out: current, ownsAttempt: true };
        if (current.status === 'FAILED' && String(current.last_error ?? '').startsWith('retryable:') && Number(current.attempt_count) < 2) {
          const changed = this.db.prepare("UPDATE outbound_messages SET status='PLANNED',last_error=NULL WHERE id=? AND status='FAILED'").run(current.id);
          return { out: this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(current.id), ownsAttempt: changed.changes === 1 };
        }
        return { out: current, ownsAttempt: false };
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO outbound_messages(id,conversation_id,client_message_id,entity_type,entity_id,snapshot_hash,payload_json,status,attempt_count,last_error,submitted_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.conversationId, client, 'DELIVERY_UNIT', entityId, hash, payload, 'PLANNED', 0, null, null, now());
      return { out: this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(id), ownsAttempt: true };
    });
    out = claimed.out; ownsAttempt = claimed.ownsAttempt;
    if (!ownsAttempt) return out;
    // Purpose is intentionally absent from this dispatch decision. Host-owned
    // unit type semantics select the only supported provider-neutral shape.
    if (!V3_TEXT_TYPES.has(unit.unitType)) {
      this.failClaimedPendingAttempt(out.id, Error('ATTACHMENT_RESOLUTION_REQUIRED'));
      return this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(out.id);
    }
    try {
      this.admitDeliveryUnit(input, unit, out, hash, payload);
    } catch (error) {
      this.failClaimedPendingAttempt(out.id, error);
      throw error;
    }
    try {
      const result = await this.adapter!.send({ accountId: input.accountId, clientMessageId: client, conversationId: externalConversationId, replyToExternalMessageId: input.replyToExternalMessageId, text: unit.text! });
      return this.finalize(out.id, result);
    } catch (error) {
      // A provider exception leaves transmission uncertain; FUL-005 owns
      // reconciliation and this path must never blindly resend.
      this.markClaimedPendingAttemptUnknown(out.id, error);
      throw error;
    }
  }

  /**
   * FUL-004: the transport owner is also the admission owner.  The outbound
   * row is first durable as PLANNED, then this BEGIN IMMEDIATE fence rechecks
   * the immutable turn/plan/disposition, authoritative V2 freshness, and any
   * newer queued inbound before CAS-ing this exact row to the provider-attempt
   * state.  No callback or V3 effect ledger is involved.
   */
  private admitDeliveryUnit(input: V3DeliveryUnitSendInput, unit: NonNullable<GroundedResponsePlan['deliveryUnits']>[number], out: any, hash: string, payload: string): void {
    this.database.runImmediate(() => {
      const current = this.db.prepare('SELECT * FROM outbound_messages WHERE id=? AND entity_type=\'DELIVERY_UNIT\'').get(out.id) as any;
      if (!current || current.status !== 'PLANNED' || current.snapshot_hash !== hash || current.payload_json !== payload) throw Error('DELIVERY_ADMISSION_ROW_CONFLICT');
      const turn = this.db.prepare('SELECT * FROM agent_turns WHERE id=? AND account_id=? AND conversation_id=?').get(input.turnId, input.accountId, input.conversationId) as any;
      if (!turn) throw Error('DELIVERY_TURN_SCOPE');
      const stored = this.db.prepare('SELECT plan_json,plan_hash FROM agent_response_plans WHERE turn_id=?').get(input.turnId) as any;
      const disposition = this.db.prepare('SELECT disposition,purpose,payload_hash FROM turn_outbound_dispositions WHERE turn_id=?').get(input.turnId) as any;
      if (!stored || canonicalSha256(JSON.parse(stored.plan_json)) !== stored.plan_hash || disposition?.disposition !== 'RUNTIME_RESPONSE' || disposition.purpose !== input.plan.outboundPurpose || disposition.payload_hash !== stored.plan_hash) throw Error('DELIVERY_ADMISSION_PLAN_STALE');
      if (canonicalJson(input.plan) !== stored.plan_json) throw Error('DELIVERY_ADMISSION_PLAN_STALE');
      let context: any;
      try { context = JSON.parse(turn.context_snapshot_json); } catch { throw Error('DELIVERY_ADMISSION_CONTEXT_STALE'); }
      if (canonicalJson(context) !== turn.context_snapshot_json || canonicalSha256(context) !== turn.context_fingerprint) throw Error('DELIVERY_ADMISSION_CONTEXT_STALE');
      if (context.turnId !== input.turnId || context.accountId !== input.accountId || context.conversationId !== input.conversationId) throw Error('DELIVERY_ADMISSION_CONTEXT_SCOPE');
      if (context.freshness?.fingerprint !== authoritativeFreshnessFingerprint(this.db, input.accountId, input.conversationId, String(turn.profile_id), String(out.id))) throw Error('DELIVERY_ADMISSION_FRESHNESS_STALE');
      const inbound = this.db.prepare('SELECT arrival_seq FROM messages WHERE id=? AND account_id=? AND conversation_id=? AND direction=\'INBOUND\'').get(turn.inbound_message_id, input.accountId, input.conversationId) as any;
      if (!inbound) throw Error('DELIVERY_ADMISSION_INBOUND_SCOPE');
      const queueItem = this.db.prepare('SELECT id,arrival_seq,state,side_effect_started FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND message_id=?').get(input.accountId, input.conversationId, turn.inbound_message_id) as any;
      if (queueItem) {
        const lease = this.db.prepare('SELECT lease_item_id,lease_arrival_seq,lease_expires_at FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?').get(input.accountId, input.conversationId) as any;
        if (!lease || lease.lease_item_id !== queueItem.id || Number(lease.lease_arrival_seq) !== Number(queueItem.arrival_seq) || queueItem.state !== 'PROCESSING' || !lease.lease_expires_at || Date.parse(lease.lease_expires_at) <= Date.now()) throw Error('DELIVERY_ADMISSION_LEASE_STALE');
      }
      const newer = Number((this.db.prepare("SELECT count(*) AS n FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND arrival_seq>? AND state='QUEUED'").get(input.accountId, input.conversationId, Number(inbound.arrival_seq ?? 0)) as any)?.n ?? 0) > 0
        || Number((this.db.prepare("SELECT count(*) AS n FROM messages WHERE account_id=? AND conversation_id=? AND direction='INBOUND' AND arrival_seq>?").get(input.accountId, input.conversationId, Number(inbound.arrival_seq ?? 0)) as any)?.n ?? 0) > 0;
      if (newer) throw Error('CP004_STALE_REPLAN_REMAINDER');
      const changed = this.db.prepare("UPDATE outbound_messages SET status='PENDING',attempt_count=attempt_count+1,last_error=NULL WHERE id=? AND entity_type='DELIVERY_UNIT' AND snapshot_hash=? AND payload_json=? AND status='PLANNED'").run(out.id, hash, payload);
      if (changed.changes !== 1) throw Error('DELIVERY_ADMISSION_ROW_CONFLICT');
      void unit;
    });
  }

  private async sendTurnResponseUnlocked(turn: any, inboundExternalMessageId: string, verdict: FreshGroundingAuthorization['verdict'], replyToExternalMessageId?: string) {
    if (!this.adapter) throw Error('CHANNEL_ADAPTER_REQUIRED');
    const purpose = verdict.outboundPurpose;
    const payload = JSON.stringify({ text: verdict.renderedText, replyToExternalMessageId: replyToExternalMessageId ?? inboundExternalMessageId });
    const hash = canonicalSha256(canonicalJson(JSON.parse(payload)));
    const client = `turn-${turn.id}-${purpose}`;
    const disposition = this.db.prepare('SELECT disposition,purpose FROM turn_outbound_dispositions WHERE turn_id=?').get(turn.id) as any;
    if (!disposition || disposition.disposition !== 'RUNTIME_RESPONSE' || disposition.purpose !== purpose) throw Error('TURN_OUTBOUND_DISPOSITION_REQUIRED');
    let out = this.db.prepare("SELECT * FROM outbound_messages WHERE entity_type='TURN_RESPONSE' AND entity_id=? AND client_message_id=?").get(turn.id, client) as any;
    if (out) {
      if (out.snapshot_hash !== hash || out.payload_json !== payload) throw Error('TURN_OUTBOUND_REPLAY_CONFLICT');
      if (['SUBMITTED', 'PENDING', 'UNKNOWN'].includes(out.status)) return out;
      if (out.status === 'FAILED' && (!String(out.last_error ?? '').startsWith('retryable:') || Number(out.attempt_count) >= 2)) return out;
    }
    let ownsAttempt = false;
    const claimed = this.database.runImmediate(() => {
      const current = this.db.prepare("SELECT * FROM outbound_messages WHERE entity_type='TURN_RESPONSE' AND entity_id=? AND client_message_id=?").get(turn.id, client) as any;
      if (current) {
        if (current.snapshot_hash !== hash || current.payload_json !== payload) throw Error('TURN_OUTBOUND_REPLAY_CONFLICT');
        if (current.status === 'FAILED' && String(current.last_error ?? '').startsWith('retryable:') && Number(current.attempt_count) < 2) {
          const changed = this.db.prepare("UPDATE outbound_messages SET status='PENDING',attempt_count=attempt_count+1,last_error=NULL WHERE id=? AND status='FAILED'").run(current.id);
          return { out: this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(current.id), ownsAttempt: changed.changes === 1 };
        }
        return { out: current, ownsAttempt: false };
      }
      const id = randomUUID(), created = now();
      this.db.prepare('INSERT INTO outbound_messages(id,conversation_id,client_message_id,entity_type,entity_id,snapshot_hash,payload_json,status,attempt_count,last_error,submitted_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, turn.conversation_id, client, 'TURN_RESPONSE', turn.id, hash, payload, 'PENDING', 1, null, null, created);
      return { out: this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(id), ownsAttempt: true };
    });
    out = claimed.out; ownsAttempt = claimed.ownsAttempt;
    if (!ownsAttempt) return out;
    // A caller-provided authorization is only a claim. Re-read canonical state
    // immediately before every new provider attempt, including retries. Any
    // failure here happens strictly before a provider call, so the claimed
    // PENDING row must become a durable retryable FAILED, never stay PENDING.
    try {
      const fresh = new ResponseGroundingGuard(this.database).authorize(turn.id);
      if (fresh.verdict.outboundPurpose !== purpose || fresh.verdict.renderedText !== verdict.renderedText) throw Error('FRESH_GROUNDING_MISMATCH');
      const freshPayload = JSON.stringify({ text: fresh.verdict.renderedText, replyToExternalMessageId: replyToExternalMessageId ?? inboundExternalMessageId });
      const freshHash = canonicalSha256(canonicalJson(JSON.parse(freshPayload)));
      if (freshHash !== hash || freshPayload !== payload) throw Error('FRESH_GROUNDING_MISMATCH');
    } catch (error) {
      this.failClaimedPendingAttempt(out.id, error);
      throw error;
    }
    // The provider call outcome is uncertain if it throws: we cannot tell
    // whether the message was actually transmitted. Never blindly resend;
    // park as UNKNOWN and require reconciliation evidence to recover.
    let result: ChannelSendResult;
    try {
      result = await this.adapter.send({ accountId: turn.account_id, clientMessageId: client, conversationId: this.destination(turn.conversation_id).external_conversation_id, replyToExternalMessageId: replyToExternalMessageId ?? inboundExternalMessageId, text: verdict.renderedText });
    } catch (error) {
      this.markClaimedPendingAttemptUnknown(out.id, error);
      throw error;
    }
    if (this.crashAfterSubmitted && result.status === 'submitted') { this.crashAfterSubmitted = false; throw Error('INJECTED_CRASH_AFTER_SUBMITTED'); }
    return this.finalize(out.id, result);
  }

  private boundedReason(prefix: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `${prefix}:${message}`.slice(0, 200);
  }

  /** Failure before a provider attempt was possible: durably retryable, bounded by the existing attempt_count rule. */
  private failClaimedPendingAttempt(id: string, error: unknown) {
    this.database.runImmediate(() => {
      const reason = this.boundedReason('retryable', error);
      const stale = /CP004_STALE_REPLAN_REMAINDER|DELIVERY_ADMISSION_(?:FRESHNESS|PLAN|CONTEXT|INBOUND|LEASE)_/.test(reason);
      this.db.prepare("UPDATE outbound_messages SET status=?,last_error=? WHERE id=? AND status IN ('PLANNED','PENDING')").run(stale ? 'SUPERSEDED' : 'FAILED', reason, id);
    });
  }

  /** Provider call outcome unknown: only reconciliation evidence may resolve it. */
  private markClaimedPendingAttemptUnknown(id: string, error: unknown) {
    this.database.runImmediate(() => {
      this.db.prepare("UPDATE outbound_messages SET status='UNKNOWN',last_error=? WHERE id=? AND status='PENDING'").run(this.boundedReason('unresolved', error), id);
    });
  }

  async sendQuotation(quotationId: string, customerMessage?: string) {
    const q = this.db.prepare('SELECT id,source_conversation_id FROM quotations WHERE id=?').get(quotationId) as any;
    if (!q) throw Error('QUOTE_NOT_FOUND');
    const destination = this.destination(q.source_conversation_id);
    if (!destination) throw Error('CHANNEL_DESTINATION_REQUIRED');
    return this.withConversationLock(`${destination.channel_account_id}|${destination.external_conversation_id}`, () => this.sendQuotationUnlocked(quotationId, customerMessage));
  }

  /** Production V2 path. It cannot use the V1 host-rendered fallback. */
  async sendQuotationV2(quotationId: string, customerMessage: string) {
    const q = this.db.prepare('SELECT id,source_conversation_id FROM quotations WHERE id=?').get(quotationId) as any;
    if (!q) throw Error('QUOTE_NOT_FOUND');
    const destination = this.destination(q.source_conversation_id);
    if (!destination) throw Error('CHANNEL_DESTINATION_REQUIRED');
    return this.withConversationLock(`${destination.channel_account_id}|${destination.external_conversation_id}`, () => this.sendQuotationUnlocked(quotationId, customerMessage, true));
  }

  private async sendQuotationUnlocked(quotationId: string, customerMessage?: string, v2 = false): Promise<any> {
    if (!this.adapter) throw Error('CHANNEL_ADAPTER_REQUIRED');
    const q = this.db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId) as any;
    if (!q) throw Error('QUOTE_NOT_FOUND');
    let out = this.db.prepare('SELECT * FROM outbound_messages WHERE entity_id=? ORDER BY rowid DESC LIMIT 1').get(quotationId) as any;
    if (out && ['PENDING', 'UNKNOWN', 'SUBMITTED'].includes(out.status)) return out;
    if (q.status !== 'DRAFT') throw Error('INVALID_QUOTE_TRANSITION');
    if (new Date(q.valid_until).getTime() <= Date.now()) throw Error('QUOTE_EXPIRED');

    let client: string;
    let ownsAttempt = false;
    let wire: OutgoingChannelMessage;
    const destination = this.destination(q.source_conversation_id);
    if (!destination) throw Error('CHANNEL_DESTINATION_REQUIRED');
    if (out?.status === 'FAILED') {
      if (!String(out.last_error ?? '').startsWith('retryable:') || Number(out.attempt_count) >= 2) return out;
      const claimed = this.database.runImmediate(() => {
        const current = this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(out.id) as any;
        if (!current || current.status !== 'FAILED' || !String(current.last_error ?? '').startsWith('retryable:') || Number(current.attempt_count) >= 2) return { out: current, ownsAttempt: false };
        const changed = this.db.prepare("UPDATE outbound_messages SET status='PENDING',attempt_count=attempt_count+1,last_error=NULL WHERE id=? AND status='FAILED'").run(out.id);
        return { out: this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(out.id), ownsAttempt: changed.changes === 1 };
      });
      if (!claimed.out || claimed.out.status !== 'PENDING' || !claimed.ownsAttempt) return claimed.out;
      out = claimed.out; client = out.client_message_id; ownsAttempt = true;
      const integrity = this.db.prepare('SELECT payload_hash,payload_version FROM outbound_message_integrity WHERE outbound_message_id=?').get(out.id) as any;
      if (!integrity || integrity.payload_hash !== canonicalSha256(canonicalJson(JSON.parse(out.payload_json)))) throw Error('QUOTATION_PAYLOAD_INTEGRITY_INVALID');
      if (integrity.payload_version === 2 && !JSON.parse(out.payload_json).attachments) throw Error('QUOTATION_PAYLOAD_INVALID');
      wire = this.quotationWireFromPersistedPayload(out.payload_json, out.client_message_id, destination.channel_account_id, destination.external_conversation_id, out.snapshot_hash);
    } else {
      client = `quote-${q.quotation_no}`;
      // The quotation is intentionally re-read, verified, normalized, rendered,
      // and inserted while one writer transaction is held. This closes the
      // snapshot/hash TOCTOU window before the provider call.
      const claimed = this.database.runImmediate(() => {
        const current = this.db.prepare('SELECT * FROM outbound_messages WHERE entity_id=? ORDER BY rowid DESC LIMIT 1').get(quotationId) as any;
        if (current) return { out: current, ownsAttempt: false };
        const canonical = this.db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId) as any;
        if (!canonical || canonical.status !== 'DRAFT') throw Error('INVALID_QUOTE_TRANSITION');
        if (!this.verifyQuotationIntegrity) throw Error('QUOTE_INTEGRITY_VERIFIER_REQUIRED');
        if (!this.db.prepare('SELECT 1 FROM quotation_lines WHERE quotation_id=? LIMIT 1').get(quotationId) || !this.db.prepare("SELECT 1 FROM commercial_integrity_seals WHERE entity_type='QUOTATION' AND entity_id=? AND account_id=? AND conversation_id=? AND customer_id=? AND lineage_id=?").get(quotationId, destination.channel_account_id, canonical.source_conversation_id, canonical.customer_id, quotationId)) throw Error('QUOTE_INTEGRITY_INVALID');
        if (typeof canonical.sent_snapshot_json !== 'string' || typeof canonical.sent_snapshot_hash !== 'string' || createHash('sha256').update(canonical.sent_snapshot_json).digest('hex') !== canonical.sent_snapshot_hash) throw Error('QUOTATION_SNAPSHOT_INVALID');
        this.verifyQuotationIntegrity(canonical, destination.channel_account_id, canonical.source_conversation_id);
        const afterVerify = this.db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId) as any;
        if (!afterVerify || afterVerify.sent_snapshot_json !== canonical.sent_snapshot_json || afterVerify.sent_snapshot_hash !== canonical.sent_snapshot_hash || afterVerify.quotation_no !== canonical.quotation_no || afterVerify.grand_total_cents !== canonical.grand_total_cents) throw Error('QUOTATION_SNAPSHOT_CHANGED');
        this.verifyQuotationIntegrity(afterVerify, destination.channel_account_id, afterVerify.source_conversation_id);
        let snapshot: FrozenQuotationSnapshot;
        try { snapshot = normalizeFrozenQuotationSnapshot(JSON.parse(afterVerify.sent_snapshot_json)); } catch { throw Error('QUOTATION_SNAPSHOT_INVALID'); }
        const safeMessage = v2 ? renderV2QuotationTemplate(customerMessage, afterVerify) : (customerMessage === undefined ? '' : validateNaturalCustomerText(customerMessage));
        const canonicalText = `${afterVerify.quotation_no} · ${afterVerify.currency} ${(afterVerify.grand_total_cents / 100).toFixed(2)}`;
        const outboundText = v2 ? safeMessage : (safeMessage ? `${safeMessage}\n${canonicalText}` : `${afterVerify.quotation_no} sent for ${afterVerify.currency} ${(afterVerify.grand_total_cents / 100).toFixed(2)}. Please reply “OK confirm” to accept it.`);
        const pdf = quotationPdfAttachment(snapshot);
        const candidateWire: OutgoingChannelMessage = { accountId: destination.channel_account_id, clientMessageId: client, conversationId: destination.external_conversation_id, text: outboundText, attachments: [{ mimeType: pdf.mimeType, fileName: pdf.fileName, ref: pdf.ref, sha256: pdf.sha256 }] };
        const payload = JSON.stringify(candidateWire);
        const payloadHash = canonicalSha256(canonicalJson(candidateWire));
        const id = randomUUID();
        this.db.prepare('INSERT INTO outbound_messages(id,conversation_id,external_message_id,client_message_id,entity_type,entity_id,snapshot_hash,payload_json,status,attempt_count,last_error,submitted_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, afterVerify.source_conversation_id, null, client, 'QUOTATION', quotationId, afterVerify.sent_snapshot_hash, payload, 'PENDING', 1, null, null, now());
        this.db.prepare('INSERT INTO outbound_message_integrity(outbound_message_id,payload_hash,payload_version) VALUES(?,?,2)').run(id, payloadHash);
        return { out: this.db.prepare('SELECT * FROM outbound_messages WHERE entity_id=? ORDER BY rowid DESC LIMIT 1').get(quotationId), ownsAttempt: true, wire: candidateWire };
      });
      if (claimed.out.status !== 'PENDING' || !claimed.ownsAttempt) return claimed.out;
      out = claimed.out; ownsAttempt = true; wire = claimed.wire!;
    }
    if (!ownsAttempt) return out;
    const result = await this.adapter.send(wire!);
    if (this.crashAfterSubmitted && result.status === 'submitted') { this.crashAfterSubmitted = false; throw Error('INJECTED_CRASH_AFTER_SUBMITTED'); }
    return this.finalize(out.id, result, q.id);
  }

  private quotationWireFromPersistedPayload(payloadJson: string, clientMessageId: string, accountId: string, conversationId: string, expectedSnapshotHash: string): OutgoingChannelMessage {
    let payload: any; try { payload = JSON.parse(payloadJson); } catch { throw Error('QUOTATION_PAYLOAD_INVALID'); }
    if (payload && payload.accountId === accountId && payload.clientMessageId === clientMessageId && payload.conversationId === conversationId && typeof payload.text === 'string' && Array.isArray(payload.attachments) && payload.attachments.length === 1) {
      const attachment = payload.attachments[0];
      try { validateQuotationPdfAttachment(attachment); } catch { throw Error('QUOTATION_PAYLOAD_INVALID'); }
      return payload as OutgoingChannelMessage;
    }
    // Pre-PDF intents are valid legacy text-only intents. They must never gain an attachment on retry.
    if (!payload || payload._quotationPayloadVersion !== 1 || typeof payload.quotationNo !== 'string' || typeof payload.snapshot !== 'string' || typeof payload.customerMessage !== 'string' || payload.attachments !== undefined) throw Error('QUOTATION_PAYLOAD_INVALID');
    let snapshot: any; try { snapshot = normalizeFrozenQuotationSnapshot(JSON.parse(payload.snapshot)); } catch { throw Error('QUOTATION_SNAPSHOT_INVALID'); }
    if (createHash('sha256').update(payload.snapshot).digest('hex') !== expectedSnapshotHash) throw Error('QUOTATION_SNAPSHOT_INVALID');
    const canonical = `${snapshot.quotationNo} · ${snapshot.currency} ${(snapshot.grandTotalCents / 100).toFixed(2)}`;
    const text = payload.customerMessage ? `${payload.customerMessage}\n${canonical}` : `${snapshot.quotationNo} sent for ${snapshot.currency} ${(snapshot.grandTotalCents / 100).toFixed(2)}. Please reply “OK confirm” to accept it.`;
    return { accountId, clientMessageId, conversationId, text };
  }

  private normalizeLegacyQuotationPayloads() {
    for (const row of this.db.prepare("SELECT id,payload_json FROM outbound_messages WHERE entity_type='QUOTATION'").all() as any[]) {
      if (this.db.prepare('SELECT 1 FROM outbound_message_integrity WHERE outbound_message_id=?').get(row.id)) continue;
      let payload: any; try { payload = JSON.parse(row.payload_json); } catch { continue; }
      const legacy = payload && typeof payload.quotationNo === 'string' && typeof payload.snapshot === 'string' && typeof payload.customerMessage === 'string' && payload.attachments === undefined;
      const current = payload && typeof payload.accountId === 'string' && Array.isArray(payload.attachments) && payload.attachments.length === 1;
      if (!legacy && !current) continue;
      const normalized = legacy ? JSON.stringify({ ...payload, _quotationPayloadVersion: 1 }) : row.payload_json;
      this.db.prepare('UPDATE outbound_messages SET payload_json=? WHERE id=?').run(normalized, row.id);
      this.db.prepare('INSERT OR IGNORE INTO outbound_message_integrity(outbound_message_id,payload_hash,payload_version) VALUES(?,?,?)').run(row.id, canonicalSha256(canonicalJson(JSON.parse(normalized))), legacy ? 1 : 2);
    }
  }

  private finalize(id: string, result: ChannelSendResult, quotationId?: string) {
    return this.database.runImmediate(() => {
      const out = this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(id) as any;
      if (result.status === 'failed') {
        this.db.prepare("UPDATE outbound_messages SET status='FAILED',last_error=? WHERE id=?").run(`${result.retryable ? 'retryable' : 'terminal'}:${result.errorCode}`, id);
        return this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(id);
      }
      if (result.status === 'unknown') {
        this.db.prepare("UPDATE outbound_messages SET status='UNKNOWN',last_error='unresolved' WHERE id=?").run(id);
        return this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(id);
      }
      this.db.prepare("UPDATE outbound_messages SET status='SUBMITTED',external_message_id=?,submitted_at=?,last_error=NULL WHERE id=?").run(result.externalMessageId, result.submittedAt ?? now(), id);
      if (out.entity_type === 'QUOTATION' && quotationId) this.finalizeQuotation?.({ quotationId, outboundId: id, externalMessageId: result.externalMessageId, submittedAt: result.submittedAt ?? now() });
      return this.db.prepare('SELECT * FROM outbound_messages WHERE id=?').get(id);
    });
  }

  async reconcile() {
    const rows = this.db.prepare("SELECT id,conversation_id FROM outbound_messages WHERE status IN ('PENDING','UNKNOWN') ORDER BY rowid").all() as any[];
    for (const candidate of rows) {
      const destination = this.destination(candidate.conversation_id);
      if (!destination) continue;
      await this.withConversationLock(`${destination.channel_account_id}|${destination.external_conversation_id}`, async () => {
        const out = this.db.prepare("SELECT * FROM outbound_messages WHERE id=? AND status IN ('PENDING','UNKNOWN')").get(candidate.id) as any;
        if (!out) return;
        this.db.prepare("UPDATE outbound_messages SET status='UNKNOWN',last_error='restart reconciliation' WHERE id=? AND status='PENDING'").run(out.id);
        if (!this.adapter?.reconcile) return;
        const result: ChannelReconcileResult = await this.adapter.reconcile({ accountId: destination.channel_account_id, clientMessageId: out.client_message_id });
        if (result.status === 'submitted') this.finalize(out.id, { status: 'submitted', externalMessageId: result.externalMessageId, submittedAt: result.submittedAt ?? now() }, out.entity_type === 'QUOTATION' ? out.entity_id : undefined);
        else if (result.status === 'not_found') this.db.prepare("UPDATE outbound_messages SET status='FAILED',last_error='retryable:not_found' WHERE id=? AND status='UNKNOWN'").run(out.id);
      });
    }
  }
}
