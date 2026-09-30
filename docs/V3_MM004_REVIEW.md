# V3 MM-004 Review

Status: **ACCEPTED COMPLETE — GOAL-FIRST FAST TRACK / SHADOW-ONLY**

Date: 2026-09-19 (Asia/Singapore)

## Delivered

- Added `src/v3-attachment-retrieval.ts`, a pure Host-owned in-memory `attachment_search` / `attachment_read` surface over immutable MM-001 sources and successful MM-003 extraction records.
- Enforced exact tenant/account/channel/conversation/customer scope binding, closed requests, accessor/proxy rejection, deterministic token search, small limits, deep immutable results, and evidence/source/extraction fingerprint coherence.
- Returned source-linked evidence citations with evidence ID, attachment ID, source message/ref, location fields, and freshness state.
- Preserved `UNTRUSTED_CUSTOMER_EVIDENCE`, `NON_AUTHORITATIVE_DERIVED`, `grantsEffects=false`, `requiresCanonicalReverification=true`, and `SALES_ORDER.DRAFT` authority cutoff. Hostile prompt-injection text remains data only.
- Added `tests/v3-attachment-retrieval.test.ts` covering all five extraction families, scope/request injection, tampering, hostile content, limits/no-match, and deep immutability.

## Scope exclusions

No embeddings, provider/network calls, persistence/schema migration, runtime/customer wiring, production traffic, deployment, or authority beyond `SALES_ORDER.DRAFT` were added.

## Evidence

- Focused MM-004/MM-001/MM-002/MM-003 tests: **24/24 PASS** after remediation of the reviewer-found multi-extraction `evidenceId` collision.
- MM-004 tests alone: **5/5 PASS**.
- Typecheck: **PASS** (`npm run typecheck`).
- Scoped `git diff --check`: **PASS** for MM-004 touched files.

## Independent review and remediation

- Independent Claude read-only review identified **P0=0** and one **functional-blocking P1**: MM-002 `evidenceId` omitted extraction class/location, causing duplicate IDs for multi-page or multi-extraction attachments when MM-004 keyed reads by `evidenceId`.
- Remediation expands evidence identity with `mediaType`, `extractionType`, `pageNumber`, `regionRef`, `boundingBox`, and `timeRange`, and adds direct multi-page same-attachment search/read coverage.
- The remaining reviewer findings are non-blocking backlog under Goal-First Fast Track.

## Non-critical backlog

- P2: The shadow factory intentionally requires Host-supplied scope, source arrays, and extraction arrays to already be deeply frozen; a future shared immutable-ingress helper could make that contract easier to consume.
- P1: validate non-null `customerId` as a string inside MM-004 local scope parser (current canonical sources still fail closed on mismatch; no cross-scope path identified).
- P2: optionally re-validate normalized output shape against extraction kind at MM-004 consumption, unify unavailable-error classification, and add extra query-edge tests.
- Existing unrelated MM-001/003 backlog remains unchanged.

No independent review is claimed; review remains a separate activity.
