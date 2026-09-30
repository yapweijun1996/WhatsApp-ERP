# V1 Product Spec

## Must have
- QR connection adapter behind `WhatsAppChannelAdapter` contract.
- Provider-neutral inbound/outbound message contracts.
- Pi Agent Core wired to configurable OpenAI-compatible GPT Gateway.
- Demo ERP with seeded customers/products/UOM/stock/pricing/history.
- Customer/product/UOM/history/price/stock tools.
- Quotation DRAFT -> SENT -> ACCEPTED lifecycle.
- explicit acceptance -> automatic Draft SO.
- staff-only SO post simulation and downstream confirmation/DO-ready demo.
- audit timeline and source provenance.
- responsive web UI/PWA-ready shell.
- deterministic tests and Golden storyline.

## Out of scope V1
- real production ERP writes;
- official Meta production onboarding;
- AI posting Sales Orders;
- payment, accounting, route planning, real DO generation;
- generalized multi-ERP marketplace.

## Acceptance
A clean clone/install can seed data, run the app, execute the Golden storyline, pass tests/build, and prove AI cannot cross the Draft SO boundary.

## Lifecycle completeness
Quotation terminal states are `ACCEPTED`, `REJECTED`, `EXPIRED`, `SUPERSEDED`; only `ACCEPTED` produces Draft SO. Staff-only SO transitions are explicit and server-authorized. See `STATE_MACHINE.md`.
