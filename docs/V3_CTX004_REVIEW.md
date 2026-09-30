# V3 CTX-004 Review — Source-Linked Sections and Rolling Memory

Status: **PASS — shadow-only, non-authoritative derived state**

Independent initial implementation review: **FAIL — P0=0/P1=2**.

The two P1 findings were remediated:

- SQLite `rowid` no longer participates in source ordering, source evidence, or `derivationVersion`; ordering uses durable `arrival_seq` when both rows have it, then parseable `occurred_at`, `external_message_id`, and message `id`.
- Empty source provenance is rejected. Every section requires at least one exact valid source message, and rolling memory requires a direct source message or valid section reference; section-only provenance remains supported.

## Scope and invariants

`src/v3-conversation-memory.ts` accepts only a bounded semantic derivation proposal. The proposal supplies section title/topic/summary and exact message IDs, plus rolling-memory text and exact message/section references. The Host validates the canonical account/conversation and every message from the existing `messages` table, rejects missing/foreign/deleted sources, duplicate or out-of-order references, invalid section references, unsafe object shapes, accessors, cycles, and custom prototypes, then redacts bounded plain text.

The result is detached and deeply frozen, marked `NON_AUTHORITATIVE_DERIVED`, `untrustedAsInstruction`, and `requiresCanonicalReverification`. Raw messages remain the source of truth; sections and memory are navigation/continuity aids only. They do not provide price, stock, identity, quotation, Sales Order, Delivery Order, capability, or effect authority. Sections are reopenable by their exact source message IDs.

The derivation version hashes the contract/schema, sanitized proposal, and canonical source message evidence/provenance. Retained source plus proposal rebuilds identically across different physical SQLite rowids and unrelated insert history; changed source content or chronology changes the version. A missing source cannot be resurrected by rebuild.

## Evidence

- `tests/v3-conversation-memory.test.ts`: deterministic rebuild, cross-database rowid-independent derivation/version and projection hash, exact/non-empty provenance including section-only rolling memory, scope/missing/deleted-source rejection, ordering/duplicates/section-ref validation, redaction, accessor/cycle/custom-prototype safety, detachment/deep freeze, authority/effect absence, and no hardcoded semantic keyword logic.
- No schema or persistence table was added.

Final remediation evidence:

- focused CTX-002/003/004/005 tests: **27/27 PASS**;
- full regression: **520/520 PASS**;
- `npm run typecheck`: **PASS**;
- `npm run build`: **PASS**;
- built `dist/v3-conversation-memory.js` import: **PASS**;
- `git diff --check`: **PASS**;
- direct `adapter.send(...)` owner scan: only `src/outbound-message-service.ts`;
- forbidden Sales Order POST/CONFIRM / Delivery Order capability guard: **PASS**;
- final independent read-only review: **PASS — P0=0 / P1=0**.


## Limitations and bounded deferrals

This task does not invent or validate an attachment-source contract; attachment integration remains a later Phase 5 task. It also does not add retrieval indexes, runtime wiring, persistence, segmentation, or customer-visible behavior. AI/deriver proposes semantics; this Host contract validates scope, provenance, ordering, bounds, and safe data only.

There are no customer-visible V3 effects, no outbound ownership changes, and no Sales Order post/confirm or Delivery Order path. V3 remains PROPOSED and the AI cutoff remains `SALES_ORDER.DRAFT`.
