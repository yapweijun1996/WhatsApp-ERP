/**
 * Static, host-owned V2 capability catalog.
 *
 * This module deliberately contains metadata only. Capability authorization,
 * invocation, profile resolution, and handler dispatch belong to later slices.
 */
import {
  defineCapability,
  validateCapabilityDefinition,
  type CapabilityDefinition,
  type CapabilityScopeDimension,
  type JsonSchema,
} from './v2-capability-contracts.js';

const timeout = { perCallMs: 15_000 } as const;
const readIdempotency = { required: false, keyScope: 'ACCOUNT_CONVERSATION', replay: 'RETURN_PRIOR_RESULT' } as const;
// Exact replay returns the durable prior result; same-key/different-input conflicts.
const mutationIdempotency = { required: true, keyScope: 'CAPABILITY_SCOPE', replay: 'RETURN_PRIOR_RESULT' } as const;
const commerceIdempotency = { required: true, keyScope: 'CAPABILITY_SCOPE', replay: 'RETURN_PRIOR_RESULT' } as const;
const noneOutbound = { disposition: 'NONE', owner: 'NONE', customerMessage: false } as const;
const noGrounding = { mode: 'NONE', protectedFactSlots: [], requiresCanonicalRefs: false } as const;
const evidenceOptional = { mode: 'OPTIONAL', canonicalRefs: 'OPTIONAL' } as const;
const evidenceRequired = { mode: 'REQUIRED', canonicalRefs: 'REQUIRED' } as const;

function permission(name: string) {
  return { identifier: `v2.capability.${name}`, policy: 'DECLARATIVE' as const };
}

function scope(...required: CapabilityScopeDimension[]) {
  return { required };
}

/** The employee-facing registry authority. Adding a capability requires an explicit reviewed change here. */
export const APPROVED_EMPLOYEE_CAPABILITY_NAMES = Object.freeze([
  'get_customer_context', 'get_order_history', 'get_or_create_work_item', 'read_order_draft',
  'create_order_draft', 'reuse_previous_order', 'add_line', 'change_line', 'remove_line',
  'set_delivery_request', 'validate_order_draft', 'check_availability', 'prepare_quotation',
  'send_quotation', 'get_commerce_status', 'record_customer_commitment',
  'create_sales_order_draft', 'request_human_handoff',
] as const);

function failRegistry(message: string): never {
  throw new Error(`INVALID_CAPABILITY_REGISTRY:${message}`);
}

/**
 * Assert the reviewed employee catalog boundary without constructing or mutating
 * a registry. This is validation only, not a registration or invocation API.
 */
export function assertApprovedEmployeeCapabilityCatalog(candidate: unknown): asserts candidate is readonly CapabilityDefinition[] {
  if (!Array.isArray(candidate) || candidate.length !== APPROVED_EMPLOYEE_CAPABILITY_NAMES.length) failRegistry('EXACT_LENGTH_REQUIRED');

  for (const capability of candidate) validateCapabilityDefinition(capability);

  const names = candidate.map(capability => capability.name);
  if (new Set(names).size !== names.length) failRegistry('DUPLICATE_NAME');
  for (const [index, expectedName] of APPROVED_EMPLOYEE_CAPABILITY_NAMES.entries()) {
    const capability = candidate[index];
    if (!capability || capability.name !== expectedName) failRegistry(`NAME_AT_INDEX_${index}`);
    if (capability.permission.identifier !== `v2.capability.${expectedName}`) failRegistry(`PERMISSION_AT_INDEX_${index}`);
  }
}

export const getCustomerContext = defineCapability({
  name: 'get_customer_context', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' } }, required: ['accountId', 'conversationId', 'customerId'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { customerId: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, currency: { type: 'string' }, warehouseId: { type: 'string' }, creditStatus: { type: 'string' } }, additionalProperties: false },
  permission: permission('get_customer_context'), scope: scope('account', 'conversation', 'customer'), sideEffect: 'READ_ONLY', timeout,
  idempotency: readIdempotency, evidence: evidenceRequired, outbound: noneOutbound, grounding: { mode: 'REQUIRED', protectedFactSlots: ['customer_identity', 'currency'], requiresCanonicalRefs: true },
});

