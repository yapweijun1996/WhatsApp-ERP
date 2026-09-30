# V3-CP-004 Review — Shadow-Only Atomic Side-Effect Admission

Status: **COMPLETE — shadow-only, non-authoritative**
Date: 2026-09-14 (Asia/Singapore)

Initial independent review: **FAIL/P1**. Findings were that authorization and freshness ran before the CAS, V3 descriptor authority fields were ignored, same-turn replay was over-claimed as idempotent, input-shape validation could read accessors, and race evidence did not prove the mutation committed. Remediation is recorded here after focused tests passed.

`src/v3-side-effect-admission.ts` adds a detached, fail-closed CP-004 admission proof. It validates the CP-001 bundle, CP-002 context, CP-003 fenced lease, CP-005-independent freshness vector, and immutable existing `agent_actions` identity before invoking the fixed-input extension of the existing V2 queue transaction fence. No V3 effect ledger, schema object, runtime wiring, provider path, or customer-visible behavior was added.

The single BEGIN IMMEDIATE fence rechecks the active owner/token/generation, validated bundle/context/lease/vector cross-bindings, canonical employee-profile capability authorization, action/turn scope, action capability/version/arguments hash, V2 authoritative freshness, newer inbound, and execution uncertainty before setting the existing `side_effect_started` bit. A repeated proof fails closed with `RECONCILE_REQUIRED`; conflicting or unresolved action state is never authorized as a different effect. Output contains only status, stable effect identity, and existing item ID.

Evidence:

- `tests/v3-side-effect-admission.test.ts`: admission/replay, stale freshness, action tampering, immutable/minimized output, exact no-effect failure, and true two-connection races whose mutation worker reports a committed write for newer inbound and profile permission removal.
- `V1Database.#queueAuthorizeSideEffectLocked` is the private fixed common locked precondition helper used by both legacy V2 and CP-004 admission; no callback or raw queue-authority seam is exposed.
- Focused CP-004, CP-003, and V2 queue tests: PASS.
- No `schema.sql` change was made by CP-004; existing dirty schema changes were preserved.

The V2 queue remains the sole side-effect-start and chronology authority. CP-005 and later tasks remain closed; V3 remains `PROPOSED`.
