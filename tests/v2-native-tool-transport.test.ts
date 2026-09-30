import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { NativeToolTransport } from '../src/v2-native-tool-transport.js';
import { deriveAgentDecisionIdentity } from '../src/v2-transport-contract-helpers.js';
import { validateCapabilityArgumentsForDefinition } from '../src/v2-capability-schema.js';

const capability = {
  name: 'get_customer_context', version: 'v1', purpose: 'get_customer_context',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' } }, required: ['accountId', 'conversationId', 'customerId'], additionalProperties: false },
  sideEffect: 'READ_ONLY', timeoutMs: 15000, idempotencyRequired: false, outboundDisposition: 'NONE', evidenceMode: 'REQUIRED', groundingMode: 'REQUIRED',
} as const;
const observation = (overrides: Record<string, unknown> = {}) => ({ turnId: 'turn-1', sequence: 1, context: { safe: true }, availableCapabilities: [capability], completedActions: [], ...overrides });
const message = (content: any[], stopReason: any): any => ({ role: 'assistant', content, api: 'test', provider: 'test', model: 'test', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: 1 });
const streamFor = (assistant: any) => { const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: assistant.stopReason, message: assistant }); return stream; };
const transport = (assistant: any, capture: any[] = []) => new NativeToolTransport({ model: {} as any, stream: (_model, context, options) => { capture.push({ context, options }); return streamFor(assistant); } });

test('native tool call uses exact registry tool metadata and provider-independent ids', async () => {
  const capture: any[] = [];
  const result = await transport(message([{ type: 'toolCall', id: 'provider-call', name: capability.name, arguments: { accountId: 'a', conversationId: 'c', customerId: 'u' }, thoughtSignature: 'private' }], 'toolUse'), capture).decide(observation());
  assert.equal(result.kind, 'tool_call');
  assert.equal(result.capabilityVersion, 'v1');
  assert.deepEqual(deriveAgentDecisionIdentity('turn-1', 1), { correlationId: result.correlationId, actionId: result.actionId });
  assert.equal(capture[0].context.tools.length, 1);
  assert.deepEqual(capture[0].context.tools[0].parameters, capability.inputSchema);
  assert.equal(capture[0].context.messages.length, 1);
  assert.equal(capture[0].options.toolChoice, 'auto');
  assert.equal(capture[0].options.maxTokens, 4096);
  assert.equal('provider-call' in result, false);
});

test('native parser accepts installed pi-ai content block shapes and ignores provider metadata', async () => {
  const plan = JSON.stringify({ turnId: 'turn-1', intent: 'ACKNOWLEDGE', connectiveText: 'Thank you.', factClaims: [], outboundPurpose: 'acknowledgement' });
  const result = await transport(message([
    { type: 'text', text: plan, textSignature: 'opaque-token-looking-signature' },
    { type: 'thinking', thinking: 'internal reasoning', thinkingSignature: 'opaque-thinking-signature', redacted: true },
  ], 'stop')).decide(observation({ availableCapabilities: [] }));
  assert.equal(result.kind, 'final_response');
  await assert.rejects(() => transport(message([{ type: 'thinking', text: 'wrong key', redacted: true }], 'stop')).decide(observation({ availableCapabilities: [] })), /ASSISTANT_THINKING/);
  await assert.rejects(() => transport(message([{ type: 'text', text: plan, textSignature: 1 }], 'stop')).decide(observation({ availableCapabilities: [] })), /ASSISTANT_TEXT/);
  await assert.rejects(() => transport(message([{ type: 'toolCall', id: 'x', name: capability.name, arguments: { accountId: 'a', conversationId: 'c', customerId: 'u' }, thoughtSignature: 1 }], 'toolUse')).decide(observation()), /ASSISTANT_TOOL/);
});

test('projection, schema, call-shape, stop, and signal failures fail closed before execution', async () => {
  const calls: any[] = [];
  const base = transport(message([], 'stop'), calls);
  await assert.rejects(() => base.decide(observation({ availableCapabilities: [{ ...capability, version: 'v2' }] })), /CAPABILITY_VERSION_MISMATCH/);
  assert.equal(calls.length, 0);
  await assert.rejects(() => base.decide(observation({ availableCapabilities: [{ ...capability, name: 'unknown' }] })), /UNKNOWN_OR_UNAVAILABLE/);
  await assert.rejects(() => transport(message([{ type: 'toolCall', id: 'x', name: capability.name, arguments: { accountId: 'a', conversationId: 'c' } }], 'toolUse')).decide(observation()), /MISSING/);
  await assert.rejects(() => transport(message([{ type: 'toolCall', id: 'x', name: capability.name, arguments: { accountId: 'a', conversationId: 'c', customerId: 'u' } }, { type: 'toolCall', id: 'y', name: capability.name, arguments: { accountId: 'a', conversationId: 'c', customerId: 'u' } }], 'toolUse')).decide(observation()), /MULTIPLE/);
  const signal = new AbortController(); signal.abort();
  await assert.rejects(() => base.decide(observation(), signal.signal), /ABORTED/);
  assert.equal(calls.length, 0);
});