export const getOrderHistory = defineCapability({
  name: 'get_order_history', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, limit: { type: 'integer' } }, required: ['accountId', 'conversationId', 'customerId'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { orders: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, salesOrderNo: { type: 'string' }, date: { type: 'string' }, grandTotalCents: { type: 'integer' } }, additionalProperties: false } } }, required: ['orders'], additionalProperties: false },
  permission: permission('get_order_history'), scope: scope('account', 'conversation', 'customer'), sideEffect: 'READ_ONLY', timeout,
  idempotency: readIdempotency, evidence: evidenceRequired, outbound: noneOutbound, grounding: { mode: 'REQUIRED', protectedFactSlots: ['sales_order_number', 'total', 'delivery_date', 'date'], requiresCanonicalRefs: true },
});

export const getOrCreateWorkItem = defineCapability({
  name: 'get_or_create_work_item', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, sourceMessageId: { type: 'string' }, goalSummary: { type: 'string' } }, required: ['accountId', 'conversationId', 'customerId'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { workItemId: { type: 'string' }, state: { type: 'string' }, revision: { type: 'integer' } }, required: ['workItemId', 'state', 'revision'], additionalProperties: false },
  permission: permission('get_or_create_work_item'), scope: scope('account', 'conversation', 'customer'), sideEffect: 'WORKSPACE_MUTATION', timeout,
  idempotency: mutationIdempotency, evidence: evidenceOptional, outbound: noneOutbound, grounding: noGrounding,
});

export const readOrderDraft = defineCapability({
  name: 'read_order_draft', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, workItemId: { type: 'string' }, draftId: { type: 'string' }, revision: { type: 'integer' }, expectedWorkItemRevision: { type: 'integer' } }, required: ['accountId', 'conversationId', 'customerId', 'workItemId', 'draftId', 'revision', 'expectedWorkItemRevision'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { draftId: { type: 'string' }, revision: { type: 'integer' }, status: { type: 'string' }, lines: { type: 'array', items: { type: 'object', properties: { lineNo: { type: 'integer' }, requestedWording: { type: 'string' }, quantity: { type: 'string' }, requestedUom: { type: 'string' }, rowRemark: { type: 'string' } }, additionalProperties: false } } }, required: ['draftId', 'revision', 'status', 'lines'], additionalProperties: false },
  permission: permission('read_order_draft'), scope: scope('account', 'conversation', 'customer', 'workItem', 'draft', 'revision'), sideEffect: 'READ_ONLY', timeout,
  idempotency: readIdempotency, evidence: evidenceRequired, outbound: noneOutbound, grounding: { mode: 'REQUIRED', protectedFactSlots: ['quantity', 'uom', 'delivery_date'], requiresCanonicalRefs: true },
});

const draftMutationOutput: JsonSchema = { type: 'object', properties: { draftId: { type: 'string' }, revision: { type: 'integer' }, status: { type: 'string' } }, required: ['draftId', 'revision', 'status'], additionalProperties: false };

const baseDraftScope = { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, workItemId: { type: 'string' } } as const;
const lineProperties = { lineNo: { type: 'integer' }, requestedWording: { type: 'string' }, quantity: { type: 'string' }, requestedUom: { type: 'string' }, rowRemark: { type: 'string' } } as const;
const lineSchema: JsonSchema = { type: 'object', properties: lineProperties, required: ['lineNo', 'requestedWording', 'quantity', 'requestedUom'], additionalProperties: false };
const draftMutationOutputWithLines: JsonSchema = { type: 'object', properties: { draftId: { type: 'string' }, revision: { type: 'integer' }, status: { type: 'string' }, lines: { type: 'array', items: lineSchema } }, required: ['draftId', 'revision', 'status', 'lines'], additionalProperties: false };

