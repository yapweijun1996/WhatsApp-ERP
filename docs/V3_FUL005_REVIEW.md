# V3-FUL-005 Review

Status: **ACCEPTED COMPLETE — Goal-First Fast Track, shadow-only**

## Scope and implementation

FUL-005 reuses the existing V2 `OutboundMessageService` and `outbound_messages` ledger. No second transport/effect owner, schema migration, runtime/customer enablement, or deployment was added.

- Provider exceptions park a delivery unit as `UNKNOWN`; replay and restart do not call the provider again.
- `reconcile()` uses the durable `client_message_id` (the FUL-003 stable delivery identity). `submitted` finalizes the original row; `not_found` becomes `FAILED` with `retryable:not_found`, which is the only path that permits the bounded existing retry.
- `RUNTIME_RESPONSE` disposition is required by both runtime delivery entry points. A capability-owned quotation terminal disposition has no runtime response plan and therefore cannot produce a duplicate runtime delivery.

## Evidence

- `tests/v3-ful-005.test.ts`: **3/3 PASS**.
  - provider uncertainty + restart/reconnect reconciliation: submitted, one provider send, same stable identity;
  - `not_found` reconciliation + bounded retry: same stable identity;
  - capability-owned quotation disposition blocks runtime delivery with zero provider calls.
- FUL dependency slice `tests/v3-ful-003.test.ts`, `tests/v3-ful-004.test.ts`, `tests/v3-ful-005.test.ts`: **3/3 test files PASS**.
- `npm run typecheck`: **PASS**.
- Scoped `git diff --check`: **PASS**.
- Independent Claude read-only review job `df9d5d36-781a-47fc-b802-45faee8544b7`: **PASS_WITH_P1**, P0=0, P1=1, P2=1. The P1 is missing an explicit negative boundary test for the existing `attempt_count >= 2` retry cap; the P2 is direct disposition-guard coverage. Both are non-blocking Fast Track backlog because the bounded retry guard and runtime/quotation ownership checks already exist in Host code.

## Safety and backlog

AI authority remains capped at `SALES_ORDER.DRAFT`. Quotation capability remains the sole quotation outbound owner; runtime response/delivery cannot duplicate it. Independent review found no P0; its non-critical P1/P2 test-hardening findings are backlog. Existing FUL-004 production CP-004 adapter/multi-connection hardening and FUL-003 attachment resolver also remain backlog/non-scope.
