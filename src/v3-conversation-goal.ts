/** Shadow-only V3-GOAL-001 contract. It has no persistence or runtime wiring. */
export const V3_CONVERSATION_GOAL_CONTRACT_VERSION = 'V3-GOAL-001' as const;
export const V3_CONVERSATION_GOAL_SCHEMA_VERSION = 1 as const;
export const V3_CONVERSATION_GOAL_AUTHORITY = 'NON_AUTHORITATIVE_DERIVED' as const;
export const V3_CONVERSATION_GOAL_AI_CUTOFF = 'SALES_ORDER.DRAFT' as const;

export const CONVERSATION_GOAL_STATUSES = [
  'OPEN', 'IN_PROGRESS', 'FULFILLED', 'NEEDS_CLARIFICATION',
  'WAITING_EXTERNAL', 'BLOCKED_BY_AUTHORITY', 'SUPERSEDED', 'CANCELLED',
] as const;
export type ConversationGoalStatus = typeof CONVERSATION_GOAL_STATUSES[number];

export type ErpObjectRef = Readonly<{
  objectType: string;
  objectId: string;
  accountId: string;
  conversationId: string;
}>;

export type ConversationGoal = Readonly<{
  contractVersion: typeof V3_CONVERSATION_GOAL_CONTRACT_VERSION;
  schemaVersion: typeof V3_CONVERSATION_GOAL_SCHEMA_VERSION;
  authority: typeof V3_CONVERSATION_GOAL_AUTHORITY;
  aiAuthorityCutoff: typeof V3_CONVERSATION_GOAL_AI_CUTOFF;
  goalId: string;
  accountId: string;
  conversationId: string;
  sourceMessageIds: readonly string[];
  sourceAttachmentIds: readonly string[];
  erpObjectRefs: readonly ErpObjectRef[];
  parentGoalId: string | null;
  dependsOnGoalIds: readonly string[];
  relatedGoalIds: readonly string[];
  description: string;
  status: ConversationGoalStatus;
  createdBy: 'AGENT';
  createdAt: string;
  updatedAt: string;
  fulfillmentEvidenceRefs: readonly string[];
}>;

const KEYS = new Set([
  'contractVersion', 'schemaVersion', 'authority', 'aiAuthorityCutoff', 'goalId',
  'accountId', 'conversationId', 'sourceMessageIds', 'sourceAttachmentIds',
  'erpObjectRefs', 'parentGoalId', 'dependsOnGoalIds', 'relatedGoalIds',
  'description', 'status', 'createdBy', 'createdAt', 'updatedAt',
  'fulfillmentEvidenceRefs',
]);
const REF_KEYS = new Set(['objectType', 'objectId', 'accountId', 'conversationId']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(code: string): never { throw new Error(`V3_CONVERSATION_GOAL_INVALID:${code}`); }

function ownDataObject(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(code);
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = descriptors[key];
    if ((typeof key === 'string' && UNSAFE_KEYS.has(key)) || !descriptor || !('value' in descriptor)) invalid(`${code}_UNSAFE`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.trim().length === 0) invalid(code);
  return value;
}

function arrayDescriptors(value: unknown, code: string): { descriptors: Record<PropertyKey, PropertyDescriptor>; length: number } {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(code);
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number' || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value > 256) invalid(code);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const isIndex = typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < lengthDescriptor.value;
    if (!isIndex) invalid(code);
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) invalid(code);
  }
  return { descriptors, length: lengthDescriptor.value };
}

function uniqueIds(value: unknown, code: string, requireNonEmpty = false): string[] {
  const { descriptors, length } = arrayDescriptors(value, code);
  const result: string[] = [];
  if (requireNonEmpty && length === 0) invalid(`${code}_EMPTY`);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) invalid(`${code}_HOLE`);
    const id = text(descriptor.value, `${code}_ITEM`);
    if (result.includes(id)) invalid(`${code}_DUPLICATE`);
    result.push(id);
  }
  return result;
}

function refs(value: unknown, accountId: string, conversationId: string): ErpObjectRef[] {
  const { descriptors, length } = arrayDescriptors(value, 'ERP_REFS');
  const result: ErpObjectRef[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const item = ownDataObject(descriptors[String(index)]?.value, 'ERP_REF');
    for (const key of Reflect.ownKeys(item)) if (typeof key !== 'string' || !REF_KEYS.has(key)) invalid('ERP_REF_EXTRA');
    const ref = { objectType: text(item.objectType, 'ERP_TYPE'), objectId: text(item.objectId, 'ERP_ID'), accountId: text(item.accountId, 'ERP_ACCOUNT'), conversationId: text(item.conversationId, 'ERP_CONVERSATION') };
    if (ref.accountId !== accountId || ref.conversationId !== conversationId) invalid('ERP_SCOPE');
    const identity = `${ref.objectType}\0${ref.objectId}`;
    if (seen.has(identity)) invalid('ERP_DUPLICATE');
    seen.add(identity); result.push(ref);
  }
  return result;
}

