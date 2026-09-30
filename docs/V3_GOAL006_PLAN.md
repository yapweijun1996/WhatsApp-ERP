# V3-GOAL-006 Owner Gate & Implementation Plan

Status: **OWNER APPROVED — GOAL006=A; IMPLEMENTED AND ACCEPTED SHADOW-ONLY**
Date: 2026-09-14 (Asia/Singapore)

## Purpose

Close the Phase 3 Goal Graph and durable-continuation gate using executable shadow-only evidence. GOAL-006 does not create a new runtime, provider path, outbound owner, commerce authority, or production route. It proves that GOAL-001..005 work together correctly under concurrent obligations, interruption, restart, and structural no-empty-promise conditions.

## Dependencies already accepted

- GOAL-001 ConversationGoal contract and lifecycle.
- GOAL-002 append-only goal events/edges.
- GOAL-003 Agent proposal + Host admission with lifecycle/revision fencing.
- GOAL-004 durable continuation contract.
- GOAL-005 wake/deadline/handoff processing with durable reservation, budget accounting, reserve-to-bind freshness/lifecycle/lease revalidation.
- CP-006 stale-plan abort/rebuild/replan and reconciliation semantics.
- CP-007 control-plane gate including stale/newer-input/lease races.

## Authorized implementation option

### A — Recommended: shadow-only Goal Graph gate closure

Authorize only GOAL-006 tests, fixtures, gate harness/projection code if strictly required, and review documentation. Reuse existing GOAL/continuation/control-plane contracts. No new customer-visible path. No new outbound/provider owner. No production/canary/deployment wiring. No authority beyond `SALES_ORDER.DRAFT`. Any schema change requires a separate explicit owner approval; the default GOAL-006 plan assumes **no schema change**.

### B — Tests-only closure

Authorize only new deterministic tests and documentation using current code, with no source additions even if a narrow reusable gate helper would improve clarity.

### C — Broader shadow integration

Authorize disabled/shadow orchestration wiring in addition to gate tests. **Not recommended for GOAL-006** because Phase 8 ORCH owns runtime integration.

### D — Hold

Keep GOAL-006 unopened. No implementation or test changes.

**Owner selection: A — approved.**

## Exact acceptance matrix

### G8 — Open obligation continuation

Fixture: an active goal has legitimate durable work and a valid continuation; a later non-substantive inbound arrives while the obligation is still open.

Prove:
- the active goal remains present and source-linked;
- the continuation remains the durable source of resumability;
- stale reasoning is invalidated/replanned through existing CP behavior;
- no second empty acknowledgement is required to represent progress;
- unrelated goals are preserved.

### G9 — Structural no-empty-promise boundary

GOAL-006 proves only the **Goal Graph/continuation side** of the rule: `STILL_IN_PROGRESS` / `WAITING_EXTERNAL` cannot be considered structurally valid unless they reference durable resumable work with bounded owner/budget/wake-or-handoff/freshness evidence.

It must not claim the later Phase 7 Fulfillment Gate is implemented. Full model-response wording/release enforcement remains owned by `V3-FUL-006/007`.

### G15 — Concurrent Goal Graph

Create at least four simultaneous obligations matching the architecture example: order edit, quotation request, historical-document question, delivery clarification.

Prove:
- each goal retains independent identity, status and provenance;
- complete/supersede/cancel of one goal cannot erase or mutate unrelated goals;
- dependency/parent/related edges remain explicit;
- stale revision writes lose deterministically;
- restart reconstructs the same active-goal set;
- concurrent independent SQLite writers cannot produce duplicate revisions or silent goal loss.

### G22 — Durable continuation / no promise loophole

Prove both `WAITING_EXTERNAL` and `STILL_IN_PROGRESS` cases require a valid GOAL-004 continuation and that GOAL-005 wake/deadline/handoff processing produces a bounded next disposition.

Negative cases must include:
- missing continuation;
- wrong goal/work/account/conversation binding;
- stale freshness;
- terminal/superseded goal after continuation creation;
- exhausted attempt budget/deadline;
- expired/stolen lease generation;
- malformed/accessor/extra-field inputs;
- raw persistence bypass attempts.

## Interruption and concurrency cases

1. New inbound arrives after plan snapshot but before any effect admission: old plan aborts/rebuilds; no stale effect begins.
2. One goal is superseded while another remains active: only the affected branch changes.
3. A continuation reserves a wake while a goal becomes terminal: bind fails closed.
4. Freshness changes after wake reservation: bind fails closed.
5. Lease owner/generation changes after reservation: bind fails closed.
6. Restart with reserved-but-unbound continuation: exact event resumes same attempt, not a new budget slot.
7. Same Host event races on independent SQLite connections: one durable reservation/bind identity.
8. Distinct Host events race for final budget slot: at most one winner.

## Proposed implementation surfaces

Preferred order:

1. `tests/v3-goal-gate.test.ts` — primary G8/G9/G15/G22 gate corpus.
2. Reuse existing fixtures/helpers from GOAL-001..005 and CP-006/007 where safe; do not fork authority logic.
3. Add a narrow `src/v3-goal-gate.ts` only if tests demonstrate a missing pure shadow projection/validation seam. It must remain non-authoritative and side-effect free.
4. `docs/V3_GOAL006_REVIEW.md` — evidence, commands, findings and final boundaries.
5. Update `docs/V3_TASKS.md` only after executable evidence and independent acceptance.

Default expectation: **tests + review docs should be sufficient; production/runtime source changes are not assumed.**

## Mandatory verification

- focused GOAL-006 gate corpus PASS;
- combined GOAL-001..006 regression PASS;
- relevant CP-006/007 regression PASS;
- restart and independent-connection concurrency cases PASS;
- `npm run typecheck` PASS;
- `npm run build` PASS;
- `git diff --check` PASS;
- static scan confirms direct `adapter.send(...)` remains owned only by `src/outbound-message-service.ts`;
- static scan confirms no GOAL-006 runtime/customer wiring;
- independent read-only acceptance review returns **P0=0 / P1=0**.

## P0/P1 review focus

P0 blockers include authority widening, customer-visible runtime wiring, new provider/outbound owner, post-DRAFT AI authority, cross-scope data exposure, or stale worker effects.

P1 blockers include silent loss of concurrent goals, invalid continuation accepted as resumable work, lifecycle/freshness/lease race gaps, duplicate wake/budget consumption, restart divergence, raw-write bypass, or tests that prove only sequential behavior where concurrency is required.

## Explicitly not authorized by GOAL-006

- runtime/customer traffic;
- canary or release;
- deployment;
- V3 promotion to SSOT;
- new provider-send/outbound ownership;
- new commerce authority;
- Sales Order progression beyond `SALES_ORDER.DRAFT`;
- Delivery Order creation/progression;
- Phase 4 retrieval implementation;
- Phase 7 Fulfillment Gate implementation;
- Phase 8 orchestration/runtime integration.

## Completion definition

GOAL-006 is complete only when G8/G9/G15/G22 executable evidence passes, concurrent/restart interruption cases pass, no authority boundary widens, and an independent read-only reviewer reports P0=0/P1=0. Completion closes **Phase 3 only**; V3 remains PROPOSED and shadow-only.
