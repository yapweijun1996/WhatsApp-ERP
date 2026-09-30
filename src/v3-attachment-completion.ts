/** V3-MM-005: Host-owned async extraction completion/invalidation bridge. */
import type {V1Database} from './database.js';
import {canonicalSha256} from './v2-canonical.js';
import {projectV3InvalidationEvent, validateV3InvalidationEvent, type V3InvalidationEvent} from './v3-invalidation.js';
import {validateV3FreshnessVector, type V3FreshnessDependencyVector} from './v3-freshness-vector.js';
import {processV3ContinuationWake, type V3ContinuationDecision} from './v3-continuation-processing.js';
import {V3_CONTINUATION_TRIGGERS} from './v3-durable-continuation.js';

export const V3_ATTACHMENT_COMPLETION_CONTRACT_VERSION = 'V3-MM-005' as const;
export const V3_ATTACHMENT_COMPLETION_SCHEMA_VERSION = 1 as const;

export type V3AttachmentExtractionOutcome = 'COMPLETED'|'INVALIDATED';
export type V3AttachmentExtractionHostEvent = Readonly<{
  contractVersion: typeof V3_ATTACHMENT_COMPLETION_CONTRACT_VERSION;
  schemaVersion: 1;
  authority: 'HOST_DERIVED_NON_AUTHORITATIVE';
  eventId: string;
  accountId: string;
  conversationId: string;
  attachmentId: string;
  sourceMessageId: string;
  sourceRef: string;
  sourceFingerprint: string;
  extractionVersion: string;
  extractionDependencyId: string;
  extractionDependencyVersion: string|number;
  outcome: V3AttachmentExtractionOutcome;
  invalidationEventId: string;
  priorVectorHash: string;
  currentVectorHash: string;
  occurredAt: string;
}>;

export type V3AttachmentCompletionCandidate = Readonly<{
  continuationId: string;
  ownerId: string;
  leaseMs?: number;
  bundle: unknown;
  context: unknown;
}>;

export type V3AttachmentCompletionResult = Readonly<{
  event: V3AttachmentExtractionHostEvent;
  freshnessAdvanced: boolean;
  decisions: readonly V3ContinuationDecision[];
}>;

