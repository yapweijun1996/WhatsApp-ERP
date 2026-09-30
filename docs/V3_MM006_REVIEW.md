# V3-MM-006 Review — Historical Media vs Current ERP Truth

Status: **ACCEPTED COMPLETE — Goal-First Fast Track, shadow-only Host gate**

## Goal

Prevent old screenshots/PDFs and other derived attachment evidence from becoming business truth at a consequential decision. Historical media remains `NON_AUTHORITATIVE_DERIVED`, untrusted as instruction, grants no effects, and requires current canonical ERP re-verification.

## Implementation

`src/v3-multimodal-canonical-reverify.ts` adds a Host-only MM-006 gate. It does not accept caller-supplied canonical ERP values. Price and stock are re-read from the current ERP state using the existing `OrderValidationService`; quotation/sales-order status is read from current canonical commerce tables with exact conversation/customer/object binding. Draft facts also require exact current draft revision. Matching truth may only become admission input; it still has `grantsEffects=false`, `requiresSideEffectAdmission=true`, and `aiAuthorityCutoff='SALES_ORDER.DRAFT'`.

Conflict/staleness behavior is content-free at the decision boundary: old price, old stock availability, or old status returns `REPLAN_REQUIRED`; stale media or unavailable/stale canonical truth also fails closed.

## Review recovery

The first independent review identified a P0 trust-boundary flaw in the initial design: a caller could provide a shape-valid but forged “canonical observation.” That design was removed. The final gate now obtains current canonical truth from the Host-owned database/services only. Final independent read-only Codex review job `e2b7ffa2-21e7-49c3-a4e9-8cc19e293dd5` completed with structured **PASS / PASS_P0_0**.

## Evidence

Targeted command: `node --test --test-concurrency=1 --import tsx tests/v3-mm-006.test.ts tests/v3-attachment-retrieval.test.ts` → **11/11 PASS** (MM-006 6 + MM-004 5). Covered old PDF price conflict, old stock screenshot vs current shortage, old PDF status conflict, matching-current control, stale media/stale draft fail-closed behavior, and cross-scope/accessor/proxy rejection.

`npm run typecheck` → **PASS**. Scoped `git diff --no-index --check` for the MM-006 source and test files → **PASS**.

## Boundaries

No production/customer runtime enablement, deployment, provider/network work, outbound-owner change, DB schema migration, or authority widening was added. AI autonomy remains capped at `SALES_ORDER.DRAFT`.
