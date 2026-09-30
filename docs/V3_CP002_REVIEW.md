# V3 CP-002 Review — Shadow Adaptive Bundling

Status: **PASS — P0=0 / P1=0; shadow-only**
Date: 2026-09-14 (Asia/Singapore)

## Scope and implementation

`src/v3-inbound-bundle.ts` adds a pure `V3-CP-002` projection over V2 arrival-ordered metadata. It uses only message ID, V2 `arrivalSeq`, and Host receipt timing; customer text, keywords, regexes, intent labels, and provider payloads are not inputs. The quiet-window decision uses only history already accepted into the bundle; an accepted gap tunes the subsequent window. Quiet windows are deterministically bounded to 800–1500 ms. A 3000 ms hard cap is measured from the first arrival. Collectable bubbles extend the current projection and advance its bundle revision; hard-cap and side-effect-start boundaries begin separate projections.

The projection is detached and immutable, fails closed on invalid timestamps/configuration/order, and is explicitly `NON_AUTHORITATIVE_SHADOW`. Independent verification found and remediated two timing defects: prospective gap timing could influence its own admission, and candidate-loop precedence could report `HARD_CAP` even when the already-existing quiet deadline was earlier. Admission now uses only the earliest deadline owned by the accepted history, with deterministic `>=` closure and hard-cap tie precedence. CP-001 `InboundBundle` remains the bundle contract: the integration test feeds the CP-002 message set into `buildInboundBundle`. The narrow `readAdaptiveArrivalsFromV2Receipts` helper reads only existing `v2_inbox_items.created_at` plus `arrival_seq`; it deliberately does not read provider `messages.occurred_at`. This strengthens Host receipt ownership without schema or runtime wiring. V2 `arrival_seq`, `v2_inbox_items`, and existing enqueue dedupe remain the only chronology/dedupe authority. No schema, runtime, queue mutation, lease, side-effect, outbound, ERP, canary, or deployment wiring was added.

## Evidence

- CP-001/CP-002 focused file: **21/21 tests pass** — 5 CP-001 and 16 CP-002, including a fixed 64-burst property-style corpus.
- Relevant V2 queue file: **20/20 tests pass**.
- Full `npm test`: **543/543 tests pass** (the prior independent run’s 541/541 count was before the final two boundary-precedence cases).
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.
- Direct `adapter.send(...)` owner scan: occurrences remain only in `src/outbound-message-service.ts`.
- Lifecycle guard scan: existing POST/CONFIRM Sales Order and Delivery Order restrictions and `SALES_ORDER.DRAFT` cutoff remain present.
- `schema.sql` SHA-256 before/after: `5a811cca49edf060c7b41521f8d8496121c06485bc6472535f39b962405f80eb` / `5a811cca49edf060c7b41521f8d8496121c06485bc6472535f39b962405f80eb`.

## Required behavior covered

Single-message quiet close; rapid-burst extension; quiet-gap split below hard cap; accepted-history adaptive split at the exact boundary; sustained-burst hard-cap precedence; deterministic replay; exact arrival ordering; bounded timing; text/keyword independence; V2 duplicate/redelivery stability; Host `created_at` receipt timing and provider `occurred_at` independence; post-hard-cap collection; side-effect-start collection boundary; immutable output; fixed property-style burst invariants; and fail-closed invalid timestamps/configuration.

## Self-review and ledger

- P0: **0** — no authority widening, provider-send ownership change, customer-visible behavior, schema change, or forbidden Sales Order/Delivery Order capability.
- P1: **0** — no second chronology/dedupe owner; no customer-language classification; no runtime wiring; no raw content telemetry; no mutable projection output.
- Task ledger: **V3-CP-002 complete**. **V3-CP-003..007 remain open and unauthorized** for this continuation. `docs/CONVERSATION_INTELLIGENCE_V3.md` remains **PROPOSED**.
