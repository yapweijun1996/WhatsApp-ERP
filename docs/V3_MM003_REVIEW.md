# V3 MM-003 Review

Status: **ACCEPTED COMPLETE — GOAL-FIRST FAST TRACK / SHADOW-ONLY**

Date: 2026-09-19 (Asia/Singapore)

## Delivered

- Added `src/v3-attachment-extraction.ts`, a provider-neutral Host-owned adapter boundary with deterministic adapter identity/version, explicit media/kind compatibility, bounded normalized output, safe failure codes, source provenance, and MM-002 evidence emission.
- Added fixture coverage for TEXT-layer PDF/document, OCR, VISION, TABLE, and TRANSCRIPT; invalid media/kind, source mismatch, malformed/oversized output, adapter failure, immutable deterministic replay, and provider-payload isolation.
- Successful outputs remain `UNTRUSTED_CUSTOMER_EVIDENCE`, `NON_AUTHORITATIVE_DERIVED`, `grantsEffects=false`, and capped at `SALES_ORDER.DRAFT`.

## Scope exclusions

No PDF/OCR/vision/audio dependencies, provider/network calls, persistence/schema migration, runtime/customer wiring, production traffic, deployment, outbound ownership, or authority beyond `SALES_ORDER.DRAFT` were added.

## Evidence

- Targeted MM-003/MM-001/MM-002 tests: **18/18 PASS** (`tests/v3-attachment-extraction.test.ts`, `tests/v3-attachment-source.test.ts`, `tests/v3-attachment-evidence.test.ts`).
- Typecheck: **PASS** (`npm run typecheck`).
- Scoped `git diff --check`: **PASS** for the MM-003 files and task entry.

- Independent read-only Claude review, VMMCP job `eb077bac-58f3-4ece-a573-634e705d4623`: **VERDICT PASS_P0_0**.

## Non-blocking hardening backlog

Goal-First Fast Track does not block this increment on these independent-review findings:

- **P1:** outer failure construction can still throw if the adapter is null/invalid before safe failure metadata is constructed.
- **P1:** FAILED-result source display strings should receive the same explicit bounded validation as success-path evidence metadata.
- **P2:** invalid media kind currently maps to generic `INVALID_OUTPUT`; a more specific safe code would improve diagnostics.
- **P2:** add a null-adapter regression and reduce coupling to MM-002 error-name matching.
- Existing MM-002 backlog remains: evidence identity/location semantics and stricter timestamp/MIME validation before persistence/runtime identity use.

No P0 blocker was identified.
