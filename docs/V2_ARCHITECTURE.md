# V2 Architecture — Agentic Digital Employee

Status: **ASTRA R3 PASS / PARTIALLY IMPLEMENTED — PHASE 0 + WORKSPACE/VALIDATION/CAPABILITY FOUNDATION + CONTEXT + PI-001/PI-002/PI-003 RUNTIME SLICES**
This document remains the normative V2 target. Implemented slices are tracked by `docs/V2_TASKS.md`, `docs/V2_PHASE1B_REVIEW.md`, and `docs/V2_PHASE1B_VERIFICATION.md`; uncompleted capabilities, context/runtime, transport, commitment, migration rollout, and release requirements remain planned behavior. V2 traffic remains disabled.

## 1. North star

One state-aware Sales Digital Employee helps a customer achieve a commercial goal across multiple turns. It observes the canonical conversation and business workspace, chooses a bounded business capability, executes it through a server-authorized registry, observes a structured result, and continues until it can reply, clarify, hand off, or stop at the V1 commitment boundary.

The employee is not a chatbot with a larger intent enum. Pi Agent Core is the runtime for a persistent, bounded observe → decide → act → observe loop. The model chooses sequencing and language; deterministic domain services decide truth, eligibility, calculations, mutations, idempotency, concurrency, provenance, and authority.

AI autonomy still ends at `SALES_ORDER.DRAFT`. Staff-only posting, confirmation, and delivery-order progression remain server-enforced and independent of prompts, model output, profile text, channel, or request-body actor labels.

## 2. V1 baseline and anti-pattern diagnosis

The frozen V1 lifecycle remains authoritative:

`MESSAGE → intelligence → QUOTATION.DRAFT → QUOTATION.SENT → QUOTATION.ACCEPTED → SALES_ORDER.DRAFT → HUMAN POST → SALES_ORDER.POSTED → HUMAN/OPS CONFIRMATION → DO_READY`.

The current source is a safe V1 baseline: `IncomingChannelMessage` isolates the channel, `CommerceService` performs deterministic ERP calls and guarded commerce transitions, outbound quotation sends use durable `PENDING/UNKNOWN` reconciliation, and Pi has no post/confirm/DO tool. V2 preserves these properties.

The main V1 scalability problem is shape, not safety:

- `PiOrderAgent` is primarily an intent interpreter with one `interpret_order` action rather than a state-aware employee runtime.
- `CommerceService` owns inbound routing, clarification wording, pending-order persistence, ERP orchestration, quote lifecycle, acceptance, outbound behavior, and staff actions.
- `customer_order_memory.pending_order` is JSON-shaped business workspace with no first-class revision or concurrent-edit model.
- Customer-facing English is emitted by domain orchestration, which makes every new state or variation a hardcoded branch.
- Browser Demo text-only behavior is treated as a special interpretation path instead of a transport that preserves the same agent semantics.

V2 addresses these with modular boundaries and a real Pi loop, not dozens of intents, regexes, a prompt-only authorization scheme, or a microservice rewrite.

## 3. Target architecture

```text
IncomingChannelMessage
        |
        v
ConversationService ── canonical transcript, dedupe, ordering, channel identity
        |
        v
AgentTurnCoordinator
  ├─ AgentContextBuilder
  ├─ EmployeeProfileResolver
  ├─ DigitalEmployeeRuntime (Pi persistent bounded loop)
  │    ├─ Capability/Tool Registry (server authorization)
  │    ├─ trusted/private native tool transport
  │    └─ Browser Demo GPT → DemoTextToolBridge
  └─ AgentTurn/Action timeline
        |
        v
Business capabilities
  ├─ CustomerContextCapability / OrderHistoryCapability
  ├─ OrderDraftWorkspaceCapability
  ├─ OrderValidationCapability
  ├─ QuotationCapability
  ├─ CommerceStatusCapability
  └─ SafeHumanHandoffCapability
        |
        v
Deterministic domain services
  ConversationService | WorkItemService | OrderDraftService
  OrderValidationService | QuotationService
  Acceptance/CommitmentService | SalesOrderDraftService
  StaffCommitService | OutboundMessageService
        |
        v
ERP contract + persistence + append-only evidence/audit
        |
        v
Provider-neutral OutgoingChannelMessage → QR demo / future Meta adapter
```

