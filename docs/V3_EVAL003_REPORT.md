# V3-EVAL-003 Benchmark Report

Status: **ACCEPTED COMPLETE — SHADOW-ONLY / PROPOSED**

## Scope and reuse

EVAL-003 is a reproducible evidence index over the accepted RET-008 evaluator. It adds no production logic, schema/provider/customer-runtime wiring, deployment, outbound owner, or authority. The AI cutoff remains `SALES_ORDER.DRAFT`; V3 remains disabled and shadow-only.

- Harness: `tests/v3-eval-003.test.ts`
- Frozen source evaluator: `tests/v3-ret-008-evaluator.test.ts`
- Corpus: seed `20260919`, **10,240 raw messages**, bounded **1,000-source active index**
- Exact-child proof: each EVAL-003 case requires one selected child, one pass, and zero failures

## Declared budgets and deterministic degradation

The benchmark reuses the RET-008/RET-006 Host budgets:

| Budget | Declared limit |
|---|---:|
| Index build | < 5,000 ms |
| Search p95 | < 1,500 ms |
| Source open | < 250 ms |
| Retrieval loop | < 250 ms |
| Retrieval steps / tool calls | 8 / 8 |
| Evidence items / candidates | 8 / 50 |
| Evidence bytes / read bytes | 20,000 / 100,000 |
| Evidence-token units | 4,000 conservative UTF-8-byte units |
| Consecutive no-new-evidence | 2 |

When evidence is insufficient or a Host budget is exhausted, RET-006 deterministically returns `ABSTAIN` with a bounded stop reason (`MAX_STEPS`, `NO_NEW_EVIDENCE`, or a specific byte/token/time budget). EVAL-003 directly runs the frozen `G16` no-new-evidence/max-step oracle; it does not introduce a second degradation implementation.

## Verification

Command: `node --test --import tsx tests/v3-eval-003.test.ts`

- **2/2 PASS**
- benchmark child: exact RET-008 G13 selected and passed
- degradation child: exact RET-008 G16 selected and passed

Required direct oracles:

Commands: `node --test --import tsx --test-name-pattern='^RET-008 G13 benchmark freezes reproducible performance and budget evidence$' tests/v3-ret-008-evaluator.test.ts` and `node --test --import tsx --test-name-pattern='^RET-008 G16 retrieval budget ends in bounded abstention$' tests/v3-ret-008-evaluator.test.ts`

- **2/2 PASS**
- measured benchmark: fixture/index build **201.217 ms**, search p95 **892.421 ms**, source open **139.761 ms**, retrieval loop **164.847 ms**
- observed Host retrieval-loop evidence-token charge: **1,267 conservative UTF-8-byte units**, positive and within the declared **4,000-unit** maximum. This is Host-side deterministic evidence accounting used for the retrieval budget; it is not provider billing usage and is not a provider tokenizer-token count. Provider calls are intentionally excluded from shadow deterministic EVAL-003.
- measured corpus: **10,240** raw messages and **1,000** indexed source IDs

Also run: `npm run typecheck` — **PASS**.

Scoped diff check: `git diff --check -- tests/v3-eval-003.test.ts docs/V3_EVAL003_REPORT.md docs/V3_TASKS.md` — **PASS**.

## Backlog and exclusions

- **P2:** RET-008’s bounded source freshness/provenance validation remains a future optimization opportunity; its measured p95 is within the frozen budget.
- Independent final read-only review job `89651ce4-d5ac-4593-95cf-711ba4c58689`: **PASS** under a PASS-only-if-P0=0/P1=0 contract; therefore P0=0 and P1=0. Provider billing-token measurement remains outside this deterministic shadow retrieval-budget contract.
- No full, broad, browser, release, audit, deploy, commit, or push operation was run.
