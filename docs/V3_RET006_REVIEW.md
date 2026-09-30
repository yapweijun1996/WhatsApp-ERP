# V3 RET-006 Review

Status: **ACCEPTED COMPLETE — AUTHORIZED PHASE 4 SHADOW-ONLY SCOPE**

Date: 2026-09-17 (Asia/Singapore)

RET-006 adds a standalone, shadow-only Host-governed retrieval loop over the closed RET-004/RET-005 retrieval surfaces. The model may select an allowlisted retrieval tool and request, while Host code owns immutable scope/version binding, budgets, source-evidence identity, deduplication, stop reasons, and fail-closed outcomes. No runtime/customer wiring, schema migration, deployment, outbound send, or authority beyond `SALES_ORDER.DRAFT` was added.

## Accepted candidate

- `src/v3-retrieval-loop.ts`: `bf9fa06629717ff57b45963bffe7255a411bf4877ef4c76e889a032ddf2645b1`
- `tests/v3-retrieval-loop.test.ts`: `45358c4047e0db29e316c41b1ac893051cd0e8bc302a51007a88230ca7cc65bb`

## Remediated independent-review findings

The first independent Sol review found five P1 gaps: evidence-byte accounting did not cover the validated payload, Host budgets lacked absolute caps, accessor-bearing requests could reach tools, clarification-policy exceptions escaped the bounded loop, and no-new identity ignored relevant evidence changes. These were remediated before the final candidate. Subsequent hardening added read/candidate/token/elapsed budgets, bounded detached traversal, exact tool/result/request binding, source-message/ref pairing, dependency-lineage identity, callback/deadline fences, and documented-shape-only evidence extraction.

## Final executable evidence

- focused RET-006: **39/39 PASS**
- RET-004/005/006 dependency slice: **82/82 PASS**
- full repository regression: **PASS** via VMMCP job `162d83f8-25e8-4378-abf4-163b5fe0968c`
- typecheck: **PASS**
- build: **PASS**
- scoped `git diff --check`: **PASS**

## Final independent acceptance reviews

All final reviews used the same frozen source/test SHA-256 hashes above.

- GPT-5.6 Sol, VMMCP job `beb1c93c-6450-49b5-a22a-78e88e0d0920`: **PASS, P0=0, P1=0** under the strict P0/P1-only acceptance contract.
- GPT-5.6 Luna, VMMCP command job `3e5723c2-cc04-40be-b194-65851051b955`: **PASS, P0=0, P1=0**; direct CLI evidence records `model: gpt-5.6-luna`.
- Native Claude Sonnet 5, VMMCP job `67659276-ca17-45d2-bf76-cfa2b1dbb52a`: **PASS, P0=0, P1=0**; `modelUsage` explicitly records `claude-sonnet-5`; review cost approximately **US$1.1102**. The reviewer recorded one non-blocking observation about hostile prototype-chain enumeration cost outside the demonstrated JSON-sourced threat model; it did not identify a P0/P1 blocker.

## Decision

RET-006 is **ACCEPTED COMPLETE** for the authorized Phase 4 shadow-only scope. It adds no runtime/customer wiring, schema migration, deployment, outbound ownership change, or authority beyond `SALES_ORDER.DRAFT`. RET-007/008 remain unopened. V3 remains **PROPOSED**.