The UI consumes readable timeline events and business documents. It does not expose private chain-of-thought, hidden prompts, secrets, or raw model JSON as the primary experience.

## 4. Core modules and contracts

### 4.1 `DigitalEmployeeRuntime`

The runtime owns one turn session for one inbound message and can resume a durable work item across messages. It receives an `AgentContext`, an `EmployeeProfile`, and a capability registry. It asks Pi for the next action or final response, validates that action, executes it, appends a structured result, rebuilds/refreshes relevant context, and repeats within budgets.

The runtime never grants authority from natural language. It checks profile permission, capability availability, input schema, work-item/conversation scope, idempotency key, and domain guards before execution. A final response is allowed only through the server-side `ResponseGroundingGuard`, including clarification and handoff fallbacks.

`ResponseGroundingGuard` accepts a transport-independent `GroundedResponsePlan`:

```text
GroundedResponsePlan {
  turnId, intent: ANSWER | CLARIFY | HANDOFF | ACKNOWLEDGE,
  connectiveText?: non-commercial model language,
  factClaims: [{ slot, canonicalRef:{sourceId, versionOrRevision, evidenceRefs[]}, valueShape }],
  safeReasonCode?, handoff?, outboundPurpose
}
```

Customer identity, quantity/UOM, SKU/product, price/currency/total, stock/availability, delivery date,
quotation/SO number or status, and commitment outcome are protected slots. They may appear only as
canonical fact references; the host resolves and renders them from authoritative records. Connective
language may not introduce or alter a protected fact. The guard rejects unsupported, stale, contradictory,
fabricated, injected, or scope-mismatched claims. Mutable facts require a canonical re-read immediately
before outbound, bound to the turn and relevant commerce revision. Failure emits no commercial claim and
selects safe retry, bounded clarification, or handoff. Verdict, resolved slots, references, and rejection
reason are persisted as evidence. Demo final responses use this exact guard.

### 4.2 `AgentContextBuilder`

The context is a bounded projection, not a second source of truth:

```text
AgentContext {
  turnId, accountId, conversationId, inboundMessageRef,
  recentTranscript: bounded canonical messages,
  conversationSummary: bounded synthesized summary + source/revision,
  customerContext: resolved identity, permissions, currency, warehouse,
  activeWorkItem: goal, state, owner, priority, revision,
  orderDraft: current revision and deterministic line facts,
  activeQuotation/SalesOrder: status and safe references,
  relevantErpEvidenceAndPolicies,
  availableCapabilities: names, purpose, input schemas, limits,
  unresolvedQuestions, handoff status, current time/timezone
}
```

The builder loads bounded recent transcript, then a summary, then authoritative records. It excludes irrelevant history, secrets, provider payloads, private staff authority, and untrusted instructions disguised as data. Context carries evidence references and freshness/revision markers so a stale result cannot silently mutate newer state.

### 4.3 `EmployeeProfile`

The initial profile is `sales-digital-employee` with role, mission, tone, language policy, capability permissions, forbidden commitments, escalation rules, and turn budgets. Profiles are configuration/data, not authorization. Server-side registry policy is the final authority. A future profile may change mission/tone/capability allow-list without rewriting the runtime; V2.0 has one profile and no swarm.

Forbidden commitments include posting or confirming a Sales Order, creating a Delivery Order, changing ERP truth without a domain capability, inventing a customer/SKU/UOM/price/stock/document number, bypassing acceptance evidence, or bypassing staff authority.

### 4.4 Work items

`WorkItem` is the long-lived customer goal, initially `SALES_ORDER_REQUEST`. It has a stable id, conversation/customer/account scope, type, lifecycle state, goal summary, active draft/quote references, assigned profile, revision, timestamps, last action, blocking reason, and provenance. It can be resumed, paused for clarification, handed off, superseded, completed, or failed safely. It is extensible for future goals without adding an intent branch to the runtime.

Suggested pre-commit states are `OPEN`, `NEEDS_CLARIFICATION`, `DRAFTING`, `READY_TO_QUOTE`, `QUOTING`, `AWAITING_ACCEPTANCE`, `CHANGING`, `HANDED_OFF`, `COMPLETED`, `CANCELLED`, and `FAILED`. These are workspace states only; they do not replace or extend the V1 quotation/Sales Order state machine after `SALES_ORDER.DRAFT`.

