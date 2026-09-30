# V3-CTX-006 Shadow Evaluation Report

Date: 2026-09-14 (Asia/Singapore)

Status: **PASS — P0=0 / P1=0**

V3-CTX-006 is complete after remediation and final independent review.

## Scope and implementation

Added only:

- `src/v3-context-shadow-eval.ts`
- `tests/v3-context-shadow-eval.test.ts`
- this report

The harness is deterministic and shadow-only. It builds the source context through the existing `AgentContextBuilder`, then composes CTX-002 `buildContextSnapshot`, CTX-003 `assembleV3ContextBudget`, CTX-004 chronology/index-derived source-linked memory, and CTX-005 `buildV3FreshnessVectorFromDatabase`. It does not call an adapter, runtime, server, commerce service, or outbound service. It performs only reads after fixture construction.

Memory proposals use chronological/index ranges only. There is no customer-language intent classification, keyword interpretation, or regex grouping. CTX-004 and the snapshot path provide canonical redaction, scope validation, detached values, and frozen outputs. Missing or cross-scope input fails closed through V2/CTX validation.

## Deterministic fixture evidence

The in-memory fixtures use `V1Database(':memory:')` and contain no production data.

| Case | Messages | V2 transcript | V3 memory source refs | V2 context | V3 model-facing budget | Completeness | Authority parity | Effects |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| short | 6 | 6 | 6 | 3,933 tokens | 646 tokens / 2,583 chars | 1.0 | exact / pass | unchanged |
| long | 121 | 20 | 121 | 4,416 tokens | 995 tokens / 3,977 chars | 1.0 | exact / pass | unchanged |

The long case demonstrates V2's bounded 20-message recent transcript while V3 derived memory retains all 121 source message references. The 121-message memory is derived state, not model-facing context. Only the CTX-003 budget plan is model-facing; this report does not claim full-history injection.

Budget configuration in both cases: model context 1,800 tokens; authority reserve 300; tool/reasoning reserve 300; future-goals reserve 200; available context 1,000 tokens. Long-case use was 995 tokens, leaving 5 tokens. Memory itself was 1,266 estimated tokens / 5,062 chars in the long case and is not injected wholesale.

Authority parity checks were exact for account, conversation, current inbound message, profile ID/version, V2 freshness fingerprint, and the complete canonical commerce projection. CTX-005 also carried the exact V2 fingerprint and was validated against canonical DB scope/profile identity.

The zero-effect proof fingerprints these tables before and after evaluation: `outbound_messages`, `quotations`, `quotation_acceptances`, `sales_orders`, `staff_actions`, `audit_events`, `work_items`, and `order_drafts`. Both cases produced identical before/after fingerprints. No outbound/provider/commerce mutation is initiated by the harness.

## Review and remediation

Initial independent review: **FAIL — P0=0 / P1=2**.

- **P1-1:** the long-conversation case did not explicitly rerun the same evaluation and assert deterministic equality.
- **P1-2:** authority parity covered core scope/profile/commerce state but omitted explicit customer/channel, capability-set, WorkItem, and OrderDraft parity.

Remediation now reruns the 121-message case and requires exact deep equality. Authority parity now checks customer context, channel/account scope, full capability projection (normalized to the freshness-vector ordering), WorkItem, OrderDraft, profile identity/version, current inbound, V2 freshness fingerprint, and canonical commerce projection.

The earlier report claim that `src/commerce.ts` directly called `adapter.send(...)` was stale. Fresh source inspection proves `CommerceService` delegates through `this.outbound.send(...)`; direct provider `adapter.send(...)` calls exist only in `src/outbound-message-service.ts`.

## Final validation evidence

- Focused CTX-002/003/004/005/006 tests: **32/32 PASS**.
- Full `npm test`: **523/523 PASS** after remediation.
- `npm run typecheck`: **PASS**.
- `npm run build`: **PASS**.
- Built `dist/v3-context-shadow-eval.js` import: **PASS**.
- `git diff --check`: **PASS**.
- Cross-scope fixture: **PASS** — fails closed at the V2 scoped inbound boundary.
- Direct provider-send ownership scan: **PASS** — only `src/outbound-message-service.ts` directly invokes `adapter.send(...)`.
- Forbidden Sales Order POST/CONFIRM / Delivery Order capability guard: **PASS**.
- Final independent read-only review: **PASS — P0=0 / P1=0**.
- Protected runtime/schema owners (`schema.sql`, `src/app.ts`, `src/server.ts`, `src/outbound-message-service.ts`, `src/v2-agent-context.ts`, `src/v2-context-projection.ts`, `src/v2-freshness.ts`) were not modified by CTX-006.

## Gate decision

**V3-CTX-006 = COMPLETE. Phase 1 Context Foundation = COMPLETE (6/6).** The result remains shadow-only and non-authoritative. V3 is still `PROPOSED`; no customer-visible V3 behavior, canary/production routing, Phase 2 implementation, or authority beyond `SALES_ORDER.DRAFT` is authorized.
