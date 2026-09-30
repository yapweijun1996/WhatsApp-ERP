# V3 CTX-003 Review — Token-Budget Context Assembly

Status: **PASS — P0=0 / P1=0**
Date: 2026-09-13 (Asia/Singapore)

## Scope and contract

`V3-CTX-003` adds the pure, shadow-only `assembleV3ContextBudget` helper in `src/v3-context-budget.ts`. It consumes a validated CTX-002 snapshot, reserves explicit system/authority, tool/reasoning, and future-goals capacity, then greedily allocates mandatory authority/current-bundle/current-canonical-business sections before optional recent transcript and lower-priority summary sections. No Goal Graph data is fabricated and no V2/V3 runtime is wired.

The estimator is explicitly reported as `CHAR_HEURISTIC_V1`; measured character count and estimated token fields are exposed, so the heuristic is not represented as an exact tokenizer. Optional summary text is compacted first and recent transcript entries are deterministically dropped from oldest to newest under pressure. Mandatory content exceeding the available context budget fails closed.

The output is detached through CTX-002 validation, redaction-checked, deterministic, deeply frozen, descriptor/accessor-safe, and bounded by the configured context budget. It remains `NON_AUTHORITATIVE_DERIVED`. The future-goals reserve is capacity only; it grants no authority and does not create goals.

## Tests and invariants

Focused CTX-002 and CTX-003 tests cover deterministic replay, mandatory-authority preservation, optional summary/transcript compaction and dropping, reserve enforcement, mandatory overflow, redaction, caller immutability, accessor rejection, deep freeze, and no fabricated goals.

Authority invariants remain unchanged: AI authority stops at `SALES_ORDER.DRAFT`; no Sales Order post/confirm or Delivery Order authority was added; outbound ownership remains solely `OutboundMessageService`; V3 remains proposed and customer-visible behavior remains off.

## Verification

Completion evidence: focused CTX-002/CTX-003 files **2/2 PASS**; full npm suite **50/50 test files PASS**; typecheck **PASS**; build **PASS**; diff check **PASS**. Direct `adapter.send(...)` calls remain limited to `src/outbound-message-service.ts`; lifecycle guard scans retain the POST/CONFIRM SO and Delivery Order blocks. The pre-existing dirty invariant files (`schema.sql`, app/server, V2 context, and outbound service) were not edited by CTX-003; their current hashes were recorded during verification. Only this module, its focused test, this review, and the CTX-003 checklist checkbox are in scope.