### 4.5 Order draft workspace

`OrderDraft` and `OrderDraftLine` replace pending-order JSON as the business workspace. A draft has customer/account/conversation/work-item references, delivery request, warehouse, currency, status, current revision, source/evidence references, and timestamps. A line stores requested wording plus resolved product/UOM facts only after deterministic validation, quantity, remark, availability/price evidence references, and line status.

`OrderDraftRevision` is immutable. Every create, reuse-previous-order, add, change, remove, delivery-date edit, validation, requote preparation, or supersession records a new revision with actor, inbound message, base revision, resulting values, and reason. Mutations require optimistic revision checks and stable idempotency keys. A quote copies a validated snapshot; later draft edits never rewrite a sent quote or accepted SO.

`prepare_quotation` invokes normative `validateForQuotation` as a quote-time transaction, never promotion of earlier validation. On the exact current
draft revision it fresh-reads customer eligibility/status, product and UOM/conversion, applicable customer
price and validity, warehouse/stock, requested delivery policy/date, and required business facts, then
atomically creates the quote snapshot/evidence. Price, stock, and customer eligibility are always fresh at
quote creation; immutable/catalog evidence is reusable only with an explicit valid source version. Changed,
ambiguous, unavailable, or stale facts block the quote with a structured result; old validation remains
historical only.

Phase 1B (`V2-VAL-001`) implements the read-only `OrderValidationService` foundation. It reads the exact immutable draft
revision, resolves customer eligibility, product/SKU or customer alias, UOM/conversion, current customer
price, warehouse stock, and recent order history directly from the existing ERP tables. Every lookup writes
an `erp_evidence` record and every validation attempt writes an append-only `v2_order_validations` historical
record with its exact draft revision, mode, status, result/reason, and evidence refs. Decimal quantities and conversion factors use string-backed integer arithmetic;
subtotals must resolve to exact currency cents. `validateForQuotation` repeats all mutable reads and checks
the current draft revision, so a previous successful validation is never promoted as quote truth. Quotation
V2-DRAFT-003 now implements deterministic revisioned draft actions, historical validation-action revisions, and SENT-quotation workspace requote preparation; quotation preparation/sending and V2 traffic remain unimplemented/disabled.

Canonical quotation, acceptance, outbound, and Sales Order state wins over WorkItem/OrderDraft projections.
WorkItem state cannot authorize commerce mutation. The legal projection matrix is:

| Canonical condition | Legal WorkItem/OrderDraft behavior |
|---|---|
| no quote | `OPEN`/`DRAFTING`; create or revise one current draft |
| quote `DRAFT` | `QUOTING`; only referenced draft revision may prepare/send |
| quote `SENT` | `AWAITING_ACCEPTANCE`; edits start replacement; old quote remains active |
| replacement `PENDING`/`UNKNOWN` | `CHANGING`/`HANDED_OFF`; reconcile first; no acceptance/second send |
| `ACCEPTED` + `SALES_ORDER.DRAFT` | `COMPLETED`/`HANDED_OFF`; no AI change, cancel, or unwind |
| `REJECTED`/`EXPIRED`/`SUPERSEDED` | reference inactive; only explicit new/replacement draft may open |
| cancelled work | no commerce mutation; only a new explicit goal may resume |

Exactly one active WorkItem per account/conversation/order goal, one current draft revision, and one active
quote reference are allowed. Every mutation fresh-reads canonical state and expected revisions under the
relevant commerce lock/transaction. Any post-acceptance or post-Draft-SO change is human handoff; AI cannot
silently unwind an accepted commitment.

### 4.6 Memory layers

1. Canonical transcript: immutable normalized inbound/outbound messages, ids, ordering, account, sender, reply correlation, forwarding/media metadata.
2. Bounded synthesized summary: replaceable, versioned compression of conversation facts and unresolved goals, each claim linked to source message/evidence refs.
3. Authoritative business state: WorkItem, OrderDraft revisions, quotations, acceptances, SOs, outbound intents, ERP evidence, and audit events.

