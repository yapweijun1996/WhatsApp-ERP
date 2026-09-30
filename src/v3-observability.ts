import { redactContextText } from './v2-context-projection.js';

export type V3TraceKind = 'bundle' | 'context' | 'goals' | 'retrieval' | 'freshness' | 'lease' | 'admission' | 'effects';
export type V3TraceScope = Readonly<{accountId: string; conversationId: string}>;
export type V3TraceEvent = Readonly<{sequence: number; kind: V3TraceKind; scope: V3TraceScope; at: string; data: Readonly<Record<string, unknown>>}>;

const KINDS = new Set<V3TraceKind>(['bundle', 'context', 'goals', 'retrieval', 'freshness', 'lease', 'admission', 'effects']);
const MAX_EVENTS = 256;
const MAX_REF = 160;
const MAX_LIST = 16;
const CODE = /^[A-Za-z0-9_.:/-]{1,160}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function invalid(code: string): never { throw new Error(`V3_OBS_001_INVALID:${code}`); }
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function safeRef(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_REF) return undefined;
  const redacted = redactContextText(value);
  return CODE.test(redacted) ? redacted : undefined;
}
function safeInt(value: unknown, max = 1_000_000_000): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}
function safeBool(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function safeList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LIST) return undefined;
  const result = value.map(safeRef);
  return result.every((item): item is string => item !== undefined) ? result : undefined;
}
function put(out: Record<string, unknown>, key: string, value: unknown): void { if (value !== undefined) out[key] = value; }
function allow(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (key.endsWith('Count') || key.endsWith('Bytes') || key.endsWith('Revision') || key.endsWith('Budget') || key.endsWith('Tokens') || key === 'depth' || key === 'generation' || key === 'sequence' || key === 'callSequence' || key === 'unitCount' || key === 'attachmentCount') put(out, key, safeInt(value));
    else if (key.startsWith('is') || key.startsWith('has') || key === 'stale' || key === 'sideEffectStarted' || key === 'freshnessCurrent' || key === 'newerInput' || key === 'leaseCurrent' || key === 'noNewEvidence') put(out, key, safeBool(value));
    else if (key === 'changedClasses' || key === 'dependencyClasses') put(out, key, safeList(value));
    else if (key === 'at' || key === 'expiresAt' || key === 'heartbeatAt') put(out, key, typeof value === 'string' && ISO.test(value) ? value : undefined);
    else put(out, key, safeRef(value));
  }
  return out;
}

const FIELDS: Record<V3TraceKind, readonly string[]> = {
  bundle: ['bundleId', 'bundleRevision', 'conversationRevision', 'messageCount', 'closeReason', 'state'],
  context: ['snapshotVersion', 'sourceCount', 'tokenBudget', 'tokenCount', 'stale', 'projectionHash'],
  goals: ['goalCount', 'activeGoalCount', 'terminalGoalCount', 'updateCount'],
  retrieval: ['tool', 'callSequence', 'depth', 'resultClass', 'evidenceCount', 'readBytes', 'candidateItems', 'stopReason', 'noNewEvidence'],
  freshness: ['vectorHash', 'dependencyCount', 'changedClasses', 'stale'],
  lease: ['generation', 'state', 'expiresAt', 'heartbeatAt'],
  admission: ['status', 'effectIdentity', 'reasonCode', 'sideEffectStarted', 'freshnessCurrent', 'newerInput', 'leaseCurrent'],
  effects: ['effectKind', 'effectIdentity', 'status', 'unitCount', 'attachmentCount', 'authorityCutoff'],
};

function scope(value: unknown): V3TraceScope {
  if (!plain(value)) invalid('SCOPE');
  const accountId = safeRef(value.accountId), conversationId = safeRef(value.conversationId);
  if (!accountId || !conversationId) invalid('SCOPE');
  return Object.freeze({accountId, conversationId});
}

export function projectV3Trace(input: unknown): V3TraceEvent {
  if (!plain(input) || !KINDS.has(input.kind as V3TraceKind)) invalid('EVENT');
  if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1) invalid('SEQUENCE');
  if (typeof input.at !== 'string' || !ISO.test(input.at)) invalid('TIME');
  if (!plain(input.data)) invalid('DATA');
  const data = allow(input.data, FIELDS[input.kind as V3TraceKind]);
  return Object.freeze({sequence: input.sequence as number, kind: input.kind as V3TraceKind, scope: scope(input.scope), at: input.at, data: Object.freeze(data)});
}