function timestamp(value: unknown, code: string): string {
  const candidate = text(value, code);
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime()) || candidate !== parsed.toISOString()) invalid(code);
  return candidate;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function parse(value: unknown): ConversationGoal {
  const input = ownDataObject(value, 'SHAPE');
  for (const key of Reflect.ownKeys(input)) if (typeof key !== 'string' || !KEYS.has(key)) invalid('EXTRA_KEY');
  const accountId = text(input.accountId, 'ACCOUNT');
  const conversationId = text(input.conversationId, 'CONVERSATION');
  const goalId = text(input.goalId, 'GOAL_ID');
  const parentGoalId = input.parentGoalId === null ? null : text(input.parentGoalId, 'PARENT');
  if (parentGoalId === goalId) invalid('PARENT_SELF');
  const dependsOnGoalIds = uniqueIds(input.dependsOnGoalIds, 'DEPENDENCIES');
  const relatedGoalIds = uniqueIds(input.relatedGoalIds, 'RELATED');
  if (dependsOnGoalIds.includes(goalId)) invalid('DEPENDENCY_SELF');
  if (relatedGoalIds.includes(goalId)) invalid('RELATED_SELF');
  const createdAt = timestamp(input.createdAt, 'CREATED_AT');
  const updatedAt = timestamp(input.updatedAt, 'UPDATED_AT');
  if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) invalid('TIMESTAMP_ORDER');
  if (!CONVERSATION_GOAL_STATUSES.includes(input.status as ConversationGoalStatus)) invalid('STATUS');
  if (input.createdBy !== 'AGENT') invalid('CREATED_BY');
  if (input.authority !== V3_CONVERSATION_GOAL_AUTHORITY || input.aiAuthorityCutoff !== V3_CONVERSATION_GOAL_AI_CUTOFF) invalid('AUTHORITY');
  if (input.contractVersion !== V3_CONVERSATION_GOAL_CONTRACT_VERSION || input.schemaVersion !== V3_CONVERSATION_GOAL_SCHEMA_VERSION) invalid('VERSION');
  return {
    contractVersion: V3_CONVERSATION_GOAL_CONTRACT_VERSION, schemaVersion: 1,
    authority: V3_CONVERSATION_GOAL_AUTHORITY, aiAuthorityCutoff: V3_CONVERSATION_GOAL_AI_CUTOFF,
    goalId, accountId, conversationId,
    sourceMessageIds: uniqueIds(input.sourceMessageIds, 'SOURCE_MESSAGES', true),
    sourceAttachmentIds: uniqueIds(input.sourceAttachmentIds, 'SOURCE_ATTACHMENTS'),
    erpObjectRefs: refs(input.erpObjectRefs, accountId, conversationId), parentGoalId,
    dependsOnGoalIds, relatedGoalIds, description: text(input.description, 'DESCRIPTION'),
    status: input.status as ConversationGoalStatus, createdBy: 'AGENT', createdAt, updatedAt,
    fulfillmentEvidenceRefs: uniqueIds(input.fulfillmentEvidenceRefs, 'FULFILLMENT_EVIDENCE'),
  };
}

function normalizeBuildInput(input: unknown): Record<string, unknown> {
  const source = ownDataObject(input, 'SHAPE');
  for (const key of Reflect.ownKeys(source)) if (typeof key !== 'string' || !KEYS.has(key)) invalid('EXTRA_KEY');
  const safe: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string') invalid('EXTRA_KEY');
    safe[key] = (Object.getOwnPropertyDescriptor(source, key) as PropertyDescriptor & { value: unknown }).value;
  }
  return safe;
}

export function buildConversationGoal(input: Omit<ConversationGoal, 'contractVersion' | 'schemaVersion' | 'authority' | 'aiAuthorityCutoff'>): ConversationGoal {
  const safeInput = normalizeBuildInput(input);
  return freeze(parse({ ...safeInput, contractVersion: V3_CONVERSATION_GOAL_CONTRACT_VERSION, schemaVersion: 1, authority: V3_CONVERSATION_GOAL_AUTHORITY, aiAuthorityCutoff: V3_CONVERSATION_GOAL_AI_CUTOFF }));
}

export function validateConversationGoal(value: unknown): ConversationGoal { return freeze(parse(value)); }
