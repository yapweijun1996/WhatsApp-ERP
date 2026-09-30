import assert from 'node:assert/strict';
import test from 'node:test';
import { DemoTextToolBridge } from '../src/v2-demo-text-tool-bridge.js';
import { deriveAgentDecisionIdentity } from '../src/v2-transport-contract-helpers.js';
import type { DemoTextModelResult } from '../src/v2-demo-text-tool-bridge.js';
import { getCapability } from '../src/v2-capability-registry.js';
import { listCapabilities } from '../src/v2-capability-registry.js';

const capability = { name: 'get_customer_context', version: 'v1', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' } }, required: ['accountId', 'conversationId', 'customerId'], additionalProperties: false }, sideEffect: 'READ_ONLY', timeout: { perCallMs: 15000 }, idempotency: { required: false }, outbound: { disposition: 'NONE' }, evidence: { mode: 'REQUIRED' }, grounding: { mode: 'REQUIRED' } } as const;
const projection = { name: capability.name, version: capability.version, purpose: capability.name, inputSchema: capability.inputSchema, sideEffect: capability.sideEffect, timeoutMs: capability.timeout.perCallMs, idempotencyRequired: capability.idempotency.required, outboundDisposition: capability.outbound.disposition, evidenceMode: capability.evidence.mode, groundingMode: capability.grounding.mode } as const;
const observation = (sequence = 1, completedActions: unknown[] = []) => ({ turnId: 'turn-1', sequence, context: { safe: true }, availableCapabilities: [projection], completedActions });
const identity = (sequence: number) => deriveAgentDecisionIdentity('turn-1', sequence);
const tool = (sequence = 1, overrides: Record<string, unknown> = {}) => JSON.stringify({ protocolVersion: 'v1', turnId: 'turn-1', sequence, ...identity(sequence), kind: 'tool_call', name: 'get_customer_context', arguments: { accountId: 'a', conversationId: 'c', customerId: 'u' }, ...overrides });
const final = (sequence = 1, overrides: Record<string, unknown> = {}) => JSON.stringify({ protocolVersion: 'v1', turnId: 'turn-1', sequence, ...identity(sequence), kind: 'final_response', responsePlan: { turnId: 'turn-1', intent: 'ACKNOWLEDGE', connectiveText: 'Thank you.', factClaims: [], outboundPurpose: 'acknowledgement' }, ...overrides });
const measured = (text: string, inputTokenCount = 1, outputTokenCount = 1): DemoTextModelResult => ({ text, inputBudget: { direction: 'input', bytes: 0, tokenCount: inputTokenCount }, outputBudget: { direction: 'output', bytes: Buffer.byteLength(text, 'utf8'), tokenCount: outputTokenCount } });
const inputMeasurement = (prompt: string) => ({ direction: 'input' as const, bytes: Buffer.byteLength(prompt, 'utf8'), tokenCount: 1 });
const model = (text: string, inputTokenCount = 1, outputTokenCount = 1) => async (prompt: string) => ({ ...measured(text, inputTokenCount, outputTokenCount), inputBudget: { direction: 'input' as const, bytes: Buffer.byteLength(prompt, 'utf8'), tokenCount: inputTokenCount } });

test('projects a compact model guide while retaining full host capability validation', async () => {
  const full = listCapabilities().map(definition => ({
    name: definition.name, version: definition.version, purpose: definition.name, inputSchema: definition.inputSchema,
    sideEffect: definition.sideEffect, timeoutMs: definition.timeout.perCallMs,
    idempotencyRequired: definition.idempotency.required, outboundDisposition: definition.outbound.disposition,
    evidenceMode: definition.evidence.mode, groundingMode: definition.grounding.mode,
  }));
  let captured = '';
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => {
    captured = prompt;
    return { ...measured(final()), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } };
  } });
  await bridge.decide({ turnId: 'turn-1', sequence: 1, context: { safe: 'x'.repeat(1500) }, availableCapabilities: full, completedActions: [] });
  const parsed = JSON.parse(captured) as any;
  assert.equal('availableCapabilities' in parsed.observation, false);
  assert.match(parsed.workflow, /AI-first semantics/);
  assert.match(parsed.workflow, /never use exact-phrase matching/);
  assert.equal(parsed.observation.capabilityGuides.length, full.length);
  assert.ok(parsed.observation.capabilityGuides.every((guide: any) => typeof guide.name === 'string' && typeof guide.arguments === 'string'));
  assert.match(parsed.observation.capabilityGuides.find((guide: any) => guide.name === 'record_customer_commitment').arguments, /commitment:ACCEPT\|REJECT\|CHANGE\|CANCEL/);
  assert.equal(captured.includes('idempotencyRequired'), false);
  assert.equal(captured.includes('outboundDisposition'), false);
  assert.ok(Buffer.byteLength(captured, 'utf8') < 9_000);
});

