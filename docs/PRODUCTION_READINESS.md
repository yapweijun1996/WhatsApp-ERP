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


### Approved account inbound inquiry policy (source preparation, not activated)
Owner Sentinel_ec4ca4e3d0a08191af8f108d1d0c92af authorizes the already paired
account's incoming customer consultations, product Q&A, quotations and
SALES_ORDER.DRAFT only. No payment, posting, confirmation, shipping or V3.
Do not repeat that scope question or require a controlled test number for
inquiry-only engineering readiness. Physical test sends remain separate.

A reviewed host-only opaque approval registers one account policy with its owner
reference and activation time. App boot never registers policy/grants or seeds demo customers/products for inquiry mode. Registration requires the existing canonical channel-account row. Only the
actual normalized channel callback admits new direct-contact messages after that
time. Imported/paused history and previously admitted messages cannot become new
work; HTTP simulation/reset cannot enter this path. No wildcard/account-wide V2
capability rollout is written. Unknown contacts retain null customer identity and
reach only the existing bounded public-catalog prospect seam using an opaque,
per-message admission; model text or a customer code never creates a binding. Authenticated PN/LID transport metadata may add an alias only to one uniquely matching existing verified phone/customer relation; ambiguous/unknown numbers remain public-catalog prospects, and no customer record or relationship is invented.
Verified existing canonical sender/customer binding is rechecked before exact
conversation shadow import/promotion and the seven existing V2 capability grants.
Opaque migration/rollout issuers retain descriptor binding, compatibility,
quarantine and staff cutoff. Partial grant failures stay blocked and observable.
First grants use a conditional insert in the rollout writer transaction, never an
UPDATE of an existing permission. Concurrent exact DISABLE wins; policy, canonical
binding and workspace revision/owner are re-read in that same transaction. Ignored
insert or aborted approval-event persistence rolls back the grant and fails closed.

The outgoing fence checks current policy/revision plus active fresh handling
scope. Generic/prospect replies must target that account/external conversation and
current external message; quotations require current-handling trusted canonical
outbound intent. Old ambiguous intent is held, not automatically replayed. Policy
revocation stops sends after an awaited model call. Inquiry startup skips outbound
reconciliation and bypasses V3 dispatch; the controlled-test three-attempt quota is
independent and is not a permanent business-message limit. All runtime failures
remain fail-closed with bounded admission status and existing endpoint/audit trace.

Activation target (after exact source review and CI): private Air DB policy for
logical paired account demo-account, owner reference above, DRAFT boundary; host
inquiryAccountId selects that registered account only, real demo gateway/Pi V2
on, startup active, V3 off, no staff bootstrap, no controlled-test policy for
regular customer responses. Each new verified conversation receives exact
customer/account/conversation migration and seven capability rows, never guessed
customer assignment/global default. Reviewed registration also covers these evidence-derived aliases, not guessed identity assignments. Persistent registration/activation must pass
action-time review before executing. Settings exposes server provider/model/runtime
and managed-gateway billing mode without keys or BYOK/OAuth/subscription setup.

### Effective runtime status
Health and selected-conversation operational status share the effective host
projection. Existing runtimeMode/v2TrafficEnabled field names remain compatible:
an active approved inquiry policy with configured Pi/V2 reports V2/true and
SCOPED, never a global rollout. Paused composition reports PAUSED/OFF; configured
model/environment alone does not enable inquiry. Revoked policy reports BLOCKED,
not a working V1 fallback. Settings prefers this projection and can derive scoped
status from existing inquiry/Pi/rollout metadata while older Phase0 labels remain
in a pre-upgrade backend. These fields report readiness, not evidence of a live
model request, provider submission, physical delivery or customer acceptance.

### Persisted replies and inbox refresh
Prospect rendered reply text/hash is committed as an UNKNOWN journal intent in
the same transaction as its provider-dispatch claim, before the sole outbound
service is invoked. Provider acknowledgement updates that intent to SUBMITTED;
malformed/ambiguous disposition remains held and never automatically resends.
Payload and terminal disposition cannot be rewritten. A selected account-scoped
chat feed merges persisted incoming messages and these recorded replies.
Pre-upgrade submissions without retained text appear only as an unavailable-text
notice, never invented historical replies. Read-only list/chat polling preserves
selection, focus, scroll and draft text. No polling path sends customer messages.
## Scoped staff conversation takeover and manual replies

This feature reuses the existing opaque staff-session contract. Cloudflare Access identity, a request-body role or a guessed staff label cannot authorize it. It does not create a credential, customer binding, workspace permission or rollout grant. The live bootstrap credential must be supplied by the owner through an approved private local handoff before staff sign-in can work; an absent bootstrap leaves all staff writes denied. Existing staff authority also governs the existing formal commerce actions; a new credential or narrower identity scheme requires a separately reviewed security decision.

The authenticated staff member selects a canonical direct WhatsApp conversation whose transport sender is evidenced by an inbound record, then explicitly takes it over. A durable revision and immutable audit event fence older AI admissions, including turns that finish after takeover/resume. Already-started work must drain before manual sending or AI resume; a provider attempt already in progress cannot be recalled. New inbound during takeover is retained for display without model execution, commerce workspace activation or automatic reply. Resume permits new inbound only and never replays held history.

The selected owner may submit a text-only manual reply of at most 4,000 characters through the existing sole OutboundMessageService. A command hash, actor, account, canonical conversation, expected takeover revision and durable UNKNOWN intent are committed before the provider attempt. The reply fence recognizes only the exact host-created wire object for that operation. Duplicate requests return the same disposition without another attempt; changed payload or stale ownership/revision is denied. Submission acknowledgement is distinct from physical delivery. Provider exceptions, malformed acknowledgements or disposition persistence failures stay UNKNOWN and block a fresh send/resume pending explicit recovery review; no automatic resend or reconciliation is added.

The inbox derives control availability from the backend, keeps unsent drafts separately per conversation in page memory, and retains the original idempotency key when checking an uncertain request. Paused runtime disables every control. Staff chat actions require the staff cookie, JSON, a custom same-origin action header and reject cross-site browser requests. This source change does not authorize deployment, staff credential provisioning or unsolicited live test messages. Offline HTTP/browser tests use synthetic data and intercepted providers; physical delivery remains a separate observation.
