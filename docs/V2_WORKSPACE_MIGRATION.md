# V2 Workspace Migration — MIG-001

Status: **CURRENT MIGRATION CANDIDATE / MIG-003 REVIEW-CLOSED / V2 TRAFFIC STILL DISABLED**

This phase adds the durable WorkItem/OrderDraft workspace and its migration safety model. It does not route customer traffic to V2, does not implement the Pi agent loop, and does not move quotation/Sales Order/ERP authority away from V1 canonical tables.

## Authority model

The persisted authority key is `(account_id, conversation_id, SALES_ORDER_REQUEST)`. Legal states are:

`V1_ONLY/LEGACY → SHADOW_IMPORT/LEGACY → V2_CANARY/V2 → V2_PRIMARY/V2 → LEGACY_RETIRED/V2`.

Only `V2_CANARY`, `V2_PRIMARY`, or `LEGACY_RETIRED` may perform normal WorkItem/OrderDraft mutations. `V1_ONLY` and `SHADOW_IMPORT` fail closed with `V2_WRITES_NOT_AUTHORIZED`. Authority creation, deletion, transitions, and migration-controlled metadata are database-enforced. Raw authority INSERT requires a process-scoped initialization function and can only create `V1_ONLY/LEGACY`; raw DELETE is forbidden outside the process-scoped reset path. Migration UPDATE requires the process-scoped migration authorization function plus a newly chained immutable `workspace_migration_events` row whose previous-event id, from/to state, writer, approval action, and approval subject match the exact authority update. The SQLite gate also binds each legal transition (including same-state quarantine metadata) to its exact active action/owner mapping, so a valid approval for one action cannot authorize another via raw SQL. Raw SQL INSERT/DELETE/state-writer flips therefore fail even when their value pair is otherwise legal. Canonical messages, identity, quotation/outbound/acceptance/Sales Order state, ERP evidence, stock/price truth, and document sequences never become workspace-owned.

Migration service transitions require process-local opaque approvals. `MIGRATION_OWNER` approves shadow import, V2 primary promotion, and legacy retirement; `V1_OWNER` approves canary promotion and rollback. Approval subjects and actions are verified by the service authority and persisted only as bounded evidence in immutable migration events/snapshots. Plain request labels, serialized objects, or forged actor strings cannot authorize a transition.

## Shadow import

`shadowImport` is migration-only. It reads the newest legacy `customer_order_memory.pending_order` for the conversation, canonicalizes the parsed JSON, computes SHA-256, and records schema version `customer_order_memory.pending_order.v1` plus an immutable migration event and idempotency hash.

If no legacy pending row exists, the empty workspace (`null`) is a valid shadow source. The marker becomes `SHADOW_IMPORT/LEGACY` without creating a draft. This allows a clean conversation to be promoted at a safe boundary and create its first V2 WorkItem afterward.

If a valid legacy pending row exists, migration creates or refreshes a **read-only V2 projection**: a derived `WorkItem`, current `OrderDraft`, current `order_draft_lines`, and immutable `OrderDraftRevision`. The authority remains `LEGACY`; runtime V2 writes are still rejected. Re-importing the same canonical source does not create a duplicate draft revision.

Malformed JSON, invalid line/date data, source-message scope errors, legacy account/customer mismatch, legacy sender-external-id mismatch against the canonical inbound message, or other projection failures set `quarantine_reason` and persist a quarantine migration event. Quarantined work cannot promote automatically. Exact same-input replay of a quarantine returns the immutable prior `QUARANTINED` result; same-key/different-input still fails `IDEMPOTENCY_CONFLICT`.

## Canary promotion

`promoteCanary` fresh-reads the legacy source immediately before cutover and requires:

- current marker is `SHADOW_IMPORT/LEGACY`;
- no quarantine;
- fresh source hash equals the expected shadow hash;
- expected WorkItem identity matches the shadow projection when one exists;
- expected current Draft revision matches when a shadow draft exists;
- a non-empty legacy source has a verified current V2 shadow draft;
- no accepted commercial commitment, active `DRAFT`/`SENT` quotation, or unresolved `PENDING`/`UNKNOWN` outbound for the conversation.

The promotion transaction verifies the current projection and then inserts a chained immutable migration event before flipping exactly one authority marker to `V2_CANARY/V2`; the database trigger verifies that exact event during the update. A changed legacy source or canonical sender-identity mismatch is quarantined instead of choosing one side. Exact quarantine replay returns the recorded result.

## Normal V2 workspace writes

Once V2 owns the marker:

- `WorkItemService` enforces one active `SALES_ORDER_REQUEST`, legal pre-commit states, optimistic WorkItem revision, source-message scope, stable idempotency, and canonical commitment precedence.
- `OrderDraftService.create/update` requires V2 authority, stable idempotency, exact WorkItem revision, exact Draft revision for updates, scoped source messages, normalized positive quantities/UOM/date values, and canonical commerce re-checks. Quantities are limited to at most three decimal places and must round-trip exactly through the V1 numeric representation within safe integer-scaled precision; unsafe magnitudes fail closed rather than risking rollback rounding.
- `order_draft_revisions`, `work_item_events`, `workspace_provenance_links`, and `workspace_migration_events` are append-only outside the explicit process-scoped local reset path.
- active `DRAFT`/`SENT` quotation or unresolved outbound blocks generic draft mutation until the later quotation/change capability owns that transition; accepted quote/Draft SO always blocks AI draft mutation and requires handoff.

## Rollback

