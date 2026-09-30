import type Database from 'better-sqlite3';
import type { IncomingChannelMessage } from './channel-contract.js';
import { randomUUID } from 'node:crypto';

export type CommitmentProposalKind = 'ACCEPT' | 'REJECT' | 'CANCEL' | 'CHANGE';
export type CommitmentGuardOutcome = 'APPLIED' | 'NOOP_REPLAY' | 'NEEDS_CLARIFICATION' | 'BLOCKED' | 'HANDOFF';
export type CommitmentReasonCode =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'CANCELLED_PRECOMMIT'
  | 'REJECTION_RECORDED'
  | 'CHANGE_PRECOMMIT'
  | 'REPLACEMENT_REQUIRED'
  | 'ACCEPTANCE_SUSPENDED_REPLACEMENT'
  | 'IDENTITY_MISMATCH'
  | 'FORWARDED_EVIDENCE'
  | 'MESSAGE_REORDERED'
  | 'REPLY_MISMATCH'
  | 'QUOTE_NOT_ACTIVE'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_SUPERSEDED'
  | 'UNRESOLVED_OUTBOUND'
  | 'COMMITMENT_ALREADY_ACCEPTED'
  | 'COMMITMENT_ALREADY_REJECTED'
  | 'INBOUND_NOT_PERSISTED'
  | 'CANONICAL_SCOPE_MISMATCH'
  | 'PROPOSAL_INVALID'
  | 'CONCURRENT_STATE';

export type CommitmentProposal = {
  kind: CommitmentProposalKind;
  accountId: string;
  conversationId: string;
  inboundMessageId: string;
};

/**
 * The only model-owned commitment value is the semantic kind.  Canonical
 * scope and the inbound evidence reference are host-owned and are deliberately
 * supplied separately.  Quote/customer/transition facts and explicitness are
 * not part of this boundary.
 */
export type SemanticCommitmentProposal = { readonly kind: unknown };
export type CommitmentEvidenceContext = Readonly<Pick<CommitmentProposal, 'accountId' | 'conversationId' | 'inboundMessageId'>>;

const COMMITMENT_KINDS: readonly CommitmentProposalKind[] = ['ACCEPT', 'REJECT', 'CANCEL', 'CHANGE'];
const COMMITMENT_FIELDS = ['kind', 'accountId', 'conversationId', 'inboundMessageId'] as const;
const EVIDENCE_FIELDS = ['accountId', 'conversationId', 'inboundMessageId'] as const;

/** Read an exact plain-object boundary without invoking any property getter. */
function readExactOwnData(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) return undefined;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
      result[field] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function hasExactOwnKeys(value: unknown, fields: readonly string[]): boolean {
  try {
    return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).length === fields.length &&
      Reflect.ownKeys(value).every((key) => typeof key === 'string' && fields.includes(key));
  } catch {
    return false;
  }
}

function nonblankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Narrow an untrusted model proposal into the guard's canonical input. */
export function narrowCommitmentProposal(input: unknown, context: CommitmentEvidenceContext): CommitmentProposal {
  const semantic = readExactOwnData(input, ['kind']);
  if (!semantic) {
    if (hasExactOwnKeys(input, ['kind'])) throw new Error('COMMITMENT_PROPOSAL_KIND_INVALID');
    throw new Error('COMMITMENT_PROPOSAL_INVALID');
  }
  if (typeof semantic.kind !== 'string' || !COMMITMENT_KINDS.includes(semantic.kind as CommitmentProposalKind)) {
    throw new Error('COMMITMENT_PROPOSAL_KIND_INVALID');
  }
  const evidence = readExactOwnData(context, EVIDENCE_FIELDS);
  if (!evidence || !nonblankString(evidence.accountId) || !nonblankString(evidence.conversationId) || !nonblankString(evidence.inboundMessageId)) {
    throw new Error('COMMITMENT_EVIDENCE_CONTEXT_INVALID');
  }
  return Object.freeze({
    kind: semantic.kind as CommitmentProposalKind,
    accountId: evidence.accountId,
    conversationId: evidence.conversationId,
    inboundMessageId: evidence.inboundMessageId,
  });
}
export type CommitmentGuardResult = {
  outcome: CommitmentGuardOutcome;
  reasonCode: CommitmentReasonCode;
  quoteRef?: { id: string; status: string; quotationNo: string };
  evidenceRefs: Array<{ sourceId: string; sourceVersion: string }>;
};

/** Canonical commitment authorization. Natural-language semantics are model-owned; canonical truth remains host-owned. */
export class CommitmentGuard {
  constructor(private readonly db: Database.Database) {}

