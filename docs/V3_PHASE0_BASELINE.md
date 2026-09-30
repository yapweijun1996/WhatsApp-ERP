# V3 Phase 0 — V2 Reproducible Baseline

Status: **BASELINE CAPTURED — V3 IMPLEMENTATION NOT AUTHORIZED**
Date: 2026-09-13 (Asia/Singapore)

This document records the V2 implementation state that Conversation Intelligence V3 must preserve or improve. It does not promote V3, enable V3 traffic, authorize schema/runtime changes, or replace the current V1/V2 authority chain.

## Baseline identity

- Branch: `main`
- HEAD: `150ec87e6a6527a3c2a403a346de0244757947a0`
- Working tree: intentionally dirty; 91 `git status --short` entries at capture start.
- Tracked working-tree diff SHA-256: `d2a22816a8ef9f5e3cce804a945e7c7ad045d7cd3045c3223b898c424de8f0b1`
- Pre-existing untracked files at capture: **39**.
- Sorted untracked-path list SHA-256: `83da21ea5f3052905c6ec5faccdfe789d096379921a03ca50409c99aa61c962f`.
- Sorted untracked-content manifest SHA-256: `43ba83e336047f6ed43f39c06208f83ddbbdb62612e774d8095d933ae3a8dfaf`. The manifest is built over the same 39 paths in bytewise (`LC_ALL=C`) path order with one row per path: regular file `F\t<path>\t<SHA-256(file bytes)>`; symlink `L\t<path>\t<target>`. The four Phase 0 evidence files created after capture are excluded: `V3_PHASE0_BASELINE.md`, `V3_PHASE0_GATE.md`, `V3_PRIVACY_RETENTION_ACCESS.md`, and `V3_REUSE_OWNERSHIP_MATRIX.md`.
- Verification note: the newest mtime among those 39 pre-existing untracked files is `2026-09-13T08:51:15Z`, earlier than the Phase 0 capture/validation run; subsequent Phase 0 reviewers were read-only.
- `package-lock.json` SHA-256: `b2c9e4e5c8c2d25d054d238cfdbf34f863266ef621d65df7e51d05febfc830c5`
- `schema.sql` SHA-256: `5a811cca49edf060c7b41521f8d8496121c06485bc6472535f39b962405f80eb`
- V3 architecture SHA-256: `961a0e2298c2102ef9d5777753bc11a5e445a92d9be9e0ecb3f1ffaa53a9f5e5`

This is a **dirty-candidate reproducibility snapshot**, not a clean release tag. Existing uncommitted work is part of the observed baseline and must not be reset, cleaned, silently absorbed into V3, or re-frozen merely to hide later drift.

## Fresh validation evidence

Executed against the exact current working tree:

- `npm test`: **491/491 PASS**, 0 failures.
- `npm run typecheck`: **PASS**.
- `npm run build`: **PASS**.
- `git diff --check`: **PASS**.
- `npm audit --offline`: **PASS, 0 vulnerabilities reported**.
- `NODE_ENV=test V2_EVAL_002_SURFACE=1 npx playwright test tests/e2e/v2-eval-002.spec.ts --project=chromium`: **1/1 PASS**.
- Direct provider send-owner scan: only `src/outbound-message-service.ts` contains direct `adapter.send(...)` ownership.
- Capability contract keeps explicit forbidden staff lifecycle names including `post_sales_order`, `confirm_sales_order`, and `create_delivery_order`.

## Authority baseline that V3 must preserve

1. AI autonomy stops at `SALES_ORDER.DRAFT`.
2. Staff alone owns Sales Order POST, Sales Order confirmation, and Delivery Order progression.
3. `IncomingChannelMessage` remains the provider-neutral ingress boundary.
4. Host owns identity/scope, capability authorization, canonical ERP truth, freshness, grounding, mutation admission, idempotency, and outbound durability.
5. `OutboundMessageService` remains the sole provider-send owner; provider `PENDING/UNKNOWN` states reconcile before any resend.
6. Existing V2 queue/lease/freshness semantics remain the minimum concurrency guarantee.
7. Workspace migration/rollout keeps one authoritative writer; V3 must not introduce dual authority.
8. Current commerce/quotation/acceptance/Draft-SO evidence remains canonical and cannot be rewritten by derived V3 memory.

## Known open baseline item

`docs/V2_EVAL_003_REPORT.md` remains **IN PROGRESS** because the fresh real-customer WhatsApp Golden journey is still required. Historical/live readiness evidence does not close that gate. V3 planning must not relabel it as complete.

## Rollback reference

Until explicit future V3 promotion, rollback means disabling/ignoring V3-derived context, indexes, goals, retrieval and orchestration extensions and returning to the current V2 execution path. Already committed canonical V1/V2 commerce/outbound evidence is not reversed or recreated. Unresolved provider effects must be reconciled through the existing V2 outbound contract.

## Phase 0 baseline decision

**PASS for baseline capture.** The current candidate is reproducibly identified and freshly validated. This does **not** close the full Phase 0 implementation gate: privacy/retention/access still requires owner policy approval, and Phase 1 implementation requires a separate explicit owner authorization.
