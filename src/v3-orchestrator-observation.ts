import {validateConversationGoal, type ConversationGoal} from './v3-conversation-goal.js';
import {V3_GOAL_EDGE_TYPES} from './v3-goal-graph.js';
import {validateInboundBundle, type InboundBundle} from './v3-inbound-bundle.js';
import {validateV3FreshnessVector, type V3FreshnessDependencyVector} from './v3-freshness-vector.js';
import {V3_RETRIEVAL_LADDER_TOOL_NAMES} from './v3-retrieval-ladder.js';
import {V3_RETRIEVAL_TOOL_NAMES} from './v3-retrieval-tools.js';

export type V3ObservationScope = Readonly<{accountId: string; conversationId: string}>;
export type V3RetrievalCapabilityDescriptor = Readonly<{name: string; contractVersion: string; readOnly: true}>;
export type V3AttachmentObservation = Readonly<{evidenceId:string;attachmentId:string;sourceMessageId:string;sourceRef:string;mediaType:string;extractionType:string;extractionVersion:string;pageNumber:number|null;regionRef:string|null;timeRange:Readonly<{start:number;end:number}|null>;freshnessState:string;trustClass:'UNTRUSTED_CUSTOMER_EVIDENCE'}>;
export type V3ObservationInput = Readonly<{scope: V3ObservationScope; inboundBundle: unknown; goalGraph: unknown; freshnessVector: unknown; retrievalCapabilities: readonly V3RetrievalCapabilityDescriptor[]; attachmentEvidence?: readonly V3AttachmentObservation[]}>;
export type V3ObservationProjection = Readonly<{
  authority: 'NON_AUTHORITATIVE_CONTEXT_METADATA'; untrustedAsInstruction: true; aiAuthorityCutoff: 'SALES_ORDER.DRAFT';
  inboundBundle: Readonly<{bundleId: string; replayIdentity: string; bundleRevision: number; conversationRevisionAtBuild: number; messageIds: readonly string[]}>;
  goalGraph: Readonly<{goalIds: readonly string[]; statuses: readonly string[]; edges: readonly Readonly<{fromGoalId: string; toGoalId: string; edgeType: string}>[]}>;
  freshness: Readonly<{vectorHash: string; dependencyDigests: Readonly<Record<string, string>>}>;
  retrievalCapabilities: readonly V3RetrievalCapabilityDescriptor[];
  attachmentEvidence: readonly V3AttachmentObservation[];
}>;

const RETRIEVAL_NAMES = new Set<string>([...V3_RETRIEVAL_TOOL_NAMES, ...V3_RETRIEVAL_LADDER_TOOL_NAMES]);
const MAX_ITEMS = 50; const MAX_ID = 512;
function invalid(code: string): never { throw new Error(`V3_ORCH_001_INVALID:${code}`); }
function bounded(value: unknown, code: string): string { if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID) invalid(code); return value; }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
function dataObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(code);
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) || Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid(code);
  return value as Record<string, unknown>;
}
function closedArray(value: unknown, code: string): readonly unknown[] { if (!Array.isArray(value) || value.length > MAX_ITEMS || Object.getPrototypeOf(value) !== Array.prototype) invalid(code); const descriptors = Object.getOwnPropertyDescriptors(value); if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) invalid(code); return value; }
function validateGraph(value: unknown, scope: V3ObservationScope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('GOAL_GRAPH_SHAPE');
  const input = dataObject(value, ['scope','goals','edges'], 'GOAL_GRAPH_SHAPE'), graphScope = dataObject(input.scope, ['accountId','conversationId'], 'GOAL_GRAPH_SCOPE');
  if (!graphScope || graphScope.accountId !== scope.accountId || graphScope.conversationId !== scope.conversationId) invalid('GOAL_GRAPH_SCOPE');
  const goals = closedArray(input.goals, 'GOALS').map(goal => validateConversationGoal(goal)) as ConversationGoal[];
  const ids = new Set(goals.map(goal => goal.goalId));
  const edges = closedArray(input.edges, 'EDGES').map(edge => {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) invalid('EDGE_SHAPE');
    const item = dataObject(edge, ['edgeId','accountId','conversationId','fromGoalId','toGoalId','edgeType','idempotencyKey','createdAt'], 'EDGE_SHAPE'), fromGoalId = bounded(item.fromGoalId, 'EDGE_FROM'), toGoalId = bounded(item.toGoalId, 'EDGE_TO');
    if (!ids.has(fromGoalId) || !ids.has(toGoalId) || fromGoalId === toGoalId || !V3_GOAL_EDGE_TYPES.includes(item.edgeType as never)) invalid('EDGE_SCOPE');
    const edgeType = bounded(item.edgeType, 'EDGE_TYPE');
    bounded(item.edgeId, 'EDGE_ID'); bounded(item.idempotencyKey, 'EDGE_IDEMPOTENCY'); bounded(item.createdAt, 'EDGE_CREATED_AT');
    if (item.accountId !== scope.accountId || item.conversationId !== scope.conversationId) invalid('EDGE_SCOPE');
    return {fromGoalId, toGoalId, edgeType};
  });
  return {scope: {accountId: scope.accountId, conversationId: scope.conversationId}, goals, edges};
}

