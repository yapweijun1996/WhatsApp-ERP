import test from 'node:test';
import assert from 'node:assert/strict';
import { projectV3Metrics } from '../src/v3-observability.js';

const scope = {accountId: 'acct-1', conversationId: 'conv-1'};

test('OBS-002 projects deterministic structural rates and latency', () => {
  const metrics = projectV3Metrics({
    scope,
    clarifications: [{requested: true, required: false}, {requested: true, required: true}, {requested: false, required: true}],
    promises: [{progressDisposition: true, continuationValid: false}, {progressDisposition: true, continuationValid: true}, {progressDisposition: false, continuationValid: false}],
    historicalRetrieval: [{attempted: true, succeeded: true}, {attempted: true, succeeded: false}, {attempted: false, succeeded: false}],
    bundles: [{expectedMessageIds: ['m-1', 'm-2'], observedMessageIds: ['m-2', 'm-1']}, {expectedMessageIds: ['m-3'], observedMessageIds: ['m-4']}],
    goals: [{eligible: true, completed: true}, {eligible: true, completed: false}, {eligible: false, completed: true}],
    responses: [
      {useful: true, grounded: true, lastBubbleAt: '2026-09-20T10:00:00Z', usefulResponseAt: '2026-09-20T10:00:00.250Z'},
      {useful: true, grounded: false, lastBubbleAt: '2026-09-20T10:00:01Z', usefulResponseAt: '2026-09-20T10:00:02Z'},
      {useful: false, grounded: false},
    ],
    outbound: [{attempted: true, duplicate: false}, {attempted: true, duplicate: true}, {attempted: false, duplicate: false}],
    crossScopeViolations: 0,
    retrievalLoops: [2, 1],
  });

  assert.deepEqual(metrics.unnecessaryClarification, {numerator: 1, denominator: 2, rate: 0.5});
  assert.deepEqual(metrics.emptyPromise, {numerator: 1, denominator: 2, rate: 0.5});
  assert.deepEqual(metrics.historicalRetrievalSuccess, {numerator: 1, denominator: 2, rate: 0.5});
  assert.deepEqual(metrics.multiBubbleBundleAccuracy, {numerator: 1, denominator: 2, rate: 0.5});
  assert.deepEqual(metrics.goalCompletion, {numerator: 1, denominator: 2, rate: 0.5});
  assert.deepEqual(metrics.groundedResponse, {numerator: 1, denominator: 2, rate: 0.5});
  assert.deepEqual(metrics.duplicateOutbound, {numerator: 1, denominator: 2, rate: 0.5});
  assert.equal(metrics.crossScopeViolations, 0);
  assert.equal(metrics.retrievalLoopCount, 3);
  assert.deepEqual(metrics.lastBubbleToUsefulResponseMs, {count: 2, total: 1250, average: 625, max: 1000});
});

test('OBS-002 uses deterministic zero denominators and retains zero-target violations', () => {
  const metrics = projectV3Metrics({scope, crossScopeViolations: 2});
  for (const key of ['unnecessaryClarification', 'emptyPromise', 'historicalRetrievalSuccess', 'multiBubbleBundleAccuracy', 'goalCompletion', 'groundedResponse', 'duplicateOutbound'] as const) {
    assert.deepEqual(metrics[key], {numerator: 0, denominator: 0, rate: 0});
  }
  assert.equal(metrics.crossScopeViolations, 2);
  assert.deepEqual(metrics.lastBubbleToUsefulResponseMs, {count: 0, total: 0, average: 0, max: 0});
});

test('OBS-002 rejects unsafe structural facts without inspecting customer wording', () => {
  assert.throws(() => projectV3Metrics({scope, retrievalLoops: [-1]}), /V3_OBS_002_INVALID:RETRIEVAL_LOOPS/);
  assert.throws(() => projectV3Metrics({scope, bundles: [{expectedMessageIds: ['m-1'], observedMessageIds: ['private customer wording']}]}), /V3_OBS_002_INVALID:OBSERVED_MESSAGE_IDS/);
  assert.throws(() => projectV3Metrics({scope, responses: [{useful: true, grounded: true}]}), /V3_OBS_002_INVALID:RESPONSE_TIME/);
  assert.throws(() => projectV3Metrics({scope: {accountId: 'acct-1', conversationId: ''}}), /V3_OBS_001_INVALID:SCOPE/);
});

test('OBS-002 fails closed for negative latency and malformed rates', () => {
  assert.throws(() => projectV3Metrics({scope, responses: [{useful: true, grounded: true, lastBubbleAt: '2026-09-20T10:00:01Z', usefulResponseAt: '2026-09-20T10:00:00Z'}]}), /V3_OBS_002_INVALID:RESPONSE_TIME_ORDER/);
  assert.throws(() => projectV3Metrics({scope, crossScopeViolations: -1}), /V3_OBS_002_INVALID:CROSS_SCOPE_VIOLATIONS/);
});