test('accepts one correlated tool call and one correlated grounded final response', async () => {
  let count = 0;
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => ++count === 1 ? { ...measured(tool()), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } } : { ...measured(final(2)), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } } });
  const first = await bridge.decide(observation());
  assert.equal(first.kind, 'tool_call');
  const result = bridge.encodeHostCapabilityResult({ ...identity(1), turnId: 'turn-1', sequence: 1, name: 'get_customer_context', result: { status: 'SUCCEEDED', data: { customerId: 'u' }, evidence: [], stateChanges: [] } });
  assert.equal(result.kind, 'capability_result');
  assert.match(result.resultHash, /^[a-f0-9]{64}$/);
  const second = await bridge.decide(observation(2, [{ actionId: first.actionId, name: 'get_customer_context', status: 'SUCCEEDED', data: { customerId: 'u' }, evidence: [], stateChanges: [] }]));
  assert.equal(second.kind, 'final_response');
});

test('classifies acknowledged action reuse as duplicate and rejects true sequence replay', async () => {
  let calls = 0;
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => {
    calls += 1;
    const sequence = calls === 1 ? 1 : 2;
    const actionId = calls === 2 ? identity(1).actionId : identity(sequence).actionId;
    return { ...measured(tool(sequence, { actionId })), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } };
  } });
  const first = await bridge.decide(observation());
  bridge.encodeHostCapabilityResult({ ...identity(1), turnId: 'turn-1', sequence: 1, name: 'get_customer_context', result: { status: 'SUCCEEDED', data: {}, evidence: [], stateChanges: [] } });
  await assert.rejects(() => bridge.decide(observation(2, [])), /DUPLICATE_ACTION/);
  await assert.rejects(() => bridge.decide(observation(1, [{ actionId: first.actionId, name: 'get_customer_context', status: 'SUCCEEDED', data: {}, evidence: [], stateChanges: [] }])), /REPLAY/);
});

test('rejects replay, correlation/sequence/turn/action mismatches, and duplicate actions', async () => {
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: model(tool()) });
  await bridge.decide(observation());
  await assert.rejects(() => bridge.decide(observation()), /PENDING_RESULT/);
  for (const [field, value, code] of [['sequence', 2, 'SEQUENCE_MISMATCH'], ['turnId', 'other', 'TURN_MISMATCH'], ['correlationId', 'corr', 'CORRELATION_MISMATCH'], ['actionId', 'act', 'ACTION_MISMATCH']] as const) {
    const fresh = new DemoTextToolBridge({ measureInput: inputMeasurement, model: model(tool(1, { [field]: value })) });
    await assert.rejects(() => fresh.decide(observation()), new RegExp(code));
  }
  const duplicate = new DemoTextToolBridge({ measureInput: inputMeasurement, model: model(tool(1)) });
  await duplicate.decide(observation());
  await assert.rejects(() => duplicate.decide(observation(2)), /PENDING_RESULT/);
});

test('rejects malformed, multi-object/prose/fenced, unknown, leaked, widened, and bypass output', async () => {
  const cases: Array<[string, RegExp]> = [
    ['{} {}', /PLAIN_JSON_OBJECT_REQUIRED|MALFORMED_JSON/],
    ['```json\n{}\n```', /PLAIN_JSON_OBJECT_REQUIRED/],
    ['prose ' + tool(), /PLAIN_JSON_OBJECT_REQUIRED/],
    [tool(1, { name: 'post_sales_order' }), /UNKNOWN_OR_UNAVAILABLE_CAPABILITY/],
    [tool(1, { arguments: { accountId: 'a', conversationId: 'c', customerId: 'dmo_abcdef123456' } }), /SECRET|SCHEMA/],
    [tool(1, { capabilityVersion: 'v2', arguments: { accountId: 'a', conversationId: 'c', customerId: 'u', scope: 'wider' } }), /CAPABILITY_VERSION|SCHEMA/],
    [JSON.stringify({ protocolVersion: 'v1', turnId: 'turn-1', sequence: 1, ...identity(1), kind: 'capability_result', name: 'get_customer_context', status: 'SUCCEEDED', result: { status: 'SUCCEEDED', data: {}, evidence: [], stateChanges: [] }, resultHash: '0'.repeat(64) }), /MODEL_RESULT_INVALID/],
    [tool().replace('"arguments":', '"__proto__":"x","arguments":'), /MODEL_OUTPUT_INVALID/],
    [JSON.stringify({ protocolVersion: 'v1', turnId: 'turn-1', sequence: 1, ...identity(1), kind: 'tool_call', tool: 'get_customer_context', input: { accountId: 'a', conversationId: 'c', customerId: 'u' } }), /MODEL_OUTPUT_INVALID|TOOL_FIELDS/],
  ];
  for (const [raw, expected] of cases) {
    const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: model(raw) });
    await assert.rejects(() => bridge.decide(observation()), expected);
  }
});

