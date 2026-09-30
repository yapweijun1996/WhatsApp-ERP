# V3-GOAL-002 Review — Shadow-Only Goal Graph Persistence

Status: **PASS — ACCEPTED COMPLETE; SHADOW-ONLY**
Date: 2026-09-14 (Asia/Singapore)

This tranche implements only additive shadow persistence for the GOAL-001 contract. `conversation_goal_events` stores immutable, append-only goal snapshots and `conversation_goal_edges` stores immutable descriptive `ADDED`/`REMOVED` edge events for `PARENT`, `DEPENDENCY`, and `RELATED` relationships. The `V3GoalGraphStore` validates closed GOAL-001 goals, exact account/conversation scope, nonblank identifiers, allowed enums, no self-edges, idempotency, event integrity hashes, and deterministic rebuild/readback. The connection-level mutation fence is registered once per SQLite connection and shared by all stores on that connection, preserving exact row context without adding V1Database insert methods.

The layer is not wired into app/runtime/router/channel/commerce/outbound/UI code. Graph edges confer no commerce, ERP, tool, outbound, Sales Order POST/CONFIRM, or Delivery Order authority. The canonical V1/V2 tables remain authoritative. Existing databases receive the tables via `CREATE TABLE IF NOT EXISTS`; existing V1/V2 rows are not rewritten.

## P1 remediation evidence

- **P1-A:** V3 insert authorization and exact row-bound mutation context live in private runtime state owned by `V3GoalGraphStore`; `V1Database` exposes no V3 insert methods. Raw SQL inserts fail, including valid canonical rows; reset-only DELETE behavior is unchanged.
- **P1-B:** Each graph mutation is serialized by `runImmediate` and receives a positive per-conversation revision allocated from both append-only tables. Replay orders by revision and validates positive/strict order plus nondecreasing event time; backdated timestamps are rejected before insertion. Existing candidate rows are assigned deterministic revisions during startup migration.
- **P1-C:** Both append APIs require exact plain, own, enumerable data keys for the top-level request and scope; symbols, hidden/extra keys, custom prototypes, and accessors fail closed without getter invocation. GOAL-001 validation remains the nested goal boundary.
- **P1-D:** Event and edge IDs and idempotency keys are resolved independently. If both identify rows they must identify the same row, and the complete request must match; chimera and partial-identity replays fail closed.
- **Graph consistency:** The deterministic descriptive direction is `from -> to`: `PARENT` means `from.parentGoalId=to`, `DEPENDENCY` means `to` is in `from.dependsOnGoalIds`, and `RELATED` means `to` is in `from.relatedGoalIds`. Explicit edge events append history; rebuild applies them by conversation-wide revision and returns only active edges. Appends and rebuild both enforce this snapshot relationship; edges remain non-authoritative.

Fresh focused adversarial evidence includes passing raw-SQL forgery, absent-DB-method, multi-store connection-fence, revision/backdating, accessor/closed-shape, chimera identity, relationship-direction, and edge add/remove/re-add cases. GOAL-001 + GOAL-002 focused tests are **23/23 PASS**. Independent acceptance review completed **PASS** through the VMMCP structured review result with no recorded failure. Fresh full regression is **597/597 PASS**; typecheck, build, and `git diff --check` PASS. Protected app/commerce/outbound hashes are unchanged and direct `adapter.send()` remains owned only by `OutboundMessageService`.

Executable acceptance evidence: `tests/v3-goal-graph.test.ts` covers immutable history, duplicate/chimera handling, raw-SQL and direct-DB bypass prevention, multiple stores on one connection, restart persistence, exact scope, monotonic revision/backdating, descriptor/accessor safety, ADDED/REMOVED edge history, relationship consistency, additive coexistence, and reset isolation. GOAL-002 is accepted complete. GOAL-003 is not started. V3 remains `PROPOSED`.
