# V3-ORCH-004 Review

Status: **ACCEPTED COMPLETE — Goal-First Fast Track**

The new v3-orchestrator-wake-resume.ts bridge composes the existing MM-005 completion processor with the existing V2PiRuntime; it does not create a second agent loop. Only the first lease-backed RESUME_AUTHORIZED decision (LEASE_REACQUIRED) calls the runtime. DUPLICATE_WAKE, invalidated completion, pending, rejected, and handoff dispositions are traceable and do not run the agent.

Attachment evidence is passed through the existing V3 observation contract as bounded metadata only. The projection marks it NON_AUTHORITATIVE_CONTEXT_METADATA, untrustedAsInstruction: true, and UNTRUSTED_CUSTOMER_EVIDENCE; extracted payload/output is not copied into the observation or trace. The runtime authority boundary remains SALES_ORDER.DRAFT.

Focused evidence:

- node --test --test-concurrency=1 --import tsx tests/v3-orch-004.test.ts: 5/5 PASS.
- npm run typecheck: PASS.
- Scoped compatibility command: node --test --test-concurrency=1 --import tsx tests/v3-orch-001-runtime-observation.test.ts tests/v3-orch-002.test.ts tests/v3-orch-003.test.ts tests/v3-mm-005.test.ts: PASS.
- git diff --check: PASS.

Independent read-only review: **VERDICT PASS_P0_0** (job `28468241-f019-4b2f-89c8-d4b82002dea0`), P0=0. The review confirmed same-runtime routing, non-authorized/duplicate suppression, bounded untrusted evidence, content-safe traces, no second loop, and the exact `SALES_ORDER.DRAFT` cutoff.

Remaining non-blocking backlog: P1 — add a direct end-to-end integration test around `resumeV3AttachmentCompletion` (multi-candidate routing/error/runtime handoff); P2 — retain bounded failure diagnostics without exposing exception/content and remove the local `as any` in `runtimeStart`; deeper G23 replan/lease-retry trace coverage remains backlog. The stale focused-test count identified by review was corrected from 3/3 to 5/5.