test('leaves business intent and next-tool selection to AI while retaining capability/schema authority', async () => {
  const project = (name:string) => { const d=getCapability(name)!; return {name:d.name,version:d.version,purpose:d.name,inputSchema:d.inputSchema,sideEffect:d.sideEffect,timeoutMs:d.timeout.perCallMs,idempotencyRequired:d.idempotency.required,outboundDisposition:d.outbound.disposition,evidenceMode:d.evidence.mode,groundingMode:d.grounding.mode}; };
  const yes:any={turnId:'turn-yes',sequence:1,context:{currentInboundMessage:{text:'Yes please.'},orderDraft:{id:'draft-1'},activeQuotationSalesOrder:{quotation:null,salesOrder:null}},availableCapabilities:[project('prepare_quotation'),project('get_order_history')],completedActions:[]};

  const finalChoice=new DemoTextToolBridge({measureInput:inputMeasurement,model:async prompt=>{const parsed=JSON.parse(prompt); assert.deepEqual(parsed.workflowState,{phase:'AI_FIRST'}); const e=parsed.expected; const text=JSON.stringify({protocolVersion:'v1',...e,kind:'final_response',responsePlan:{turnId:e.turnId,intent:'ACKNOWLEDGE',connectiveText:'I understand.',factClaims:[],outboundPurpose:'acknowledgement'}}); return{...measured(text),inputBudget:{direction:'input',bytes:Buffer.byteLength(prompt),tokenCount:1}};}});
  assert.equal((await finalChoice.decide(yes) as any).kind,'final_response');

  const toolChoice=new DemoTextToolBridge({measureInput:inputMeasurement,model:async prompt=>{const parsed=JSON.parse(prompt); assert.deepEqual(parsed.workflowState,{phase:'AI_FIRST'}); const e=parsed.expected; const text=JSON.stringify({protocolVersion:'v1',...e,kind:'tool_call',name:'prepare_quotation',arguments:{accountId:'a',conversationId:'c',customerId:'u',workItemId:'w',draftId:'d',draftRevision:1,expectedWorkItemRevision:1}}); return{...measured(text),inputBudget:{direction:'input',bytes:Buffer.byteLength(prompt),tokenCount:1}};}});
  const decision=await toolChoice.decide(yes); assert.equal(decision.kind,'tool_call'); assert.equal((decision as any).capabilityName,'prepare_quotation');

  const badSchema=new DemoTextToolBridge({measureInput:inputMeasurement,model:async prompt=>{const parsed=JSON.parse(prompt); const e=parsed.expected; const text=JSON.stringify({protocolVersion:'v1',...e,kind:'tool_call',name:'prepare_quotation',arguments:{customerId:'u'}}); return{...measured(text),inputBudget:{direction:'input',bytes:Buffer.byteLength(prompt),tokenCount:1}};}});
  await assert.rejects(()=>badSchema.decide(yes),/SCHEMA|ARGUMENT/);
});

