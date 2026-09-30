import type Database from 'better-sqlite3';
import {canonicalJson, canonicalSha256} from './v2-canonical.js';
import {AgentContextBuilder} from './v2-agent-context.js';
import {buildContextSnapshot} from './v3-context-snapshot.js';
import {assembleV3ContextBudget, type V3ContextBudgetPlan} from './v3-context-budget.js';
import {buildV3ConversationMemory, type ConversationMemoryDerivationProposal, type V3ConversationMemory} from './v3-conversation-memory.js';
import {buildV3FreshnessVectorFromDatabase, type V3FreshnessDependencyVector} from './v3-freshness-vector.js';

export type ShadowConversationFixture = Readonly<{
  accountId: string;
  conversationId: string;
  inboundMessageId: string;
  messageIds: readonly string[];
}>;

export type ShadowMetric = Readonly<{value: number; passed: boolean; note: string}>;
export type V3ContextShadowEvaluation = Readonly<{
  fixture: ShadowConversationFixture;
  v2: Readonly<{contextChars: number; contextTokens: number; transcriptMessages: number; transcriptSourceIds: readonly string[]}>;
  v3: Readonly<{snapshotChars: number; plan: V3ContextBudgetPlan; memory: V3ConversationMemory; freshness: V3FreshnessDependencyVector; modelFacingChars: number; modelFacingTokens: number}>;
  metrics: Readonly<{
    completeness: ShadowMetric;
    sourceCoverage: ShadowMetric;
    tokenUse: Readonly<{v2ContextTokens: number; v3ModelFacingTokens: number; v3MemoryChars: number; v3MemoryTokens: number}>;
    authorityParity: ShadowMetric;
    zeroCustomerVisibleEffect: ShadowMetric;
  }>;
  effectsBefore: string;
  effectsAfter: string;
  deterministicFingerprint: string;
}>;

const EFFECT_TABLES = ['outbound_messages', 'quotations', 'quotation_acceptances', 'sales_orders', 'staff_actions', 'audit_events', 'work_items', 'order_drafts'] as const;
const TOKENS_PER_CHARS = 4;

