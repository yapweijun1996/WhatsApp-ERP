import type Database from 'better-sqlite3';
import {canonicalJson, canonicalSha256} from './v2-canonical.js';

export const V3_INBOUND_BUNDLE_CONTRACT_VERSION = 'V3-CP-001';
export const V3_INBOUND_BUNDLE_SCHEMA_VERSION = 1;

export const INBOUND_BUNDLE_CLOSE_REASONS = ['QUIET_WINDOW', 'HARD_CAP', 'CHANNEL_SEMANTICS', 'MANUAL', 'REPLAY'] as const;
export type InboundBundleCloseReason = typeof INBOUND_BUNDLE_CLOSE_REASONS[number];
export const INBOUND_BUNDLE_PROCESSING_STATES = ['CLOSED', 'PROCESSING', 'COMPLETED', 'SUPERSEDED'] as const;
export type InboundBundleProcessingState = typeof INBOUND_BUNDLE_PROCESSING_STATES[number];

export type InboundBundle = Readonly<{
  contractVersion: typeof V3_INBOUND_BUNDLE_CONTRACT_VERSION;
  schemaVersion: 1;
  bundleId: string;
  replayIdentity: string;
  accountId: string;
  conversationId: string;
  conversationRevisionAtBuild: number;
  bundleRevision: number;
  messageIds: readonly string[];
  firstOccurredAt: string;
  lastOccurredAt: string;
  hardCapAt: string;
  closedAt: string;
  closeReason: InboundBundleCloseReason;
  processingState: InboundBundleProcessingState;
  authority: 'NON_AUTHORITATIVE_SHADOW';
}>;

type BundleBuildInput = {
  accountId: string;
  conversationId: string;
  messageIds: readonly string[];
  bundleRevision: number;
  hardCapAt: string;
  closedAt: string;
  closeReason: InboundBundleCloseReason;
  processingState?: InboundBundleProcessingState;
};

type MessageRow = { id: string; occurred_at: string; arrival_seq: number };

function fail(code: string): never { throw new Error(`V3_INBOUND_BUNDLE_INVALID:${code}`); }
function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) fail(code);
  return value;
}
function revision(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}
function iso(value: unknown, code: string): string {
  const result = text(value, code);
  if (!Number.isFinite(Date.parse(result))) fail(code);
  return result;
}
function plainMessageIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) fail('MESSAGE_IDS');
  const ids = value.map((id) => text(id, 'MESSAGE_ID'));
  if (new Set(ids).size !== ids.length) fail('DUPLICATE_MESSAGE_ID');
  return ids;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function bundleIdentity(input: Pick<InboundBundle, 'accountId' | 'conversationId' | 'conversationRevisionAtBuild' | 'bundleRevision' | 'messageIds'>): string {
  return `${V3_INBOUND_BUNDLE_CONTRACT_VERSION}:replay:${canonicalSha256({accountId: input.accountId, conversationId: input.conversationId, conversationRevisionAtBuild: input.conversationRevisionAtBuild, bundleRevision: input.bundleRevision, messageIds: input.messageIds})}`;
}

/**
 * Builds a detached shadow projection from the existing durable V2 queue.
 * V2 arrival_seq remains the sole ingress chronology and dedupe authority.
 */