test('requires measured byte and token budgets from the trusted model callback', async () => {
  let inputCalls = 0;
  let modelCalls = 0;
  const inputTokenOver = new DemoTextToolBridge({ measureInput: prompt => { inputCalls += 1; return { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 8_001 }; }, model: async () => { modelCalls += 1; return { ...measured(tool()), inputBudget: { direction: 'input', bytes: 0, tokenCount: 0 } }; } });
  const outputTokenOver = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => ({ text: tool(), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 }, outputBudget: { direction: 'output', bytes: Buffer.byteLength(tool()), tokenCount: 4_001 } }) });
  const inputByteOver = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => ({ text: tool(), inputBudget: { direction: 'input', bytes: 32 * 1024 + 1, tokenCount: 1 }, outputBudget: { direction: 'output', bytes: Buffer.byteLength(tool()), tokenCount: 1 } }) });
  const outputByteOver = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => ({ text: tool(), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 }, outputBudget: { direction: 'output', bytes: 16 * 1024 + 1, tokenCount: 1 } }) });
  await assert.rejects(() => inputTokenOver.decide(observation()), /BUDGET_EXCEEDED/);
  assert.equal(inputCalls, 1);
  assert.equal(modelCalls, 0);
  for (const bridge of [outputTokenOver, inputByteOver, outputByteOver]) await assert.rejects(() => bridge.decide(observation()), /BUDGET_EXCEEDED/);
  const wrong = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => ({ text: tool(), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt) + 1, tokenCount: 1 }, outputBudget: { direction: 'output', bytes: Buffer.byteLength(tool()), tokenCount: 1 } }) });
  await assert.rejects(() => wrong.decide(observation()), /INPUT_MEASUREMENT_MISMATCH/);
});

test('requires fixed budget directions before accepting a model decision', async () => {
  const wrongInputMeasurement = new DemoTextToolBridge({ measureInput: () => ({ direction: 'output', bytes: 1, tokenCount: 1 }), model: model(tool()) });
  await assert.rejects(() => wrongInputMeasurement.decide(observation()), /BUDGET_DIRECTION/);

  const wrongOutputDirection = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => ({
    text: tool(), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 },
    outputBudget: { direction: 'input', bytes: Buffer.byteLength(tool()), tokenCount: 4_001 },
  }) });
  await assert.rejects(() => wrongOutputDirection.decide(observation()), /BUDGET_DIRECTION/);
});

test('rejects model results that are not exact plain data objects', async () => {
  const cases: Array<() => unknown> = [
    () => Object.assign(Object.create(null), measured(tool())),
    () => Object.assign(Object.create({ inherited: true }), measured(tool())),
    () => ({ ...measured(tool()), extra: true }),
    () => ({ text: tool(), inputBudget: measured(tool()).inputBudget }),
    () => ({ ...measured(tool()), get text() { throw new Error('hostile getter'); } }),
    () => { const value = { ...measured(tool()) } as Record<string | symbol, unknown>; value[Symbol('hidden')] = true; return value; },
  ];
  for (const make of cases) {
    const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async () => make() as DemoTextModelResult });
    await assert.rejects(() => bridge.decide(observation()), /MODEL_OUTPUT_INVALID/);
  }
});

test('rejects duplicate JSON member keys instead of accepting last-wins parsing', async () => {
  const duplicate = tool().replace('"kind":"tool_call"', '"kind":"tool_call","kind":"final_response"');
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: model(duplicate) });
  await assert.rejects(() => bridge.decide(observation()), /DUPLICATE_JSON_KEY/);
});

test('blocks pending sequencing, terminal replay, and validates the exact capability projection', async () => {
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: model(tool()) });
  await bridge.decide(observation());
  await assert.rejects(() => bridge.decide(observation(2)), /PENDING_RESULT/);
  assert.throws(() => bridge.encodeHostCapabilityResult({ ...identity(1), turnId: 'turn-1', sequence: 1, correlationId: 'wrong', name: 'get_customer_context', result: { status: 'SUCCEEDED', data: {}, evidence: [], stateChanges: [] } }), /HOST_RESULT_CORRELATION/);

  const terminal = new DemoTextToolBridge({ measureInput: inputMeasurement, model: model(final()) });
  await terminal.decide(observation());
  await assert.rejects(() => terminal.decide(observation()), /TERMINAL/);

  for (const changed of [
    { ...projection, purpose: 'lied' },
    { ...projection, inputSchema: { ...projection.inputSchema, additionalProperties: true } },
    { ...projection, version: 'v2' },
    projection,
  ]) {
    const availableCapabilities = changed === projection ? [projection, projection] : [changed];
    const invalid = new DemoTextToolBridge({ measureInput: inputMeasurement, model: model(tool()) });
    await assert.rejects(() => invalid.decide({ ...observation(), availableCapabilities }), changed === projection ? /DUPLICATE/ : /CAPABILITY_(METADATA|SCHEMA|VERSION)|INVALID_AVAILABLE/);
  }
});

