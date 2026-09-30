import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import * as registry from '../src/v2-capability-registry.js';
import { defineCapability, validateCapabilityDefinition, type CapabilityDefinition } from '../src/v2-capability-contracts.js';
import { authorizeCapability, preflightCapability } from '../src/v2-capability-authorization.js';
import { V1Database } from '../src/database.js';

const expectedNames = [
  'get_customer_context', 'get_order_history', 'get_or_create_work_item', 'read_order_draft',
  'create_order_draft', 'reuse_previous_order', 'add_line', 'change_line', 'remove_line',
  'set_delivery_request', 'validate_order_draft', 'check_availability', 'prepare_quotation',
  'send_quotation', 'get_commerce_status', 'record_customer_commitment',
  'create_sales_order_draft', 'request_human_handoff',
] as const;

// Finite adversarial evidence only; this is not an exhaustive synonym classifier.
const forbiddenAliases = [
  'execute_sql', 'executeSql', 'sql', 'run_sql', 'raw_sql', 'query_sql', 'model_sql', 'execute_model_sql',
  'mutate_stock', 'stock_mutation', 'stock_mutate', 'update_stock', 'adjust_stock', 'reserve_stock', 'deduct_stock', 'decrement_stock', 'change_stock', 'set_stock', 'update_inventory',
  'price_override', 'override_price', 'set_price', 'update_price', 'change_price', 'custom_price',
  'post_sales_order', 'sales_order_post', 'confirm_sales_order', 'sales_order_confirm', 'approve_sales_order', 'submit_sales_order',
  'create_delivery_order', 'delivery_order_create', 'delivery_order_creation', 'create_do',
  'DO_READY', 'do_ready', 'do_ready_transition', 'mark_do_ready', 'set_do_ready', 'delivery_order_ready',
  'increase_stock', 'decrease_inventory', 'allocate_stock', 'stock_modification', 'set_unit_price',
  'override_unit_price', 'post_order', 'create_delivery',
] as const;

const canonicalExplicitNames = [
  'execute_sql', 'sql', 'stock_mutation', 'price_override', 'post_sales_order',
  'confirm_sales_order', 'create_delivery_order', 'do_ready', 'sales_order_post',
  'sales_order_confirm', 'delivery_order_create', 'delivery_order_ready',
] as const;
const canonicalExplicitNameSet = new Set<string>(canonicalExplicitNames);
const reviewerSemanticAliases = [
  'increase_stock', 'decrease_inventory', 'allocate_stock', 'stock_modification',
  'set_unit_price', 'override_unit_price', 'post_order', 'create_delivery',
] as const;

const forbiddenFamily = /(?:^|[_:.])(?:execute[_]?sql|sql|(?:stock|inventory)[_.]?(?:mutat|updat|adjust|reserv|deduct|decrement|chang|set)|(?:price[_:.]?override|override[_:.]?price|(?:set|update|change)[_.]?price)|(?:post|confirm|approve|submit)[_.]?sales[_:.]?order|sales[_:.]?order[_:.]?(?:post|confirm)|(?:create|creation)[_.]?(?:delivery[_:.]?order|do)|delivery[_:.]?order[_:.]?(?:create|ready)|do[_:.]?ready)(?:$|[_:.])/i;
const definitionName = (name: string): CapabilityDefinition => ({
  name,
  version: 'v1',
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'object', additionalProperties: false },
  permission: { identifier: 'test.capability', policy: 'DECLARATIVE' },
  scope: { required: ['account', 'conversation'] },
  sideEffect: 'READ_ONLY',
  timeout: { perCallMs: 5000 },
  idempotency: { required: false, keyScope: 'ACCOUNT_CONVERSATION', replay: 'RETURN_PRIOR_RESULT' },
  evidence: { mode: 'NONE', canonicalRefs: 'FORBIDDEN' },
  outbound: { disposition: 'NONE', owner: 'NONE', customerMessage: false },
  grounding: { mode: 'NONE', protectedFactSlots: [], requiresCanonicalRefs: false },
});

function databaseSnapshot(db: V1Database): string {
  const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const rows = db.db.prepare(`SELECT * FROM ${quoted}`).all();
      return [name, rows.length, rows];
    });
  return crypto.createHash('sha256').update(JSON.stringify(tables)).digest('hex');
}

function host(db: V1Database, permissions: string[]) {
  return {
    db: db.db,
    profileId: 'hostile-test-profile',
    permissions,
    accountId: 'demo-account',
    conversationId: 'conv-001',
    customerId: 'CUST-001',
  } as const;
}

test('CAP-004 registry inspection proves the frozen 18-name catalog and forbidden permission space is empty', () => {
  const definitions = registry.listCapabilities();
  assert.deepEqual(definitions.map(definition => definition.name), expectedNames);
  assert.deepEqual(definitions.map(definition => definition.permission.identifier), expectedNames.map(name => `v2.capability.${name}`));

  const namesAndPermissions = definitions.flatMap(definition => [definition.name, definition.permission.identifier]);
  for (const forbidden of forbiddenAliases) assert.equal(namesAndPermissions.includes(forbidden), false, forbidden);
  for (const value of namesAndPermissions) assert.equal(forbiddenFamily.test(value), false, value);
  assert.equal(new Set(namesAndPermissions).size, namesAndPermissions.length);
});

test('CAP-001 only rejects canonical explicit forbidden names; finite semantic corpus remains registry evidence', () => {
  for (const name of canonicalExplicitNames) {
    const definition = definitionName(name);
    assert.throws(() => validateCapabilityDefinition(definition), /INVALID_NAME/, `${name} must fail CAP-001 validation`);
    assert.throws(() => defineCapability(definition), /INVALID_NAME/, `${name} must fail CAP-001 definition`);
  }
  for (const name of reviewerSemanticAliases) {
    assert.doesNotThrow(() => defineCapability(definitionName(name)), `${name} is not claimed by generic semantic classification`);
  }
});

test('CAP-004 forbidden names and aliases are unknown before hostile permissions can authorize them or mutate state', () => {
  const db = new V1Database(':memory:');
  db.resetAndSeed();
  const before = databaseSnapshot(db);

  for (const [index, name] of forbiddenAliases.entries()) {
    const boundary = index % 2 === 0 ? authorizeCapability : preflightCapability;
    const inventedPermission = `v2.capability.${name}`;
    assert.throws(
      () => boundary({ name, arguments: {} }, host(db, [inventedPermission, `employee.${name}`])),
      /UNKNOWN_CAPABILITY/,
      `${name} must be rejected as unknown before permission checks`,
    );
    assert.equal(databaseSnapshot(db), before, `${name} changed business state`);
  }
});
