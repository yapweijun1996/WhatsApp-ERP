# V3-RET-003 Review

Status: **ACCEPTED COMPLETE — AUTHORIZED PHASE 4 SHADOW-ONLY SCOPE**

Date: 2026-09-16 (Asia/Singapore)

Review round 1 found **P0=1, P1=0**: the exported module-global authority issuer allowed caller-supplied principal/turn identifiers. A later fresh independent review found a second authority-boundary **P0=1, P1=0**: `authority()` trusted a caller-controlled lookalike `verify()` method and could accept forged `AuthorityData` when the DB identity matched. The final remediation removes caller-dispatched verification and uses a module-private `WeakMap` registry keyed by the exact process-local authority object, with exact per-authority opaque-token identity. Final independent Codex GPT-5.6 Sol review **PASS (P0=0, P1=0)**, independent Codex GPT-5.6 Luna review **PASS (P0=0, P1=0)**, and an additional reviewed Claude Code 2.1.172 / Claude Sonnet 5 frozen-evidence review **PASS (P0=0, P1=0)**. V3-RET-003 is accepted complete for its authorized Phase 4 shadow-only scope. V3 remains **PROPOSED**. No runtime/customer traffic, activation, canary, deployment, release, promotion, Phase 5 work, RET-004+ work, schema migration, outbound ownership, or Sales Order authority change was made.

## Contract

`V3RetrievalIndexService` is bound to a process-local authority instance created by trusted Host/bootstrap code with a closed authenticated principal binding (`subject`, `tenantId`, `channelAccountId`) and the DB. A module-private registry owns the exact authority-instance and per-authority token WeakMaps; `issue(turnId)` accepts only a turn ID and validates the immutable/coordinator-created `agent_turns` row, exact inbound message, canonical conversation/channel lineage, and current customer row before issuing an opaque instance-local token. Build/reopen require that same instance and token; foreign-instance, plain, cloned, or structured-cloned tokens fail generically. The current schema has no tenant table, so tenant identity is fixed by the authenticated Host principal binding and is not inferred from `channelAccountId`; future runtime integration must obtain this instance from authenticated server bootstrap, while RET-003 does not wire runtime/customer traffic.

The untrusted retrieval request contains memory plus optional requestedScope only; account/conversation/tenant/customer authority selectors are not part of its contract. requestedScope and memory scope are exact-match assertions and cannot authorize, widen, or repair scope. Scope version and non-authoritative audit metadata are deterministic and included in the RET-002 index fingerprint. Build and reopen validate scope before candidate return. Chronology, semantic, entity/object, section, reply/thread, and existing attachment-reference candidates are generated only from the validated scoped source set; reopen re-derives and rechecks the current canonical scope. Missing/foreign/malformed scope references fail with generic `V3_RETRIEVAL_SCOPE_UNAVAILABLE`.

## Evidence

- `src/v3-retrieval-index.ts`: schema-free Host scope derivation, exact-match requested-scope validation, deterministic scope/version audit metadata, and pre-return enforcement.
- `tests/v3-retrieval-index.test.ts`: cross-account/channel/conversation/customer negatives, tampered scope, wrong-customer entity exclusion, foreign reply-reference handling, and all RET-002 modes.
- Final authority-boundary tests: Host A cannot issue a real B turn; a B token is rejected by Host A; cloned/plain/structured-cloned tokens and cloned/lookalike/accessor authorities are rejected; a forged `verify()` method cannot synthesize authority; principal binding is fixed and issuance accepts only `turnId`.
- Final executable evidence: focused retrieval-index suite **21/21 PASS**; full regression **694/694 PASS**; typecheck **PASS**; build **PASS**; scoped `git diff --check` **PASS**.
- Final independent reviews: GPT-5.6 Sol VMMCP Codex read-only review **PASS** under the P0=0/P1=0-only contract; GPT-5.6 Luna read-only review returned `VERDICT=PASS; P0=0; P1=0; ACCEPT_RET003=YES`; reviewed Claude Code **2.1.172** explicitly ran **Claude Sonnet 5** (`modelUsage` included `claude-sonnet-5`) against a frozen 35,752-byte RET-003 evidence bundle and returned **PASS, P0=0, P1=0**. The Claude review correctly notes that the shadow-only/PROPOSED runtime-wiring claim was uncontradicted by the supplied evidence but not independently proven by that bounded bundle.

RET-003 is **ACCEPTED COMPLETE** for the authorized shadow-only scope. RET-004 through RET-008 remain unchecked and unstarted.
