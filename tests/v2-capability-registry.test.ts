import test from 'node:test';
import assert from 'node:assert/strict';
import * as registryModule from '../src/v2-capability-registry.js';
import { validateCapabilityDefinition, type CapabilityDefinition } from '../src/v2-capability-contracts.js';

const expectedNames = [
  'get_customer_context', 'get_order_history', 'get_or_create_work_item', 'read_order_draft',
  'create_order_draft', 'reuse_previous_order', 'add_line', 'change_line', 'remove_line',
  'set_delivery_request', 'validate_order_draft', 'check_availability', 'prepare_quotation',
  'send_quotation', 'get_commerce_status', 'record_customer_commitment',
  'create_sales_order_draft', 'request_human_handoff',
];

function walk(value: unknown, visit: (value: object) => void, seen = new Set<object>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value); visit(value);
  if (Array.isArray(value)) value.forEach(child => walk(child, visit, seen));
  else Object.values(value).forEach(child => walk(child, visit, seen));
}

test('CAP-002 registers the exact ordered immutable capability catalog', () => {
  const names = registryModule.listCapabilities().map(capability => capability.name);
  assert.deepEqual(names, expectedNames);
  assert.equal(new Set(names).size, names.length);
  assert.strictEqual(registryModule.V2_CAPABILITY_CATALOG, registryModule.V2_CAPABILITY_REGISTRY);
  assert.strictEqual(registryModule.listCapabilities(), registryModule.V2_CAPABILITY_REGISTRY);
  assert.equal(Object.isFrozen(registryModule.V2_CAPABILITY_REGISTRY), true);
  assert.equal(Object.isFrozen(registryModule.V2_CAPABILITY_REGISTRY[0]), true);
  assert.strictEqual(registryModule.getCapability('add_line'), registryModule.getCapability('add_line'));
  assert.equal(registryModule.getCapability('prepare_requote'), undefined);
  assert.equal(registryModule.getCapability('not_registered'), undefined);
});

test('every registered definition is CAP-001-valid, deeply immutable, and handler-free', () => {
  for (const definition of registryModule.listCapabilities()) {
    validateCapabilityDefinition(definition);
    walk(definition, value => {
      assert.equal(Object.isFrozen(value), true, `${definition.name} contains a mutable object`);
      for (const child of Object.values(value)) assert.notEqual(typeof child, 'function', `${definition.name} embeds executable metadata`);
    });
    assert.equal(definition.inputSchema.type, 'object');
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(definition.outputSchema.type, 'object');
    assert.equal(definition.outputSchema.additionalProperties, false);
    assert.ok(definition.scope.required.includes('account'));
    assert.ok(definition.scope.required.includes('conversation'));
    if (definition.sideEffect !== 'READ_ONLY') {
      assert.equal(definition.idempotency.required, true);
      assert.equal(definition.idempotency.keyScope, 'CAPABILITY_SCOPE');
    }
  }
});

test('catalog metadata preserves outbound ownership and guarded canonical boundaries', () => {
  const definitions = new Map(registryModule.listCapabilities().map(capability => [capability.name, capability]));
  const outbound = registryModule.listCapabilities().filter(capability => capability.outbound.customerMessage);
  assert.deepEqual(outbound.map(capability => capability.name), ['send_quotation']);
  assert.equal(definitions.get('send_quotation')?.outbound.disposition, 'CAPABILITY_OWNED_QUOTATION');
  assert.equal(definitions.get('request_human_handoff')?.outbound.disposition, 'HANDOFF_NO_CUSTOMER_MESSAGE');
  assert.equal(definitions.get('request_human_handoff')?.sideEffect, 'WORKSPACE_MUTATION');
  for (const name of ['prepare_quotation', 'record_customer_commitment', 'create_sales_order_draft']) {
    const capability = definitions.get(name) as CapabilityDefinition;
    assert.equal(capability.sideEffect, 'CANONICAL_COMMERCE_MUTATION');
    assert.ok(capability.scope.required.includes('canonical-commerce'));
    assert.equal(capability.outbound.disposition, 'NONE');
    assert.equal(capability.idempotency.required, true);
  }
  assert.equal(definitions.get('validate_order_draft')?.sideEffect, 'WORKSPACE_MUTATION');
  assert.equal(definitions.get('check_availability')?.sideEffect, 'READ_ONLY');
  assert.equal(definitions.get('check_availability')?.scope.required.includes('canonical-commerce'), true);
});

