# V3 CP-007 Review — Control Plane Gate Closure

Status: **PASS — P0=0 / P1=0; shadow-only**
Date: 2026-09-14 (Asia/Singapore)

## Scope and evidence

CP-007 closes only the control-plane gate. `tests/v3-cp-007-gate.test.ts` contains **5/5 passing tests** and does not add runtime wiring, schema, provider, commerce, or outbound ownership.

| Golden criterion | Executable evidence | Result |
|---|---|---|
| G2 interrupted burst / stale-plan fence | Enqueues opaque newer evidence after the old lease is projected; CP-004 admission throws `NEWER_INPUT_QUEUED`, the old item is `SUPERSEDED`, `side_effect_started=0`, and CP-006 returns `ABORT_REBUNDLE_REBUILD_REPLAN`. | PASS |
| G18 atomic admission TOCTOU | Uses two independent SQLite connections and tests both orderings: newer inbound first causes zero old effect; admission first sets the effect-start CAS and later inbound remains post-effect input. | PASS |
| G19 fenced lease crash / resume | Admits once before the simulated crash, closes the database, reacquires generation 2, observes durable `sideEffectStarted=true`, and runs CP-006 recovery first. Recovery is `RECONCILE_REQUIRED` with `mayProviderAttempt=false`; the old proof is fenced, a repeat admission under generation 2 is rejected, and the final started-effect count is exactly 1. | PASS |
| G20 non-message freshness invalidation | Changes customer canonical freshness with no new inbound; the Host-derived projection reports stale, `assertV3PlanContextCurrent` rejects, and the effect remains unstarted. | PASS |
| bounded multi-connection stress | **12 iterations** each exercise crash/expiry/reacquire, a two-independent-connection claim race, and the existing `v3-side-effect-admission-race-worker.ts` admission-vs-newer race. Each admission race is asserted to linearize as exactly one admitted effect with one started bit, or mutation-first with a superseded item and zero effect; no duplicate admission or stale unreserved effect is accepted. | PASS |

The test inputs use opaque evidence text. No customer-language keyword or regex interpretation participates in any gate assertion. The direct CP-007 G20 example changes canonical customer freshness with no new inbound and asserts the plan is stale before admission; it is not a substitute for the dependency-class evidence below.

## G20 mandatory dependency map

| Mandatory dependency class | Reused executable evidence | Coverage boundary |
|---|---|---|
| Identity / scope | `tests/v3-freshness-vector.test.ts` DB-derived channel-account and customer mismatch rejection; `tests/v3-cp-005-invalidation.test.ts` event scope rejection | Host-derived scope and fail-closed scope validation; no new CP-007 identity implementation. |
| Employee profile | `tests/v3-freshness-vector.test.ts` exact profile-version/DB identity checks; CP-005 profile mutation case | Profile freshness invalidates; employee lifecycle remains V2-owned. |
| Capability policy | `tests/v3-cp-005-invalidation.test.ts` individual `capabilityPolicy` change; CP-004 admission checks capability authority | Policy invalidation and admission authority are covered; CP-007 adds no policy owner. |
| Goal Graph | `tests/v3-cp-005-invalidation.test.ts` version/dependency change and no-new-inbound assertion | Direct non-message invalidation coverage. |
| Canonical business / quote / outbound / draft / work-item | `tests/v3-freshness-vector.test.ts` constructs and validates canonical quotation, outbound, work-item/order-draft references; `tests/v3-context-budget.test.ts` preserves quotation, draft, work-item and sales-order context fields | These tests establish detached vector/context representation and authority parity. CP-005 has no fabricated per-field mutation claim where its fixture leaves canonical business empty. |
| Relevant ERP evidence | `tests/v3-cp-005-invalidation.test.ts` relevant ERP evidence mutation; `tests/v3-freshness-vector.test.ts` relevant price/stock DB freshness and unrelated-data control | Relevant ERP evidence is invalidating; unrelated evidence remains a negative control. |
| Attachment extraction | `tests/v3-cp-005-invalidation.test.ts` individual extraction-version/dependency mutation | Versioned extraction dependency only; no attachment parser is added. |
| Retention / access | `tests/v3-cp-005-invalidation.test.ts` individual retention/access mutation and malformed/scope rejection | Retention/access freshness is invalidating; no new retention authority is introduced. |

The direct CP-007 G20 test is therefore the no-new-inbound canonical-business freshness gate, while the mandatory class assertions are reused CP-005/CTX-005 executable evidence rather than claimed as new CP-007 coverage.

## Verification

Fresh bounded re-verification on 2026-09-14 after gate closure: focused Control Plane/V2 queue/outbound suite **93/93 PASS**; full regression **574/574 PASS**; typecheck, build, and `git diff --check` **PASS**.


- Focused CP/V2 queue/outbound/control-plane run: **10/10 test files pass** (`v2-queue`, `v2-out-001..003`, CP-001, CP-003, CP-004, CP-005, CP-006, CP-007); CP-007 is **5/5 tests PASS**, including 12 stress iterations.
- `npm run typecheck`: **PASS**.
- `npm run build`: **PASS**.
- `npm test`: **59/59 test files pass**.
- `git diff --check`: **PASS**.
- `adapter.send(...)`: **3 occurrences, all in `src/outbound-message-service.ts`**, the sole direct adapter-send owner.
- Lifecycle scan retains the `SALES_ORDER.DRAFT` cutoff and staff-only POST/CONFIRM Sales Order / Delivery Order progression; no V3 capability or lifecycle path was added.
- V3 source authority scan: no customer-language keyword/regex intent logic.

## Adversarial self-review

Remediation history: the verified P1 G19 gap was closed by changing the executable scenario from pre-admission lease reacquisition to post-admission crash/resume. It now proves durable `UNKNOWN` recovery before any resumed admission attempt, old-generation fencing, resumed `sideEffectStarted`, repeat-admission rejection, and exactly one started effect. The stress weakness was closed by increasing the bounded run from 6 to 12 iterations and adding the existing admission-vs-newer worker race with explicit linearization assertions. The Phase 1 gate wording was corrected to match the completed Phase 2 gate.

P0 findings: **0**. P1 findings: **0**.

The evidence is intentionally bounded: it proves the V2 serialized admission fence, durable generation fencing, and non-message freshness rejection through shadow projections, but it does not claim provider delivery, customer-visible V3 behavior, schema durability for new V3 records, or distributed database behavior beyond the independent SQLite connections exercised here. CP-007 does not authorize Phase 3, runtime integration, canary, deployment, V3 promotion, or authority beyond `SALES_ORDER.DRAFT`. `CONVERSATION_INTELLIGENCE_V3.md` remains **PROPOSED**.
