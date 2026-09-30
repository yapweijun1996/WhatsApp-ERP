# V3-FUL-004 Review

Status: **ACCEPTED COMPLETE — Goal-First Fast Track, shadow-only**

`OutboundMessageService.sendDeliveryUnits` now requires a Host-supplied CP-004-shaped admission receipt immediately before every provider attempt for an uncommitted delivery unit. The service remains the sole durable/provider owner: `outbound_messages` is read before admission and remains the only effect ledger. Existing `SUBMITTED`, `PENDING`, and `UNKNOWN` rows are never provider-replayed by the unit loop.

Focused evidence in `tests/v3-ful-004.test.ts` covers per-unit admission, interruption after a submitted prefix, durable replay/resume, and missing/stale admission fail-closed behavior without a duplicate provider call. Pre-attempt admission or grounding failures are recorded as retryable `FAILED`; provider uncertainty remains `UNKNOWN` for FUL-005.

Verification: focused FUL-003/FUL-004 tests PASS; `npm run typecheck` PASS; scoped `git diff --check` PASS. No schema migration, second effect ledger, runtime/customer enablement, deployment, or authority widening was made. P1/P2 hardening backlog: wire the production Host CP-004 adapter and add multi-connection admission race coverage when the V3 shadow boundary is opened; FUL-005 owns provider reconciliation.
