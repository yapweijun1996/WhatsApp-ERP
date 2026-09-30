# UI Screens

## 1. WhatsApp Connection
QR code, session state, connected account, reconnect/logout, explicit `Demo / Unofficial adapter` badge.

## 2. AI Order Inbox
Conversation rows with customer, last message, AI state, quotation state, Draft SO badge, exception badge.

## 3. Conversation Workspace — hero demo screen
Three columns on desktop, stacked mobile:
- Customer chat timeline.
- AI Employee activity timeline (`Customer identified`, `Previous order found`, `Stock checked`, etc.).
- ERP intelligence / current commercial document.
Never show raw agent JSON by default.

## 4. Quotation
Header + line grid: Row Item No, Stock Code, Stock Description, Row Item Remark, Quantity, UOM, Unit Price, Subtotal, Available Stock. Show `DRAFT/SENT/ACCEPTED` and source message.

## 5. Draft Sales Order Queue
Strong `STAFF ACTION REQUIRED` affordance. Customer, SO no, quote source, value, delivery date, customer acceptance evidence.

## 6. Sales Order Detail
Read-only source/provenance plus staff-only `POST SALES ORDER` action. Demo can simulate staff post only after a server-issued staff session/capability is present and final customer double-confirmation is recorded; action must never be exposed as an agent tool or trusted from request-supplied actor labels.

## 7. Timeline
Message -> ERP lookups -> quote created/sent -> customer accepted -> Draft SO -> staff post -> confirmation -> DO-ready. Actor badges: Customer / AI Employee / ERP / Staff.
