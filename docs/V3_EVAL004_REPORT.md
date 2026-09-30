# V3-EVAL-004 — Final Regression Gate Report

Status: **ACCEPTED COMPLETE — Goal-First Fast Track; shadow-only; V3 remains PROPOSED**
Date: 2026-09-20
Strategy: Goal-First Fast Track

## Scope

Run the Phase 8 final V1/V2 regression/typecheck/build/browser/audit/static-authority gate while V3 remains customer-disabled, and separately exercise the deterministic V3 evaluation seam. This task does not authorize deployment, provider/customer traffic, schema migration execution, rollout, V3 promotion, a second outbound owner, or authority beyond `SALES_ORDER.DRAFT`.

## Why a broad run was used

V3-EVAL-004 itself is the explicit full-regression gate. The broad suite was run once. A later failure in the first static scan was diagnosed as a scan false positive caused by a negative test fixture containing the literal `SALES_ORDER.POSTED`; only the affected static authority scan was corrected and rerun. The broad suite was not repeated.

## Evidence

### Full current regression — one run

`npm test`

- tests: **926**
- pass: **926**
- fail: **0**
- duration: **80.539 s**

This single suite contains the current V1/V2 regression coverage plus deterministic V3 module/corpus tests. Runtime/customer V3 is still not enabled; V3-MIG-001 has not been implemented.

### Deterministic V3 test-mode slice

`NODE_ENV=test node --test --test-concurrency=1 --import tsx tests/v3-orch-003.test.ts tests/v3-eval-001.test.ts tests/v3-eval-002.test.ts tests/v3-eval-003.test.ts`

- tests: **35**
- pass: **35**
- fail: **0**
- Includes G1-G23, the seven adversarial EVAL-002 cases, EVAL-003 benchmark/degradation, and ORCH-003 goal/freshness behavior.

Explicit mode proof is provided by `tests/v3-eval-004.test.ts`: disabled mode reads `runtimeTelemetry()` and proves current runtime is `V1`, V2/customer traffic is disabled, and the cutoff is `SALES_ORDER.DRAFT`; enabled mode invokes the deterministic V3 orchestrator gate directly and proves the same cutoff. The ORCH-003 disabled-seam test is also strengthened to read runtime telemetry instead of using tautological literals.

The phrase “V3 enabled in deterministic test mode” here means V3 logic is invoked directly by deterministic test harnesses. It does **not** mean customer/runtime V3 routing is enabled; that capability is intentionally deferred to V3-MIG-001.

### Compiler/build/audit/diff

- `npm run typecheck`: **PASS**
- `npm run build`: **PASS**
- `npm audit --offline`: **PASS — 0 vulnerabilities**
- `git diff --check`: **PASS**

### Browser gate

`NODE_ENV=test V2_EVAL_002_SURFACE=1 npx playwright test tests/e2e/v2-eval-002.spec.ts tests/e2e/golden.spec.ts --project=chromium`

- **2/2 PASS**
- Browser surface still reports/preserves the existing AI/staff cutoff and V1/V2 safety contract.

### Static authority/effect gate

Corrected production-only scan:

- direct provider `adapter.send(...)` owner: **only `src/outbound-message-service.ts`**
- forbidden model capability names still include `post_sales_order`, `confirm_sales_order`, `create_delivery_order`
- production V3 unsafe cutoff scan for `SALES_ORDER.POSTED`/`SALES_ORDER.CONFIRMED`: **no unsafe V3 cutoff literal found**
- production V3 contracts continue to expose exact `SALES_ORDER.DRAFT` cutoff

The first static command included `tests/` and therefore matched the intentional negative fixture in `tests/v3-conversation-goal.test.ts` that asserts `SALES_ORDER.POSTED` is rejected. This was a validation-script false positive, not a product failure; only that static scan was narrowed to production source and rerun.

## Result before independent review

- Product/regression blocker: **P0=0 observed**
- Known acceptance blocker: **none observed**
- Non-critical hardening: leave existing P1/P2 backlog unchanged unless independent review identifies an acceptance blocker.
- V3 remains **PROPOSED / customer-disabled**.
- AI authority remains capped exactly at **`SALES_ORDER.DRAFT`**.
- No customer/runtime deployment or provider-backed action was performed.

## Independent review

Initial Claude read-only review job `d3097983-c620-411b-8ab5-ef7058402eb8` found **P0=0, P1=1, P2=1**. The P1 was evidence integrity: the report had attributed disabled-seam proof to a tautological ORCH-003 test. The claim and test were remediated with runtime-derived evidence. P2 (browser safety object is a hardcoded literal rather than derived from runtime telemetry) remains backlog because it does not weaken current runtime authority.

Final independent Claude read-only rereview job `a5bb28b4-6e0e-409c-8c26-e11512d8f532` returned **PASS — P0=0, P1=0, P2=1**. It confirmed the disabled seam now calls production `runtimeTelemetry()`, the exact `SALES_ORDER.DRAFT` cutoff is preserved cross-module, the production-only static scan correction is valid, and V3 remains customer-disabled. Therefore V3-EVAL-004 is accepted complete. No broad suite was repeated for this closure; only the independent rereview and documentation/diff verification were performed.
