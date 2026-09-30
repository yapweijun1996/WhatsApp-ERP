import type Database from 'better-sqlite3';
import {authoritativeFreshnessFingerprint} from './v2-freshness.js';
import {canonicalJson, canonicalSha256} from './v2-canonical.js';

export const V3_FRESHNESS_VECTOR_CONTRACT_VERSION = 'V3-CTX-005';
export const V3_FRESHNESS_VECTOR_SCHEMA_VERSION = 1;

type JsonObject = Record<string, unknown>;
type Ref = Readonly<{id: string; version: string | number}>;
type BusinessRef = Readonly<{id: string; revision: number | string; status: string}>;
type EvidenceRef = Readonly<{sourceId: string; sourceVersion: string | number; kind: string}>;

export type V3FreshnessVectorInput = Readonly<{
  identityScope: Readonly<{accountId: string; conversationId: string; customerId: string | null; channelAccountId: string}>;
  employeeProfile: Ref;
  capabilityPolicy: Readonly<{policyVersion: string | number; availableCapabilities: readonly Ref[]}>;
  workItemOrderDraftRefs: Readonly<{workItem: BusinessRef | null; orderDraft: BusinessRef | null}>;
  canonicalBusiness: Readonly<{
    quotations: readonly BusinessRef[];
    acceptances: readonly BusinessRef[];
    outbound: readonly BusinessRef[];
    salesOrders: readonly BusinessRef[];
  }>;
  relevantErpEvidence: readonly EvidenceRef[];
  goalGraph: Readonly<{version: string | number | null; dependencyRefs: readonly Ref[]}>;
  attachmentExtraction: Readonly<{version: string | number | null; dependencyRefs: readonly Ref[]}>;
  retentionAccess: Readonly<{version: string | number; dependencyRefs: readonly Ref[]}>;
  conversationBundle: Readonly<{conversationRevision: number; bundleRevision: number; messageRefs: readonly Ref[]}>;
  authoritativeV2FreshnessFingerprint: string;
}>;

export type V3FreshnessDependencyVector = Readonly<{
  contractVersion: typeof V3_FRESHNESS_VECTOR_CONTRACT_VERSION;
  schemaVersion: 1;
  authority: 'HOST_DERIVED_NON_AUTHORITATIVE_CONTEXT_INPUT';
  dependencies: Readonly<V3FreshnessVectorInput>;
  dependencyDigests: Readonly<Record<keyof V3FreshnessVectorInput, string>>;
  vectorHash: string;
}>;

function fail(code: string): never { throw new Error(`V3_FRESHNESS_VECTOR_INVALID:${code}`); }

function plain(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('NUMBER'); return value; }
  if (typeof value !== 'object' || seen.has(value)) fail('PLAIN_JSON');
  seen.add(value);
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if ((array && proto !== Array.prototype) || (!array && proto !== Object.prototype && proto !== null)) fail('PLAIN_JSON');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) if (!('value' in descriptor)) fail('ACCESSOR');
  if (array) {
    const length = descriptors.length?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) fail('ARRAY');
    const result: unknown[] = new Array(length);
    for (const key of Object.keys(value)) {
      if (key === 'length' || !/^\d+$/.test(key) || Number(key) >= length) fail('ARRAY');
      result[Number(key)] = plain(descriptors[key].value, seen);
    }
    seen.delete(value); return result;
  }
  const result: JsonObject = {};
  for (const key of Object.keys(value)) {
    if (descriptors[key].value === undefined) fail('UNDEFINED');
    result[key] = plain(descriptors[key].value, seen);
  }
  seen.delete(value); return result;
}

function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) fail(code);
  return value;
}
function scalar(value: unknown, code: string): string | number {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isSafeInteger(value))) fail(code);
  return value;
}
function nullableScalar(value: unknown, code: string): string | number | null {
  return value === null ? null : scalar(value, code);
}
function revision(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}
function ref(value: unknown, code: string): Ref {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const item = value as JsonObject;
  return {id: text(item.id, `${code}_ID`), version: scalar(item.version, `${code}_VERSION`)};
}
function refs(value: unknown, code: string): Ref[] {
  if (!Array.isArray(value)) fail(code);
  return value.map((item) => ref(item, code)).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}
