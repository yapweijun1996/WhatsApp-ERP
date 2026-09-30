# V3-GOAL-004 Review — Shadow-Only Durable Continuation Records

Status: **PASS — ACCEPTED COMPLETE; SHADOW-ONLY**
Date: 2026-09-14 (Asia/Singapore)

V3-GOAL-004 is accepted complete for the authorized shadow-only scope. It adds `src/v3-durable-continuation.ts` plus the additive guarded `durable_continuations` persistence surface for `STILL_IN_PROGRESS` and `WAITING_EXTERNAL`. It does **not** implement GOAL-005 wake/resume/deadline processing, runtime/customer wiring, response release, canary/release, or new commerce/outbound authority.

The continuation contract is exact/closed and scope-bound. A record binds continuation/work-item/goal/account/conversation identity, disposition, owner, state, Host-governed resume trigger/condition reference, nullable eligibility/deadline, expected freshness-vector reference, evidence/effect refs, bounded attempt/budget state, idempotency identity, and timestamps. Returned arrays and nested budget state are detached/frozen; hidden/Symbol/accessor/custom/sparse inputs fail closed without getter invocation.

`WAITING_EXTERNAL` requires durable `WAITING` state. `STILL_IN_PROGRESS` requires durable `READY` or `RUNNING` state. `MANUAL_HANDOFF` requires a human owner. `nextEligibleAt` and `deadlineAt` remain nullable as required by the architecture; when a deadline exists, record and budget deadlines must match and ordering is bounded. Attempt/budget exhaustion fails closed.

Resume-condition ownership is separated from the record: creation requires an exact Host condition envelope carrying account/conversation scope, trigger and condition. The stored `resumeConditionRef` is an opaque SHA-256 reference derived from canonical Host-envelope content; it does not embed reversible condition content. The record alone cannot satisfy creation.

For a new write, the supplied V3 freshness vector is integrity-validated and re-derived against current database state inside the same `runImmediate` transaction. The DB adapter verifies conversation/account/channel/customer identity and employee-profile version and derives the authoritative V2 freshness fingerprint. The current vector hash and persisted freshness reference must match exactly before work-item, Goal Graph and evidence/effect provenance checks and insertion. Exact replay is resolved first and remains stable even if live state later changes; partial/chimera identities fail closed.

The Host also requires an active exact-scope work item owned by the canonical conversation customer and a current Goal Graph goal compatible with the requested disposition. Evidence and effect refs use explicit typed references and require exact scoped durable provenance. The table is guarded against raw insertion and direct update/delete, carries conversation/work-item foreign keys, content hash and idempotency uniqueness, and supports file-backed restart readback.

## Final acceptance evidence

- Independent final review: **PASS; P0=0, P1=0**.
- GOAL-004 focused tests: **11/11 PASS**.
- GOAL-001/002/003/004 combined focused tests: **43/43 PASS**.
- Full regression: **617/617 PASS**.
- `npm run typecheck`: **PASS**.
- `npm run build`: **PASS**.
- `git diff --check`: **PASS**.
- Direct `adapter.send(...)`: exactly **3**, all in `src/outbound-message-service.ts`.
- GOAL-004 runtime/customer wiring scan: **none**.
- AI cutoff remains exactly `SALES_ORDER.DRAFT`.
- No customer-language keyword intent logic was introduced.
- GOAL-005 and GOAL-006 remain unopened and separately owner-gated.

Remediation history: the first independent review returned P0=0/P1=8, covering work-item binding, freshness, evidence/effect provenance, Host-owned condition, budget coherence and missing adversarial/restart/replay coverage. A later review isolated three remaining issues: nullable deadline semantics, separate Host condition proof and DB-current freshness validation. All were remediated and revalidated on the final snapshot before the independent P0=0/P1=0 acceptance review.

V3 remains **PROPOSED** and shadow-only. GOAL-004 acceptance does not authorize GOAL-005+, runtime/customer traffic, canary/release, V3 promotion, deployment, a new outbound owner, or authority beyond `SALES_ORDER.DRAFT`.
