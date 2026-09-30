# Independent DIRTY V2 Phase 1A Final Remediation Review

## Baseline and scope

Baseline HEAD: `be5b9257288e9fbe86b1a3660d0ab16e4de0b279`. Reviewed the current dirty candidate and this report first, then the Phase 1A schema, database capability boundary, workspace/migration/draft services, focused tests, package lock, and governing V2 documents. Only this report was modified. Later DRAFT-003/VAL/CAP/CTX/PI/transport/rollout absence was excluded as instructed.

## Prior P1 re-check

| Finding | Result |
|---|---|
| P1-01 raw authority flips lacked DB enforcement | **Remediated.** Migration UPDATE requires the process-scoped authorization function, legal transition, and chained immutable event evidence matching prior event/from/to/writer. Raw UPDATE remains rejected. |
| P1-02 quarantine replay threw stored errors | **Remediated.** Exact replay returns the stored `QUARANTINED` snapshot; changed input with the same idempotency key remains an `IDEMPOTENCY_CONFLICT`. |
| P1-03 legacy sender mismatch was not checked | **Remediated.** Shadow import and fresh promotion re-check canonical message sender identity; mismatch is durably quarantined and exact replay is stable. |
| P1-04 rollback quantity could round | **Remediated.** Ingress and rollback require exact three-decimal safe numeric round-trip; `1234567890.123` succeeds and unsafe integers are rejected. |
| P1-05 authority INSERT/DELETE and forgeable reset bypass | **Remediated.** INSERT is trigger-gated and permits only the bounded `V1_ONLY`/`LEGACY` initialization shape; DELETE is reset-capability-gated; migration UPDATE remains chained and authorized. The old maintenance-flag table is absent, reset authorization is process-scoped, and legitimate bounded reset still works. |

## P0

None found. P0 count: **0**.

## P1

None found after remediation. P1 count: **0**.

## P2

No additional P2 finding. The intentionally absent later V2 work is not a Phase 1A defect.

## Invariant checklist

| Invariant | Result |
|---|---|
| One writer and DB authority constraints | PASS; raw INSERT, DELETE, and unauthorized UPDATE are rejected; migration service is the authorized writer. |
| `SHADOW_IMPORT` is LEGACY/read-only | PASS at service boundary and tested |
| Derived, idempotent shadow projection | PASS; exact replay returns stored result |
| Invalid/mismatched legacy source durably quarantined | PASS, including sender mismatch and fresh promotion re-check |
| Fresh hash/work-item/draft checks and one CANARY flip | PASS. |
| Rollback materializes V1 first, then flips authority | PASS; V2 writes are blocked after rollback |
| Canonical quote/outbound/accepted-SO precedence | PASS in reviewed service/tests; canonical pending/unknown and commitment boundaries block migration |
| Immutable events, revisions, provenance, and source scope | PASS; reset-only deletion/update capability is process-scoped. |
| Reset path | PASS; fake maintenance table is absent, raw SQL reports reset authorization `0`, and bounded reset succeeds. |
| V1 unchanged and V2 traffic disabled | PASS; no relevant V1 regression or enabled V2 traffic found |
| No overclaim of later work | PASS |
| better-sqlite3 13.0.3 compatibility | PASS; lockfile and runtime agree. |

## Validation

Independent validation: `npm test` **46/46 PASS**; Phase 1A focused run **13/13 PASS**; `npm run typecheck` PASS; `npm run build` PASS; `git diff --check` PASS. Direct raw-SQL probes independently confirmed: V1-shaped INSERT rejected with `WORKSPACE_AUTHORITY_INIT_REQUIRED`, stronger INSERT rejected, DELETE rejected with `WORKSPACE_AUTHORITY_DELETE_FORBIDDEN`, unauthorized UPDATE rejected with `WORKSPACE_AUTHORITY_MIGRATION_REQUIRED`, fake `v2_maintenance_flags` INSERT failed because the table does not exist, and `v2_workspace_reset_authorized()` returned `0` outside reset. Legitimate `resetAndSeed()` preserved the seeded V1 sales order and returned reset authorization to `0` afterward. Supplied fresh evidence also passes: `npm ci`, Node v24.20.0, better-sqlite3 13.0.3, Phase 1A **9/9**, build, Chromium **1/1**, `npm audit` **0**, diff check, and secret scan.

## Gate decision

**GO — PASS Phase 1A implementation gate.** P0=0, P1=0. No remediation remains within this review scope.

VERDICT: PASS
