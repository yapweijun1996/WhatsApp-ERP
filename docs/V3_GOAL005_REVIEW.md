# V3-GOAL-005 Review — Shadow-Only Continuation Wake/Resume Processing

Status: **ACCEPTED COMPLETE — authorized shadow-only scope**
Date: 2026-09-14 (Asia/Singapore)

V3-GOAL-005 is accepted complete only for its authorized shadow-only engineering scope. `src/v3-continuation-processing.ts` consumes immutable GOAL-004 continuation records, validates exact scoped Host wake inputs, re-verifies DB-current freshness/context, and reuses the existing V2 durable queue lease as the sole lease authority. It is not wired into runtime/customer traffic and adds no provider-send owner, commerce authority, canary/release path, deployment authority, V3 promotion, or authority beyond `SALES_ORDER.DRAFT`.

## Final acceptance result

Fresh independent read-only acceptance review on 2026-09-14 returned a verified **PASS**. The review contract permitted PASS only with **P0=0 and P1=0**. The first Pi review attempt was operationally unverified because it did not return a validated structured result; it was not counted as acceptance evidence. A fresh independent Codex read-only review then completed with validated PASS.

The final tranche specifically closes the reserve → lease-bind TOCTOU window. `v3WakeBindLease()` executes under the existing `BEGIN IMMEDIATE` write fence and, before appending `LEASE_BOUND`, re-checks the reserved attempt, current continuation/Goal lifecycle, exact account/conversation scope, validated bundle/context/freshness, DB-rebuilt freshness, and current V2 lease owner/generation/fencing state. Any changed or invalid state fails closed without a bound receipt.

Three deterministic adversarial tests prove state changes after reservation but before bind are rejected:

- Goal becomes terminal after reservation → `STALE`, zero `LEASE_BOUND` rows;
- freshness dependency changes after reservation → `STALE`, zero `LEASE_BOUND` rows;
- lease owner/generation changes after reservation → `STALE`, zero `LEASE_BOUND` rows.

## Durable wake / budget / lifecycle properties

- true Host `DEADLINE` wakes are bounded non-effect handling only: they require the persisted deadline to have elapsed and never acquire a reasoning lease;
- current-state freshness is re-derived from the database before reservation and again inside lease binding;
- immutable GOAL-004 `attempt` / `budgetState.consumed` forms the base for durable reservation accounting;
- bounded Host-owned `wakeEventId` provides occurrence identity while exact replay remains idempotent;
- the guarded append-only `v3_continuation_wake_events` ledger reserves one attempt per distinct Host event;
- a reserved-but-unbound event may retry the same reservation after lease contention, but a bound event cannot reacquire a later generation;
- current Goal states `FULFILLED`, `SUPERSEDED`, and `CANCELLED` fail closed before new reservation, and lifecycle is rechecked again at bind;
- raw insert/update/delete bypass of the wake ledger is guarded; foreign scope fails closed;
- restart tests preserve duplicate identity, bound generation fencing, and an unbound final reservation without consuming an extra budget slot;
- concurrent SQLite tests prove the same Host event reserves once and two distinct events racing for the last budget slot produce one winner.

Historical pre-remediation evidence showed the prior defect: repeated expired-lease processing could reacquire later generations for the same logical wake, and an obsolete terminal continuation could be re-woken. That behavior is not the accepted implementation. The durable receipt/budget fence plus lifecycle and bind-time revalidation close those P1s.

## Verification evidence

Fresh post-remediation verification on the accepted working tree:

- GOAL-005 + GOAL-004 + CP-003 combined: **40/40 PASS**;
- GOAL-005 includes **18 passing tests**, including the three post-reservation adversarial bind tests;
- `npm run typecheck`: **PASS**;
- `npm run build`: **PASS**;
- `git diff --check`: **PASS**;
- direct `adapter.send(...)` owner scan: only `src/outbound-message-service.ts`;
- no production/runtime caller of `V3ContinuationProcessor` / `processV3ContinuationWake` was found outside the GOAL-005 module;
- independent read-only reviewer: **validated PASS; P0=0/P1=0 by review contract**.

A full repository regression was not rerun in this selected acceptance tranche. Earlier phases retain their existing full-regression evidence; this GOAL-005 acceptance is based on the focused dependency slice, adversarial concurrency/restart coverage, static authority checks, typecheck/build/diff checks, and independent review.

## Authority boundary after acceptance

Acceptance does **not** authorize runtime/customer traffic, canary/release, production deployment, V3 promotion, a new outbound owner, provider-side effects, or any AI authority beyond `SALES_ORDER.DRAFT`. `V2QueueService` remains the sole durable lease authority and `OutboundMessageService` remains the sole provider-send owner. `CONVERSATION_INTELLIGENCE_V3.md` remains `PROPOSED`.

V3-GOAL-006 remains **UNOPENED** and separately owner-gated. Phase 3 accepted progress is **5/6**.