test('final response is parsed as the same grounded response-plan contract', async () => {
  const plan = JSON.stringify({ turnId: 'turn-1', intent: 'ACKNOWLEDGE', connectiveText: 'Thank you.', factClaims: [], outboundPurpose: 'acknowledgement' });
  const result = await transport(message([{ type: 'text', text: plan }], 'stop')).decide(observation({ availableCapabilities: [] }));
  assert.equal(result.kind, 'final_response');
  await assert.rejects(() => transport(message([{ type: 'text', text: '```json\n' + plan + '\n```' }], 'stop')).decide(observation({ availableCapabilities: [] })), /MALFORMED_JSON|CONNECTIVE/);
});

test('caller-owned capability/result loop sends normalized completed action back on the next call', async () => {
  const calls: any[] = [];
  const toolMessage = message([{ type: 'toolCall', id: 'opaque', name: capability.name, arguments: { accountId: 'a', conversationId: 'c', customerId: 'u' } }], 'toolUse');
  const plan = JSON.stringify({ turnId: 'turn-1', intent: 'ACKNOWLEDGE', connectiveText: 'Thank you.', factClaims: [], outboundPurpose: 'acknowledgement' });
  const finalMessage = message([{ type: 'text', text: plan }], 'stop');
  let callCount = 0;
  const adapter = new NativeToolTransport({ model: {} as any, stream: (_model, context) => { calls.push(context); callCount += 1; return streamFor(callCount === 1 ? toolMessage : finalMessage); } });
  const first = await adapter.decide(observation());
  const completedAction = { actionId: first.actionId, name: capability.name, status: 'SUCCEEDED', data: { customerId: 'u' }, evidence: [], stateChanges: [] };
  const secondObservation = observation({ sequence: 2, completedActions: [completedAction] });
  const second = await adapter.decide(secondObservation);
  assert.equal(first.kind, 'tool_call');
  assert.equal(second.kind, 'final_response');
  assert.equal(calls.length, 2);
  const canonicalObservation = JSON.parse(calls[1].messages[0].content);
  assert.deepEqual(canonicalObservation.completedActions, [completedAction]);
});

test('native transport is deterministic, fixed-mode, and rejects unsafe identity/preamble inputs', async () => {
  const captures: any[] = [];
  const a = new NativeToolTransport({ model: {} as any, id: 'safe-id', stream: (_m, c) => { captures.push(c); return streamFor(message([{ type: 'text', text: JSON.stringify({ turnId: 'turn-1', intent: 'ACKNOWLEDGE', connectiveText: 'Thank you.', factClaims: [], outboundPurpose: 'acknowledgement' }) }], 'stop')); } });
  await a.decide(observation({ availableCapabilities: [] })); await a.decide(observation({ availableCapabilities: [] }));
  assert.equal(a.mode, 'native-tools'); assert.equal(a.id, 'safe-id');
  assert.equal(captures[0].messages[0].timestamp, 0); assert.deepEqual(captures[0], captures[1]);
  for (const id of ['provider-token', 'staff-approval', 'session-secret', 'whatsapp-webhook']) assert.throws(() => new NativeToolTransport({ model: {} as any, id, stream: () => { throw new Error('must not'); } }));
  await assert.rejects(() => new NativeToolTransport({ model: {} as any, systemPreamble: 'Bearer secret-token', stream: () => { throw new Error('must not'); } }).decide(observation({ availableCapabilities: [] })), /SYSTEM_PREAMBLE_SECRET/);
  for (const turnId of ['provider-token', 'staff-turn', 'credential-1', 'session-secret']) assert.throws(() => deriveAgentDecisionIdentity(turnId, 1));
  assert.deepEqual(deriveAgentDecisionIdentity('turn-1', 1), deriveAgentDecisionIdentity('turn-1', 1));
  assert.notDeepEqual(deriveAgentDecisionIdentity('turn-1', 1), deriveAgentDecisionIdentity('turn-1', 2));
});

