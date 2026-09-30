# Astra V2 Architecture / Security / Reliability Review

## Reviewed baseline

Reviewed current HEAD `28bd3bc3df5f4f6828cd6b4e37215ffb41f591fa` and the dirty working tree as documentation under review. Read: `AGENTS.md`, `DESIGN.md`, `docs/GO_CONTRACT.md`, `docs/STATE_MACHINE.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/PI_AGENT_TOOLS.md`, `docs/CHANNEL_ADAPTER.md`, `docs/V1_VERIFICATION.md`, `docs/INDEPENDENT_REVIEW.md`, and all five new `docs/V2_*.md` documents. I also inspected the current `src/` and `tests/` boundaries, without treating absent V2 code as an implementation defect.

## Executive verdict

**FAIL.** V2 has the right safety direction and a credible bounded Pi loop, but the proposed contracts are not sufficiently precise to open implementation. The unresolved issues below can produce commercially misleading replies, split-brain workspace/commerce state, stale quotation facts, duplicate/lost outbound messages, or nondeterministic commitment handling. These are P1 design gaps; no P0 path is identified in the written plan because the inherited V1 guard is explicitly retained.

## P0 findings

None identified in the documents. This is not a PASS: unresolved P1 findings block implementation.

## P1 findings

### P1-01 — Final-response grounding is asserted, not enforceable

`V2_ARCHITECTURE.md` §4.1 and §5 say final responses must be grounded, and §7 adds `groundingRefs`, but no validator contract defines which facts may be stated, how references bind to current canonical records, how totals/prices/stock/status are checked, or what happens when text contains an unsupported commercial claim. `V2_SPEC.md` FR-07 and acceptance criterion 9 likewise require the outcome without making it verifiable. A model can therefore produce a plausible but false price, availability, quote status, delivery date, or commitment response while all tools remain deterministic.

Remediation: add to `V2_ARCHITECTURE.md` §4.1/§7 and `V2_SPEC.md` FR-07 a response-grounding contract: structured allowed fact claims with canonical source/version/evidence refs, authoritative-state snapshot id, and permitted response intents; a server-side response validator that rejects or rewrites unsupported numeric/commercial/status claims; mandatory re-read for mutable state; and a fail-closed safe template/handoff. Test positive, stale, contradictory, injection, and fabricated-claim cases in the corpus.

### P1-02 — Canonical-state precedence and WorkItem overlap are not modeled as a transition contract

`V2_ARCHITECTURE.md` §4.4–§4.5 and §8 say WorkItem/OrderDraft states are workspace-only and quote/SO state is canonical, but do not provide a transition matrix or invariants for overlapping states such as `QUOTING`, `AWAITING_ACCEPTANCE`, `COMPLETED`, `CANCELLED`, a draft changed after a sent quote, an accepted quote, or an existing Draft SO. `V2_SPEC.md` FR-04/FR-05 repeats the principle without defining which service wins, how references become inactive, or how a WorkItem resumes after canonical state changes. This is a direct split-brain risk.

Remediation: add a normative precedence and mapping table in `V2_ARCHITECTURE.md` §4.4/§4.5/§8 and `V2_SPEC.md` FR-04/FR-05. Make canonical quotation/SO state authoritative whenever overlap exists; define legal WorkItem/draft transitions, terminal/reference rules, stale-context behavior, and database constraints for one active revision/reference. Require each mutation to re-read canonical state in one transaction.

### P1-03 — Draft validation freshness before quotation creation is unsafe

`V2_ARCHITECTURE.md` §4.5 says a quote copies a validated snapshot and §10 says deterministic validation is used, but neither document requires validation immediately before `prepare_quotation`, defines a validity interval/version for price and stock evidence, or states how price validity dates, delivery date, customer status, and stock changes are handled between draft validation and quote creation. `V2_SPEC.md` FR-05 permits validate and later quote as separate actions. Earlier validation can silently become quote truth.

Remediation: specify in `V2_ARCHITECTURE.md` §4.5/§8/§10 and `V2_SPEC.md` FR-05/FR-10 that quotation preparation must atomically verify current draft revision, customer/UOM/conversion, price validity at quotation time, delivery policy, and required stock evidence; define TTL/source version and invalidation rules; never promote stale evidence; return `NEEDS_CLARIFICATION` or require revalidation. Add a test with changed price/stock/customer policy between validation and quote.

### P1-04 — Outbound ownership permits duplicate or lost customer messages

