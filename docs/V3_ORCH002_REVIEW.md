# V3-ORCH-002 Review

Status: **ACCEPTED COMPLETE — GOAL-FIRST FAST TRACK**

V3 retrieval is now an opt-in bridge inside the existing `V2PiRuntime` loop. Host code supplies the exact server-scoped RET-004/005 tools and RET-006 budget inputs. When enabled, Pi can make repeated read-only retrieval calls, receive bounded derived evidence, reformulate, and then continue to the existing Host-authorized capability path. When omitted or disabled, V2 tool exposure and behavior are unchanged.

The bridge reuses `runV3RetrievalLoop` validation and evidence accounting for every call, with remaining RET-006 budgets carried across the complete Pi turn/session (including steps, calls, evidence/read/candidate/token bytes and counts, no-new streak, elapsed time, and Host-owned depth). Aggregate evidence/read/candidate/token caps are fail-closed before the underlying retrieval tool is invoked when already saturated, including evidence item capacity. It adds a Host-owned per-turn depth/call/no-new guard and content-free bounded trace entries containing only sequence, tool, depth, result class, and stop reason. Retrieval calls never call `AgentTurnCoordinator.propose`, do not consume the business capability ledger, and cannot authorize ERP truth. Current price/stock/customer/order truth remains verified through existing V2 capability and grounding paths.

Focused evidence: `tests/v3-orch-002.test.ts` covers two retrieval calls with reformulation/depth, no-new/budget stops, aggregate evidence-cap saturation preventing a second underlying tool invocation, ledger separation, disabled-by-default semantics, bounded content-free traces, and the literal `SALES_ORDER.DRAFT` cutoff. `tests/v2-pi-runtime.test.ts` adds the focused fauxProvider runtime sequence retrieval→deeper retrieval→V2 capability→final plan and verifies exactly one business ledger entry with no retrieval entries. Retrieval failures and budget stops return sanitized failure details and leave traces content-free. No schema migration, deployment, customer traffic, canary, outbound-owner change, or Sales Order posting/confirmation/Delivery Order authority was added.

Final evidence:

- ORCH-002 bridge: **5/5 PASS**
- focused V2 runtime integration: **2/2 PASS**
- ORCH-001 compatibility: **3/3 PASS**
- TypeScript typecheck: **PASS**
- scoped `git diff --check`: **PASS**
- frozen SHA-256: `src/v3-orchestrator-retrieval-bridge.ts` `a0ce66abc3e1a4551739b3a4a9467f1048f1903f5f50fefa746777296d4bbe52`; `src/v2-pi-runtime.ts` `1e605a8132863f3c7fdc3e0cc5c766ace9361995206942290d5637739ac89c8c`; `tests/v3-orch-002.test.ts` `331d9b6df191b6ea12a1435f825d49f32788a44068e4115aa599a457439fe3ef`; `tests/v2-pi-runtime.test.ts` `c6fd9ef8fd82ebbac2e43fa49ae71234ba664eb6c2438f574ec5008d5aa80519`
- independent read-only review job `619069ff-2fcd-4653-a52e-4ca21759a707`: **PASS P0=0**, with no P1/P2 findings.

Optional future backlog, non-blocking for ORCH-002: provider-native semantic-parity coverage with a production-shaped RET-005 ladder, and a durable retrieval trace sink only if a later approved task requires cross-process replay.

Decision: ORCH-002 is **ACCEPTED COMPLETE**. Retrieval remains Host-controlled and disabled by default; no deploy, canary, customer runtime activation, schema migration, outbound-owner change, or authority beyond `SALES_ORDER.DRAFT` was added.
