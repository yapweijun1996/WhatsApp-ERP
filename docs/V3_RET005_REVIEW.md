# V3 RET-005 Acceptance Review

Status: **ACCEPTED COMPLETE — AUTHORIZED PHASE 4 SHADOW-ONLY SCOPE**

Date: 2026-09-17 (Asia/Singapore)

RET-005 implements goal/business-object retrieval and the hierarchical retrieval ladder: current bundle -> recent raw -> goals -> sections -> raw history -> attachments -> historical ERP. V3 remains **PROPOSED/shadow-only**. This acceptance does not enable runtime/customer traffic, deployment, canary, schema migration, outbound ownership changes, or authority beyond `SALES_ORDER.DRAFT`. RET-006+ remains unopened.

## Accepted candidate

- `src/v3-retrieval-ladder.ts`: `0999078c4492c88a458b30227667433635f19d1a27b03bc80b55462b8f713d93`
- `tests/v3-retrieval-ladder.test.ts`: `cbb1d39af9a09d41719b194419619d493bb3c85b46a999db29c4b7145120ce9e`

Accepted dependency boundary preserved:

- RET-004 closed retrieval authority/provenance contract remains unchanged.
- GOAL-006 dependency is reused without widening model authority.
- Server-derived retrieval scope remains Host-controlled and model requests cannot select tenant/account/channel/conversation/customer scope.
- Bundle freshness is checked against canonical receipts/current inbox revision before evidence use.
- Historical ERP evidence is read-only/non-authoritative and requires canonical re-verification for consequential use.
- `OutboundMessageService` remains the sole outbound owner.

## Review finding remediated before final freeze

An earlier GPT-5.6 Sol review found a P1 freshness gap: `assertBundleCurrent()` did not bind `conversationRevisionAtBuild` to the current inbox revision. The implementation was corrected and an adversarial regression added using a legal queue mutation to advance the revision. All final evidence below applies only to the corrected frozen hashes above.

## Final executable evidence

- focused RET-005 slice: **26/26 PASS**
- dependency slice: **71/71 PASS**
- full regression: **737/737 PASS**
- typecheck: **PASS**
- build: **PASS**
- scoped `git diff --check`: **PASS**

## Final independent acceptance reviews

All final reviews used the same frozen candidate hashes.

- GPT-5.6 Sol: **PASS, P0=0, P1=0**.
- GPT-5.6 Luna: **PASS, P0=0, P1=0**.
- Native Claude Code 2.1.269 / `claude-sonnet-5`, VMMCP job `548ffd5c-7810-470e-8ea8-b1eb8c1cf908`: **PASS, P0=0, P1=0**. `modelUsage` explicitly records `claude-sonnet-5`; review cost approximately **US$1.8613**. The reviewer statically traced all 24 RET-005 tests but could not execute commands under the read-only Claude profile; executable gates were already established independently before this review.

Claude recorded one non-blocking P2 nit: the trusted Host-constructed bundle freshness check revalidates revision/close reason/message IDs but does not re-derive `bundleReplayIdentity`/`bundleId`. The reviewer found no exploit path because the bundle is not model-facing and returned evidence is independently reopened through RET-004 authority. This is not an acceptance blocker under the P0/P1 contract.

## Decision

RET-005 is **ACCEPTED COMPLETE** for the authorized bounded Phase 4 shadow-only scope. RET-006 through RET-008 remain unopened/unaccepted. No commit, push, deploy, runtime/customer wiring, or outbound ownership change is part of this acceptance.