function business(value: unknown, code: string): BusinessRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const item = value as JsonObject;
  return {id: text(item.id, `${code}_ID`), revision: scalar(item.revision, `${code}_REVISION`), status: text(item.status, `${code}_STATUS`)};
}
function businesses(value: unknown, code: string): BusinessRef[] {
  if (!Array.isArray(value)) fail(code);
  return value.map((item) => business(item, code)).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}
function evidence(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value)) fail('ERP_EVIDENCE');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('ERP_EVIDENCE');
    const item = entry as JsonObject;
    return {sourceId: text(item.sourceId, 'ERP_EVIDENCE_SOURCE'), sourceVersion: scalar(item.sourceVersion, 'ERP_EVIDENCE_VERSION'), kind: text(item.kind, 'ERP_EVIDENCE_KIND')};
  }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function normalize(input: unknown): V3FreshnessVectorInput {
  plain(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('SHAPE');
  const source = input as JsonObject;
  const scope = source.identityScope as JsonObject;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) fail('IDENTITY_SCOPE');
  const profile = source.employeeProfile as JsonObject;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail('PROFILE');
  const policy = source.capabilityPolicy as JsonObject;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('CAPABILITY_POLICY');
  const refsInput = source.workItemOrderDraftRefs as JsonObject;
  if (!refsInput || typeof refsInput !== 'object' || Array.isArray(refsInput)) fail('WORKSPACE_REFS');
  const canonical = source.canonicalBusiness as JsonObject;
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) fail('CANONICAL_BUSINESS');
  const goal = source.goalGraph as JsonObject;
  const extraction = source.attachmentExtraction as JsonObject;
  const retention = source.retentionAccess as JsonObject;
  const bundle = source.conversationBundle as JsonObject;
  if (!goal || !extraction || !retention || !bundle) fail('PLACEHOLDER_DEPENDENCY');
  const optionalBusiness = (value: unknown, code: string): BusinessRef | null => value === null ? null : business(value, code);
  return {
    identityScope: {accountId: text(scope.accountId, 'ACCOUNT_ID'), conversationId: text(scope.conversationId, 'CONVERSATION_ID'), customerId: scope.customerId === null ? null : text(scope.customerId, 'CUSTOMER_ID'), channelAccountId: text(scope.channelAccountId, 'CHANNEL_ACCOUNT_ID')},
    employeeProfile: ref(profile, 'PROFILE'),
    capabilityPolicy: {policyVersion: scalar(policy.policyVersion, 'POLICY_VERSION'), availableCapabilities: refs(policy.availableCapabilities, 'CAPABILITIES')},
    workItemOrderDraftRefs: {workItem: optionalBusiness(refsInput.workItem, 'WORK_ITEM'), orderDraft: optionalBusiness(refsInput.orderDraft, 'ORDER_DRAFT')},
    canonicalBusiness: {quotations: businesses(canonical.quotations, 'QUOTATIONS'), acceptances: businesses(canonical.acceptances, 'ACCEPTANCES'), outbound: businesses(canonical.outbound, 'OUTBOUND'), salesOrders: businesses(canonical.salesOrders, 'SALES_ORDERS')},
    relevantErpEvidence: evidence(source.relevantErpEvidence),
    goalGraph: {version: nullableScalar(goal.version, 'GOAL_VERSION'), dependencyRefs: refs(goal.dependencyRefs, 'GOAL_REFS')},
    attachmentExtraction: {version: nullableScalar(extraction.version, 'EXTRACTION_VERSION'), dependencyRefs: refs(extraction.dependencyRefs, 'EXTRACTION_REFS')},
    retentionAccess: {version: scalar(retention.version, 'RETENTION_VERSION'), dependencyRefs: refs(retention.dependencyRefs, 'RETENTION_REFS')},
    conversationBundle: {conversationRevision: revision(bundle.conversationRevision, 'CONVERSATION_REVISION'), bundleRevision: revision(bundle.bundleRevision, 'BUNDLE_REVISION'), messageRefs: refs(bundle.messageRefs, 'MESSAGE_REFS')},
    authoritativeV2FreshnessFingerprint: text(source.authoritativeV2FreshnessFingerprint, 'V2_FRESHNESS_FINGERPRINT'),
  };
}

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value as JsonObject)) frozen(child); Object.freeze(value); }
  return value;
}

