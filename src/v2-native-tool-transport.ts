import type { AssistantMessage, Context, Model, Tool } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { redactContextText } from './v2-context-projection.js';
import { canonicalJson } from './v2-canonical.js';
import { getCapability } from './v2-capability-registry.js';
import type { CapabilityDefinition } from './v2-capability-contracts.js';
import { validateCapabilityArgumentsForDefinition } from './v2-capability-schema.js';
import {
  deriveAgentDecisionIdentity,
  exactKeys,
  plainRecord,
  transportFail,
  validateTransportJson,
  canonicalTransportId,
  boundedTransportText,
} from './v2-transport-contract-helpers.js';
import {
  normalizeAgentDecision,
  normalizeAgentObservation,
  type AgentDecision,
  type AgentModelTransport,
  type AgentObservation,
} from './v2-agent-model-transport.js';
import { parseGroundedResponsePlan } from './v2-grounded-response-plan.js';

export type NativeToolTransportOptions = Readonly<{
  model: Model<any>;
  stream: StreamFn;
  systemPreamble?: string;
  id?: string;
}>;

const MAX_PREAMBLE = 2_000;
const MAX_OUTPUT = 16 * 1024;
const MAX_TOKENS = 4_096;
const projectionKeys = ['name', 'version', 'purpose', 'inputSchema', 'sideEffect', 'timeoutMs', 'idempotencyRequired', 'outboundDisposition', 'evidenceMode', 'groundingMode'] as const;

function fail(code: string): never { throw new Error(`NATIVE_TOOL_TRANSPORT_FAILED:${code}`); }

function definitionForProjection(value: unknown): CapabilityDefinition {
  const projection = plainRecord(value, 'CAPABILITY_PROJECTION');
  exactKeys(projection, projectionKeys, 'CAPABILITY_PROJECTION');
  if (typeof projection.name !== 'string' || typeof projection.version !== 'string' || typeof projection.purpose !== 'string') fail('CAPABILITY_PROJECTION_FIELDS');
  const definition = getCapability(projection.name);
  if (!definition || definition.name !== projection.name) fail('UNKNOWN_OR_UNAVAILABLE_CAPABILITY');
  if (projection.version !== definition.version) fail('CAPABILITY_VERSION_MISMATCH');
  if (canonicalJson(projection.inputSchema) !== canonicalJson(definition.inputSchema)) fail('CAPABILITY_SCHEMA_MISMATCH');
  if (projection.purpose !== definition.name || projection.sideEffect !== definition.sideEffect || projection.timeoutMs !== definition.timeout.perCallMs || projection.idempotencyRequired !== definition.idempotency.required || projection.outboundDisposition !== definition.outbound.disposition || projection.evidenceMode !== definition.evidence.mode || projection.groundingMode !== definition.grounding.mode) fail('CAPABILITY_METADATA_MISMATCH');
  return definition;
}

function allowedDefinitions(observation: AgentObservation): CapabilityDefinition[] {
  if (!Array.isArray(observation.availableCapabilities)) fail('CAPABILITIES_NOT_ARRAY');
  const seen = new Set<string>();
  const definitions = observation.availableCapabilities.map(entry => {
    const definition = definitionForProjection(entry);
    if (seen.has(definition.name)) fail('DUPLICATE_CAPABILITY');
    seen.add(definition.name);
    return definition;
  });
  return definitions;
}

function systemPrompt(preamble?: string): string {
  if (preamble !== undefined) {
    if (typeof preamble !== 'string' || preamble.length > MAX_PREAMBLE) fail('SYSTEM_PREAMBLE');
    if (redactContextText(preamble) !== preamble) fail('SYSTEM_PREAMBLE_SECRET');
    const safe = preamble.trim();
    if (safe.length > MAX_PREAMBLE) fail('SYSTEM_PREAMBLE');
    return `${safe ? `${safe}\n\n` : ''}Return exactly one next V2 decision: one native tool call or one grounded final-response JSON object. The host alone executes capabilities.`;
  }
  return 'Return exactly one next V2 decision: one native tool call or one grounded final-response JSON object. The host alone executes capabilities.';
}