Raw chat and summaries are context aids only. They never become ERP truth or authorization evidence. Summarization failure leaves authoritative state intact and causes a bounded fallback to recent transcript or handoff.

## 5. Capability/Tool Registry

Capabilities are business-level operations with typed input/output contracts, policy metadata, scopes, side-effect class, idempotency requirements, timeout, and evidence requirements. They are preferable to microscopic SQL reads. SQL is never model-facing.

Initial registry target:

- `get_customer_context` and `get_order_history`;
- `get_or_create_work_item`;
- `read_order_draft`, `create_order_draft`, `reuse_previous_order`, `add_line`, `change_line`, `remove_line`, `set_delivery_request`;
- `validate_order_draft` and `check_availability`;
- `prepare_quotation`, `send_quotation`, `get_commerce_status`;
- `record_customer_commitment` only through `CommitmentGuard`;
- `create_sales_order_draft` only after guarded accepted quotation;
- `request_human_handoff` (a capability action; customer messaging remains runtime-owned) and
  `QuotationService.send_quotation` through the sole `OutboundMessageService`.

No `execute_sql`, stock mutation, price override, `post_sales_order`, `confirm_sales_order`, `create_delivery_order`, or `DO_READY` capability exists in the employee registry. StaffCommitService is a separate authenticated surface and is not exposed to Pi.

Capability results use structured contracts:

```text
CapabilityResult<T> = {
  status: "SUCCEEDED" | "NEEDS_CLARIFICATION" | "BLOCKED" | "RETRYABLE" | "FAILED",
  data?: T,
  evidence: EvidenceRef[],
  stateChanges: StateChangeRef[],
  reasonCode?: string,
  retryable?: boolean,
  idempotency?: { key: string, replayed: boolean },
  revision?: number
}
```

Contracts contain reason codes and facts, not hardcoded customer-facing English. The agent proposes a
`GroundedResponsePlan`; it cannot call a generic send-message capability.

There is exactly one outbound owner: `OutboundMessageService`, invoked by `AgentTurnCoordinator` for
runtime-owned replies and by `QuotationService` for a quotation capability-owned response. Each turn has
one exclusive `TurnOutboundDisposition`: `RUNTIME_RESPONSE`, `CAPABILITY_OWNED_QUOTATION`, `HANDOFF_NO_CUSTOMER_MESSAGE`,
or `NONE`. Quotation service returns `CAPABILITY_OWNED_QUOTATION`; the coordinator must not emit a second
final response in that turn. A follow-up is allowed only if explicitly modeled as one atomic multipart
response; V2.0 uses one outbound owner/message.

Every intent has stable per-turn/purpose client id, canonical payload hash, and durable `PENDING`,
`SUBMITTED`, `FAILED`, or `UNKNOWN` state. Non-quotation replies never blind-resend `UNKNOWN`; they reconcile
by client id/provider evidence or hand off. Quotation retains the stronger frozen V1 reconciliation and
acceptance blocking rules. Uniqueness is `(conversationId, turnId, purpose)` and provider submission is
idempotent. Crash/retry/reconnect tests must prove no duplicate or lost disposition.

## 6. Pi turn algorithm and budgets

For each accepted inbound message:

1. Persist/dedupe the normalized message with a monotonic `arrival_seq` (unique inbound key remains
   account + externalMessageId) and enqueue it in the durable per-conversation inbox.
2. Load or create the WorkItem; build bounded context and resolve the profile.
3. Start a durable `agent_turn` with correlation and budget metadata.
4. Ask Pi for exactly one next capability action or final response.
5. Validate plain/native action syntax, profile permissions, registry availability, scope, schema, revision, and idempotency.
6. Execute the capability through the domain boundary; persist action/result/evidence summary.
7. Refresh only changed context and continue until final response, clarification, handoff, terminal business result, or budget exhaustion.
8. Before any capability side effect, re-read expected WorkItem/draft/canonical-commerce versions. If stale,
   abort/rebuild. Before runtime-owned outbound, suppress or merge a stale nonessential reply when a newer
   inbound is queued. Persist outbound intent before provider submission and reconcile quotation sends using
   the unchanged V1 semantics.
