import type Database from 'better-sqlite3';
import {canonicalSha256} from './v2-canonical.js';
import {validateContextSnapshot, type ContextSnapshot} from './v3-context-snapshot.js';
import {validateInboundBundle, type InboundBundle} from './v3-inbound-bundle.js';

export const V3_REASONING_LEASE_CONTRACT_VERSION = 'V3-CP-003';
export const V3_REASONING_LEASE_SCHEMA_VERSION = 1;
export const REASONING_LEASE_STATES = ['ACTIVE', 'EXPIRED', 'SUPERSEDED', 'RELEASED'] as const;
export type ReasoningLeaseState = typeof REASONING_LEASE_STATES[number];

export type ActiveReasoningLease = Readonly<{
  contractVersion: typeof V3_REASONING_LEASE_CONTRACT_VERSION;
  schemaVersion: 1;
  authority: 'NON_AUTHORITATIVE_SHADOW';
  leaseId: string;
  accountId: string;
  conversationId: string;
  bundleId: string;
  conversationRevision: number;
  bundleRevision: number;
  contextSnapshotVersion: string;
  ownerId: string | null;
  fencingToken: string | null;
  generation: number;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  state: ReasoningLeaseState;
  queueItemId: string | null;
  queueArrivalSeq: number | null;
}>;

type QueueStateRow = {
  account_id: string;
  conversation_id: string;
  revision: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_item_id: string | null;
  lease_arrival_seq: number | null;
  lease_generation: number;
  lease_expires_at: string | null;
  lease_heartbeat_at: string | null;
};
type QueueItemRow = {id: string; message_id: string; arrival_seq: number; state: string; updated_at: string};

