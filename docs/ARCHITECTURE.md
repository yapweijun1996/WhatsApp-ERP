# Architecture

```text
Channel Adapter
  -> IncomingChannelMessage
  -> Conversation / Message Store
  -> Pi Order Agent
      -> ERP read tools
      -> Order Memory
      -> Commerce tools
  -> Quotation Service
  -> Customer acceptance detector
  -> Draft Sales Order Service
  -> Staff Review UI
  -> Human-only ERP commit boundary
```

## Modules
- `channels/contract`: provider-neutral input/output contract.
- `channels/whatsapp-qr`: V1 demo linked-device adapter.
- `channels/whatsapp-meta`: future official webhook adapter, same contract.
- `agent/pi`: Pi Agent Core orchestration and event stream.
- `agent/tools`: thin typed tools; no direct SQL from model.
- `order-intelligence`: customer/product/UOM/order-history resolution.
- `commerce/quotation`: draft/send/accept lifecycle.
- `commerce/sales-order`: draft generation only for AI path.
- `erp/contract`: business capability interface.
- `erp/demo`: deterministic seeded ERP implementation.
- `database`: persistence/audit/provenance.
- `ui`: QR connection, inbox, conversation workspace, quotation, draft SO queue, SO detail, timeline.

## Replaceability rule
Business core imports only contracts. It never imports Baileys/Meta SDK types. Provider migration must require replacing only channel adapter configuration and adapter code.