function estimateTokens(chars: number): number { return Math.ceil(chars / TOKENS_PER_CHARS); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); }
  return value;
}
function tableFingerprint(db: Database.Database): string {
  return canonicalSha256(EFFECT_TABLES.map((table) => ({table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()})));
}
function rowsForMemory(db: Database.Database, fixture: ShadowConversationFixture): Array<{id: string; occurredAt: string; arrival_seq: number}> {
  return db.prepare('SELECT id,occurred_at,COALESCE(arrival_seq,rowid) AS arrival_seq FROM messages WHERE id IN (' + fixture.messageIds.map(() => '?').join(',') + ') AND account_id=? AND conversation_id=? ORDER BY arrival_seq,rowid')
    .all(...fixture.messageIds, fixture.accountId, fixture.conversationId) as Array<{id: string; occurredAt: string; arrival_seq: number}>;
}
function chronologyProposal(db: Database.Database, fixture: ShadowConversationFixture): ConversationMemoryDerivationProposal {
  const rows = rowsForMemory(db, fixture);
  const sections = [];
  const width = Math.max(1, Math.ceil(rows.length / 4));
  for (let start = 0; start < rows.length; start += width) {
    const selected = rows.slice(start, start + width);
    sections.push({id: `chronology-${start}`, title: `Chronology ${start + 1}-${start + selected.length}`, topic: `Index range ${start}-${start + selected.length - 1}`, summary: `Chronological source range ${start}-${start + selected.length - 1}`, sourceMessageIds: selected.map((row) => row.id)});
  }
  return {sections, rollingMemory: {text: `Chronological derived coverage for ${rows.length} source messages`, sourceMessageIds: rows.map((row) => row.id), sectionIds: sections.map((section) => section.id)}};
}
function freshnessInput(db: Database.Database, context: Record<string, any>, fixture: ShadowConversationFixture) {
  const state = context.activeQuotationSalesOrder;
  const business = (value: any) => value ? [{id: value.id, revision: 1, status: value.status}] : [];
  const messageRefs = rowsForMemory(db, fixture).map((row) => ({id: row.id, version: row.arrival_seq}));
  return {
    identityScope: {accountId: fixture.accountId, conversationId: fixture.conversationId, customerId: context.customerContext?.id ?? null, channelAccountId: fixture.accountId},
    employeeProfile: {id: context.profile.id, version: context.profile.version},
    capabilityPolicy: {policyVersion: context.profile.version, availableCapabilities: context.availableCapabilities.map((cap: any) => ({id: cap.name, version: cap.version}))},
    workItemOrderDraftRefs: {workItem: context.activeWorkItem ? {id: context.activeWorkItem.id, revision: context.activeWorkItem.revision, status: context.activeWorkItem.state} : null, orderDraft: context.orderDraft ? {id: context.orderDraft.id, revision: context.orderDraft.revision, status: context.orderDraft.status} : null},
    canonicalBusiness: {quotations: business(state.quotation), acceptances: business(state.acceptance), outbound: business(state.outbound), salesOrders: business(state.salesOrder)},
    relevantErpEvidence: (context.relevantErpEvidenceAndPolicies.validation?.evidence ?? []).map((entry: any) => ({sourceId: entry.id, sourceVersion: entry.sourceVersion, kind: entry.type})),
    goalGraph: {version: null, dependencyRefs: []}, attachmentExtraction: {version: null, dependencyRefs: []}, retentionAccess: {version: 1, dependencyRefs: []},
    conversationBundle: {conversationRevision: messageRefs.length, bundleRevision: messageRefs.length, messageRefs},
  };
}
function exactAuthorityParity(context: Record<string, any>, snapshot: ReturnType<typeof buildContextSnapshot>, vector: V3FreshnessDependencyVector, fixture: ShadowConversationFixture): boolean {
  const refs = snapshot.sourceRevisionRefs;
  const expectedCapabilities = context.availableCapabilities.map((cap: any) => ({id: cap.name, version: cap.version})).sort((a: any, b: any) => a.id.localeCompare(b.id) || String(a.version).localeCompare(String(b.version)));
  const expectedWorkItem = context.activeWorkItem ? {id: context.activeWorkItem.id, revision: context.activeWorkItem.revision, status: context.activeWorkItem.state} : null;
  const expectedOrderDraft = context.orderDraft ? {id: context.orderDraft.id, revision: context.orderDraft.revision, status: context.orderDraft.status} : null;
  return refs.accountId === fixture.accountId
    && refs.conversationId === fixture.conversationId
    && refs.inboundMessageId === fixture.inboundMessageId
    && refs.profileId === context.profile.id
    && refs.profileVersion === context.profile.version
    && refs.freshnessFingerprint === context.freshness.fingerprint
    && canonicalJson(snapshot.context.customerContext) === canonicalJson(context.customerContext)
    && canonicalJson(snapshot.context.availableCapabilities) === canonicalJson(context.availableCapabilities)
    && canonicalJson(snapshot.context.activeWorkItem) === canonicalJson(context.activeWorkItem)
    && canonicalJson(snapshot.context.orderDraft) === canonicalJson(context.orderDraft)
    && canonicalJson(snapshot.context.activeQuotationSalesOrder) === canonicalJson(context.activeQuotationSalesOrder)
    && vector.dependencies.identityScope.accountId === context.accountId
    && vector.dependencies.identityScope.channelAccountId === context.accountId
    && vector.dependencies.identityScope.conversationId === context.conversationId
    && vector.dependencies.identityScope.customerId === (context.customerContext?.id ?? null)
    && vector.dependencies.employeeProfile.id === context.profile.id
    && vector.dependencies.employeeProfile.version === context.profile.version
    && canonicalJson(vector.dependencies.capabilityPolicy.availableCapabilities) === canonicalJson(expectedCapabilities)
    && canonicalJson(vector.dependencies.workItemOrderDraftRefs.workItem) === canonicalJson(expectedWorkItem)
    && canonicalJson(vector.dependencies.workItemOrderDraftRefs.orderDraft) === canonicalJson(expectedOrderDraft)
    && vector.dependencies.authoritativeV2FreshnessFingerprint === context.freshness.fingerprint;
}
export function evaluateV3ContextShadow(db: Database.Database, fixture: ShadowConversationFixture, nowIso = '2026-09-14T12:00:00+08:00'): V3ContextShadowEvaluation {
  const effectsBefore = tableFingerprint(db);
  const v2Context = new AgentContextBuilder(db).build({turnId: `shadow-${fixture.conversationId}`, accountId: fixture.accountId, conversationId: fixture.conversationId, inboundMessageId: fixture.inboundMessageId, nowIso, timezone: 'Asia/Singapore'}) as Record<string, any>;
  const snapshot = buildContextSnapshot(v2Context);
  const memory = buildV3ConversationMemory(db, {accountId: fixture.accountId, conversationId: fixture.conversationId, proposal: chronologyProposal(db, fixture)});
  const freshness = buildV3FreshnessVectorFromDatabase(db, freshnessInput(db, v2Context, fixture));
  const plan = assembleV3ContextBudget(snapshot, {modelContextBudgetTokens: 1800, systemAuthorityReserveTokens: 300, toolReasoningReserveTokens: 300, futureGoalsReserveTokens: 200});
  const effectsAfter = tableFingerprint(db);
  const v2Ids = v2Context.recentTranscript.messages.map((message: any) => message.id);
  const memoryIds = new Set([...memory.sections.flatMap((section) => section.sourceMessageIds), ...memory.rollingMemory.sourceMessageIds]);
  const modelFacingChars = plan.budget.usedContextChars;
  const authorityParity = exactAuthorityParity(v2Context, snapshot, freshness, fixture);
  const sourceCoverage = fixture.messageIds.filter((id) => memoryIds.has(id)).length / fixture.messageIds.length;
  return freeze({fixture, v2: {contextChars: canonicalJson(v2Context).length, contextTokens: estimateTokens(canonicalJson(v2Context).length), transcriptMessages: v2Ids.length, transcriptSourceIds: v2Ids}, v3: {snapshotChars: canonicalJson(snapshot).length, plan, memory, freshness, modelFacingChars, modelFacingTokens: estimateTokens(modelFacingChars)}, metrics: {completeness: {value: sourceCoverage, passed: sourceCoverage === 1, note: 'Every fixture message is represented by source-linked derived memory'}, sourceCoverage: {value: v2Ids.filter((id: string) => memoryIds.has(id)).length / Math.max(1, v2Ids.length), passed: v2Ids.every((id: string) => memoryIds.has(id)), note: 'V2 bounded transcript IDs remain covered by V3 source refs'}, tokenUse: {v2ContextTokens: estimateTokens(canonicalJson(v2Context).length), v3ModelFacingTokens: estimateTokens(modelFacingChars), v3MemoryChars: canonicalJson(memory).length, v3MemoryTokens: estimateTokens(canonicalJson(memory).length)}, authorityParity: {value: authorityParity ? 1 : 0, passed: authorityParity, note: 'Exact scope, inbound, profile/version, V2 fingerprint, and canonical commerce parity'}, zeroCustomerVisibleEffect: {value: effectsBefore === effectsAfter ? 1 : 0, passed: effectsBefore === effectsAfter, note: 'Effect-table fingerprint unchanged by pure shadow evaluation'}}, effectsBefore, effectsAfter, deterministicFingerprint: canonicalSha256({fixture, v2: {contextChars: canonicalJson(v2Context).length, transcriptMessages: v2Ids.length, transcriptSourceIds: v2Ids}, v3: {snapshot, plan, memory, freshness}, effectsBefore, effectsAfter})});
}

export function assertV3ContextShadowGates(evaluation: V3ContextShadowEvaluation): void {
  if (!evaluation.metrics.completeness.passed || !evaluation.metrics.sourceCoverage.passed || !evaluation.metrics.authorityParity.passed || !evaluation.metrics.zeroCustomerVisibleEffect.passed) throw new Error('V3_CTX006_SHADOW_GATE_FAILED');
}
