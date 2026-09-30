# V2 Implementation Baseline

Date: 2026-09-08 (Asia/Singapore)
Architecture/package baseline: `3a5b33e4014418b19f50ea7fa9b44143796a2778`
Scope: V1 executable regression + V2 implementation gate bookkeeping only.

## Gate result

- `V2-GATE-001A` — **PASS**. The owner explicitly authorized V2 implementation in this conversation on 2026-09-08.
- `V2-GATE-002` — **PASS**. The V1 executable baseline was re-run from the clean architecture commit and independently repeated after one transient environment failure.
- V2 runtime/schema implementation had not started at the time this baseline was captured.

## Exact baseline evidence

| Command | Final result | Evidence |
|---|---|---|
| `git status --short` | PASS | clean before baseline bookkeeping |
| `git rev-parse HEAD` | PASS | `3a5b33e4014418b19f50ea7fa9b44143796a2778` |
| `npm run typecheck` | PASS | `tsc --noEmit` exited 0 |
| `npm test` | PASS | 31/31 tests, 0 failures |
| `npm run build` | PASS | `tsc` exited 0 |
| `npx playwright test` | PASS | Chromium Golden storyline 1/1 |
| `npm audit --audit-level=high` | PASS | 0 vulnerabilities |
| `git diff --check` | PASS | no whitespace errors |

A first automated baseline attempt transiently reported a Node/native cleanup assertion, a snap launcher error, and npm registry `EAI_AGAIN`. These were treated as environment evidence, not product failures, because the same workspace had passed earlier. Immediate direct reproduction then passed the focused commerce suite (20/20), full suite (31/31), Playwright Chromium (1/1), and audit (0 vulnerabilities) without source/runtime changes. The passing repeat is the baseline gate evidence.

## Frozen V1 invariants carried into V2

- Canonical lifecycle remains `MESSAGE -> intelligence -> QUOTATION.DRAFT -> QUOTATION.SENT -> QUOTATION.ACCEPTED -> SALES_ORDER.DRAFT -> HUMAN POST -> SALES_ORDER.POSTED -> HUMAN/OPS CONFIRMATION -> DO_READY`.
- AI autonomy ends at `SALES_ORDER.DRAFT`. No AI-facing post-SO, confirm-SO, Delivery Order, or `DO_READY` capability may exist.
- Customer/SKU/UOM/conversion/price/stock/totals/document numbers remain deterministic ERP/service truth; the model may never invent them.
- Explicit customer commitment remains independently guarded and bound to canonical active quotation evidence; exactly one accepted quotation may create one Draft SO without repricing.
- Quotation outbound intent remains durable before provider submission; unresolved `PENDING/UNKNOWN` never blind-resends and blocks acceptance eligibility when applicable.
- WhatsApp/provider-specific payloads remain isolated at the channel adapter; domain receives provider-neutral messages.
- Immutable provenance/evidence continues from inbound message -> ERP evidence -> quotation -> acceptance -> Draft SO -> staff actions.
- Existing server-issued opaque staff authority remains outside AI control.

## Implementation start rule

Phase 0 may now begin. Every V2 implementation slice must preserve this baseline, remain feature-flag/strangler compatible, add executable evidence, and stop on any V1 invariant regression. No push, deploy, publication, or remote mutation is authorized by this gate.
