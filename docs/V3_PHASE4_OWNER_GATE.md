# V3 Phase 4 Retrieval — Owner Gate and Implementation Plan

Status: **OWNER APPROVED — BOUNDED SHADOW-ONLY IMPLEMENTATION**
Date prepared: 2026-09-15 (Asia/Singapore)

The owner explicitly selected `Phase4=A` on 2026-09-15 (Asia/Singapore). This packet authorizes only bounded, dependency-ordered, shadow-only implementation of `V3-RET-001..008` within the exact exclusions below. V3 remains **PROPOSED** and shadow-only. Existing V1/V2 contracts remain authoritative, and AI authority ends at `SALES_ORDER.DRAFT`. No RET task is complete merely from this authorization.

## 1. Owner decision options

### A — Recommended: bounded shadow-only Phase 4 implementation

Authorize only `V3-RET-001..008`, in the dependency order below, as disabled/shadow-only retrieval and scope-isolation work. Permit only the explicitly listed contracts, fixtures, indexes, tools, benchmark/evaluation evidence, and rebuild/invalidation behavior. Existing V2 chronology, identity, ERP, commerce, outbound, and side-effect authorities remain unchanged. No customer-visible V3 behavior or effect is enabled.

### B — Planning/tests-only

Authorize retrieval contracts, fixtures, deterministic tests, benchmark/evaluator freeze, and migration/rebuild design for `V3-RET-001..008`, but no implementation source, persistent schema migration, runtime wiring, or index activation.

### C — Broader runtime/customer integration — explicitly not recommended and not part of Phase 4

Do not select for this gate. It would exceed the Phase 4 boundary by enabling runtime/customer integration, canary/deployment, or promotion. Orchestrator integration belongs to Phase 6; multimodal extraction and async wake belong to Phase 5; release and customer traffic belong to later migration gates.

### D — Hold

Keep Phase 4 at documentation and owner-review status. No RET implementation, schema, tests, runtime wiring, traffic, canary, deployment, or promotion.

Owner selection: `Phase4=A` — bounded shadow-only implementation, recorded 2026-09-15 (Asia/Singapore). The owner subsequently explicitly authorized starting RET-002 and, on 2026-09-15, explicitly authorized starting RET-003 now in dependency order. RET-003 is limited to the schema-free Host-derived scope contract and shadow tests below; RET-004 and later remain unopened.

## 2. Exact Phase 4 boundary

Phase 4 is limited to **hierarchical text/history retrieval and scope isolation**:

- section/episode navigation over already-authorized source-linked conversation evidence;
- chronological, semantic, entity/object, reply/thread, and section retrieval;
- server-derived scope enforcement before candidate return;
- Agent-facing search/open/read contracts;
- the progressive retrieval ladder, bounded retrieval loops, abstention, and retention/access invalidation;
- rebuildable index/summary metadata and 10,000+ message evaluation.

Phase 5 owns actual image/PDF/document/audio ingest, extraction, OCR, vision, table extraction, transcription, and asynchronous extraction wake. Phase 4 may define attachment references and a search/read contract only for **already-authorized evidence that already exists**; it must not ingest media, perform extraction, or create new media-extraction authority. Attachment references are evidence pointers, not instructions or authority. Historical evidence never replaces current ERP truth.

The phase does not change V3 status, enable customer traffic, create outbound/provider ownership, widen commerce authority, post or confirm a Sales Order, create/progress a Delivery Order, or move AI authority beyond `SALES_ORDER.DRAFT`.

## 3. Proposed RET sequence and task gates

The sequence below follows `docs/V3_TASKS.md` exactly and preserves its task wording, dependencies, and unchecked status. “Allowed surfaces” are the only surfaces proposed under option A. Any schema/persistence change requires an explicit owner gate before migration: document the reuse map, migration/rollback plan, retention/access behavior, provenance/version fields, and independent P0/P1 review. Default is reuse of existing V2 source evidence and no duplicate authority ledger.

### RET-001 — section/episode navigation

Purpose: implement section/episode navigation over source-linked raw bubbles with deterministic reopen-to-source behavior.

Allowed surfaces: rebuildable section/episode projection, source-reference and open-source contract, deterministic navigation fixtures; no customer/runtime wiring.

Required evidence: section/raw provenance tests, including deterministic reopen to the exact source bubbles and scope lineage.

Dependencies: `V3-CTX-004`.

Owner gates and exclusions: any persistent projection or schema change needs the explicit Phase 4 owner selection plus migration/rollback and retention/access review. No semantic authority is created by a section or summary; no media extraction.

### RET-002 — versioned retrieval indexes

Purpose: implement chronological, semantic, entity/object, section, and reply/thread indexes with versioned rebuild metadata.

Allowed surfaces: rebuildable index definitions and version/rebuild metadata over authorized text/history evidence; attachment references only where an already-authorized source/evidence record exists.

Required evidence: index version/rebuild tests, deterministic provenance, chronology/reply linkage, and proof that derived indexes are non-authoritative and reproducible.

Dependencies: `V3-RET-001`, `V3-GATE-003`.

