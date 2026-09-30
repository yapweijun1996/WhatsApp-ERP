# V3-CP-003 Review — Fenced Reasoning Lease

Status: **COMPLETE — shadow-only, non-authoritative**
Date: 2026-09-14 (Asia/Singapore)

`src/v3-reasoning-lease.ts` adds a read-only CP-003 projection over the existing V2 durable queue lease. It validates a CP-001 `InboundBundle` and V3 context snapshot, binds them by scope/revisions/version, and derives owner, fencing token, generation, heartbeat, expiry, item and logical state from Host-owned `v2_conversation_inbox` / `v2_inbox_items` state. The projection is detached, deeply immutable, content-free, and never claims, heartbeats, completes, supersedes, releases, or authorizes side effects.

V2 remains the sole lease authority. V2 expiry/reacquisition advances generation and fences old token/generation; V2 supersede projects `SUPERSEDED`; V2 completion, which clears the durable lease, projects `RELEASED`. An unprovable state fails closed. Durable restart/resume and stale old-token fencing are proven using isolated V2 database fixtures. CP-004 atomic side-effect admission is not implemented or implied.

Evidence:

- `tests/v3-reasoning-lease.test.ts`: expiry, heartbeat/current ownership, reacquisition/generation increase, stale token/generation fencing, supersede/release projection, restart/resume, wrong scope/context rejection, immutable output and content-free output.
- `tests/v2-queue.test.ts` plus CP-003 tests: PASS.
- `npm test`: 55 test files PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.
- `schema.sql` SHA-256 remains `5a811cca49edf060c7b41521f8d8496121c06485bc6472535f39b962405f80eb`.
- Direct `adapter.send` remains confined to `src/outbound-message-service.ts`; AI cutoff remains `SALES_ORDER.DRAFT`; forbidden post/confirm Sales Order and Delivery Order markers remain present.
- `docs/CONVERSATION_INTELLIGENCE_V3.md` remains `PROPOSED` and unchanged.

No schema, runtime/customer-traffic, provider, order-core, outbound-owner, or V1/V2 lifecycle semantic change was made. CP-004..007 remain closed and unauthorized by this bookkeeping update.

## Initial P1 findings and bounded remediation

Independent review identified completeness gaps in the initial projection: same-scope stale contexts could bind; a lease on an earlier item could be treated as the whole multi-message bundle; terminal selection was not latest-message based; impossible V2 lease-field combinations were not rejected; `acquiredAt` was inferred from mutable item state; lease identity omitted generation; and expected projections were read through caller-controlled properties.

Remediation evidence in `src/v3-reasoning-lease.ts` and `tests/v3-reasoning-lease.test.ts` now covers latest-message context binding, latest-item/PROCESSING and persisted-arrival lease binding, latest terminal derivation, lease-field coherence, null `acquiredAt` as the deliberate no-immutable-source fail-safe, generation-specific lease IDs, and accessor/prototype/shape rejection before expected-value reads. The implementation remains read-only and V2 remains the sole lease authority.
