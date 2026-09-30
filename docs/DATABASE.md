# Database V1

Use SQLite for the self-contained demo; keep types/query patterns portable to PostgreSQL.

## Tables
- `channel_accounts(id, provider, external_account_id, status, created_at, updated_at)`
- `conversations(id, channel_account_id, external_conversation_id, customer_id, status, last_message_at)`
- `messages(id, conversation_id, external_message_id, direction, message_type, text, occurred_at, raw_ref)`
- `customers(id, code, name, currency, credit_status, default_warehouse_id)`
- `customer_channel_identities(id, customer_id, channel, external_id, phone)`
- `products(id, stock_code, description, base_uom, active)`
- `product_aliases(id, customer_id, product_id, alias, confidence, source)`
- `uoms(code, description)`
- `product_uom_conversions(id, product_id, from_uom, to_uom, factor)`
- `warehouses(id, code, name)`
- `stock_balances(product_id, warehouse_id, quantity_base)`
- `customer_prices(customer_id, product_id, uom, unit_price, currency, valid_from, valid_to)`
- `quotations(id, quotation_no, customer_id, status, currency, quotation_date, valid_until, delivery_date, warehouse_id, remark, subtotal, tax, grand_total, source_conversation_id, sent_at, accepted_at)`
- `quotation_lines(id, quotation_id, row_item_no, product_id, stock_code, stock_description, row_item_remark, quantity, uom, unit_price, subtotal)`
- `sales_orders(id, sales_order_no, customer_id, status, currency, delivery_date, warehouse_id, remark, subtotal, tax, grand_total, source_quotation_id, source_acceptance_message_id, posted_at, confirmed_at)`
- `sales_order_lines(...)` mirrors quotation lines with source line id.
- `customer_order_memory(id, customer_id, memory_type, key_text, value_json, confidence, evidence_ref, updated_at)`
- `agent_runs(id, conversation_id, status, started_at, completed_at)`
- `agent_tool_calls(id, agent_run_id, tool_name, input_json, output_json, status, occurred_at)`
- `audit_events(id, entity_type, entity_id, event_type, actor_type, actor_id, evidence_ref, occurred_at, payload_json)`

## Invariants
- accepted quotation requires explicit inbound message evidence.
- draft SO requires accepted quotation.
- AI actor cannot transition SO beyond `DRAFT`.
- all document line totals are deterministic decimal calculations, never LLM-calculated strings.

## Required V1 constraints and evidence fields
- `messages` also persists `sender_external_id`, `sender_phone`, `reply_to_external_message_id`, `account_id`; unique `(channel_account_id, external_message_id)`.
- `customer_channel_identities` unique `(channel_account_id, external_id)` so identities cannot cross accounts.
- `outbound_messages(id, conversation_id, external_message_id, client_message_id, entity_type, entity_id, snapshot_hash, status, attempt_count, last_error, submitted_at, created_at)`.
- `quotations` also stores immutable `sent_snapshot_json`, `sent_snapshot_hash`, `source_message_id`, `sent_outbound_message_id`, `superseded_by_quotation_id`; only one active SENT quote per conversation.
- `quotation_acceptances(id, quotation_id UNIQUE, message_id UNIQUE, sender_external_id, accepted_at, evidence_json)`.
- `sales_orders.source_quotation_id` is UNIQUE.
- `staff_actions(id, sales_order_id, action_type, staff_session_subject, customer_double_confirmed_at, evidence_ref, occurred_at)`.
- immutable commerce evidence is append-only; historical quote/SO snapshots are never rewritten by later product/price changes.

## Monetary rules
- money stored as integer minor units (`*_cents`) for SGD demo; display uses 2 decimals.
- quantity stored as decimal text/NUMERIC-compatible value with maximum 3 fractional places; V1 seeded CTN quantities are whole numbers.
- line subtotal = exact Decimal(quantity) × Decimal(unit price in major currency units), rounded HALF_UP once to 2 currency decimals; document subtotal = sum rounded line minor units; tax default is 0% in V1 seed; grand total = subtotal + tax.
- negative/zero quantity and unknown UOM conversion are rejected.

## ERP evidence model
- `erp_evidence(id, evidence_type, tool_call_id, lookup_key, input_json, output_json, observed_at, source_version)` is immutable/append-only.
- `quotation_line_evidence(quotation_line_id, evidence_id, role)` binds each exact quotation revision line to evidence roles: `customer`, `product`, `uom`, `price`, `stock`, `order_history` as applicable.
- minimum `input_json`: canonical customer/product/warehouse/UOM/date/quantity keys used by the lookup; minimum `output_json`: exact returned canonical ids/values used in the quote; `observed_at` is mandatory.
- a revised quotation creates new line rows/evidence links; it never repoints historical sent snapshots to later lookups.
- Draft SO lines copy source quotation line ids and accepted snapshot values; they do not rerun price lookup.

## Atomic staff post
`staff_post_idempotency_key` is UNIQUE. Posting starts one transaction, locks affected stock rows in sorted `(product_id, warehouse_id)` order, rechecks available base quantity, hard-blocks on shortage, deducts each balance exactly once, changes SO to POSTED, records `staff_actions`, and appends audit events. Rollback is all-or-nothing.

## Durable outbound intent / recovery
Before adapter submission, insert `outbound_messages` with stable `client_message_id`, frozen `snapshot_hash`, and the exact provider-neutral wire payload (caption plus attachment `fileName`/`ref`/`sha256`) in `payload_json`, status `PENDING`, attempt number, and created timestamp, then commit. New quotation sends verify the snapshot hash before PDF generation. Retries replay `payload_json` exactly; legacy pre-PDF payloads remain text-only. After provider result, update to `SUBMITTED`, `FAILED`, or `UNKNOWN`.
On restart, any unfinished `PENDING` attempt is converted to `UNKNOWN` and must run adapter `reconcile(clientMessageId, accountId)` when supported. Reconciliation returns `submitted(externalMessageId)`, `not_found`, or `unknown`.
- `submitted`: persist external id and permit quotation `SENT`.
- `not_found`: one retry is allowed using the same stable client id/idempotency semantics where provider supports it.
- `unknown`: no automatic resend; quotation stays non-SENT/non-acceptance-eligible and UI surfaces operator reconciliation.
For QR demo adapters that cannot prove provider state, unresolved attempts remain `UNKNOWN`; automated Golden tests use the simulated adapter with deterministic reconciliation.


## Submitted-send atomic commerce finalization
A provider `submitted` result is never persisted by itself. In one transaction the system updates `outbound_messages` to `SUBMITTED`, writes the provider external message id, transitions the target quote to `SENT`, supersedes any prior active quote, and appends audit events. Rollback leaves the durable outbound intent `PENDING`, so restart reconciliation can prove submission and replay finalization without resending. Acceptance processing is blocked while the conversation has an unresolved quotation outbound `PENDING/UNKNOWN` that could change which quote is active.
