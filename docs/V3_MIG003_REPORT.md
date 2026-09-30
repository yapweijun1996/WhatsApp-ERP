# V3-MIG-003 — Canary and Rollback Control Report

Status: **ACCEPTED COMPLETE — process-local control surface; no live traffic**
Date: 2026-09-20

`V3Mig003Control` adds an exact account+conversation canary state and rollback seam without routing a provider or changing schema. Activation requires a reviewed MIG-002-eligible evidence snapshot and an opaque `MIGRATION_OWNER` approval bound to the exact scope and expected migration state. The transition replaces the single authoritative writer from V2 to V3 for that scope; it never introduces a dual writer and leaves `OutboundMessageService` as the sole outbound owner.

Rollback is also owner-authorized and fail-closed unless the scope is currently a V3 canary. It invokes only the supplied V3 derived-state `ignoreAndRebuild` seam, then returns the exact canonical V2 commerce/outbound evidence supplied by the caller. No canonical message, quotation, acceptance, Sales Order, ERP, outbound, or staff-authority evidence is deleted or rewritten. The resulting scope is V2-authoritative and all other scopes remain V2-routed.

## Evidence

- `tests/v3-mig-003.test.ts`: **3/3 PASS**, including owner authorization, exact-scope isolation, one-writer enforcement, and rollback drill.
- `npm run typecheck`: **PASS**.
- `git diff --check`: **PASS**.
- No provider/customer traffic, live provider path, deployment, schema migration, outbound-owner change, or authority beyond `SALES_ORDER.DRAFT` was added.

MIG-003 does not promote V3 globally or establish release readiness. Live canary journeys remain gated by the subsequent approved evaluation tasks and separate owner promotion decision.
