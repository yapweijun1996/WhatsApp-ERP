# AGENTS.md

This repository is documentation-first. `DESIGN.md` and `docs/GO_CONTRACT.md` are the V1 SSOT.

## Non-negotiable business boundary
- AI may interpret customer messages, query ERP truth, create/send quotations, record explicit customer acceptance, and create `SALES_ORDER.DRAFT`.
- AI must never post a Sales Order, confirm a Sales Order, or create a Delivery Order.
- Staff owns `POST SALES ORDER` and subsequent Sales Order Confirmation / DO progression.
- No provider-specific WhatsApp payload may enter order-core. All channels normalize to `IncomingChannelMessage`.
- QR adapter is demo-only/unofficial. Meta Cloud API adapter is the production migration path.

## Engineering rules
- Keep channel, agent, commerce, ERP, persistence, and UI boundaries explicit.
- LLM interprets intent; deterministic ERP tools provide customer/product/price/stock truth.
- Unknown/ambiguous customer, SKU, UOM, price, stock, or customer intent must be resolved by tool lookup or bounded customer clarification, never guessed.
- Preserve provenance from message -> quotation -> acceptance -> draft sales order -> staff actions.
- Add executable tests for business-state transitions and approval boundaries.
- Do not change lifecycle semantics without first updating docs and receiving owner review.