const fail = (code: string): never => { throw new Error(`V3_ATTACHMENT_COMPLETION_INVALID:${code}`); };
const text = (value: unknown, code: string, max = 512): string => { if (typeof value !== 'string' || value.trim() === '' || value.length > max) fail(code); return value as string; };
const iso = (value: unknown): string => { const result = text(value, 'OCCURRED_AT', 80); if (!Number.isFinite(Date.parse(result))) fail('OCCURRED_AT'); return result; };
const outcome = (value: unknown): V3AttachmentExtractionOutcome => { if (value !== 'COMPLETED' && value !== 'INVALIDATED') fail('OUTCOME'); return value as V3AttachmentExtractionOutcome; };
const version = (value: unknown): string|number => { if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isSafeInteger(value))) fail('VERSION'); return value as string|number; };
const hex = (value: unknown, code: string): string => { const result = text(value, code, 128); if (!/^[a-f0-9]{64}$/.test(result)) fail(code); return result; };
const exact = (value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('SHAPE');
  const object = value as object, descriptors = Object.getOwnPropertyDescriptors(object), allowed = new Set([...keys, ...optional]);
  if (Reflect.ownKeys(object).some((key) => typeof key !== 'string' || !allowed.has(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) fail('SHAPE');
  const result: Record<string, unknown> = {};
  for (const key of [...keys, ...optional]) { const descriptor = descriptors[key]; if (!descriptor) continue; if (!descriptor.enumerable || !('value' in descriptor)) fail('SHAPE'); result[key] = (descriptor as PropertyDescriptor & {value: unknown}).value; }
  return result;
};

function validateEvent(value: unknown): V3AttachmentExtractionHostEvent {
  const x = exact(value, ['contractVersion','schemaVersion','authority','eventId','accountId','conversationId','attachmentId','sourceMessageId','sourceRef','sourceFingerprint','extractionVersion','extractionDependencyId','extractionDependencyVersion','outcome','invalidationEventId','priorVectorHash','currentVectorHash','occurredAt']);
  if (x.contractVersion !== V3_ATTACHMENT_COMPLETION_CONTRACT_VERSION || x.schemaVersion !== 1 || x.authority !== 'HOST_DERIVED_NON_AUTHORITATIVE') fail('CONTRACT');
  const {eventId: suppliedEventId, ...rawEvent} = x;
  const event = {...rawEvent, accountId: text(x.accountId, 'ACCOUNT_ID'), conversationId: text(x.conversationId, 'CONVERSATION_ID'), attachmentId: text(x.attachmentId, 'ATTACHMENT_ID'), sourceMessageId: text(x.sourceMessageId, 'SOURCE_MESSAGE_ID'), sourceRef: text(x.sourceRef, 'SOURCE_REF'), sourceFingerprint: hex(x.sourceFingerprint, 'SOURCE_FINGERPRINT'), extractionVersion: text(x.extractionVersion, 'EXTRACTION_VERSION'), extractionDependencyId: text(x.extractionDependencyId, 'DEPENDENCY_ID'), extractionDependencyVersion: version(x.extractionDependencyVersion), outcome: outcome(x.outcome), invalidationEventId: text(x.invalidationEventId, 'INVALIDATION_EVENT_ID'), priorVectorHash: text(x.priorVectorHash, 'PRIOR_VECTOR_HASH', 128), currentVectorHash: text(x.currentVectorHash, 'CURRENT_VECTOR_HASH', 128), occurredAt: iso(x.occurredAt)} as Omit<V3AttachmentExtractionHostEvent, 'eventId'>;
  const identity = {...event};
  if (suppliedEventId !== `${V3_ATTACHMENT_COMPLETION_CONTRACT_VERSION}:event:${canonicalSha256(identity)}`) fail('EVENT_ID');
  return Object.freeze({...event, eventId: text(suppliedEventId, 'EVENT_ID')});
}

function condition(event: V3AttachmentExtractionHostEvent): string { return `v3:mm005:extraction:${event.eventId}`; }

export function buildV3AttachmentExtractionHostEvent(previousInput: unknown, currentInput: unknown, input: Readonly<{accountId: string; conversationId: string; attachmentId: string; sourceMessageId: string; sourceRef: string; sourceFingerprint: string; extractionVersion: string; extractionDependencyId: string; extractionDependencyVersion: string|number; outcome: V3AttachmentExtractionOutcome; occurredAt: string}>): V3AttachmentExtractionHostEvent {
  const previous = validateV3FreshnessVector(previousInput), current = validateV3FreshnessVector(currentInput);
  const accountId = text(input.accountId, 'ACCOUNT_ID'), conversationId = text(input.conversationId, 'CONVERSATION_ID');
  if (previous.dependencies.identityScope.accountId !== accountId || previous.dependencies.identityScope.conversationId !== conversationId || current.dependencies.identityScope.accountId !== accountId || current.dependencies.identityScope.conversationId !== conversationId) fail('SCOPE');
  if (previous.vectorHash === current.vectorHash) fail('FRESHNESS_NOT_ADVANCED');
  const invalidation = projectV3InvalidationEvent(previous, current, accountId, conversationId, input.occurredAt).event;
  if (invalidation === null) throw new Error('V3_ATTACHMENT_COMPLETION_INVALID:EXTRACTION_NOT_CHANGED');
  if (invalidation.changedClasses.length !== 1 || invalidation.changedClasses[0] !== 'attachmentExtraction') fail('EXTRACTION_NOT_CHANGED');
  const dependency = current.dependencies.attachmentExtraction.dependencyRefs.find((ref) => ref.id === input.extractionDependencyId && ref.version === input.extractionDependencyVersion);
  if (!dependency) fail('DEPENDENCY_MISMATCH');
  const eventBody = {contractVersion: V3_ATTACHMENT_COMPLETION_CONTRACT_VERSION as typeof V3_ATTACHMENT_COMPLETION_CONTRACT_VERSION, schemaVersion: 1 as const, authority: 'HOST_DERIVED_NON_AUTHORITATIVE' as const, accountId, conversationId, attachmentId: text(input.attachmentId, 'ATTACHMENT_ID'), sourceMessageId: text(input.sourceMessageId, 'SOURCE_MESSAGE_ID'), sourceRef: text(input.sourceRef, 'SOURCE_REF'), sourceFingerprint: hex(input.sourceFingerprint, 'SOURCE_FINGERPRINT'), extractionVersion: text(input.extractionVersion, 'EXTRACTION_VERSION'), extractionDependencyId: text(input.extractionDependencyId, 'DEPENDENCY_ID'), extractionDependencyVersion: version(input.extractionDependencyVersion), outcome: outcome(input.outcome), invalidationEventId: invalidation.eventId, priorVectorHash: previous.vectorHash, currentVectorHash: current.vectorHash, occurredAt: iso(input.occurredAt)};
  return validateEvent({...eventBody, eventId: `${V3_ATTACHMENT_COMPLETION_CONTRACT_VERSION}:event:${canonicalSha256(eventBody)}`});
}

export function attachmentExtractionResumeCondition(event: V3AttachmentExtractionHostEvent): string { return condition(validateEvent(event)); }

export function processV3AttachmentExtractionHostEvent(database: V1Database, eventInput: unknown, currentVectorInput: unknown, candidates: readonly V3AttachmentCompletionCandidate[]): V3AttachmentCompletionResult {
  const event = validateEvent(eventInput), currentVector = validateV3FreshnessVector(currentVectorInput);
  if (currentVector.vectorHash !== event.currentVectorHash || currentVector.dependencies.identityScope.accountId !== event.accountId || currentVector.dependencies.identityScope.conversationId !== event.conversationId) fail('VECTOR_SCOPE');
  validateV3InvalidationEvent({contractVersion: 'V3-CP-005', schemaVersion: 1, authority: 'HOST_DERIVED_NON_AUTHORITATIVE', eventId: event.invalidationEventId, accountId: event.accountId, conversationId: event.conversationId, priorVectorHash: event.priorVectorHash, currentVectorHash: event.currentVectorHash, changedClasses: ['attachmentExtraction'], occurredAt: event.occurredAt});
  if (!Array.isArray(candidates)) fail('CANDIDATES');
  if (event.outcome === 'INVALIDATED') return Object.freeze({event, freshnessAdvanced: true, decisions: []});
  const decisions: V3ContinuationDecision[] = [];
  for (const candidateInput of candidates) {
    const candidate = exact(candidateInput, ['continuationId','ownerId','bundle','context'], ['leaseMs']);
    const accountId = event.accountId, conversationId = event.conversationId;
    decisions.push(processV3ContinuationWake(database, {accountId, conversationId, continuationId: text(candidate.continuationId, 'CONTINUATION_ID'), resumeTriggerType: V3_CONTINUATION_TRIGGERS[1], condition: condition(event), nowIso: event.occurredAt, ownerId: text(candidate.ownerId, 'OWNER_ID'), wakeEventId: event.eventId, ...(candidate.leaseMs === undefined ? {} : {leaseMs: candidate.leaseMs}), bundle: candidate.bundle, context: candidate.context, freshnessVector: currentVector}));
  }
  return Object.freeze({event, freshnessAdvanced: true, decisions: Object.freeze(decisions)});
}
