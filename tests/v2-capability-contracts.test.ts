import assert from 'node:assert/strict';
import test from 'node:test';
import * as contracts from '../src/v2-capability-contracts.js';
import { defineCapability, validateCapabilityDefinition, type CapabilityDefinition } from '../src/v2-capability-contracts.js';

const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } as const;
const base = (overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition => ({
  name: 'read_customer_context', version: 'v1', inputSchema: schema, outputSchema: schema,
  permission: { identifier: 'customer.context.read', policy: 'DECLARATIVE' }, scope: { required: ['account', 'conversation'] }, sideEffect: 'READ_ONLY', timeout: { perCallMs: 5000 },
  idempotency: { required: false, keyScope: 'ACCOUNT_CONVERSATION', replay: 'RETURN_PRIOR_RESULT' }, evidence: { mode: 'REQUIRED', canonicalRefs: 'REQUIRED' }, outbound: { disposition: 'NONE', owner: 'NONE', customerMessage: false }, grounding: { mode: 'REQUIRED', protectedFactSlots: ['customer_identity'], requiresCanonicalRefs: true }, ...overrides
});
const rejects = (value: unknown, pattern: RegExp) => assert.throws(() => validateCapabilityDefinition(value), pattern);

test('accepts read-only and workspace-mutating definitions with required idempotency', () => {
  assert.equal(defineCapability(base()).name, 'read_customer_context');
  assert.equal(defineCapability(base({ name: 'update_order_draft', sideEffect: 'WORKSPACE_MUTATION', idempotency: { required: true, keyScope: 'CAPABILITY_SCOPE', replay: 'REJECT_CONFLICT' }, grounding: { mode: 'OPTIONAL', protectedFactSlots: [], requiresCanonicalRefs: false } })).sideEffect, 'WORKSPACE_MUTATION');
});

test('accepts coherent quotation ownership and handoff dispositions', () => {
  assert.equal(defineCapability(base({ name: 'send_quotation', sideEffect: 'CANONICAL_COMMERCE_MUTATION', idempotency: { required: true, keyScope: 'CAPABILITY_SCOPE', replay: 'RETURN_PRIOR_RESULT' }, outbound: { disposition: 'CAPABILITY_OWNED_QUOTATION', owner: 'QUOTATION_CAPABILITY', customerMessage: true, quotationOwnership: 'SOLE_QUOTATION_OUTBOUND_OWNER' }, grounding: { mode: 'OPTIONAL', protectedFactSlots: ['quotation_total'], requiresCanonicalRefs: true } })).outbound.disposition, 'CAPABILITY_OWNED_QUOTATION');
  assert.equal(defineCapability(base({ name: 'request_human_handoff', sideEffect: 'WORKSPACE_MUTATION', idempotency: { required: true, keyScope: 'CAPABILITY_SCOPE', replay: 'REJECT_CONFLICT' }, outbound: { disposition: 'HANDOFF_NO_CUSTOMER_MESSAGE', owner: 'HANDOFF', customerMessage: false, handoffReasonRequired: true } })).outbound.disposition, 'HANDOFF_NO_CUSTOMER_MESSAGE');
});

test('requires typed inline schemas and rejects remote references', () => {
  assert.equal(defineCapability(base({ inputSchema: { type: 'string' }, outputSchema: { type: 'array', items: { type: 'integer' } } })).inputSchema.type, 'string');
  rejects(base({ inputSchema: {} as never }), /inputSchema_INVALID_TYPE/);
  rejects(base({ outputSchema: {} as never }), /outputSchema_INVALID_TYPE/);
  rejects(base({ inputSchema: { $ref: 'https://evil.invalid/schema.json' } as never }), /inputSchema_UNKNOWN_FIELD_\$ref/);
  rejects(base({ inputSchema: { type: 'string', properties: {} } as never }), /inputSchema_OBJECT_KEYWORDS_REQUIRE_OBJECT/);
  rejects(base({ inputSchema: { type: 'array' } as never }), /inputSchema_ARRAY_REQUIRES_ITEMS/);
  rejects(base({ inputSchema: { type: 'string', enum: [] } as never }), /inputSchema_INVALID_ENUM/);
  rejects(base({ inputSchema: { type: 'string', enum: ['A', 'A'] } as never }), /inputSchema_INVALID_ENUM/);
  rejects(base({ inputSchema: { type: 'string', enum: [1] } as never }), /inputSchema_ENUM_TYPE_MISMATCH/);
  rejects(base({ inputSchema: { type: 'object', required: ['value', 'value'] } as never }), /inputSchema_INVALID_REQUIRED/);
  rejects(base({ inputSchema: { type: 'object', required: ['missing'], additionalProperties: false } as never }), /inputSchema_REQUIRED_PROPERTY_NOT_DECLARED/);
});

test('enforces evidence and grounding coherence', () => {
  rejects(base({ evidence: { mode: 'NONE', canonicalRefs: 'REQUIRED' } }), /EVIDENCE_NONE_CANNOT_HAVE_CANONICAL_REFS/);
  rejects(base({ grounding: { mode: 'NONE', protectedFactSlots: ['price'], requiresCanonicalRefs: false } }), /GROUNDING_NONE_CANNOT_REQUIRE_FACTS/);
  rejects(base({ grounding: { mode: 'NONE', protectedFactSlots: [], requiresCanonicalRefs: true } }), /GROUNDING_NONE_CANNOT_REQUIRE_FACTS/);
  rejects(base({ grounding: { mode: 'OPTIONAL', protectedFactSlots: ['   '], requiresCanonicalRefs: false } }), /INVALID_GROUNDING/);
  rejects(base({ grounding: { mode: 'REQUIRED', protectedFactSlots: ['price'], requiresCanonicalRefs: false } }), /GROUNDING_REQUIRES_CANONICAL_EVIDENCE/);
  assert.equal(defineCapability(base({ grounding: { mode: 'REQUIRED', protectedFactSlots: ['price'], requiresCanonicalRefs: true }, evidence: { mode: 'REQUIRED', canonicalRefs: 'REQUIRED' } })).grounding.mode, 'REQUIRED');
  rejects(base({ grounding: { mode: 'REQUIRED', protectedFactSlots: ['price'], requiresCanonicalRefs: true }, evidence: { mode: 'OPTIONAL', canonicalRefs: 'REQUIRED' } }), /GROUNDING_REQUIRES_CANONICAL_EVIDENCE/);
  rejects(base({ grounding: { mode: 'OPTIONAL', protectedFactSlots: ['price'], requiresCanonicalRefs: true }, evidence: { mode: 'OPTIONAL', canonicalRefs: 'OPTIONAL' } }), /GROUNDING_REQUIRES_CANONICAL_REFS/);
  assert.equal(defineCapability(base({ grounding: { mode: 'OPTIONAL', protectedFactSlots: ['price'], requiresCanonicalRefs: true }, evidence: { mode: 'OPTIONAL', canonicalRefs: 'REQUIRED' } })).evidence.canonicalRefs, 'REQUIRED');
});

test('fails closed for outbound branch-mixture metadata', () => {
  rejects(base({ outbound: { disposition: 'NONE', owner: 'NONE', customerMessage: false, quotationOwnership: 'SOLE_QUOTATION_OUTBOUND_OWNER' } } as never), /outbound_UNKNOWN_FIELD_quotationOwnership/);
  rejects(base({ outbound: { disposition: 'RUNTIME_RESPONSE', owner: 'RUNTIME', customerMessage: true, handoffReasonRequired: true } } as never), /outbound_UNKNOWN_FIELD_handoffReasonRequired/);
  rejects(base({ outbound: { disposition: 'HANDOFF_NO_CUSTOMER_MESSAGE', owner: 'HANDOFF', customerMessage: false, handoffReasonRequired: true, quotationOwnership: 'SOLE_QUOTATION_OUTBOUND_OWNER' } } as never), /outbound_UNKNOWN_FIELD_quotationOwnership/);
  rejects(base({ sideEffect: 'CANONICAL_COMMERCE_MUTATION', idempotency: { required: true, keyScope: 'CAPABILITY_SCOPE', replay: 'RETURN_PRIOR_RESULT' }, outbound: { disposition: 'CAPABILITY_OWNED_QUOTATION', owner: 'QUOTATION_CAPABILITY', customerMessage: true, quotationOwnership: 'SOLE_QUOTATION_OUTBOUND_OWNER', handoffReasonRequired: true } } as never), /outbound_UNKNOWN_FIELD_handoffReasonRequired/);
});

test('exported JsonSchema is the supported inline subset', () => {
  const schema: contracts.JsonSchema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
  assert.equal(schema.type, 'object');
  rejects(base({ inputSchema: { type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema' } as never }), /inputSchema_UNKNOWN_FIELD_\$schema/);
  rejects(base({ inputSchema: { type: 'object', $ref: '#\/local' } as never }), /inputSchema_UNKNOWN_FIELD_\$ref/);
});

test('uses closed-world metadata and coherent revision scope', () => {
  rejects(base({ promptAuthority: 'ALLOW' } as never), /definition_UNKNOWN_FIELD_promptAuthority/);
  rejects(base({ staffEndpoint: '/api/staff/post' } as never), /definition_UNKNOWN_FIELD_staffEndpoint/);
  rejects(base({ permission: { identifier: 'customer.context.read', policy: 'DECLARATIVE', promptAuthority: 'ALLOW' } as never }), /permission_UNKNOWN_FIELD_promptAuthority/);
  rejects(base({ scope: { required: ['account', 'conversation', 'revision'] } }), /REVISION_SCOPE_REQUIRES_REVISION_ENTITY/);
  assert.equal(defineCapability(base({ scope: { required: ['account', 'conversation', 'draft', 'revision'] } })).scope.required.includes('revision'), true);
  rejects(base({ outbound: { disposition: 'NONE', owner: 'NONE', customerMessage: false, staffEndpoint: '/api/staff/post' } as never }), /outbound_UNKNOWN_FIELD_staffEndpoint/);
});

test('fails closed for malformed metadata, schemas, timeout, idempotency, evidence, grounding, outbound, and enums', () => {
  rejects(base({ name: 'Bad Name' }), /INVALID_NAME/); rejects(base({ version: 'v0' }), /INVALID_VERSION/); rejects(base({ permission: { identifier: '', policy: 'DECLARATIVE' } }), /INVALID_PERMISSION/); rejects(base({ inputSchema: undefined as never }), /inputSchema/); rejects(base({ timeout: { perCallMs: 0 } }), /INVALID_TIMEOUT/); rejects(base({ timeout: { perCallMs: Number.MAX_SAFE_INTEGER + 1 } }), /INVALID_TIMEOUT/); rejects(base({ sideEffect: 'WORKSPACE_MUTATION', idempotency: { required: false, keyScope: 'ACCOUNT_CONVERSATION', replay: 'RETURN_PRIOR_RESULT' } }), /MUTATION_REQUIRES_IDEMPOTENCY/); rejects(base({ grounding: { mode: 'REQUIRED', protectedFactSlots: [], requiresCanonicalRefs: true }, evidence: { mode: 'OPTIONAL', canonicalRefs: 'REQUIRED' } }), /GROUNDING_REQUIRES_CANONICAL_EVIDENCE/); rejects(base({ outbound: { disposition: 'CAPABILITY_OWNED_QUOTATION', owner: 'RUNTIME', customerMessage: true, quotationOwnership: 'SOLE_QUOTATION_OUTBOUND_OWNER' } as never, sideEffect: 'CANONICAL_COMMERCE_MUTATION', idempotency: { required: true, keyScope: 'CAPABILITY_SCOPE', replay: 'RETURN_PRIOR_RESULT' } }), /INVALID_QUOTATION_OUTBOUND/); rejects(base({ sideEffect: 'NOT_SUPPORTED' as never }), /INVALID_SIDE_EFFECT/); rejects(base({ outbound: { disposition: 'NOT_SUPPORTED' } as never }), /INVALID_OUTBOUND_DISPOSITION/); rejects(base({ inputSchema: { type: 'wat' } as never }), /inputSchema_INVALID_TYPE/);
});

test('metadata is JSON data, immutable, and contains no authority or forbidden employee path', () => {
  const definition = defineCapability(base());
  assert.equal(JSON.stringify(definition).includes('function'), false); assert.equal(Object.isFrozen(definition), true); assert.equal(Object.isFrozen(definition.permission), true);
  rejects(base({ name: 'execute_sql' }), /INVALID_NAME/); rejects(base({ name: 'post_sales_order' }), /INVALID_NAME/); rejects(base({ permission: { identifier: 'x', policy: 'PROMPT' as never } }), /INVALID_PERMISSION/); rejects(base({ inputSchema: { type: 'object', x: (() => 1) as never } as never }), /MUST_BE_JSON/);
  rejects(base({ outbound: { disposition: 'HANDOFF_NO_CUSTOMER_MESSAGE', owner: 'HANDOFF', customerMessage: false, handoffReasonRequired: true } as never }), /HANDOFF_REQUIRES_WORKSPACE_MUTATION/);
  assert.equal('register' in contracts, false); assert.equal('invoke' in contracts, false);
});

test('rejects accessors and closed-world metadata without invoking getters', () => {
  let getterCalls = 0;
  const topLevel = base() as Record<string, unknown>;
  Object.defineProperty(topLevel, 'sideEffect', { enumerable: true, get: () => { getterCalls += 1; return 'READ_ONLY'; } });
  rejects(topLevel, /MUST_BE_JSON/); assert.equal(getterCalls, 0);

  const nested = base({ permission: { identifier: 'x', policy: 'DECLARATIVE' } }) as Record<string, unknown>;
  Object.defineProperty((nested.permission as Record<string, unknown>), 'secret', { enumerable: true, get: () => { getterCalls += 1; return 'x'; } });
  rejects(nested, /MUST_BE_JSON/); assert.equal(getterCalls, 0);

  const hidden = base() as Record<string, unknown>;
  Object.defineProperty(hidden, 'promptAuthority', { enumerable: false, value: 'ALLOW' });
  rejects(hidden, /MUST_BE_JSON/);
  const symbolKey = base() as Record<string | symbol, unknown>;
  symbolKey[Symbol('authority')] = 'ALLOW';
  rejects(symbolKey, /SYMBOL_KEY_NOT_ALLOWED/);
});

test('accepts ordinary JSON arrays and objects, freezes them, and rejects non-JSON arrays', () => {
  const accepted = defineCapability(base({ scope: { required: ['account', 'conversation', 'draft', 'revision'] } }));
  assert.equal(Object.isFrozen(accepted.scope.required), true);
  assert.equal(Object.isFrozen(accepted.inputSchema.properties?.value), true);

  const sparse = ['account', , 'conversation'];
  rejects(base({ scope: { required: sparse as never } }), /MUST_BE_JSON/);
  const accessorArray = ['account', 'conversation'];
  Object.defineProperty(accessorArray, '1', { enumerable: true, get: () => 'conversation' });
  rejects(base({ scope: { required: accessorArray as never } }), /MUST_BE_JSON/);
  const customArray = ['account', 'conversation'];
  Object.setPrototypeOf(customArray, { ...Array.prototype });
  rejects(base({ scope: { required: customArray as never } }), /MUST_BE_JSON/);
});

test('deep-freezes descendants when an ancestor is already frozen', () => {
  const preFrozenRoot = base();
  Object.freeze(preFrozenRoot);
  const frozen = defineCapability(preFrozenRoot);
  assert.equal(Object.isFrozen(frozen.permission), true);
  assert.equal(Object.isFrozen(frozen.scope), true);
  assert.equal(Object.isFrozen(frozen.scope.required), true);

  const nestedParent = { nested: { type: 'string' as const } };
  Object.freeze(nestedParent);
  const definition = base({
    inputSchema: { type: 'object', properties: nestedParent },
    outputSchema: { type: 'object', properties: nestedParent },
  });
  const nestedFrozen = defineCapability(definition);
  assert.equal(Object.isFrozen(nestedFrozen.inputSchema.properties), true);
  assert.equal(Object.isFrozen(nestedFrozen.inputSchema.properties?.nested), true);
});

test('requires capability-scoped idempotency for mutations while read-only remains flexible', () => {
  rejects(base({ sideEffect: 'WORKSPACE_MUTATION', idempotency: { required: true, keyScope: 'ACCOUNT_CONVERSATION', replay: 'REJECT_CONFLICT' }, grounding: { mode: 'OPTIONAL', protectedFactSlots: [], requiresCanonicalRefs: false } }), /MUTATION_REQUIRES_CAPABILITY_SCOPE/);
  assert.equal(defineCapability(base({ sideEffect: 'WORKSPACE_MUTATION', idempotency: { required: true, keyScope: 'CAPABILITY_SCOPE', replay: 'REJECT_CONFLICT' }, grounding: { mode: 'OPTIONAL', protectedFactSlots: [], requiresCanonicalRefs: false } })).idempotency.keyScope, 'CAPABILITY_SCOPE');
  assert.equal(defineCapability(base({ idempotency: { required: false, keyScope: 'ACCOUNT_CONVERSATION', replay: 'RETURN_PRIOR_RESULT' } })).idempotency.keyScope, 'ACCOUNT_CONVERSATION');
});

test('rejects obvious staff action aliases', () => {
  for (const name of ['sales_order_post', 'sales_order_confirm', 'delivery_order_create', 'delivery_order_ready', 'post_sales_order', 'confirm_sales_order', 'create_delivery_order', 'DO_READY']) rejects(base({ name }), /INVALID_NAME/);
});
