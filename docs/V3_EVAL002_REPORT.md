# V3-EVAL-002 Adversarial Concurrency/Security Gate

Status: **ACCEPTED — shadow-only; V3 remains PROPOSED; P1 remediation complete**

The focused harness is `tests/v3-eval-002.test.ts`, backed by the seven-case index in `src/v3-eval-002-harness.ts`. It reuses the existing Host-owned seams and adds no production behavior, schema, provider, runtime, deployment, or outbound owner.

| Scenario | Reused oracle | Result |
|---|---|---|
| TOCTOU | CP-007 G18 atomic-admission interleavings | PASS |
| Stale lease | CP-007 G19 crash/restart generation fence | PASS |
| Cross-scope tampering | RET-003 generic scope/tamper rejection | PASS |
| Retention invalidation | RET-007 stale-version rebuild/no-resurrection fence | PASS |
| Prompt injection | MM-007 G12 untrusted attachment isolation | PASS |
| Duplicate wake | MM-005 replay-safe wake identity/scope fence | PASS |
| Partial outbound | FUL-004 submitted-prefix and stale-remainder fence | PASS |

P1 remediation: corrected every indexed `testName` to the exact current child test name, and the wrapper now requires that exact name plus `tests 1`, `pass 1`, and `fail 0` in child output. Acceptance is valid only after this exact-child proof passes; a zero-match child command is no longer sufficient.

Focused exact-child evidence: **7/7 PASS**, each with `tests 1`, `pass 1`, and `fail 0`. The gate therefore found zero stale, duplicate, cross-scope, prompt-owned, partial-replay, or otherwise unauthorized effects in these scenarios.

Additional verification: `npm run typecheck` PASS; scoped `git diff --check` PASS. No full regression, browser, build, release, deployment, customer runtime, or provider suite was run. The AI authority cutoff remains exactly `SALES_ORDER.DRAFT`.
