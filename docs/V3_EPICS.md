# V3 Epics — Conversation Intelligence Implementation Plan

Status: **PLANNING ONLY — V3 remains PROPOSED; this file does not authorize implementation**
Architecture source: `docs/CONVERSATION_INTELLIGENCE_V3.md`
Current runtime/business authority: existing V1/V2 contracts remain controlling until explicit owner promotion.

## Delivery gates

Every V3 epic must preserve these non-negotiable invariants:

- AI autonomy ends exactly at `SALES_ORDER.DRAFT`; no AI POST/CONFIRM Sales Order or Delivery Order progression.
- V3 extends the current V2 runtime/authority layer; it must not replace proven queue, atomic side-effect admission, commerce-lock, outbound reconciliation, grounding, idempotency, or rollback guarantees with weaker mechanisms.
- AI owns semantics, retrieval strategy, reasoning, planning, goal decomposition, and natural response composition. Host owns identity/scope, evidence durability, authority, canonical ERP truth, freshness, effect admission, idempotency, and exactly-once/reconciliation behavior.
- Customer wording, regex, keywords, summaries, model output, attachment instructions, and retrieved content never create authority.
- Long-term retrieval is server-scoped by tenant/account/channel/conversation/customer before evidence is returned.
- Derived memory is rebuildable and non-authoritative; raw evidence remains source truth for what was said/shown and canonical ERP remains current business truth.
- Planning completion is not implementation completion. Each implementation epic requires executable evidence and an independent P0/P1 review before advancing its gate.

### E0 — V3 authorization, baseline, and reuse lock

**Goal:** Establish a safe implementation starting point without changing runtime behavior.

**Scope:** owner authorization, current V2 regression/rollback baseline, V3 architecture hash, V2-to-V3 reuse map, feature-gate strategy, privacy/retention review, and exact non-goals.

**Acceptance gate:** current V2 behavior remains unchanged and fully rollback-capable; V3 is still disabled; the implementation plan names which V2 services/contracts are reused rather than duplicated; owner explicitly authorizes the first implementation phase.

**Depends on:** independently reviewed V3 architecture.

### E1 — Context and derived-memory foundation

**Goal:** Replace fixed-count conversational context with source-linked, token-budgeted, versioned context while keeping canonical business authority unchanged.

**Scope:** context snapshot/version contract, rolling memory, sections/episodes, derivation metadata, source watermarks, canonical business-state projection, Authoritative Freshness Dependency Vector, retention/access invalidation, and shadow comparison against V2 context.

**Acceptance gate:** V3 context can be built in shadow mode from real conversations; raw evidence/canonical ERP precedence is preserved; stale derived state is detectable; unrelated tenant/product changes do not create global freshness churn; no V3 side effect or customer response is enabled.

**Depends on:** E0.

### E2 — Conversation Control Plane and adaptive bundling

**Goal:** Make multi-bubble reasoning interruptible, replayable, crash-safe, and at least as concurrency-safe as the proven V2 queue/freshness layer.

**Scope:** durable bundles, conversation/bundle/context revisions, adaptive quiet window + hard cap, fenced reasoning lease (`owner/token/generation/expiry/heartbeat`), atomic side-effect admission, newer-input checks, non-message freshness invalidation, stale-plan rebundle/replan, crash/resume, and race/interleaving coverage.

**Acceptance gate:** TOCTOU race tests prove that freshness/newer-input/lease/authority/idempotency recheck and side-effect-start CAS share one linearization point; expired/superseded lease generations cannot regain effect authority; post-admission work finishes/reconciles idempotently instead of being replayed.

**Depends on:** E1 and existing V2 queue/outbound/commerce guarantees.

### E3 — Goal Graph and durable continuation

**Goal:** Represent concurrent customer obligations durably so one thread can change without losing unrelated work or allowing empty promises.

**Scope:** goal nodes/edges/events, source-message/attachment/ERP links, dependency/parent/related edges, explicit dispositions, supersession/cancellation evidence, `STILL_IN_PROGRESS`/`WAITING_EXTERNAL` continuation records, wake triggers, deadlines/budgets, and replan coordination.

**Acceptance gate:** concurrent goals survive interrupts/restarts; every customer-facing response has a disposition for all active goals; `STILL_IN_PROGRESS`/`WAITING_EXTERNAL` is rejected unless resumable durable work and a Host-observable wake/handoff path exist.

**Depends on:** E2.

### E4 — Hierarchical retrieval and server-enforced isolation

**Goal:** Give the Agent a bounded equivalent of intentional human “scroll up” over long conversations without exposing foreign customer/tenant data.

