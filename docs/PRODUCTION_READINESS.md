# WhatsApp ERP production readiness

The owner delegates engineering and routine QA to Codex. This checklist distinguishes implemented logic, isolated verification and live deployment; no universal 100% guarantee is claimed. Existing protected Air account is paired; processing is paused. This branch does not activate runtime authority or send real messages.

| Gate | Existing implementation | Required evidence |
| --- | --- | --- |
| Identity | canonical account/sender binding; unknown/prospect fail closed | independent synthetic identities, cross-account denial, no implicit CUST-001 binding |
| Interpretation | existing Demo Gateway + Pi V2 harness | controlled structured-decision tests, malformed/unsafe-output rejection; live runtime configuration separately reviewed |
| Commerce | canonical SQLite catalog/stock/price, revisioned drafts, quotations, explicit acceptance -> SALES_ORDER.DRAFT | exact money/stock/evidence, no implicit acceptance, no AI post/confirm/DO |
| Persistence/recovery | SQLite WAL, durable inbound/outbound ledgers and freshness/idempotency | restart/replay/concurrency and ambiguous-provider no-blind-resend tests |
| Staff | existing credential-entry/session and opaque capabilities | missing/forged auth denial, explicit SO targeting and double confirmation; owner credential handoff remains separate |
| Review/print | selected canonical detail and audit; read-only print view added here | account-scoped print, escaped content, frozen quote lines, unchanged business counts |
| Operations | protected Access, loopback origin, private data/session, paused flags | exact release + health/Access checks; live receive/model/draft/outbound requires narrow action-time approval |

Activation proposal after offline gates: reuse existing demo gateway only; resolve the actual paired account and selected conversation/customer through canonical identity (no guessed IDs); approve migration authority and the seven existing V2 capabilities only for that exact workspace, with AI cutoff SALES_ORDER.DRAFT and V3 off. Review pending outbound before startup. Staff credentials remain owner-only handoff. Separately authorize recipient and exact real external test messages before any provider send. Do not create global rollouts, arbitrary bindings, tokens or subscriptions. Keep one authoritative writer and preserve private backup; rollback pauses Air processing and blocks sends without restarting the retained old VM service.

The linked-device QR adapter is explicitly unofficial/demo in AGENTS.md. Calling the system production-grade requires an owner decision on the supported Meta Cloud API path and its credentials; engineering must not silently claim QR is an official production transport. The intended commerce backend is canonical SQLite; external ERP connector parity must be explicitly established before claiming an external ERP integration.

Print is a read-only representation of the selected account-scoped canonical state under the existing whole-host Access guard. It grants no staff action or order authority and performs no printing automatically.

Prepared production staff session cookies add Secure alongside existing HttpOnly/SameSite=Strict; logout preserves the same Secure scope. Test-only credentials are injected only in synthetic tests. No live owner credentials or runtime auth configuration are created/changed.

Validation: 1027 full offline tests, 114 focused identity/commerce/acceptance/recovery cases, two targeted print/auth security tests and 13 browser tests passed. Typecheck/build, diff check and redacted secret scan passed. Synthetic model/provider tests prove deterministic host semantics, not live inference or WhatsApp delivery. Print/cookie changes are source preparation, not deployed to the paired Air runtime.
