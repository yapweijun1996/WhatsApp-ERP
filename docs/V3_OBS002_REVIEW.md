# V3-OBS-002 Review

Status: **ACCEPTED COMPLETE — Goal-First Fast Track, shadow-only**.

This increment extends `src/v3-observability.ts` with the pure Host-owned `projectV3Metrics` projection. It accepts bounded, structural fixture facts only; it does not parse customer wording, semantic keywords, model reasoning, or provider payloads. The output is detached and content-free, scoped to one account/conversation, and grants no capability or execution authority.

Formulas (all rates are `numerator / denominator`, with rate `0` when the denominator is `0`):

- unnecessary clarification: requested clarifications with `required=false` / requested clarifications;
- empty promise: progress dispositions with `continuationValid=false` / progress dispositions;
- historical retrieval success: successful attempted historical retrievals / attempted historical retrievals;
- multi-bubble bundle accuracy: bundles whose expected and observed message-ID sets are exactly equal / bundles;
- goal completion: completed eligible goals / eligible goals;
- grounded response: grounded useful responses / useful responses;
- duplicate outbound: duplicate attempted outbound units / attempted outbound units;
- cross-scope violations: explicit Host-counted violations, reported as a count even when zero;
- retrieval loop count: sum of bounded structural retrieval-loop counts;
- last-bubble-to-useful-response latency: total, average, and maximum milliseconds over useful responses with valid Host timestamps.

Evidence:

- `node --import tsx --input-type=module -e "await import('./tests/v3-obs-002.test.ts')"`: **4/4 PASS**.
- `npm run typecheck`: **PASS**.
- `git diff --check -- src/v3-observability.ts tests/v3-obs-002.test.ts docs/V3_TASKS.md docs/V3_OBS002_REVIEW.md`: **PASS**.

Safety boundaries:

- Structural flags and IDs are bounded and validated; exact bundle membership uses IDs, never wording.
- Historical retrieval distinguishes `attempted` from `succeeded`; empty-promise measurement consumes structural continuation validity rather than duplicating fulfillment authority.
- Cross-scope violations are counted without exposing foreign/private payloads. Invalid scope, timestamps, negative counts, negative latency, duplicate IDs, and malformed facts fail closed.
- This is an in-memory/pure diagnostic projection. It does not persist state, contact WhatsApp, call a provider, change outbound ownership, alter lifecycle semantics, or widen the AI ceiling beyond `SALES_ORDER.DRAFT`.

Blockers/backlog:

- P0: **0**. No blocker identified for the OBS-002 diagnosability goal.
- Independent Claude read-only review job `d5a5ac5e-21dc-4b0e-93b5-dbe24a33b627`: **PASS_P0_0**, P0=0, P1=0, P2=3, `BLOCKING_FOR_OBS002=NO`, safety boundaries PASS. The runner summary classified all three P2 items as backlog; their detailed text was not surfaced by the structured job result, so no speculative details are recorded here.
- Existing OBS-001 backlog remains unchanged: stronger recorder-to-scope binding and future retention/access/cross-process sink policy remain follow-up work before any production telemetry path.

No schema migration, runtime/customer deployment, network traffic, release/promotion, or commit was performed.
