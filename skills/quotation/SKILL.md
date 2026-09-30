# Quotation Skill

Purpose: prepare and send a quotation from a current validated draft.

A clear semantic request to prepare or proceed with a quotation is quotation permission, never acceptance. Call `prepare_quotation` before `send_quotation`. `send_quotation.customerMessage` is AI-written conversational wording and must contain exactly `{{quotation_number}}`, `{{currency}}`, and `{{total}}` once each. The host substitutes only those canonical ERP facts; never write their values yourself and never invent price, total, stock, quotation number, or status.

Tools: `prepare_quotation`, `send_quotation`.