function draftMutation(name: 'create_order_draft' | 'reuse_previous_order' | 'add_line' | 'change_line' | 'remove_line' | 'set_delivery_request', inputSchema: JsonSchema, requiredScope: CapabilityScopeDimension[], outputSchema: JsonSchema = draftMutationOutput) {
  return defineCapability({ name, version: 'v1', inputSchema, outputSchema, permission: permission(name), scope: scope(...requiredScope), sideEffect: 'WORKSPACE_MUTATION', timeout, idempotency: mutationIdempotency, evidence: evidenceOptional, outbound: noneOutbound, grounding: noGrounding });
}

export const createOrderDraft = draftMutation('create_order_draft', { type: 'object', properties: { ...baseDraftScope, sourceMessageId: { type: 'string' }, expectedWorkItemRevision: { type: 'integer' }, requestedDeliveryDate: { type: 'string' }, warehouseId: { type: 'string' }, currency: { type: 'string' }, lines: { type: 'array', items: lineSchema } }, required: ['accountId', 'conversationId', 'customerId', 'workItemId', 'expectedWorkItemRevision', 'lines'], additionalProperties: false }, ['account', 'conversation', 'customer', 'workItem']);
export const reusePreviousOrder = draftMutation('reuse_previous_order', { type: 'object', properties: { ...baseDraftScope, previousSalesOrderId: { type: 'string' }, sourceMessageId: { type: 'string' }, expectedWorkItemRevision: { type: 'integer' }, requestedDeliveryDate: { type: 'string' }, warehouseId: { type: 'string' }, currency: { type: 'string' } }, required: ['accountId', 'conversationId', 'customerId', 'workItemId', 'previousSalesOrderId', 'expectedWorkItemRevision'], additionalProperties: false }, ['account', 'conversation', 'customer', 'workItem'], draftMutationOutputWithLines);
export const addLine = draftMutation('add_line', { type: 'object', properties: { ...baseDraftScope, draftId: { type: 'string' }, expectedDraftRevision: { type: 'integer' }, expectedWorkItemRevision: { type: 'integer' }, sourceMessageId: { type: 'string' }, lineNo: lineProperties.lineNo, requestedWording: lineProperties.requestedWording, quantity: lineProperties.quantity, requestedUom: lineProperties.requestedUom, rowRemark: lineProperties.rowRemark }, required: ['accountId', 'conversationId', 'customerId', 'workItemId', 'draftId', 'expectedDraftRevision', 'expectedWorkItemRevision', 'lineNo', 'requestedWording', 'quantity', 'requestedUom'], additionalProperties: false }, ['account', 'conversation', 'customer', 'workItem', 'draft', 'revision']);
export const changeLine = draftMutation('change_line', { type: 'object', properties: { ...baseDraftScope, draftId: { type: 'string' }, expectedDraftRevision: { type: 'integer' }, expectedWorkItemRevision: { type: 'integer' }, sourceMessageId: { type: 'string' }, lineNo: { type: 'integer' }, change: { type: 'object', properties: { requestedWording: { type: 'string' }, quantity: { type: 'string' }, requestedUom: { type: 'string' }, rowRemark: { type: 'string' } }, additionalProperties: false } }, required: ['accountId', 'conversationId', 'customerId', 'workItemId', 'draftId', 'expectedDraftRevision', 'expectedWorkItemRevision', 'lineNo', 'change'], additionalProperties: false }, ['account', 'conversation', 'customer', 'workItem', 'draft', 'revision']);
export const removeLine = draftMutation('remove_line', { type: 'object', properties: { ...baseDraftScope, draftId: { type: 'string' }, expectedDraftRevision: { type: 'integer' }, expectedWorkItemRevision: { type: 'integer' }, sourceMessageId: { type: 'string' }, lineNo: { type: 'integer' } }, required: ['accountId', 'conversationId', 'customerId', 'workItemId', 'draftId', 'expectedDraftRevision', 'expectedWorkItemRevision', 'lineNo'], additionalProperties: false }, ['account', 'conversation', 'customer', 'workItem', 'draft', 'revision']);
// CAP-001 has no union type: required empty string means clear, matching normalizeDate('').
export const setDeliveryRequest = draftMutation('set_delivery_request', { type: 'object', properties: { ...baseDraftScope, draftId: { type: 'string' }, expectedDraftRevision: { type: 'integer' }, expectedWorkItemRevision: { type: 'integer' }, sourceMessageId: { type: 'string' }, requestedDeliveryDate: { type: 'string' } }, required: ['accountId', 'conversationId', 'customerId', 'workItemId', 'draftId', 'expectedDraftRevision', 'expectedWorkItemRevision', 'requestedDeliveryDate'], additionalProperties: false }, ['account', 'conversation', 'customer', 'workItem', 'draft', 'revision']);