`V2_ARCHITECTURE.md` §5 exposes both `send_quotation` and `send_safe_customer_message`; §6 step 8 separately invokes outbound handling; §10 says clarification reliability should be brought under the service “where appropriate”. There is no single reply ownership contract deciding whether the runtime final response, a capability, or the turn coordinator creates the outbound intent. No uniqueness/idempotency rule covers non-quotation replies, nor is there a rule preventing a capability send plus a final response for one turn. This can duplicate quotation/clarification replies or lose them on crash, while conflicting with the frozen V1 quotation protocol.

Remediation: define in `V2_ARCHITECTURE.md` §5/§6/§10 and `V2_SPEC.md` FR-07/FR-10 one OutboundMessageService API and an exclusive per-turn outbound decision: exactly one customer-facing response intent (or an explicitly declared capability-owned quotation response), stable key, snapshot hash, status/reconciliation policy, and atomic link to the turn/action. Make quotation sends the sole owner of quotation text/submission and prohibit a second final response after a sent capability unless the result explicitly requires a separate reply. Add crash, retry, duplicate, and reconnect tests for clarification, handoff, and quote messages.

### P1-05 — Demo transport lacks a complete correlation/replay/secrecy/grounding contract

`V2_ARCHITECTURE.md` §7 specifies one JSON object and a repair attempt, but the protocol has no turn/action/result correlation field, nonce or replay policy, maximum input/output/token bounds, or explicit rule that repair output cannot widen authority. It also does not define how final-response grounding validation from P1-01 is applied to Demo output. “`dmo_` tokens are memory-only” is not enough to specify logging, exception, tracing, or prompt-redaction behavior. Multiple JSON and unknown-key rejection is useful syntax validation but does not itself prevent replay or host-loop bypass.

Remediation: extend `V2_ARCHITECTURE.md` §7 and `V2_SPEC.md` FR-08/security requirements with a versioned envelope containing turn id, expected action sequence, correlation id, and bounded payload; reject replay/out-of-order results; keep secrets/tokens out of prompts, logs, persistence, and error text; constrain repair to the same schema/budget; route final text through the grounding validator; and require bridge tests for replay, mismatched result, token leakage, and direct-bypass attempts.

### P1-06 — Native/Demo “semantic parity” is not defined strongly enough to be testable

`V2_ARCHITECTURE.md` §7 and `V2_SPEC.md` FR-08 say transports share semantics, while `V2_EPICS.md` E6 and `V2_TASKS.md` V2-TRAN-001/004 request parity tests. They do not define canonical fixtures, normalization of model outputs, action ordering, error mapping, final-response validation, or an allowed transport-difference policy. Native tools may expose typed calls while Demo uses text JSON; without a host-level semantic oracle, the same prompt can reach different capability calls or different failure behavior.

Remediation: define in `V2_ARCHITECTURE.md` §7 and `V2_SPEC.md` FR-08 a transport-independent turn trace/oracle: canonical context fixture, one normalized `ToolCall|FinalResponse`, identical registry invocation/result/error/stop semantics, and explicitly enumerated transport-only differences. Make one corpus execute both transports and compare state changes, evidence, outbound intents, handoff, and final-response validation—not merely HTTP/parser success.

### P1-07 — Late-message serialization and provider reconnect behavior are underspecified

`V2_ARCHITECTURE.md` §6 says messages are ordered by provider time plus arrival tie-breaker and stale revisions are rejected/clarified; §10 lists provider reconnect as a failure. This does not define whether a late message can change an already processed decision, how a message whose provider timestamp predates an outbound is classified, lock duration across model/network waits, queue ownership, or reconnect deduplication/ack behavior. `V2_ROADMAP.md` Phase 7 names these tests but does not establish the contract.

Remediation: specify in `V2_ARCHITECTURE.md` §4.4/§6/§10 and `V2_SPEC.md` FR-01/FR-10 a per-conversation ordered inbox/lease model, monotonic processing watermark, late-message policy, cancellation rules, lock/queue boundaries, provider reconnect and redelivery semantics, and durable turn resume state. Require no action based on an older context snapshot and require acceptance/requote to revalidate under the commerce lock.

### P1-08 — Migration leaves dual-authority and rollback ownership unresolved

`V2_ARCHITECTURE.md` §9 calls `customer_order_memory.pending_order` “legacy compatibility only” and permits dual-read/dual-write behind flags, but does not define the authoritative read/write cutover per field, reconciliation mismatch policy, backfill identity/idempotency, schema version compatibility, or who can resolve divergence. `V2_ROADMAP.md` Phase 2/6 and `V2_TASKS.md` V2-WORK-003/V2-MIG-001–003 defer these decisions to implementation. “Backward-readable” does not prevent two writers from producing different active drafts.

