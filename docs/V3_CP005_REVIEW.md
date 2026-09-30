# V3-CP-005 Review — Non-message Invalidation Projection

Status: **COMPLETE — shadow-only, non-authoritative**
Date: 2026-09-14 (Asia/Singapore)

CP-005 adds `src/v3-invalidation.ts`, a closed, versioned projection of Host-owned freshness changes. It derives a deterministic event identity from the prior/current V3-CTX-005 vectors, binds the event to account and conversation scope, and reports only changed dependency classes. Profile/policy, work-item/order-draft, canonical business/ERP, ERP evidence, Goal Graph, attachment extraction, and retention/access changes are covered. Conversation-bundle changes are deliberately excluded because inbound chronology remains V2-owned and CP-005 is for non-message invalidation.

No event table, schema migration, runtime wiring, provider send, outbound behavior, or customer-visible behavior was added. Event durability is safely projected from existing durable Host facts and vector hashes; replaying the same facts yields the same event identity. `projectV3InvalidationEventFromDatabase` rebuilds current V3 freshness through the existing canonical V2 freshness adapter. `assertV3PlanContextCurrent` first revalidates the CP-003 lease and then fails closed on any affected dependency, leaving later replan eligibility to CP-006 (not implemented here).

Evidence:

- `tests/v3-cp-005-invalidation.test.ts`: no-new-inbound Goal Graph invalidation, individual profile/policy/ERP evidence/extraction/retention coverage, scope and malformed-event rejection, and message/bundle-only negative control.
- Focused CP-005 test file: **PASS**.
- No schema or V1/V2 lifecycle semantics changed. AI remains cut off at `SALES_ORDER.DRAFT`; `OutboundMessageService` remains the sole provider-send owner.

Adversarial self-review: P0=0, P1=0 in the bounded CP-005 scope. CP-006 was not started.
