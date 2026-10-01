# Design SSOT — V1

## Product boundary
The product is **ERP Order Intelligence**, not a WhatsApp chatbot. WhatsApp is one replaceable input channel.

## Canonical lifecycle
`CUSTOMER_MESSAGE -> ORDER_INTELLIGENCE -> QUOTATION.DRAFT -> QUOTATION.SENT`. From `SENT`, only `ACCEPTED` can create `SALES_ORDER.DRAFT`; `REJECTED`, `EXPIRED`, and `SUPERSEDED` are terminal for that quotation. Human staff alone may then advance `SALES_ORDER.DRAFT -> POSTED -> CONFIRMED -> DO_READY`. See `docs/STATE_MACHINE.md`.

AI autonomy ends at `SALES_ORDER.DRAFT`.

Human chat access is separate from commercial authority. A `CHAT_ONLY` session may reply, take over and resume only explicitly approved account/conversation scopes; it cannot POST, confirm, progress DO or reset data. Existing broad staff remains compatible. See `docs/STAFF_CHAT_ACCESS.md` for the authorization and private owner handoff contract.

## Commercial interaction
1. Customer sends natural language order/request.
2. AI resolves customer, products, UOM, recent-order references, stock and customer pricing using ERP tools.
3. If ambiguous, AI asks a bounded clarification question.
4. If stock/price are valid, AI can prepare and send a quotation.
5. Only explicit customer acceptance such as "OK confirm" may accept a quotation.
6. Accepted quotation creates `SALES_ORDER.DRAFT` with immutable source quotation/acceptance references.
7. Staff reviews and double-confirms with customer, then posts Sales Order.
8. Sales Order Confirmation and DO progression remain human/business-operation responsibilities in V1.

## Core document line fields
`rowItemNo`, `stockCode`, `stockDescription`, `rowItemRemark`, `quantity`, `uom`, `unitPrice`, `subtotal`, plus stock/warehouse context for review.

## Safety
No LLM-generated price, stock, UOM conversion, customer identity, or ERP document number is accepted without deterministic tool evidence.
