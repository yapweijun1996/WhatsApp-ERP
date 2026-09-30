# V3-FUL-003 Review

Status: **IMPLEMENTED — focused evidence complete; V3 remains proposed/shadow-only**

## Scope

`OutboundMessageService.sendDeliveryUnits` reuses the existing `outbound_messages` ledger as the sole durable effect owner. Each validated delivery unit gets one stable `DELIVERY_UNIT` row and client identity `delivery-{turnId}-{deliveryUnitId}`. Existing `PENDING`, `SUBMITTED`, `FAILED`, and `UNKNOWN` handling is reused, including exact payload replay fencing and provider reconciliation. Units are attempted sequentially in plan order; a non-submitted unit stops later units.

Dispatch authority is Host-owned: the closed delivery `unitType` determines the provider-neutral text shape. Free-form `purpose` is not used to select a transport operation or capability. Attachment units are recorded and fail closed before provider send until a later Host-owned attachment resolver supplies a generic attachment payload. The FUL-001 validator now requires every unit `attachmentRef` to appear in root `attachments`.

## Evidence

- `tests/v3-ful-003.test.ts`: focused stable identity/uniqueness, replay/idempotency, deterministic order, purpose non-authority, attachment referential consistency, and replay-conflict/fail-closed tests.
- `npm run typecheck`: PASS.
- Scoped `git diff --check`: PASS.
- No schema change and no second provider/transport owner.

## Backlog

- P1: FUL-004 must add atomic side-effect admission/freshness fencing before each uncommitted unit and preserve committed units during partial replans.
- P1: FUL-005 must connect attachment resolution and provider `PENDING/UNKNOWN` reconciliation to capability-owned quotation exclusivity without blind resend.
- P2: add a Host-owned attachment resolver with immutable scope/hash/MIME/file-name evidence before enabling PDF/DOCUMENT submission.

## Safety and non-scope

No runtime/customer enablement, deployment, schema migration, provider-specific payload, second outbound owner, or authority beyond `SALES_ORDER.DRAFT` was added.
