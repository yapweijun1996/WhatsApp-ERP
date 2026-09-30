# Independent Architecture / Security / Reliability Review

## Reviewed baseline/current HEAD

Baseline: frozen commit `28bd3bc3df5f4f6828cd6b4e37215ffb41f591fa`.

Current HEAD resolves to `28bd3bc3df5f4f6828cd6b4e37215ffb41f591fa`; the implementation is in the dirty working tree. Existing changes were reviewed but not modified. `package-lock.json` was not read.

## P0

None identified.

## P1

None identified after remediation.

## P2

1. Non-quotation clarification replies are sent asynchronously without durable outbound intent/result tracking (`src/commerce.ts:17-18`). A process failure can lose or duplicate a clarification; durable PENDING/UNKNOWN handling is implemented for quotation sends.

2. QR customer binding depends on `WHATSAPP_QR_CUSTOMER_PHONE` before creating the configured demo identity (`src/commerce.ts:80-90`). This is fail-closed and safe, but the manual QR demo is not self-contained without deployment configuration.

3. The staff-session endpoint issues a staff session without an external login/authentication step (`src/app.ts:27-29`). This is acceptable for the explicitly demo-only UI, but production deployment needs real staff authentication before exposing the route.

4. The live Gateway path is selected only when both model and base URL environment variables are present; otherwise the deterministic faux provider is used (`src/pi-agent.ts:94-97`). Operational status does not expose this mode, so a demo run could be mistaken for a live Gateway run.

5. Browser E2E could not start in this sandbox because the Playwright web server failed to create the tsx IPC pipe with `listen EPERM /tmp/tsx-1000/78.pipe`. This is an environment limitation; deterministic unit/integration evidence remains available.

## Prior-P1 remediation check

1. **Staff boundary: remediated.** `createStaffCapabilityAuthority()` issues frozen opaque object capabilities tracked by a private `WeakMap`; verification rejects request-body strings and unrelated objects (`src/staff-auth.ts:1-21`). The app stores the capability outside request JSON in the server-side session map and passes it to the service (`src/app.ts:20-29`). `CommerceService.staff()` independently verifies the capability and requires a non-empty explicit `salesOrderNo`; it has no latest-order or literal fallback (`src/commerce.ts:248-255`). Tests cover forged capability, missing target, and direct service invocation (`tests/commerce.test.ts:14`, `tests/server.test.ts:5-31`).

2. **Quotation send/finalization/reconciliation: remediated.** Public `sendQuote()` resolves the conversation and runs under the per-conversation lock (`src/commerce.ts:185-188`). `sendQuoteUnlocked()` returns existing PENDING/UNKNOWN/SUBMITTED attempts, requires `DRAFT`, rejects expired drafts before provider submission, and uses a stable client id (`src/commerce.ts:190-212`). Finalization is transactional and requires the target quotation still be `DRAFT` before setting SUBMITTED/SENT and superseding the prior quote (`src/commerce.ts:214-231`). Reconciliation uses the same conversation lock and calls finalization without resending (`src/commerce.ts:232-245`). Direct concurrent calls, terminal-quote protection, unknown-send recovery, and same-client retry are tested (`tests/commerce.test.ts:17,30,32,39,41`).

3. **Duplicate weaker DemoStore surface: remediated.** No `DemoStore`, `domain.ts`, or second commerce implementation/test surface remains in `src/` or `tests/`; the only commerce implementation is `CommerceService` (`rg` review; `src/commerce.ts`, `tests/commerce.test.ts`).

## Evidence summary

- AI autonomy ends at Draft SO: the Pi tool surface contains only `interpret_order`, while forbidden post/confirm/DO tool names are excluded (`src/pi-agent.ts:15-19,44-71`); service-side staff transitions are separate (`src/commerce.ts:248-287`).
- Acceptance is independently guarded for explicit text, active SENT quote, account/conversation/customer identity, message ordering, expiry, reply correlation, forwarding, media, unresolved outbound state, and exactly-once acceptance/SO transaction (`src/commerce.ts:104-119,141,247`; `schema.sql:5,16,20-21`).
- ERP truth is deterministic and database-backed, including product/UOM/price/stock/history lookup on non-Golden inputs (`src/erp.ts:3-27`); tool-call records, evidence hashes, line roles, immutable snapshot/hash, and quote lines are persisted (`src/commerce.ts:42-59,167-180`; `schema.sql:15-20,28`).
- Outbound quotation intent is durable before provider submission; unknown/PENDING states block duplicate send/acceptance, reconciliation uses the same stable client id, and submitted finalization is atomic (`src/commerce.ts:168-245`; `schema.sql:23`).
- Staff posting aggregates demand by product, rechecks all stock before deduction, deducts and transitions in one transaction, records evidence/audit, and supports stable idempotency (`src/commerce.ts:248-287`; `schema.sql:13,21,25`).
- Provider isolation and normalization cover provider-neutral messages, media metadata, forwarding, reply correlation, LID/alternate JID handling, Baileys auth/credential updates, reconnects, and `messages.upsert`; QR is explicitly unofficial (`src/channels.ts:5-9,25-59`).
- The UI presents readable activities/documents and exposes the human POSTED -> CONFIRMED -> DO_READY path (`public/index.html:1-20`; `tests/e2e/golden.spec.ts:16-54`).
- Verification: `npm test` passed (3 test files, 0 failures); `npm run typecheck` passed; `npm run build` passed. Browser E2E was blocked only by the sandbox IPC-pipe permission failure recorded above. No physical-phone or authenticated Gateway smoke was required for this deterministic review.

VERDICT: PASS
