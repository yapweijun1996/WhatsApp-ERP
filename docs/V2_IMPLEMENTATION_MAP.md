# V2 Phase 0 Implementation Map

Status: **REVIEWED — Phase 0 only — runtime remains V1**

This map was reviewed against the clean implementation baseline `300f4c906a16e284609b20991adde8e0dd2e89a9` and the approved V2 architecture. It is an ownership map, not a claim that the V2 workspace/schema exists.

| Current responsibility | Current owner | Approved target seam/module | Phase 0 disposition |
|---|---|---|---|
| Normalize provider messages and send/reconcile channel messages | `src/channels.ts` adapters | Provider-neutral `IncomingChannelMessage` / `OutgoingChannelMessage` at channel edge; `OutboundMessageService` | Preserved; provider payloads remain adapter-only. |
| Receive/dedupe/order inbound messages and conversation identity | `CommerceService.inbound` + `messages`, `conversations`, identities | `ConversationService` | V1 compatibility adapter delegates inbound and read operations; canonical tables remain authoritative. |
| Pi intent interpretation and forbidden tool list | `PiOrderAgent` / `src/pi-agent.ts` | `DigitalEmployeeRuntime` and capability registry (later phase) | Preserved as V1 interpreter; no V2 traffic is routed. |
| Pending order JSON workspace | `CommerceService` + `customer_order_memory.pending_order` | `OrderDraftService` / `WorkItemService` (Phase 1) | Deliberately retained as V1 compatibility state. No OrderDraft schema/workspace work in Phase 0. |
| Customer/product/UOM/conversion/price/stock/history truth and ERP evidence | `DemoErpAdapter` + `CommerceService.loggedErpCall` | `OrderValidationService` and ERP contract | Preserved; deterministic calls and evidence writes are unchanged. |
| Quote preparation, immutable snapshot/line evidence, numbers, status | `CommerceService.createQuote` + database | `QuotationService` | Existing V1 behavior remains canonical; seam contract is present, with prepare reserved to V1 inbound orchestration. |
| Quote outbound PENDING/SUBMITTED/UNKNOWN, reconciliation and atomic finalization | `CommerceService.sendQuote`, `finalize`, `reconcileOutbound` | `QuotationService` through sole `OutboundMessageService` | Existing durable behavior retained; no blind resend semantics changed. |
| Acceptance evidence guard and accepted-quote → Draft SO transaction | `CommerceService.accept` | `Acceptance/CommitmentService` + `SalesOrderDraftService` | Existing guarded V1 transaction remains authoritative; Phase 0 adapter does not duplicate or fake it. |
| Staff post/confirm/DO progression and opaque capability verification | `CommerceService.staff`, `staff-auth.ts`, staff routes | `StaffCommitService` (separate from AI) | Route now delegates through the compatibility seam; server-issued capability and lifecycle are unchanged. |
| State projection and UI operational view | `CommerceService.state`, `src/app.ts`, `public/index.html` | Read model/UI consuming canonical state and telemetry | Existing state is preserved; health/API expose runtime, model, transport, and cutoff status. |
| Database schema, seed truth, document sequences, audit/evidence | `schema.sql`, `V1Database` | ERP/persistence/evidence boundaries | No schema, seed, lifecycle, document-number, or canonical-state changes. |

## Compatibility ownership and no-drop statement

`CommerceService` remains the V1 compatibility facade and canonical owner of all existing inbound → quote → acceptance → Draft SO and staff behavior. `createV1ServiceSeams` exposes typed service boundaries and delegates channel inbound, quotation send/reconcile, and staff surfaces to that facade. V2-only WorkItem/OrderDraft/Commitment methods remain contract-only and are not instantiated by the Phase 0 compatibility seam; they are not simulated. No existing behavior is dropped, rewritten, or made V2-authoritative in Phase 0.

The only new runtime decision is telemetry/flag evaluation. The effective runtime is always `V1`, V2 traffic is always disabled, and unknown runtime values fail closed.