export function buildInboundBundle(db: Database.Database, input: BundleBuildInput): InboundBundle {
  const accountId = text(input.accountId, 'ACCOUNT_ID');
  const conversationId = text(input.conversationId, 'CONVERSATION_ID');
  const messageIds = plainMessageIds(input.messageIds);
  const bundleRevision = revision(input.bundleRevision, 'BUNDLE_REVISION');
  const hardCapAt = iso(input.hardCapAt, 'HARD_CAP_AT');
  const closedAt = iso(input.closedAt, 'CLOSED_AT');
  if (!(INBOUND_BUNDLE_CLOSE_REASONS as readonly string[]).includes(input.closeReason)) fail('CLOSE_REASON');
  const processingState = input.processingState ?? 'CLOSED';
  if (!(INBOUND_BUNDLE_PROCESSING_STATES as readonly string[]).includes(processingState)) fail('PROCESSING_STATE');

  const state = db.prepare('SELECT revision FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?').get(accountId, conversationId) as {revision: number} | undefined;
  if (!state) fail('CONVERSATION_SCOPE');
  const rows = db.prepare(`SELECT m.id,m.occurred_at,i.arrival_seq FROM v2_inbox_items i JOIN messages m ON m.id=i.message_id WHERE i.account_id=? AND i.conversation_id=? AND m.id IN (${messageIds.map(() => '?').join(',')}) ORDER BY i.arrival_seq`).all(accountId, conversationId, ...messageIds) as MessageRow[];
  if (rows.length !== messageIds.length) fail('MESSAGE_REF_SCOPE');
  const byId = new Map(rows.map((row) => [row.id, row]));
  const orderedRows = messageIds.map((id) => {
    const row = byId.get(id);
    if (!row) fail('MESSAGE_REF_SCOPE');
    return row;
  });
  if (orderedRows.some((row, index) => index > 0 && row.arrival_seq <= orderedRows[index - 1].arrival_seq)) fail('MESSAGE_ORDER');
  const conversationRevisionAtBuild = revision(state.revision, 'CONVERSATION_REVISION');
  const base = {
    contractVersion: V3_INBOUND_BUNDLE_CONTRACT_VERSION as typeof V3_INBOUND_BUNDLE_CONTRACT_VERSION,
    schemaVersion: 1 as const,
    accountId,
    conversationId,
    conversationRevisionAtBuild,
    bundleRevision,
    messageIds: [...messageIds],
  };
  const replayIdentity = bundleIdentity(base);
  const bundleId = `${V3_INBOUND_BUNDLE_CONTRACT_VERSION}:bundle:${canonicalSha256({replayIdentity})}`;
  return freeze({
    ...base,
    bundleId,
    replayIdentity,
    firstOccurredAt: iso(orderedRows[0].occurred_at, 'FIRST_OCCURRED_AT'),
    lastOccurredAt: iso(orderedRows[orderedRows.length - 1].occurred_at, 'LAST_OCCURRED_AT'),
    hardCapAt,
    closedAt,
    closeReason: input.closeReason,
    processingState,
    authority: 'NON_AUTHORITATIVE_SHADOW' as const,
  });
}

export function validateInboundBundle(value: unknown): InboundBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype) fail('SHAPE');
  const source = value as Record<string, unknown>;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key=>typeof key!=='string') || Object.values(descriptors).some(descriptor=>!('value' in descriptor))) fail('SHAPE');
  const required = ['contractVersion', 'schemaVersion', 'bundleId', 'replayIdentity', 'accountId', 'conversationId', 'conversationRevisionAtBuild', 'bundleRevision', 'messageIds', 'firstOccurredAt', 'lastOccurredAt', 'hardCapAt', 'closedAt', 'closeReason', 'processingState', 'authority'];
  if (Object.keys(source).sort().join('|') !== required.slice().sort().join('|')) fail('SHAPE');
  if (source.contractVersion !== V3_INBOUND_BUNDLE_CONTRACT_VERSION || source.schemaVersion !== 1 || source.authority !== 'NON_AUTHORITATIVE_SHADOW') fail('VERSION_OR_AUTHORITY');
  const messageIds = plainMessageIds(source.messageIds);
  const candidate = {
    contractVersion: V3_INBOUND_BUNDLE_CONTRACT_VERSION as typeof V3_INBOUND_BUNDLE_CONTRACT_VERSION,
    schemaVersion: 1 as const,
    bundleId: text(source.bundleId, 'BUNDLE_ID'), replayIdentity: text(source.replayIdentity, 'REPLAY_IDENTITY'),
    accountId: text(source.accountId, 'ACCOUNT_ID'), conversationId: text(source.conversationId, 'CONVERSATION_ID'),
    conversationRevisionAtBuild: revision(source.conversationRevisionAtBuild, 'CONVERSATION_REVISION'), bundleRevision: revision(source.bundleRevision, 'BUNDLE_REVISION'), messageIds,
    firstOccurredAt: iso(source.firstOccurredAt, 'FIRST_OCCURRED_AT'), lastOccurredAt: iso(source.lastOccurredAt, 'LAST_OCCURRED_AT'), hardCapAt: iso(source.hardCapAt, 'HARD_CAP_AT'), closedAt: iso(source.closedAt, 'CLOSED_AT'),
    closeReason: source.closeReason as InboundBundleCloseReason, processingState: source.processingState as InboundBundleProcessingState, authority: 'NON_AUTHORITATIVE_SHADOW' as const,
  };
  if (!(INBOUND_BUNDLE_CLOSE_REASONS as readonly string[]).includes(candidate.closeReason)) fail('CLOSE_REASON');
  if (!(INBOUND_BUNDLE_PROCESSING_STATES as readonly string[]).includes(candidate.processingState)) fail('PROCESSING_STATE');
  if (bundleIdentity(candidate) !== candidate.replayIdentity) fail('REPLAY_IDENTITY');
  if (candidate.bundleId !== `${V3_INBOUND_BUNDLE_CONTRACT_VERSION}:bundle:${canonicalSha256({replayIdentity: candidate.replayIdentity})}`) fail('BUNDLE_ID');
  return freeze(candidate);
}

