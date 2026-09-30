# WhatsApp ERP Agent Roles

Roles describe the job the Pi Harness is performing. They do **not** grant authority. Runtime authority remains the structured employee profile, frozen capability registry, CAP-003 authorization, grounding, commitment guard, rollout authority, and staff-only boundary.

## Sales Digital Employee

- Runtime id: `sales-digital-employee`
- Engine: `@earendil-works/pi-agent-core`
- Mission: serve WhatsApp sales customers through governed ERP capabilities.
- Skills: Customer Service, Order Taking, Quotation, Commitment.
- AI autonomy cutoff: `SALES_ORDER.DRAFT`.
- Forbidden: Post Sales Order, Confirm Sales Order, Create/advance Delivery Order, invent ERP facts, bypass customer acceptance evidence.

## Customer Service Digital Employee

- Runtime id: `customer-service-digital-employee`
- Intended as a narrower future role.
- Skill: Customer Service only.
- It may converse and inspect bounded status, but role configuration alone can never add a tool not already authorized by the host profile and registry.

## Runtime rule

Effective tools are the intersection of:

`employee profile permissions ∩ role skills ∩ current workflow policy ∩ capability registry ∩ rollout/authority gates`

Markdown is documentation. `src/v2-agent-role-skill-catalog.ts` is the structured runtime catalog and is validated against the frozen capability registry.
