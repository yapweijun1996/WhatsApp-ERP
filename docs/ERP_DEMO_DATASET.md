# ERP Demo Dataset

## Company
Northstar Food Distribution Pte Ltd · SGD · Warehouse `SG-MAIN`.

## Customer
`CUST-001` Sunrise Mini Mart Pte Ltd · phone `+6591110001` · SGD · credit status OK · default warehouse `SG-MAIN`.

## Products
1. `FCH-WHOLE-12` — Frozen Whole Chicken 1.2kg x 10 · base UOM PCS · 1 CTN = 10 PCS · stock 820 PCS (82 CTN) · customer price SGD 48.00/CTN.
2. `FRANK-RED-1KG` — Red Label Chicken Frank 1kg x 10 · base UOM PACK · 1 CTN = 10 PACK · stock 60 PACK (6 CTN) · customer price SGD 36.50/CTN.
3. `FCH-WING-2KG` — Frozen Chicken Wing 2kg x 6 · 1 CTN = 6 PACK · stock 24 CTN · SGD 42.00/CTN.

## Customer-specific aliases
- `ayam` -> `FCH-WHOLE-12`
- `red one` -> `FRANK-RED-1KG`
- `wings` -> `FCH-WING-2KG`

## Previous order
`SO-000041`, posted, customer `CUST-001`: 10 CTN `FCH-WHOLE-12`, 5 CTN `FRANK-RED-1KG`.

## Golden demo message
`Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?`
Expected: customer resolves; previous order explains reference; both products/UOMs resolve; requested stock is available (second item leaves 1 CTN); customer prices are exact; agent offers quotation.

## Deterministic Golden clock / numbering
- fixed Golden clock: `2026-09-07T21:10:00+08:00` Asia/Singapore;
- `tomorrow` resolves to requested delivery date `2026-09-08`, explicitly pending staff confirmation;
- previous `SO-000041` date: `2026-09-01`;
- reset seeds next quotation number `QT-000001` and next Sales Order number `SO-000052`;
- tax rate: 0% for V1 demo;
- reset restores original stock, documents, aliases and number sequences.

## Deterministic automated gateway
Golden tests do not depend on a live model. A scripted model transport emits the documented tool intents/results so tests exercise the real Pi/order services, persistence and commerce state machine deterministically. A live GPT Gateway smoke is separate evidence and may vary in wording, but must satisfy the same tool/state contract.