export const validateOrderDraft = defineCapability({
  name: 'validate_order_draft', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, workItemId: { type: 'string' }, draftId: { type: 'string' }, revision: { type: 'integer' }, expectedWorkItemRevision: { type: 'integer' } }, required: ['accountId', 'conversationId', 'customerId', 'workItemId', 'draftId', 'revision', 'expectedWorkItemRevision'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { draftId: { type: 'string' }, draftRevision: { type: 'integer' }, lines: { type: 'array', items: { type: 'object', properties: { lineNo: { type: 'integer' }, productId: { type: 'string' }, quantity: { type: 'string' }, unitPriceCents: { type: 'integer' }, availableBaseQuantity: { type: 'string' } }, additionalProperties: false } }, subtotalCents: { type: 'integer' }, grandTotalCents: { type: 'integer' }, evidenceRefs: { type: 'array', items: { type: 'string' } } }, required: ['draftId', 'draftRevision', 'lines', 'subtotalCents', 'grandTotalCents', 'evidenceRefs'], additionalProperties: false },
  permission: permission('validate_order_draft'), scope: scope('account', 'conversation', 'customer', 'workItem', 'draft', 'revision'), sideEffect: 'WORKSPACE_MUTATION', timeout,
  idempotency: mutationIdempotency, evidence: evidenceRequired, outbound: noneOutbound, grounding: { mode: 'REQUIRED', protectedFactSlots: ['product', 'quantity', 'uom', 'price', 'currency', 'total', 'stock', 'availability', 'delivery_date'], requiresCanonicalRefs: true },
});

export const checkAvailability = defineCapability({
  name: 'check_availability', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, draftId: { type: 'string' }, revision: { type: 'integer' }, warehouseId: { type: 'string' } }, required: ['accountId', 'conversationId', 'customerId', 'draftId', 'revision'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { draftId: { type: 'string' }, revision: { type: 'integer' }, lines: { type: 'array', items: { type: 'object', properties: { lineNo: { type: 'integer' }, availableBaseQuantity: { type: 'string' }, requestedBaseQuantity: { type: 'string' }, available: { type: 'boolean' } }, required: ['lineNo', 'availableBaseQuantity', 'requestedBaseQuantity', 'available'], additionalProperties: false } }, evidenceRefs: { type: 'array', items: { type: 'string' } } }, required: ['draftId', 'revision', 'lines', 'evidenceRefs'], additionalProperties: false },
  permission: permission('check_availability'), scope: scope('account', 'conversation', 'customer', 'draft', 'revision', 'canonical-commerce'), sideEffect: 'READ_ONLY', timeout,
  idempotency: readIdempotency, evidence: evidenceRequired, outbound: noneOutbound, grounding: { mode: 'REQUIRED', protectedFactSlots: ['stock', 'availability', 'quantity', 'uom'], requiresCanonicalRefs: true },
});

