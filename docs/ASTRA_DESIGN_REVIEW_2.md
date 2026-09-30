**VERDICT: PASS_WITH_REQUIRED_FIXES**

Three prior P1 findings remain unresolved in part. Implementation still requires missing safety/business semantics.

1. **P1 — Stock shortage policy and posting atomicity remain undefined (prior #7).**  
   [STATE_MACHINE.md:22](/srv/agent-workstation/workspaces/whatsapp-erp-order-intelligence/docs/STATE_MACHINE.md:22) references a “warning/block policy” without choosing one. [Lines 49–50](/srv/agent-workstation/workspaces/whatsapp-erp-order-intelligence/docs/STATE_MACHINE.md:49) require stock deduction at posting, but quotation/SO row serialization does not establish atomic protection of balances shared by different orders. After one order consumes 5 of 6 CTN, may another 5-CTN order post?  
   **Required:** Specify shortage blocking or an explicit staff override policy. Require stock recheck, permitted deduction, `POSTED` transition, and audit to commit atomically, including retries and competing orders.

2. **P1 — Quotation-to-ERP evidence remains incomplete (prior #6).**  
   [DATABASE.md:37](/srv/agent-workstation/workspaces/whatsapp-erp-order-intelligence/docs/DATABASE.md:37) adds immutable snapshots and source-message links, but no defined references bind quotation lines to the exact customer/product/UOM/price/stock lookup evidence used. Generic [tool-call and audit records](/srv/agent-workstation/workspaces/whatsapp-erp-order-intelligence/docs/DATABASE.md:24) cannot reliably distinguish which results supported successive quotation revisions.  
   **Required:** Define immutable quotation/line-to-ERP-evidence references and minimum evidence payloads, including lookup inputs, returned values, and timestamps. Historical evidence must remain attributable after subsequent ERP changes.

3. **P1 — Outbound crash recovery remains unspecified (prior #5).**  
   [CHANNEL_ADAPTER.md:40](/srv/agent-workstation/workspaces/whatsapp-erp-order-intelligence/docs/CHANNEL_ADAPTER.md:40) defines submission outcomes and safely blocks blind retries after `unknown`. However, [outbound persistence](/srv/agent-workstation/workspaces/whatsapp-erp-order-intelligence/docs/DATABASE.md:36) does not require durable intent before submission or define recovery after the provider submits but the process crashes before saving its result. “Requires reconciliation” leaves the resolution contract unspecified.  
   **Required:** Persist a stable send identifier and frozen snapshot before submission; treat unfinished attempts as uncertain after restart; define provider-neutral reconciliation and unresolved-outcome handling. Verify crashes before submission and after submission but before result persistence.

**Prior P1 disposition:** #1 lifecycle, #2 staff authorization/downstream transitions, #3 acceptance binding, and #4 acceptance/Draft SO atomicity are resolved at the architecture-contract level. #5–#7 remain partially resolved above.

No P0 or new contradiction authorizing AI beyond `SALES_ORDER.DRAFT` was identified. Authenticated staff alone explicitly advances `DRAFT → POSTED → CONFIRMED → DO_READY`.

Read all 17 requested Markdown files, including the prior Astra review; independently cross-checked the findings. No files modified.