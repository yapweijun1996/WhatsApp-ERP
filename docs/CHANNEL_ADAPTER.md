# WhatsApp Channel Adapter Contract

## Incoming contract
```ts
export type IncomingChannelMessage = {
  channel: "whatsapp";
  accountId: string;
  externalMessageId: string;
  conversationId: string;
  sender: { externalId: string; phone?: string; displayName?: string };
  type: "text" | "image" | "audio" | "document";
  text?: string;
  media?: { mimeType: string; externalRef: string };
  occurredAt: string;
  forwarding?: { isForwarded: boolean; originalSenderKnown?: boolean; originalSenderExternalId?: string };
};
```

## Outbound contract
```ts
export type OutgoingChannelMessage = {
  accountId: string;
  clientMessageId: string; // stable, persisted before submission
  conversationId: string;
  replyToExternalMessageId?: string;
  text: string;
  attachments?: Array<{ mimeType: string; fileName: string; ref: string; sha256: string }>;
};
```

## Adapter interface
`connect()`, `disconnect()`, `getStatus()`, `onMessage(handler)`, `send(message)`.

## QR V1
Shows QR, persists linked-device session, normalizes received messages, and sends replies. It is explicitly **demo-only/unofficial** and must be isolated under its adapter.

## Meta migration
Official webhook adapter verifies webhook/auth, converts Meta payload -> same `IncomingChannelMessage`, and uses Graph API for outbound. No change is permitted to Pi tools, commerce state machine, ERP adapter, DB document model, or UI business semantics.

## Correlation and send result
Inbound messages include optional `replyToExternalMessageId`; adapters must preserve account + sender identity and never infer customer globally from phone alone. `fileName` is the provider-neutral attachment filename, `ref` is the immutable content reference, and `sha256` is the lowercase SHA-256 of the referenced bytes.

`send()` returns provider-neutral:
```ts
type ChannelSendResult =
  | { status: "submitted"; externalMessageId: string; submittedAt: string }
  | { status: "failed"; retryable: boolean; errorCode: string }
  | { status: "unknown"; clientMessageId: string };
```
Commerce may mark a quotation `SENT` only on `submitted`. `unknown` is persisted and requires reconciliation; it must not trigger blind resend or acceptance eligibility. Every send is linked to a frozen quote snapshot hash.

## Presence (transport UX only)
Adapters may optionally implement:
```ts
publishAvailable?(): Promise<void>;
sendChatPresence?(input: { conversationId: string; state: "composing" | "paused" }): Promise<void>;
```
`publishAvailable` is account-level online/available presence, published by the adapter itself when its transport reaches an online/reconnected state (e.g. the linked-device socket reaching `open`). `sendChatPresence` is the per-chat typing indicator: the host sends `composing` immediately before AI/tool processing begins for an inbound message that will actually be processed, and always sends `paused` afterward — on any terminal, error, timeout, cancel, or handoff outcome — via try/finally cleanup so composing can never get stuck. Both methods are optional; adapters that omit them are simply skipped. Presence is never durable, never retried, and a presence failure must never fail, delay, or duplicate the business outbound message. Duplicate/replayed inbound delivery (already deduplicated before reaching processing) must not trigger a second composing/paused cycle.

## V1 media behavior
Only text is interpreted in V1. Image/audio/document metadata may be stored, but the agent must ask for a text restatement and those unsupported messages cannot accept a quote or create a commerce document.

## Reconciliation contract
Adapters expose optional `reconcile({ accountId, clientMessageId })` returning:
```ts
type ChannelReconcileResult =
  | { status: "submitted"; externalMessageId: string; submittedAt?: string }
  | { status: "not_found" }
  | { status: "unknown" };
```
The commerce service persists outbound intent **before** invoking `send`. On restart, unfinished attempts are uncertain until reconciliation. `unknown` never causes automatic resend and never makes a quotation acceptance-eligible. QR demo may return `unknown`; Meta/simulated adapters may provide stronger reconciliation. A new quotation intent validates `sent_snapshot_hash`, renders its caption and PDF once, validates/binds the attachment identity and hash, and durably stores the complete provider-neutral `OutgoingChannelMessage` in `payload_json` before `send()`. Retries use that stored wire payload exactly; they do not read a new quote snapshot or caller wording. Legacy pre-PDF intents are accepted only when their snapshot/payload is structurally valid and remain text-only on retry. `{}` and missing/malformed snapshots are rejected.
