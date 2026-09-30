import {canonicalSha256} from './v2-canonical.js';

/** RET-007: disposable, Host-owned retention/access projection for shadow-only use. */
export const V3_RETENTION_ACCESS_CONTRACT_VERSION = 'V3-RET-007';
export const V3_RETENTION_ACCESS_SCHEMA_VERSION = 1;
export const V3_RETENTION_ACCESS_STATES = ['ACTIVE', 'DELETED', 'EXPIRED', 'REVOKED'] as const;
export type V3RetentionAccessState = typeof V3_RETENTION_ACCESS_STATES[number];
export type V3RetentionAccessProjectionInput = Readonly<{
  accountId: string;
  conversationId: string;
  version: number;
  sources: readonly Readonly<{sourceId: string; state: V3RetentionAccessState; available: boolean}>[];
}>;
export type V3RetentionAccessProjection = Readonly<V3RetentionAccessProjectionInput & {
  contractVersion: typeof V3_RETENTION_ACCESS_CONTRACT_VERSION;
  schemaVersion: 1;
  authority: 'HOST_OWNED_SHADOW_ONLY';
  projectionHash: string;
}>;
export type V3DerivedRetentionArtifact = Readonly<{
  kind: 'CONVERSATION_MEMORY' | 'RETRIEVAL_INDEX';
  accountId: string;
  conversationId: string;
  retentionAccessVersion: number;
  sourceMessageIds: readonly string[];
  sourceSetHash: string;
}>;
export type V3RetentionAccessEvidence = Readonly<{
  contractVersion: typeof V3_RETENTION_ACCESS_CONTRACT_VERSION;
  status: 'USABLE' | 'REBUILD_REQUIRED';
  accountId: string;
  conversationId: string;
  retentionAccessVersion: number;
  sourceCount: number;
  activeSourceCount: number;
  affectedSourceCount: number;
  reasonCodes: readonly string[];
  sourceSetHash: string;
  projectionHash: string;
}>;

