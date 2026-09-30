# V3-ORCH-003 Review

Status: **ACCEPTED COMPLETE — Goal-First Fast Track**

ORCH-003 adds a bounded, opt-in Host session that snapshots the descriptive Goal Graph and Host-derived freshness vector, admits Agent proposals only through `V3GoalProposalHost`, and refreshes both projections after retrieval results, completed capability results, or explicit freshness invalidation. A changed projection returns a content-free `REPLAN_REQUIRED` signal; the existing V2 loop remains the only model loop and the refreshed observation is supplied before its next turn.

Focused evidence:

- ORCH-003: **3/3 PASS** — stale same-goal proposal fails closed; unrelated concurrent goal survives; retrieval/capability/freshness reverify reprojections signal replan; disabled seam and literal `SALES_ORDER.DRAFT` cutoff remain covered.
- ORCH-001/002 compatibility: **8/8 PASS**.
- TypeScript typecheck: **PASS**.
- Scoped `git diff --check`: **PASS**.

Boundaries preserved: disabled by default; no schema migration; no provider payload in order-core; no customer/runtime enablement; no second agent loop; no Sales Order post/confirm or Delivery Order authority; telemetry/replan signal is content-free. Goal Graph mutations remain descriptive and never authorize ERP mutations.

Independent review: VMMCP read-only Claude job `01a80fad-0028-443a-bc4f-46ed5b08f452` returned **PASS_P0_0**. The reviewer verified all seven Goal-First acceptance clauses and found no blocking issue.

Backlog (non-blocking P1/P2):
- P1: validate refreshed `freshnessVector` scope explicitly inside `reverify()` as well as at construction.
- P1: replace the vacuous disabled-by-default assertion with a production-shaped V2 runtime integration fixture.
- P2: replace `JSON.stringify` graph equality with canonical/deterministic equality to avoid safe false-positive replans if ordering changes.
- P2: remove the redundant `admit`/`admitProposal` alias if the public API is later tightened.
- Add a dedicated runtime fixture for explicit non-message invalidation delivery when an approved caller exists.

Decision: ORCH-003 is **ACCEPTED COMPLETE** under Goal-First Fast Track. P1/P2 items are backlog, not blockers. No deploy/customer traffic/schema migration/authority widening was performed.
