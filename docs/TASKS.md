# V1 Task Breakdown

Status: **IMPLEMENTED / VERIFIED — independent reviewer PASS (2026-09-08)**

1. [x] Scaffold TypeScript app and test stack.
2. [x] Implement provider-neutral channel contracts.
3. [x] Implement unofficial/demo-only Baileys QR adapter plus simulated CI/E2E adapter.
4. [x] Implement SQLite schema, deterministic seed/reset, sequences, audit and provenance.
5. [x] Implement ERP contract and deterministic demo adapter.
6. [x] Integrate current `@earendil-works/pi-agent-core` with environment-based GPT Gateway transport and deterministic test provider.
7. [x] Implement deterministic ERP resolution capabilities with tool-call/evidence provenance.
8. [x] Implement quotation draft/send lifecycle, durable outbound intent, reconciliation and supersession.
9. [x] Implement explicit acceptance recognizer bound to active quote, account/customer/conversation/order/media/forwarding guards.
10. [x] Implement accepted quote -> exactly one Draft Sales Order and enforce AI cutoff.
11. [x] Implement opaque server-issued staff capability plus explicitly targeted POST/CONFIRM/DO_READY state machine.
12. [x] Implement connection, inbox, conversation, quotation, Draft SO and timeline UI.
13. [x] Add Golden, dynamic-order, ambiguity, stock, acceptance, outbound-recovery and security negative cases.
14. [x] Pass clean install, audit, typecheck, unit/integration/security, Chromium E2E and build gates.
15. [x] Independent reviewer re-check after P1 remediation: `VERDICT: PASS`, zero P0/P1.

## External/manual smoke still available

- Physical WhatsApp QR scan + real inbound/outbound message journey.
- Authenticated live GPT Gateway model call once an authorized runtime credential/session is supplied.

These do not change the V1 implementation status; see `docs/V1_VERIFICATION.md`.