test('draft actions expose minimal closed payloads for their actual operations', () => {
  const definitions = new Map(registryModule.listCapabilities().map(capability => [capability.name, capability]));
  const schema = (name: string) => definitions.get(name)!.inputSchema;
  const required = (name: string) => new Set(schema(name).required);
  const properties = (name: string) => new Set(Object.keys(schema(name).properties ?? {}));

  assert.ok(required('create_order_draft').has('lines'));
  assert.ok(required('create_order_draft').has('expectedWorkItemRevision'));
  assert.ok(required('reuse_previous_order').has('previousSalesOrderId'));
  assert.ok(required('reuse_previous_order').has('expectedWorkItemRevision'));
  assert.equal(properties('reuse_previous_order').has('lines'), false);

  for (const name of ['add_line', 'change_line', 'remove_line', 'set_delivery_request']) {
    assert.ok(required(name).has('draftId'));
    assert.ok(required(name).has('expectedDraftRevision'));
    assert.ok(required(name).has('expectedWorkItemRevision'));
  }
  for (const field of ['lineNo', 'requestedWording', 'quantity', 'requestedUom']) assert.ok(required('add_line').has(field));
  assert.ok(required('change_line').has('lineNo'));
  assert.ok(required('change_line').has('change'));
  assert.equal((schema('change_line').properties?.change as { additionalProperties?: boolean }).additionalProperties, false);
  assert.ok(required('remove_line').has('lineNo'));
  assert.ok(required('set_delivery_request').has('requestedDeliveryDate'));
  assert.equal((schema('set_delivery_request').properties?.requestedDeliveryDate as { type?: string }).type, 'string');

  assert.ok(required('read_order_draft').has('revision'));
  assert.ok(definitions.get('read_order_draft')!.scope.required.includes('revision'));
  assert.ok(required('validate_order_draft').has('revision'));
  assert.ok(required('validate_order_draft').has('expectedWorkItemRevision'));
  assert.ok(required('request_human_handoff').has('workItemId'));
  assert.ok(required('request_human_handoff').has('expectedWorkItemRevision'));
  assert.ok(definitions.get('request_human_handoff')!.scope.required.includes('workItem'));
  assert.ok(definitions.get('request_human_handoff')!.scope.required.includes('revision'));
  for (const name of ['create_order_draft', 'reuse_previous_order', 'add_line', 'change_line', 'remove_line', 'set_delivery_request']) {
    assert.equal(schema(name).additionalProperties, false);
  }
});

test('every scoped capability represents the revision preflight requires', () => {
  for (const capability of registryModule.listCapabilities()) {
    const required = new Set(capability.inputSchema.required ?? []);
    if (capability.scope.required.includes('workItem')) assert.ok(required.has('expectedWorkItemRevision'), capability.name);
    if (capability.scope.required.includes('draft')) {
      assert.ok(['expectedDraftRevision', 'draftRevision', 'revision'].some(field => required.has(field)), capability.name);
    }
    if (capability.scope.required.includes('revision') && capability.scope.required.includes('draft')) {
      assert.ok(['expectedDraftRevision', 'draftRevision', 'revision'].some(field => required.has(field)), capability.name);
    }
  }
  const prepare = registryModule.getCapability('prepare_quotation')!;
  assert.ok(prepare.inputSchema.required?.includes('expectedWorkItemRevision'));
});