test('authority-free schema helper returns detached JSON and rejects hostile values', () => {
  const source: any = { accountId: 'a', conversationId: 'c', customerId: 'u' };
  const result = validateCapabilityArgumentsForDefinition(capability, source);
  assert.deepEqual(result, source); assert.notEqual(result, source);
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const hostile: any = { ...source }; Object.defineProperty(hostile, key, { value: 'x', enumerable: true });
    assert.throws(() => validateCapabilityArgumentsForDefinition(capability, hostile));
  }
  const accessor: any = { ...source }; Object.defineProperty(accessor, 'customerId', { enumerable: true, get: () => { throw new Error('getter'); } });
  assert.throws(() => validateCapabilityArgumentsForDefinition(capability, accessor));
});

test('provider decision surface fails closed for malformed and mixed content', async () => {
  const goodArgs = { accountId: 'a', conversationId: 'c', customerId: 'u' };
  const badParts: any[] = [
    [{ type: 'toolCall', id: 'x', name: capability.name, arguments: goodArgs }, { type: 'toolCall', id: 'y', name: capability.name, arguments: goodArgs }],
    [{ type: 'text', text: 'x' }, { type: 'toolCall', id: 'x', name: capability.name, arguments: goodArgs }],
    [{ type: 'image', url: 'x' }], [{ type: 'text', text: 'x', extra: true }],
    [{ type: 'thinking', thinking: 'x', signature: 'x' }], [{ type: 'toolCall', id: 'x', name: capability.name, arguments: goodArgs, namespace: 'other' }],
  ];
  for (const parts of badParts) await assert.rejects(() => transport(message(parts, parts[0]?.type === 'toolCall' ? 'toolUse' : 'stop')).decide(observation()), /NATIVE_TOOL_TRANSPORT_FAILED|INVALID_AGENT_TRANSPORT/);
  const sparse: any[] = []; sparse.length = 1;
  await assert.rejects(() => transport(message(sparse, 'stop')).decide(observation({ availableCapabilities: [] })), /ASSISTANT_CONTENT_SPARSE/);
  const accessor: any = { role: 'assistant', content: [{ type: 'text', text: '{}' }], stopReason: 'stop' };
  Object.defineProperty(accessor.content[0], 'text', { enumerable: true, get: () => { throw new Error('getter'); } });
  await assert.rejects(() => transport(accessor).decide(observation({ availableCapabilities: [] })), /ASSISTANT_CONTENT/);
});

test('authority-free schema helper enforces independent resource bounds', () => {
  const permissive: any = { ...capability, inputSchema: { type: 'object', additionalProperties: true } };
  assert.throws(() => validateCapabilityArgumentsForDefinition(permissive, { value: 'x'.repeat(16 * 1024) }), /CAPABILITY_SCHEMA_INVALID:.*(STRING|BYTE)_LIMIT/);
  let deep: any = 'x'; for (let i = 0; i < 17; i += 1) deep = { value: deep };
  assert.throws(() => validateCapabilityArgumentsForDefinition(permissive, deep), /CAPABILITY_SCHEMA_INVALID:.*DEPTH_LIMIT/);
  const many: any = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 1)));
  assert.throws(() => validateCapabilityArgumentsForDefinition(permissive, many), /CAPABILITY_SCHEMA_INVALID:.*NODE_LIMIT/);
  assert.throws(() => validateCapabilityArgumentsForDefinition(permissive, { value: Array.from({ length: 129 }, () => 1) }), /CAPABILITY_SCHEMA_INVALID:.*ARRAY_LENGTH_LIMIT/);
  const wide: any = {}; for (let i = 0; i < 129; i += 1) wide[`key${i}`] = i;
  assert.throws(() => validateCapabilityArgumentsForDefinition(permissive, wide), /CAPABILITY_SCHEMA_INVALID:.*OBJECT_KEYS_LIMIT/);
  assert.throws(() => validateCapabilityArgumentsForDefinition(permissive, { value: 'x'.repeat(8 * 1024 + 1) }), /CAPABILITY_SCHEMA_INVALID:.*STRING_LIMIT/);
  assert.deepEqual(validateCapabilityArgumentsForDefinition(capability, { accountId: 'a', conversationId: 'c', customerId: 'u' }), { accountId: 'a', conversationId: 'c', customerId: 'u' });
});
