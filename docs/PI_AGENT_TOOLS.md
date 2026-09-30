# Pi Agent Tools

Pi Agent Core uses `@earendil-works/pi-agent-core` and talks to the user's OpenAI-compatible GPT Gateway through environment-based configuration. Model cost is not a V1 planning constraint; correctness and deterministic ERP evidence are.

## Model-facing V1 tool surface
In deterministic/offline mode the model-facing contract is one bounded tool:

- `interpret_order({ intent, reason, lines?, requestedDeliveryDate? })`

In Browser Demo GPT mode, the Gateway policy forbids tools, so Pi sends **no model-facing tools**. The model returns plain text JSON, which is locally schema-validated into the same `OrderIntentResult` contract before `CommerceService` runs deterministic ERP lookups.

For an order, Pi may interpret customer wording into requested product text, quantity, UOM expression, optional row remark, and requested delivery date. These are **requests**, not ERP truth.

Pi does **not** decide canonical customer id, SKU, UOM conversion, price, stock, quotation number, Sales Order number, or any post-Draft action. After Pi returns an intent, `CommerceService` calls deterministic ERP capabilities and fails closed on ambiguity or missing evidence.

## Deterministic ERP/service capabilities
The application, not the model, performs the equivalent of:

- resolve customer identity within the channel account;
- search/resolve products and customer aliases;
- resolve/convert UOM;
- read recent order history;
- fetch customer price;
- check stock;
- create/send quotation with immutable evidence;
- record explicit acceptance and create Draft Sales Order.

This narrower model-facing surface preserves the frozen rule: **Pi interprets intent; ERP deterministic tools provide truth.**

## Explicit acceptance guard
A model classification alone cannot accept a quotation. The service independently requires explicit customer text such as `OK confirm`, correct account/conversation/customer identity, valid ordering/correlation, a current `SENT` quotation, no unresolved competing outbound, and non-forwarded evidence.

## Forbidden AI tools
No `post_sales_order`, `confirm_sales_order`, `create_delivery_order`, or `DO_READY` tool exists in the Pi toolset. AI autonomy ends at `SALES_ORDER.DRAFT`.

## Deterministic tests vs live Gateway
Golden tests run the real Pi Agent loop with a deterministic faux provider so CI does not depend on external credentials. Live WhatsApp demo mode uses the Browser Demo session flow (`DEMO_GPT_*`), sends no model-facing tools, parses plain assistant text as a strict `OrderIntentResult`, and keeps ERP lookups local and deterministic. Private `GPT_GATEWAY_*` configuration remains a valid trusted-server deployment path; the current WhatsApp live demo intentionally uses the short-lived `/demo/*` session path.
