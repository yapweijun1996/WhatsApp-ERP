# V2 Epics — Agentic Digital Employee

Status: **PLANNED / ASTRA R3 PASS / IMPLEMENTATION PENDING OWNER AUTHORIZATION**

## Delivery gates

Each epic must preserve the V1 lifecycle, evidence semantics, staff boundary, provider-neutral channel contract, and outbound reliability. An epic cannot declare done from code existence alone; its acceptance gate requires tests/evidence listed below.

### E0 — Phase 0 preservation and baseline

**Goal:** Freeze the V1 contract and establish a regression baseline before refactoring.

**Scope:** Inventory current CommerceService/Pi/channel/database boundaries; capture V1 lifecycle and authority invariants; retain Golden flow, duplicate inbound, acceptance, quotation-send reconciliation, stock-posting, staff-forgery, and adapter tests; add V2 feature flags/observability plan without changing behavior.

**Dependencies:** None.

**Acceptance gate:** Architecture review has a written PASS target; baseline tests/evidence are reproducible; no V1 normative file is weakened; rollback flag is defined.

### E1 — Domain decomposition seams

**Goal:** Split the monolithic service into explicit modular boundaries without a semantic rewrite.

**Scope:** ConversationService, WorkItemService seam, OrderDraftService seam, OrderValidationService, QuotationService, Acceptance/CommitmentService, SalesOrderDraftService, StaffCommitService, and the sole OutboundMessageService; typed contracts and adapters over existing behavior. Authority precedence, one-writer migration, queue/lease, and outbound ownership are fixed before implementation.

**Dependencies:** E0.

**Acceptance gate:** Existing V1 behavior passes unchanged through seams; staff actions remain separate; no provider payload or model truth crosses the domain boundary.

### E2 — First-class OrderDraft and revision workspace

**Goal:** Replace pending-order JSON as the business workspace.

**Scope:** Draft/line/revision model, optimistic concurrency, idempotent workspace actions, create/reuse/add/change/remove/delivery/validate/requote, migration compatibility and source references.

**Dependencies:** E1.

**Acceptance gate:** Every required workspace action produces immutable revision evidence; stale and duplicate actions fail/replay safely; quote and SO snapshots remain immutable.

### E3 — WorkItem, memory, and context

**Goal:** Make long-lived customer goals and bounded context first-class.

**Scope:** `SALES_ORDER_REQUEST` WorkItem lifecycle; canonical transcript projection; bounded summary with source refs; AgentContextBuilder; active quote/SO/draft/evidence/policy projection; context redaction and size limits.

**Dependencies:** E1, E2.

**Acceptance gate:** Multi-turn resume works; summaries cannot mutate truth; context contains current revision and excludes secrets/private authority; concurrent/reordered messages are deterministic.

### E4 — Capability/Tool Registry

**Goal:** Expose business capabilities with server-side permissions and structured results.

**Scope:** Registry metadata, schemas, profile authorization, scope/revision/idempotency checks, structured result contracts, initial customer/history/draft/validation/quotation/status/handoff capabilities, forbidden capability tests, and `ResponseGroundingGuard`/`GroundedResponsePlan` contracts.

**Dependencies:** E1, E2, E3.

**Acceptance gate:** Unknown/forbidden/SQL/post/confirm/DO actions are rejected server-side; deterministic evidence is returned; no customer-facing English is required from domain result contracts.

### E5 — True Pi DigitalEmployeeRuntime loop

**Goal:** Make Pi the real state-aware agent runtime.

**Scope:** Persistent/resumable turn coordinator; monotonic inbox/lease/watermark; observe → choose → execute → observe loop; EmployeeProfile; provisional budgets, timeouts, cancellation, replay/idempotency, failure modes; grounded final response contract.

**Dependencies:** E3, E4.

**Acceptance gate:** A deterministic scenario completes a multi-step order goal through multiple capability calls and produces a grounded state-aware reply; loop cannot run away or mutate beyond Draft.

### E6 — DemoTextToolBridge and transport parity

