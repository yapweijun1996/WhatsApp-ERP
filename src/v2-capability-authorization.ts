import type Database from 'better-sqlite3';
import { getCapability } from './v2-capability-registry.js';
import type { CapabilityDefinition, JsonValue } from './v2-capability-contracts.js';
import { validateCapabilityArgumentsForDefinition } from './v2-capability-schema.js';
export { validateCapabilityArgumentsForDefinition } from './v2-capability-schema.js';

export type ProposedCapabilityAction = { readonly name: string; readonly arguments: unknown };
export type HostAuthorizationContext = {
  readonly db: Database.Database;
  readonly profileId: string;
  readonly permissions: readonly string[];
  readonly accountId: string;
  readonly conversationId: string;
  readonly customerId?: string;
  readonly idempotencyKey?: string;
};
export type AuthorizedCapabilityEnvelope = Readonly<{
  capability: Readonly<{ name: string; version: string }>;
  arguments: JsonValue;
  profileId: string;
  scope: Readonly<{ accountId: string; conversationId: string; customerId?: string; workItemId?: string; draftId?: string }>;
  idempotencyKey?: string;
}>;

const MAX_STRING = 512;
function fail(code: string): never { throw new Error(`CAPABILITY_AUTHORIZATION_DENIED:${code}`); }
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const string = (v: unknown, code: string): string => { if (typeof v !== 'string' || v.trim().length === 0 || v.length > MAX_STRING) fail(code); return v; };

function argString(args: Record<string, JsonValue>, key: string): string | undefined { const v = args[key]; return v === undefined ? undefined : string(v, `ARG_${key}`); }
function argInt(args: Record<string, JsonValue>, key: string): number | undefined { const v = args[key]; if (v === undefined) return undefined; if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(`ARG_${key}`); return v as number; }
function row(db: Database.Database, sql: string, ...params: unknown[]) { return db.prepare(sql).get(...params) as Record<string, unknown> | undefined; }

function authorizeScope(def: CapabilityDefinition, args: Record<string, JsonValue>, host: HostAuthorizationContext) {
  if (args.accountId !== host.accountId || args.conversationId !== host.conversationId) fail('ACCOUNT_OR_CONVERSATION_SCOPE');
  const conversation = row(host.db, 'SELECT customer_id FROM conversations WHERE id=? AND channel_account_id=?', host.conversationId, host.accountId);
  if (!conversation) fail('CONVERSATION_SCOPE');
  const canonicalCustomer = conversation.customer_id as string | null;
  if (def.scope.required.includes('customer')) {
    if (!canonicalCustomer || host.customerId !== canonicalCustomer || args.customerId !== canonicalCustomer) fail('CUSTOMER_SCOPE');
  } else if (args.customerId !== undefined && args.customerId !== canonicalCustomer) fail('CUSTOMER_SCOPE');
  const workItemId = argString(args, 'workItemId');
  const draftId = argString(args, 'draftId');
  if (def.scope.required.includes('workItem')) {
    if (!workItemId) fail('WORK_ITEM_REQUIRED');
    const work = row(host.db, 'SELECT id,revision,customer_id FROM work_items WHERE id=? AND account_id=? AND conversation_id=?', workItemId, host.accountId, host.conversationId);
    if (!work || work.customer_id !== canonicalCustomer) fail('WORK_ITEM_SCOPE');
    const expected = argInt(args, 'expectedWorkItemRevision');
    if (expected === undefined || expected !== work.revision) fail('STALE_OR_MISSING_WORK_ITEM_REVISION');
  }
  if (def.scope.required.includes('draft')) {
    if (!draftId) fail('DRAFT_REQUIRED');
    const draft = row(host.db, "SELECT id,current_revision,work_item_id,customer_id FROM order_drafts WHERE id=? AND status='CURRENT' AND account_id=? AND conversation_id=?", draftId, host.accountId, host.conversationId);
    if (!draft || draft.customer_id !== canonicalCustomer || (workItemId && draft.work_item_id !== workItemId)) fail('DRAFT_SCOPE');
    const expected = argInt(args, 'expectedDraftRevision') ?? argInt(args, 'draftRevision') ?? argInt(args, 'revision');
    if (expected === undefined || expected !== draft.current_revision) fail('STALE_OR_MISSING_DRAFT_REVISION');
  }
  return { canonicalCustomer, workItemId, draftId };
}

