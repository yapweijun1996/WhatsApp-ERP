# V3 CP-001 Review — Durable Versioned InboundBundle

Status: **PASS — P0=0 / P1=0; shadow-only**
Date: 2026-09-14 (Asia/Singapore)

## Implementation contract

`src/v3-inbound-bundle.ts` defines the versioned `V3-CP-001` `InboundBundle` contract with:

- exact, non-empty, duplicate-free `messageIds[]` in V2 arrival order;
- `conversationRevisionAtBuild`, `bundleRevision`, `closeReason`, `processingState`, timestamps, `bundleId`, and stable `replayIdentity`;
- canonical SHA-256 replay identity bound to account, conversation, both revisions, and the exact ordered message set;
- detached, deeply frozen, integrity-validated outputs with explicit `NON_AUTHORITATIVE_SHADOW` authority;
- fail-closed validation for invalid revisions, scopes, timestamps, close/state values, replay identity, bundle identity, and missing/duplicate/out-of-order refs.

The projection is read-only. It does not interpret message text, use keyword/regex intent logic, send messages, mutate ERP state, or widen AI authority.

## Ownership reuse

CP-001 reuses existing V2 durable ownership:

- `messages` is the source message evidence;
- `messages.arrival_seq` is the sole receipt chronology;
- `v2_inbox_items` is the scoped membership/dedupe bridge;
- `v2_conversation_inbox.revision` is the conversation revision source;
- existing V2 enqueue dedupe remains the replay authority.

No competing V3 chronology, dedupe, authority ledger, runtime path, provider payload, outbound owner, or schema change was introduced. `OutboundMessageService` remains the sole provider-send owner.

## Validation evidence

- `tests/v3-inbound-bundle.test.ts`: CP-001 focused contract tests PASS (5/5), covering deterministic identity, exact ordered membership, V2 dedupe/replay, detached immutable output, monotonic revision validation, scope validation, and invalid/missing refs.
- `npm test`: PASS — 54/54 test files, 54/54 passed.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.
- Direct `adapter.send(...)` scan: occurrences remain only in `src/outbound-message-service.ts`.
- Forbidden capability/cutoff scan: POST/CONFIRM Sales Order and Delivery Order restrictions plus `SALES_ORDER.DRAFT` cutoff remain present.
- `schema.sql` was not edited in this run; its pre-existing dirty state was preserved.
- `docs/CONVERSATION_INTELLIGENCE_V3.md` remains `PROPOSED`.

## Remaining boundaries

CP-001 and the separately reviewed shadow-only CP-002 are complete. CP-003..007 remain open and are not implemented or authorized by this continuation. Existing V1/V2 authority semantics and the AI cutoff at `SALES_ORDER.DRAFT` remain unchanged.
