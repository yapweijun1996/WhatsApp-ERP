# V3 Phase 0 — V2 to V3 Reuse and Ownership Matrix

Status: **V3-CTX-001 REVIEWED / REUSE LOCK — SHADOW-ONLY PHASE 1 AUTHORIZED**

V3 is an extension of the current V2 Digital Employee. New conversation-intelligence state may be added only where V2 has no equivalent derived-state surface. Existing V2 authority owners are reused, not cloned.

| V3 concern | Existing V2 owner / contract | V3 decision | Allowed V3 extension | Forbidden duplication / authority drift |
|---|---|---|---|---|
| Provider-neutral ingress | `channel-contract.ts`, `channels.ts`, `v2-conversation-ingress-persistence.ts` | REUSE | Add attachment/reply metadata through reviewed provider-neutral contracts | Provider SDK payloads in order-core; model-selected customer/account scope |
| Conversation ordering | `v2-queue.ts`, persisted `arrival_seq` | REUSE/EXTEND | Bundle multiple ordered inbound events above the same durable chronology | Second independent ordering ledger that can disagree with V2 |
| Lease / crash recovery | `v2-queue.ts` | REUSE/EXTEND | V3 bundle/context revision references and richer fenced reasoning metadata | Weaker in-memory lease, unfenced resume, second mutation owner |
| Fresh side-effect admission | `v2-queue.ts`, `v2-freshness.ts`, commerce locks | REUSE AS MINIMUM | Extend dependency vector for goals/extraction/retention state | Separate preflight-only freshness check; check-then-send TOCTOU window |
| WorkItem | `v2-work-item.ts`, `v2-domain-contracts.ts` | REUSE | Goal Graph may reference WorkItem as governed ERP/workspace object | Goal Graph becoming commerce/workspace authority |
| OrderDraft | `v2-order-draft.ts`, `v2-order-validation.ts` | REUSE UNCHANGED AUTHORITY | V3 goals/context may link current/historical draft revisions | New V3 draft state machine or model-owned revision truth |
| Quotation / acceptance / Draft SO | `commerce.ts`, `v2-quotation.ts`, `v2-commitment-guard.ts`, `v2-acceptance-commit.ts` | REUSE | V3 planning/retrieval can request existing capabilities and cite evidence | Any V3 POST/CONFIRM SO or Delivery Order capability; semantic shortcut around CommitmentGuard |
| Capability catalog | `v2-capability-registry.ts`, `v2-capability-contracts.ts` | REUSE | Add separately reviewed retrieval/conversation capabilities with closed schemas | Dynamic/model-created capabilities or staff lifecycle aliases |
| Capability authorization/execution | `v2-capability-authorization.ts`, `v2-capability-executor.ts` | REUSE | Pass V3 scoped observations/revision refs into Host validation | Model-owned identity, authorization, idempotency or effect execution |
| Agent loop | `v2-pi-runtime.ts`, `v2-transport-runtime.ts`, native/Demo transports | EXTEND SAME LOOP | Add bounded Search→Read→Reason→Tool→Verify cycles and V3 observations | Second autonomous runtime with separate authority/budgets |
| Context construction | `v2-agent-context.ts`, `v2-context-projection.ts` | EXTEND | Token-budget assembly, context snapshot version, hierarchical retrieval | Parallel context authority or summaries treated as ERP truth |
| Recent transcript / summary | `v2-context-projection.ts`, `conversation_summaries` | EXTEND/REPLACE MODEL-FACING SELECTION | Dynamic token-budgeted recent raw turns; versioned sections/rolling memory | Simply increasing fixed message count; rewriting raw messages |
| Grounding | `v2-response-grounding.ts`, `v2-grounding-references.ts`, `v2-grounded-response-plan.ts` | REUSE/EXTEND | Ground V3 response-plan evidence and fresh dynamic facts through same Host gate | Derived memory or attachment extraction authorizing price/stock/status claims |
| Outbound provider effects | `outbound-message-service.ts`, `v2-runtime-outbound.ts` | REUSE SOLE OWNER | Ordered V3 delivery units map to stable durable intents/effects handled by sole owner | Any second `adapter.send(...)` path; blind resend; model-owned provider call |
| Provider uncertainty | `OutboundMessageService` reconciliation contract | REUSE | Per-delivery-unit reconciliation references | Replay of `UNKNOWN/PENDING` without proof |
| Rollout | `v2-rollout.ts`, rollout approval boundary | EXTEND | Future V3-specific shadow/canary flags through reviewed server-owned rollout | Prompt/model flags, silent V3 activation, dual routing authority |
| Migration / one writer | `v2-workspace-migration.ts`, `workspace_authority` | REUSE PRINCIPLE | V3 derived-state cutover can use equivalent explicit owner-gated transition | Two authoritative writers for same business surface |
| Observability | `v2-agent-observability.ts`, bounded trace/event ledgers | EXTEND | Bundle/goal/retrieval/lease/invalidation/effect metadata | Raw chain-of-thought, secrets, unrestricted transcript dumps |
| Employee profile | `v2-employee-profile.ts` | REUSE | Profile version participates in V3 freshness dependency vector | Model widening role/capability policy |
| Canonical ERP evidence | current ERP/validation/grounding services | REUSE | Historical refs can be retrieved; current dynamic facts re-read at decision boundary | Conversation/PDF/image becoming current ERP authority |

## New V3 derived-state components allowed in principle

These have no complete V2 equivalent and may be designed in later authorized phases: durable versioned inbound bundles; context-snapshot metadata; Conversation Goal Graph; durable continuation records; conversation sections/episodes; hierarchical retrieval indexes; attachment source/extraction evidence; retrieval cursors/results; non-message freshness invalidation events; and ordered multi-unit response-plan metadata.

They remain **non-authoritative unless an existing Host authority explicitly consumes them after validation**. Any new persistence/schema for these surfaces requires separate implementation authorization and executable migration/rollback evidence.

## Ownership invariants

- One business truth owner per surface.
- One provider outbound owner: `OutboundMessageService`.
- One Host capability authorization/execution boundary.
- One canonical V1/V2 commerce lifecycle through `SALES_ORDER.DRAFT`.
- V3-derived memory, goals, indexes, embeddings, OCR/vision/transcripts, and model plans are evidence/navigation state, never permission.
- AI owns meaning and planning; Host owns scope, truth, freshness, durability and effect admission.

## Phase 0 reuse decision

**REUSE-FIRST.** No existing safety-critical V2 authority owner should be replaced by V3. V3 implementation should begin by extending context/derived-state surfaces behind disabled/shadow gates, then prove compatibility with these owners before any canary authority is considered.

## V3-CTX-001 source verification — 2026-09-13

Fresh working-tree inspection verified the mapped owners against current source. Direct provider `adapter.send(...)` calls remain contained in `src/outbound-message-service.ts`; the queue retains durable lease plus atomic side-effect authorization; capability contracts still reject post/confirm Sales Order and Delivery Order creation. See `V3_CTX001_REVIEW.md`.

**V3-CTX-001 verdict: PASS — P0=0 / P1=0.**
