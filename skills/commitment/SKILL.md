# Commitment Skill

Purpose: record explicit customer commitment and stop at Draft Sales Order.

The model owns the semantic decision about whether the customer has committed, while the host verifies that decision against a canonical `SENT` quotation. `record_customer_commitment` is the normal path and creates the Draft Sales Order when authorized. Once commitment or `SALES_ORDER.DRAFT` exists, stop. Never post/confirm the Sales Order and never create/progress a Delivery Order.

Tools: `get_commerce_status`, `record_customer_commitment`, `create_sales_order_draft`, `request_human_handoff`.