export function replayInboundBundle(value: unknown): InboundBundle { return validateInboundBundle(structuredClone(value)); }

export function assertInboundBundleRevisionProgression(previous: InboundBundle, next: InboundBundle): void {
  const prior = validateInboundBundle(previous); const candidate = validateInboundBundle(next);
  if (prior.accountId !== candidate.accountId || prior.conversationId !== candidate.conversationId) fail('REVISION_SCOPE');
  if (candidate.conversationRevisionAtBuild < prior.conversationRevisionAtBuild) fail('CONVERSATION_REVISION_REGRESSION');
  if (candidate.bundleRevision < prior.bundleRevision) fail('BUNDLE_REVISION_REGRESSION');
  if (candidate.conversationRevisionAtBuild === prior.conversationRevisionAtBuild && candidate.bundleRevision === prior.bundleRevision) fail('REVISION_NOT_ADVANCED');
}

export function inboundBundleCanonicalJson(bundle: InboundBundle): string { return canonicalJson(validateInboundBundle(bundle)); }

export const V3_ADAPTIVE_BUNDLING_CONTRACT_VERSION = 'V3-CP-002';
export const DEFAULT_ADAPTIVE_BUNDLING_CONFIG = Object.freeze({
  minQuietWindowMs: 800,
  maxQuietWindowMs: 1_500,
  hardCapMs: 3_000,
});

export type AdaptiveBundlingConfig = Readonly<{
  minQuietWindowMs: number;
  maxQuietWindowMs: number;
  hardCapMs: number;
}>;

/** Only channel/arrival metadata is accepted here. Customer text is deliberately not part of this type. */
export type AdaptiveArrival = Readonly<{
  messageId: string;
  arrivalSeq: number;
  arrivedAt: string;
}>;

export type AdaptiveBundleProjection = Readonly<{
  contractVersion: typeof V3_ADAPTIVE_BUNDLING_CONTRACT_VERSION;
  bundleRevision: number;
  messageIds: readonly string[];
  firstArrivedAt: string;
  lastArrivedAt: string;
  hardCapAt: string;
  quietWindowMs: number;
  closeAt: string;
  closeReason: 'QUIET_WINDOW' | 'HARD_CAP';
  nextCollectionBoundary: 'QUIET_WINDOW' | 'HARD_CAP' | 'SIDE_EFFECT_STARTED' | null;
  authority: 'NON_AUTHORITATIVE_SHADOW';
}>;

export type AdaptiveReceiptScope = Readonly<{
  accountId: string;
  conversationId: string;
}>;