/** Host-owned, content-free, in-memory trace collector. It grants no capability or effect authority. */
export class V3TraceRecorder {
  private readonly events: V3TraceEvent[] = [];
  record(input: unknown): V3TraceEvent {
    if (this.events.length >= MAX_EVENTS) invalid('EVENT_LIMIT');
    const event = projectV3Trace(input);
    if (event.sequence !== this.events.length + 1) invalid('SEQUENCE');
    this.events.push(event);
    return event;
  }
  snapshot(): readonly V3TraceEvent[] { return Object.freeze(this.events.slice()); }
}

export function projectV3TraceSnapshot(events: readonly unknown[]): readonly V3TraceEvent[] {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) invalid('SNAPSHOT');
  const projected = events.map((event, index) => {
    const item = projectV3Trace(event);
    if (item.sequence !== index + 1) invalid('SEQUENCE');
    return item;
  });
  return Object.freeze(projected);
}

export type V3MetricScope = V3TraceScope;
export type V3MetricInput = Readonly<{
  scope: V3MetricScope;
  clarifications?: readonly Readonly<{requested: boolean; required: boolean}>[];
  promises?: readonly Readonly<{progressDisposition: boolean; continuationValid: boolean}>[];
  historicalRetrieval?: readonly Readonly<{attempted: boolean; succeeded: boolean}>[];
  bundles?: readonly Readonly<{expectedMessageIds: readonly string[]; observedMessageIds: readonly string[]}>[];
  goals?: readonly Readonly<{eligible: boolean; completed: boolean}>[];
  responses?: readonly Readonly<{useful: boolean; grounded: boolean; lastBubbleAt?: string; usefulResponseAt?: string}>[];
  outbound?: readonly Readonly<{attempted: boolean; duplicate: boolean}>[];
  crossScopeViolations?: number;
  retrievalLoops?: readonly number[];
}>;

export type V3MetricProjection = Readonly<{
  scope: V3MetricScope;
  unnecessaryClarification: Readonly<{numerator: number; denominator: number; rate: number}>;
  emptyPromise: Readonly<{numerator: number; denominator: number; rate: number}>;
  historicalRetrievalSuccess: Readonly<{numerator: number; denominator: number; rate: number}>;
  multiBubbleBundleAccuracy: Readonly<{numerator: number; denominator: number; rate: number}>;
  goalCompletion: Readonly<{numerator: number; denominator: number; rate: number}>;
  groundedResponse: Readonly<{numerator: number; denominator: number; rate: number}>;
  duplicateOutbound: Readonly<{numerator: number; denominator: number; rate: number}>;
  crossScopeViolations: number;
  retrievalLoopCount: number;
  lastBubbleToUsefulResponseMs: Readonly<{count: number; total: number; average: number; max: number}>;
}>;

const MAX_METRIC_ROWS = 256;
const METRIC_ID = /^[A-Za-z0-9_.:/-]{1,160}$/;

function metricInvalid(code: string): never { throw new Error(`V3_OBS_002_INVALID:${code}`); }
function metricBool(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') metricInvalid(code);
  return value;
}
function metricRows(value: unknown, code: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_METRIC_ROWS) metricInvalid(code);
  return value.map((row) => {
    if (!plain(row)) metricInvalid(`${code}_ROW`);
    return row;
  });
}
function metricIds(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) metricInvalid(code);
  const ids = value.map((id) => typeof id === 'string' && METRIC_ID.test(id) ? id : undefined);
  if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) metricInvalid(code);
  return ids as string[];
}
function metricScope(value: unknown): V3MetricScope {
  return scope(value);
}
function metricRate(numerator: number, denominator: number): Readonly<{numerator: number; denominator: number; rate: number}> {
  return Object.freeze({numerator, denominator, rate: denominator === 0 ? 0 : numerator / denominator});
}
function exactMembership(expected: readonly string[], observed: readonly string[]): boolean {
  if (expected.length !== observed.length) return false;
  const right = new Set(observed);
  return expected.every((id) => right.has(id));
}
function metricIso(value: unknown, code: string): number {
  if (typeof value !== 'string' || !ISO.test(value)) metricInvalid(code);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) metricInvalid(code);
  return millis;
}

/**
 * Pure OBS-002 aggregation over Host-owned structural fixture facts. It stores
 * no content and grants no capability or execution authority. Every rate has
 * an explicit denominator and is zero when its denominator is zero.
 */
