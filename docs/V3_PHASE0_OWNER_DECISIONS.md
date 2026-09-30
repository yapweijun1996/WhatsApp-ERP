# V3 Phase 0 — Owner Decision Packet

Status: **OWNER APPROVED — `Phase1=A; Privacy=A; Phase2=A; Phase3=A` on 2026-09-14 (Asia/Singapore); Phase 3 shadow-only**
Date: 2026-09-14 (Asia/Singapore)

This packet records the currently approved decisions `Phase1=A; Privacy=A; Phase2=A; Phase3=A`, plus the owner's bounded GOAL-005 durable-state remediation approval on 2026-09-14. GOAL-001..006 are accepted complete for their authorized shadow-only scopes on executable plus independent review evidence. The owner explicitly approved `GOAL006=A` on 2026-09-15 (Asia/Singapore). Phase 3 accepted progress is **6/6 (COMPLETE)**. No runtime/customer traffic, canary/release, new outbound owner, V3 promotion, or authority beyond `SALES_ORDER.DRAFT` is authorized.

## Decision 5 — Phase 3 implementation authorization (`Phase3=A`) — SHADOW-ONLY

The V3-GOAL-002 persistence tranche, V3-GOAL-003 Agent-proposal Host-admission tranche, V3-GOAL-004 durable-continuation-record tranche, and bounded V3-GOAL-005 wake/resume tranche are accepted complete in shadow-only mode. GOAL-005 evidence is recorded in `docs/V3_GOAL005_REVIEW.md`: reserve→bind transactional revalidation, three post-reservation adversarial race tests, combined GOAL-005/004/CP-003 40/40 PASS, typecheck/build/diff checks PASS, and validated independent read-only PASS (P0=0/P1=0 by review contract). GOAL-006 is accepted complete for shadow-only gate closure. Phase 4+, runtime/customer traffic, canary/release, outbound ownership changes, V3 promotion, and authority beyond `SALES_ORDER.DRAFT` remain unopened.

- allowed: the additive V3-only GOAL-002 schema/persistence/test surfaces described above;
- completed/accepted: isolated GOAL-003 proposal contract/Host validation, GOAL-004 durable continuation record persistence, and GOAL-005 shadow-only wake/resume processing with durable reservation/bind fencing; no runtime/customer wiring;
- not authorized: Phase 4+ implementation, runtime/customer traffic, new outbound ownership, deployment/canary, V3 promotion, or any authority beyond the accepted shadow-only Phase 3 boundary;
- closed: new outbound owner and authority beyond `SALES_ORDER.DRAFT` (including Sales Order POST/CONFIRM and Delivery Order progression).

## Decision 4 — Phase 2 implementation authorization (`Phase2=A`)

Authorize only shadow-only Conversation Control Plane work through `V3-CP-007`; CP-001..007 are now complete with the required CP-007 executable gate evidence:

- allowed: a read-only fenced reasoning-lease projection over the existing V2 durable lease state, bound to validated CP-001 bundle and V3 context revisions, with isolated expiry/heartbeat/reacquisition/fencing/supersede/release/resume tests;
- allowed: reuse of existing V2 `messages`, `arrival_seq`, `v2_inbox_items`, `v2_conversation_inbox`, dedupe, and chronology authority;
- forbidden: runtime/customer-visible wiring, canary routing, deployment, and schema changes; Phase 3+ implementation remains separately owner-gated.
- forbidden: any second chronology/dedupe/authority ledger, provider-specific payloads in order-core, or new outbound owner;
- existing V2 authority remains authoritative; `OutboundMessageService` remains the sole provider send owner;
- AI authority remains capped at `SALES_ORDER.DRAFT`; POST/CONFIRM Sales Order and Delivery Order creation/progression remain forbidden.

`CONVERSATION_INTELLIGENCE_V3.md` remains `PROPOSED`.

## Decision 1 — Phase 1 implementation authorization (`V3-GATE-001`)

### A — Recommended: shadow-only Context Foundation

Authorize only Phase 1 context/derived-memory foundation work behind disabled/shadow gates:

- allowed: `V3-CTX-001..006` implementation and tests;
- allowed: additive V3-only persistence needed by those tasks, only after migration/rollback evidence and independent review;
- allowed: deterministic shadow comparisons against existing V2 context;
- forbidden: V3 customer-visible replies, mutation authority, quotation/outbound ownership changes, canary routing, production deployment;
- forbidden: any AI authority beyond `SALES_ORDER.DRAFT`;
- forbidden: a second agent runtime, second provider-send owner, or duplicate commerce authority.

This option gives useful implementation progress while keeping the existing V2 execution path authoritative.

### B — Narrower: contracts/tests only

Authorize implementation contracts, fixtures, deterministic tests, and migration design for Phase 1, but no runtime wiring or persistent schema migration yet.

### C — Broader: all Phase 1 including shadow runtime wiring

Authorize all `V3-CTX-001..006`, including disabled/shadow runtime integration, subject to existing owner/review gates. Still no customer-visible V3 effects or production/canary promotion.

### D — Hold

Keep V3 at planning/evidence-only. No source/schema/test implementation.

**Recommended selection: A.** It maximizes engineering learning while preserving zero customer-visible V3 authority.

## Decision 2 — Privacy/retention/access policy (`V3-GATE-003`)

The safest Phase 1 policy is to avoid inventing legal retention periods and make V3 derived data strictly subordinate to existing source retention/access authority.

### Recommended Phase 1 engineering policy

