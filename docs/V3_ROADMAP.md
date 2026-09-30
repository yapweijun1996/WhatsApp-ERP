# V3 Roadmap — Dependency-Ordered Conversation Intelligence Delivery

Status: **PLANNING ONLY — no implementation authority**
Architecture: `docs/CONVERSATION_INTELLIGENCE_V3.md`
Epics: `docs/V3_EPICS.md`

## Governing rule

V3 is an incremental extension over the current V2 Digital Employee. The safe order is **observe/shadow first, concurrency authority before new effects, durable obligations before richer retrieval, retrieval before multimodal wake, and deterministic evaluation before canary**.

At every phase:

1. V1/V2 authority and rollback remain intact.
2. AI autonomy remains capped at `SALES_ORDER.DRAFT`.
3. A new V3 surface is disabled or shadow-only until its phase gate passes.
4. Existing V2 queue/freshness/outbound/commerce/grounding contracts are reused where they already satisfy the V3 requirement.
5. No phase may infer customer meaning with Host keyword/regex workflow rules.

## Phase 0 — Authorization and implementation baseline

**Purpose:** make later implementation auditable and reversible.

Deliver:
- explicit owner authorization for implementation start;
- current V2 full regression + rollback baseline;
- V3 architecture hash and planning-document consistency check;
- V2→V3 contract/service reuse matrix;
- feature-gate and data-retention/privacy plan;
- implementation evidence template and independent-review gate.

**Exit:** V3 traffic/effects remain OFF; baseline evidence is reproducible; no ambiguity about which current V2 contracts remain authoritative.

## Phase 1 — Context foundation in shadow mode

**Purpose:** build richer context without changing customer-visible behavior.

Deliver:
- versioned context snapshot contract;
- token-budget context assembler;
- rolling memory + section/episode derivation with source refs;
- canonical business-state projection reuse;
- Authoritative Freshness Dependency Vector;
- source/retention/access invalidation;
- shadow comparison of V2 vs V3 context selection.

**Exit:** long conversations can be represented without fixed `slice(-N)` assumptions; derived state is rebuildable/non-authoritative; context staleness is detectable; no V3 mutation or outbound is enabled.

## Phase 2 — Conversation Control Plane and adaptive bundles

**Purpose:** establish concurrency/freshness safety before any V3-driven effect.

Deliver:
- durable versioned inbound bundles;
- adaptive quiet window + hard cap;
- conversation/bundle/context revisions;
- fenced reasoning lease with owner/token/generation/expiry/heartbeat/resume;
- atomic freshness/newer-input/lease/authorization/idempotency recheck through side-effect-start CAS;
- non-message invalidation events;
- stale-plan abort → rebuild → replan;
- crash/reacquire and true multi-connection race tests.

**Exit:** G2/G18/G19/G20-class races pass; no stale/expired worker can win side-effect admission; V2 proven outbound/commerce behavior is not weakened.

## Phase 3 — Goal Graph and durable continuation

**Purpose:** make unfinished and concurrent business threads explicit and resumable.

Deliver:
- goal/event/edge persistence contracts;
- source message/attachment/ERP-object provenance;
- concurrent goal decomposition and status transitions;
- replan preservation/supersession semantics;
- durable continuation for `STILL_IN_PROGRESS` / `WAITING_EXTERNAL`;
- Host-observable wake/deadline/condition/handoff path;
- restart and concurrent-goal Golden tests.

**Exit:** no active goal disappears silently; no “I’ll continue/check” promise is accepted without durable resumable work.

## Phase 4 — Hierarchical long-term retrieval

**Purpose:** provide bounded human-like “scroll up” capability over large histories.

Deliver:
- section/episode navigation;
- chronological, semantic, entity/object, reply/thread and attachment indexes;
- server-derived retrieval scope enforcement;
- Agent-facing search/open/read tools;
- progressive disclosure ladder;
- bounded iterative retrieval budgets and stop conditions;
- retention/deletion invalidation and index rebuild;
- 10,000+ message latency/token tests and cross-scope adversarial tests.

**Exit:** G3/G4/G7/G11/G13/G16/G17 behavior passes; raw evidence can be reopened; cross-customer/tenant evidence is never returned through ordinary customer conversation tools.

## Phase 5 — Multimodal evidence and async wake

**Purpose:** make images/PDF/documents/audio first-class evidence without making them authority.

Deliver:
- immutable attachment/source contract;
- extraction/version/provenance/page/region/time contract;
- text/OCR/vision/table/transcript pipelines behind common interfaces;
- untrusted evidence/prompt-injection isolation;
- extraction completion/invalidation events;
- freshness-vector integration;
- durable waiter wake/resume and no-unsolicited-reply rule;
- historical-document vs current-ERP re-verification.

**Exit:** G5/G6/G12/G23 pass; every observation traces to source bytes/message; async extraction completion can safely replan dependent work without new inbound.