export const prepareQuotation = defineCapability({
  name: 'prepare_quotation', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, workItemId: { type: 'string' }, draftId: { type: 'string' }, draftRevision: { type: 'integer' }, expectedWorkItemRevision: { type: 'integer' } }, required: ['accountId', 'conversationId', 'customerId', 'workItemId', 'draftId', 'draftRevision', 'expectedWorkItemRevision'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { quotationId: { type: 'string' }, status: { type: 'string', enum: ['DRAFT'] }, sourceDraftId: { type: 'string' }, sourceDraftRevision: { type: 'integer' }, validationEvidenceRefs: { type: 'array', items: { type: 'string' } } }, required: ['quotationId', 'status', 'sourceDraftId', 'sourceDraftRevision', 'validationEvidenceRefs'], additionalProperties: false },
  permission: permission('prepare_quotation'), scope: scope('account', 'conversation', 'customer', 'workItem', 'draft', 'revision', 'canonical-commerce'), sideEffect: 'CANONICAL_COMMERCE_MUTATION', timeout,
  idempotency: commerceIdempotency, evidence: evidenceRequired, outbound: noneOutbound, grounding: { mode: 'REQUIRED', protectedFactSlots: ['price', 'currency', 'total', 'stock', 'quotation_status'], requiresCanonicalRefs: true },
});

export const sendQuotation = defineCapability({
  name: 'send_quotation', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, quotationId: { type: 'string' }, customerMessage: { type: 'string' }, quotationRevision: { type: 'integer' } }, required: ['accountId', 'conversationId', 'customerId', 'quotationId', 'customerMessage'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { quotationId: { type: 'string' }, status: { type: 'string', enum: ['SENT'] }, quotationNo: { type: 'string' }, evidenceRefs: { type: 'array', items: { type: 'string' } } }, required: ['quotationId', 'status', 'evidenceRefs'], additionalProperties: false },
  permission: permission('send_quotation'), scope: scope('account', 'conversation', 'customer', 'canonical-commerce'), sideEffect: 'CANONICAL_COMMERCE_MUTATION', timeout,
  idempotency: commerceIdempotency, evidence: evidenceRequired, outbound: { disposition: 'CAPABILITY_OWNED_QUOTATION', owner: 'QUOTATION_CAPABILITY', customerMessage: true, quotationOwnership: 'SOLE_QUOTATION_OUTBOUND_OWNER' }, grounding: { mode: 'REQUIRED', protectedFactSlots: ['price', 'currency', 'total', 'quotation_number', 'quotation_status'], requiresCanonicalRefs: true },
});

export const getCommerceStatus = defineCapability({
  name: 'get_commerce_status', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, workItemId: { type: 'string' } }, required: ['accountId', 'conversationId', 'customerId'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { quotationId: { type: 'string' }, quotationStatus: { type: 'string' }, salesOrderId: { type: 'string' }, salesOrderStatus: { type: 'string' }, workItemId: { type: 'string' } }, additionalProperties: false },
  permission: permission('get_commerce_status'), scope: scope('account', 'conversation', 'customer', 'canonical-commerce'), sideEffect: 'READ_ONLY', timeout,
  idempotency: readIdempotency, evidence: evidenceRequired, outbound: noneOutbound, grounding: { mode: 'REQUIRED', protectedFactSlots: ['quotation_status', 'sales_order_status'], requiresCanonicalRefs: true },
});