9. Emit a readable timeline and close/resume the turn with a durable outcome.

Default pilot configuration is provisional and change-controlled: maximum 8 model turns, 6 capability calls,
one action per model turn, 15-second call timeout, 60-second turn timeout, and one repair attempt. These are
configuration, not authority decisions. On exhaustion, no further mutation occurs; the guard-approved safe
retry/handoff response records the reason.

Replay uses turn/action ids and capability idempotency. The coordinator processes one `arrival_seq` at a time
under a bounded lease with owner, expiry, heartbeat, and durable resume; no database transaction spans model
or provider waits. New inputs queue. If a newer input arrives before a side effect, the turn may be superseded;
after side-effect start, finish idempotently then process the next sequence. Provider timestamps are evidence
and commitment-ordering input only; they never rewind the processed watermark. Reconnect/redelivery dedupes,
late timestamps cannot retroactively mutate, and acceptance/requote uses the commerce lock plus fresh canonical read.

## 7. Transport abstraction

`AgentModelTransport` supplies the canonical `AgentDecision`, `AgentObservation`, and `TurnTrace` interface
regardless of transport. A semantic oracle runs the same canonical context and scripted decision fixture through
both transports and compares normalized decision, registry invocation, capability result/error mapping,
stateChanges/evidence, `TurnOutboundDisposition`, grounding verdict, and terminal outcome. Only wire/auth,
stream/provider request id, latency, and natural connective wording may differ; business actions, state,
evidence, guard results, and stop semantics may not. The corpus compares host traces, not model wording or
HTTP/parser success.

### Trusted/private native tools

The private Gateway path may expose typed native tools where supported. The host still validates every call and executes only registry capabilities.

### Browser Demo `DemoTextToolBridge`

The `/demo` policy forbids provider-native tools and structured outputs. The bridge sends a versioned v1 envelope
and requires exactly one plain-text JSON object per model turn. Every envelope contains `protocolVersion`,
`turnId`, `sequence`, `correlationId`, `actionId`, and exactly one `kind` (`tool_call`, `capability_result`,
or `final_response`). A tool call contains tool name and args; a final response contains a response plan,
not free-form protected facts. The prompt includes expected turn/sequence. Results echo matching ids/sequence, status, and `resultHash`. `resultHash` is SHA-256 over UTF-8 RFC 8785/JCS canonical JSON of exactly `{protocolVersion, turnId, sequence, correlationId, actionId, kind:"capability_result", name, status, result}` with `resultHash` itself excluded. The `result` value is the complete normalized `CapabilityResult` after host validation/redaction and before transport serialization. Native and Demo semantic traces use the same normalized hash input. Replay, mismatch, out-of-order, duplicate action, unknown capability, multiple objects, hash mismatch, and schema violations are rejected. Max input 32 KiB/8k tokens, output 16 KiB/4k tokens, and one repair attempt
using the same ids/schema/budget; repair cannot widen capabilities or scope. The host durably records the
observation/projection fingerprint and append-only repair phase before reserving REPAIR. A restart may resume
only PENDING repair; RESERVED or VALID without a durably reflected action/final response fails closed, so a
fresh bridge cannot reserve another MODEL or safely replay an uncertain provider call.

```json
{"protocolVersion":"v1","turnId":"turn-...","sequence":2,"correlationId":"corr-...","actionId":"act-...","kind":"tool_call","name":"validate_order_draft","arguments":{"draftId":"...","revision":3}}
```

or:

```json
{"protocolVersion":"v1","turnId":"...","sequence":3,"correlationId":"...","actionId":"...","kind":"final_response","responsePlan":{"intent":"ANSWER","connectiveText":"...","factClaims":[{"slot":"quotation_status","canonicalRef":{"sourceId":"...","versionOrRevision":"...","evidenceRefs":["..."]},"valueShape":"status"}],"outboundPurpose":"customer_reply"}}
```

The bridge rejects markdown, multiple objects, unknown keys, multiple actions, invalid schemas, unavailable
capabilities, and malformed output. It never executes domain actions: validated actions enter the same host
registry path as native transport. `dmo_` tokens and API secrets are excluded from prompts, model context,
logs, traces, database, audit payloads, errors, and customer output; transport errors are sanitized. Final
plans pass through `ResponseGroundingGuard`. A direct-bypass attempt fails closed.

