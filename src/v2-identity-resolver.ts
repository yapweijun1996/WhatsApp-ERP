import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { IncomingChannelMessage } from './channel-contract.js';

export type IdentityState = 'UNKNOWN' | 'PROSPECT' | 'CANDIDATE_CUSTOMER' | 'VERIFIED_CUSTOMER';

export interface IdentityResolution {
  readonly identityState: IdentityState;
  /** Non-null only for VERIFIED_CUSTOMER. */
  readonly customerId: string | null;
  /** Non-null for UNKNOWN/PROSPECT (prospect_identities row id). */
  readonly prospectId: string | null;
}

/**
 * Evidence-based identity resolver. UNKNOWN and PROSPECT are additive states
 * that never create customer bindings. Only deterministic canonical evidence
 * may commit a VERIFIED_CUSTOMER binding. CANDIDATE_CUSTOMER is reserved for
 * future ERP-evidence-based promotion and is never committed here.
 */
export class IdentityResolver {
  constructor(private readonly db: Database.Database) {}

  resolve(input: IncomingChannelMessage): IdentityResolution {
    // 1. Existing verified binding in customer_channel_identities.
    const identity = this.db.prepare(
      'SELECT customer_id, channel FROM customer_channel_identities WHERE channel_account_id=? AND external_id=?'
    ).get(input.accountId, input.sender.externalId) as { customer_id: string; channel: string } | undefined;

    if (identity) {
      if (identity.channel !== input.channel) throw Error('V2_CANONICAL_CHANNEL_CONFLICT');
      return { identityState: 'VERIFIED_CUSTOMER', customerId: identity.customer_id, prospectId: null };
    }

    // 2. Deterministic canonical evidence: env-configured phone binding.
    // BOTH WHATSAPP_QR_CUSTOMER_PHONE and WHATSAPP_QR_CUSTOMER_ID must be explicitly set.
    // Missing customer ID never implies CUST-001 or any default.
    const phone = (input.sender.phone ?? '').replace(/\D/g, '');
    const configuredPhone = (process.env.WHATSAPP_QR_CUSTOMER_PHONE ?? '').replace(/\D/g, '');
    const configuredCustomerId = process.env.WHATSAPP_QR_CUSTOMER_ID;
    if (phone && configuredPhone && phone === configuredPhone && configuredCustomerId) {
      if (this.db.prepare('SELECT id FROM customers WHERE id=?').get(configuredCustomerId)) {
        const identityId = `qr-${createHash('sha256').update(`${input.accountId}|${input.sender.externalId}`).digest('hex').slice(0, 24)}`;
        this.db.prepare('INSERT OR IGNORE INTO customer_channel_identities VALUES(?,?,?,?,?,?)')
          .run(identityId, configuredCustomerId, input.accountId, input.channel, input.sender.externalId, input.sender.phone ?? null);
        const committed = this.db.prepare(
          'SELECT customer_id, channel FROM customer_channel_identities WHERE channel_account_id=? AND external_id=?'
        ).get(input.accountId, input.sender.externalId) as { customer_id: string; channel: string } | undefined;
        if (!committed || committed.channel !== input.channel) throw Error('V2_CANONICAL_CHANNEL_CONFLICT');
        if (committed.customer_id !== configuredCustomerId) throw Error('V2_CANONICAL_IDENTITY_CONFLICT');
        return { identityState: 'VERIFIED_CUSTOMER', customerId: configuredCustomerId, prospectId: null };
      }
    }

    // 3. No verified binding: track as prospect (UNKNOWN on first contact, PROSPECT thereafter).
    const now = new Date().toISOString();
    const prospectId = `pros-${createHash('sha256').update(`${input.accountId}|${input.sender.externalId}`).digest('hex').slice(0, 24)}`;
    const existing = this.db.prepare(
      'SELECT id FROM prospect_identities WHERE channel_account_id=? AND external_id=?'
    ).get(input.accountId, input.sender.externalId) as { id: string } | undefined;

    if (!existing) {
      this.db.prepare(
        `INSERT OR IGNORE INTO prospect_identities(id,channel_account_id,channel,external_id,phone,display_name,first_seen_at,last_seen_at,message_count)
         VALUES(?,?,?,?,?,?,?,?,1)`
      ).run(prospectId, input.accountId, input.channel, input.sender.externalId,
            input.sender.phone ?? null, input.sender.displayName ?? null, now, now);
      return { identityState: 'UNKNOWN', customerId: null, prospectId };
    }

    this.db.prepare(
      `UPDATE prospect_identities SET last_seen_at=?, message_count=message_count+1,
       phone=COALESCE(?,phone), display_name=COALESCE(?,display_name)
       WHERE channel_account_id=? AND external_id=?`
    ).run(now, input.sender.phone ?? null, input.sender.displayName ?? null,
          input.accountId, input.sender.externalId);
    return { identityState: 'PROSPECT', customerId: null, prospectId: existing.id };
  }
}
