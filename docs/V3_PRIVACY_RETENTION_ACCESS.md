# V3 Phase 0 — Privacy, Retention, and Access Contract

Status: **PROPOSED POLICY CONTRACT — OWNER APPROVAL REQUIRED**

This contract defines the safety semantics Conversation Intelligence V3 must satisfy before long-term conversational memory, retrieval, or multimodal evidence can be implemented. It deliberately does **not** invent legal retention periods. Exact durations, hold authority, deletion SLAs, and jurisdiction/customer obligations are owner/policy decisions.

## 1. Core rule

“Immutable evidence” means retained source content is not silently rewritten to match later summaries or model conclusions. It does **not** mean “retain forever.” Retention, deletion, access revocation, legal/operational hold, and backup policy remain Host-owned policy decisions.

## 2. Data classes

V3 must classify at least:

1. Raw inbound/outbound conversation messages and provider-neutral chronology.
2. Original attachment bytes and bounded source metadata.
3. Provider metadata needed for identity, deduplication, reply linkage, reconciliation, and audit.
4. Derived attachment evidence: extracted text, OCR, vision observations, tables, transcripts, page/region/time references.
5. Derived conversation intelligence: summaries, sections/episodes, embeddings/index entries, rolling memory.
6. Goal Graph and durable continuation state.
7. ERP/business references and immutable canonical commerce evidence governed by existing ERP/V1/V2 policy.
8. Audit/observability metadata.
9. Ephemeral model/context payloads and temporary processing/cache artifacts.

A retention decision for one class must not silently redefine another class's legal/business retention requirements.

## 3. Server-enforced scope

Every persisted/retrieved V3 item inherits the narrowest authoritative scope available from its source:

`tenant/account -> channel account -> conversation -> customer -> source message/attachment`

The Host derives this scope from authenticated canonical state. Model-provided tenant/customer/conversation identifiers are never authorization. Search indexes, summaries, embeddings, attachment extractions, caches and async work inherit source scope and cannot broaden it. Scope mismatch fails closed without confirming foreign evidence exists.

## 4. Retention policy semantics

- Retention periods are configuration/policy, not model decisions.
- Each source/derived class has an explicit policy identifier and retention state.
- Derived state cannot outlive its usable source/access authority unless a separately approved policy explicitly permits a content-free tombstone/audit record.
- Historical business records such as quotation/acceptance/Sales Order evidence remain governed by their canonical ERP/V1/V2 retention policy; conversation expiry must not silently delete canonical ERP truth.
- Policy changes advance the relevant `retentionAccessVersion` and invalidate affected context/retrieval authorization.

## 5. Deletion / expiry semantics

When source evidence is deleted, expires, or becomes inaccessible:

1. it must no longer be returned to active conversation retrieval;
2. affected summaries/sections/indexes/embeddings/extractions are invalidated and removed or rebuilt without that source according to policy;
3. cached/context snapshots referencing it become stale and cannot authorize new effects;
4. active async extraction/index/retrieval work for it must be cancelled when possible; late results must be discarded rather than reintroduced;
5. durable continuations depending on it must wake only to produce a bounded unavailable/clarification/handoff disposition, not to expose the revoked evidence;
6. a future rebuild must respect the deletion/tombstone state so restore/reindex cannot resurrect expired evidence.

A deletion workflow must be idempotent and scoped. Failure is visible/auditable and fails closed for retrieval.

## 6. Attachments and multimodal derivatives

Original media and every extraction version remain linked by source identity/content version while retained. Deleting/revoking the source invalidates OCR, text extraction, vision observations, thumbnails/previews, tables, transcripts, embeddings and search entries derived from it. Prompt-injection text inside media never changes retention/access policy.

A content hash is an integrity/provenance aid, not automatically permission to retain personal content. Whether a hash/tombstone may remain after source deletion is an explicit policy decision.

## 7. Holds

Legal or operational holds, if required, are explicit Host-owned records with scope, reason category, authority, creation/expiry/review metadata and audit evidence. AI/customer content cannot create or remove a hold. A hold prevents normal purge only within its exact approved scope; it does not widen conversational/model access.

## 8. Access revocation and identity changes

Customer/channel rebinding, employee/profile disablement, tenant/account access loss, policy change, or explicit evidence revocation advances the freshness/access watermark. Running reasoning that observed the old scope becomes stale. Before any retrieval result is exposed or effect is admitted, current access is rechecked server-side.

Access revocation is stronger than cache freshness: stale workers, old model sessions, queued async jobs and old lease generations cannot regain access from previously captured identifiers.

## 9. Model/context minimization

- Provide only evidence needed for the current bounded decision.
- Redact secrets and provider credentials before model visibility.
- Prefer bounded references/snippets before opening full historical sections or attachments.
- Do not log raw chain-of-thought.
- Diagnostic traces should prefer IDs, versions, reason codes, counts, hashes and bounded safe summaries over full private message/document bodies.
- Model/provider retention settings, if external providers are used, require a separate explicit deployment/privacy review; V3 architecture alone does not approve them.

## 10. Backups, restores, caches, and replicas

The production policy must define deletion propagation and maximum persistence windows across database backups, object storage, caches, search/vector indexes, replicas, temporary processing artifacts and provider-side retained data where applicable. The architecture must not claim immediate physical erasure where a backup system cannot provide it.

Restore procedures must replay deletion/access tombstones or equivalent policy state before rebuilt indexes become queryable, preventing deleted evidence from reappearing after disaster recovery.

## 11. Audit minimization

Audit must prove access/deletion/invalidation decisions without becoming a shadow archive of the deleted content. Prefer scoped identifiers, policy/version refs, actor/authority refs, timestamps, reason codes and integrity metadata. Raw content in audit payloads requires an explicit necessity and retention policy.

## 12. Required fail-closed cases

V3 implementation tests must eventually prove at least:

- cross-tenant/cross-customer search cannot return or enumerate foreign evidence;
- deleted/expired source is absent from raw, semantic, section, attachment and business-object conversation retrieval;
- derived summary/index cannot resurrect deleted source after rebuild;
- async OCR/vision/transcription finishing after revocation is discarded;
- stale context cannot send/mutate after access-version change;
- rollback from V3 does not restore revoked derived evidence;
- backup/restore test procedure reapplies access/deletion policy before retrieval is enabled;
- canonical ERP evidence remains separately governed and is not rewritten by conversation-memory deletion.

## 13. Owner decisions required before Gate 003 can close

The owner/privacy policy must explicitly approve:

- retention period/policy per data class and environment;
- customer/tenant deletion and access-revocation process;
- legal/operational hold authority and review process;
- deletion propagation SLA and backup retention/restore behavior;
- object/media storage and external-provider deletion expectations;
- employee/support access roles and audit requirements;
- export/subject-access obligations where applicable;
- encryption/key-management requirements for retained conversation/media data;
- whether post-deletion tombstone hashes/identifiers may remain and for how long;
- model/provider data-handling configuration for production multimodal processing.

## Phase 0 policy decision

**PHASE 1 ENGINEERING POLICY APPROVED — OWNER CHOICE A.** The engineering constraints in this document are approved for shadow-only Phase 1. Exact production retention durations, legal-hold/export/provider settings, deletion SLAs, and jurisdiction-specific compliance remain deferred.