export function buildV3FreshnessVector(input: V3FreshnessVectorInput): V3FreshnessDependencyVector {
  const dependencies = normalize(input);
  const keys = Object.keys(dependencies) as (keyof V3FreshnessVectorInput)[];
  const dependencyDigests = Object.fromEntries(keys.map((key) => [key, canonicalSha256(dependencies[key])])) as Record<keyof V3FreshnessVectorInput, string>;
  const unsigned = {contractVersion: V3_FRESHNESS_VECTOR_CONTRACT_VERSION as typeof V3_FRESHNESS_VECTOR_CONTRACT_VERSION, schemaVersion: V3_FRESHNESS_VECTOR_SCHEMA_VERSION as 1, authority: 'HOST_DERIVED_NON_AUTHORITATIVE_CONTEXT_INPUT' as const, dependencies, dependencyDigests};
  return frozen({...unsigned, vectorHash: canonicalSha256(unsigned)});
}

export function validateV3FreshnessVector(value: unknown): V3FreshnessDependencyVector {
  const copy = plain(value) as JsonObject;
  if (!copy || typeof copy !== 'object' || Array.isArray(copy) || copy.contractVersion !== V3_FRESHNESS_VECTOR_CONTRACT_VERSION || copy.schemaVersion !== 1 || copy.authority !== 'HOST_DERIVED_NON_AUTHORITATIVE_CONTEXT_INPUT' || typeof copy.vectorHash !== 'string') fail('VERSION_OR_SHAPE');
  const vector = buildV3FreshnessVector(copy.dependencies as V3FreshnessVectorInput);
  if (canonicalJson(vector.dependencyDigests) !== canonicalJson(copy.dependencyDigests) || vector.vectorHash !== copy.vectorHash) fail('INTEGRITY');
  return vector;
}

export function freshnessVectorChangedClasses(previous: unknown, current: unknown): string[] {
  const oldVector = validateV3FreshnessVector(previous), newVector = validateV3FreshnessVector(current);
  return (Object.keys(oldVector.dependencies) as (keyof V3FreshnessVectorInput)[]).filter((key) => oldVector.dependencyDigests[key] !== newVector.dependencyDigests[key]);
}
export function isV3FreshnessVectorStale(previous: unknown, current: unknown): boolean { return validateV3FreshnessVector(previous).vectorHash !== validateV3FreshnessVector(current).vectorHash; }

/** DB adapter: V2 remains the owner of authoritative ERP freshness facts. */
export function buildV3FreshnessVectorFromDatabase(db: Database.Database, input: Omit<V3FreshnessVectorInput, 'authoritativeV2FreshnessFingerprint'>): V3FreshnessDependencyVector {
  const safe = plain(input) as Omit<V3FreshnessVectorInput, 'authoritativeV2FreshnessFingerprint'>;
  const scope = safe.identityScope, profile = safe.employeeProfile;
  if (!scope || typeof scope !== 'object' || !profile || typeof profile !== 'object') fail('SHAPE');
  const canonical = db.prepare('SELECT channel_account_id, customer_id FROM conversations WHERE id=? AND channel_account_id=?').get(scope.conversationId, scope.accountId) as {channel_account_id:string; customer_id:string|null}|undefined;
  if (!canonical) fail('CONVERSATION_SCOPE');
  if (canonical.channel_account_id !== scope.channelAccountId) fail('CHANNEL_ACCOUNT_MISMATCH');
  if (canonical.customer_id !== scope.customerId) fail('CUSTOMER_MISMATCH');
  const canonicalProfile = db.prepare('SELECT id, version FROM employee_profiles WHERE id=?').get(profile.id) as {id:string; version:number}|undefined;
  if (!canonicalProfile) fail('PROFILE_MISSING');
  if (canonicalProfile.version !== profile.version) fail('PROFILE_VERSION_MISMATCH');
  const fingerprint = authoritativeFreshnessFingerprint(db, scope.accountId, scope.conversationId, profile.id);
  return buildV3FreshnessVector({...safe, authoritativeV2FreshnessFingerprint: fingerprint});
}
