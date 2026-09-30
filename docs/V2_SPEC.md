# V2 Specification — Sales Digital Employee

Status: **ASTRA R3 PASS / PARTIALLY IMPLEMENTED — PHASE 0 + WORKSPACE FOUNDATION + V2-VAL-001 + V2-DRAFT-003 / FULL V2 NOT IMPLEMENTED**

Phase 1B closeout evidence is recorded in `docs/V2_PHASE1B_REVIEW.md` and `docs/V2_PHASE1B_VERIFICATION.md`. The implemented slice now also includes V2-DRAFT-003 deterministic revisioned workspace actions, historical validation-action revisions, and SENT-quote workspace requote preparation; it does not implement quotation preparation/sending, Draft SO creation, or full V2 traffic. V2 traffic remains disabled.

## 1. Product and business requirements

V2 shall provide one state-aware Sales Digital Employee for WhatsApp conversations. It shall help customers ask questions, assemble and revise an order workspace, validate it against ERP truth, prepare/send/revise quotations, record explicit acceptance, and create at most a `SALES_ORDER.DRAFT`. Staff shall retain all post-Draft authority.

V2 shall preserve the V1 lifecycle, provenance, immutable quotation snapshots, durable outbound send/reconciliation, account-scoped identity, deterministic calculations, stock-posting policy, and provider-neutral channel contract. New WorkItem and OrderDraft states are pre-commit workspace state only.

## 2. Functional requirements

### FR-01 Agent runtime

The runtime shall load context, ask Pi for one next action or final response, execute a server-validated capability, observe the structured result, and continue within explicit model/tool/time budgets. It shall support multi-step goals across turns and durable resume without requiring one giant CommerceService branch.

### FR-02 Context

Each turn shall receive bounded recent transcript, versioned summary when available, customer context, active WorkItem, current OrderDraft revision, active quotation/SO state, relevant ERP evidence/policies, unresolved questions, and available capabilities. Context shall distinguish authoritative state from derived memory and untrusted customer content.

### FR-03 Profiles and authority

`EmployeeProfile` shall describe mission, role, tone, permitted capabilities, forbidden commitments, and escalation behavior. Server-side capability authorization, domain guards, staff capability verification, and database constraints shall enforce authority. Prompt instructions are never sufficient authorization.

### FR-04 WorkItem

`SALES_ORDER_REQUEST` shall be first-class and resumable. It shall own a stable customer goal, active draft/quote references, lifecycle state, revision, provenance, and handoff status. The model may propose actions; WorkItemService determines legal workspace transitions.

### FR-05 OrderDraft

The system shall support create, reuse previous order, add line, change line, remove line, set delivery request, validate, prepare quote, and requote. `prepare_quotation` MUST invoke `validateForQuotation` on the exact current draft revision at quote time; prior validation is historical only. Revisions shall be immutable, optimistic-concurrency checked, idempotent, and linked to source messages and ERP evidence. A quotation/SO snapshot shall not change when a later draft changes.

### FR-06 Capabilities

Initial capabilities shall cover customer context/history, draft workspace, validation/availability, quotation, commerce status, and safe human handoff. They shall return structured `status/data/evidence/stateChanges/reasonCode` results and shall not contain customer-facing prose as their contract.

### FR-07 Natural responses

The employee shall produce concise, state-aware natural language through a server-side `ResponseGroundingGuard`.
The model may provide connective language and a `GroundedResponsePlan`, but protected facts (customer,
quantity/UOM, SKU/product, price/currency/total, stock, delivery date, quotation/SO number/status, commitment
outcome) require canonical source id plus version/revision and evidence refs. The host renders fact slots,
freshly re-reads mutable facts immediately before outbound, and rejects stale, fabricated, injected,
unsupported, contradictory, or scope-mismatched claims. Failure emits no commercial claim and uses safe
retry/clarification/handoff. Demo uses the same guard. Positive, fabricated, stale, injection, and contradiction
tests are required.

### FR-08 Transport parity

Trusted/private native tools and Browser Demo text-only operation shall share canonical `AgentDecision`,
`AgentObservation`, and `TurnTrace` semantics. The host oracle compares canonical context, registry call,
result/error, state/evidence, outbound disposition, grounding verdict, and terminal outcome; only wire/auth,
request id/latency, and connective wording may differ. Demo v1 envelopes contain protocolVersion, turnId,
sequence, correlationId, actionId, and one tool call/result/final plan; expected ids are echoed, replay/mismatch/
out-of-order/duplicate/unknown actions reject, limits are 32KiB input/8k tokens and 16KiB output/4k tokens,
and one same-id repair is allowed without capability widening. Repair eligibility and phase are host/durable
ledger facts: pending repair may resume once, while reserved/uncertain repair fails closed across restart.
Bridge never executes domain actions directly;
tokens/secrets are absent from prompt/context/log/trace/DB/audit/error/customer output.

### FR-09 Commitment guard