function fail(code: string): never { throw new Error(`V3_RETENTION_ACCESS_INVALID:${code}`); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); }
  return value;
}
function plain(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('PLAIN_JSON'); return value; }
  if (typeof value !== 'object' || seen.has(value)) fail('PLAIN_JSON');
  seen.add(value);
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if ((array && proto !== Array.prototype) || (!array && proto !== Object.prototype)) fail('PLAIN_JSON');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) if (!('value' in descriptor)) fail('ACCESSOR');
  if (array) {
    const length = descriptors.length?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || Object.keys(value).length !== length) fail('PLAIN_JSON');
    const result: unknown[] = new Array(length);
    for (const key of Object.keys(value)) { if (key === 'length') continue; if (!/^\d+$/.test(key) || Number(key) >= length) fail('PLAIN_JSON'); result[Number(key)] = plain(descriptors[key].value, seen); }
    seen.delete(value); return result;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) { if (descriptors[key].value === undefined) fail('PLAIN_JSON'); result[key] = plain(descriptors[key].value, seen); }
  seen.delete(value); return result;
}
function exact(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${code}_SHAPE`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) fail(`${code}_FIELDS`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) { const descriptor = descriptors[key]; if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(`${code}_ACCESSOR`); }
  return value as Record<string, unknown>;
}
function text(value: unknown, code: string): string { if (typeof value !== 'string' || value.trim() === '' || value.length > 256) fail(code); return value; }
function version(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('VERSION'); return value; }
function sourceSetHash(accountId: string, conversationId: string, sourceMessageIds: readonly string[]): string { return canonicalSha256({accountId, conversationId, sourceMessageIds}); }
function sourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) fail('SOURCE_IDS');
  const ids = value.map((id) => text(id, 'SOURCE_ID'));
  if (new Set(ids).size !== ids.length) fail('SOURCE_IDS_DUPLICATE');
  return ids;
}
function sourceProjection(value: unknown): V3RetentionAccessProjectionInput {
  plain(value);
  const item = exact(value, ['accountId', 'conversationId', 'version', 'sources'], 'PROJECTION');
  const sourcesValue = item.sources;
  if (!Array.isArray(sourcesValue)) fail('SOURCES');
  const sources = sourcesValue.map((raw) => {
    const source = exact(raw, ['sourceId', 'state', 'available'], 'SOURCE');
    const state = source.state;
    if (typeof state !== 'string' || !(V3_RETENTION_ACCESS_STATES as readonly string[]).includes(state)) fail('SOURCE_STATE');
    if (typeof source.available !== 'boolean') fail('SOURCE_AVAILABILITY');
    return {sourceId: text(source.sourceId, 'SOURCE_ID'), state: state as V3RetentionAccessState, available: source.available};
  });
  if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) fail('SOURCE_ID_DUPLICATE');
  return {accountId: text(item.accountId, 'ACCOUNT_ID'), conversationId: text(item.conversationId, 'CONVERSATION_ID'), version: version(item.version), sources};
}
function projectionBody(input: V3RetentionAccessProjectionInput) {
  return {contractVersion: V3_RETENTION_ACCESS_CONTRACT_VERSION, schemaVersion: 1, authority: 'HOST_OWNED_SHADOW_ONLY', ...input};
}

/** The only projection constructor. It deliberately accepts no duration, hold, or legal policy fields. */
export function projectV3RetentionAccess(input: V3RetentionAccessProjectionInput): V3RetentionAccessProjection {
  const normalized = sourceProjection(input), body = projectionBody(normalized);
  return freeze({...body, projectionHash: canonicalSha256(body)} as V3RetentionAccessProjection);
}
export function validateV3RetentionAccessProjection(value: unknown): V3RetentionAccessProjection {
  plain(value);
  const item = exact(value, ['contractVersion', 'schemaVersion', 'authority', 'accountId', 'conversationId', 'version', 'sources', 'projectionHash'], 'PROJECTION');
  if (item.contractVersion !== V3_RETENTION_ACCESS_CONTRACT_VERSION || item.schemaVersion !== 1 || item.authority !== 'HOST_OWNED_SHADOW_ONLY' || typeof item.projectionHash !== 'string') fail('CONTRACT');
  const normalized = sourceProjection({accountId: item.accountId, conversationId: item.conversationId, version: item.version, sources: item.sources});
  if (item.projectionHash !== canonicalSha256(projectionBody(normalized))) fail('INTEGRITY');
  return projectV3RetentionAccess(normalized);
}

function artifact(value: unknown): V3DerivedRetentionArtifact {
  plain(value);
  const item = exact(value, ['kind', 'accountId', 'conversationId', 'retentionAccessVersion', 'sourceMessageIds', 'sourceSetHash'], 'ARTIFACT');
  if (item.kind !== 'CONVERSATION_MEMORY' && item.kind !== 'RETRIEVAL_INDEX') fail('ARTIFACT_KIND');
  const accountId = text(item.accountId, 'ACCOUNT_ID'), conversationId = text(item.conversationId, 'CONVERSATION_ID'), retentionAccessVersion = version(item.retentionAccessVersion), sourceMessageIds = sourceIds(item.sourceMessageIds);
  if (item.sourceSetHash !== sourceSetHash(accountId, conversationId, sourceMessageIds)) fail('SOURCE_SET_HASH');
  return {kind: item.kind, accountId, conversationId, retentionAccessVersion, sourceMessageIds, sourceSetHash: item.sourceSetHash as string};
}

/** Content-minimized usability decision; it never returns source content or canonical ERP records. */
export function evaluateV3DerivedRetentionAccess(projectionInput: unknown, artifactInput: unknown): V3RetentionAccessEvidence {
  const projection = validateV3RetentionAccessProjection(projectionInput), derived = artifact(artifactInput);
  const reasons: string[] = [], sourceMap = new Map(projection.sources.map((source) => [source.sourceId, source]));
  if (derived.accountId !== projection.accountId || derived.conversationId !== projection.conversationId) reasons.push('SCOPE_MISMATCH');
  if (derived.retentionAccessVersion !== projection.version) reasons.push('RETENTION_ACCESS_VERSION_STALE');
  const affected = derived.sourceMessageIds.filter((id) => { const source = sourceMap.get(id); return !source || source.state !== 'ACTIVE' || !source.available; });
  if (affected.length > 0) reasons.push(...affected.map((id) => { const source = sourceMap.get(id); return !source ? 'SOURCE_NOT_PROJECTED' : source.available ? `SOURCE_${source.state}` : 'SOURCE_UNAVAILABLE'; }));
  const uniqueReasons = [...new Set(reasons)].sort();
  return freeze({contractVersion: V3_RETENTION_ACCESS_CONTRACT_VERSION, status: uniqueReasons.length === 0 ? 'USABLE' : 'REBUILD_REQUIRED', accountId: projection.accountId, conversationId: projection.conversationId, retentionAccessVersion: projection.version, sourceCount: derived.sourceMessageIds.length, activeSourceCount: derived.sourceMessageIds.filter((id) => sourceMap.get(id)?.state === 'ACTIVE' && sourceMap.get(id)?.available === true).length, affectedSourceCount: affected.length, reasonCodes: uniqueReasons, sourceSetHash: derived.sourceSetHash, projectionHash: projection.projectionHash});
}

/** Rebuild ordering fence: a new artifact can be bound only after the current projection validates and passes. */
export function bindV3DerivedRetentionArtifact(projectionInput: unknown, artifactInput: unknown): V3DerivedRetentionArtifact {
  const projection = validateV3RetentionAccessProjection(projectionInput), derived = artifact(artifactInput), evidence = evaluateV3DerivedRetentionAccess(projection, derived);
  if (evidence.status !== 'USABLE') fail('REBUILD_REQUIRED');
  return freeze({...derived, retentionAccessVersion: projection.version, sourceSetHash: sourceSetHash(projection.accountId, projection.conversationId, derived.sourceMessageIds)});
}
