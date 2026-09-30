import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertDemoV1Budget, computeDemoV1ResultHash, demoV1ToAgentDecision, normalizeDemoV1Envelope, verifyDemoV1ResultHash, DEMO_V1_MAX_INPUT_BYTES, DEMO_V1_MAX_OUTPUT_BYTES } from '../src/v2-demo-v1-envelope.js';
import { normalizeAgentDecision, normalizeAgentObservation, normalizeTurnTrace, type TurnTrace } from '../src/v2-agent-model-transport.js';
import { assertTransportSemanticParity, compareTransportSemanticParity } from '../src/v2-transport-semantic-oracle.js';

const result = { status: 'SUCCEEDED' as const, data: { ok: true }, evidence: [{ sourceId: 'erp-1', sourceVersion: 'v1', evidenceRefs: ['ev-1'] }], stateChanges: [] };
const base = { protocolVersion: 'v1' as const, turnId: 'turn-1', sequence: 1, correlationId: 'corr-1', actionId: 'action-1' };
const plan = { turnId: 'turn-1', intent: 'ANSWER' as const, connectiveText: 'Verified.', factClaims: [], outboundPurpose: 'customer_reply' as const };
const tool = { ...base, kind: 'tool_call' as const, name: 'lookup_customer', capabilityVersion: 'v1', arguments: { customerCode: 'C-1' } };
const capability = { ...base, sequence: 2, kind: 'capability_result' as const, name: 'lookup_customer', status: result.status, result, resultHash: '' };
const { resultHash: _hash, ...unsignedCapability } = capability;
capability.resultHash = computeDemoV1ResultHash(unsignedCapability);

test('Demo v1 accepts and detaches frozen tool, result, and final fixtures', () => {
  const a = normalizeDemoV1Envelope(tool), b = normalizeDemoV1Envelope(capability), c = normalizeDemoV1Envelope({ ...base, kind: 'final_response', responsePlan: plan });
  assert.equal(Object.isFrozen(a), true); assert.equal(Object.isFrozen((a as any).arguments), true); assert.notEqual((a as any).arguments, tool.arguments);
  assert.equal(Object.isFrozen(b), true); assert.equal(Object.isFrozen(c), true); assert.equal(verifyDemoV1ResultHash(b), true);
});

test('result hash is canonical, excludes itself, and detects tampering', () => {
  const ordered = normalizeDemoV1Envelope(capability);
  const reordered = normalizeDemoV1Envelope({ ...capability, result: { stateChanges: [], evidence: result.evidence, data: { ok: true }, status: 'SUCCEEDED' } });
  assert.equal((ordered as any).resultHash, (reordered as any).resultHash);
  for (const field of ['result', 'status', 'turnId', 'sequence', 'name', 'resultHash']) {
    const changed: any = { ...capability, [field]: field === 'sequence' ? 3 : field === 'resultHash' ? '0'.repeat(64) : field === 'result' ? { ...result, data: { ok: false } } : field === 'status' ? 'FAILED' : `${(capability as any)[field]}-x` };
    assert.equal(verifyDemoV1ResultHash(changed), false, field);
  }
});

test('Demo v1 budget assertion accepts exact boundaries and rejects invalid measurements', () => {
  assert.doesNotThrow(() => assertDemoV1Budget({ direction: 'input', bytes: DEMO_V1_MAX_INPUT_BYTES, tokenCount: 8000 }));
  assert.doesNotThrow(() => assertDemoV1Budget({ direction: 'output', bytes: DEMO_V1_MAX_OUTPUT_BYTES, tokenCount: 4000 }));
  for (const bad of [
    { direction: 'input', bytes: DEMO_V1_MAX_INPUT_BYTES + 1, tokenCount: 8000 },
    { direction: 'input', bytes: DEMO_V1_MAX_INPUT_BYTES, tokenCount: 8001 },
    { direction: 'output', bytes: DEMO_V1_MAX_OUTPUT_BYTES + 1, tokenCount: 4000 },
    { direction: 'output', bytes: DEMO_V1_MAX_OUTPUT_BYTES, tokenCount: 4001 },
    { direction: 'sideways', bytes: 0, tokenCount: 0 }, { direction: 'input', bytes: -1, tokenCount: 0 },
    { direction: 'input', bytes: 0.5, tokenCount: 0 }, { direction: 'input', bytes: Number.MAX_SAFE_INTEGER + 1, tokenCount: 0 },
    { direction: 'input', bytes: 0, tokenCount: NaN }, { direction: 'input', bytes: 0, tokenCount: 0, extra: true },
  ]) assert.throws(() => assertDemoV1Budget(bad));
});