function boundedInteger(value: unknown, code: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(code);
  return Number(value);
}

function adaptiveConfig(input?: Partial<AdaptiveBundlingConfig>): AdaptiveBundlingConfig {
  const config = {...DEFAULT_ADAPTIVE_BUNDLING_CONFIG, ...(input ?? {})};
  const minQuietWindowMs = boundedInteger(config.minQuietWindowMs, 'QUIET_WINDOW_BOUNDS', 1, 60_000);
  const maxQuietWindowMs = boundedInteger(config.maxQuietWindowMs, 'QUIET_WINDOW_BOUNDS', minQuietWindowMs, 60_000);
  const hardCapMs = boundedInteger(config.hardCapMs, 'HARD_CAP_BOUNDS', maxQuietWindowMs, 300_000);
  return Object.freeze({minQuietWindowMs, maxQuietWindowMs, hardCapMs});
}

function adaptiveArrivals(input: readonly AdaptiveArrival[]): AdaptiveArrival[] {
  if (!Array.isArray(input) || input.length === 0) fail('ARRIVALS');
  const result = input.map((value) => {
    if (!value || typeof value !== 'object') fail('ARRIVAL');
    return Object.freeze({
      messageId: text(value.messageId, 'MESSAGE_ID'),
      arrivalSeq: boundedInteger(value.arrivalSeq, 'ARRIVAL_SEQ', 1, Number.MAX_SAFE_INTEGER),
      arrivedAt: iso(value.arrivedAt, 'ARRIVED_AT'),
    });
  });
  const ids = new Set<string>();
  for (let index = 0; index < result.length; index += 1) {
    const current = result[index];
    if (ids.has(current.messageId)) fail('DUPLICATE_MESSAGE_ID');
    ids.add(current.messageId);
    if (index > 0 && (current.arrivalSeq <= result[index - 1].arrivalSeq || Date.parse(current.arrivedAt) < Date.parse(result[index - 1].arrivedAt))) fail('ARRIVAL_ORDER');
  }
  return result;
}

function adaptiveQuietWindowMs(config: AdaptiveBundlingConfig, previousGapMs: number | null): number {
  // Arrival behavior only: a larger observed gap permits a larger bounded quiet window.
  const gap = Math.max(0, previousGapMs ?? 0);
  return Math.min(config.maxQuietWindowMs, config.minQuietWindowMs + gap);
}

/**
 * Reads only durable Host receipt timing from the existing V2 queue membership.
 * Provider `messages.occurred_at` is intentionally not selected; V2 arrival_seq
 * and v2_inbox_items.created_at remain the existing receipt/dedupe authority.
 */
export function readAdaptiveArrivalsFromV2Receipts(
  db: Database.Database,
  scope: AdaptiveReceiptScope,
  messageIds?: readonly string[],
): readonly AdaptiveArrival[] {
  const accountId = text(scope.accountId, 'ACCOUNT_ID');
  const conversationId = text(scope.conversationId, 'CONVERSATION_ID');
  const ids = messageIds === undefined ? undefined : plainMessageIds(messageIds);
  const filter = ids === undefined ? '' : ` AND i.message_id IN (${ids.map(() => '?').join(',')})`;
  const rows = db.prepare(`SELECT i.message_id AS messageId,i.arrival_seq AS arrivalSeq,i.created_at AS arrivedAt
    FROM v2_inbox_items i WHERE i.account_id=? AND i.conversation_id=?${filter} ORDER BY i.arrival_seq`)
    .all(accountId, conversationId, ...(ids ?? [])) as AdaptiveArrival[];
  if (ids !== undefined && rows.length !== ids.length) fail('MESSAGE_REF_SCOPE');
  return Object.freeze(adaptiveArrivals(rows.map((row) => ({
    messageId: text(row.messageId, 'MESSAGE_ID'),
    arrivalSeq: boundedInteger(row.arrivalSeq, 'ARRIVAL_SEQ', 1, Number.MAX_SAFE_INTEGER),
    arrivedAt: iso(row.arrivedAt, 'ARRIVED_AT'),
  }))));
}