Owner gates and exclusions: index persistence/schema requires owner approval, rollback/rebuild evidence, and retention/access invalidation review before migration. No OCR, vision, document parsing, audio transcription, or extraction completion event.

### RET-003 — server-derived retrieval scope

Purpose: implement server-derived tenant/account/channel/conversation/customer retrieval scope enforced before candidate return.

Allowed surfaces: Host-side scope derivation and enforcement for every retrieval mode; fail-closed result handling and scope/version audit metadata.

Required evidence: cross-scope negative tests for every retrieval mode, including tampered model/customer scope, with no foreign existence leak.

Dependencies: `V3-RET-002`.

Owner gates and exclusions: identity and access authority remain Host-owned and canonical. No model-supplied scope can authorize, widen, or repair a scope. No customer traffic or runtime activation.

### RET-004 — closed Agent-facing retrieval tools

Purpose: implement `conversation_recent/search/find_sections/open_section/get_message/get_thread/find_by_date` tools with closed scoped contracts.

Allowed surfaces: typed search/open/read request and result contracts, Host-derived scope, source-open paths, citations, bounded result sizes, and test-only/shadow invocation.

Required evidence: schema/scope/provenance tests, including exact source IDs, chronology/version, scope lineage, and rejection of foreign or malformed references.

Dependencies: `V3-RET-003`.

Owner gates and exclusions: tool contracts cannot grant effects or bypass ERP tools. No provider payloads in order-core, no second agent loop, no runtime/customer wiring, and no keyword/regex semantics in Host.

### RET-005 — goal/business-object retrieval and ladder

Purpose: implement goal/business-object retrieval and the hierarchical ladder: **current bundle → recent raw → goals → sections → raw history → attachments → historical ERP**.

Allowed surfaces: retrieval strategy contracts and evidence-candidate projections; references to goals, business objects, attachments, and historical ERP records only through their existing authorized Host contracts.

Required evidence: retrieval-strategy Golden tests proving progressive disclosure, current ERP re-verification, source citations, and no replacement of current truth by historical evidence.

Dependencies: `V3-GOAL-006`, `V3-RET-004`.

Owner gates and exclusions: Agent chooses query/strategy; Host derives and enforces scope before candidates return. Phase 4 may open existing attachment evidence references but cannot create extraction authority or wake async work. No consequential action is authorized by retrieval output.

### RET-006 — bounded retrieval loop and abstention

Purpose: implement bounded retrieval loop budgets/stop conditions and no-new-evidence detection; insufficient evidence clarifies/abstains.

Allowed surfaces: deterministic budget/stop/abstention contract and shadow traces; no Host-side intent interpretation.

Required evidence: bounded-loop tests covering budget exhaustion, no-new-evidence, ambiguity, safe clarification/abstention, and absence of hallucinated completion.

Dependencies: `V3-RET-004`.

Owner gates and exclusions: the Agent selects query and strategy within declared limits. Host enforces budgets, scope, source access, and result validity; it must not implement keyword/regex semantics or infer customer intent.

### RET-007 — deletion/retention/access invalidation

Purpose: implement source deletion/retention/access invalidation across indexes and summaries; expired evidence cannot be resurrected by rebuild.

Allowed surfaces: invalidation markers, index/summary rebuild behavior, retention/access version binding, restore ordering, and content-minimized audit evidence.

Required evidence: deletion/rebuild tests showing raw, semantic, section, attachment-reference, and business-object conversation retrieval obey current access; restore/rebuild reapplies revocation first.

Dependencies: `V3-RET-002`, `V3-GATE-003`.

Owner gates and exclusions: any retention/schema change requires privacy/owner approval and rollback evidence. Physical purge/legal retention durations remain policy decisions. No late media extraction result may be introduced by this task; Phase 5 owns extraction invalidation events.

### RET-008 — retrieval gate closure

Purpose: close the retrieval gate with G3/G4/G7/G11/G13/G16/G17 and 10,000+ message latency/token targets.

Allowed surfaces: frozen benchmark/evaluator, performance/security report, shadow-only evidence, and independent review packet.

Required evidence: performance/security report plus independent P0/P1 review; all required Golden cases must be verifiable against the frozen baseline/evaluator.

Dependencies: `V3-RET-003..007`.

Owner gates and exclusions: RET-008 cannot authorize runtime/customer traffic, schema expansion, deployment, canary, promotion, multimodal extraction, or authority beyond `SALES_ORDER.DRAFT`. It is the independent gate review, not a traffic-enablement gate.

## 4. Retrieval architecture contract

- Raw conversation/source evidence is immutable, addressable, and authoritative for what was said or received. Derived sections, summaries, embeddings, indexes, and projections are rebuildable and non-authoritative.
- Every candidate carries source references/citations and an exact source-open path. Retrieval must support chronological, semantic, entity/object, reply/thread, and section retrieval.
- The progressive ladder is: current bundle → recent raw → goals → sections → raw history → attachments → historical ERP. The ladder is progressive disclosure, not permission to skip current ERP verification.
- The Agent chooses the query and retrieval strategy. The Host derives the server scope and enforces it before candidate return. Model-supplied scope, customer IDs, tenant IDs, or conversation IDs are never authorization.
- Retrieval results are evidence candidates, not effects. Prompt content, summaries, citations, and retrieved instructions never create capability or commerce authority.
- Host-side retrieval is semantic-neutral with respect to customer intent: it may enforce identity, scope, chronology, versions, budgets, and access; it must not implement keyword/regex customer-language semantics.

