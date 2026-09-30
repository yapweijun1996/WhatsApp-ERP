# V3-MIG-002 — Canary Eligibility and Cutover Policy

Status: **IMPLEMENTED / ELIGIBILITY-ONLY; no canary authority granted**
Date: 2026-09-20

`evaluateV3Mig002CanaryEligibility` is a pure Host-owned classifier over a reviewed, exact account+conversation evidence snapshot. It defines eligibility to request a later canary decision; it cannot route, activate, send, mutate, promote, or change schema. Customer-language matching is not part of the policy.

## Migration matrix

| Surface | Pre-canary / shadow | Canary definition in this policy | Owner rule |
|---|---|---|---|
| Routing | MIG-001 `SHADOW`; V2 result remains returned | Not implemented; eligibility only | MIG-003 owns routing controls |
| Writer | Exactly one active authoritative writer: V2 | A future explicit V2→V3 handoff may request V3 as the sole writer | Any `V2`+`V3` active set is ineligible |
| Outbound | `OutboundMessageService` is the only provider-send owner | Same owner remains required | Alternate owner or provider path count other than one is ineligible |
| Commerce | Existing V2 canonical commerce / ERP truth | V3 may use existing Host seams only | AI cutoff is exactly `SALES_ORDER.DRAFT`; no post/confirm SO or DO |
| Retrieval / derived state | V3 memory, goals, indexes and evidence are non-authoritative, rebuildable, scope-bound | Same properties required | Derived state never grants permission or effects |
| Continuation / effects | Existing Host leases, freshness, admission and reconciliation remain authoritative | No new effect ledger or second loop is defined here | Existing continuation/effect owners are reused |
| Rollback handoff | No rollback is implemented by MIG-002 | MIG-003 must hand off to an explicit owner-controlled drill preserving canonical V2 commerce/outbound evidence | No implicit activation or rollback |

Eligibility requires exact scope equality across the requested pair, MIG-001 shadow evidence, canonical scope proof, V2 current authority, a single active writer, an explicit single-writer handoff contract, the existing migration state, sole `OutboundMessageService` ownership, canonical V2 commerce ownership, the exact AI cutoff, safe derived-state properties, and proof that V3/provider traffic is inactive.

Bounded fail-closed reason codes are: `EVIDENCE_REQUIRED`, `SCOPE_REQUIRED`, `SCOPE_MISMATCH`, `SHADOW_REQUIRED`, `CANONICAL_SCOPE_UNPROVEN`, `WRITER_PROOF_REQUIRED`, `DUAL_WRITER`, `WRITER_HANDOFF_INVALID`, `MIGRATION_STATE_INVALID`, `OUTBOUND_OWNER_REQUIRED`, `ALTERNATE_OUTBOUND_OWNER`, `PROVIDER_SEND_PATH_INVALID`, `COMMERCE_OWNER_INVALID`, `AI_AUTHORITY_WIDENED`, `DERIVED_STATE_INVALID`, and `TRAFFIC_ALREADY_ACTIVE`.

## Evidence

- `tests/v3-mig-002.test.ts`: **6/6 PASS** covering incomplete/default evidence, exact-scope mismatch, dual writers, alternate outbound ownership, complete eligibility without activation, already-active V3/customer/provider traffic, and authority widening.
- `npm run typecheck`: **PASS**; scoped `git diff --check`: **PASS**.
- Initial independent Claude review found P0=0/P1=1: missing negative coverage for `TRAFFIC_ALREADY_ACTIVE`; that focused test gap was remediated.
- Final independent Codex read-only review `d6727e4c-15c6-4fbd-8899-31f1fc8c38ac`: **PASS** under a PASS-only-if-P0=0/P1=0 contract; VMMCP validation also reports **PASS**.
- No provider/customer traffic, runtime activation, deployment, schema change, V3 promotion, or second outbound owner was added.

## What remains for MIG-003

Implement and drill the per-account/conversation canary router, explicit activation authorization, rollback handoff, and derived-state ignore/rebuild behavior while preserving canonical V2 commerce and outbound evidence. MIG-002 does not make V3 live and does not establish release readiness.