  authorize(proposal: unknown): CommitmentGuardResult {
    const canonical = readExactOwnData(proposal, COMMITMENT_FIELDS);
    if (!canonical || typeof canonical.kind !== 'string' || !COMMITMENT_KINDS.includes(canonical.kind as CommitmentProposalKind) ||
      !nonblankString(canonical.accountId) || !nonblankString(canonical.conversationId) || !nonblankString(canonical.inboundMessageId)) {
      return this.result('BLOCKED', 'PROPOSAL_INVALID');
    }
    const detached = Object.freeze({
      kind: canonical.kind as CommitmentProposalKind,
      accountId: canonical.accountId,
      conversationId: canonical.conversationId,
      inboundMessageId: canonical.inboundMessageId,
    });
    const message = this.db.prepare('SELECT * FROM messages WHERE id=? AND account_id=? AND conversation_id=? AND direction=\'INBOUND\'').get(detached.inboundMessageId, detached.accountId, detached.conversationId) as any;
    if (!message) return this.result('BLOCKED', 'INBOUND_NOT_PERSISTED');
    const conversation = this.db.prepare('SELECT * FROM conversations WHERE id=? AND channel_account_id=?').get(detached.conversationId, detached.accountId) as any;
    const identity = conversation?.customer_id && this.db.prepare('SELECT 1 FROM customer_channel_identities WHERE channel_account_id=? AND customer_id=? AND external_id=?').get(detached.accountId, conversation.customer_id, message.sender_external_id);
    if (!conversation || !identity) return this.result('BLOCKED', 'IDENTITY_MISMATCH');
    // The model owns semantic interpretation of ACCEPT/REJECT/CANCEL/CHANGE.
    // The host deliberately does not re-parse customer language with phrase
    // catalogs or regular expressions. Authorization below is canonical only.

    const evidence = JSON.stringify({ kind: detached.kind, messageId: message.id, externalMessageId: message.external_message_id, accountId: detached.accountId, conversationId: detached.conversationId });
    const acceptedReplay = this.db.prepare("SELECT q.*,a.id AS acceptance_id FROM quotations q JOIN quotation_acceptances a ON a.quotation_id=q.id WHERE q.source_conversation_id=? AND a.message_id=? LIMIT 1").get(detached.conversationId, message.id) as any;
    if (acceptedReplay) return this.result('NOOP_REPLAY', 'ACCEPTED', acceptedReplay, [{ sourceId: acceptedReplay.acceptance_id, sourceVersion: 'ACCEPTANCE' }, { sourceId: message.id, sourceVersion: 'INBOUND' }]);
    const rejectionReplay = this.db.prepare("SELECT a.id,q.* FROM audit_events a JOIN quotations q ON q.id=a.entity_id WHERE a.entity_type='QUOTATION' AND a.event_type='COMMITMENT' AND a.evidence_ref=? AND a.payload_json=? LIMIT 1").get(message.id, evidence) as any;
    if (rejectionReplay) return this.result('NOOP_REPLAY', detached.kind === 'CANCEL' ? 'REJECTION_RECORDED' : 'REJECTED', rejectionReplay, [{ sourceId: rejectionReplay.id, sourceVersion: 'COMMITMENT' }, { sourceId: message.id, sourceVersion: 'INBOUND' }]);

    // Read the canonical latest commitment-relevant quote first. This makes a
    // superseded quote observable instead of checking an unreachable status.
    const quote = this.db.prepare("SELECT * FROM quotations WHERE source_conversation_id=? AND status IN ('SENT','SUPERSEDED','EXPIRED') ORDER BY rowid DESC LIMIT 1").get(detached.conversationId) as any;
    const committed = this.db.prepare("SELECT q.id,q.status,q.quotation_no FROM quotations q LEFT JOIN sales_orders s ON s.source_quotation_id=q.id WHERE q.source_conversation_id=? AND (q.status='ACCEPTED' OR s.status='DRAFT') ORDER BY q.rowid DESC LIMIT 1").get(detached.conversationId) as any;
    if (committed) return this.result('HANDOFF', 'COMMITMENT_ALREADY_ACCEPTED', committed);
    // Only quotation sends can suspend commitment. Runtime/customer replies
    // and unrelated outbound work in this conversation are not quotation truth.
    const unresolved = this.db.prepare("SELECT 1 FROM outbound_messages WHERE conversation_id=? AND entity_type='QUOTATION' AND status IN ('PENDING','UNKNOWN')").get(detached.conversationId);
    if (detached.kind === 'CHANGE' && !quote) return this.result('APPLIED', 'CHANGE_PRECOMMIT');
    if (detached.kind === 'CANCEL' && !quote) return this.result('APPLIED', 'CANCELLED_PRECOMMIT');
    if (!quote) return this.result('NEEDS_CLARIFICATION', 'QUOTE_NOT_ACTIVE');
    if (quote.customer_id !== conversation.customer_id) return this.result('BLOCKED', 'CANONICAL_SCOPE_MISMATCH', quote);
    if (quote.status === 'SUPERSEDED') return this.result('NEEDS_CLARIFICATION', 'QUOTE_SUPERSEDED', quote);
    if (quote.status === 'EXPIRED') return this.result('NEEDS_CLARIFICATION', 'QUOTE_EXPIRED', quote);
    if (new Date(quote.valid_until).getTime() <= Date.now()) return this.result('NEEDS_CLARIFICATION', 'QUOTE_EXPIRED', quote);
    if (message.forwarding_json) {
      try {
        const forwarding = JSON.parse(message.forwarding_json);
        if (!forwarding || typeof forwarding !== 'object' || typeof forwarding.isForwarded !== 'boolean') throw Error('MALFORMED_FORWARDING');
        if (forwarding.isForwarded) return this.result('BLOCKED', 'FORWARDED_EVIDENCE', quote);
      }
      catch { return this.result('BLOCKED', 'FORWARDED_EVIDENCE', quote); }
    }
    if (new Date(message.occurred_at).getTime() < new Date(quote.sent_at ?? 0).getTime()) return this.result('BLOCKED', 'MESSAGE_REORDERED', quote);
    if (message.reply_to_external_message_id && message.reply_to_external_message_id !== quote.sent_outbound_message_id) return this.result('NEEDS_CLARIFICATION', 'REPLY_MISMATCH', quote);
    if (detached.kind === 'CHANGE') return this.result('NEEDS_CLARIFICATION', unresolved ? 'ACCEPTANCE_SUSPENDED_REPLACEMENT' : 'REPLACEMENT_REQUIRED', quote);
    if (detached.kind === 'ACCEPT' && unresolved) return this.result('BLOCKED', 'UNRESOLVED_OUTBOUND', quote);
    if (detached.kind === 'ACCEPT') return this.result('APPLIED', 'ACCEPTED', quote, [
      { sourceId: message.id, sourceVersion: 'INBOUND' },
      { sourceId: quote.id, sourceVersion: 'QUOTATION' },
    ]);

    try {
      this.db.transaction(() => {
        const moved = this.db.prepare("UPDATE quotations SET status='REJECTED' WHERE id=? AND status='SENT'").run(quote.id);
        if (moved.changes !== 1) throw Error('COMMITMENT_CONCURRENT_STATE');
        this.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), 'QUOTATION', quote.id, 'COMMITMENT', 'Customer', message.id, message.id, new Date().toISOString(), evidence);
      })();
    } catch (error) {
      if ((error as Error).message === 'COMMITMENT_CONCURRENT_STATE') return this.result('BLOCKED', 'CONCURRENT_STATE', quote, [{ sourceId: message.id, sourceVersion: 'INBOUND' }]);
      throw error;
    }
    const audit = this.db.prepare("SELECT id FROM audit_events WHERE entity_type='QUOTATION' AND entity_id=? AND event_type='COMMITMENT' AND payload_json=?").get(quote.id, evidence) as any;
    const rejected = this.db.prepare('SELECT * FROM quotations WHERE id=?').get(quote.id) as any;
    return this.result('APPLIED', detached.kind === 'CANCEL' ? 'REJECTION_RECORDED' : 'REJECTED', rejected, [{ sourceId: audit.id, sourceVersion: 'COMMITMENT' }, { sourceId: message.id, sourceVersion: 'INBOUND' }]);
  }

  private result(outcome: CommitmentGuardOutcome, reasonCode: CommitmentReasonCode, quote?: any, evidenceRefs: Array<{ sourceId: string; sourceVersion: string }> = []): CommitmentGuardResult {
    return { outcome, reasonCode, ...(quote ? { quoteRef: { id: quote.id, status: quote.status, quotationNo: quote.quotation_no } } : {}), evidenceRefs };
  }
}

export function commitmentMessageRef(db: Database.Database, message: IncomingChannelMessage): string | undefined {
  return (db.prepare('SELECT id FROM messages WHERE account_id=? AND external_message_id=? AND conversation_id=? AND direction=\'INBOUND\'').get(message.accountId, message.externalMessageId, message.conversationId) as any)?.id;
}
