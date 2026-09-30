# V3-EVAL-001 Deterministic Golden Corpus

Status: **ACCEPTED — Goal-First Fast Track, shadow-only**

## Scope and reuse boundary

`tests/v3-eval-001.test.ts` is a 23-case executable index. Each case is independently selectable with Node's anchored `--test-name-pattern='^EVAL-001 G#:'` naming convention and delegates to exactly one existing focused test through `src/v3-eval-001-corpus.ts`. The runner escapes each child name and requires exact `tests 1`, `pass 1`, and `fail 0` summaries, preventing zero-match or multi-match false passes. The corpus adds no production logic, provider call, schema, runtime wiring, outbound owner, or authority beyond `SALES_ORDER.DRAFT`.

## Golden mapping

| Golden | Criterion | Reused executable scenario / oracle | Evidence |
|---|---|---|---|
| G1 | Rapid multi-bubble order | Eight rapid product/quantity/delivery/quotation/listing bubbles are projected into one bounded bundle, passed once through the deterministic scripted semantic seam, and composed into one released response plan | PASS |
| G2 | Interrupted burst / stale-plan fence | CP-007 interrupted burst; stale revision is rejected and replanning is required | PASS |
| G3 | Long conversation recall | RET-008 exact source reopen | PASS |
| G4 | Ambiguous same-as-last-time | RET-008 historical evidence remains separate from current ERP verification | PASS |
| G5 | Image recall | MM-007 image Search→Read lineage and ERP re-verification | PASS |
| G6 | PDF recall | MM-007 exact PDF page evidence and conflict-driven replan | PASS |
| G7 | Reply relation | RET-008 reply linkage resolves the referenced proposition | PASS |
| G8 | Open obligation continuation | GOAL gate preserves an open obligation and durable continuation | PASS |
| G9 | No empty promise | GOAL gate rejects an ungrounded completion/promise | PASS |
| G10 | Canonical conflict | Stale pending/not-accepted derived memory is paired with current canonical `ACCEPTED` quotation + `SALES_ORDER.DRAFT`; the canonical rows win and the derived memory remains non-authoritative/reverification-required | PASS |
| G11 | Cross-customer isolation | RET-008 foreign evidence fails closed without existence leakage | PASS |
| G12 | Prompt injection attachment | MM-007 attachment remains untrusted, non-authoritative, and bounded | PASS |
| G13 | 10,000+ message performance | RET-008 reproducible benchmark and declared budget oracle | PASS |
| G14 | Multilingual/code-switching | Chinese + English + Malay/product-shorthand bubbles reach the deterministic scripted semantic seam as one model-facing payload and one released result without Host language rules; this is seam/orchestration evidence, not a claim of model language understanding | PASS |
| G15 | Concurrent Goal Graph | GOAL gate preserves four independent goals, links, terminal isolation, and restart readback | PASS |
| G16 | Retrieval budget / abstention | RET-008 bounded retrieval loop ends in abstention | PASS |
| G17 | Server scope tampering | RET-008 tampered scope fails before retrieval with no existence leak | PASS |
| G18 | Atomic admission TOCTOU race | CP-007 both SQLite admission interleavings are linearized | PASS |
| G19 | Fenced lease crash/resume | CP-007 restart reacquisition fences the old generation and avoids duplicate effects | PASS |
| G20 | Non-message freshness invalidation | CP-007 dependency mutation invalidates the plan without new inbound | PASS |
| G21 | Partial multi-unit response interruption | FUL-004 proves exactly one submitted prefix, marks the stale remainder `SUPERSEDED`, fails closed, and does not replay the prefix on retry | PASS |
| G22 | Durable continuation / no promise loophole | GOAL gate rejects invalid continuation inputs structurally | PASS |
| G23 | Async multimodal extraction wake | MM-007 extraction completion advances freshness and resumes only eligible work | PASS |

## Verification record

The acceptance run is intentionally scoped to EVAL-001, followed by `npm run typecheck` and `git diff --check` on the touched EVAL-001 files. The verified targeted count is **23/23 PASS**. No broad regression suite, schema change, deployment, runtime enablement, or customer traffic is part of this increment. V3 remains `PROPOSED` and shadow-only.

## Independent review

Independent Codex read-only review job `f2200832-dc6c-4c76-954f-4ae8b4ab6a69`: **VERDICT PASS_P0_0_P1_0**. P0=0, P1=0. One P2 is retained as evidence-precision backlog: G1/G14 use a deterministic scripted semantic fixture whose wording is intentionally not interpreted, so those cases prove the semantic seam/orchestration path and single-run behavior rather than live-model language understanding. G10 confirms canonical `ACCEPTED` + `SALES_ORDER.DRAFT`; G21 confirms submitted-prefix preservation plus stale-remainder supersession. No release/customer/runtime authority was widened.