function fail(code: string): never { throw new Error(`V3_REASONING_LEASE_INVALID:${code}`); }
function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) fail(code);
  return value;
}
function nowIso(value: unknown): string {
  const result = text(value, 'NOW');
  if (!Number.isFinite(Date.parse(result))) fail('NOW');
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function binding(bundle: InboundBundle, context: ContextSnapshot, generation: number): string {
  return `${V3_REASONING_LEASE_CONTRACT_VERSION}:lease:${canonicalSha256({
    accountId: bundle.accountId,
    conversationId: bundle.conversationId,
    bundleId: bundle.bundleId,
    conversationRevision: bundle.conversationRevisionAtBuild,
    bundleRevision: bundle.bundleRevision,
    contextSnapshotVersion: context.contextSnapshotVersion,
    generation,
  })}`;
}

function validateBinding(db: Database.Database, bundleInput: unknown, contextInput: unknown): {bundle: InboundBundle; context: ContextSnapshot} {
  const bundle = validateInboundBundle(bundleInput);
  const context = validateContextSnapshot(contextInput);
  if (context.sourceRevisionRefs.accountId !== bundle.accountId || context.sourceRevisionRefs.conversationId !== bundle.conversationId) fail('SCOPE_MISMATCH');
  const state = db.prepare('SELECT 1 FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?').get(bundle.accountId, bundle.conversationId);
  if (!state) fail('CONVERSATION_SCOPE');
  const rows = db.prepare(`SELECT i.id,i.message_id,i.arrival_seq,i.state,i.updated_at
    FROM v2_inbox_items i WHERE i.account_id=? AND i.conversation_id=? AND i.message_id IN (${bundle.messageIds.map(() => '?').join(',')})
    ORDER BY i.arrival_seq`).all(bundle.accountId, bundle.conversationId, ...bundle.messageIds) as QueueItemRow[];
  if (rows.length !== bundle.messageIds.length || rows.some((row, index) => row.message_id !== bundle.messageIds[index])) fail('BUNDLE_MESSAGE_SCOPE');
  if (context.sourceRevisionRefs.inboundMessageId !== bundle.messageIds[bundle.messageIds.length - 1]) fail('STALE_CONTEXT');
  return {bundle, context};
}

/**
 * Read-only CP-003 projection. V2 remains the only durable lease authority;
 * this function never claims, heartbeats, completes, supersedes, or releases.
 */
export function projectReasoningLease(db: Database.Database, bundleInput: unknown, contextInput: unknown, now: string): ActiveReasoningLease {
  const {bundle, context} = validateBinding(db, bundleInput, contextInput);
  const instant = nowIso(now);
  const state = db.prepare('SELECT account_id,conversation_id,revision,lease_owner,lease_token,lease_item_id,lease_arrival_seq,lease_generation,lease_expires_at,lease_heartbeat_at FROM v2_conversation_inbox WHERE account_id=? AND conversation_id=?').get(bundle.accountId, bundle.conversationId) as QueueStateRow | undefined;
  if (!state) fail('CONVERSATION_SCOPE');
  const generation = Number(state.lease_generation);
  if (!Number.isSafeInteger(generation) || generation < 0) fail('LEASE_GENERATION');
  const hasLeaseItem = state.lease_item_id !== null;
  const activeFields = [state.lease_owner, state.lease_token, state.lease_arrival_seq, state.lease_expires_at, state.lease_heartbeat_at];
  if (hasLeaseItem) {
    if (state.lease_owner === null || state.lease_token === null || state.lease_arrival_seq === null || state.lease_expires_at === null || state.lease_heartbeat_at === null || generation <= 0) fail('LEASE_COHERENCE');
    text(state.lease_owner, 'LEASE_COHERENCE'); text(state.lease_token, 'LEASE_COHERENCE');
    if (!Number.isSafeInteger(state.lease_arrival_seq) || state.lease_arrival_seq <= 0 || !Number.isFinite(Date.parse(state.lease_expires_at)) || !Number.isFinite(Date.parse(state.lease_heartbeat_at))) fail('LEASE_COHERENCE');
  } else if (activeFields.some((value) => value !== null)) fail('LEASE_COHERENCE');
  const item = state.lease_item_id === null ? undefined : db.prepare('SELECT id,message_id,arrival_seq,state,updated_at FROM v2_inbox_items WHERE id=? AND account_id=? AND conversation_id=?').get(state.lease_item_id, bundle.accountId, bundle.conversationId) as QueueItemRow | undefined;
  const bundleRows = db.prepare(`SELECT id,message_id,arrival_seq,state,updated_at FROM v2_inbox_items WHERE account_id=? AND conversation_id=? AND message_id IN (${bundle.messageIds.map(() => '?').join(',')}) ORDER BY arrival_seq`).all(bundle.accountId, bundle.conversationId, ...bundle.messageIds) as QueueItemRow[];
  if (bundleRows.length !== bundle.messageIds.length || bundleRows.some((row, index) => row.message_id !== bundle.messageIds[index])) fail('BUNDLE_MESSAGE_SCOPE');
  const latest = bundleRows[bundleRows.length - 1];
  if (hasLeaseItem && (!item || !Number.isSafeInteger(item.arrival_seq) || item.arrival_seq <= 0 || item.id !== state.lease_item_id || item.arrival_seq !== state.lease_arrival_seq || item.message_id !== latest.message_id || item.state !== 'PROCESSING')) fail('LEASE_BINDING');
  let leaseState: ReasoningLeaseState = 'RELEASED';
  if (hasLeaseItem) leaseState = Date.parse(state.lease_expires_at!) > Date.parse(instant) ? 'ACTIVE' : 'EXPIRED';
  else if (latest.state === 'SUPERSEDED') leaseState = 'SUPERSEDED';
  else if (latest.state === 'COMPLETED') leaseState = 'RELEASED';
  else fail('UNPROVABLE_STATE');
  // V2 has no immutable acquisition timestamp; updated_at is mutable and is not used here.
  const acquiredAt = null;
  return freeze({
    contractVersion: V3_REASONING_LEASE_CONTRACT_VERSION,
    schemaVersion: V3_REASONING_LEASE_SCHEMA_VERSION,
    authority: 'NON_AUTHORITATIVE_SHADOW',
    leaseId: binding(bundle, context, generation), accountId: bundle.accountId, conversationId: bundle.conversationId,
    bundleId: bundle.bundleId, conversationRevision: bundle.conversationRevisionAtBuild, bundleRevision: bundle.bundleRevision,
    contextSnapshotVersion: context.contextSnapshotVersion, ownerId: state.lease_owner, fencingToken: state.lease_token,
    generation, acquiredAt, heartbeatAt: state.lease_heartbeat_at, expiresAt: state.lease_expires_at,
    state: leaseState, queueItemId: state.lease_item_id, queueArrivalSeq: state.lease_arrival_seq,
  });
}

/** Revalidates a previously projected lease against current V2 state; no mutation authority is granted. */
export function isCurrentReasoningLease(db: Database.Database, expectedInput: unknown, bundleInput: unknown, contextInput: unknown, now: string): boolean {
  const expected = validateExpectedProjection(expectedInput);
  const current = projectReasoningLease(db, bundleInput, contextInput, now);
  return current.state === 'ACTIVE' && expected.leaseId === current.leaseId && expected.ownerId === current.ownerId && expected.fencingToken === current.fencingToken && expected.generation === current.generation;
}

function validateExpectedProjection(value: unknown): ActiveReasoningLease {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('EXPECTED_SHAPE');
  const expectedKeys = ['contractVersion','schemaVersion','authority','leaseId','accountId','conversationId','bundleId','conversationRevision','bundleRevision','contextSnapshotVersion','ownerId','fencingToken','generation','acquiredAt','heartbeatAt','expiresAt','state','queueItemId','queueArrivalSeq'];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== expectedKeys.length || Object.keys(descriptors).sort().join('|') !== expectedKeys.slice().sort().join('|') || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) fail('EXPECTED_SHAPE');
  const source = value as Record<string, unknown>;
  if (source.contractVersion !== V3_REASONING_LEASE_CONTRACT_VERSION || source.schemaVersion !== 1 || source.authority !== 'NON_AUTHORITATIVE_SHADOW') fail('EXPECTED_VERSION');
  for (const key of ['leaseId','accountId','conversationId','bundleId','contextSnapshotVersion']) text(descriptors[key].value, `EXPECTED_${key.toUpperCase()}`);
  for (const key of ['conversationRevision','bundleRevision']) if (typeof descriptors[key].value !== 'number' || !Number.isSafeInteger(descriptors[key].value) || descriptors[key].value <= 0) fail('EXPECTED_NUMBER');
  if (typeof descriptors.generation.value !== 'number' || !Number.isSafeInteger(descriptors.generation.value) || descriptors.generation.value < 0) fail('EXPECTED_NUMBER');
  for (const key of ['ownerId','fencingToken','acquiredAt','heartbeatAt','expiresAt','queueItemId']) if (descriptors[key].value !== null) text(descriptors[key].value, `EXPECTED_${key.toUpperCase()}`);
  if (descriptors.queueArrivalSeq.value !== null && (typeof descriptors.queueArrivalSeq.value !== 'number' || !Number.isSafeInteger(descriptors.queueArrivalSeq.value) || descriptors.queueArrivalSeq.value <= 0)) fail('EXPECTED_QUEUE_ARRIVAL');
  if (descriptors.acquiredAt.value !== null) fail('EXPECTED_ACQUIRED_AT');
  if (!(REASONING_LEASE_STATES as readonly unknown[]).includes(descriptors.state.value)) fail('EXPECTED_STATE');
  return source as ActiveReasoningLease;
}
