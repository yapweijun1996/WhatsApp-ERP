import type Database from 'better-sqlite3';

export type AbuseState = 'NORMAL' | 'SUSPICIOUS' | 'COOLDOWN' | 'BLOCKED';

export interface AbuseGuardResult {
  readonly state: AbuseState;
  readonly messageCountInWindow: number;
}

const WINDOW_SECONDS = 60;
const SUSPICIOUS_THRESHOLD = 5;
const COOLDOWN_THRESHOLD = 10;
const BLOCKED_THRESHOLD = 20;

export const PROSPECT_ABUSE_REPLIES: Record<'COOLDOWN' | 'BLOCKED', string> = {
  COOLDOWN: 'Too many messages. Please wait before sending more.',
  BLOCKED: 'This number has been temporarily restricted.',
};

export const PROSPECT_ONBOARDING_REPLY =
  'Hello! To help you with orders, I need to verify your identity first. Please contact us to set up your account.';

/** Fixed reply for SUSPICIOUS abuse state — no model tokens consumed, explicit policy. */
export const PROSPECT_SUSPICIOUS_REPLY =
  'Your message activity looks unusual. Please wait a moment before trying again.';

/**
 * Cheap deterministic pre-LLM rate guard. Zero model calls.
 * Counts recent inbound messages from the sender in the messages table.
 */
export class InboundAbuseGuard {
  constructor(private readonly db: Database.Database) {}

  evaluate(accountId: string, senderExternalId: string, occurredAt: string): AbuseGuardResult {
    const windowStart = new Date(new Date(occurredAt).getTime() - WINDOW_SECONDS * 1000).toISOString();
    const result = this.db.prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE account_id=? AND sender_external_id=? AND direction='INBOUND' AND occurred_at>=?`
    ).get(accountId, senderExternalId, windowStart) as { n: number };
    const n = Number(result.n);
    const state: AbuseState =
      n >= BLOCKED_THRESHOLD ? 'BLOCKED'
      : n >= COOLDOWN_THRESHOLD ? 'COOLDOWN'
      : n >= SUSPICIOUS_THRESHOLD ? 'SUSPICIOUS'
      : 'NORMAL';
    return { state, messageCountInWindow: n };
  }
}