test('closed schemas reject unsafe, mixed, wrong-kind, and oversized objects', () => {
  const rejects = [
    { ...tool, extra: true }, { ...tool, protocolVersion: 'v2' }, { ...tool, sequence: 0 }, { ...tool, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...tool, responsePlan: plan }, { ...base, kind: 'final_response', name: 'x', responsePlan: plan }, { ...tool, arguments: { x: NaN } },
    { ...tool, arguments: { x: 'x'.repeat(40000) } },
  ];
  for (const value of rejects) assert.throws(() => normalizeDemoV1Envelope(value));
  const custom = Object.create({ inherited: true }); Object.assign(custom, tool); assert.throws(() => normalizeDemoV1Envelope(custom));
  const accessor: any = { ...tool }; Object.defineProperty(accessor, 'name', { enumerable: true, get: () => 'x' }); assert.throws(() => normalizeDemoV1Envelope(accessor));
  const symbol: any = { ...tool }; symbol[Symbol('x')] = true; assert.throws(() => normalizeDemoV1Envelope(symbol));
  const cycle: any = { ...tool, arguments: {} }; cycle.arguments.self = cycle.arguments; assert.throws(() => normalizeDemoV1Envelope(cycle));
});

test('prototype-shaped own data keys are rejected at every JSON boundary', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const malicious = (value: any) => { Object.defineProperty(value, key, { value: 'attack', enumerable: true, configurable: true }); return value; };
    assert.throws(() => normalizeAgentDecision(malicious({ ...tool })));
    assert.throws(() => normalizeAgentDecision({ ...tool, arguments: malicious({ safe: true }) }));
    assert.throws(() => normalizeAgentDecision({ ...tool, arguments: { nested: malicious({ safe: true }) } }));
    assert.throws(() => normalizeAgentObservation({ turnId: 'turn-1', sequence: 1, context: malicious({ safe: true }), availableCapabilities: [], completedActions: [] }));
    assert.throws(() => normalizeAgentObservation({ turnId: 'turn-1', sequence: 1, context: { nested: malicious({ safe: true }) }, availableCapabilities: [], completedActions: [] }));
    assert.throws(() => normalizeDemoV1Envelope(malicious({ ...tool })));
    assert.throws(() => normalizeDemoV1Envelope({ ...tool, arguments: malicious({ safe: true }) }));
    assert.throws(() => normalizeDemoV1Envelope({ ...tool, arguments: { nested: malicious({ safe: true }) } }));
    assert.throws(() => normalizeTurnTrace({ ...trace(), wire: malicious({ requestId: 'r' }) }));
    assert.throws(() => normalizeTurnTrace({ ...trace(), wire: { requestId: 'r', nested: malicious({ safe: true }) } }));
    assert.throws(() => normalizeTurnTrace({ ...trace(), provider: malicious({ providerName: 'p' }) }));
  }
});

test('native and Demo fixture representations normalize to the same decision', () => {
  const demo = demoV1ToAgentDecision(tool);
  const native = normalizeAgentDecision({ kind: 'tool_call', turnId: 'turn-1', sequence: 1, correlationId: 'corr-1', actionId: 'action-1', capabilityName: 'lookup_customer', capabilityVersion: 'v1', arguments: { customerCode: 'C-1' } });
  assert.deepEqual(native, demo);
});