## Phase 6 — Agentic orchestrator integration

**Purpose:** connect V3 context/retrieval/goals to the existing bounded Digital Employee without creating a second authority/runtime stack.

Deliver:
- V3 observation contract in the existing runtime behind disabled flags;
- bounded Search→Read→Reason→reformulate→Search deeper→Tool→Verify loop;
- Goal Graph update/reverify cycle;
- capability/profile/scope freshness integration;
- multimodal observation + async wake resume in the same loop;
- native/Demo semantic parity for V3 retrieval/results/final plans where applicable.

**Exit:** the Agent can autonomously retrieve/reason/replan within budgets while Host validates every action; no new post-Draft authority exists.

## Phase 7 — Fulfillment and durable response effects

**Purpose:** complete customer goals and deliver natural multi-unit responses without duplicate/stale partial effects.

Deliver:
- Fulfillment Gate for every active goal;
- AI-owned response composition;
- ordered durable delivery units with stable effect identities;
- per-unit atomic admission and partial-effect reconciliation;
- provider `PENDING/UNKNOWN` no-blind-resend compatibility;
- quotation capability-owned output vs runtime reply exclusivity;
- structural durable-continuation requirement for waiting/in-progress promises.

**Exit:** G1/G8/G9/G10/G14/G15/G21/G22 pass; committed units are never replayed and only uncommitted remainder is replanned.

## Phase 8 — Observability, security, scale, and full Golden evaluation

**Purpose:** prove V3 behavior with deterministic, concurrency, privacy, security, and performance evidence.

Deliver:
- bounded execution traces and privacy-safe metrics;
- complete G1–G23 executable corpus;
- TOCTOU/stale-lease/cross-scope/prompt-injection/partial-outbound adversarial suite;
- 10,000+ message/index/token/latency benchmark;
- full V1/V2 regression with V3 disabled and deterministic V3 mode enabled;
- independent implementation review P0=0/P1=0.

**Exit:** deterministic/browser/scale/security gates pass and independent review reports no unresolved P0/P1.

## Phase 9 — Shadow, canary, rollback, and owner promotion decision

**Purpose:** introduce V3 incrementally without changing V2 authority until real evidence justifies promotion.

Deliver:
- no-effect V3 shadow flags;
- explicit canary eligibility and one-writer/one-outbound-owner cutover rules;
- per-account/conversation canary + rollback control;
- real WhatsApp rapid-bubble, long-history, reply-reference, multimodal and async-wake journeys through at most `SALES_ORDER.DRAFT`;
- V3-vs-V2 correctness/clarification/latency/cost/duplicate-effect comparison;
- rollback drill and explicit owner promote/reject decision.

**Exit:** V3 remains `PROPOSED` until owner acceptance. Promotion changes authority only through a separate reviewed release action.

## Release milestones

| Milestone | Meaning | Customer-visible V3 effects |
| --- | --- | --- |
| M0 | Planning + owner implementation gate | OFF |
| M1 | Context foundation shadow-ready | OFF |
| M2 | Control Plane concurrency gate PASS | OFF |
| M3 | Goal Graph + continuation gate PASS | OFF |
| M4 | Retrieval gate PASS | OFF / shadow only |
| M5 | Multimodal + async wake gate PASS | OFF / shadow only |
| M6 | Agentic orchestrator gate PASS | OFF / deterministic only |
| M7 | Fulfillment/effect gate PASS | pilot-disabled by default |
| M8 | Full Golden/security/scale review PASS | shadow eligible |
| M9 | Shadow/canary/rollback evidence PASS | limited explicit canary only |
| M10 | Owner V3 promotion decision | only after separate approval |

## Critical path

`E0 -> E1 -> E2 -> E3 -> E4 -> E5 -> E6 -> E7 -> E8 -> E9`

Some implementation work may run in parallel only after its shared authority dependency is closed. Examples: index performance work can parallel section derivation after scope contracts exist; extraction adapters can parallel attachment storage after evidence contracts exist. No parallel lane may bypass E2 atomic admission for side effects or E4 server-side isolation for retrieval.

## Explicit rollback principles

- Canonical messages, customer/channel identity, quotation/outbound/acceptance/Sales Order, ERP evidence, staff authority, and document sequences remain current V1/V2/domain sources of truth throughout migration.
- Shadow V3 derived memory/indexes may be discarded and rebuilt without rewriting canonical commerce state.
- Rollback disables V3 context/retrieval/orchestration flags and returns execution to the current V2 path; it does not “reverse” already committed canonical effects.
- Any provider `PENDING/UNKNOWN` effect is reconciled through existing durable outbound rules before retry or rollback-driven continuation.
- A stale V3 lease/generation cannot regain effect authority after rollback/cutover.
- Promotion or rollback must never create dual authoritative workspace writers or dual outbound owners.