## 8. Domain boundaries and authority

- `ConversationService`: normalization, deduplication, ordering, transcript and channel identity.
- `WorkItemService`: long-lived goal lifecycle and concurrency/revision ownership.
- `OrderDraftService`: draft workspace and immutable revisions.
- `OrderValidationService`: deterministic customer/product/UOM/price/stock validation and evidence.
- `QuotationService`: quote snapshots, send orchestration, supersession, expiry.
- `Acceptance/CommitmentService`: explicit acceptance/rejection and `CommitmentGuard`.
- `SalesOrderDraftService`: accepted quote → exactly one `SALES_ORDER.DRAFT`.
- `StaffCommitService`: authenticated staff post/confirm/DO progression, outside AI capabilities.
- `OutboundMessageService`: durable intents, provider submission, UNKNOWN/reconciliation.
- `ErpContract`: canonical ERP truth and document numbering.

The split is modular within the existing application, not a mandate for separate deployables. `CommerceService` is strangled behind these boundaries incrementally.

`CommitmentGuard` combines deterministic checks with semantic assistance. The model may identify that a message appears to accept/reject a quote or propose a commercial change, but only the guard can mutate state after checking original inbound evidence, active canonical quote, account/conversation/customer identity, ordering/reply/forwarding rules, expiry, unresolved outbound state, and explicitness policy. A vague “yes”, quoted old text, stale/superseded quote, or ambiguous intent produces clarification, never mutation.

Normative commitment matrix (only `CommitmentGuard` may authorize these transitions):

| Input | Required guards and exact canonical transition |
|---|---|
| ACCEPT | Inherited V1 explicitness; sole eligible active `SENT` quote; account/customer/conversation identity; message/reply ordering; non-forwarded evidence; not expired/superseded; and no unresolved replacement/quotation outbound `PENDING/UNKNOWN`. Exact idempotent transaction: `SENT -> ACCEPTED` + acceptance evidence + exactly one `SALES_ORDER.DRAFT`. |
| REJECT | Explicit rejection bound to the current eligible active `SENT` quote with the same identity/order/reply/forward/expiry checks. Exact idempotent transition: `SENT -> REJECTED`; no Draft SO is created. |
| CANCEL before a sent quote | Cancel the active pre-commit WorkItem/OrderDraft only; no quotation/SO canonical transition exists. |
| CANCEL with active `SENT` quote | Explicit cancel is treated as guarded commercial rejection. Exact idempotent canonical transition: active quote `SENT -> REJECTED`, with cancellation/rejection evidence; then close/cancel the workspace projection. If correlation/identity/eligibility is ambiguous, clarify/handoff and do not mutate. |
| CANCEL after `ACCEPTED` or `SALES_ORDER.DRAFT` | No AI commerce mutation. Preserve accepted quote/SO and create human handoff. |
| CHANGE before acceptance, no sent quote | Create/revise the current OrderDraft revision and revalidate affected facts; no canonical quote mutation. |
| CHANGE with active `SENT` quote | Start a replacement draft/quotation workflow under the conversation commerce lock. The old quote remains canonical `SENT`, but **acceptance eligibility is suspended immediately while any replacement quotation outbound is `PENDING/UNKNOWN`**. If replacement submission is proven `submitted`, one atomic finalization sets the new quote `SENT`, sets the old quote `SUPERSEDED`, persists outbound external id/evidence/audit, and makes only the new quote acceptance-eligible. If replacement resolves to a non-submitted terminal `FAILED/not_found` state and no unresolved replacement remains, the old still-valid `SENT` quote may regain eligibility after fresh CommitmentGuard checks. |
| CHANGE after `ACCEPTED` or `SALES_ORDER.DRAFT` | No AI unwind/requote. Preserve the commitment and hand off to staff. |
| conflicting ACCEPT + CHANGE (for example “confirm, but change red one to 2”) | Never ACCEPT. `CHANGE`/clarification wins safety; follow the applicable CHANGE row. |