Semantic assistance may classify a likely acceptance, rejection, cancel, or change, but only `CommitmentGuard`
may mutate. ACCEPT requires inherited explicitness and all active-SENT/account/customer/conversation/order/reply/forward/
expiry/unresolved-send guards, exactly once. Plain Yes is not acceptance. REJECT of the current eligible active
`SENT` quote maps idempotently to `SENT -> REJECTED` with bound evidence. CANCEL is workspace-only before a sent
quote; with an active `SENT` quote, explicit cancel uses the same guard and exact canonical `SENT -> REJECTED`
transition; after `ACCEPTED`/Draft SO it cannot unwind and hands off. CHANGE revises the workspace before
acceptance. With active `SENT`, it starts a replacement under the commerce lock: the old quote remains `SENT`
but acceptance is suspended while replacement outbound is `PENDING/UNKNOWN`; proven replacement submission
atomically sets the new quote `SENT` and the old quote `SUPERSEDED`. A proven non-submitted terminal replacement
failure may restore eligibility of the still-valid old quote only after fresh guard checks. After acceptance/Draft
SO CHANGE hands off. Conflicting accept+change chooses change/clarify and never accepts. Unknown, stale,
superseded, forwarded, reordered, or uncorrelated messages do not mutate and return the matrix-authorized
clarification/block/handoff result idempotently.

### FR-10 Channel and outbound

All channels shall normalize to `IncomingChannelMessage`; no WhatsApp provider payload may enter order-core. QR remains demo/unofficial. Meta remains a replaceable future adapter. Quotation outbound intent is durable before submission; submitted finalization is atomic; UNKNOWN prevents blind resend and acceptance eligibility until reconciliation. `OutboundMessageService` is the sole outbound owner; each turn has one disposition, and quotation capability results are `CAPABILITY_OWNED_QUOTATION`, prohibiting a second runtime final response. Runtime replies use stable per-turn/purpose ids, durable PENDING/SUBMITTED/FAILED/UNKNOWN states, uniqueness, and reconciliation/no-blind-resend rules.

### FR-11 Queue, freshness, and canonical precedence

Persistence assigns monotonic `arrival_seq`; one bounded lease processes a conversation sequence at a time,
with expiry/owner/heartbeat and durable resume, never a DB transaction across model/network waits. New inputs
queue; side effects recheck expected revisions and canonical commerce under the commerce lock. Provider time is
evidence, not a rewind mechanism. Canonical quote/acceptance/outbound/SO state beats WorkItem/draft projection;
one active work item, current draft revision, and active quote reference are constraints. `prepare_quotation`
fresh-validates the exact current revision, customer policy, product/UOM, current price/validity, stock,
delivery, and required facts atomically; prior validation is historical only.

## 3. Required behavior corpus

The executable/evaluation corpus shall cover at least:

| Case | Required outcome |
|---|---|
| Greeting / thanks | Natural concise response; no invented commerce mutation. |
| Order history question | Query deterministic history and summarize grounded facts. |
| Same as last week | Retrieve history, present/reuse a draft only with evidence, clarify differences. |
| Modify previous order | Create/reuse OrderDraft revision; do not mutate historical SO/quote. |
| Add/remove/change line | Revisioned workspace action, then revalidate affected facts. |
| Delivery request | Store requested delivery in draft and validate date/policy. |
| Price/stock question | Deterministic evidence; no model-generated price/stock. |
| Ambiguous product | Bounded clarification, never guess SKU. |
| Shortage | Explain shortage and offer bounded adjustment/handoff; no quote with invalid stock. |
| Yes state-awareness | Distinguish permission to prepare from quote acceptance using canonical state. |
| Prepare quote | Validate, prepare/send according to current state and outbound rules. |
| Change after quote | Create a new draft/requote; preserve old sent quote until replacement is successfully sent, then supersede atomically. |
| OK confirm | Accept only if explicit and active quote guards pass; create one Draft SO. |
| Vague acceptance | Clarify; no commitment mutation. |
| Reject/cancel/change order | Apply only legal current-state behavior; quote rejection is guarded; draft changes stay pre-commit. |
| Order status | Read canonical commerce status; distinguish quote, Draft SO, and staff progression. |
| Unknown customer | Ask for bounded identity clarification; do not infer globally. |
| Prompt injection | Treat as untrusted text; capabilities and authority unchanged. |
| Customer asks AI to post SO | Refuse/route to staff; no post capability exists. |
| Duplicate/reordered messages | Idempotent replay or stale-revision clarification; no duplicate quote/SO. |
| Malformed model output | Reject/repair once within budget, then fail closed or hand off. |
| Human handoff | Persist reason, context/evidence refs, customer-safe response, and staff-visible work item. |
| Grounding | Positive canonical claim passes; fabricated, stale, injected, contradictory, and unsupported protected claims fail closed. |
| Fresh quotation | Changed price, stock, or customer policy between draft validation and quote preparation blocks the quote. |
| Queue/recovery | Late timestamp cannot rewind watermark; redelivery dedupes; lease expiry resumes; newer queued input suppresses stale nonessential reply. |
| Outbound ownership | Crash/retry/reconnect yields one disposition; capability-owned quotation never receives a second runtime response. |
| Demo envelope | Replay, mismatch, duplicate, multi-object, unknown capability, token leakage, widened repair, and direct bypass all fail. |
| Transport oracle | Native and Demo host traces are semantically equal under the allowed wire-only difference list. |
| Commitment matrix | ACCEPT/REJECT/CANCEL/CHANGE and conflicting language produce only the matrix-authorized idempotent result. |

