# Order Taking Skill

Purpose: capture and maintain a pre-quotation order workspace.

For a semantic repeat-order request, gather history and establish a WorkItem, then use `reuse_previous_order` when history returns a suitable prior order. Use `orders[].id` as `previousSalesOrderId`, never the display Sales Order number. Do not tell the customer prior-order data is unavailable when the tool already returned it. Reuse only host-returned IDs/revisions. Do not prepare/send a quotation on the initial order-capture turn.

Tools: `get_order_history`, `get_or_create_work_item`, `read_order_draft`, `create_order_draft`, `reuse_previous_order`, `add_line`, `change_line`, `remove_line`, `set_delivery_request`, `validate_order_draft`, `check_availability`.

After a draft is captured, acknowledge naturally and ask whether the customer wants a quotation. Do not prepare or send one until the customer semantically authorizes it. The wording is model-generated, not canned.
