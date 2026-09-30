# V3-RET-001 Review — ACCEPTED COMPLETE

Status: **ACCEPTED COMPLETE — authorized Phase4=A shadow-only scope**

Date: 2026-09-15 (Asia/Singapore)

RET-001 is accepted complete as a shadow-only, schema-free extension of the existing V3-CTX-004 conversation-memory service. It adds section reopen/navigation over the existing V1/V2 `messages` source evidence. Owner authorization is already recorded as `Phase4=A` for bounded shadow-only work. RET-002 and later were not started. The V3 status remains **PROPOSED** and shadow-only; AI authority remains capped at `SALES_ORDER.DRAFT`.

## Evidence

Focused and dependency regression command:

```text
npm test -- tests/v3-conversation-memory.test.ts tests/v3-context-shadow-eval.test.ts tests/v3-context-snapshot.test.ts
```

Controller focused/dependency regression: **21/21 PASS**.

Controller full regression: **673/673 PASS**.

The RET-001 cases cover exact source reopening, deterministic chronology independent of storage row identity, non-authoritative output, deep immutability/detachment, tampered provenance, foreign scope, duplicate refs, and unavailable (`NULL`/redacted) source text. Existing CTX-004 coverage remains in the same dependency regression set.

## Independent review finding and bounded remediation

The initial independent review identified **P1=1**: `build()` accepted a scoped source row with `text=NULL`, while source evidence converted it to an empty string; `openSection()` then rejected the resulting source-linked memory. This violated deterministic reopen-to-source for memories built from unavailable source text. The P1 NULL-source gap was remediated.

The bounded remediation makes `build()` fail closed with the existing `SOURCE_MESSAGE_UNAVAILABLE` semantics whenever any referenced source row has `text=NULL`, and adds focused regression coverage. No schema, migration, runtime/customer wiring, authorization, or task-ledger changes were made.

Fresh independent read-only review job: **SUCCEEDED**. It returned `codexOutcomeStatus=PASS` and `validation=PASS` under the review contract **PASS iff P0=0 and P1=0**. Final independent review: **P0=0, P1=0**.

Additional validation:

Controller focused/dependency regression: **21/21 PASS**; controller full regression: **673/673 PASS**.

```text
npm run typecheck
```

Result: **PASS**.

```text
npm run build
```

Result: **PASS**.

```text
git diff --check
```

Result: **PASS**.

Authority scans found the existing direct provider adapter sends only in `src/outbound-message-service.ts`; RET-001 adds no provider send path. The changed V3 source contains no customer-language intent keyword/regex logic and no Sales Order POST/CONFIRM or Delivery Order authority. No schema, migration, runtime wiring, customer-visible traffic, canary, deployment, release/promotion, Phase 5 extraction/OCR/vision/audio wake, or new authority owner was added.

## Contract and fail-closed behavior

- Reopen requires the requested account/conversation to match the memory scope.
- Current scoped source rows are re-read from the existing `messages` table.
- Missing, cross-scope, malformed, unavailable/redacted, direction-invalid, out-of-order, or duplicate references fail closed.
- CTX-004 derivation and projection hashes are revalidated, so stale/tampered section fields or provenance cannot be reopened.
- Raw messages are returned in deterministic `arrival_seq`, then `occurred_at`, external-message-ID, and message-ID order; SQLite rowid is not used.
- Returned arrays/objects are detached and deeply frozen. Sections remain `NON_AUTHORITATIVE_DERIVED` and require canonical reverification.

## Risks and exclusions

P0 self-identified risks: **none observed** in the bounded evidence. The implementation does not introduce a new raw-message ledger or authorization surface.

P1 self-identified risks:

- The current schema has no explicit deleted/redacted marker. RET-001 treats a missing row or `NULL` message text as unavailable, but a future retention/access authority must expose any additional revocation state before retrieval is widened.
- Fresh independent read-only re-review completed SUCCEEDED with `codexOutcomeStatus=PASS`, `validation=PASS`, and final **P0=0/P1=0** under the stated review contract.
- No persistent index, migration/rollback, benchmark, runtime integration, or customer-traffic evidence is claimed; those belong to later RET tasks or separate gates.

## Review decision

RET-001 is **ACCEPTED COMPLETE** for the already authorized `Phase4=A` bounded shadow-only scope. Acceptance is based on final independent **P0=0/P1=0**, controller focused/dependency **21/21 PASS**, controller full regression **673/673 PASS**, typecheck **PASS**, build **PASS**, and `git diff --check` **PASS**. RET-002 remains unchecked/unstarted. V3 remains **PROPOSED** and shadow-only; no runtime/customer traffic, schema change, post-`SALES_ORDER.DRAFT` authority, Sales Order POST/CONFIRM, Delivery Order creation/progression, or competing outbound owner was introduced. The existing sole `OutboundMessageService` remains the outbound/provider-send owner.