Remediation: add a field-level ownership matrix, migration state machine, deterministic backfill key, one-writer rule, mismatch quarantine/hand-off policy, schema version/rollback compatibility, and explicit owner/approval in `V2_ARCHITECTURE.md` §9/§12 and `V2_ROADMAP.md` Phase 2/6. Until cutover, V2 must be shadow/read-only for overlapping workspace facts; rollback must disable V2 writes without creating a second active revision.

### P1-09 — Commitment semantics beyond positive acceptance remain incomplete

`V2_ARCHITECTURE.md` §8 and `V2_EPICS.md` E8 mention rejection, cancel, and change, but do not specify canonical state transitions, evidence binding, reply-to requirements, precedence when a message says both accept and change, or exactly-once/idempotency behavior for rejection/cancel/change. The inherited V1 rules precisely cover explicit acceptance, but V2 broadens semantic assistance to other commitment-like outcomes without an equivalent deterministic contract.

Remediation: add a normative commitment matrix in `V2_ARCHITECTURE.md` §8 and `V2_SPEC.md` FR-09 covering accept/reject/cancel/change, explicit phrase policy, active quote identity, reply/forward/order/account/customer checks, stale/superseded/UNKNOWN handling, conflicting messages, and transaction/idempotency outcomes. Only CommitmentGuard may invoke each legal canonical transition; all other classifications remain proposals.

## P2 findings

1. `V2_ARCHITECTURE.md` §6 leaves exact budgets as “configuration reviewed with implementation”; publish initial operational defaults and metric thresholds before pilot.
2. `V2_ARCHITECTURE.md` §14 and `V2_ROADMAP.md` leave Pi persistence API, summary retention, handoff SLA, production staff authentication, and Meta reconciliation open. These are P2 only where they cannot alter the authority/state contracts above; production staff authentication becomes P1 before non-demo exposure.
3. `V2_TASKS.md` V2-EVAL-003 places real QR evaluation before final review, while `V2_SPEC.md` acceptance criterion 10 also requires real-channel evidence. Make the evidence owner and exact gate ordering explicit.
4. Observability requirements should include an explicit allowlist/redaction test for evidence payloads, model/tool inputs, and provider error metadata (`V2_ARCHITECTURE.md` §11; `V2_SPEC.md` §6), including retention and access control.

## Detailed invariant checks

| Invariant/check | Astra result |
|---|---|
| V1 lifecycle and staff authority | Preserved textually; `SALES_ORDER.DRAFT` remains the AI ceiling and StaffCommitService is outside Pi. PASS subject to implementation proof. |
| Deterministic customer/SKU/UOM/price/stock/numbers/calculation | Explicitly preserved. Freshness gap is P1-03. |
| Acceptance evidence and canonical active SENT quote | Guard is correctly named and includes key inherited checks; full non-positive commitment matrix is P1-09. |
| Durable quotation outbound and no blind resend | V1 protocol is repeatedly retained; ownership conflict for general replies and final responses is P1-04. |
| Provider payload isolation | Explicitly preserved at adapter edge. PASS as a design invariant. |
| Immutable provenance | Required across messages, revisions, quotes, acceptance, SO, evidence, and audit. Migration/source ownership remains P1-08. |
| Agentic runtime | Pi is clearly described as bounded observe → act → observe with multi-capability acceptance criterion. PASS in intent; resumability/concurrency precision is P1-07. |
| Authority split and profile non-authority | Correct principle: server registry/domain guards win. The plan needs executable contract tests, but no P1 principle defect beyond the state/migration gaps. |
| WorkItem/OrderDraft versus canonical quote/SO | P1-02. |
| Context/memory injection and bounds | Good non-authority and redaction intent; response grounding and transport leakage gaps are P1-01/P1-05. |
| Demo/native equivalence | P1-06, with protocol hardening in P1-05. |
| Failure budgets/recovery | Bounded loop and fail-closed language exist; exact recovery/queue semantics remain P1-07 and P1-04. |
| Behavior corpus | Broad and avoids hardcoded intent proliferation; it is an acceptance target, not evidence. |
| Roadmap/task ordering | The architecture gate is correctly first. Implementation is not ready because several “define/resolve during implementation” items are authority contracts; see P1-03/P1-08 and the stated open questions in `V2_ARCHITECTURE.md` §14. |

## Implementation gate decision

The implementation gate may **not** open. Resolve and owner-approve every P1 above, update the exact referenced V2 sections, then re-review the resulting documents before runtime/schema/migration work. Do not treat tests written after an ambiguous contract as a substitute for deciding authority and state ownership first.

Only `docs/V2_ASTRA_DESIGN_REVIEW.md` was added/changed by Astra. Existing untracked V2 plan files were preserved.

VERDICT: FAIL
