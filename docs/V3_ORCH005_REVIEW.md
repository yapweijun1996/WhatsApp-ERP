# V3-ORCH-005 Review

Status: **ACCEPTED COMPLETE — Goal-First Fast Track**

The initial independent review returned **FAIL**. It identified synthetic native/Demo wire fixtures, caller-trusted retrieval results, and key-order-sensitive request comparison. Those gaps were remediated and an independent read-only rereview returned **PASS_P0_0** (job `845c53df-0177-420e-896e-d9935b6edc59`).

This increment adds a focused V3 semantic-parity harness at the real shared Pi `AssistantMessage` stream boundary used by native providers and `createPiDemoStream`. It normalizes both representations into one Host-observed projection containing the V3 observation, the canonicalized retrieval request, the Host-derived read-only retrieval result/trace, and the existing grounded final response plan. The harness executes retrieval through `V3OrchestratorRetrievalSession`; no model-authored result is accepted as evidence. It does not add a second agent runtime or change lifecycle behavior.

Changed files:

- `src/v3-orchestrator-semantic-parity-harness.ts` — Pi stream-boundary normalizer; canonical request comparison; Host-session-owned result/trace; retrieval is fixed as `NON_AUTHORITATIVE_DERIVED`, `grantsEffects: false`, and `HOST_ONLY` execution.
- `tests/v3-orch-005.test.ts` — native Pi message plus production `createPiDemoStream` parity, Host result/trace assertions, extra authority/result-field rejection, cross-scope rejection, and side-effect/cutoff assertions.
- `docs/V3_TASKS.md` — ORCH-005 marked ACCEPTED COMPLETE. ORCH-006 remains open.
- `docs/V3_ORCH005_REVIEW.md` — this evidence record.

Targeted evidence:

- `node --test --test-concurrency=1 --import tsx tests/v3-orch-005.test.ts tests/v3-orch-002.test.ts tests/v2-pi-demo-stream.test.ts tests/v2-native-tool-transport.test.ts tests/v2-pi-runtime.test.ts`: **50/50 PASS** (2 ORCH-005, 5 ORCH-002, 43 directly needed V2/Pi boundary tests).
- `npm run typecheck`: **PASS** (`tsc --noEmit`).
- `git diff --check -- src/v3-orchestrator-semantic-parity-harness.ts tests/v3-orch-005.test.ts docs/V3_TASKS.md docs/V3_ORCH005_REVIEW.md`: **PASS**.

Safety and boundaries:

- Retrieval is derived context only and remains untrusted/non-authoritative; the parity projection cannot treat conversation history or media as canonical ERP truth.
- Native and Demo retrieval calls are read from actual Pi stream blocks and must be one of the existing V3 retrieval tools. Equivalent request objects are compared canonically, so key order is irrelevant. Model-authored authority, effect, or result fields are rejected; the Host session alone produces and validates the retrieval result/trace, and retrieval is not a business capability execution.
- The final plan is validated by the existing grounded response-plan validator. The asserted AI cutoff is exactly `SALES_ORDER.DRAFT`; Host remains the sole execution authority.
- No schema migration, provider/network call, deployment, customer traffic, or Sales Order posting/confirmation/Delivery Order authority was added.

Independent rereview: **PASS_P0_0**. It verified the real shared Pi boundary, Host-owned retrieval result/trace, canonical request comparison, rejection of model-owned authority/effect fields, exact `SALES_ORDER.DRAFT` cutoff, and no unauthorized side effects/deploy. P0=0, P1=0. P2 backlog: replace one tautological cutoff assertion with a behavioral assertion; tighten the self-referential argument object check; avoid the unchecked retrieval outcome cast where practical. Broader production-shaped RET-005 ladder parity, multi-step final-plan corpus coverage, and durable cross-process retrieval trace replay also remain P2 future work. ORCH-006 remains open.
