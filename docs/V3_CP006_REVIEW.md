# V3-CP-006 Review — Stale-plan Recovery and Post-admission Finish

Status: **COMPLETE — shadow-only, non-authoritative**
Date: 2026-09-14 (Asia/Singapore)

CP-006 adds a pure recovery projection in `src/v3-control-plane-recovery.ts`. Before side-effect admission, a stale plan deterministically yields abort → rebundle/rebuild → replan. After CP-004 admission, the projection preserves the stable effect identity and selects idempotent finish, already-finished, reconciliation-required, or terminal-failure handling from durable effect state. `UNKNOWN` never authorizes a blind provider resend.

The projection does not claim or release V2 leases, rebuild V2 chronology, call a model, mutate ERP, or send through a channel. Existing V2 queue/lease, CP-004 admission, invalidation, and `OutboundMessageService` remain authoritative. No schema, runtime, customer-visible, or provider adapter wiring changed.

Evidence:

- `tests/v3-cp-006-recovery.test.ts`: pre-admission interruption, post-admission interruption, idempotent finish, UNKNOWN reconciliation, closed descriptor-safe input/output validation, malformed/incomplete/extra-field/wrong-value/authority/accessor adversarial tests: **PASS**.
- No customer-language classification, new `adapter.send` path, or capability was added.
- AI authority remains capped at `SALES_ORDER.DRAFT`; POST/CONFIRM Sales Order and Delivery Order progression remain staff-owned.

Remediation: stale-plan inputs and both recovery output variants are now exact closed data shapes; validation checks every enum/value and requires admitted-effect `mayProviderAttempt === false` without invoking accessors. `FAILED_RETRYABLE` remains `FINISH_IDEMPOTENTLY`; V2 owns retryable outbound failure handling and no CP-006 path authorizes a blind resend.

Self-review after remediation: P0=0, P1=0 for the bounded CP-006 shadow scope. CP-007 was not started.
