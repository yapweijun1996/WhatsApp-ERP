/**
 * Host-owned capability metadata. This is deliberately a contract only:
 * CAP-002 owns registration and later tasks own authorization and invocation.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonSchema = {
  readonly type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  readonly properties?: { readonly [key: string]: JsonSchema };
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly enum?: readonly JsonPrimitive[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
};

export type CapabilityScopeDimension =
  | 'account'
  | 'conversation'
  | 'customer'
  | 'workItem'
  | 'draft'
  | 'revision'
  | 'canonical-commerce';

export type CapabilityScope = {
  readonly required: readonly CapabilityScopeDimension[];
};

export type CapabilitySideEffect =
  | 'READ_ONLY'
  | 'WORKSPACE_MUTATION'
  | 'CANONICAL_COMMERCE_MUTATION';

export type CapabilityIdempotencyPolicy = {
  readonly required: boolean;
  readonly keyScope: 'ACCOUNT_CONVERSATION' | 'CAPABILITY_SCOPE';
  readonly replay: 'RETURN_PRIOR_RESULT' | 'REJECT_CONFLICT';
};

export type CapabilityEvidencePolicy = {
  readonly mode: 'NONE' | 'OPTIONAL' | 'REQUIRED';
  readonly canonicalRefs: 'FORBIDDEN' | 'OPTIONAL' | 'REQUIRED';
};

export type CapabilityGroundingPolicy = {
  readonly mode: 'NONE' | 'OPTIONAL' | 'REQUIRED';
  readonly protectedFactSlots: readonly string[];
  readonly requiresCanonicalRefs: boolean;
};

export type TurnOutboundDisposition =
  | 'RUNTIME_RESPONSE'
  | 'CAPABILITY_OWNED_QUOTATION'
  | 'HANDOFF_NO_CUSTOMER_MESSAGE'
  | 'NONE';

export type CapabilityOutboundContract =
  | { readonly disposition: 'RUNTIME_RESPONSE'; readonly owner: 'RUNTIME'; readonly customerMessage: true }
  | { readonly disposition: 'CAPABILITY_OWNED_QUOTATION'; readonly owner: 'QUOTATION_CAPABILITY'; readonly customerMessage: true; readonly quotationOwnership: 'SOLE_QUOTATION_OUTBOUND_OWNER' }
  | { readonly disposition: 'HANDOFF_NO_CUSTOMER_MESSAGE'; readonly owner: 'HANDOFF'; readonly customerMessage: false; readonly handoffReasonRequired: true }
  | { readonly disposition: 'NONE'; readonly owner: 'NONE'; readonly customerMessage: false };

export type CapabilityDefinition = {
  readonly name: string;
  readonly version: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly permission: { readonly identifier: string; readonly policy: 'DECLARATIVE' };
  readonly scope: CapabilityScope;
  readonly sideEffect: CapabilitySideEffect;
  readonly timeout: { readonly perCallMs: number };
  readonly idempotency: CapabilityIdempotencyPolicy;
  readonly evidence: CapabilityEvidencePolicy;
  readonly outbound: CapabilityOutboundContract;
  readonly grounding: CapabilityGroundingPolicy;
};

const DIMENSIONS: readonly CapabilityScopeDimension[] = ['account', 'conversation', 'customer', 'workItem', 'draft', 'revision', 'canonical-commerce'];
const SIDE_EFFECTS: readonly CapabilitySideEffect[] = ['READ_ONLY', 'WORKSPACE_MUTATION', 'CANONICAL_COMMERCE_MUTATION'];
const OUTBOUND_DISPOSITIONS: readonly TurnOutboundDisposition[] = ['RUNTIME_RESPONSE', 'CAPABILITY_OWNED_QUOTATION', 'HANDOFF_NO_CUSTOMER_MESSAGE', 'NONE'];
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
// This is only a small canonical explicit-name guard. It is not a semantic
// authorization classifier; the employee registry is the closed allowlist.
const FORBIDDEN_NAMES = /(^|_)(execute_sql|sql|stock_mutat(e|ion)|price_override|post_sales_order|confirm_sales_order|create_delivery_order|do_ready|sales_order_post|sales_order_confirm|delivery_order_create|delivery_order_ready)(_|$)/i;
const MAX_TIMEOUT_MS = 120_000;
const DEFINITION_KEYS = ['name', 'version', 'inputSchema', 'outputSchema', 'permission', 'scope', 'sideEffect', 'timeout', 'idempotency', 'evidence', 'outbound', 'grounding'];
const PERMISSION_KEYS = ['identifier', 'policy'];
const SCOPE_KEYS = ['required'];
const TIMEOUT_KEYS = ['perCallMs'];
const IDEMPOTENCY_KEYS = ['required', 'keyScope', 'replay'];
const EVIDENCE_KEYS = ['mode', 'canonicalRefs'];
const OUTBOUND_KEYS = ['disposition', 'owner', 'customerMessage', 'quotationOwnership', 'handoffReasonRequired'];
const GROUNDING_KEYS = ['mode', 'protectedFactSlots', 'requiresCanonicalRefs'];
const SCHEMA_KEYS = ['type', 'properties', 'required', 'items', 'additionalProperties', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'];
const OUTBOUND_KEYS_BY_DISPOSITION: Record<TurnOutboundDisposition, readonly string[]> = {
  RUNTIME_RESPONSE: ['disposition', 'owner', 'customerMessage'],
  CAPABILITY_OWNED_QUOTATION: ['disposition', 'owner', 'customerMessage', 'quotationOwnership'],
  HANDOFF_NO_CUSTOMER_MESSAGE: ['disposition', 'owner', 'customerMessage', 'handoffReasonRequired'],
  NONE: ['disposition', 'owner', 'customerMessage'],
};

function fail(message: string): never { throw new Error(`INVALID_CAPABILITY_DEFINITION:${message}`); }

function assertPlainRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${field}_MUST_BE_PLAIN_OBJECT`);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${field}_SYMBOL_KEY_NOT_ALLOWED`);
    if (!allowed.includes(key)) fail(`${field}_UNKNOWN_FIELD_${key}`);
  }
}

function assertOrdinaryData(value: object, field: string): void {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string') fail(`${field}_SYMBOL_KEY_NOT_ALLOWED`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(`${field}_MUST_BE_JSON`);
  }
}

function assertJson(value: unknown, field: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(`${field}_MUST_BE_JSON`); return; }
  if (typeof value === 'function' || typeof value === 'undefined' || typeof value === 'bigint' || typeof value === 'symbol') fail(`${field}_MUST_BE_JSON`);
  if (typeof value !== 'object') fail(`${field}_MUST_BE_JSON`);
  if (seen.has(value)) fail(`${field}_MUST_NOT_BE_CIRCULAR`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${field}_MUST_BE_JSON`);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.enumerable || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) fail(`${field}_MUST_BE_JSON`);
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(`${field}[${index}]_MUST_BE_JSON`);
      assertJson(descriptor.value, `${field}[${index}]`, seen);
    }
    for (const key of keys) if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) fail(`${field}_MUST_BE_JSON`);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail(`${field}_MUST_BE_JSON`);
    assertOrdinaryData(value, field);
    for (const key of Reflect.ownKeys(value)) assertJson((Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor).value, `${field}.${String(key)}`, seen);
  }
  seen.delete(value);
}

function validateSchema(value: unknown, field: string, seen = new Set<object>()): void {
  assertPlainRecord(value, field);
  assertJson(value, field);
  assertKnownKeys(value, SCHEMA_KEYS, field);
  if (seen.has(value)) fail(`${field}_MUST_NOT_BE_CIRCULAR`);
  seen.add(value);
  if (typeof value.type !== 'string' || !SCHEMA_TYPES.has(value.type)) fail(`${field}_INVALID_TYPE`);
  const schemaType = value.type;
  if (schemaType !== 'object' && ['properties', 'required', 'additionalProperties'].some(key => key in value)) fail(`${field}_OBJECT_KEYWORDS_REQUIRE_OBJECT`);
  if (schemaType !== 'array' && 'items' in value) fail(`${field}_ITEMS_REQUIRE_ARRAY`);
  if (schemaType === 'array' && !('items' in value)) fail(`${field}_ARRAY_REQUIRES_ITEMS`);
  if ('properties' in value) {
    assertPlainRecord(value.properties, `${field}.properties`);
    for (const [key, schema] of Object.entries(value.properties)) { if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) fail(`${field}_INVALID_PROPERTY_NAME`); validateSchema(schema, `${field}.properties.${key}`, seen); }
  }
  if ('required' in value && (!Array.isArray(value.required) || value.required.some(key => typeof key !== 'string' || key.trim().length === 0) || new Set(value.required).size !== value.required.length)) fail(`${field}_INVALID_REQUIRED`);
  const propertyNames = 'properties' in value ? new Set(Object.keys(value.properties as Record<string, unknown>)) : undefined;
  if (schemaType === 'object' && value.additionalProperties === false && Array.isArray(value.required) && value.required.some(key => !propertyNames?.has(key))) fail(`${field}_REQUIRED_PROPERTY_NOT_DECLARED`);
  if ('items' in value && value.items !== undefined) validateSchema(value.items, `${field}.items`, seen);
  if ('additionalProperties' in value && typeof value.additionalProperties !== 'boolean') validateSchema(value.additionalProperties, `${field}.additionalProperties`, seen);
  if ('enum' in value && (!Array.isArray(value.enum) || value.enum.some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item)))) fail(`${field}_INVALID_ENUM`);
  if ('enum' in value && Array.isArray(value.enum) && value.enum.length === 0) fail(`${field}_INVALID_ENUM`);
  if ('enum' in value && Array.isArray(value.enum) && new Set(value.enum).size !== value.enum.length) fail(`${field}_INVALID_ENUM`);
  if ('enum' in value && Array.isArray(value.enum) && value.enum.some(item => {
    if (schemaType === 'null') return item !== null;
    if (schemaType === 'string') return typeof item !== 'string';
    if (schemaType === 'number') return typeof item !== 'number' || !Number.isFinite(item);
    if (schemaType === 'integer') return typeof item !== 'number' || !Number.isSafeInteger(item);
    if (schemaType === 'boolean') return typeof item !== 'boolean';
    return true;
  })) fail(`${field}_ENUM_TYPE_MISMATCH`);
  seen.delete(value);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

export function validateCapabilityDefinition(input: unknown): asserts input is CapabilityDefinition {
  assertPlainRecord(input, 'definition');
  assertJson(input, 'definition');
  assertKnownKeys(input, DEFINITION_KEYS, 'definition');
  if (typeof input.name !== 'string' || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(input.name) || input.name.length > 100 || FORBIDDEN_NAMES.test(input.name)) fail('INVALID_NAME');
  if (typeof input.version !== 'string' || !/^(?:v[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]+){0,2})$/.test(input.version)) fail('INVALID_VERSION');
  validateSchema(input.inputSchema, 'inputSchema');
  validateSchema(input.outputSchema, 'outputSchema');
  assertPlainRecord(input.permission, 'permission');
  assertKnownKeys(input.permission, PERMISSION_KEYS, 'permission');
  if (input.permission.policy !== 'DECLARATIVE' || typeof input.permission.identifier !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(input.permission.identifier)) fail('INVALID_PERMISSION');
  assertPlainRecord(input.scope, 'scope');
  assertKnownKeys(input.scope, SCOPE_KEYS, 'scope');
  if (!Array.isArray(input.scope.required) || !input.scope.required.includes('account') || !input.scope.required.includes('conversation') || new Set(input.scope.required).size !== input.scope.required.length || input.scope.required.some(item => !DIMENSIONS.includes(item as CapabilityScopeDimension))) fail('INVALID_SCOPE');
  if (input.scope.required.includes('revision') && !input.scope.required.some(item => ['workItem', 'draft', 'canonical-commerce'].includes(item as string))) fail('REVISION_SCOPE_REQUIRES_REVISION_ENTITY');
  if (!SIDE_EFFECTS.includes(input.sideEffect as CapabilitySideEffect)) fail('INVALID_SIDE_EFFECT');
  assertPlainRecord(input.timeout, 'timeout');
  assertKnownKeys(input.timeout, TIMEOUT_KEYS, 'timeout');
  if (!Number.isSafeInteger(input.timeout.perCallMs) || (input.timeout.perCallMs as number) <= 0 || (input.timeout.perCallMs as number) > MAX_TIMEOUT_MS) fail('INVALID_TIMEOUT');
  assertPlainRecord(input.idempotency, 'idempotency');
  assertKnownKeys(input.idempotency, IDEMPOTENCY_KEYS, 'idempotency');
  if (typeof input.idempotency.required !== 'boolean' || !['ACCOUNT_CONVERSATION', 'CAPABILITY_SCOPE'].includes(input.idempotency.keyScope as string) || !['RETURN_PRIOR_RESULT', 'REJECT_CONFLICT'].includes(input.idempotency.replay as string)) fail('INVALID_IDEMPOTENCY');
  if (input.sideEffect !== 'READ_ONLY' && input.idempotency.required !== true) fail('MUTATION_REQUIRES_IDEMPOTENCY');
  if (input.sideEffect !== 'READ_ONLY' && input.idempotency.keyScope !== 'CAPABILITY_SCOPE') fail('MUTATION_REQUIRES_CAPABILITY_SCOPE');
  assertPlainRecord(input.evidence, 'evidence');
  assertKnownKeys(input.evidence, EVIDENCE_KEYS, 'evidence');
  if (!['NONE', 'OPTIONAL', 'REQUIRED'].includes(input.evidence.mode as string) || !['FORBIDDEN', 'OPTIONAL', 'REQUIRED'].includes(input.evidence.canonicalRefs as string)) fail('INVALID_EVIDENCE');
  if (input.evidence.mode === 'NONE' && input.evidence.canonicalRefs !== 'FORBIDDEN') fail('EVIDENCE_NONE_CANNOT_HAVE_CANONICAL_REFS');
  if (input.evidence.canonicalRefs === 'REQUIRED' && input.evidence.mode === 'NONE') fail('CANONICAL_REFS_REQUIRE_EVIDENCE');
  assertPlainRecord(input.grounding, 'grounding');
  assertKnownKeys(input.grounding, GROUNDING_KEYS, 'grounding');
  if (!['NONE', 'OPTIONAL', 'REQUIRED'].includes(input.grounding.mode as string) || typeof input.grounding.requiresCanonicalRefs !== 'boolean' || !Array.isArray(input.grounding.protectedFactSlots) || input.grounding.protectedFactSlots.some(slot => typeof slot !== 'string' || slot.trim().length === 0)) fail('INVALID_GROUNDING');
  if (new Set(input.grounding.protectedFactSlots).size !== input.grounding.protectedFactSlots.length) fail('INVALID_GROUNDING_DUPLICATE_SLOT');
  if (input.grounding.mode === 'NONE' && (input.grounding.protectedFactSlots.length !== 0 || input.grounding.requiresCanonicalRefs !== false)) fail('GROUNDING_NONE_CANNOT_REQUIRE_FACTS');
  if (input.grounding.mode === 'REQUIRED' && (input.evidence.mode !== 'REQUIRED' || input.evidence.canonicalRefs !== 'REQUIRED' || input.grounding.requiresCanonicalRefs !== true)) fail('GROUNDING_REQUIRES_CANONICAL_EVIDENCE');
  if (input.grounding.requiresCanonicalRefs && input.evidence.canonicalRefs !== 'REQUIRED') fail('GROUNDING_REQUIRES_CANONICAL_REFS');
  assertPlainRecord(input.outbound, 'outbound');
  assertKnownKeys(input.outbound, OUTBOUND_KEYS, 'outbound');
  if (!OUTBOUND_DISPOSITIONS.includes(input.outbound.disposition as TurnOutboundDisposition)) fail('INVALID_OUTBOUND_DISPOSITION');
  const outbound = input.outbound as Record<string, unknown>;
  assertKnownKeys(outbound, OUTBOUND_KEYS_BY_DISPOSITION[input.outbound.disposition as TurnOutboundDisposition], 'outbound');
  if (input.outbound.disposition === 'RUNTIME_RESPONSE' && (outbound.owner !== 'RUNTIME' || outbound.customerMessage !== true)) fail('INVALID_RUNTIME_OUTBOUND');
  if (input.outbound.disposition === 'CAPABILITY_OWNED_QUOTATION' && (input.sideEffect !== 'CANONICAL_COMMERCE_MUTATION' || input.idempotency.required !== true || outbound.owner !== 'QUOTATION_CAPABILITY' || outbound.customerMessage !== true || outbound.quotationOwnership !== 'SOLE_QUOTATION_OUTBOUND_OWNER')) fail('INVALID_QUOTATION_OUTBOUND');
  if (input.outbound.disposition === 'HANDOFF_NO_CUSTOMER_MESSAGE' && (outbound.owner !== 'HANDOFF' || outbound.customerMessage !== false || outbound.handoffReasonRequired !== true)) fail('INVALID_HANDOFF_OUTBOUND');
  if (input.outbound.disposition === 'HANDOFF_NO_CUSTOMER_MESSAGE' && (input.sideEffect !== 'WORKSPACE_MUTATION' || input.idempotency.required !== true)) fail('HANDOFF_REQUIRES_WORKSPACE_MUTATION');
  if (input.outbound.disposition === 'NONE' && (outbound.owner !== 'NONE' || outbound.customerMessage !== false)) fail('INVALID_NONE_OUTBOUND');
}

export function defineCapability<T extends CapabilityDefinition>(definition: T): Readonly<T> {
  validateCapabilityDefinition(definition);
  return freeze(definition);
}
