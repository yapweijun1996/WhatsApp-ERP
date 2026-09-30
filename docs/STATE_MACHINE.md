# Canonical Commerce State Machine

This file is normative for V1 lifecycle and actor authority.

## Quotation transitions
| From | To | Actor | Guard |
|---|---|---|---|
| none | DRAFT | AI/service | customer resolved; deterministic lines/price/UOM; requested delivery date recorded |
| DRAFT | SENT | AI/service | provider-neutral send result is `submitted`; sent snapshot frozen |
| DRAFT | SUPERSEDED | service | replacement draft is created before send |
| SENT | ACCEPTED | customer evidence + service | explicit acceptance from same account/conversation/customer, message after sent message, quote still active/not expired |
| SENT | REJECTED | customer evidence + service | explicit rejection tied to active quote |
| SENT | EXPIRED | service clock | `valid_until` passed before acceptance |
| SENT | SUPERSEDED | service | a replacement quote is successfully SENT; old quote becomes ineligible |

Only `ACCEPTED` may produce a Draft Sales Order. At most one acceptance-eligible `SENT` quotation exists per conversation. Ambiguous acceptance triggers clarification, never mutation.

## Sales Order transitions
| From | To | Actor | Guard |
|---|---|---|---|
| none | DRAFT | service after accepted quote | exactly one SO per accepted quotation; accepted snapshot copied without repricing |
| DRAFT | POSTED | authenticated staff capability | staff records final customer double-confirmation; latest stock is rechecked; V1 hard-blocks any shortage with no override |
| POSTED | CONFIRMED | authenticated staff capability | post exists and confirmation action explicitly invoked |
| CONFIRMED | DO_READY | authenticated staff capability | confirmation exists and DO-ready action explicitly invoked |

AI principal/capability is rejected server-side for every transition beyond `DRAFT`, regardless of request body actor labels.

## Demo staff authorization
V1 uses a server-issued staff session/capability stored outside request JSON. Staff-only routes validate it at service boundary. Tests must prove forged `actorType: staff` input cannot bypass it.

## Acceptance rules
- inbound message persists `accountId`, sender external id/phone, optional `replyToExternalMessageId`, ordering timestamp and dedup key;
- acceptance must refer to or unambiguously follow the sole active SENT quote;
- quoted/forwarded old acceptance text does not count;
- `Yes please` after the AI asks permission to prepare a quote is permission to prepare/send, not quote acceptance;
- old/delayed acceptance after supersession/expiry cannot mutate state.

## Idempotency / atomicity
- unique inbound key: `(channel_account_id, external_message_id)`;
- unique Draft SO source: `sales_orders.source_quotation_id`;
- quotation acceptance + acceptance evidence + Draft SO + audit events commit in one DB transaction;
- all commerce mutation tools accept a stable idempotency key and return existing result on exact retry;
- concurrent conflicting transitions serialize on the quotation/SO row and fail closed.

## Stock / price validity
- stock is informational in V1 until staff post; quotation does not reserve or deduct stock;
- price is validated when quote is created and frozen in the sent snapshot until `valid_until`;
- acceptance uses frozen quote price; no automatic repricing;
- staff post rechecks current stock and surfaces any deterioration before allowing demo post;
- demo stock deduction occurs at staff `POSTED`, exactly once.

## V1 hard stock-posting policy
V1 has **no stock-shortage override**. Staff post is blocked if the atomic recheck finds insufficient available base quantity for any line. In one DB transaction, the service locks all affected `(product_id, warehouse_id)` balance rows in deterministic key order, rechecks quantities, deducts stock, records the `DRAFT -> POSTED` transition, stores staff/double-confirm evidence, and appends audit events. Any failure rolls back all changes. Exact retry returns the already-posted result by stable staff-post idempotency key. Competing orders cannot both consume the same remaining stock.


## Outbound quotation finalization atomicity
The adapter call occurs after a durable `PENDING` outbound intent commit. If the provider returns `submitted`, the service opens one DB transaction that: (1) updates that outbound row to `SUBMITTED` with external message id, (2) freezes/marks the target quotation `SENT`, (3) marks the previously active SENT quotation `SUPERSEDED` when this is a replacement, and (4) appends send/supersession audit events. These four effects commit or roll back together. There is no state where a persisted `SUBMITTED` outbound exists without its quotation finalization.

If the process crashes after provider submission but before this transaction commits, the durable row is still `PENDING`; restart converts/reconciles it as uncertain. If reconciliation proves submission, the same atomic finalization transaction is replayed idempotently and **never resends** the payload. Any unresolved `PENDING/UNKNOWN` quotation send in a conversation suspends acceptance eligibility for potentially superseded quotes until reconciliation/finalization completes. Tests inject crashes before provider call, after provider submission/before finalization commit, and concurrent acceptance during replacement send.


## In-flight quotation serialization
A conversation may have only one quotation send/finalization mutation in flight. Creating/sending a replacement acquires the conversation commerce lock before reading the active quote and holds serialized mutation ownership through durable send-intent creation/finalization state registration. Acceptance and competing replacement attempts must serialize against the same conversation lock; acceptance cannot race past an unresolved replacement attempt.
