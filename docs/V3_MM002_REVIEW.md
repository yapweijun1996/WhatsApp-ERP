# V3-MM-002 Review

Status: **ACCEPTED COMPLETE — GOAL-FIRST FAST TRACK / SHADOW-ONLY**

Date: 2026-09-19 (Asia/Singapore)

## Goal

Provide the smallest immutable Host-owned versioned `AttachmentEvidence` contract needed for later MM-003 extraction adapters, without adding extraction providers, persistence, runtime wiring, customer traffic, or authority widening.

## Delivered

- `src/v3-attachment-evidence.ts` — pure builder/verifier for `V3-MM-002`.
- `tests/v3-attachment-evidence.test.ts` — targeted contract/version/integrity coverage.
- Exact binding to the validated MM-001 source scope, attachment ID, source message ID, source ref, content SHA-256 and source fingerprint.
- Versioned media/extraction metadata, extractor identity/version, page/region/bounding-box/time refs, freshness state and provenance refs.
- Fixed `UNTRUSTED_CUSTOMER_EVIDENCE`, `NON_AUTHORITATIVE_DERIVED`, `grantsEffects=false`, and `SALES_ORDER.DRAFT` cutoff.
- Closed data-only shape, proxy/accessor rejection, bounded strings/arrays/numbers, deterministic fingerprinting and deep immutable output.
- `CURRENT` remains source-version freshness only; it does not establish current ERP truth.
- No DB/schema/migration, persistence, OCR/vision/transcription, provider calls, runtime/customer wiring, deployment, outbound ownership change, or authority widening.

## Frozen candidate hashes

- `src/v3-attachment-evidence.ts`: `bf9cd4d898811e99479f44dab4577474865b0e764e587788692f5893c2ee9127`
- `tests/v3-attachment-evidence.test.ts`: `956b08b6cd7392b5dec3adb4c986891823c2267d58253a30d0ab2af5bcb95504`

## Evidence

- Targeted MM-002 tests: **7/7 PASS**.
- TypeScript typecheck: **PASS**.
- Scoped `git diff --check`: **PASS**.
- Independent read-only Claude review, VMMCP job `2d1acae3-03bf-4fbe-8a1e-d919a3f6d081`: **PASS_P0_0**.

## Non-blocking hardening backlog

Goal-First Fast Track treats these as non-blocking because there is no storage/runtime identity consumer yet and the record fingerprint/source binding remain integrity-protected:

- **P1:** `evidenceId` identity currently omits location/media/extraction fields, so distinct observations can share an `evidenceId` when source/extractor/version/provenance are equal. Before persistence/indexing uses `evidenceId` as a unique key, expand or redefine identity semantics.
- **P2:** validate `derivedAt` as an ISO/RFC3339 timestamp; optionally cross-check logical `mediaType` against trusted MM-001 MIME classification when that mapping is introduced.
- **P2:** add an explicit build-path regression for a structurally tampered MM-001 source.

## Decision

MM-002 is **ACCEPTED COMPLETE** for the Goal-First shadow-only scope. The next functional critical-path item is MM-003: common extraction adapter contracts/fixture outputs that emit this evidence without changing Host authority.
