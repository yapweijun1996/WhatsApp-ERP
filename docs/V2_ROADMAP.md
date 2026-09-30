# V2 Roadmap — Dependency-Ordered Delivery

Status: **IMPLEMENTATION AUTHORIZED / PHASE 0 PASS / PHASE 1A PASS / PHASE 1B V2-VAL-001 PASS / V2 TRAFFIC DISABLED**

## Governing rule

Astra Review 1 and Review 2 are preserved historical FAILs. Astra Review 3 (`V2_ASTRA_DESIGN_REVIEW_3.md`) is PASS with zero P0/P1 and closes the architecture-review gate. The V1 owner explicitly authorized implementation on 2026-09-08. The V1 executable baseline is green and recorded in `V2_IMPLEMENTATION_BASELINE.md`; Phase 0 may begin under the dependency-ordered strangler plan. No V2 runtime/schema migration task is considered complete until its own evidence gate passes. All authority, state, commitment, queue, grounding, outbound, and migration contracts remain governed by the five documents; later implementation/security review remains a separate release gate.

Phase 1B `V2-VAL-001` is closed PASS as a read-only deterministic ERP validation foundation. Evidence is recorded in `docs/V2_PHASE1B_REVIEW.md` and `docs/V2_PHASE1B_VERIFICATION.md`. Quote preparation, Draft SO creation, runtime, transport, commitment, and rollout remain pending.

## Phase 0 — Preserve and baseline

**Milestone:** V2 architecture package reviewed; V1 evidence captured; Phase 0 preservation/seams implemented.
**Work:** E0; freeze lifecycle, acceptance, staff, evidence, channel, and outbound invariants; record current source seams and test baseline.
**Stop/go:** Architecture review, owner authorization, and the executable V1 regression baseline are PASS. GO to Phase 0 only under the strangler sequence. STOP on any ambiguity or regression in AI cutoff, acceptance, send reconciliation, provider isolation, ERP truth, or staff authority.
**Rollback boundary:** Existing V1 remains the only path. Runtime telemetry is fail-closed and V2 traffic is disabled.

## Phase 1 — Modular seams

**Milestone:** E1 contracts wrap current behavior — **PASS for Phase 0 seam extraction; no workspace/schema implementation.**
**Dependencies:** Phase 0.
**Work:** Extract service boundaries inside the modular monolith; keep CommerceService as compatibility facade while tests prove behavior.
**Stop/go:** **PASS for Phase 0:** typed seams, compatibility delegation, provider-neutral guard, and V1 Golden/negative/reliability tests pass. STOP if semantics or evidence change. Phase 1 remains gated.
**Rollback boundary:** Feature flag routes all traffic to the existing V1 facade.

## Phase 2 — Workspace foundation

**Milestone:** Phase 1A revisioned OrderDraft/WorkItem persistence and safe shadow migration foundation PASS; draft actions, validation, context, and runtime remain pending. Workspace persistence/migration sub-slice is implemented and under independent verification; summary/context work remains pending.
**Dependencies:** Phase 1.
**Work:** E2 and E3; create migration/backfill plan, bounded summary, AgentContextBuilder, concurrency model.
**Stop/go:** GO when shadow projections match V1 state and stale/replay tests pass. STOP if summaries become authoritative or old quotes/SOs can be rewritten.
**Rollback boundary:** Continue reading V1 pending memory and disable new workspace writes.

## Phase 3 — Capabilities and runtime

**Milestone:** E4 and E5; deterministic native-tool loop completes a safe multi-step goal in test mode.
**Dependencies:** Phase 2.
**Work:** Registry, EmployeeProfile, Pi persistent turn loop, budgets, result contracts, replay.
**Stop/go:** GO when forbidden capabilities are rejected server-side and AI cutoff tests pass. STOP on any prompt-only authority or unbounded loop.
**Rollback boundary:** V1 interpreter/CommerceService remains active behind flag; V2 loop can run in shadow mode only.

## Phase 4 — Demo transport and natural conversation

