# Astra V2 Architecture / Security / Reliability Review 2

## Reviewed baseline and files

Reviewed Git baseline from `git rev-parse HEAD`: `f7db579d3a21f346ac976a9ebec4153d63e74377`.

Reviewed `AGENTS.md`, `DESIGN.md`, `docs/GO_CONTRACT.md`, `docs/STATE_MACHINE.md`,
`docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/PI_AGENT_TOOLS.md`,
`docs/CHANNEL_ADAPTER.md`, `docs/V1_VERIFICATION.md`, `docs/INDEPENDENT_REVIEW.md`,
`docs/V2_ASTRA_DESIGN_REVIEW_1.md`, and all five V2 documents:
`docs/V2_ARCHITECTURE.md`, `docs/V2_SPEC.md`, `docs/V2_EPICS.md`,
`docs/V2_ROADMAP.md`, and `docs/V2_TASKS.md`. Source boundaries were inspected only
to distinguish the documented V1 evidence from planned V2 behavior. No V2 implementation
evidence is inferred from document existence.

## Executive verdict

**FAIL.** The remediation materially improves the package and resolves most review-1
findings, but P1-05, P1-08, and P1-09 remain unresolved. Therefore the package does not
yet have zero unresolved P0/P1 findings and the implementation gate must remain closed.

## Review-1 remediation table

| Finding | Result | Evidence |
|---|---|---|
| P1-01 Response grounding | RESOLVED | `V2_ARCHITECTURE.md` §4.1 defines `GroundedResponsePlan`, protected slots, canonical refs, mutable-fact re-read, fail-closed outcomes, persisted guard evidence, and Demo parity. `V2_SPEC.md` FR-07 and `V2_TASKS.md` V2-GROUND-001 make the negative/positive test contract explicit. The runtime remains planned, not implemented. |
| P1-02 Canonical precedence and workspace overlap | RESOLVED | `V2_ARCHITECTURE.md` §§4.4–4.5 explicitly makes quotation/acceptance/outbound/SO state authoritative, supplies a legal projection matrix, limits workspace states to pre-commit, requires one current revision/reference, and requires fresh canonical reads under lock. `V2_SPEC.md` FR-11 repeats the contract. |
| P1-03 Quote-time validation freshness | RESOLVED | `V2_ARCHITECTURE.md` §4.5 and `V2_SPEC.md` FR-05 require `validateForQuotation` on the exact current revision, fresh customer/product/UOM/price/stock/delivery/business reads, atomic quote evidence/snapshot creation, and rejection of stale or changed facts. |
| P1-04 Single outbound owner | RESOLVED | `V2_ARCHITECTURE.md` §§5 and 10 define `OutboundMessageService` as sole owner, exclusive per-turn `TurnOutboundDisposition`, capability-owned quotation output, stable ids, durable states, uniqueness, reconciliation, and no second runtime response. `V2_SPEC.md` FR-10 and V2-TASKS V2-OUT-002 carry the same rule. |
| P1-05 Demo correlation/replay/secrecy/grounding | UNRESOLVED | `V2_ARCHITECTURE.md` §7 normatively requires every envelope to contain `protocolVersion`, `turnId`, `sequence`, `correlationId`, and `actionId`, but the immediately following normative-looking `tool_call` example at line 281 omits all of them. The same section also gives a result-hash requirement without defining the canonical hash input. This contradiction leaves the v1 wire contract insufficiently precise for implementation and parity testing. |
| P1-06 Native/Demo semantic parity | RESOLVED | `V2_ARCHITECTURE.md` §7 and `V2_SPEC.md` FR-08 define normalized `AgentDecision`, `AgentObservation`, and `TurnTrace`, a host semantic oracle, compared state/evidence/outbound/grounding/terminal results, and an explicit wire-only difference list. |
| P1-07 Queue, late messages, and reconnect | RESOLVED | `V2_ARCHITECTURE.md` §§6 and 10 define monotonic `arrival_seq`, one bounded lease, heartbeat/expiry/resume, watermark behavior, queueing, supersession before side effects, stale rechecks, no transaction across model/provider waits, dedupe, reconnect handling, and commerce-lock revalidation. `V2_SPEC.md` FR-11 and V2-TASKS V2-QUEUE-001 provide matching acceptance tests. |
| P1-08 One-writer migration | UNRESOLVED | `V2_ARCHITECTURE.md` §§9 and 12 define the requested migration states, one writer, stable key/hash/idempotency/authority marker, quarantine, rollback, owners, and non-authoritative legacy memory. However, they provide no field-level source/owner matrix identifying which exact fields are V1-owned, V2-owned, mirrored, or read-only at each state. The requested ownership decision remains implementer discretion at precisely the split-brain boundary. |
| P1-09 Commitment matrix | UNRESOLVED | `V2_ARCHITECTURE.md` §8 and `V2_SPEC.md` FR-09 cover ACCEPT/REJECT/CANCEL/CHANGE, inherited guards, conflict precedence, idempotency, and the rule that acceptance is blocked during replacement. But active-SENT `CANCEL` says only “uses rejection/cancel guard” and does not name the canonical transition; `CHANGE` says the old quote remains active until replacement SENT but does not state in the matrix that successful replacement atomically transitions the old quote to `SUPERSEDED`. Those transitions exist elsewhere in V1/state text, but the V2 commitment matrix is not itself exact enough to be the single mutation authorization contract. |

