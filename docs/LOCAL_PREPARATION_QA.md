# Local preparation verification

Branch: `preparation/real-cutover-readiness`; base `e6db4da4`. Isolated worktree `whatsapp-erp-local-prep`. No push, deployment, service changes, real database changes, pairing or authority activation occurred in this task.

## Changes

- `src/app.ts`: explicit paused startup skips channel connect and outbound reconciliation, drops inbound processing, rejects write HTTP methods with 503 and exposes startup mode in health.
- `public/index.html`: actual health-driven paused banner, hidden simulator and disabled writes, accurate QR-paused explanation; supported Bearer bootstrap staff dialog clears credential on success, failure and cancel, without page storage.
- `src/v2-identity-resolver.ts` and `src/commerce.ts`: shared existing canonical evidence lookup, no default customer, explicit phone plus customer ID required, resolve new conversations from verified bindings and retain conversation ownership/channel checks.
- Synthetic identity/startup tests and intercepted browser tests; two legacy fixtures now explicitly provide required customer/channel evidence.

## Results

Node 24.20.0 ARM64 full explicit offline suite: **1,021 passed, 0 failed**, 112.47 seconds. Browser suite: **5 passed**, including paused preview, credential clearing/header contract and existing boundary/parity tests. Typecheck/build/diff checks pass. Gitleaks redacted directory scan: no leaks found.

The first full run passed 1,018/1,021: two obsolete fixture assumptions were corrected and a retrieval timing threshold failed once. All 37 affected tests passed separately, then the entire 1,021-test suite passed. No thresholds or authorization checks were weakened.

Evidence under sibling `migration-evidence/`: `local-prep-tests-final.log`, `local-prep-recheck.log`, `local-prep-browser.log`, `local-prep-secret-scan-final.log`.

## Limits and next step

These are local synthetic/intercepted tests, not live WhatsApp evidence. Existing public runtime remains unchanged. Owner QR is not ready until reviewed publication/final sync/paused pairing launch. Refer to `REAL_MIGRATION_MILESTONES.md` for precise owner-only decryption/QR handoff, estimated downtime, separate V2 recipient scope and rollback. Recipient-specific enforcement remains a prerequisite to active real testing; no global or fixture-derived authority is approved.

## Owner QR control extension

Branch `preparation/owner-qr-controls`, worktree `whatsapp-erp-owner-qr`: adds verified existing Access-session owner action, reconnect/error/rate guards, QR expiry/disconnect clearing and a manual owner UI. Full offline suite: 1,024 passed; a subsequently added provider-error-redaction case passed in the 4/4 focused pairing suite. Browser QA: 7/7 passed. Typecheck/build, diff and redacted secret scan pass. Synthetic browser server now binds only loopback. Evidence: sibling `migration-evidence/owner-qr-tests.log`, `owner-qr-focused-final.log`, `owner-qr-browser.log`, `owner-qr-secret-scan.log`.

No live account pairing is claimed from these synthetic tests. Existing application audience was read from the protected hostname's official public Cloudflare login metadata; actual owner request must still carry a signed session valid for that exact audience. No auth tokens or private keys were read, persisted or printed.
