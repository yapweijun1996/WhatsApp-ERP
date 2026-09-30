# V3-GOAL-003 Review — Shadow-Only Agent Goal Proposal Admission

Status: **PASS — ACCEPTED COMPLETE; SHADOW-ONLY**
Date: 2026-09-14 (Asia/Singapore)

V3-GOAL-003 is accepted complete for the authorized shadow-only scope. The Agent supplies an exact closed semantic proposal containing only `scope`, `operation`, `expected`, and `goal`; a separate exact closed `V3GoalProposalHostEnvelope` supplies Host-owned `proposalId`, `idempotencyKey`, and authoritative event time. Accessors, hidden fields, symbols, extra fields, scope widening, and authority widening fail closed.

Lifecycle is enforced at both the GOAL-003 proposal admission boundary and the underlying public `V3GoalGraphStore.appendGoalEvent` writer. `CREATE` creates only `OPEN`; `UPDATE` permits active nonterminal -> active or `FULFILLED`; `SUPERSEDE` and `CANCEL` permit active nonterminal -> their dedicated terminal states. `FULFILLED`, `SUPERSEDED`, and `CANCELLED` cannot transition further, including through the lower-level graph writer. Exact replay remains idempotent.

For non-CREATE mutations, Host requires the incoming goal `createdAt` to equal the current goal and rejects `updatedAt` regression. Expected goal revision/status, exact account/conversation scope, source-message provenance, and the append are serialized by the same `runImmediate` admission transaction. Exact replay is resolved before live-provenance/current-revision checks and succeeds only when event identity, idempotency identity, canonical goal snapshot/hash, event type, and event timestamp all match; chimera/conflicting replay fails closed.

## Final acceptance evidence

- Independent final review: **PASS; P0=0, P1=0**.
- GOAL-001/002/003 focused tests: **31/31 PASS**.
- Full regression: **605/605 PASS**.
- `npm run typecheck`: **PASS**.
- `npm run build`: **PASS**.
- `git diff --check`: **PASS**.
- True two-independent-SQLite-writer stale race: one winner, one stale, no duplicate goal event.
- Public graph-writer terminal-bypass regression: **PASS**.
- Direct `adapter.send(...)`: **3 occurrences, all in `src/outbound-message-service.ts`**.
- GOAL-003 runtime/customer wiring scan: **none**.
- AI cutoff remains exactly `SALES_ORDER.DRAFT`.
- Customer-language keyword/regex intent logic in GOAL-003: **none**.

Remediation history: independent review surfaced four P1s (terminal-state transition bypass, mutable goal `createdAt`, regressing `updatedAt`, and provenance validation outside serialized admission). Those were remediated and revalidated. A later direct-store bypass review also hardened `V3GoalGraphStore.appendGoalEvent` so lower-level writes cannot evade the lifecycle contract.

No runtime/customer traffic, canary/release, new outbound owner, deployment, V3 promotion, or authority beyond `SALES_ORDER.DRAFT` is authorized or implied. V3 remains **PROPOSED**. GOAL-004..006 remain unopened and require separate owner authorization.
