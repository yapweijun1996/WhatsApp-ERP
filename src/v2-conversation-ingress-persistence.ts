import { createHash } from 'node:crypto';
import type { IncomingChannelMessage } from './channel-contract.js';
import { V1Database } from './database.js';
import { IdentityResolver, type IdentityState } from './v2-identity-resolver.js';

export type CanonicalIngress = {
  message: IncomingChannelMessage;
  customerId: string | null;
  /** Present when resolved by the evidence-based IdentityResolver. */
  identityState?: IdentityState;
};

/** Server-owned, provider-neutral conversation/identity boundary for V2 ingress.
 * Always persists the conversation. Returns null customerId for unresolved contacts. */
export class ConversationIngressPersistence {
  private readonly identityResolver: IdentityResolver;

  constructor(private readonly database: V1Database) {
    this.identityResolver = new IdentityResolver(database.db);
  }

  resolve(input: IncomingChannelMessage): CanonicalIngress | undefined {
    return this.database.runImmediate(() => {
      const db = this.database.db;

      // Resolve identity: always succeeds, never returns undefined.
      // May throw on V2_CANONICAL_CHANNEL_CONFLICT or V2_CANONICAL_IDENTITY_CONFLICT.
      const resolution = this.identityResolver.resolve(input);
      const customerId = resolution.customerId;

      let conversation = db.prepare('SELECT * FROM conversations WHERE id=? AND channel_account_id=?').get(input.conversationId, input.accountId) as any;
      if (!conversation) conversation = db.prepare('SELECT * FROM conversations WHERE channel_account_id=? AND external_conversation_id=?').get(input.accountId, input.conversationId) as any;

      // Guard: existing customer conversation must not be claimed by an unresolved sender.
      if (conversation?.customer_id && customerId === null) throw Error('V2_CANONICAL_IDENTITY_CONFLICT');
      if (conversation?.customer_id && customerId && conversation.customer_id !== customerId) throw Error('V2_CANONICAL_CUSTOMER_CONFLICT');

      if (!conversation) {
        const id = `conv-${createHash('sha256').update(`${input.accountId}|${input.conversationId}`).digest('hex').slice(0, 24)}`;
        db.prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?,?,?)').run(
          id, input.accountId, input.conversationId, customerId, 'OPEN', input.occurredAt
        );
        conversation = db.prepare('SELECT * FROM conversations WHERE id=? AND channel_account_id=?').get(id, input.accountId) as any;
      } else if (!conversation.customer_id && customerId) {
        db.prepare('UPDATE conversations SET customer_id=? WHERE id=? AND customer_id IS NULL').run(customerId, conversation.id);
        conversation = db.prepare('SELECT * FROM conversations WHERE id=? AND channel_account_id=?').get(conversation.id, input.accountId) as any;
      }

      if (!conversation) throw Error('V2_CANONICAL_SCOPE_CONFLICT');
      if (customerId && conversation.customer_id !== customerId) throw Error('V2_CANONICAL_SCOPE_CONFLICT');

      return {
        message: { ...input, conversationId: conversation.id },
        customerId,
        identityState: resolution.identityState,
      };
    });
  }
}
