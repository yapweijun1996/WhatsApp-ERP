# WhatsApp ERP Order Intelligence

AI Employee V1 that turns natural WhatsApp customer orders into ERP-backed quotations and, after explicit customer acceptance, a **Draft Sales Order**. AI autonomy ends there. Human staff owns Sales Order posting, Sales Order Confirmation, and the `DO_READY` handoff.

## North Star
**Customers order naturally. ERP receives clean, validated commercial documents.**

## Frozen V1 lifecycle
`MESSAGE -> intelligence -> QUOTATION.DRAFT -> QUOTATION.SENT -> QUOTATION.ACCEPTED -> SALES_ORDER.DRAFT -> HUMAN POST -> SALES_ORDER.POSTED -> HUMAN/OPS CONFIRMATION -> DO_READY`

`DESIGN.md` and `docs/GO_CONTRACT.md` are the implementation SSOT.

## Architecture

- WhatsApp is a replaceable `WhatsAppChannelAdapter`.
- Pi Agent Core interprets customer intent/requested lines.
- Deterministic ERP code resolves customer, SKU, UOM, order history, price, and stock.
- Quotations persist immutable ERP evidence.
- Explicit customer acceptance creates exactly one Draft Sales Order.
- Server-issued staff session + explicit SO target + double-confirm evidence are required after Draft.
- The Baileys QR adapter is **demo-only/unofficial**; future Meta Cloud API remains swappable without commerce/Pi/ERP lifecycle changes.

## Install and verify

```bash
npm ci
npm run typecheck
npm test
npm run build
npx playwright test
npm audit --audit-level=high
```

There is no configured lint script in V1.

## Run simulated demo

```bash
npm run dev
```

Open the local server and use the Golden message:

`Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?`

Then: `Yes please.` -> `OK confirm.` -> staff session -> double-confirm -> Post -> Confirm -> `DO_READY`.

## GPT Gateway
For live WhatsApp runtime, enable the Browser Demo flow in `.env.example`. It creates a short-lived session with the configured `project_id` and `Origin`, then calls `/demo/v1/responses` with `demo-fast`. Demo mode sends no tools and validates the assistant's JSON locally. No token/key belongs in Git. Private `/v1/*` remains available for trusted server-side deployments with `gw_…` credentials; this WhatsApp live-demo path intentionally uses `/demo/*`. Golden tests do not require external credentials.

## Real WhatsApp QR demo

Set, at minimum:

```bash
ORDER_CHANNEL=whatsapp-qr
WHATSAPP_AUTH_DIR=.data/whatsapp-auth
WHATSAPP_CHANNEL_ACCOUNT_ID=demo-account
WHATSAPP_QR_CUSTOMER_PHONE=+65XXXXXXXX
WHATSAPP_QR_CUSTOMER_ID=CUST-001
```

Start the app and scan the displayed QR from WhatsApp -> Linked devices -> Link a device. Auth/session material stays under ignored `.data/`. The adapter handles Baileys `connection.update`, `creds.update`, `messages.upsert`, linked-device LID/alternate JID normalization, and provider-neutral outbound messages.

See `docs/V1_VERIFICATION.md` for evidence and remaining external/manual smoke boundaries.
