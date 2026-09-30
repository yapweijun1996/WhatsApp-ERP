# Real migration milestones and done criteria

## M1 — isolated engineering preparation (this task)

Reuse V2 identity, commerce and approval contracts. Remove the legacy default-customer fallback, resolve existing verified sender bindings even for a new conversation, and preserve existing conversation ownership. Add paused startup that performs no channel connect/reconcile/commerce write, clear read-only UI, and the existing Bearer-bootstrap staff UI path without creating credentials. All changes stay on preparation/real-cutover-readiness with synthetic DBs/intercepted outbound.

Done: typecheck/build, full offline unit/integration suite, browser tests for default boundaries/staff credential clearing/paused UI, identity regression tests, startup inbound-drop/write-block test and secret/diff checks pass. Existing V2 canonical draft suite must remain green. Record exact results and limitations; automated evidence does not prove physical WhatsApp operation.

## M2 — reviewed final data sync and owner pairing (separate production action)

Pre-stage all code, private directories, reviewed decrypt helper, gateway settings and rollback command before outage. Confirm owner is at Air with WhatsApp available. At the reviewed window, stop the single VM unit, verify stopped/no restart; create one consistent final SQLite backup preserving WAL and outbound ledgers; encrypt/transfer, verify ciphertext; owner runs the final pinned decryption helper once. Preserve pristine source/snapshot and original VM data/auth. Start Air in pairing-only paused mode, then owner scans at https://whatsapp-erp.gmb01.xyz under existing owner-only Access. Verify connected yet processing paused, no model/canonical/outbound writes.

Owner command (final helper must be regenerated/pinned to final file/hash before scheduling): `/Users/yapweijun/Documents/Codex/2026-09-30/task-4/private-runtime/whatsapp-erp/decrypt-tools/bin/python /Users/yapweijun/Documents/Codex/2026-09-30/task-4/migration-evidence/owner-decrypt-erp.py`. Do not reuse the initial snapshot as final. Owner opens WhatsApp → Linked devices → Link a device and scans the protected page. Team handles all QA; owner only decrypts/unlocks and scans.

Planning estimate: 10–20 minutes of VM handler downtime for final snapshot/transfer/decrypt/QR, budget a 30-minute window. This is an estimate, not a guaranteed duration; connection or owner-handoff delays can extend it. Agree on a rollback time before stopping VM. No pause until the plan, owner availability and reviewed production action are ready.

## M3 — exact-scope V2 manual test approval (separate authority/outbound action)

After actual identity resolution, privately present accountId/conversationId/customerId and the intended recipient. No seeded tuple/default customer may substitute. Owner approves exactly seven capabilities on that account+conversation (customer_context, order_history, order_draft_workspace, order_validation, quotation, commitment, sales_order_draft), V2_CANARY/V2 writer via existing migration/rollout authority seams, recipient-specific inbound/outbound allowlist and exact synthetic order/quote/acceptance messages. No global rollout, V3 promotion or post-Draft AI/staff authority. Unknown/prospect contacts must not receive test replies.

Done: team records actual normalized/provider inbound, real inference, deterministic ERP lookup evidence, sent quotation, explicit acceptance, exactly one SALES_ORDER.DRAFT, backend display and persistence after restart; prove zero post/confirm/DO effects and zero sends outside recipient scope. Existing demo service reuse and its handled costs are already owner-approved; no new billing/model/grant changes are implied.

## M4 — handover/recovery

Team verifies restart safety, unknown/pending outbound handling, duplicate inbound/order protection, protected public UI and existing route baselines. Staff credential handoff is needed only if staff actions are separately wanted; it is not a draft-only prerequisite.

Rollback: pause/disconnect Air first; preserve all Air canonical/audit/outbound evidence, disable only the approved exact-scope V2 capabilities through authority-bound controls and reconcile any effects before resuming VM. Never resume dual writers or blindly restore pre-cutover data after sends/orders. No resets, customer-data deletion or V3 changes.

## Current readiness limits

Local tests exercise synthetic persistence, intercepted outbound, existing V2 quote/acceptance/Draft semantics, canonical identity and paused startup. They do not prove physical QR pairing, real provider inbound/outbound or production recovery. The existing public runtime has not received this branch's UI/code changes.

The next production action to review is only publishing the verified preparation changes and scheduling final sync plus paused pairing; it must not enable V2 processing or automated replies. Pairing is connection-only: the paused inbound handler drops messages rather than storing them. The owner is not asked to perform QA.

Before M3 activation, recipient-specific processing/outbound enforcement must be implemented and locally verified against the actual identified scope, including unknown sender rejection; existing V2 workspace authority alone must not be treated as a global unknown-contact reply guard. No such allowlist or authority has been activated by this preparation task. External ERP credentials are not a prerequisite to the canonical SQLite draft workflow; any separately required external ERP connector must be scoped and validated independently.

## Owner continuation decision

Owner subsequently chose Air-only continuation and manual owner QR regeneration. Do not offer or execute VM ERP restart as the default next step. Only the old WhatsApp ERP unit was stopped; VM/VMMCP and retained data/backups remain intact. No deletion is authorized. The controlled final snapshot matched the already owner-decrypted snapshot byte for byte; verified reuse avoided a redundant key handoff. Current phase is paused account pairing, followed by separately scoped processing readiness. See `OWNER_QR_PAIRING.md` for the manual control contract.