function authorizeCanonical(name: string, args: Record<string, JsonValue>, host: HostAuthorizationContext, customer: string | null) {
  const quotationId = argString(args, 'quotationId');
  if (quotationId) {
    const q = row(host.db, 'SELECT customer_id FROM quotations WHERE id=? AND source_conversation_id=?', quotationId, host.conversationId);
    if (!q || q.customer_id !== customer) fail('QUOTATION_SCOPE');
  }
  const inbound = argString(args, 'inboundMessageId');
  if (inbound) {
    const m = row(host.db, "SELECT id FROM messages WHERE account_id=? AND conversation_id=? AND direction='INBOUND' AND (id=? OR external_message_id=?)", host.accountId, host.conversationId, inbound, inbound);
    if (!m) fail('INBOUND_MESSAGE_SCOPE');
  }
  if (name === 'create_sales_order_draft') {
    const acceptance = argString(args, 'acceptanceEvidenceId');
    if (!quotationId || !acceptance) fail('ACCEPTANCE_REQUIRED');
    const a = row(host.db, 'SELECT qa.id FROM quotation_acceptances qa JOIN quotations q ON q.id=qa.quotation_id WHERE qa.id=? AND qa.quotation_id=? AND q.source_conversation_id=? AND q.customer_id=?', acceptance, quotationId, host.conversationId, customer);
    if (!a) fail('ACCEPTANCE_SCOPE');
  }
}

export function authorizeCapability(action: ProposedCapabilityAction, host: HostAuthorizationContext): AuthorizedCapabilityEnvelope {
  if (!isObject(action)) fail('MALFORMED_ACTION');
  const actionKeys = Reflect.ownKeys(action);
  if (actionKeys.length !== 2 || actionKeys.some(key => typeof key !== 'string' || !['name', 'arguments'].includes(key))) fail('MALFORMED_ACTION');
  const nameDescriptor = Object.getOwnPropertyDescriptor(action, 'name');
  const argumentsDescriptor = Object.getOwnPropertyDescriptor(action, 'arguments');
  if (!nameDescriptor || !('value' in nameDescriptor) || !nameDescriptor.enumerable || !argumentsDescriptor || !('value' in argumentsDescriptor) || !argumentsDescriptor.enumerable || typeof nameDescriptor.value !== 'string') fail('MALFORMED_ACTION');
  const actionName = nameDescriptor.value;
  const capability = getCapability(actionName);
  if (!capability || capability.name !== actionName) fail('UNKNOWN_CAPABILITY');
  string(host.profileId, 'PROFILE_ID');
  if (!Array.isArray(host.permissions) || !host.permissions.every(p => typeof p === 'string' && p.trim().length > 0 && p.length <= MAX_STRING)) fail('PROFILE_PERMISSIONS');
  if (!host.permissions.includes(capability.permission.identifier)) fail('PERMISSION_DENIED');
  let args: JsonValue;
  try { args = validateCapabilityArgumentsForDefinition(capability, argumentsDescriptor.value); }
  catch (error) {
    const raw = error instanceof Error ? error.message.replace(/^CAPABILITY_SCHEMA_INVALID:/, '') : 'ARGUMENTS_NOT_JSON';
    const code = raw.replace('ARGUMENTS_UNKNOWN_', 'ARGUMENTS_UNKNOWN_FIELD_').replace('ARGUMENTS_DESCRIPTOR', 'ARGUMENTS_NOT_JSON').replace('ARGUMENTS.extra_JSON', 'ARGUMENTS.extra_NOT_JSON');
    fail(code);
  }
  if (!isObject(args)) fail('ARGUMENTS_TYPE');
  const scoped = authorizeScope(capability, args, host);
  if (capability.scope.required.includes('canonical-commerce')) authorizeCanonical(capability.name, args, host, scoped.canonicalCustomer);
  let idempotencyKey: string | undefined;
  if (capability.idempotency.required) idempotencyKey = string(host.idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED');
  const scope: { accountId: string; conversationId: string; customerId?: string; workItemId?: string; draftId?: string } = { accountId: host.accountId, conversationId: host.conversationId };
  if (scoped.canonicalCustomer) scope.customerId = scoped.canonicalCustomer;
  if (scoped.workItemId) scope.workItemId = scoped.workItemId;
  if (scoped.draftId) scope.draftId = scoped.draftId;
  const envelope = { capability: { name: capability.name, version: capability.version }, arguments: args, profileId: host.profileId, scope, ...(idempotencyKey ? { idempotencyKey } : {}) } as AuthorizedCapabilityEnvelope;
  return deepFreeze(envelope);
}

export const preflightCapability = authorizeCapability;
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