Phase 1A rollback is implemented, not simulated. It is allowed only from `V2_CANARY`/`V2_PRIMARY` at a safe canonical boundary. If a current V2 draft exists, rollback first materializes that exact requested workspace back into a V1-compatible `customer_order_memory.pending_order` inside the same transaction, preserving customer/account/source-message/delivery/line wording/quantity/UOM/remark. Quantity conversion is guarded by exact string-to-number round-trip validation, so rollback cannot silently round a draft value. It then flips authority to `V1_ONLY/LEGACY` and records an immutable migration event.

V2 history is preserved after rollback and immediately becomes non-authoritative. Further V2 mutations fail closed. Rollback refuses accepted commitments, active quotation work, unresolved outbound, or missing canonical source-message evidence.

## Idempotency and audit

Shadow import, promotion, and rollback each require a stable idempotency key. `workspace_migration_events` stores the normalized input hash, previous migration-event id, immutable result snapshot, and transition evidence. `workspace_authority.last_migration_event_id` forms the checked event chain. Exact replay, including quarantine/error outcomes, returns the prior durable result; same-key/different-input fails `IDEMPOTENCY_CONFLICT`. Direct update/delete of migration, revision, event, or provenance history is blocked by SQLite triggers unless the in-process `resetAndSeed()` reset authorization function is active. No writable maintenance-flag table exists.

## Primary promotion and legacy retirement

`promotePrimary` requires `V2_CANARY`, a fresh unchanged legacy compatibility hash, no quarantine, and a safe canonical boundary. `retireLegacy` requires `V2_PRIMARY`, the same compatibility checks, an explicit compatibility confirmation, and a safe boundary. MIG-001 changes only the persisted authority marker; it does not delete legacy pending JSON. Legacy cleanup remains MIG-003 work.

MIG-003 cleanup is a distinct owner-approved action after `LEGACY_RETIRED`. Its dual-read completion gate is the completed migration/compatibility evidence already required by `RETIRE_LEGACY` (including the unchanged scoped source hash and compatibility read), plus a separate opaque `CLEANUP_LEGACY` approval; no time duration is assumed. Cleanup re-reads and hashes the scoped legacy source, appends a chained same-state `LEGACY_CLEANUP` event, and deletes only that conversation's `pending_order` rows in the same transaction. State, approval, hash, identity, and scope mismatches fail closed; exact idempotent replay returns the durable cleanup result. Database guards reject raw pending-order deletion and reject new or updated retired pending-order compatibility data, while preserving unrelated `customer_order_memory` rows. The cleanup does not alter quotation, acceptance, Sales Order, confirmation, or Delivery Order authority; AI autonomy remains capped at `SALES_ORDER.DRAFT`.

## Compatibility and rollout status

All schema changes are additive and V1 does not read the new workspace tables. On existing databases, startup explicitly replaces the two migration-authorization triggers from the current schema definition after adding approval-evidence columns, preventing an older `CREATE TRIGGER IF NOT EXISTS` definition from surviving an upgrade with weaker checks. `resetAndSeed()` explicitly clears the V2 workspace under a private process-scoped reset authorization depth so demo/test reset remains deterministic; raw SQL cannot forge reset mode. `V2-VAL-001` now provides the read-only deterministic ERP validation foundation, including quote-time freshness semantics and remediated exact decimal arithmetic. `V2-DRAFT-003` now provides revisioned deterministic workspace actions, including SENT-quote requote preparation without quote send/supersession; `V2-VAL-002`, quote preparation, capability registry, agent context/runtime, transport bridge, commitment extraction, and V2 traffic routing remain later tasks. V2 traffic remains disabled.

MIG-003 is review-closed on the current candidate: focused migration 28/28 PASS, full regression 397/397 PASS, typecheck PASS, build PASS, Chromium E2E 1/1 PASS, npm audit 0 vulnerabilities, git diff --check PASS, sole direct `adapter.send` in `src/outbound-message-service.ts`, and independent final review PASS with P0=0/P1=0/P2=0. V2 customer traffic remains OFF and AI autonomy remains capped at `SALES_ORDER.DRAFT`. This does not claim release readiness. The P2-01 atomic cross-line quote snapshot and P2-02 delivery-policy validation advisories remain preserved as later quote-preparation work; this phase does not claim either capability.

## Capability-scoped rollout — MIG-002

MIG-002 adds a server-owned, durable rollout authority without changing the one-writer workspace state machine. `v2_capability_rollouts` stores one flag at global, account, or conversation scope; the most specific matching scope wins. Only an opaque process-local rollout approval can create or change a flag, and `v2_rollout_events` is immutable evidence with stable idempotency. Both the service and the database independently verify the exact captured opaque approval/action before opening the SQLite rollout gate; no caller-provided verified object, verifier, or authority can bypass it. Unknown capabilities, malformed scope/configuration, forged approval objects, direct gate misuse, cross-action tokens, raw SQL, and invalid scope relationships fail closed.

`effectiveV2` is true only when the configured capability flag is enabled and the persisted MIG-001 authority for the exact account/conversation is a V2 writer in `V2_CANARY`, `V2_PRIMARY`, or `LEGACY_RETIRED` without quarantine. Explicit rollback writes a durable `ROLLBACK` event and stops new V2 capability use; it does not delete messages, migration events, revisions, evidence, quotes, acceptances, Sales Orders, outbound intents, or legacy pending JSON. Configured/effective status is exposed as allowlisted capability names, states, and reason codes through operational telemetry only. No model, customer payload, or public route can issue rollout authority, and this seam does not enable global V2 customer traffic or any post-Draft/confirmation/DO behavior.
