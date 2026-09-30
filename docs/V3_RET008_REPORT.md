# V3-RET-008 Retrieval Gate Report

Status: **ACCEPTED COMPLETE — GOAL-FIRST FAST TRACK / PHASE 4 SHADOW-ONLY**

Date: 2026-09-19 (Asia/Singapore)

## Goal-First scope

RET-008 closes the Phase 4 retrieval evidence gate only. It does not enable V3 runtime/customer traffic, schema expansion, deployment, canary/promotion, multimodal extraction, outbound ownership changes, or AI authority beyond `SALES_ORDER.DRAFT`. The evaluator reuses accepted RET-003..007 surfaces and adds no production retrieval implementation.

## Frozen evaluator

- Harness: `tests/v3-ret-008-evaluator.test.ts`
- Seed: `20260919`
- Raw conversation corpus: **10,240 messages**
- Bounded source-linked active retrieval index: **1,000 messages**, matching the existing V3 conversation-memory hard cap. This is deliberate progressive retrieval, not full-history prompt stuffing.
- Long-recall source: `m-00999`, **9,240 raw messages before the conversation tail**.
- Retrieval loop budgets: max 8 steps / 8 tool calls / 8 evidence items / 20,000 evidence bytes / 100,000 read bytes / 50 candidate items / 4,000 conservative evidence-token units / 2 consecutive no-new-evidence / 250 ms loop elapsed budget.
- Token note: RET-006 currently charges a conservative **one UTF-8 byte per evidence-token unit**. This is not claimed to be a provider tokenizer measurement.
- Performance acceptance targets: fixture+index build <5,000 ms; search p95 <1,500 ms; source open <250 ms; one retrieval loop <250 ms.
- Environment captured by the run: Node `v24.20.0`, Linux arm64.

## Golden evidence

| Gate | Evidence | Result |
|---|---|---|
| G3 long recall | Semantic search locates `m-00999`, then exact `conversation_get_message` source reopen; source is 9,240 raw messages behind tail. | PASS |
| G4 same as last time | Historical search is explicitly non-authoritative and requires canonical reverification. Existing RET-005 ladder evidence separately proves historical ERP is read-only handoff and current ERP reverification remains mandatory. | PASS |
| G7 reply relation | `m-00001` resolves its reply parent `m-00000` from stored reply linkage/thread graph. | PASS |
| G11 cross-customer isolation | A real foreign account/customer/conversation contains the same search term; current-customer search returns only `m-00500`, and direct foreign-message open fails generically without exposing foreign content. | PASS |
| G13 10,000+ performance | 10,240 raw messages with bounded 1,000-source active index; actual benchmark below declared latency and candidate/token budgets. | PASS |
| G16 budget/abstention | Insufficient retrieval terminates as bounded `ABSTAIN` by no-new-evidence/max-step semantics; no hallucinated completion. | PASS |
| G17 scope tampering | Foreign Host authority/token binding fails before evidence; model request scope injection is rejected as invalid; errors contain no foreign IDs/customer data. | PASS |

## Final targeted run

Command: `node --test --import tsx tests/v3-ret-008-evaluator.test.ts`

- **7/7 PASS**
- fixture+index build: **178.060 ms**
- search p95 (16 deterministic searches): **736.640 ms**
- exact source open: **131.919 ms**
- bounded retrieval loop: **125.354 ms**
- candidate budget: **50**
- evidence-token budget: **4,000 conservative UTF-8-byte units**

G4 supporting command: `node --test --test-name-pattern='RET-005 historical ERP is capability handoff only and cannot replace current truth|RET-005 deeper historical layers always require current ERP reverification' --import tsx tests/v3-retrieval-ladder.test.ts`

- **2/2 PASS**

No full repository regression was run because Goal-First Fast Track requires targeted evidence unless a concrete cross-project failure demands broader testing.

## Security / privacy / authority

- Server-derived retrieval scope remains `tenant/account/channel-account/conversation/customer`; model request fields cannot widen it.
- Foreign real evidence is present in the benchmark DB and remains unreachable from the current retrieval tools.
- Retrieved/historical evidence is non-authoritative and cannot grant effects.
- Current ERP facts still require existing canonical Host capabilities before a consequential decision.
- `SALES_ORDER.DRAFT` remains the AI autonomy cutoff.
- No customer/runtime wiring, provider send, schema migration, deploy, commit, or push is part of RET-008.

## Non-blocking backlog

- **P2 performance:** current source freshness/provenance validation intentionally rechecks a bounded source set and makes search p95 ~737 ms on this workstation. It is within the frozen 1,500 ms target but can be optimized later if the same freshness guarantees are preserved.
- The active derived index is intentionally bounded to 1,000 cited source messages even when raw history is 10,240+. Future retrieval-quality work may improve source-selection/section derivation; RET-008 does not widen the accepted memory contract.

## Independent review and decision

Frozen packet reviewed:

- evaluator SHA-256: `ac0bbf3f8d90a41d8213c0b4bd39e649e4f57ac335b0fb47c97e46a09d75806f`
- pre-review report SHA-256: `f1f4faf71b6e312f9b6e17de557b0058d0b8ffffef846749a27af6f422ea6973`
- independent GPT-5.6 Luna read-only review, executed through VMMCP-controlled Codex CLI: **PASS P0=0 P1=0 — no blockers**. VMMCP command hash: `432099f566c1d7bae3fd03bdce75437959493adf1ca10d8331a19cc1f193e291`.

RET-008 is **ACCEPTED COMPLETE** for the authorized Phase 4 shadow-only scope. Phase 4 retrieval is **8/8 complete**. This closure does not enable runtime/customer traffic, deploy/canary/promotion, or authority beyond `SALES_ORDER.DRAFT`.