export function projectV3OrchestratorObservation(input: V3ObservationInput): V3ObservationProjection {
  const scope = {accountId: bounded(input.scope.accountId, 'ACCOUNT_ID'), conversationId: bounded(input.scope.conversationId, 'CONVERSATION_ID')};
  const bundle: InboundBundle = validateInboundBundle(input.inboundBundle);
  if (bundle.accountId !== scope.accountId || bundle.conversationId !== scope.conversationId || bundle.messageIds.length > MAX_ITEMS) invalid('BUNDLE_SCOPE');
  const vector: V3FreshnessDependencyVector = validateV3FreshnessVector(input.freshnessVector);
  if (vector.dependencies.identityScope.accountId !== scope.accountId || vector.dependencies.identityScope.conversationId !== scope.conversationId) invalid('FRESHNESS_SCOPE');
  const validatedGraph = validateGraph(input.goalGraph, scope);
  const capabilities = closedArray(input.retrievalCapabilities, 'RETRIEVAL_CAPABILITIES').map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('RETRIEVAL_DESCRIPTOR');
    const item = dataObject(value, ['name','contractVersion','readOnly'], 'RETRIEVAL_DESCRIPTOR');
    if (!RETRIEVAL_NAMES.has(String(item.name)) || item.readOnly !== true) invalid('RETRIEVAL_DESCRIPTOR');
    return {name: bounded(item.name, 'RETRIEVAL_NAME'), contractVersion: bounded(item.contractVersion, 'RETRIEVAL_VERSION'), readOnly: true as const};
  });
  const attachmentEvidence = (input.attachmentEvidence ?? []).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('ATTACHMENT_OBSERVATION');
    const item = value as Record<string, unknown>;
    const keys = ['evidenceId','attachmentId','sourceMessageId','sourceRef','mediaType','extractionType','extractionVersion','pageNumber','regionRef','timeRange','freshnessState','trustClass'];
    if (Object.keys(item).some(key => !keys.includes(key)) || keys.some(key => !Object.prototype.hasOwnProperty.call(item, key))) invalid('ATTACHMENT_OBSERVATION');
    if (item.trustClass !== 'UNTRUSTED_CUSTOMER_EVIDENCE' || (item.pageNumber !== null && typeof item.pageNumber !== 'number')) invalid('ATTACHMENT_OBSERVATION');
    return Object.freeze({...item, evidenceId: bounded(item.evidenceId, 'ATTACHMENT_EVIDENCE_ID'), attachmentId: bounded(item.attachmentId, 'ATTACHMENT_ID'), sourceMessageId: bounded(item.sourceMessageId, 'ATTACHMENT_MESSAGE_ID'), sourceRef: bounded(item.sourceRef, 'ATTACHMENT_SOURCE_REF'), mediaType: bounded(item.mediaType, 'ATTACHMENT_MEDIA'), extractionType: bounded(item.extractionType, 'ATTACHMENT_EXTRACTION'), extractionVersion: bounded(item.extractionVersion, 'ATTACHMENT_VERSION'), freshnessState: bounded(item.freshnessState, 'ATTACHMENT_FRESHNESS')}) as V3AttachmentObservation;
  });
  return freeze({authority: 'NON_AUTHORITATIVE_CONTEXT_METADATA' as const, untrustedAsInstruction: true as const, aiAuthorityCutoff: 'SALES_ORDER.DRAFT' as const,
    inboundBundle: {bundleId: bundle.bundleId, replayIdentity: bundle.replayIdentity, bundleRevision: bundle.bundleRevision, conversationRevisionAtBuild: bundle.conversationRevisionAtBuild, messageIds: [...bundle.messageIds]},
    goalGraph: {goalIds: validatedGraph.goals.map(goal => goal.goalId), statuses: validatedGraph.goals.map(goal => goal.status), edges: validatedGraph.edges.map(edge => ({fromGoalId: edge.fromGoalId, toGoalId: edge.toGoalId, edgeType: edge.edgeType}))},
    freshness: {vectorHash: vector.vectorHash, dependencyDigests: {...vector.dependencyDigests}}, retrievalCapabilities: capabilities, attachmentEvidence: Object.freeze(attachmentEvidence)});
}