Plain “Yes” is not acceptance unless the explicit V1 acceptance contract is satisfied. `UNKNOWN`, stale,
superseded, forwarded, reordered, or uncorrelated replies never mutate. Every guard result is idempotent,
transaction-bound, references the canonical quote revision and inbound evidence, and returns `APPLIED`,
`NOOP_REPLAY`, `NEEDS_CLARIFICATION`, `BLOCKED`, or `HANDOFF`. Semantic/model output is only a proposal to this matrix and cannot name a different transition.

## 9. Persistence proposal

Add incrementally: `employee_profiles`; `conversation_summaries` and optionally `agent_sessions`; `work_items`; `order_drafts`, `order_draft_lines`, `order_draft_revisions`; `agent_turns`, `agent_actions`; `human_handoffs`; and commitment evidence records if existing acceptance/audit tables cannot express the required references. Preserve `messages`, `quotations`, `quotation_lines`, `quotation_acceptances`, `sales_orders`, `outbound_messages`, `erp_evidence`, `agent_tool_calls`, `audit_events`, staff authorization, and document sequences.

Source of truth: canonical messages and V1 commerce/ERP/evidence tables remain authoritative; new workspace tables own pre-commit goals and draft revisions; summaries are derived; agent turns/actions are operational provenance, not business truth.

Migration is a one-writer state machine: `V1_ONLY → SHADOW_IMPORT → V2_CANARY → V2_PRIMARY → LEGACY_RETIRED`.
Exactly one workspace writer is authoritative per conversation/work item.

Normative overlapping-field ownership matrix. “Legacy” means `customer_order_memory.pending_order`; “V2” means the current `OrderDraft`/`OrderDraftRevision`. Canonical `messages`, customer/channel identity, quotation/outbound/acceptance/SO, ERP evidence, and document sequences are never workspace-owned and remain their existing V1/domain sources in every migration state.

| Overlapping workspace field/source | `V1_ONLY` | `SHADOW_IMPORT` | `V2_CANARY` (eligible work item only) | `V2_PRIMARY` | `LEGACY_RETIRED` |
|---|---|---|---|---|---|
| customer/account/conversation refs | canonical identity/message refs; legacy may copy | canonical refs; V2 projection read-only | canonical refs; V2 stores foreign refs | canonical refs; V2 stores foreign refs | canonical refs; V2 stores foreign refs |
| source inbound message id / sender external ref | Legacy writer, derived from canonical message | Legacy writer; V2 read-only projection | V2 writer from canonical message; legacy mirror only | V2 writer from canonical message; legacy mirror only | V2 writer from canonical message |
| requested product wording / line query | Legacy writer | Legacy writer; V2 shadow read-only | V2 `OrderDraftRevision` writer | V2 writer | V2 writer |
| quantity / requested UOM / row remark | Legacy writer | Legacy writer; V2 shadow read-only | V2 `OrderDraftRevision` writer | V2 writer | V2 writer |
| requested delivery date | Legacy writer | Legacy writer; V2 shadow read-only | V2 `OrderDraftRevision` writer | V2 writer | V2 writer |
| resolved product/UOM/price/stock facts | never authoritative in legacy memory; ERP/evidence is canonical | ERP/evidence canonical; V2 projection read-only | ERP/evidence canonical; V2 only stores evidence refs/snapshot facts | same | same |
| current workspace revision / active draft pointer | implicit legacy row is authority | legacy authority; V2 pointer read-only | V2 revision/pointer is sole workspace authority | V2 sole authority | V2 sole authority |
| WorkItem goal/state | absent/derived; V1 flow authority | V2 derived shadow only, no writes affecting flow | V2 writer for eligible canary work item, subordinate to canonical commerce | V2 writer, subordinate to canonical commerce | V2 writer, subordinate to canonical commerce |
| legacy pending JSON after V2 authority | authoritative | authoritative | derived compatibility mirror; MUST NOT be read as authority | derived mirror only | absent/retired |