export function projectV3Metrics(input: V3MetricInput): V3MetricProjection {
  if (!plain(input)) metricInvalid('INPUT');
  const expectedScope = metricScope(input.scope);
  const rows = (value: unknown, code: string): readonly Record<string, unknown>[] => metricRows(value ?? [], code);
  const clarifications = rows(input.clarifications, 'CLARIFICATIONS');
  clarifications.forEach((row) => { metricBool(row.requested, 'CLARIFICATION_REQUESTED'); metricBool(row.required, 'CLARIFICATION_REQUIRED'); });
  const unnecessary = clarifications.filter((row) => row.requested === true && row.required === false).length;
  const promises = rows(input.promises, 'PROMISES');
  promises.forEach((row) => { metricBool(row.progressDisposition, 'PROMISE_DISPOSITION'); metricBool(row.continuationValid, 'PROMISE_CONTINUATION'); });
  const empty = promises.filter((row) => row.progressDisposition === true && row.continuationValid === false).length;
  const historical = rows(input.historicalRetrieval, 'HISTORICAL_RETRIEVAL');
  historical.forEach((row) => { metricBool(row.attempted, 'RETRIEVAL_ATTEMPT'); metricBool(row.succeeded, 'RETRIEVAL_SUCCESS'); });
  const attempts = historical.filter((row) => row.attempted === true);
  const successes = attempts.filter((row) => row.succeeded === true).length;
  const bundles = rows(input.bundles, 'BUNDLES');
  const bundleAccurate = bundles.filter((row) => exactMembership(metricIds(row.expectedMessageIds, 'EXPECTED_MESSAGE_IDS'), metricIds(row.observedMessageIds, 'OBSERVED_MESSAGE_IDS'))).length;
  const goals = rows(input.goals, 'GOALS');
  goals.forEach((row) => { metricBool(row.eligible, 'GOAL_ELIGIBLE'); metricBool(row.completed, 'GOAL_COMPLETED'); });
  const eligibleGoals = goals.filter((row) => row.eligible === true);
  const completedGoals = eligibleGoals.filter((row) => row.completed === true).length;
  const responses = rows(input.responses, 'RESPONSES');
  responses.forEach((row) => { metricBool(row.useful, 'RESPONSE_USEFUL'); metricBool(row.grounded, 'RESPONSE_GROUNDED'); if (row.useful === true) { if (row.lastBubbleAt === undefined || row.usefulResponseAt === undefined) metricInvalid('RESPONSE_TIME'); const start = metricIso(row.lastBubbleAt, 'LAST_BUBBLE_TIME'); const end = metricIso(row.usefulResponseAt, 'USEFUL_RESPONSE_TIME'); if (end < start) metricInvalid('RESPONSE_TIME_ORDER'); } });
  const usefulResponses = responses.filter((row) => row.useful === true);
  const grounded = usefulResponses.filter((row) => row.grounded === true).length;
  const outbound = rows(input.outbound, 'OUTBOUND');
  outbound.forEach((row) => { metricBool(row.attempted, 'OUTBOUND_ATTEMPT'); metricBool(row.duplicate, 'OUTBOUND_DUPLICATE'); });
  const outboundAttempts = outbound.filter((row) => row.attempted === true);
  const duplicateOutbound = outboundAttempts.filter((row) => row.duplicate === true).length;
  const violationCount = input.crossScopeViolations ?? 0;
  if (!Number.isSafeInteger(violationCount) || violationCount < 0 || violationCount > 1_000_000) metricInvalid('CROSS_SCOPE_VIOLATIONS');
  const loops = input.retrievalLoops ?? [];
  if (!Array.isArray(loops) || loops.length > MAX_METRIC_ROWS || loops.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) metricInvalid('RETRIEVAL_LOOPS');
  let latencyTotal = 0, latencyMax = 0;
  usefulResponses.forEach((row) => { const latency = metricIso(row.usefulResponseAt, 'USEFUL_RESPONSE_TIME') - metricIso(row.lastBubbleAt, 'LAST_BUBBLE_TIME'); latencyTotal += latency; latencyMax = Math.max(latencyMax, latency); });
  const latencyCount = usefulResponses.length;
  return Object.freeze({
    scope: expectedScope,
    unnecessaryClarification: metricRate(unnecessary, clarifications.filter((row) => row.requested === true).length),
    emptyPromise: metricRate(empty, promises.filter((row) => row.progressDisposition === true).length),
    historicalRetrievalSuccess: metricRate(successes, attempts.length),
    multiBubbleBundleAccuracy: metricRate(bundleAccurate, bundles.length),
    goalCompletion: metricRate(completedGoals, eligibleGoals.length),
    groundedResponse: metricRate(grounded, usefulResponses.length),
    duplicateOutbound: metricRate(duplicateOutbound, outboundAttempts.length),
    crossScopeViolations: violationCount,
    retrievalLoopCount: loops.reduce((total, value) => total + value, 0),
    lastBubbleToUsefulResponseMs: Object.freeze({count: latencyCount, total: latencyTotal, average: latencyCount === 0 ? 0 : latencyTotal / latencyCount, max: latencyMax}),
  });
}