**Scope:** chronological/semantic/entity/section/thread/attachment indexes; `conversation_recent/search/find_sections/open_section/get_message/get_thread/find_by_date/search_attachments/goal_list/business_objects`; progressive retrieval ladder; iterative Search→Read→Reason→reformulate→Search deeper→Tool→Verify loop; budgets/stop conditions; deletion/retention invalidation; 10,000+ message performance.

**Acceptance gate:** cross-tenant/cross-customer adversarial queries fail closed before evidence return; raw evidence can be reopened from summaries; bounded retrieval resolves long-history cases without whole-transcript stuffing; insufficient evidence ends in clarification/abstention rather than guessing.

**Depends on:** E1, E3.

### E5 — Multimodal evidence and asynchronous extraction

**Goal:** Make image/PDF/document/audio evidence searchable, source-addressable, versioned, untrusted, and able to wake eligible work when extraction completes.

**Scope:** immutable attachment source contract, extraction/version/provenance/page/region/time metadata, OCR/vision/table/transcript adapters, trust classification, prompt-injection isolation, extraction completion/invalidation events, freshness-vector integration, durable waiter wake/resume, and historical-vs-current truth separation.

**Acceptance gate:** every derived observation traces to exact source bytes/message; attachment instructions cannot widen authority/scope; async completion without a new customer bubble can safely invalidate/rebuild/replan only dependent work; no unsolicited reply is generated when no durable work is waiting.

**Depends on:** E1, E3, E4.

### E6 — Agentic orchestrator integration

**Goal:** Extend the existing bounded V2 Digital Employee loop with V3 context, Goal Graph, retrieval, and multimodal evidence without creating a second authority/runtime stack.

**Scope:** V3 observation/context contract, bounded retrieval/model/tool loops, profile/capability-policy freshness, retrieval-result observations, Goal Graph updates, clarification policy, native/Demo transport semantic parity where applicable, and current canonical-state re-verification before consequential actions.

**Acceptance gate:** the Agent can autonomously decide when to retrieve deeper, use multiple permitted capabilities, and replan after freshness changes while Host validates every capability/effect independently; no new post-Draft authority exists.

**Depends on:** E2–E5.

### E7 — Fulfillment, response composition, and durable multi-unit effects

**Goal:** Complete actual customer goals before communicating, while allowing natural multi-bubble/media responses without duplicate or stale partial delivery.

**Scope:** Fulfillment Gate, response plan, ordered delivery units, stable effect identities, durable per-unit states, per-unit atomic admission, partial-effect reconciliation, provider `PENDING/UNKNOWN` handling, capability-owned quotation compatibility, no-empty-promise enforcement, crash/reconnect recovery.

**Acceptance gate:** already committed/submitted units are never replayed after interruption; only uncommitted remainder is superseded/replanned; completion claims require grounding/capability evidence; quotation and runtime response ownership remains exclusive and consistent with V2 OutboundMessageService semantics.

**Depends on:** E3, E6 and existing V2 outbound/grounding contracts.

### E8 — Observability, security, and Golden evaluation

**Goal:** Prove the V3 behavior and safety contracts with inspectable evidence rather than file existence.

**Scope:** bounded execution traces, lease/effect/invalidation observability, privacy-safe telemetry, G1–G23 deterministic corpus, concurrency/race tests, cross-scope security tests, prompt-injection tests, 10,000+ message performance, multimodal evaluation, multilingual/code-switching, and independent P0/P1 review.

**Acceptance gate:** all required V3 Golden cases pass; zero cross-scope leakage; zero duplicate/stale effects in adversarial concurrency cases; privacy/redaction checks pass; independent reviewer reports P0=0/P1=0 for the implementation candidate.

**Depends on:** E1–E7.

### E9 — Shadow, canary, rollback, and owner promotion

**Goal:** Introduce V3 incrementally without changing V2 authority until evidence justifies promotion.

**Scope:** shadow context/retrieval, per-account/conversation capability flags, V3 canary eligibility, rollback drill, real WhatsApp multi-bubble/long-history/multimodal journeys, comparison against V2, release telemetry, and explicit owner acceptance.

**Acceptance gate:** rollback returns immediately to the current V2 path without losing canonical commerce/outbound evidence; fresh real-channel evidence reaches at most `SALES_ORDER.DRAFT`; all deterministic/browser/live gates and independent review pass; only then may the owner explicitly promote V3 from `PROPOSED`.

**Depends on:** E8 and current V2 release safety gates.

## Epic completion rule

No epic is complete because interfaces/tables/files exist. Completion requires its stated behavioral evidence, preserved V2 invariants, `git diff --check`, focused + full regression relevant to the touched surfaces, and an independent review appropriate to the risk. Production/canary authority changes require a separate explicit owner decision.
