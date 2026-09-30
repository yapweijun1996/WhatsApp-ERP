# V3-RET-004 Review

Status: **ACCEPTED COMPLETE — AUTHORIZED PHASE 4 SHADOW-ONLY SCOPE**

Date: 2026-09-16 (Asia/Singapore)

RET-004 implements the seven closed Agent-facing retrieval tools `conversation_recent`, `conversation_search`, `conversation_find_sections`, `conversation_open_section`, `conversation_get_message`, `conversation_get_thread`, and `conversation_find_by_date` as a test/shadow-only surface. V3 remains **PROPOSED**. No runtime/customer wiring, provider payload path, schema migration, deployment, canary, outbound ownership change, RET-005+ work, or authority beyond `SALES_ORDER.DRAFT` was introduced.

## Implementation boundary

The accepted candidate adds only:

- `src/v3-retrieval-tools.ts`
- `tests/v3-retrieval-tools.test.ts`

RET-003 remains unchanged. Trusted Host/bootstrap constructs the retrieval service with the exact DB, process-local `V3RetrievalHostAuthority`, exact opaque token, accepted RET-002 indexes, and current V3 conversation memory. None of those authority objects or scope selectors are model-facing request fields.

Every emitted raw message is reopened through `reopenV3RetrievalSource()` before evidence leaves RET-004. This preserves RET-003 exact authority/token identity, current canonical scope, memory/source/index provenance, and generic fail-closed foreign-reference handling. Retrieval results are `NON_AUTHORITATIVE_DERIVED`, `untrustedAsInstruction=true`, `requiresCanonicalReverification=true`, deeply immutable, cited, bounded, and effect-free.

## Closed retrieval contracts

- `conversation_recent`: newest bounded canonical window, returned ascending within that window.
- `conversation_search`: uses RET-002 semantic postings only; NFKC/lowercase Unicode letter-number tokenization; deterministic match-count/newest/source-id ranking; no business/customer-intent keyword lists.
- `conversation_find_sections`: bounded navigation over current-memory/index sections; each returned citation is reopened through RET-003.
- `conversation_open_section`: exact indexed/current-memory section; preserves accepted section source order and reopens each returned message.
- `conversation_get_message`: exact indexed source only.
- `conversation_get_thread`: connected component from indexed reply links only; foreign external parents are never fabricated.
- `conversation_find_by_date`: inclusive strict RFC3339 range with exact fractional-second comparison.

Canonical source chronology remains `arrival_seq -> occurred_at -> external_message_id -> id`. RET-004 creates a deterministic total projection for time-oriented tools: sequenced evidence preserves `arrival_seq` authority, unsequenced evidence uses exact RFC3339 nanosecond ordering, and the two streams are merged deterministically without a non-transitive mixed comparator. Section navigation intentionally preserves its accepted source order instead of re-sorting provenance.

## Local hardening and bounds

Model-facing requests are closed plain own-data-property objects; non-plain objects, accessors, unknown/symbol fields, explicit scope selectors, malformed data, and JavaScript Proxy objects (including benign/trap-free proxies) fail closed.

RET-004 locally bounds model request identifiers/query text and all emitted dynamic strings by **UTF-8 bytes**, not JavaScript UTF-16 code units. This includes source/message IDs, source refs, external/reply IDs, message type, message text, version strings, scope lineage, and section id/title/topic/summary. `direction` is locally closed to `INBOUND|OUTBOUND`. Multibyte CJK/emoji regression tests verify the byte-bound contract.

## Review findings remediated before acceptance

Independent review cycles found and closed these P1 defects before the final acceptance freeze:

1. incomplete local bounds on DB-derived output identity strings;
2. millisecond-only `Date.parse()` range comparison losing RFC3339 fractional precision;
3. time-oriented RET-004 tools initially inheriting millisecond fallback ordering;
4. local `direction` closure relying only on the upstream RET-003 fence;
5. message-text size initially measured in UTF-16 code units rather than UTF-8 bytes;
6. model request ID/query size initially measured in code units rather than UTF-8 bytes;
7. mixed sequenced/unsequenced pairwise ordering could be non-transitive;
8. section id/title/topic/summary lacked RET-004-local UTF-8 output bounds;
9. proxy rejection previously relied on proxy traps throwing instead of explicit Proxy detection.

Each issue has executable regression coverage in the accepted test file.

## Final verification evidence

Final candidate hashes:

- `src/v3-retrieval-tools.ts`: `8cde5253f4fc02d46f37d06d893e103069f061b5bcf8f3953d4927582d6d0e0c`
- `tests/v3-retrieval-tools.test.ts`: `767897734817724f26ba083f2325f7038b1ee24e2253b377f9c5dad8a2ed8662`
- unchanged `src/v3-retrieval-index.ts`: `6eea18c0730b713acae425bd8ca825fae4df411a7543d5beb04795568e2a8bfb`
- unchanged `tests/v3-retrieval-index.test.ts`: `07d34f3d64114093da82627f8bfbcd54e590a60bc4bb69c8510f9fa1b878598a`
- final frozen evidence bundle SHA-256: `83e4af68f3696e35c9401ded6eb6f775c5064af6bf1f08513def4434b31734a9`

Executable evidence:

- focused RET-002/003/004 slice: **38/38 PASS**
- final full regression: **711/711 PASS**
- `npm run typecheck`: **PASS**
- `npm run build`: **PASS**
- scoped `git diff --check`: **PASS**

Final independent reviews on the same frozen final candidate:

- GPT-5.6 Sol frozen-evidence review job `3da7993a-e80f-4825-9e5b-ed76ce9d2f95`: **PASS, P0=0, P1=0**.
- GPT-5.6 Luna frozen-evidence review job `6c3e6edf-0612-4317-96f1-270fdabc2c85`: **PASS, P0=0, P1=0**.
- Reviewed Claude Code 2.1.172 / Claude Sonnet 5 frozen-evidence review job `4c1a9245-3b0e-4733-9c7e-a86274cac73a`: **PASS, P0=0, P1=0**. `modelUsage` explicitly included `claude-sonnet-5`; total review cost was approximately **US$0.5604**.

Earlier review attempts and intermediate verdicts applied to superseded candidate hashes and are not acceptance evidence for the final candidate.

## Decision

RET-004 is **ACCEPTED COMPLETE** for the authorized bounded Phase 4 shadow-only scope. RET-005 through RET-008 remain unopened/unaccepted. This acceptance does not enable V3 runtime/customer traffic and does not change V1/V2 authority owners, outbound ownership, or the `SALES_ORDER.DRAFT` cutoff.