## 4. Non-functional requirements

- Safety: no AI post/confirm/DO path; fail closed on unknown identity, product, UOM, price, stock, commitment, permission, or revision.
- Reliability: bounded loops; durable turn/action correlation; idempotent retries; crash-safe outbound reconciliation; provider reconnect handling.
- Consistency: deterministic decimal totals, UOM conversions, document numbers, state transitions, and evidence.
- Performance: configurable per-turn timeout and budgets; no unbounded context or transcript growth.
- Privacy/security: no secrets or Demo tokens persisted; redact sensitive provider/model data; isolate staff authority; defend against prompt injection.
- Portability: provider-neutral channel and ERP contracts; QR-to-Meta migration without commerce semantic changes.
- Operability: readable timeline, structured logs/metrics, replay diagnostics, handoff queue, and explicit model/transport mode. Telemetry is allowlisted, role-access-controlled, redacted, and retention-tested; production staff authentication is required before non-demo exposure.
- Migration: incremental strangler with exactly one authoritative workspace writer. The field-level ownership matrix in `V2_ARCHITECTURE.md` §9 is normative for source message refs, requested line wording/quantity/UOM/remark, requested delivery, active revision and WorkItem state. `SHADOW_IMPORT` is read-only for V2; canary/primary writes require the persisted authority marker; canonical identity/commerce/ERP evidence never transfers to workspace ownership; mismatches quarantine and rollback cannot create dual active drafts.

## 5. Data and provenance requirements

Every agent turn/action shall link to account, conversation, inbound message, WorkItem revision, profile, capability name/version, model transport, outcome, and redacted error/latency. Every business mutation shall retain source message/evidence refs. Every quote line shall retain exact ERP evidence roles. Every accepted quote shall retain explicit inbound acceptance evidence and source quote. Draft SO lines shall copy accepted quote values without repricing. Summaries shall cite source refs and remain non-authoritative.

Proposed new records are `employee_profiles`, `conversation_summaries`/sessions, `work_items`, `order_drafts`, `order_draft_lines`, `order_draft_revisions`, `agent_turns`, `agent_actions`, and `human_handoffs`; optional commitment evidence is allowed only if existing acceptance/audit records are insufficient. Existing V1 messages, quote, SO, outbound, ERP evidence, audit, and staff records remain authoritative.

## 6. Security and safety requirements

Capability permissions shall be checked server-side against profile, tenant/account, conversation/work-item scope, current state, and revision. No prompt can add a capability. No capability can post/confirm/DO. Staff actions require the existing opaque server-issued authority and explicit target/evidence. Provider payloads are normalized at the channel edge. Raw customer text, summaries, model outputs, and tool results are untrusted input. SQL, secrets, private staff authority, and hidden prompts are never model-visible.

## 7. Acceptance criteria

V2 is acceptable only when:

1. The architecture review gate is PASS and all open authority questions are resolved or explicitly deferred without weakening invariants.
2. Pi demonstrably performs a bounded multi-step observe/action/result loop using at least three business capabilities in a single goal.
3. The same semantic test corpus passes in deterministic native-tool and DemoTextToolBridge modes, including malformed output and prompt injection.
4. WorkItem and revisioned OrderDraft support the required create/reuse/add/change/remove/delivery/validate/requote behaviors with stale-revision and replay tests.
5. Customer/SKU/UOM/price/stock/document truth comes only from deterministic services and evidence.
6. Explicit acceptance is independently guarded and produces exactly one Draft SO; vague/stale/forwarded/superseded acceptance does not mutate state.
7. No AI-facing route/capability can post/confirm SO or create DO; forged actor labels fail.
8. Existing V1 outbound `PENDING/UNKNOWN` recovery, atomic sent finalization, supersession, and acceptance blocking remain green.
9. Timeline/UI shows readable receive/context/action/result/reply/handoff events without private chain-of-thought or raw JSON primary UX.
10. Rollback to the V1 path is demonstrated before broad enablement, and full deterministic plus real-WhatsApp evaluation evidence is recorded.

## 8. V2 Definition of Done

V2 is done only when implementation evidence, not document existence, demonstrates: all required corpus cases; deterministic unit/integration/browser coverage; failure/recovery injection; security/authority negatives; migration and rollback evidence; provider-neutral adapter tests; acceptable latency/budget metrics; staff handoff operations; and an independent review with no unresolved P0/P1 contract violation. Until then every runtime statement in this specification is planned behavior.
