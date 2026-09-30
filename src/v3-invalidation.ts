import type Database from 'better-sqlite3';
import {canonicalJson, canonicalSha256} from './v2-canonical.js';
import {isCurrentReasoningLease, type ActiveReasoningLease} from './v3-reasoning-lease.js';
import {validateInboundBundle, type InboundBundle} from './v3-inbound-bundle.js';
import {validateContextSnapshot, type ContextSnapshot} from './v3-context-snapshot.js';
import {buildV3FreshnessVectorFromDatabase, freshnessVectorChangedClasses, validateV3FreshnessVector, type V3FreshnessDependencyVector, type V3FreshnessVectorInput} from './v3-freshness-vector.js';

export const V3_INVALIDATION_EVENT_CONTRACT_VERSION = 'V3-CP-005';
export const V3_INVALIDATION_EVENT_SCHEMA_VERSION = 1;
export const V3_INVALIDATION_CLASSES = ['identityScope', 'employeeProfile', 'capabilityPolicy', 'workItemOrderDraftRefs', 'canonicalBusiness', 'relevantErpEvidence', 'goalGraph', 'attachmentExtraction', 'retentionAccess', 'authoritativeV2FreshnessFingerprint'] as const;
export type V3InvalidationClass = typeof V3_INVALIDATION_CLASSES[number];

export type V3InvalidationEvent = Readonly<{
  contractVersion: typeof V3_INVALIDATION_EVENT_CONTRACT_VERSION;
  schemaVersion: 1;
  authority: 'HOST_DERIVED_NON_AUTHORITATIVE';
  eventId: string;
  accountId: string;
  conversationId: string;
  priorVectorHash: string;
  currentVectorHash: string;
  changedClasses: readonly V3InvalidationClass[];
  occurredAt: string;
}>;

export type V3InvalidationProjection = Readonly<{event: V3InvalidationEvent | null; stale: boolean; changedClasses: readonly V3InvalidationClass[]}>;

function fail(code: string): never { throw new Error(`V3_INVALIDATION_INVALID:${code}`); }
function text(value: unknown, code: string, max = 512): string { if (typeof value !== 'string' || value.trim() === '' || value.length > max) fail(code); return value; }
function iso(value: unknown): string { const result = text(value, 'OCCURRED_AT', 80); if (!Number.isFinite(Date.parse(result))) fail('OCCURRED_AT'); return result; }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
function scope(vector: V3FreshnessDependencyVector, accountId: string, conversationId: string) {
  const actual = vector.dependencies.identityScope;
  if (actual.accountId !== accountId || actual.conversationId !== conversationId) fail('SCOPE');
}
function classes(value: readonly string[]): V3InvalidationClass[] {
  if (!Array.isArray(value)) fail('CLASS');
  const result = [...new Set(value)].sort() as V3InvalidationClass[];
  if (result.some((item) => !(V3_INVALIDATION_CLASSES as readonly string[]).includes(item))) fail('CLASS');
  return result;
}

/** A deterministic Host event projection. It persists through the existing vector-bound facts; no event table is introduced. */
export function projectV3InvalidationEvent(previousInput: unknown, currentInput: unknown, accountId: string, conversationId: string, occurredAt: string): V3InvalidationProjection {
  const previous = validateV3FreshnessVector(previousInput), current = validateV3FreshnessVector(currentInput);
  const account = text(accountId, 'ACCOUNT_ID'), conversation = text(conversationId, 'CONVERSATION_ID');
  scope(previous, account, conversation); scope(current, account, conversation);
  const changed = classes(freshnessVectorChangedClasses(previous, current).filter((item): item is V3InvalidationClass => (V3_INVALIDATION_CLASSES as readonly string[]).includes(item)));
  if (changed.length === 0) return freeze({event: null, stale: false, changedClasses: []});
  const at = iso(occurredAt);
  const identity = {accountId: account, conversationId: conversation, priorVectorHash: previous.vectorHash, currentVectorHash: current.vectorHash, changedClasses: changed};
  return freeze({event: {contractVersion: V3_INVALIDATION_EVENT_CONTRACT_VERSION, schemaVersion: 1, authority: 'HOST_DERIVED_NON_AUTHORITATIVE', eventId: `${V3_INVALIDATION_EVENT_CONTRACT_VERSION}:event:${canonicalSha256(identity)}`, ...identity, occurredAt: at}, stale: true, changedClasses: changed});
}

/** Rebuilds current facts from canonical Host-owned state. This is the durable projection boundary. */
export function projectV3InvalidationEventFromDatabase(db: Database.Database, previousInput: unknown, currentInput: Omit<V3FreshnessVectorInput, 'authoritativeV2FreshnessFingerprint'>, occurredAt: string): V3InvalidationProjection {
  const previous = validateV3FreshnessVector(previousInput);
  const current = buildV3FreshnessVectorFromDatabase(db, currentInput);
  return projectV3InvalidationEvent(previous, current, current.dependencies.identityScope.accountId, current.dependencies.identityScope.conversationId, occurredAt);
}

/** Fail-closed revalidation for a plan/lease with no inbound message required. */
export function assertV3PlanContextCurrent(db: Database.Database, leaseInput: unknown, bundleInput: unknown, contextInput: unknown, previousVectorInput: unknown, currentInput: Omit<V3FreshnessVectorInput, 'authoritativeV2FreshnessFingerprint'>, now: string): V3InvalidationProjection {
  const bundle = validateInboundBundle(bundleInput), context = validateContextSnapshot(contextInput), previous = validateV3FreshnessVector(previousVectorInput);
  if (context.sourceRevisionRefs.accountId !== bundle.accountId || context.sourceRevisionRefs.conversationId !== bundle.conversationId) fail('CONTEXT_SCOPE');
  if (!isCurrentReasoningLease(db, leaseInput, bundle, context, now)) fail('LEASE_NOT_CURRENT');
  const projection = projectV3InvalidationEventFromDatabase(db, previous, currentInput, now);
  if (projection.stale) fail('STALE_CONTEXT');
  return projection;
}

export function validateV3InvalidationEvent(value: unknown): V3InvalidationEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SHAPE');
  const item = value as Record<string, unknown>;
  const required = ['contractVersion','schemaVersion','authority','eventId','accountId','conversationId','priorVectorHash','currentVectorHash','changedClasses','occurredAt'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== required.length || Object.keys(descriptors).sort().join('|') !== required.slice().sort().join('|') || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) fail('SHAPE');
  if (item.contractVersion !== V3_INVALIDATION_EVENT_CONTRACT_VERSION || item.schemaVersion !== 1 || item.authority !== 'HOST_DERIVED_NON_AUTHORITATIVE') fail('VERSION_OR_AUTHORITY');
  text(item.eventId, 'EVENT_ID'); text(item.accountId, 'ACCOUNT_ID'); text(item.conversationId, 'CONVERSATION_ID'); text(item.priorVectorHash, 'PRIOR_HASH', 128); text(item.currentVectorHash, 'CURRENT_HASH', 128); iso(item.occurredAt);
  const changed = classes(item.changedClasses as string[]); if (changed.length === 0) fail('CLASS');
  const identity = {accountId: item.accountId, conversationId: item.conversationId, priorVectorHash: item.priorVectorHash, currentVectorHash: item.currentVectorHash, changedClasses: changed};
  if (item.eventId !== `${V3_INVALIDATION_EVENT_CONTRACT_VERSION}:event:${canonicalSha256(identity)}`) fail('EVENT_ID');
  return freeze({...item, changedClasses: changed} as unknown as V3InvalidationEvent);
}
