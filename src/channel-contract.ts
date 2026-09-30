export type IncomingChannelMessage = {
  channel: 'whatsapp';
  accountId: string;
  externalMessageId: string;
  conversationId: string;
  sender: { externalId: string; phone?: string; displayName?: string };
  type: 'text' | 'image' | 'audio' | 'document';
  text?: string;
  media?: { mimeType: string; externalRef: string };
  occurredAt: string;
  replyToExternalMessageId?: string;
  forwarding?: { isForwarded: boolean; originalSenderKnown?: boolean; originalSenderExternalId?: string };
};

export type OutgoingChannelMessage = {
  accountId: string;
  clientMessageId: string;
  conversationId: string;
  replyToExternalMessageId?: string;
  text: string;
  attachments?: Array<{ mimeType: string; ref: string; fileName: string; sha256: string }>;
};

export type ChannelSendResult =
  | { status: 'submitted'; externalMessageId: string; submittedAt: string }
  | { status: 'failed'; retryable: boolean; errorCode: string }
  | { status: 'unknown'; clientMessageId: string };

export type ChannelReconcileResult =
  | { status: 'submitted'; externalMessageId: string; submittedAt?: string }
  | { status: 'not_found' }
  | { status: 'unknown' };

/** Per-chat typing indicator. Distinct from account-level online/available presence. */
export type ChatPresenceState = 'composing' | 'paused';

/** Provider-neutral channel boundary. Provider SDK payloads must be normalized before this interface. */
export interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): Promise<'connected' | 'disconnected' | 'connecting'>;
  onMessage(handler: (message: IncomingChannelMessage) => Promise<void>): void;
  send(message: OutgoingChannelMessage): Promise<ChannelSendResult>;
  reconcile?(input: { accountId: string; clientMessageId: string }): Promise<ChannelReconcileResult>;
  /** Transport UX only, never business semantics. Adapters that cannot support
   * presence simply omit these; callers must treat both as optional/no-op and
   * never let a presence failure affect business message delivery. */
  publishAvailable?(): Promise<void>;
  sendChatPresence?(input: { conversationId: string; state: ChatPresenceState }): Promise<void>;
}

/** Backward-compatible V1 name; the contract itself is provider-neutral. */
export type WhatsAppChannelAdapter = ChannelAdapter;
