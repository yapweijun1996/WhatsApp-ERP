# V3-RET-002 Review

Status: **ACCEPTED COMPLETE**

Date: 2026-09-15 (Asia/Singapore)

RET-002 is implemented as a schema-free, disposable in-memory derived index over already-authorized `messages` evidence and RET-001 source-linked sections. V3 remains **PROPOSED** and shadow-only. No runtime/customer traffic, activation, canary, deployment, release, promotion, or authority change was made.

## Implementation evidence

RET-002 remediation files:

- `src/v3-retrieval-index.ts`
- `tests/v3-retrieval-index.test.ts`
- `docs/V3_RET002_REVIEW.md`

The public `V3RetrievalIndexInput` is Host-derived-only: caller-facing `V3RetrievalObjectRef` and `objectRefs` are not exported or accepted by the TypeScript input contract. Runtime defense-in-depth still rejects an object annotation supplied through an untyped/dynamic caller with `OBJECT_ANNOTATION_CALLER_INPUT_FORBIDDEN`.

The index contract exposes deterministic chronological entries, normalized-term postings (a shadow semantic index, not semantic truth), Host-derived entity postings from existing scoped canonical business rows with exact indexed source-message linkage, attachment pointers derived only from existing authorized message ` raw_ref ` metadata and never caller-supplied source refs, RET-001 section postings, reply/external-ID linkage with deep-chain roots, exact source IDs and reopen references, and version/fingerprint metadata. Caller-supplied object/entity annotations are rejected before any posting can be created.

Before any section-derived state is consumed, RET-002 calls the shared RET-001 memory validator. It rechecks exact derivation version, projection hash, section/source membership, titles/topics/summaries, rolling references, chronology, scope, and current source availability. Reopen now requires an explicit current RET-001 memory projection, validates it with the shared validator, requires exact account/conversation plus derivation-version/projection-hash equality with the index, and requires exact deterministic equality between the source IDs derived from validated current memory and `index.sourceMessageIds` before reopening. It recomputes current Host-derived entity postings and fingerprints; a self-consistent forged/rehashed index cannot add a source outside the validated memory projection. A self-consistent caller hash is not treated as source authority. WORK_ITEM postings require the current conversation's canonical customer binding; a null binding emits no business entity postings.

Every result is marked `NON_AUTHORITATIVE_DERIVED`, `untrustedAsInstruction: true`, and `requiresCanonicalReverification: true`. Rebuilds read current source evidence again; no index table, cache, database column, migration, or persistent derived ledger was added. Source reopen rejects missing, unavailable, out-of-scope, or stale evidence.

## Tests and commands

Focused RET-001 dependency slice:

```text
npm test -- tests/v3-retrieval-index.test.ts tests/v3-conversation-memory.test.ts
```

Result: **2/2 test files PASS** (the runner reported `tests 2`, `pass 2`, `fail 0`).

The RET-002 tests cover all five forms, deterministic version/rebuild metadata across independent databases, exact provenance/source reopen, rejection of a self-consistent forged/rehashed source set that adds a same-account/same-conversation message outside current validated memory, chronology, deep reply roots and cycle safety, shared RET-001 memory provenance rejection (including tampered derivation/projection/section refs), compile-time and runtime caller entity annotation rejection, Host-derived canonical entity postings with exact indexed source linkage, foreign/unindexed row exclusion, normalized semantic terms, raw-ref-only attachment derivation and caller attachment rejection, non-authoritative/disposable semantics, stale source rejection, and malformed/unavailable input negatives.

Required repository checks:

```text
npm test
npm run typecheck
npm run build
git diff --check (scoped to the two acceptance documents)
```

Results: focused RET-001/RET-002 tests **PASS**; full regression **PASS**; `typecheck` **PASS**; `build` **PASS**; and the scoped `git diff --check` terminal **SUCCEEDED**.

Full regression:

```text
npm test
```

Result: **full regression PASS**.

## Safety-boundary verification

- No `schema.sql` or database migration was changed. Persistent schema/index tables were not needed; rollback is disposal by dropping the in-memory object and rebuilding from source evidence.
- `schema.sql` was already pre-existing dirty state at task start and remains untouched; no RET-002 schema/index diff was introduced.
- No runtime/customer traffic, V3 activation, canary, deployment, release, promotion, or provider integration was added.
- No Phase 5 OCR, vision, PDF/document parsing, media/audio extraction, transcription, async extraction wake, or extraction completion event was added.
- No RET-003 server-derived scope authority, RET-004 retrieval tools, RET-005 ladder, RET-006 loop, RET-007 invalidation, or RET-008 closure was implemented.
- No commerce authority was added beyond `SALES_ORDER.DRAFT`; no Sales Order POST/CONFIRM or Delivery Order path was added.
- `OutboundMessageService` remains the sole provider/send owner; the new source contains no adapter send authority.
- Historical/derived index results remain evidence candidates and cannot authorize side effects or replace current ERP truth.

Safety scans: direct `adapter.send` references resolve only to `src/outbound-message-service.ts`; the RET-002 source/test surfaces contain no send, post/confirm, Delivery Order, Phase 5 extraction, canary, or customer-traffic wiring.

## Residual boundaries / closure

The remediation addresses P1-01 (customer-bound work-item postings and null-customer suppression), P1-02 (current-memory and Host-entity reopen revalidation), and P1-03 (truthful runner evidence) in this bounded surface. Independent review verified the shared memory validator, source fingerprint/reopen behavior, canonical entity-row change/deletion detection, deep reply handling, and that normalized terms and object annotations remain clearly non-authoritative. RET-003 still owns server-derived scope enforcement; this implementation does not expose a retrieval tool or authorize model-supplied scope.

The exact-source provenance bypass identified as P1 was remediated: reopen derives source IDs from validated `currentMemory` and requires exact equality with `index.sourceMessageIds`. The adversarial self-consistent forged/rehashed extra-source regression **PASS**.

Fresh independent codex-readonly review job `3e403238-caaa-4531-b606-c19f22e30c37` terminal **SUCCEEDED**, with `codexOutcomeStatus=PASS` and `validation=PASS`. Zero-command verdict extraction job `b362cf1b-4489-4798-b36a-a56a20c6e1fb` returned structured status **PASS** and exact summary `NO P0/P1 FINDINGS`, under the contract PASS iff P0=0 and P1=0.

## Final acceptance

RET-002: **ACCEPTED COMPLETE**. Final independent review verdict: **P0=0, P1=0**. Focused RET-001/RET-002 tests, full regression, typecheck, build, and scoped documentation `git diff --check` all passed/succeeded as recorded above.

RET-003 and all RET-003+ work remain unstarted. No runtime/customer traffic, canary, deploy/release, Phase 5 multimodal work, or authority widening was performed. V3 remains **PROPOSED** and shadow-only; AI authority remains capped at `SALES_ORDER.DRAFT`, and `OutboundMessageService` remains the sole outbound owner.