## 5. Security, privacy, freshness, and revision

Retrieval must isolate `tenant/account/channel-account/conversation/customer` scope. Foreign-scope requests fail closed generically, without confirming whether foreign evidence exists. Active retrieval checks current retention/access state before returning candidates. Deletion and access revocation invalidate active retrieval before physical purge; restore/rebuild reapplies revocation first. Prompt or retrieved content cannot change authority.

Results bind to relevant context, source, index, access, and freshness/revision versions. A stale reasoning attempt may continue read-only only when its trace attribution remains safe; stale reasoning cannot authorize any effect. Historical conversation, attachment, or ERP evidence cannot replace current ERP truth. Relevant current customer/product/UOM/price/stock/policy evidence must be re-read through canonical ERP surfaces before consequential decisions. Changes to conversation, identity/scope, policy/access, goal, ERP, or evidence/index versions invalidate the relevant binding.

## 6. Evidence and citation contract

Every returned section, snippet, message, and result must carry:

- exact source message/attachment/object IDs;
- chronology and source/version information;
- derivation/index/summary version when applicable;
- tenant/account/channel-account/conversation/customer scope lineage;
- retention/access and relevant freshness/revision bindings;
- a source-open path that can reopen the raw or authorized source evidence.

A summary or section is never final authority when raw evidence is required. A citation must identify the evidence actually used, preserve ordering/reply/thread relationships where relevant, and make unavailable or revoked sources explicit rather than substituting an uncited derivative.

## 7. Retrieval loop budget, stop, and abstention

The implementation must declare and test per-turn retrieval/tool-call, candidate, token, and elapsed-time budgets. The loop may proceed through Search → Read → Reason → reformulate → Search deeper, but stops on any of: sufficient cited evidence, no-new-evidence, ambiguity that remains after the configured budget, scope/access failure, stale/invalid binding, or budget exhaustion. It must then produce a bounded clarification/abstention/handoff disposition in the shadow result. It must never loop unboundedly, guess missing identity/product/UOM/price/stock/customer intent, or treat a retrieved instruction as authority.

## 8. Benchmark, Golden gates, and review freeze

Phase 4 requires a reproducible **10,000+ message** benchmark covering index/retrieval latency, token use, progressive retrieval, degradation within declared budgets, exact source reopen, and scope isolation. Freeze the baseline corpus, data generator/fixtures, evaluator version, oracle definitions, budget configuration, environment metadata, and report format before claiming results.

The exact Phase 4 Golden gate list is: **G3, G4, G7, G11, G13, G16, G17**.

- G3: long conversation recall with source reopening;
- G4: ambiguous “same as last time” with historical retrieval and current ERP verification;
- G7: reply relation resolved from linkage, not generic keyword logic;
- G11: cross-customer isolation;
- G13: 10,000+ message performance within declared budgets;
- G16: retrieval budget/abstention;
- G17: server scope tampering rejected without existence leak.

Missing, stale, or unverifiable baseline/evaluator evidence is **UNKNOWN**, not PASS. RET-008 needs a complete report and independent P0/P1 review; a passing subset cannot close the gate.

## 9. P0/P1 blocker definitions

**P0 blocker:** any issue that permits foreign-scope evidence, retention/access-revoked evidence, uncited or fabricated source authority, stale retrieval to authorize an effect, post-`SALES_ORDER.DRAFT` authority, duplicate/competing authority owner, irreversible data loss/resurrection, unbounded retrieval that can affect customer behavior, or an unverified/invalid Golden gate where safety or isolation cannot be established.

**P1 blocker:** any material Phase 4 contract, provenance, chronology/reply, rebuild/invalidation, budget/abstention, latency/token, or benchmark defect that prevents reliable bounded shadow evaluation; missing required evidence; a reproducibility gap; or a failure that can mislead reasoning or weaken operator auditability even without demonstrated P0 impact.

P0/P1 findings remain open until fixed and independently verified. UNKNOWN is not evidence of zero blockers.

## 10. Mandatory verification and completion

Each RET task requires focused executable verification of its stated evidence, dependency and exclusion contract, `git diff --check`, and an independent read-only P0/P1 review before acceptance. Schema/persistence tasks additionally require migration/rollback, rebuild, retention/access, and scope evidence before any owner considers a schema gate. RET-008 requires the complete frozen G3/G4/G7/G11/G13/G16/G17 corpus, 10,000+ message report, security/privacy evidence, and an **independent P0/P1 review**.

Phase 4 closes only when `V3-RET-001..008` are accepted with verifiable evidence and no unresolved P0/P1 blockers. Closure does not enable runtime or customer traffic: no customer traffic, canary, deployment, promotion, or Phase 5/6 work is enabled by this packet. V3 remains PROPOSED/shadow-only, and the AI authority cutoff remains `SALES_ORDER.DRAFT`.
