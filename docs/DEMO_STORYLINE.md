# Demo Storyline

## Scene 1 — Connect
Operator opens Connection screen and scans QR. Status becomes Connected.

## Scene 2 — Customer asks naturally
Customer sends: `Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?`

## Scene 3 — AI Employee works
UI streams human-readable activities:
1. identified Sunrise Mini Mart;
2. fetched SO-000041;
3. mapped `ayam` and `red one` using customer aliases/history;
4. converted CTN UOM;
5. checked SG-MAIN stock;
6. fetched customer-specific pricing.
AI replies that requested stock is currently available, records `2026-09-08` as the **requested delivery date pending staff confirmation**, and asks whether to prepare a quotation.

## Scene 4 — Quotation
Customer: `Yes please.` AI creates `QT-000001` DRAFT, sends it, state becomes SENT. Quotation total is SGD 662.50 before any configured tax.

## Scene 5 — Customer accepts
Customer: `OK confirm.` The active quote becomes ACCEPTED and system automatically creates `SO-000052` with state `DRAFT` and acceptance-message provenance.

## Scene 6 — Human boundary
Draft SO Queue displays `STAFF ACTION REQUIRED`. Staff reviews source quote and acceptance evidence, double-confirms with customer, then uses staff-only Post Sales Order action.

## Scene 7 — Fulfilment handoff
Demo timeline changes SO to POSTED, creates/shows Sales Order Confirmation, then marks `DO_READY`. V1 does not let AI perform these staff actions.

## Demo proof points
- natural customer language;
- tool-driven ERP truth;
- autonomous commercial conversation until Draft SO;
- explicit human commitment boundary;
- full provenance/audit trail;
- channel adapter is replaceable.