test('business JSON closes nested authority and secret surfaces across observation, decision, trace, and Demo', () => {
  const observation = { turnId: 'turn-1', sequence: 1, context: { customer: { token: 'x' } }, availableCapabilities: [], completedActions: [] };
  for (const value of [observation, { ...observation, context: { note: 'Authorization: Bearer abcdefgh' } }]) assert.throws(() => normalizeAgentObservation(value));
  assert.doesNotThrow(() => normalizeAgentObservation({ ...observation, context: { note: 'A token is a unit of text.' } }));
  for (const bad of [{ auth: 'x' }, { requestId: 'x' }, { nested: { credential: 'x' } }, { x: undefined }, { x: 1n }, { x: NaN }]) assert.throws(() => normalizeAgentDecision({ kind: 'tool_call', turnId: 'turn-1', sequence: 1, correlationId: 'c', actionId: 'a', capabilityName: 'lookup_customer', arguments: bad }));
  const valid = trace();
  for (const bad of [
    { ...valid, turnId: 'other' }, { ...valid, registryInvocation: { ...valid.registryInvocation, sequence: 2 } },
    { ...valid, capabilityError: { code: 'FAILED' } }, { ...valid, evidence: [] },
    { ...valid, grounding: { verdict: 'PASS', factSlots: [{ slot: 'unknown', canonicalRef: { sourceId: 'e', versionOrRevision: 'v1', evidenceRefs: ['e'] }, value: 'x' }] } },
    { ...valid, terminal: { status: 'TERMINAL' } }, { ...valid, outboundDisposition: 'INVALID' },
    { ...valid, wire: { authorization: 'secret' } }, { ...valid, provider: { session: 'secret' } },
    { ...valid, wire: { raw: 'different' } }, { ...valid, wire: { requestId: 'x', nested: {} } },
    { ...valid, wire: { latency: 1, latencyMs: 2 } }, { ...valid, wire: { latencyMs: -1 } },
    { ...valid, wire: { latencyMs: NaN } }, { ...valid, wire: { latencyMs: 86_400_001 } },
    { ...valid, wire: { auth: 'secret' } }, { ...valid, wire: { token: 'secret' } }, { ...valid, wire: { session: 'secret' } },
  ]) assert.throws(() => normalizeTurnTrace(bad));
  const finalTrace: any = { turnId: 'turn-1', decision: normalizeAgentDecision({ kind: 'final_response', turnId: 'turn-1', sequence: 1, correlationId: 'c', actionId: 'a', responsePlan: plan }), evidence: [], stateChanges: [], outboundDisposition: 'RUNTIME_RESPONSE', grounding: null, terminal: { status: 'TERMINAL', reasonCode: 'DONE' }, registryInvocation: valid.registryInvocation };
  assert.throws(() => normalizeTurnTrace(finalTrace));
});

function trace(overrides: Partial<TurnTrace> = {}): TurnTrace {
  return { turnId: 'turn-1', decision: normalizeAgentDecision({ kind: 'tool_call', turnId: 'turn-1', sequence: 1, correlationId: 'corr-1', actionId: 'action-1', capabilityName: 'lookup_customer', capabilityVersion: 'v1', arguments: { customerCode: 'C-1' } }), registryInvocation: { actionId: 'action-1', sequence: 1, capabilityName: 'lookup_customer', capabilityVersion: 'v1', arguments: { customerCode: 'C-1' } }, capabilityResult: { name: 'lookup_customer', result }, evidence: result.evidence, stateChanges: [], outboundDisposition: 'NONE', grounding: { verdict: 'PASS', factSlots: [] }, terminal: { status: 'CONTINUE' }, wire: { requestId: 'native-1' }, provider: { latencyMs: 2 }, connectiveWording: 'Verified.', ...overrides };
}

test('semantic oracle ignores only transport metadata and connective wording', () => {
  const left = trace(), right = trace({ wire: { requestId: 'demo-2', latencyMs: 99 }, provider: { latencyMs: 99, providerName: 'demo' }, connectiveWording: 'Thanks.' });
  assert.equal(compareTransportSemanticParity(left, right).equal, true); assert.doesNotThrow(() => assertTransportSemanticParity(left, right));
  for (const field of ['decision', 'registryInvocation', 'capabilityResult', 'evidence', 'stateChanges', 'outboundDisposition', 'grounding', 'terminal'] as const) {
    const changed: any = trace({ [field]: field === 'stateChanges' ? [{ entity: 'ORDER_DRAFT', to: 'CHANGED' }] : field === 'outboundDisposition' ? 'RUNTIME_RESPONSE' : field === 'evidence' ? [{ sourceId: 'other' }] : field === 'grounding' ? { verdict: 'REJECT', factSlots: [], rejectionReason: 'DIFFERENT' } : field === 'terminal' ? { status: 'FAIL_CLOSED', reasonCode: 'HANDOFF' } : field === 'capabilityResult' ? { name: 'lookup_customer', result: { ...result, reasonCode: 'DIFFERENT' } } : field === 'registryInvocation' ? { ...trace().registryInvocation, capabilityVersion: 'v2' } : normalizeAgentDecision({ kind: 'tool_call', turnId: 'turn-1', sequence: 1, correlationId: 'corr-1', actionId: 'action-1', capabilityName: 'other', arguments: {} }) });
    assert.equal(compareTransportSemanticParity(trace(), changed).equal, false, field);
  }
});