## P0 findings

None identified. The documents preserve the irreversible-action boundary and do not authorize an AI post/confirm/DO path.

## P1 findings

### P1-05 — Demo v1 envelope is internally inconsistent

`V2_ARCHITECTURE.md` §7 says every envelope carries the correlation fields, while its
`tool_call` example omits them. The result-hash comparison is also not defined in terms
of canonical serialization or the exact covered result. Correct the example and specify
the canonical hash input before implementation. This is a protocol-contract gap, not
implementation evidence.

### P1-08 — Migration ownership is not field-level

The one-writer state machine is present, but “overlapping facts” and “one workspace writer”
do not identify ownership for each overlapping field or define the read/write behavior per
migration state. Add a normative field/source ownership matrix and make mismatch and rollback
behavior apply to those named fields.

### P1-09 — CANCEL/CHANGE matrix lacks exact canonical transitions

The matrix must state the active-SENT CANCEL result (for example, the exact guarded
`SENT -> REJECTED` mapping if that is the intended V1-compatible meaning) and must state
that replacement success atomically sends the new quote and changes the old quote to
`SUPERSEDED`. It must also retain the documented rule that unresolved `PENDING/UNKNOWN`
replacement send suspends acceptance eligibility, while the old quote remains otherwise
active until successful replacement finalization.

## P2 findings

1. The pilot budgets and alert thresholds are explicitly provisional, which is safe; implementation should still record the change-control owner and pilot measurement window.
2. Observability allowlist, redaction, role access, and provisional 90-day/7-year retention are specified; implementation should test exports and deletion/retention boundaries.
3. Production staff authentication is correctly an explicit blocker before non-demo exposure. No V2 implementation or live-model evidence is claimed here.
4. The exact Demo `tool_call` example should be corrected together with P1-05 even if the surrounding prose is treated as authoritative.

## Invariant checks

| Invariant | Result |
|---|---|
| AI autonomy ends at `SALES_ORDER.DRAFT`; no AI post/confirm/DO | PASS in the written design; `V2_ARCHITECTURE.md` §§1, 5, 8, 13 and `V2_SPEC.md` §§1, 6 preserve it. |
| Deterministic customer/SKU/UOM/conversion/price/stock/numbers/calculations/state eligibility | PASS in the written design; ERP/domain services remain authoritative and quote-time freshness is specified. |
| Explicit acceptance bound to original inbound and canonical active SENT quote | PASS in principle; inherited V1 guards are explicitly retained. Replacement blocking remains subject to unresolved P1-09 matrix precision. |
| V1 PENDING/UNKNOWN/atomic finalization/no-blind-resend | PASS in the written preservation contract; `V2_ARCHITECTURE.md` §10 and `V2_SPEC.md` FR-10 retain stronger quotation semantics. |
| Provider payload isolation | PASS in the written design; normalized channel contracts remain at the adapter edge. |
| Immutable provenance | PASS in the written requirements; source refs, evidence, revisions, snapshots, and audit are required. Migration ownership precision remains P1-08. |
| Protected facts vs connective language | PASS at contract intent: protected slots are host-rendered and connective language cannot alter them; implementation must provide the guard tests. |
| Transport parity | PASS at contract intent, subject to resolving the contradictory Demo example in P1-05. |
| Queue/lease/watermark/reconnect | PASS at contract intent; implementation evidence is not present and is not claimed. |
| Migration one-writer behavior | FAIL/P1-08: state machine exists, field-level authority matrix does not. |
| Commitment behavior | FAIL/P1-09: matrix does not fully name active-SENT CANCEL and replacement-success transitions. |
| Task dependencies and roadmap gate | PASS: V2-DRAFT-003 depends on V2-VAL-001, which depends on V2-DRAFT-002; no cycle is present. `V2_ROADMAP.md` and `V2_TASKS.md` require architecture PASS before implementation authorization. |
| Operational safeguards and review ownership | PASS in the package: provisional defaults, telemetry controls, production staff-auth blocker, evaluation ownership, and separate later implementation review are stated. |

## Implementation gate decision

Do not open the implementation gate. Resolve and owner-approve P1-05, P1-08, and
P1-09 in the normative V2 documents, then perform a subsequent independent architecture
review. The five V2 documents are a plan only; their pending tasks and acceptance criteria
are not evidence that runtime, schema, migration, or tests exist.

## Exact file-change statement

Only `docs/V2_ASTRA_DESIGN_REVIEW_2.md` was created/overwritten by this review. No other
file was edited and no commit was made.

VERDICT: FAIL
