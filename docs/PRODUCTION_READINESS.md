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

## Prospect outbound scope

Customer workspace authority never authorizes a prospect reply. Prospect replies default denied and require a separate host-supplied exact `(accountId, externalConversationId)` allowlist. No wildcard/global entry is supported. An unapproved prospect inbound is persisted and marked SUPPRESSED with a bounded route audit; it performs zero model/catalog/provider calls. Approval changes cannot auto-replay historical suppressed messages. An authorized fresh inbound still runs existing abuse, freshness, catalog grounding and sole-outbound-owner controls. The allowlist is copied at construction so caller mutation cannot widen a running router. This branch configures no real allowlist or grants.

Release candidate verification: 1032 full offline tests and 13 browser tests pass under the CI environment (NODE_ENV=test, simulated channel, demo gateway/V2 disabled). The full journey test uses actual canonical identity, versioned V2 coordinator/executor tools, deterministic catalog/validation, quotation submission through intercepted provider, explicit acceptance -> DRAFT, staff auth/evidence/idempotency, read-only print and persistent SQLite reopen. It does not claim real model or physical provider delivery. Prospect guard focused suite: 91 pass. CI is bounded to 15 minutes, Node24.20.0/Ubuntu24.04, read-only GitHub token, pinned official actions, no deployment or app credentials.


### Prospect replay and delivery recovery
An account/provider-message terminal prospect decision remains terminal after
verified customer binding or V2 workspace authorization. Distinct new message IDs
remain eligible under the normal exact scope checks. Existing audit rows survive.
Prospect processing atomically claims a durable `prospect_reply_delivery` row
before model/catalog awaits. Client message identity is stable by account/provider
message ID. `UNKNOWN` is written before calling the sole outbound sender; a crash,
throw, failed or ambiguous result is never automatically resent. `CLAIMED` after a
crash is also held for explicit review. A submitted result is provider submission,
not physical receipt or exactly-once delivery. Recovery requires reviewed provider
evidence; no timed retry, ledger deletion or global reset is authorized. This is a
fail-closed availability tradeoff pending owner review before production release.

Denied prospect intake, admission disposition and denial audit commit in one
SQLite immediate transaction. Failed suppression/admission/audit rejects the
request and rolls back that intake, permitting a retry while scope remains denied;
no successful suppression is reported from nonterminal state. Historical denial
audit is also a terminal fence for legacy inconsistent PENDING rows. Persistence
failure is operationally unresolved, not an authorization or delivery success.


### Controlled recipient/provider-attempt test fence (opt-in, not activated)
Host createApp controlledTest option installs a send fence before startup on the
shared channel, covering generic, quotation and grounded sends through the sole
outbound service. Omitted option leaves existing runtime unchanged; opting in
without sendPolicy fails closed. Policy names exactly one account, canonical
conversation and external recipient; it grants no customer binding, workspace
capabilities or consent. Group/broadcast/newsletter destinations are rejected.
A durable SQLite immediate transaction reserves one of three provider attempts
before every adapter call. Concurrent calls, process restart, ambiguous/failed
results and crash-after-provider-call never refund slots. Policy ID/scope changes
cannot silently reset a budget; the same account/recipient has a unique budget scope, even if the canonical conversation changes.
Counters/evidence survive demo resets. No automatic refund/reset/new window is
supported. Owner-approved future windows require separate reviewed handling.
Do not activate processing or configure a real policy from this code release.
No recipient, model or provider was contacted by its synthetic tests. Submitted
means provider submission, not physical delivery or exactly-once semantics.
