# V1 Verification Evidence

Date: 2026-09-08 (Asia/Singapore)

Architecture baseline: `28bd3bc3df5f4f6828cd6b4e37215ffb41f591fa`

## V1 result

The implementation satisfies the frozen V1 lifecycle:

`MESSAGE -> intelligence -> QUOTATION.DRAFT -> QUOTATION.SENT -> QUOTATION.ACCEPTED -> SALES_ORDER.DRAFT -> HUMAN POST -> SALES_ORDER.POSTED -> HUMAN/OPS CONFIRMATION -> DO_READY`

AI autonomy ends at `SALES_ORDER.DRAFT`. The Pi tool surface has no Sales Order post/confirm or DO action. Post-Draft transitions require a server-issued opaque staff capability, an explicit Sales Order target, and the required staff evidence/ordering guards.

## Deterministic validation gates

Final pre-commit candidate validation:

- `npm ci` — PASS.
- `npm audit --audit-level=high` — PASS, `0 vulnerabilities`.
- `npm run typecheck` — PASS.
- `npm test` — PASS, `31/31` tests, `0` failures after Browser Demo GPT integration and live-WhatsApp regressions were added.
- lint — N/A; no lint script is configured in V1.
- `npm run build` — PASS.
- `npx playwright test` — PASS, Chromium Golden storyline `1/1`.
- `git diff --check` — PASS.

The Chromium Golden path verifies customer message -> ERP-backed quote -> immutable stock display -> explicit acceptance -> Draft SO -> forged staff request rejected -> server-issued staff session -> double-confirm evidence -> POSTED -> CONFIRMED -> DO_READY.

Additional executable coverage includes account-scoped identity, duplicate inbound idempotency, forwarding/media rejection, vague-acceptance rejection at the service boundary, quote expiry/supersession, dynamic non-Golden product resolution, ERP tool-call/evidence linkage, stock-shortage rollback, repeated-SKU aggregate stock checks, durable outbound UNKNOWN recovery, same-client retry after proven `not_found`, terminal-send no-retry, unresolved-send serialization, concurrent `sendQuote` serialization, and terminal-quotation no-revival.

## Independent reviewer

`docs/INDEPENDENT_REVIEW.md` is the persisted independent review report.

Final reviewer verdict: **PASS**.

- P0: 0
- P1: 0
- Prior P1 staff-auth/service-target, quotation-send serialization/lifecycle, and duplicate weaker commerce implementation findings were all re-checked as remediated.
- Remaining P2 items are non-blocking demo/operability advisories and do not weaken the frozen V1 human commitment boundary.

The reviewer's own sandbox could not launch Playwright because its isolated tsx IPC pipe returned `EPERM`; this does not replace or invalidate the separate VMMCP Chromium execution above, which passed `1/1` on the same candidate.

## Real Baileys QR smoke

Package: `@whiskeysockets/baileys@7.0.0-rc14`.

A real network smoke used the QR adapter with an isolated ignored auth directory. The adapter reached the WhatsApp registration channel and produced a scannable PNG data URL:

- mode: `whatsapp-qr`
- unofficial/demo-only: `true`
- account id: `demo-account`
- `qrReady: true`
- latest observed QR data URL length: `7174`

This proves the linked-device QR generation path, `connection.update` plumbing, persisted auth-state path, and QR rendering source can run against WhatsApp infrastructure.

A later live run on 2026-09-08 completed the previously manual channel checks:

- physical phone QR scan — PASS; linked-device session reached `connected` and persisted under ignored `.data/`.
- real inbound WhatsApp text — PASS; unknown sender was persisted and failed closed with the linked-customer clarification.
- explicit demo-customer binding — PASS; after binding the observed sender to `CUST-001`, no re-scan was required.
- real Golden order inbound — PASS; the ERP-backed flow replied `Stock is available. Shall I prepare a quotation?`.
- real outbound WhatsApp replies — PASS.

That live run also exposed a real UX bug: plain `Yes` was not treated as permission to prepare the quotation. The regression is now fixed and covered so `Yes`, `Yes please`, `Please proceed`, and `Prepare quotation` mean `prepare_quote`, while acceptance still requires the independent explicit-acceptance guard.

## GPT Gateway smoke

Environment-only configuration remains the rule. No `gw_…`, provider key, or `dmo_…` token is stored in the repository.

The Browser Demo contract from the Gateway User Guide is now implemented directly:

1. `POST /demo/session` with exact configured `Origin` and `project_id`;
2. keep the short-lived `dmo_…` token in memory only and refresh once on inference `401`;
3. `POST /demo/v1/responses` with the exact minimal text-only body `{ model: "demo-fast", input }`;
4. send no tools, stored-response flag, structured-output contract, files, images, or other disabled Demo capabilities;
5. parse the assistant's plain-text JSON through a strict local schema before deterministic ERP logic runs.

Observed against `https://gpt.yapweijun1996.com` on 2026-09-08:

- `GET /healthz` -> HTTP `200`.
- demo inference without a session -> HTTP `401`, as expected.
- the implemented `DemoGatewaySession` calling `POST /demo/session` for project `whatsapp-erp-order-intelligence` with origin `http://127.0.0.1:32111` -> HTTP `403`, mapped to `DEMO_GPT_ORIGIN_UNREGISTERED`.

Therefore the remaining live-model blocker is **Demo project/origin registration**, not a missing private Gateway credential. The application must not spoof another registered Origin or bypass this control.

## Current integration packages

- `@earendil-works/pi-agent-core@0.85.1`
- `@earendil-works/pi-ai@0.85.1`
- `@whiskeysockets/baileys@7.0.0-rc14`
- `@fastify/static@10.1.3`
- `qrcode@1.5.4`

The deprecated `@mariozechner/pi-agent-core` is not used.

## Remaining external/manual checks

1. Register Demo project `whatsapp-erp-order-intelligence` with exact Origin `http://127.0.0.1:32111` in the Gateway's `demo_projects` configuration.
2. Re-run the already-linked WhatsApp live flow with `DEMO_GPT_ENABLED=true` and verify production `demo-fast` performs the Pi interpretation.
3. Complete the real channel sequence `Golden order -> Yes -> quotation SENT -> OK confirm -> quotation ACCEPTED -> SALES_ORDER.DRAFT`, then stop at the frozen AI boundary.

No private `gw_…` credential is required for this Browser Demo path. These remaining checks depend on the Gateway's exact-origin registration control; they must not be bypassed.
