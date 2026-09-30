# V3-OBS-001 Review

Status: **ACCEPTED COMPLETE — Goal-First Fast Track, shadow-only**.

This increment adds `src/v3-observability.ts`, a Host-owned in-memory projection for eight content-free trace stages: bundle, context, goals, retrieval, freshness, lease, admission, and effects. Each stage has an explicit structural allowlist. Unknown fields are omitted; invalid scope, event kind, timestamp, sequence, and snapshot ordering fail closed. Values are bounded and code/ref fields are deterministically redacted/validated. Raw customer content, broad private payloads, secrets, and chain-of-thought are neither accepted into the projected event nor stored by this collector.

Evidence:

- `node --import tsx --input-type=module -e "await import('./tests/v3-obs-001.test.ts')"`: **4/4 PASS**. (The repository's `node --test --import tsx` wrapper reports the `.ts` file as one passing file-level test under this environment.)
- `npm run typecheck`: **PASS**.
- `git diff --check -- src/v3-observability.ts tests/v3-obs-001.test.ts docs/V3_TASKS.md docs/V3_OBS001_REVIEW.md`: **PASS**.

The implementation is read-only with respect to ERP, provider, transport, lease, admission, and effect authority; the recorder is an ephemeral diagnostic collector and creates no execution authority. No schema migration, persistence, runtime/customer deployment, network access, or WhatsApp traffic was used. The exact authority ceiling remains `SALES_ORDER.DRAFT`; staff-owned Sales Order posting/confirmation and Delivery Order progression are unchanged.

Independent review:

- Claude read-only job `c0636e70-7b34-4a6e-8da9-0b4165a5d5b1`: **PASS_P0_0**. P0=0, P1=1, P2=2.
- The reviewer confirmed all eight required stages have typed allowlists, unknown fields are structurally unreachable, scope/kind/sequence/time validation fails closed, the collector is in-memory/read-only, and the exact `SALES_ORDER.DRAFT` authority ceiling is unchanged.
- Non-blocking P1 backlog: pure-alphanumeric secrets are not intrinsically detectable by the existing text redactor; current risk is bounded because accepted values are Host-assigned structural code/ref fields rather than free-form customer text.
- P2 backlog: bind recorder instances more explicitly to one scope; define later trace retention/access/cross-process sink policy.

Blockers: **P0=0**. No review finding materially blocks the current diagnosability goal.
