# GO Contract — FROZEN V1

Status: **FROZEN FOR IMPLEMENTATION — ASTRA PASS 2026-09-07**

## Mission
Implement the complete documented V1 of WhatsApp ERP Order Intelligence and produce executable evidence, not scaffolding-only progress.

## Authority order
1. `AGENTS.md`
2. this `GO_CONTRACT.md`
3. `DESIGN.md`
4. remaining `docs/*.md`

If documents appear inconsistent, stop the affected path and preserve the stricter safety/business boundary. Do not invent a new lifecycle.

## Dynamic routing
Use configured VMMCP/Codex roles; do not hard-code models:
- worker: bounded repetitive/simple tasks
- explorer: investigation/context
- engineer: primary implementation/debugging/tests
- architect: cross-system design decisions
- reviewer: independent critical review

## Frozen lifecycle
`MESSAGE -> intelligence -> QUOTATION.DRAFT -> QUOTATION.SENT -> QUOTATION.ACCEPTED -> SALES_ORDER.DRAFT -> HUMAN POST -> SALES_ORDER.POSTED -> HUMAN/OPS CONFIRMATION -> DO_READY`.

## Frozen approval boundary
AI may create `SALES_ORDER.DRAFT` only. No AI-facing tool or API route may post/confirm a Sales Order or create a DO. Staff-only action is required after Draft SO. Chat-only human access does not satisfy commercial staff authorization: POST, CONFIRM and DO each require their own permission. Scoped chat SEND, TAKEOVER and RESUME each require their own unexpired, unrevoked capability for the exact canonical account/conversation.

## Required implementation properties
- QR demo and future Meta adapter share one provider-neutral contract.
- CI/browser tests may use a simulated channel adapter; real QR is not required for automated CI.
- Pi Agent Core talks through configurable GPT Gateway transport.
- ERP truth is deterministic and tool-backed.
- all document totals/UOM conversions are deterministic.
- V1 staff posting hard-blocks on stock shortage and atomically rechecks/deducts stock with SO transition/audit.
- each quotation line carries immutable references to the exact ERP evidence used.
- outbound intent is durable before provider submission; unresolved send state never blind-resends or marks a quote SENT. Provider `submitted` -> outbound SUBMITTED + quote SENT + replacement supersession + audit is one atomic DB finalization transaction.
- explicit customer acceptance must be evidenced and bound to the active sent quotation.
- audit/provenance spans message -> quote -> acceptance -> Draft SO -> staff action.
- UI presents readable agent activities, never raw JSON as the primary experience.

## Required validation
- dependency install succeeds;
- typecheck/lint if configured;
- unit tests;
- integration tests;
- Golden business-flow tests;
- negative test proving AI cannot post Sales Order;
- browser E2E of Golden storyline using simulated channel;
- production build;
- independent reviewer report.

## Definition of done
Do not claim done from file existence. Done requires all required validations green plus an independent reviewer finding no unresolved P0/P1 contract violations. If an external credential/QR/network issue blocks an optional real-channel smoke, document it separately; it does not replace deterministic adapter/E2E proof.


## Architecture freeze evidence
Astra final architecture review: `docs/ASTRA_DESIGN_REVIEW_4_PASS.md` — VERDICT PASS. All prior P0/P1 findings resolved before implementation. Non-blocking P2 advisories were incorporated before this freeze.
