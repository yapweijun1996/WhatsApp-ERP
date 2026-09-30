# V3-MM-007 Multimodal Golden Report

Status: **ACCEPTED COMPLETE — Goal-First Fast Track**

Scope is test/report evidence only. No provider, runtime, customer, deployment, schema, migration, or outbound-owner change was made. AI authority remains capped at `SALES_ORDER.DRAFT`.

## Golden mapping

| Golden | Fixture coverage | Deterministic proof |
|---|---|---|
| G5 | IMAGE / VISION | Search→Read returns the exact image source, message, attachment, source ref, extraction provenance, and page location; MM-001 raw bytes are rehashed and verified; current ERP price reverify returns `CURRENT_ERP_MATCH`, while effects remain denied. |
| G6 | PDF / OCR | Read preserves exact PDF page 2 and source/message lineage; historical price 47.00 conflicts with current ERP truth and returns `REPLAN_REQUIRED` / `HISTORICAL_MEDIA_CONFLICT`. |
| G12 | PDF / OCR, IMAGE / VISION, DOCUMENT / TEXT | Malicious attachment content remains `untrustedAsInstruction=true`, `grantsEffects=false`, `requiresCanonicalReverification=true`, with exact cutoff `SALES_ORDER.DRAFT`; DOCUMENT is explicitly covered. |
| G23 | AUDIO / TRANSCRIPT | Host completion advances freshness; no-candidate completion creates no outbound; an eligible durable continuation receives `RESUME_AUTHORIZED` without a new inbound message. |

MM-001/MM-002 lineage is asserted through raw-byte SHA-256 and byte length, exact source/message/attachment binding, extraction provenance refs, retrieval citations, and the PDF page reference.

## Validation

Command:

```text
node --test --test-concurrency=1 --import tsx tests/v3-mm-007-golden.test.ts tests/v3-mm-006.test.ts tests/v3-mm-005.test.ts
```

Result: **PASS — 14/14 focused tests across 3/3 test files, 0 failures, 0 cancellations, 0 skipped** (MM-007 contributes 4 Golden cases; MM-006 and MM-005 are the immediate dependency slice).

Command:

```text
npm run typecheck
```

Result: **PASS — `tsc --noEmit` exit 0**.

Command:

```text
for f in tests/v3-mm-007-golden.test.ts docs/V3_MM007_REPORT.md docs/V3_TASKS.md; do git diff --no-index --check /dev/null "$f" || test $? -eq 1; done
```

Result: **PASS — no whitespace errors**.

## Boundaries

The tests compose the existing MM-001 source/integrity, MM-002 evidence, MM-004 retrieval, MM-005 completion, and MM-006 Host ERP reverify contracts. They do not add persistence, schema, runtime wiring, customer traffic, deployment, provider integration, outbound effects, Sales Order posting/confirmation, or Delivery Order creation.

## Independent review

Read-only Codex review job `5e554879-353f-4eb2-9cd1-8cdff9ef4b59` returned **VERDICT PASS_P0_0_P1_0**: **P0=0, P1=0, P2=1**. The single non-blocking P2 is backlog: G23 currently proves completion through `RESUME_AUTHORIZED`, while deeper replan/duplicate-wake trace coverage belongs to ORCH-004 runtime integration. No authority widening was found.

Decision: **MM-007 ACCEPTED COMPLETE** under Goal-First Fast Track. Phase 5 multimodal is 7/7 complete. The next critical-path increment is ORCH-004, integrating multimodal observations and async wake/resume into the existing runtime without creating a second agent loop.