1. **No new independent raw-message retention.** Reuse existing V1/V2 message evidence; V3 does not clone raw conversation bodies into a second archive.
2. **Derived state has no independent retention right.** Sections, summaries, embeddings/index rows, context snapshots and Goal/continuation projections become unusable when their source/access authority expires or is revoked.
3. **Deletion/access revocation fails closed immediately for active retrieval.** Physical purge may be asynchronous, but revoked evidence must stop being queryable/usable before purge completes.
4. **No external multimodal/provider persistence in Phase 1.** Attachment OCR/vision/audio extraction and production external-provider data handling remain out of scope until Phase 5 plus a separate deployment/privacy review.
5. **No cross-customer retrieval.** Ordinary customer-conversation retrieval is server-scoped to authenticated tenant/account/channel/conversation/customer state.
6. **Audit is content-minimized.** Prefer IDs, policy versions, reason codes, timestamps and hashes; do not create a shadow transcript archive in observability tables.
7. **Restore/rebuild must reapply deletion/access state before indexes become queryable.** A restore cannot resurrect revoked evidence.
8. **Canonical ERP/commerce evidence keeps its existing V1/V2 retention policy.** Conversation-memory deletion cannot rewrite quote/acceptance/SO evidence.
9. **Post-deletion tombstones are content-free by default.** Keep only the minimum scoped identifier/policy/version metadata needed to prevent resurrection; do not retain message/document body content in tombstones.
10. **Production durations/SLA/legal-hold/export/encryption/provider settings remain separate policy decisions.** Phase 1 may implement the policy hooks/contracts, but must not claim legal compliance or choose jurisdiction-specific periods automatically.

### Approval choices

- **A — Recommended:** approve the Phase 1 engineering policy above; defer exact production retention durations, legal-hold/export/provider settings until the relevant production/multimodal gate.
- **B:** approve only items 1–9, but prohibit any persistent derived index/summary until production durations are also defined.
- **C:** require a full production privacy policy, exact durations and provider settings before any Phase 1 implementation.
- **D:** hold Gate 003 open with no implementation.

**Recommended selection: A.** It permits safe shadow engineering without pretending to settle legal/compliance policy.

## Decision 3 — Gate bookkeeping after approval

If the owner later explicitly selects **Decision 1 = A/C** and **Decision 2 = A**, the gate update should be narrow and mechanical:

- mark `V3-GATE-001` approved with the exact allowed scope;
- mark `V3-GATE-003` approved for Phase 1 engineering only, while recording deferred production-policy decisions;
- mark `V3-GATE-002` complete from the frozen reproducible baseline evidence;
- keep `CONVERSATION_INTELLIGENCE_V3.md` status `PROPOSED`;
- keep all production/canary/release gates closed;
- start with `V3-CTX-001` reuse-map verification, then `V3-CTX-002` context snapshot contract.

No approval may silently authorize later phases, deployment, canary traffic, POST/CONFIRM Sales Order, or Delivery Order progression.

## Owner response format

A future owner decision can be recorded compactly as:

`Phase1=<A|B|C|D>; Privacy=<A|B|C|D>`

Example recommended decision: `Phase1=A; Privacy=A`.


## Decision 6 — V3-GOAL-006 Phase 3 closure authorization — APPROVED AND ACCEPTED

Owner explicitly selected **GOAL006=A**. GOAL-006 shadow-only gate closure is accepted complete. See `docs/V3_GOAL006_PLAN.md` and `docs/V3_GOAL006_REVIEW.md`.

- **A — Recommended:** authorize shadow-only GOAL-006 gate closure: G8/G9/G15/G22 tests, restart/concurrency fixtures, narrowly required pure shadow gate helper if evidence shows one is needed, and review docs. Default is no schema change. No runtime/customer wiring.
- **B:** tests/docs only; no source helper even if useful.
- **C:** broaden to disabled/shadow orchestration integration. Not recommended; Phase 8 owns orchestration.
- **D:** hold GOAL-006 unopened.

Selection format: `GOAL006=<A|B|C|D>`.

GOAL-006 acceptance closes Phase 3 only. Existing prohibitions remain unchanged: no Phase 4+ implementation without a new owner gate, runtime/customer traffic, canary/release, deployment, V3 promotion, new outbound/provider owner, commerce authority widening, or AI authority beyond `SALES_ORDER.DRAFT`.

## Decision 7 — Phase 4 retrieval owner gate packet — OWNER APPROVED, BOUNDED SHADOW-ONLY

On **2026-09-15 (Asia/Singapore)**, the owner explicitly selected `Phase4=A`. This authorizes only bounded, dependency-ordered, shadow-only implementation of `V3-RET-001..008` within the packet's stated exclusions. It does not authorize completion or acceptance of any RET task.

The packet is now **OWNER APPROVED — BOUNDED SHADOW-ONLY IMPLEMENTATION**. V3 remains **PROPOSED/shadow-only**, the AI authority cutoff remains `SALES_ORDER.DRAFT`, and Phase 4 task checkboxes remain unchanged. This approval does not authorize schema/migration changes without a separate schema gate, runtime/customer wiring, customer traffic, canary, deployment, promotion, or any Phase 5 multimodal extraction/async-wake authority.

The owner subsequently explicitly authorized starting `V3-RET-002` in dependency order, still within the bounded shadow-only Phase4=A packet. This run is limited to RET-002; RET-003 and later remain unopened, and no RET task is marked complete by this authorization.
