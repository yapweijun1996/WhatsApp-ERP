# Independent DIRTY Phase 1B V2-VAL-001 Review

## Scope and basis

Reviewed the remediated dirty candidate at baseline HEAD `55fdfde32efe02b654847c31ab7cce48ed97d33a`. The prior FAIL report was read first. Review covered `AGENTS.md`, `docs/GO_CONTRACT.md`, `docs/STATE_MACHINE.md`, `docs/V2_ARCHITECTURE.md`, `docs/V2_SPEC.md`, `docs/V2_TASKS.md`, `docs/V2_PHASE1A_REVIEW.md`, `docs/V2_PHASE1A_VERIFICATION.md`, and `docs/V2_WORKSPACE_MIGRATION.md`, plus the current validation implementation, schema, database reset path, domain contract, and focused tests.

Only this review file was overwritten. No product, test, schema, package, or existing documentation file was modified by this review.

## P0 findings

None. P0 count: **0**.

## P1 findings

None. P1 count: **0**.

### P1-01 — CLOSED: validation history is append-only except reset

`v2_order_validations` has database `BEFORE UPDATE` and `BEFORE DELETE` guards that reject ordinary SQL with `IMMUTABLE_V2_ORDER_VALIDATION`. `V1Database.resetAndSeed()` has the private process-scoped reset authorization and clears validation history as intended. The focused test reproduced both rejected ordinary mutations and successful reset clearing.

### P1-02 — CLOSED: blocked validation attempts are durably recorded

The validation catch path persists a `BLOCKED` row containing the draft id, requested revision, mode, reason in `result_json`, and the accumulated evidence refs. The focused tests reproduced a blocked DRAFT attempt and a later `QUOTE_TIME` failure after an earlier successful DRAFT validation; the rows remain distinguishable by mode/status and preserve historical order. If validation-history insertion itself fails, a successful validation is converted to `BLOCKED` with `VALIDATION_HISTORY_PERSIST_FAILED`; the service does not claim success. If the database is unavailable, the probe returned `BLOCKED` rather than a successful result. A persistence outage cannot durably write its own failure row, which is an unavoidable limitation of that outage and is fail-closed rather than a Phase 1B success overclaim.

### P1-03 — CLOSED: evidence refs are line-scoped

Each line now owns a fresh evidence-ref list. The multi-line focused test reproduced five refs for each converted line: exactly `product_resolution`, `uom_resolution`, `uom_conversion`, `customer_price`, and `warehouse_stock`; refs do not use the prior global suffix and do not cross-contaminate lines. The non-conversion path is implemented to omit `uom_conversion` while retaining the other exact line lookups. Global customer, warehouse, and order-history evidence remains at validation scope and is not placed in line refs.

### P1-04 — CLOSED: UOM conversion ambiguity and invalid factors fail closed

The conversion query returns all matching rows in deterministic id order and blocks duplicate matches as `UOM_CONVERSION_AMBIGUOUS`. Decimal parsing plus an explicit positive-factor check blocks zero, negative, and malformed factors as `UOM_CONVERSION_INVALID`. Focused tests reproduced duplicate, zero, and malformed-factor failures.

## P2 findings and later-work advisories

### P2-01 — Cross-line atomic ERP snapshot remains later work

The service performs deterministic per-lookup reads and records each result, but does not yet provide one transactionally consistent snapshot spanning all mutable ERP facts and all lines. Preserve the existing architecture/quote-preparation requirement for an atomic fresh read and immutable quote snapshot. This is not a Phase 1B blocker because the current implementation is explicitly a read-only validation foundation and makes no quotation claim.

### P2-02 — Delivery policy validation remains later work

The draft requested delivery date is carried in the workspace contract, but Phase 1B does not implement a delivery-policy lookup/evidence contract. Preserve this as a later quote-preparation advisory; it is not a Phase 1B blocker while the docs do not claim delivery-policy validation is complete.

### P2-03 — Arithmetic bounds hardened and safely bounded

String-backed decimal arithmetic canonicalizes `1.50` to `1.5` and preserves exact totals. Per-line totals reject non-exact cents and out-of-range results; malformed/non-safe/negative/over-limit prices fail closed; the aggregate subtotal is accumulated as `bigint` and rejects overflow before conversion to a JavaScript number. Focused tests reproduced exact decimal totals, non-exact-cent rejection, malformed price rejection, and aggregate overflow rejection. This is bounded hardening within V2-VAL-001 and does not add quotation, Draft SO, capability, runtime, or traffic scope.