function tool(definition: CapabilityDefinition): Tool<any> {
  return { name: definition.name, description: definition.name, parameters: definition.inputSchema as any };
}

function ownData(value: object, code: string): Record<string, unknown> {
  if (Object.getPrototypeOf(value) !== Object.prototype) fail(`${code}_PROTOTYPE`);
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${code}_KEY`);
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d) || !d.enumerable) fail(`${code}_DESCRIPTOR`);
    out[key] = d.value;
  }
  return out;
}
function providerOpaque(value: unknown, code: string, max = 16 * 1024): string {
  if (typeof value !== 'string' || value.length > max) fail(code);
  return value;
}
function parseAssistantSurface(input: unknown): { stopReason: string; content: Array<Record<string, unknown>> } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('ASSISTANT_MESSAGE');
  const message = ownData(input, 'ASSISTANT_MESSAGE');
  if (message.role !== 'assistant' || typeof message.stopReason !== 'string' || !['stop', 'toolUse', 'error', 'aborted', 'length', 'deferred'].includes(message.stopReason)) fail('ASSISTANT_MESSAGE_FIELDS');
  if (!Array.isArray(message.content) || Object.getPrototypeOf(message.content) !== Array.prototype) fail('ASSISTANT_CONTENT');
  if (Reflect.ownKeys(message.content).some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) fail('ASSISTANT_CONTENT_KEY');
  const content: Array<Record<string, unknown>> = [];
  for (let i = 0; i < message.content.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(message.content, String(i))) fail('ASSISTANT_CONTENT_SPARSE');
    const partDescriptor = Object.getOwnPropertyDescriptor(message.content, String(i));
    if (!partDescriptor || !('value' in partDescriptor)) fail('ASSISTANT_CONTENT_ACCESSOR');
    const part = ownData(partDescriptor.value as object, `ASSISTANT_CONTENT_${i}`);
    const type = part.type;
    if (type === 'text') {
      if (Object.keys(part).some(key => !['type', 'text', 'textSignature'].includes(key)) || typeof part.text !== 'string' || ('textSignature' in part && typeof part.textSignature !== 'string')) fail('ASSISTANT_TEXT');
      boundedTransportText(part.text, 'PROVIDER_TEXT', MAX_OUTPUT);
      if (part.textSignature !== undefined) providerOpaque(part.textSignature, 'PROVIDER_TEXT_SIGNATURE');
    }
    else if (type === 'thinking') {
      if (Object.keys(part).some(key => !['type', 'thinking', 'thinkingSignature', 'redacted'].includes(key)) || typeof part.thinking !== 'string' || ('thinkingSignature' in part && typeof part.thinkingSignature !== 'string') || ('redacted' in part && typeof part.redacted !== 'boolean')) fail('ASSISTANT_THINKING');
      providerOpaque(part.thinking, 'PROVIDER_THINKING', MAX_OUTPUT);
      if (part.thinkingSignature !== undefined) providerOpaque(part.thinkingSignature, 'PROVIDER_THINKING_SIGNATURE');
    }
    else if (type === 'toolCall') { if (Object.keys(part).some(key => !['type', 'id', 'name', 'arguments', 'namespace', 'thoughtSignature'].includes(key)) || typeof part.id !== 'string' || typeof part.name !== 'string' || !('arguments' in part) || ('namespace' in part && typeof part.namespace !== 'string') || ('thoughtSignature' in part && typeof part.thoughtSignature !== 'string')) fail('ASSISTANT_TOOL'); boundedTransportText(part.id, 'PROVIDER_TOOL_ID', 256); boundedTransportText(part.name, 'PROVIDER_TOOL_NAME', 256); if (part.namespace !== undefined && part.namespace !== '') boundedTransportText(part.namespace, 'PROVIDER_NAMESPACE', 256); if (part.thoughtSignature !== undefined) providerOpaque(part.thoughtSignature, 'PROVIDER_THOUGHT_SIGNATURE'); validateTransportJson(part.arguments, 'TOOL_ARGUMENTS', true, 16_384); }
    else fail('ASSISTANT_UNKNOWN_CONTENT');
    content.push(part);
  }
  return { stopReason: message.stopReason, content };
}
function assistantFromStream(stream: Awaited<ReturnType<StreamFn>>): Promise<AssistantMessage> {
  return stream.result();
}

function parseAssistant(message: AssistantMessage, observation: AgentObservation, definitions: readonly CapabilityDefinition[]): AgentDecision {
  const surface = parseAssistantSurface(message);
  if (surface.stopReason === 'error' || surface.stopReason === 'aborted' || surface.stopReason === 'length' || surface.stopReason === 'deferred') fail('MODEL_STOP_REASON');
  const calls = surface.content.filter(part => part.type === 'toolCall');
  const textBlocks = surface.content.filter(part => part.type === 'text') as Array<{ type: 'text'; text: string }>;
  const text = textBlocks.map(part => part.text).join('');
  const identity = deriveAgentDecisionIdentity(observation.turnId, observation.sequence);
  if (calls.length > 0) {
    if (surface.stopReason !== 'toolUse') fail('TOOL_STOP_REASON');
    if (calls.length !== 1 || text.trim() !== '') fail(calls.length !== 1 ? 'MULTIPLE_TOOL_CALLS' : 'MIXED_TEXT_AND_TOOL');
    const call = calls[0];
    if (call.namespace !== undefined && call.namespace !== '') fail('NAMESPACE');
    const definition = definitions.find(candidate => candidate.name === call.name);
    if (!definition) fail('UNKNOWN_OR_UNAVAILABLE_CAPABILITY');
    validateTransportJson(call.arguments, 'TOOL_ARGUMENTS', true, 16_384);
    const args = validateCapabilityArgumentsForDefinition(definition, call.arguments);
    return normalizeAgentDecision({ kind: 'tool_call', turnId: observation.turnId, sequence: observation.sequence, ...identity, capabilityName: definition.name, capabilityVersion: definition.version, arguments: args });
  }
  if (surface.stopReason !== 'stop') fail('FINAL_STOP_REASON');
  if (textBlocks.length !== 1 || text.trim() === '' || Buffer.byteLength(text, 'utf8') > MAX_OUTPUT) fail('FINAL_TEXT');
  const responsePlan = parseGroundedResponsePlan(text, observation.turnId);
  return normalizeAgentDecision({ kind: 'final_response', turnId: observation.turnId, sequence: observation.sequence, ...identity, responsePlan });
}

export class NativeToolTransport implements AgentModelTransport {
  readonly id: string;
  readonly mode = 'native-tools' as const;
  private readonly model: Model<any>;
  private readonly stream: StreamFn;
  private readonly preamble?: string;

  constructor(options: NativeToolTransportOptions) {
    this.model = options.model;
    this.stream = options.stream;
    this.preamble = options.systemPreamble;
    this.id = options.id === undefined ? 'native-tools' : canonicalTransportId(options.id, 'TRANSPORT_ID', 160);
  }

  async decide(input: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    if (signal?.aborted) fail('ABORTED');
    const observation = normalizeAgentObservation(input);
    const definitions = allowedDefinitions(observation);
    const context: Context = {
      systemPrompt: systemPrompt(this.preamble),
      messages: [{ role: 'user', content: canonicalJson(observation), timestamp: 0 }],
      tools: definitions.map(tool),
    };
    let response: Awaited<ReturnType<StreamFn>>;
    try { response = await this.stream(this.model, context, { signal, toolChoice: 'auto', maxTokens: MAX_TOKENS }); }
    catch { fail('MODEL_FAILED'); }
    if (signal?.aborted) fail('ABORTED');
    let message: AssistantMessage;
    try { message = await assistantFromStream(response!); }
    catch { fail('MODEL_FAILED'); }
    if (signal?.aborted) fail('ABORTED');
    return parseAssistant(message!, observation, definitions);
  }
}

export { NativeToolTransport as V2NativeToolTransport };
