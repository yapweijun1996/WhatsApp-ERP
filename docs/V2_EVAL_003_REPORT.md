# V2-EVAL-003 Live QR / Demo GPT Evaluation Report

Status: **IN PROGRESS — fresh real-customer Golden journey still required**

Date: 2026-09-11 (Asia/Singapore)

## Current workspace verification (2026-09-13)

- Full Node regression: **478/478 PASS**.
- Typecheck: **PASS** (`npm run typecheck`).
- Build: **PASS** (`npm run build`).
- Static safety checks: **PASS** (`git diff --check`; forbidden capability and sole outbound-owner checks).
- Browser E2E: **BLOCKED by environment**; Playwright Chromium is not installed (`browserType.launch` cannot find the configured executable). No browser result is claimed from this run.
- Dependency audit: offline audit reports **0 vulnerabilities**; the online audit request was unavailable due to registry DNS `EAI_AGAIN`.
- AI-first review: **PASS**; no customer-language regex/keyword/canned business interpretation was added. V2 remains globally OFF and the AI cutoff remains `SALES_ORDER.DRAFT`.

## Completed live evidence

## Canary implementation readiness evidence (2026-09-11)

- Independent review remediation: durable V2 route ownership now fails closed on absent/malformed transport with zero V1 fallback; rollback drain reclassifies only queued, unbound, side-effect-free items with immutable route evidence and blocks claimed/processing/side-effect-started items; canonical V2 ingress uses a transaction-fenced conversation/identity persistence boundary; customer context/history executor projections match the registered `customerId`/`date` schemas.
- Dedicated canary/executor tests cover transport fail-closed and exact output field names; the report remains **IN PROGRESS** and EVAL-003 is not closed.
- Defense-in-depth follow-up now rejects a persisted customer identity whose stored channel does not exactly match the normalized inbound channel before V2 scope resolution. Focused canary/migration/evaluation checks are 9/9 PASS; full regression is 436/436 PASS; typecheck/build PASS; Chromium E2E 2/2 PASS; npm audit reports 0 vulnerabilities; `git diff --check` PASS. The AI cutoff remains `SALES_ORDER.DRAFT`.

- `V2CanaryIngressRouter` is now the sole app-wired inbound dispatcher. V2 selection is server-owned and requires `V2_CANARY_RUNTIME_ENABLED`, an existing customer identity, workspace authority in `V2_CANARY`/`V2_PRIMARY`/`LEGACY_RETIRED` with `authoritative_writer=V2` and no quarantine, and the complete durable rollout intersection for all seven frozen capability groups. The default remains OFF; fallback to V1 occurs before V2 queue claim.
- V2 ingress uses the provider-neutral `IncomingChannelMessage`, durable arrival sequencing/deduplication, turn bind, exclusive lease, side-effect fence, completion, and no V1 replay after claim.
- `V2CapabilityExecutor` maps the registered employee capabilities to existing WorkItem, OrderDraft, validation, quotation, CommitmentGuard/Commerce, and handoff services. Unknown or absent mappings fail closed; no staff lifecycle action is exposed. Runtime replies use the existing `OutboundMessageService` owner.
- Deterministic validation: full regression **433/433 PASS**, typecheck PASS. This is implementation readiness evidence only; it does not close this report.

- Browser Demo project/origin session: **PASS**. `DemoGatewaySession` obtained a short-lived session using project `whatsapp-erp-order-intelligence` and exact Origin `http://127.0.0.1:32111`; no private Gateway key was used or persisted.
- Real Demo GPT inference: **PASS** against model `demo-fast`.
- Project Pi intent path against real Demo GPT: **PASS** for the three critical semantic stages:
  - order with explicit line + tomorrow -> `offer_quote`, line present, delivery date present;
  - plain `Yes` -> `prepare_quote`, never acceptance;
  - explicit `OK confirm` -> `accept_quote`.
- Existing Baileys linked-device credentials under ignored `.data/whatsapp-auth-live`: **PASS** reconnect on 2026-09-11 without a new QR scan; adapter reached `connected`, `qrReady=false`, mode `whatsapp-qr`, `unofficial=true`.
- Historical 2026-09-08 V1 live evidence remains valid background evidence for real inbound, explicit customer binding, ERP-backed stock response, and real outbound WhatsApp reply, but it is **not** treated as completion of the V2-EVAL-003 fresh Golden journey.
- No Sales Order post/confirm or Delivery Order action was executed during this evaluation. AI cutoff remains `SALES_ORDER.DRAFT`.