## Invariant checklist

| Invariant | Result | Basis |
|---|---|---|
| Exact immutable draft revision and stale revision checks | PASS | Current revision and immutable revision snapshot are checked; focused tests pass. |
| Customer/account/conversation scope | PASS | Draft/work-item tuple and canonical conversation customer/account are checked. |
| Product/SKU/alias ambiguity and active status | PASS | Exact case-insensitive SKU/alias/description matching, active products, and ambiguity blocking are present. |
| UOM existence/conversion correctness | PASS | Unknown UOM, missing conversion, duplicate conversion, and invalid factor fail closed. |
| Decimal/cents arithmetic | PASS | Canonical decimal arithmetic, exact cents, safe price bounds, and bigint aggregate bound are tested. |
| Price validity/ambiguity/current currency | PASS | Validity window, ambiguity, currency, integer/safe-range, and non-negative checks are present. |
| Stock/warehouse freshness | PASS with snapshot advisory | Warehouse and stock are reread per invocation; P2-01 remains later work. |
| Quote-time fresh re-read | PASS as historical re-read semantics | `validateForQuotation` uses `QUOTE_TIME`, rechecks revision and mutable ERP facts, and records failures distinctly; quotation preparation is not implemented. |
| Order history provenance | PASS | Recent history is read and evidenced at validation scope. |
| ERP evidence correctness and per-line mapping | PASS | Each line has only its own exact lookup refs; global refs are not copied into lines. |
| `v2_order_validations` append-only/history | PASS | Ordinary UPDATE/DELETE rejected; reset path alone clears history. |
| Failure behavior and durable failure evidence | PASS with outage limitation | Blocked attempts persist mode/revision/reason/evidence; persistence failure never returns success, and unavailable storage cannot record a row. |
| Canonical commerce precedence | PASS | Validation reads canonical ERP tables and does not create or alter commerce commitments. |
| No mutation beyond read-only business effect | PASS | Only ERP evidence and validation-attempt history are written; no draft, quote, stock, customer, product, price, or Sales Order mutation. |
| V1 lifecycle and AI cutoff | PASS | Existing V1 lifecycle and cutoff remain intact; no post/confirm/DO path is added. |
| V2 traffic disabled | PASS | Docs and runtime retain disabled/unimplemented V2 routing. |
| No overclaim of VAL-002/DRAFT-003/CAP/runtime | PASS | Later tasks remain pending; this phase is documented as validation foundation only. |

## Independent verification

- `npm run typecheck` — PASS.
- Focused `tests/v2-order-validation.test.ts` — **10/10 PASS**.
- `npm test` — **56/56 PASS**.
- `npm run build` — PASS.
- `git diff --check` — PASS.
- Bounded persistence-outage probe — PASS fail-closed behavior: closed DB returned `BLOCKED`, not success.
- Direct focused probes — PASS: ordinary validation UPDATE/DELETE rejected; `resetAndSeed()` cleared history; blocked DRAFT and later QUOTE_TIME failures persisted distinctly; duplicate/zero/malformed conversion, invalid price, aggregate overflow, line-scoped evidence, and `1.50` canonicalization were reproduced by focused tests.
- `npm audit --audit-level=moderate` — **BLOCKED** by environment registry DNS failure (`getaddrinfo EAI_AGAIN registry.npmjs.org`); no vulnerability result was produced locally. The supplied fresh commander evidence reports audit 0 and is noted but not independently reproduced here.
- `npm run e2e` / Chromium — **BLOCKED** by environment: `/usr/bin/chromium-browser` requires the unavailable Chromium snap. The supplied fresh commander evidence reports Chromium 1/1 and is noted but not independently reproduced here.
- Baseline check — current `HEAD` is `55fdfde32efe02b654847c31ab7cce48ed97d33a`.

## Verdict

P0: **0**. P1: **0**. P2: **3** (P2-01 and P2-02 later-work advisories; P2-03 safely hardened).

The Phase 1B gate is met. P1-01 through P1-04 are genuinely closed, the requested arithmetic bounds are fail-closed without scope expansion, and the implementation remains read-only in business effect. Browser and audit are environment-blocked locally, with supplied fresh evidence recorded separately rather than represented as locally reproduced.

**VERDICT: PASS**
