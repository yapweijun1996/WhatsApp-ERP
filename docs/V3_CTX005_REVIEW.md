# V3-CTX-005 Review — Host-Derived Freshness Dependency Vector

## Independent initial review

Initial independent review: **FAIL — P0=0, P1=3**.

- **P1-1:** `src/v3-freshness-vector.ts` imported `./v2-freshness.ts`, leaving the built dist module pointing at a nonexistent TypeScript file.
- **P1-2:** `buildV3FreshnessVectorFromDatabase` accepted caller-supplied channel-account/customer identity and profile version without canonical DB verification.
- **P1-3:** the unrelated product/stock/price test compared identical pure inputs and did not exercise the DB adapter or dependency scope.

## Remediation

The production import now uses the NodeNext-safe `./v2-freshness.js`. The DB adapter reads the canonical conversation by account and conversation, derives and verifies channel-account/customer identity, reads the requested employee profile, and requires an exact profile-version match before delegating the authoritative fingerprint to unchanged V2 code. Mismatches fail closed.

The focused V3 tests now use `V1Database` fixtures with a current draft line for product A. They insert unrelated product/stock/price B and prove the DB-derived vector remains equal, then change relevant price A and prove staleness. They also cover channel-account, customer, and profile-version mismatch rejection. Existing getter/cycle/custom-prototype tests remain.

## Fresh final evidence

- Focused CTX-002/CTX-003/CTX-005 tests: **22/22 PASS** (`tests/v3-context-snapshot.test.ts`, `tests/v3-context-budget.test.ts`, `tests/v3-freshness-vector.test.ts`).
- `npm run typecheck`: **PASS**.
- `npm run build`: **PASS**.
- Direct `import('./dist/v3-freshness-vector.js')`: **PASS**.
- `git diff --check`: **PASS**.
- Direct `adapter.send(...)` ownership scan: only `src/outbound-message-service.ts`.
- Forbidden Sales Order/Delivery Order lifecycle guard scan: **PASS**.
- Full `npm test`: **513/513 tests PASS**.
- Final independent read-only review: **PASS — P0=0 / P1=0**.

V3 remains shadow-only, non-authoritative, and unwired to customer-visible runtime behavior. No schema or V2 freshness implementation changes were made.