test('transport modules contain no adapter execution or forbidden SO authority', () => {
  const source = ['src/v2-agent-model-transport.ts', 'src/v2-demo-v1-envelope.ts', 'src/v2-transport-semantic-oracle.ts', 'src/v2-transport-contract-helpers.ts', 'src/v2-native-tool-transport.ts', 'src/v2-capability-schema.ts'].map(path => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(source, /\b(fetch|executeSql|postSalesOrder|confirmSalesOrder|createDeliveryOrder)\s*\(/i);
  assert.doesNotMatch(source, /name\s*:\s*['"](?:post_sales_order|confirm_sales_order|create_delivery_order)['"]/i);
  assert.doesNotMatch(source, /\b(?:gateway|providerAdapter|tokenizer|tokenSession|persistToken|registryInvoke|postSalesOrder|confirmSalesOrder|createDeliveryOrder)\s*\(/i);
});

test('complete TurnTrace requires one coherent tool outcome or a pure final decision', () => {
  const valid = trace();
  assert.throws(() => normalizeTurnTrace({ ...valid, capabilityResult: undefined, capabilityError: undefined }));
  assert.throws(() => normalizeTurnTrace({ ...valid, capabilityError: { code: 'FAILED' }, evidence: result.evidence }));
  assert.throws(() => normalizeTurnTrace({ ...valid, capabilityResult: undefined, capabilityError: { code: 'FAILED' }, evidence: result.evidence, stateChanges: [] }));
  const finalDecision = normalizeAgentDecision({ kind: 'final_response', turnId: 'turn-1', sequence: 1, correlationId: 'c', actionId: 'a', responsePlan: plan });
  const final = { turnId: 'turn-1', decision: finalDecision, evidence: [], stateChanges: [], outboundDisposition: 'RUNTIME_RESPONSE' as const, grounding: null, terminal: { status: 'TERMINAL' as const, reasonCode: 'PI_FINAL_PENDING_GROUNDING' as const } };
  assert.doesNotThrow(() => normalizeTurnTrace(final));
  assert.throws(() => normalizeTurnTrace({ ...final, connectiveWording: { text: 'no' } }));
  assert.throws(() => normalizeTurnTrace({ ...final, evidence: result.evidence }));
});

test('grounding and terminal projections enforce their closed mappings', () => {
  const valid = trace();
  assert.throws(() => normalizeTurnTrace({ ...valid, grounding: { verdict: 'PASS', factSlots: [], safeReasonCode: 'X' } }));
  assert.throws(() => normalizeTurnTrace({ ...valid, grounding: { verdict: 'PASS', factSlots: [{ slot: 'price', canonicalRef: { sourceId: 'erp', versionOrRevision: 'v1', evidenceRefs: ['e'] }, value: 1 }, { slot: 'price', canonicalRef: { sourceId: 'erp', versionOrRevision: 'v1', evidenceRefs: ['e2'] }, value: 2 }] } }));
  assert.throws(() => normalizeTurnTrace({ ...valid, grounding: { verdict: 'REJECT', factSlots: [], safeReasonCode: 'NOPE', rejectionReason: 'GROUNDING_STALE' } }));
  assert.throws(() => normalizeTurnTrace({ ...valid, grounding: { verdict: 'REJECT', factSlots: [], safeReasonCode: 'GROUNDING_REJECTED', rejectionReason: 'OTHER' } }));
  assert.throws(() => normalizeTurnTrace({ ...valid, terminal: { status: 'CONTINUE', reasonCode: 'PI_MODEL_FAILED' } }));
  assert.throws(() => normalizeTurnTrace({ ...valid, terminal: { status: 'TERMINAL' } }));
  assert.throws(() => normalizeTurnTrace({ ...valid, terminal: { status: 'FAIL_CLOSED', reasonCode: 'PI_FINAL_PENDING_GROUNDING' } }));
  assert.throws(() => normalizeTurnTrace({ ...valid, terminal: { status: 'TERMINAL', reasonCode: 'PI_MODEL_FAILED' } }));
  assert.doesNotThrow(() => normalizeTurnTrace({ ...valid, grounding: { verdict: 'REJECT', factSlots: [], safeReasonCode: 'GROUNDING_REJECTED', rejectionReason: 'GROUNDING_STALE' }, terminal: { status: 'FAIL_CLOSED', reasonCode: 'PI_MODEL_FAILED' } }));
});

test('tool-call terminal reasons remain coherent with the decision kind', () => {
  const valid = trace();
  assert.throws(() => normalizeTurnTrace({ ...valid, terminal: { status: 'TERMINAL', reasonCode: 'PI_FINAL_PENDING_GROUNDING' } }), /TOOL_CALL_TERMINAL_MISMATCH/);
  assert.doesNotThrow(() => normalizeTurnTrace({ ...valid, outboundDisposition: 'CAPABILITY_OWNED_QUOTATION', terminal: { status: 'TERMINAL', reasonCode: 'PI_CAPABILITY_OWNED_QUOTATION' } }));
});

test('grounding facts match the runtime scalar domain and retain string redaction checks', () => {
  const valid = trace({ grounding: { verdict: 'PASS', factSlots: [{ slot: 'availability', canonicalRef: { sourceId: 'erp', versionOrRevision: 'v1', evidenceRefs: ['ev'] }, value: true }] } });
  for (const value of ['exact text', 12.5, false]) assert.doesNotThrow(() => normalizeTurnTrace({ ...valid, grounding: { ...valid.grounding!, factSlots: [{ ...valid.grounding!.factSlots[0], value }] } }));
  for (const value of [null, {}, [], undefined, NaN, Infinity, 'Bearer secret-token']) assert.throws(() => normalizeTurnTrace({ ...valid, grounding: { ...valid.grounding!, factSlots: [{ ...valid.grounding!.factSlots[0], value }] } }));
});

test('final-response traces require the exact runtime terminal mapping', () => {
  const decision = normalizeAgentDecision({ kind: 'final_response', turnId: 'turn-1', sequence: 1, correlationId: 'c', actionId: 'a', responsePlan: plan });
  const valid = { turnId: 'turn-1', decision, evidence: [], stateChanges: [], outboundDisposition: 'RUNTIME_RESPONSE' as const, grounding: null, terminal: { status: 'TERMINAL' as const, reasonCode: 'PI_FINAL_PENDING_GROUNDING' as const } };
  assert.doesNotThrow(() => normalizeTurnTrace(valid));
  for (const terminal of [{ status: 'CONTINUE' }, { status: 'TERMINAL' }, { status: 'TERMINAL', reasonCode: 'PI_MODEL_FAILED' }, { status: 'FAIL_CLOSED', reasonCode: 'PI_MODEL_FAILED' }]) assert.throws(() => normalizeTurnTrace({ ...valid, terminal }));
  for (const field of ['registryInvocation', 'capabilityResult', 'capabilityError', 'evidence', 'stateChanges']) assert.throws(() => normalizeTurnTrace({ ...valid, [field]: field === 'evidence' || field === 'stateChanges' ? result.evidence : valid.registryInvocation ?? { code: 'FAILED' } }));
});

test('TurnTrace rejects each execution-coherence violation independently', () => {
  const valid = trace();
  const cases = [
    { registryInvocation: { ...valid.registryInvocation!, actionId: 'wrong' } },
    { registryInvocation: { ...valid.registryInvocation!, sequence: 2 } },
    { registryInvocation: { ...valid.registryInvocation!, capabilityName: 'other' } },
    { registryInvocation: { ...valid.registryInvocation!, capabilityVersion: 'v2' } },
    { registryInvocation: { ...valid.registryInvocation!, arguments: { customerCode: 'C-2' } } },
    { capabilityResult: undefined, capabilityError: undefined },
    { capabilityError: { code: 'FAILED' } },
    { capabilityResult: valid.capabilityResult, capabilityError: { code: 'FAILED' } },
    { capabilityResult: { ...valid.capabilityResult!, name: 'other' } },
    { capabilityResult: undefined, capabilityError: { code: 'FAILED' }, evidence: result.evidence },
    { capabilityResult: undefined, capabilityError: { code: 'FAILED' }, stateChanges: [{ entity: 'ORDER_DRAFT' }] },
    { outboundDisposition: 'INVALID' },
  ];
  for (const change of cases) assert.throws(() => normalizeTurnTrace({ ...valid, ...change }));
});

test('semantic oracle reports semantic mismatches only after both valid traces normalize', () => {
  const fact = { slot: 'price' as const, canonicalRef: { sourceId: 'erp', versionOrRevision: 'v1', evidenceRefs: ['ev'] }, value: 10 };
  const pass = { verdict: 'PASS' as const, factSlots: [fact] };
  const fail = { verdict: 'REJECT' as const, factSlots: [], safeReasonCode: 'GROUNDING_REJECTED' as const, rejectionReason: 'GROUNDING_STALE' };
  const baseTrace = trace({ grounding: pass });
  const errorTrace = trace({ capabilityResult: undefined, capabilityError: { code: 'FAILED', reasonCode: 'PI_MODEL_FAILED' }, evidence: [], stateChanges: [], terminal: { status: 'FAIL_CLOSED', reasonCode: 'PI_MODEL_FAILED' } });
  const validPairs: Array<[string, TurnTrace, TurnTrace]> = [
    ['capability decision/name', baseTrace, trace({ decision: normalizeAgentDecision({ kind: 'tool_call', turnId: 'turn-1', sequence: 1, correlationId: 'corr-1', actionId: 'action-1', capabilityName: 'other', capabilityVersion: 'v1', arguments: { customerCode: 'C-1' } }), registryInvocation: { ...baseTrace.registryInvocation!, capabilityName: 'other' }, capabilityResult: { ...baseTrace.capabilityResult!, name: 'other' } })],
    ['arguments', baseTrace, trace({ decision: normalizeAgentDecision({ kind: 'tool_call', turnId: 'turn-1', sequence: 1, correlationId: 'corr-1', actionId: 'action-1', capabilityName: 'lookup_customer', capabilityVersion: 'v1', arguments: { customerCode: 'C-2' } }), registryInvocation: { ...baseTrace.registryInvocation!, arguments: { customerCode: 'C-2' } } })],
    ['capabilityVersion', baseTrace, trace({ decision: normalizeAgentDecision({ kind: 'tool_call', turnId: 'turn-1', sequence: 1, correlationId: 'corr-1', actionId: 'action-1', capabilityName: 'lookup_customer', capabilityVersion: 'v2', arguments: { customerCode: 'C-1' } }), registryInvocation: { ...baseTrace.registryInvocation!, capabilityVersion: 'v2' } })],
    ['normalized result status/reason/data', baseTrace, trace({ capabilityResult: { name: 'lookup_customer', result: { status: 'FAILED', reasonCode: 'OTHER', data: { ok: false }, evidence: result.evidence, stateChanges: [] } } })],
    ['evidence', baseTrace, trace({ capabilityResult: { name: 'lookup_customer', result: { ...result, evidence: [{ sourceId: 'other' }] } }, evidence: [{ sourceId: 'other' }] })],
    ['stateChanges', baseTrace, trace({ capabilityResult: { name: 'lookup_customer', result: { ...result, evidence: [], stateChanges: [{ entity: 'ORDER_DRAFT', to: 'CHANGED' }] } }, evidence: [], stateChanges: [{ entity: 'ORDER_DRAFT', to: 'CHANGED' }] })],
    ['capabilityError code/reasonCode', errorTrace, trace({ capabilityResult: undefined, capabilityError: { code: 'OTHER', reasonCode: 'OTHER' }, evidence: [], stateChanges: [], terminal: { status: 'FAIL_CLOSED', reasonCode: 'PI_MODEL_FAILED' } })],
    ['outboundDisposition', baseTrace, trace({ outboundDisposition: 'RUNTIME_RESPONSE' })],
    ['grounding verdict', baseTrace, trace({ grounding: fail })],
    ['grounding slot/ref/version/evidenceRefs/value', baseTrace, trace({ grounding: { verdict: 'PASS', factSlots: [{ ...fact, slot: 'quantity', canonicalRef: { sourceId: 'other', versionOrRevision: 'v2', evidenceRefs: ['other'] }, value: 11 }] } })],
    ['terminal status/reason', baseTrace, trace({ terminal: { status: 'FAIL_CLOSED', reasonCode: 'PI_MODEL_FAILED' } })],
    ['terminal reason within FAIL_CLOSED', errorTrace, trace({ capabilityResult: undefined, capabilityError: errorTrace.capabilityError, evidence: [], stateChanges: [], terminal: { status: 'FAIL_CLOSED', reasonCode: 'PI_CANCELLED' } })],
  ];
  for (const [label, left, right] of validPairs) { const compared = compareTransportSemanticParity(left, right); assert.equal(compared.equal, false, label); assert.equal(compared.mismatchCode, 'SEMANTIC_PARITY_MISMATCH', label); }
  assert.equal(compareTransportSemanticParity(baseTrace, trace({ grounding: pass, connectiveWording: 'Thanks.', wire: { requestId: 'other' }, provider: { latencyMs: 9, providerName: 'other' } })).equal, true);
  assert.equal(compareTransportSemanticParity(baseTrace, { ...baseTrace, wire: { authorization: 'Bearer secret' } } as TurnTrace).mismatchCode, 'SEMANTIC_PARITY_INVALID_TRACE');
});