export const recordCustomerCommitment = defineCapability({
  name: 'record_customer_commitment', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, quotationId: { type: 'string' }, inboundMessageId: { type: 'string' }, commitment: { type: 'string', enum: ['ACCEPT', 'REJECT', 'CHANGE', 'CANCEL'] } }, required: ['accountId', 'conversationId', 'customerId', 'inboundMessageId', 'commitment'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { commitmentStatus: { type: 'string' }, quotationId: { type: 'string' }, salesOrderDraftId: { type: 'string' } }, required: ['commitmentStatus'], additionalProperties: false },
  permission: permission('record_customer_commitment'), scope: scope('account', 'conversation', 'customer', 'canonical-commerce'), sideEffect: 'CANONICAL_COMMERCE_MUTATION', timeout,
  idempotency: commerceIdempotency, evidence: evidenceRequired, outbound: noneOutbound, grounding: { mode: 'REQUIRED', protectedFactSlots: ['commitment_outcome', 'quotation_status', 'quotation_reference'], requiresCanonicalRefs: true },
});

export const createSalesOrderDraft = defineCapability({
  name: 'create_sales_order_draft', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, quotationId: { type: 'string' }, acceptanceEvidenceId: { type: 'string' } }, required: ['accountId', 'conversationId', 'customerId', 'quotationId', 'acceptanceEvidenceId'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { salesOrderDraftId: { type: 'string' }, status: { type: 'string', enum: ['DRAFT'] }, sourceQuotationId: { type: 'string' }, salesOrderNo: { type: 'string' } }, required: ['salesOrderDraftId', 'status', 'sourceQuotationId'], additionalProperties: false },
  permission: permission('create_sales_order_draft'), scope: scope('account', 'conversation', 'customer', 'canonical-commerce'), sideEffect: 'CANONICAL_COMMERCE_MUTATION', timeout,
  idempotency: commerceIdempotency, evidence: evidenceRequired, outbound: noneOutbound, grounding: { mode: 'REQUIRED', protectedFactSlots: ['sales_order_status', 'sales_order_number'], requiresCanonicalRefs: true },
});

export const requestHumanHandoff = defineCapability({
  name: 'request_human_handoff', version: 'v1',
  inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, conversationId: { type: 'string' }, customerId: { type: 'string' }, workItemId: { type: 'string' }, expectedWorkItemRevision: { type: 'integer' }, reasonCode: { type: 'string' }, sourceMessageId: { type: 'string' } }, required: ['accountId', 'conversationId', 'customerId', 'workItemId', 'expectedWorkItemRevision', 'reasonCode'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { workItemId: { type: 'string' }, state: { type: 'string', enum: ['HANDED_OFF'] }, reasonCode: { type: 'string' } }, required: ['workItemId', 'state', 'reasonCode'], additionalProperties: false },
  permission: permission('request_human_handoff'), scope: scope('account', 'conversation', 'customer', 'workItem', 'revision'), sideEffect: 'WORKSPACE_MUTATION', timeout,
  idempotency: mutationIdempotency, evidence: evidenceOptional, outbound: { disposition: 'HANDOFF_NO_CUSTOMER_MESSAGE', owner: 'HANDOFF', customerMessage: false, handoffReasonRequired: true }, grounding: noGrounding,
});

const candidateRegistry = [
  getCustomerContext, getOrderHistory, getOrCreateWorkItem, readOrderDraft, createOrderDraft, reusePreviousOrder,
  addLine, changeLine, removeLine, setDeliveryRequest, validateOrderDraft, checkAvailability, prepareQuotation,
  sendQuotation, getCommerceStatus, recordCustomerCommitment, createSalesOrderDraft, requestHumanHandoff,
] as const;

assertApprovedEmployeeCapabilityCatalog(candidateRegistry);
export const V2_CAPABILITY_REGISTRY = Object.freeze([...candidateRegistry]);

export const V2_CAPABILITY_CATALOG = V2_CAPABILITY_REGISTRY;

const byName = new Map(V2_CAPABILITY_REGISTRY.map(capability => [capability.name, capability] as const));

export function listCapabilities(): readonly CapabilityDefinition[] {
  return V2_CAPABILITY_REGISTRY;
}

export function getCapability(name: string): CapabilityDefinition | undefined {
  return byName.get(name);
}
