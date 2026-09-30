import test from 'node:test';
import assert from 'node:assert/strict';
import { V3TraceRecorder, projectV3Trace, projectV3TraceSnapshot } from '../src/v3-observability.js';

const scope = {accountId: 'acct-1', conversationId: 'conv-1'};
const at = '2026-09-20T10:00:00Z';

test('OBS-001 projects all required pipeline stages using only structural allowlists', () => {
  const recorder = new V3TraceRecorder();
  const kinds = ['bundle', 'context', 'goals', 'retrieval', 'freshness', 'lease', 'admission', 'effects'] as const;
  kinds.forEach((kind, index) => recorder.record({sequence: index + 1, kind, scope, at, data: {
    bundleId: 'b-1', bundleRevision: 1, conversationRevision: 2, messageCount: 3, state: 'CLOSED',
    snapshotVersion: 'ctx-1', sourceCount: 2, tokenBudget: 1000, tokenCount: 300, projectionHash: 'hash-1',
    goalCount: 2, activeGoalCount: 1, terminalGoalCount: 1, updateCount: 2,
    tool: 'conversation_recent', callSequence: 1, depth: 1, resultClass: 'EVIDENCE', evidenceCount: 2, readBytes: 20, candidateItems: 2, stopReason: 'NONE', noNewEvidence: false,
    vectorHash: 'vec-1', dependencyCount: 4, changedClasses: ['erp'], stale: false,
    generation: 1, expiresAt: at, heartbeatAt: at,
    status: 'ADMITTED', effectIdentity: 'effect-1', reasonCode: 'FRESH', sideEffectStarted: false, freshnessCurrent: true, newerInput: false, leaseCurrent: true,
    effectKind: 'DRAFT_SALES_ORDER', unitCount: 1, attachmentCount: 0, authorityCutoff: 'SALES_ORDER.DRAFT',
    privateMessage: 'customer phone +6599999999 and model chain of thought', nested: {secret: 'do not copy'},
  }}));
  const trace = recorder.snapshot();
  assert.equal(trace.length, 8);
  assert.deepEqual(trace.map(event => event.kind), kinds);
  assert.equal((trace[0].data as any).privateMessage, undefined);
  assert.equal((trace[0].data as any).nested, undefined);
  assert.equal((trace[7].data as any).authorityCutoff, 'SALES_ORDER.DRAFT');
  assert.doesNotMatch(JSON.stringify(trace), /6599999999|chain of thought|do not copy/);
});

test('OBS-001 bounds and redacts structural values without accepting content telemetry', () => {
  const event = projectV3Trace({sequence: 1, kind: 'retrieval', scope, at, data: {
    tool: 'conversation_recent', stopReason: 'Bearer secret-token', evidenceCount: 2,
    unknownText: 'private customer message', unknownObject: {body: 'private'},
  }});
  assert.equal(event.data.tool, 'conversation_recent');
  assert.equal(event.data.stopReason, undefined);
  assert.equal(event.data.unknownText, undefined);
  assert.equal(event.data.unknownObject, undefined);
});

test('OBS-001 fails closed for malformed scope, event, time, and sequence', () => {
  assert.throws(() => projectV3Trace({sequence: 1, kind: 'unknown', scope, at, data: {}}), /V3_OBS_001_INVALID:EVENT/);
  assert.throws(() => projectV3Trace({sequence: 1, kind: 'bundle', scope: {accountId: 'acct-1', conversationId: ''}, at, data: {}}), /SCOPE/);
  assert.throws(() => projectV3Trace({sequence: 1, kind: 'bundle', scope, at: 'not-time', data: {}}), /TIME/);
  assert.throws(() => projectV3Trace({sequence: 0, kind: 'bundle', scope, at, data: {}}), /SEQUENCE/);
});

test('OBS-001 recorder and snapshots are immutable, bounded, and ordered', () => {
  const recorder = new V3TraceRecorder();
  recorder.record({sequence: 1, kind: 'effects', scope, at, data: {status: 'DRAFT', authorityCutoff: 'SALES_ORDER.DRAFT'}});
  assert.throws(() => recorder.record({sequence: 3, kind: 'effects', scope, at, data: {}}), /SEQUENCE/);
  const snapshot = projectV3TraceSnapshot(recorder.snapshot());
  assert.throws(() => (snapshot as any).push('private'), /TypeError|object is not extensible/);
  assert.throws(() => projectV3TraceSnapshot([{sequence: 2, kind: 'effects', scope, at, data: {}}]), /SEQUENCE/);
});