## Pre-live Golden readiness with real Demo GPT (2026-09-11)

- **PASS — simulated channel only, not EVAL completion evidence.** Two fresh isolated `V2_CANARY` runs exercised the real `DemoGatewaySession` / `demo-fast` model through `V2CanaryIngressRouter -> V2TransportRuntime -> V2CapabilityExecutor` with all seven V2 rollout groups effective.
- Golden state sequence reached exactly: initial order -> current V2 OrderDraft with no quotation; plain `Yes please.` -> one quotation `SENT`; explicit `OK confirm.` -> the same quotation `ACCEPTED` plus exactly one `SALES_ORDER.DRAFT`; zero new `POSTED`, `CONFIRMED`, or `DO_READY` Sales Orders were created.
- Clean terminal behavior was observed for all three turns: order and acceptance ended at `PI_FINAL_PENDING_GROUNDING`; quotation send ended at host-owned `PI_CAPABILITY_OWNED_QUOTATION`.
- Demo request-size blocker is resolved without weakening host authority: model-facing capability guidance is compact while the host still validates the complete registered capability projection and full input schemas. The largest Golden prompt observed in the clean non-diagnostic run was 9,666 bytes.
- Runtime receiver-binding defect was fixed so the app-wired `DemoTextToolBridge.encodeHostCapabilityResult` keeps its bridge receiver instead of failing after a successful host capability result. A regression test now covers the exact app-style transport hook.
- Same-as-last-week flow now uses server-owned workflow sequencing and binds `previousSalesOrderId` only to an internal `get_order_history` `orders[].id`; display `salesOrderNo` cannot be substituted for the internal reference. This narrows model behavior without widening executor/CAP-003 authority.
- Final post-change validation: **442/442 tests PASS**, typecheck PASS, build PASS, Chromium E2E **2/2 PASS**, `npm audit` **0 vulnerabilities**, `git diff --check` PASS, the only direct `adapter.send(...)` owner file is `src/outbound-message-service.ts`, and no forbidden staff lifecycle capability is registered.
- Historical/live databases were not used as completion evidence and no real WhatsApp customer message was sent during these readiness runs.

## Remaining live/manual evidence

A fresh real customer must send the Golden sequence while the isolated evaluation service is connected:

1. order message with explicit product/quantity/UOM and delivery request;
2. `Yes` to request quotation preparation;
3. after the quotation is actually `SENT`, `OK confirm` as explicit acceptance.

PASS requires captured provider-backed inbound/outbound provenance, quotation `SENT`, quotation `ACCEPTED`, and exactly one `SALES_ORDER.DRAFT`, then the run stops. Staff post, SO confirm, and Delivery Order creation are forbidden for this evaluation.

This is an external/manual-input requirement and is not bypassed with simulated inbound or replayed historical messages.

## Meta Cloud API readiness gaps

The provider-neutral `ChannelAdapter` seam is ready and the business/domain layers do not import Baileys or Meta SDK payload types. However Meta is **not production-ready** yet:

1. No active Meta Cloud API adapter is implemented or instantiated; requested `meta-cloud` currently fails closed/falls back to the non-Meta runtime path.
2. Official webhook verification/authentication and request-signature validation are not implemented.
3. Meta webhook payload -> `IncomingChannelMessage` normalization is not implemented.
4. Graph API outbound submission and provider message-id/status mapping are not implemented.
5. Provider reconciliation/delivery-status callback handling for durable `PENDING/SUBMITTED/FAILED/UNKNOWN` recovery is not implemented.
6. Production configuration for WABA/phone-number identifiers, access-token lifecycle, webhook secret, versioning, rate limits/retries, and template policy is not implemented.
7. Meta media retrieval/authorization and provider-specific error mapping remain adapter work.

These gaps do not require commerce, Pi, ERP, database-document, or UI business-semantic changes; they belong behind the existing provider-neutral adapter contract.

## Current verdict

**PRE-LIVE READINESS PASS / EVAL NOT CLOSED.** Real Demo GPT Golden readiness, full regression, and real QR reconnect gates are green. EVAL-003 remains unchecked until a fresh provider-backed QR WhatsApp Golden journey reaches exactly `SALES_ORDER.DRAFT` and stops.