**Milestone:** E6 and E7; native and DemoTextToolBridge semantic parity.
**Dependencies:** Phase 3.
**Work:** Strict text action protocol, malformed-output handling, grounded natural responses, state-aware corpus.
**Stop/go:** GO when both transports pass the complete deterministic corpus and no raw JSON/private reasoning is user-facing. STOP on semantic divergence that affects commitment or truth.
**Rollback boundary:** Disable V2 transport per account/conversation and fall back to V1; preserve all durable records.

## Phase 5 — Commitment and outbound hardening

**Milestone:** E8 and E9; V1 commercial boundary proven under the new runtime.
**Dependencies:** Phase 3 and 4.
**Work:** CommitmentGuard evidence binding, quote/requote/supersession, outbound recovery, concurrent message/replacement tests.
**Stop/go:** GO only when all V1 send/acceptance/staff negatives and injected crash tests pass. STOP on any duplicate SO, acceptance race, blind resend, or post-Draft AI path.
**Rollback boundary:** Route commerce mutations to V1 services while retaining safe read-only V2 context if desired.

## Phase 6 — Observability and controlled migration

**Milestone:** E10 and E11; per-capability strangler rollout.
**Dependencies:** Phases 2–5.
**Work:** Timeline/UI, feature flags, shadow comparison, one capability at a time, rollback drills, legacy JSON retirement criteria.
**Stop/go:** GO per capability when evidence parity and rollback are demonstrated; STOP on unexplained state divergence, missing evidence, or operationally invisible model mode.
**Rollback boundary:** Per-capability flag, then per-conversation/account flag, then global V1 mode.

## Phase 7 — Full real WhatsApp evaluation

**Milestone:** E12; approved V2 evaluation on QR demo and official adapter seam.
**Dependencies:** Phase 6.
**Work:** Real inbound/outbound, reconnect, duplicate/reordered messages, unknown customer, handoff, and full Golden journey through Draft SO only; validate against the already-provisioned Browser Demo project/origin and real Demo GPT. Registration is available infrastructure, not a V2 implementation task.
**Stop/go:** GO for broader rollout only with deterministic suite, browser suite, manual/live evidence, security review, and independent review PASS. Evaluation Lead owns corpus/browser reports; Channel QA owns live QR/Demo evidence; Security/Architecture Reviewer owns the later independent review. STOP on external origin/credential/network blockers; document them without bypassing controls.
**Rollback boundary:** QR/demo account only, then V1 mode; no post-Draft migration is included.

## Release milestones

1. **M0 Architecture/authorization/baseline PASS:** Astra R3 approved the documentation, owner implementation authorization is recorded, and the V1 executable baseline is green; Phase 0 may proceed.
2. **M1 Seams green:** Phase 0 contracts/compatibility seams and runtime telemetry are implemented; no lifecycle change and no workspace/schema implementation.
3. **M2 Agent loop green:** deterministic multi-step, bounded, server-authorized.
4. **M3 Transport parity green:** private/native and Demo text bridge equivalent.
5. **M4 Commitment/reliability green:** V1 acceptance/send guarantees preserved.
6. **M5 Controlled pilot:** feature-flagged, observable, rollback-tested.
7. **M6 V2 evaluation PASS:** full corpus and real-channel evidence; rollout decision.

M0 architecture PASS and the later independent implementation/security review PASS are separate gates.
Pilot defaults and metrics are provisional configuration: alert on grounding failure, duplicate outbound,
UNKNOWN older than 15 minutes, lease expiry, semantic-parity mismatch, or migration mismatch. Pilot targets
are 100% protected-claim grounding, zero unauthorized transitions, zero duplicate quote/SO mutations, and
durable replay evidence for every turn.

## Explicit rollback principles

Rollback never deletes messages, evidence, revisions, quotes, acceptances, SOs, outbound intents, or audit events. It changes routing flags and stops new V2 mutations. A partially completed capability must replay from durable idempotency state or hand off; it must not be retried blindly. Any schema addition must be backward-readable by the V1 path before rollout.