/**
 * Pure CP-002 shadow projection. The caller must provide the existing V2 arrival_seq order;
 * this function does not deduplicate, reorder, inspect, or classify customer content.
 */
export function projectAdaptiveInboundBundles(
  arrivals: readonly AdaptiveArrival[],
  inputConfig?: Partial<AdaptiveBundlingConfig>,
  sideEffectStartedAtArrivalSeq?: number,
): readonly AdaptiveBundleProjection[] {
  const config = adaptiveConfig(inputConfig);
  const ordered = adaptiveArrivals(arrivals);
  if (sideEffectStartedAtArrivalSeq !== undefined) boundedInteger(sideEffectStartedAtArrivalSeq, 'SIDE_EFFECT_BOUNDARY', 1, Number.MAX_SAFE_INTEGER);
  const projections: AdaptiveBundleProjection[] = [];
  let start = 0;
  while (start < ordered.length) {
    const first = ordered[start];
    const hardCapAtMs = Date.parse(first.arrivedAt) + config.hardCapMs;
    let end = start;
    let closeReason: 'QUIET_WINDOW' | 'HARD_CAP' = 'QUIET_WINDOW';
    let quietWindowMs = adaptiveQuietWindowMs(config, null);
    while (end + 1 < ordered.length) {
      const next = ordered[end + 1];
      if (sideEffectStartedAtArrivalSeq !== undefined && first.arrivalSeq <= sideEffectStartedAtArrivalSeq && next.arrivalSeq > sideEffectStartedAtArrivalSeq) break;
      // Decide using only history already accepted into this bundle. A
      // prospective gap may tune the next window only after acceptance.
      const quietCloseAtMs = Date.parse(ordered[end].arrivedAt) + quietWindowMs;
      // The current accepted history owns both deadlines. The earliest one
      // decides admission; hard-cap wins ties because equality closes.
      const boundaryAtMs = Math.min(quietCloseAtMs, hardCapAtMs);
      if (Date.parse(next.arrivedAt) >= boundaryAtMs) {
        closeReason = quietCloseAtMs >= hardCapAtMs ? 'HARD_CAP' : 'QUIET_WINDOW';
        break;
      }
      const gapMs = Date.parse(next.arrivedAt) - Date.parse(ordered[end].arrivedAt);
      end += 1;
      quietWindowMs = adaptiveQuietWindowMs(config, gapMs);
    }
    const last = ordered[end];
    const quietCloseAtMs = Date.parse(last.arrivedAt) + quietWindowMs;
    const closeAtMs = Math.min(hardCapAtMs, quietCloseAtMs);
    closeReason = quietCloseAtMs >= hardCapAtMs ? 'HARD_CAP' : 'QUIET_WINDOW';
    const boundary = sideEffectStartedAtArrivalSeq !== undefined && end + 1 < ordered.length && ordered[end + 1].arrivalSeq > sideEffectStartedAtArrivalSeq
      ? 'SIDE_EFFECT_STARTED'
      : closeReason;
    projections.push(Object.freeze({
      contractVersion: V3_ADAPTIVE_BUNDLING_CONTRACT_VERSION,
      // Each collected bubble advances this shadow bundle revision; a new collection starts at 1.
      bundleRevision: end - start + 1,
      messageIds: Object.freeze(ordered.slice(start, end + 1).map((message) => message.messageId)),
      firstArrivedAt: first.arrivedAt,
      lastArrivedAt: last.arrivedAt,
      hardCapAt: new Date(hardCapAtMs).toISOString(),
      quietWindowMs,
      closeAt: new Date(closeAtMs).toISOString(),
      closeReason,
      nextCollectionBoundary: boundary,
      authority: 'NON_AUTHORITATIVE_SHADOW',
    }));
    start = end + 1;
  }
  return Object.freeze(projections);
}