**Goal:** Support Browser Demo text-only policy with the same agent semantics.

**Scope:** Versioned v1 envelope/correlation/sequence/replay rules; strict one-action/plain-text JSON protocol; validation, one same-id bounded repair policy, result feedback loop, native/private transport adapter, token redaction, and host semantic-oracle traces.

**Dependencies:** E4, E5.

**Acceptance gate:** Native and Demo modes pass the same semantic corpus; malformed, multi-action, markdown, unknown-action, and injection outputs fail closed; bridge cannot bypass Pi or domain guards.

### E7 — Natural response and state-aware conversation

**Goal:** Remove giant hardcoded customer-facing conversation branches.

**Scope:** Grounded response generation, concise tone, clarification/handoff templates only as safe fallbacks, status/history/thanks/greeting/change responses from context and structured results.

**Dependencies:** E5, E6.

**Acceptance gate:** Required corpus has state-appropriate responses with no dozen-intent expansion or guessed facts; raw JSON/private reasoning is absent from primary UX.

### E8 — CommitmentGuard hardening

**Goal:** Preserve explicit commitment evidence while enabling semantic assistance.

**Scope:** Original inbound evidence, canonical active quote lookup, ordering/reply/forwarding/expiry/supersession/unresolved-send checks, explicitness policy, deterministic ACCEPT/REJECT/CANCEL/CHANGE matrix, conflicting-language safety, and exactly-once accepted quote → Draft SO.

**Dependencies:** E1, E4, E5, E7.

**Acceptance gate:** Explicit `OK confirm` succeeds only when eligible; vague yes, stale/forwarded/old/superseded acceptance, prompt injection, and model-only acceptance do not mutate state; no post/confirm/DO action exists.

### E9 — Outbound reliability and recovery

**Goal:** Retain and extend V1 send safety across agent replies.

**Scope:** Preserve quote durable intent/submission/finalization/reconciliation; bring safe clarification/handoff outbound under durable tracking where appropriate; provider reconnect and duplicate recovery.

**Dependencies:** E1, E5, E8.

**Acceptance gate:** Crash-before-send, after-submit-before-finalize, UNKNOWN, not-found retry, concurrent replacement/acceptance, duplicate inbound, and provider reconnect tests remain green.

### E10 — Observability and UI

**Goal:** Make agent behavior inspectable without exposing chain-of-thought.

**Scope:** Runtime timeline, structured action/result summaries, work item/draft revision views, budgets/errors/handoff, transport mode, redaction, staff boundary indicators.

**Dependencies:** E3, E5, E7, E9.

**Acceptance gate:** UI shows receive/context/action/tool/result/reply/handoff summaries and evidence refs; no raw hidden reasoning, secrets, or raw JSON primary UX.

### E11 — Incremental migration and rollback

**Goal:** Strangle V1 capability by capability.

**Scope:** Explicit `V1_ONLY → SHADOW_IMPORT → V2_CANARY → V2_PRIMARY → LEGACY_RETIRED` one-writer state machine, field ownership, stable backfill hash/idempotency/authority marker, mismatch quarantine, per-capability cutover, rollback projection, and legacy pending JSON retirement criteria. Shadow never writes overlapping facts.

**Dependencies:** E2–E10.

**Acceptance gate:** Each cutover has comparison evidence and rollback drill; no big-bang switch; V1 is retained until V2 exit gates pass.

### E12 — Full real WhatsApp evaluation

**Goal:** Prove the provider-neutral employee on the real QR demo and prepare Meta migration evidence.

**Scope:** QR reconnect/duplicate/media/unknown sender cases, full Golden flow through Draft SO only, smoke validation against the already-provisioned Browser Demo project/origin and real Demo GPT registration, provider-neutral adapter contract, and documented Meta seam. Registration is available infrastructure, not a V2 implementation task.

**Dependencies:** E6, E8, E9, E10, E11.

**Acceptance gate:** Deterministic suite and approved manual/live evidence pass; no provider payload leaks into domain; AI stops at Draft; unresolved external gateway/QR checks are recorded rather than bypassed.
