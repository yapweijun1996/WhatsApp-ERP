# Astra V2 Architecture / Security / Reliability Review 3

## Reviewed baseline and files

Reviewed Git baseline from `git rev-parse HEAD`:
`f7db579d3a21f346ac976a9ebec4153d63e74377`.

Reviewed `AGENTS.md`, `DESIGN.md`, `docs/GO_CONTRACT.md`, and inherited V1 contract/evidence
documents: `docs/STATE_MACHINE.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`,
`docs/PI_AGENT_TOOLS.md`, `docs/CHANNEL_ADAPTER.md`, `docs/V1_VERIFICATION.md`, and
`docs/INDEPENDENT_REVIEW.md`. Reviewed all V2 documents and prior reviews:
`docs/V2_ARCHITECTURE.md`, `docs/V2_SPEC.md`, `docs/V2_EPICS.md`,
`docs/V2_ROADMAP.md`, `docs/V2_TASKS.md`, `docs/V2_ASTRA_DESIGN_REVIEW_1.md`, and
`docs/V2_ASTRA_DESIGN_REVIEW_2.md`.

This is a documentation review. V2 remains explicitly planned/documentation-only; no
runtime, schema, migration, or test implementation is inferred from these documents.

## Executive verdict

**PASS.** Round 2's P1-05, P1-08, and P1-09 are resolved in the normative V2 package.
No new P0 or P1 was found, and the earlier P1 contracts were re-checked without
regression. The implementation gate may open only as the documentation gate described
by the roadmap; implementation and its later evidence gates remain pending.

## Round-2 P1 remediation status

| Finding | Status | Review result |
|---|---|---|
| P1-05 Demo protocol | RESOLVED | `V2_ARCHITECTURE.md` §7 requires every Demo v1 envelope (`tool_call`, `capability_result`, and `final_response`) to carry `protocolVersion`, `turnId`, `sequence`, `correlationId`, and `actionId`, with the one-object/kind rule. The tool-call and final-response examples now carry the required fields. `resultHash` is SHA-256 over UTF-8 RFC 8785/JCS canonical JSON of the exact six identity/type fields plus `name`, `status`, and complete normalized `result`, excluding `resultHash` itself. Host validation/redaction precedes serialization. Replay, mismatch, out-of-order, duplicate action, unknown capability, multi-object, schema, and hash mismatch all reject; repair is one bounded same-id attempt and cannot widen capability or scope. Secrets/tokens are excluded, and Demo actions/results/final plans use the same registry and `ResponseGroundingGuard` as native transport. |
| P1-08 migration authority | RESOLVED | `V2_ARCHITECTURE.md` §§9/12 provide a normative field-level matrix across `V1_ONLY`, `SHADOW_IMPORT`, `V2_CANARY`, `V2_PRIMARY`, and `LEGACY_RETIRED`, explicitly naming legacy `customer_order_memory.pending_order` versus V2 `OrderDraft`/`OrderDraftRevision` fields and read/write authority. Canonical messages, customer/channel identity, quotation/outbound/acceptance/SO, ERP evidence, and document sequences remain outside workspace ownership. The persisted authority marker, safe-boundary cutover, stable backfill key/hash/schema/idempotency data, mismatch quarantine, V1-owner approval, rollback that freezes V2 and cannot create a second active draft, and no dual-authoritative reads/writes are explicit. |
| P1-09 commitment semantics | RESOLVED | `V2_ARCHITECTURE.md` §8 and `V2_SPEC.md` FR-09 define guarded, idempotent transitions. Active-SENT `CANCEL` is exactly `SENT -> REJECTED`; active-SENT `CHANGE` suspends acceptance while replacement is `PENDING/UNKNOWN`, keeps the old quote `SENT`, and on proven submission atomically sets new `SENT` plus old `SUPERSEDED`. A proven non-submitted terminal failure may restore old eligibility only after fresh guard checks. Accepted/Draft-SO changes cannot unwind and hand off. Conflicting accept+change selects change/clarification and never accepts. |

## P0 findings

None identified. The package preserves the V1 irreversible boundary: AI may create only
`SALES_ORDER.DRAFT`; staff-only server-enforced authority owns POST, confirmation, and
Delivery Order progression. No AI-facing capability or route authorizes those actions.

## P1 findings

None identified.

## P2 findings

1. `V2_ROADMAP.md` still describes Review 1 as the current failed review in its governing
   prose, although it also correctly requires a subsequent independent PASS. Update that
   historical label during the next documentation maintenance pass so gate status is not
   operationally confusing.
2. Pilot budgets/thresholds and retention/access defaults remain provisional; record the
   change-control owner and measurement window before pilot operation.
3. Real QR/Demo-GPT checks remain external operational evidence and are correctly gated and
   non-bypassable; they are not V2 implementation evidence.

## Regression and invariant checks

| Check | Astra result |
|---|---|
| Response grounding | PASS. Protected commercial facts are structured canonical slots, host-resolved/rendered, freshly re-read when mutable, and rejected safe on stale/fabricated/injected/contradictory/scope-mismatched claims. Model connective language cannot bypass the guard. |
| State precedence | PASS. Canonical quotation, acceptance, outbound, and SO state outranks WorkItem/OrderDraft projections; workspace states are pre-commit and cannot authorize commerce mutation. |
| `validateForQuotation` freshness | PASS. Exact current revision and customer/product/UOM/price/stock/delivery/business facts are fresh-read and atomically snapshotted; prior validation is historical only. |
| Exclusive outbound owner | PASS. `OutboundMessageService` is sole owner, with one per-turn disposition and no second runtime response after capability-owned quotation output. |
| Semantic transport parity | PASS. Native and Demo share normalized decision/observation/trace semantics and a host oracle; only enumerated wire/auth/request/latency/connective wording differences are allowed. |
| Queue/lease/watermark | PASS. Arrival ordering, bounded lease/heartbeat/expiry/resume, monotonic watermark, queued-message supersession, dedupe, reconnect handling, and fresh commerce-lock reads are specified. |
| Commitment identity/evidence | PASS. Explicit evidence remains bound to account, conversation, customer, ordering/reply/forwarding rules, active quote, and canonical revisions; model classification is proposal-only. |
| AI cutoff | PASS. V1 SSOT and V2 registry/spec/roadmap preserve the `SALES_ORDER.DRAFT` ceiling and independent staff authority. |
| Dependency DAG and roadmap gate | PASS. The listed task dependencies are acyclic for the reviewed paths; architecture PASS and V1 owner approval gate implementation, with later implementation/security review as a separate gate. |
| Provider isolation and provenance | PASS. Channel payloads normalize at the adapter edge; message-to-quote-to-acceptance-to-draft-SO/staff provenance and immutable ERP evidence remain required. |

## Implementation-gate decision

**OPEN for documentation-gated V2 implementation planning, subject to the stated V1 owner
approval and roadmap stop/go conditions.** This review does not claim that V2 is
implemented or that any pending task has evidence. Runtime/schema/migration work must
still satisfy the task evidence, deterministic behavior corpus, rollback drill, and later
independent implementation/security review.

## Exact file-change statement

Only `docs/V2_ASTRA_DESIGN_REVIEW_3.md` was created/overwritten by this review. No other
file was edited and no commit was made.

VERDICT: PASS