A state transition flips a persisted workspace-authority marker in the same deterministic migration transaction that creates/verifies the V2 current revision. Reads MUST consult that marker; dual-authoritative reads or dual writes are forbidden. Shadow is read-only for overlapping
facts. Cutover occurs only at a safe boundary or deterministic migration transaction with stable key
`accountId/conversationId/workItemId`; backfill stores source hash, schema version, idempotency key, and
authority marker. Hash mismatch is quarantined for human review, never auto-chosen. After V2 authority,
`customer_order_memory.pending_order` may be a derived compatibility mirror only and is never read as authority.
Rollback freezes V2 writes, transactionally materializes a V1-compatible projection if required, flips the
authority marker, preserves V2 history, and cannot create a second active draft. Migration owner is the
application/database migration owner; V1 owner approves canary and rollback. Schema additions must be
backward-readable by V1 before cutover.

## 10. Reliability, recovery, and security

The V1 durable outbound quotation protocol remains intact: intent before send, stable client id, submitted finalization transaction, UNKNOWN reconciliation, no blind resend, no acceptance eligibility while unresolved, and serialized replacement/acceptance. All runtime-owned clarification, acknowledgement, and handoff customer replies MUST use the sole `OutboundMessageService` and the exclusive `TurnOutboundDisposition` contract in §5. They use durable per-turn/purpose intent, idempotency, reconciliation/no-blind-resend behavior, while quotation sends retain the stronger frozen V1 semantics.

Failure policy is explicit for model unavailable, malformed Demo action, ambiguous product, unknown customer, stock shortage, price failure, stale draft revision, outbound UNKNOWN, superseding quote, concurrent messages, duplicate inbound, provider reconnect, and handoff: preserve prior durable state, return a safe reason or hand off, and never guess or partially commit.

Prompt injection is untrusted input. It cannot create capabilities, change profile permissions, reveal private staff authority, or override domain guards. Capabilities are server-authorized, channel payloads do not enter order-core, secrets are not persisted, Demo tokens remain memory-only, and all mutations require deterministic contracts.

## 11. Observability and UI

Persist and display timeline summaries for receive, context load, profile/budget, selected capability, tool
start/end, result status, state change, grounding verdict, reply, clarification, and handoff. The telemetry
allowlist is ids, bounded reason/status codes, durations, retry/replay flags, source/version/evidence ids,
state names, and redacted hashes. It excludes prompts, raw customer text unless separately access-controlled,
model outputs, provider payloads, secrets, tokens, prices/customer data outside approved evidence fields, and
staff credentials. Access is role-scoped (customer support/audit only to permitted evidence), retention is
provisional 90 days for operational traces and 7 years for immutable commercial audit, and export/redaction
tests are mandatory. Staff views show active WorkItem, draft revision, quote/SO references, and authority boundary.

## 12. Strangler migration

Use the one-writer state machine in §9: baseline V1, import V2 shadow read-only, canary only eligible work items at safe boundaries, then promote V2 as the sole writer. Keep V1 as rollback until corpus, negatives, reconciliation, and real-channel evidence pass. Do not big-bang replace schema or CommerceService.

## 13. Non-goals and invariants

Non-goals: multi-agent swarm, autonomous post/confirm/DO, provider lock-in, a new lifecycle after Draft, replacing ERP truth with an LLM, a framework/microservice rewrite, raw chain-of-thought storage, or an unbounded autonomous loop.

Architectural invariants: V1 authority order remains; AI stops at Draft; staff authority is server-enforced; explicit acceptance is guarded; evidence is immutable/traceable; quote send reliability is preserved; provider payloads stay at adapters; unknowns are clarified or handed off; all AI actions are bounded, replayable, and observable.

## 14. Decided operational contracts

Decisions: one Sales Digital Employee and no swarm; Pi owns the bounded loop; business capabilities over SQL
tools; structured result contracts; Demo bridge is a transport adapter; workspace states are pre-commit only;
modular monolith remains the deployment shape; the contracts above own authority/state/commitment/migration.
Pi persistence uses durable `agent_turns`/`agent_actions` with lease resume; schema changes use versioned,
backward-readable migrations; summaries use source-linked replacement records and the stated retention policy;
handoff ownership is the staff operations queue with a provisional 4-business-hour pilot alert; commitment
evidence uses existing acceptance/audit records unless schema review proves they cannot carry the references.
Production staff authentication is a release blocker before any non-demo exposure: existing opaque staff
authority plus tenant/role/target checks must be demonstrated. Meta webhook idempotency follows the same
account+externalMessageId key, arrival watermark, and OutboundMessageService reconciliation contract.