test('protected fact outputs require canonical grounding evidence', () => {
  const definitions = new Map(registryModule.listCapabilities().map(capability => [capability.name, capability]));
  const expected: Record<string, string[]> = {
    get_customer_context: ['customer_identity', 'currency'],
    get_order_history: ['sales_order_number', 'total', 'delivery_date', 'date'],
    read_order_draft: ['quantity', 'uom', 'delivery_date'],
    validate_order_draft: ['product', 'quantity', 'uom', 'price', 'currency', 'total', 'stock', 'availability', 'delivery_date'],
    check_availability: ['stock', 'availability', 'quantity', 'uom'],
    get_commerce_status: ['quotation_status', 'sales_order_status'],
    record_customer_commitment: ['commitment_outcome', 'quotation_status'],
    create_sales_order_draft: ['sales_order_status', 'sales_order_number'],
  };
  for (const [name, slots] of Object.entries(expected)) {
    const grounding = definitions.get(name)!.grounding;
    assert.equal(grounding.mode, 'REQUIRED', name);
    assert.equal(grounding.requiresCanonicalRefs, true, name);
    for (const slot of slots) assert.ok(grounding.protectedFactSlots.includes(slot), `${name} missing ${slot}`);
    assert.equal(definitions.get(name)!.evidence.canonicalRefs, 'REQUIRED', name);
  }
  assert.equal(definitions.get('send_quotation')!.outbound.disposition, 'CAPABILITY_OWNED_QUOTATION');
  assert.equal(definitions.get('prepare_quotation')!.grounding.mode, 'REQUIRED');
});

test('workspace mutation metadata documents exact replay semantics', () => {
  for (const capability of registryModule.listCapabilities()) {
    if (capability.sideEffect === 'WORKSPACE_MUTATION') assert.equal(capability.idempotency.replay, 'RETURN_PRIOR_RESULT', capability.name);
  }
});

test('CAP-002 exports no dynamic registration API', () => {
  assert.equal('register' in registryModule, false);
  assert.equal('invoke' in registryModule, false);
  assert.equal('dispatch' in registryModule, false);
  assert.equal(Object.keys(registryModule).some(key => /handler|register|invoke|dispatch/i.test(key)), false);
});

test('CAP-004 assertion rejects aliases, wrong permissions, duplicates, and malformed definitions without mutating the live catalog', () => {
  const live = registryModule.listCapabilities();
  const aliasCandidate = live.map(capability => ({ ...capability }));
  (aliasCandidate[0] as { name: string }).name = 'increase_stock';
  assert.throws(() => registryModule.assertApprovedEmployeeCapabilityCatalog(aliasCandidate), /INVALID_CAPABILITY_REGISTRY:NAME_AT_INDEX_0/);

  const wrongPermissionCandidate = live.map(capability => ({ ...capability }));
  (wrongPermissionCandidate[0] as { permission: { identifier: string; policy: 'DECLARATIVE' } }).permission = { identifier: 'v2.capability.increase_stock', policy: 'DECLARATIVE' };
  assert.throws(() => registryModule.assertApprovedEmployeeCapabilityCatalog(wrongPermissionCandidate), /INVALID_CAPABILITY_REGISTRY:PERMISSION_AT_INDEX_0/);

  const duplicateCandidate = [...live.slice(0, -1), live[0]];
  assert.throws(() => registryModule.assertApprovedEmployeeCapabilityCatalog(duplicateCandidate), /INVALID_CAPABILITY_REGISTRY:DUPLICATE_NAME/);

  const malformedSameNameCandidate = live.map(capability => ({ ...capability }));
  (malformedSameNameCandidate[0] as { version: string }).version = '';
  assert.throws(() => registryModule.assertApprovedEmployeeCapabilityCatalog(malformedSameNameCandidate), /INVALID_CAPABILITY_DEFINITION/);

  assert.throws(() => registryModule.assertApprovedEmployeeCapabilityCatalog([...live, live[0]]), /INVALID_CAPABILITY_REGISTRY:EXACT_LENGTH_REQUIRED/);
  assert.deepEqual(registryModule.listCapabilities().map(capability => capability.name), expectedNames);
});