test('allows only an exact same-observation repair boundary and sanitizes model failures', async () => {
  let calls = 0;
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => { const text = calls++ === 0 ? '{}' : tool(); return { ...measured(text), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } }; } });
  await assert.rejects(() => bridge.decide(observation()), /MODEL_OUTPUT_INVALID|PLAIN_JSON/);
  await assert.rejects(() => bridge.decide({ ...observation(), context: { widened: true } }), /REPAIR_SCOPE_MISMATCH/);
  await assert.doesNotReject(() => bridge.decide(observation()));

  const exhausted = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => ({ ...measured('{}'), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } }) });
  await assert.rejects(() => exhausted.decide(observation()), /MODEL_OUTPUT_INVALID|PLAIN_JSON/);
  await assert.rejects(() => exhausted.decide(observation()), /MODEL_OUTPUT_INVALID|PLAIN_JSON/);
  await assert.rejects(() => exhausted.decide(observation()), /REPAIR_EXHAUSTED/);

  const secret = 'dmo_secret_api_key';
  const leaking = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => { void prompt; throw new Error(secret); } });
  await assert.rejects(() => leaking.decide(observation()), error => { assert.match(String(error), /MODEL_FAILED/); assert.doesNotMatch(String(error), new RegExp(secret)); return true; });
});

test('rejects secret-bearing observations before prompt construction', async () => {
  let modelCalls = 0;
  let capturedPrompt = '';
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => {
    modelCalls += 1;
    capturedPrompt = prompt;
    return { ...measured(tool()), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } };
  } });
  await assert.rejects(() => bridge.decide({ ...observation(), context: { note: 'dmo_secret_api_key' } }), /SECRET_VALUE|MODEL_OUTPUT_INVALID/);
  assert.equal(modelCalls, 0);
  assert.equal(capturedPrompt, '');
});

test('host result validation is fixed-class and does not echo hostile secrets', async () => {
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: model(tool()) });
  await bridge.decide(observation());
  const secret = 'host-result-secret-key';
  await assert.rejects(() => Promise.resolve().then(() => bridge.encodeHostCapabilityResult({ ...identity(1), turnId: 'turn-1', sequence: 1, name: 'get_customer_context', result: { status: 'SUCCEEDED', data: { apiKey: secret }, evidence: [], stateChanges: [] } })), error => {
    assert.match(String(error), /HOST_RESULT_INVALID/);
    assert.doesNotMatch(String(error), new RegExp(secret));
    return true;
  });
});

test('passes the immutable output ceiling unchanged to the model adapter', async () => {
  let request: unknown;
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async (prompt, options) => {
    request = options;
    return { ...measured(tool()), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } };
  } });
  await bridge.decide(observation());
  assert.deepEqual(request, { signal: undefined, maxOutputTokens: 4000 });
});

test('is parser-only: model callback is the only side effect', async () => {
  let calls = 0;
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => { calls += 1; assert.match(prompt, /"protocolVersion":"v1"/); return { ...measured(tool()), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } }; } });
  await bridge.decide(observation());
  assert.equal(calls, 1);
});

test('claims a turn before the model await and rejects a concurrent decision', async () => {
  let modelCalls = 0;
  let releaseModel!: (result: DemoTextModelResult) => void;
  const modelGate = new Promise<DemoTextModelResult>(resolve => { releaseModel = resolve; });
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => {
    modelCalls += 1;
    assert.equal(modelCalls, 1);
    return { ...(await modelGate), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } };
  } });

  const first = bridge.decide(observation());
  await assert.rejects(() => bridge.decide(observation()), /DECISION_IN_FLIGHT/);
  assert.equal(modelCalls, 1);

  releaseModel(measured(tool()));
  const decision = await first;
  assert.equal(decision.kind, 'tool_call');
  assert.equal(modelCalls, 1);
});

test('rejects a model result when aborted in flight without accepting action state', async () => {
  let modelCalls = 0;
  let modelStarted!: () => void;
  const started = new Promise<void>(resolve => { modelStarted = resolve; });
  let releaseModel!: () => void;
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
  const bridge = new DemoTextToolBridge({ measureInput: inputMeasurement, model: async prompt => {
    modelCalls += 1;
    if (modelCalls === 1) {
      modelStarted();
      await modelGate;
    }
    return { ...measured(tool()), inputBudget: { direction: 'input', bytes: Buffer.byteLength(prompt), tokenCount: 1 } };
  } });
  const controller = new AbortController();
  const pending = bridge.decide(observation(), controller.signal);
  await started;
  controller.abort();
  releaseModel();
  await assert.rejects(() => pending, /ABORTED/);

  const retry = await bridge.decide(observation());
  assert.equal(retry.kind, 'tool_call');
  assert.equal(modelCalls, 2);
});
