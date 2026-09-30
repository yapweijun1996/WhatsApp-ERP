import type { IncomingChannelMessage, OutgoingChannelMessage } from './channel-contract.js';
import type { CapabilityResult, EvidenceRef, StateChangeRef } from './v2-capability-result.js';
import type { CommitmentProposal, CommitmentGuardResult } from './v2-commitment-guard.js';
import type { FreshGroundingAuthorization } from './v2-response-grounding.js';

export type { EvidenceRef, StateChangeRef };
export type ServiceResult<T> = CapabilityResult<T>;
export type ActorRef = { kind: 'CUSTOMER' | 'AI' | 'STAFF' | 'SYSTEM'; id?: string };
export type ConversationScope = { accountId: string; conversationId: string };
export type WorkspaceState = 'OPEN' | 'NEEDS_CLARIFICATION' | 'DRAFTING' | 'READY_TO_QUOTE' | 'QUOTING' | 'AWAITING_ACCEPTANCE' | 'CHANGING' | 'HANDED_OFF' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
export type WorkspaceActorType = 'CUSTOMER' | 'AI' | 'STAFF' | 'SYSTEM';
export type WorkItemContract = { id:string; account_id:string; conversation_id:string; customer_id:string; type:'SALES_ORDER_REQUEST'; state:WorkspaceState; revision:number; goal_summary:string; active_order_draft_id?:string|null; active_quotation_id?:string|null; source_message_id?:string|null; created_at:string; updated_at:string };
export type OrderDraftLineContract = { line_no:number; requested_wording:string; quantity:string; requested_uom:string; row_remark?:string|null; resolved_product_id?:string|null; resolved_uom?:string|null; evidence_refs_json?:string|null };
export type OrderDraftContract = { id:string; work_item_id:string; account_id:string; conversation_id:string; customer_id:string; status:'CURRENT'|'SUPERSEDED'|'CANCELLED'; current_revision:number; requested_delivery_date?:string|null; warehouse_id?:string|null; currency?:string|null; source_message_id?:string|null; created_at?:string; updated_at?:string; lines?:OrderDraftLineContract[] };
export type MaybePromise<T> = T | Promise<T>;
export type QuoteRef = { id: string; status: string; quotationNo?: string };
export type SalesOrderDraftRef = { id: string; status: 'DRAFT'; salesOrderNo?: string };
export interface CommitmentGuardService { authorize(input: CommitmentProposal): CommitmentGuardResult; }

export interface ConversationService {
  receive(message: IncomingChannelMessage): Promise<unknown>;
  read(scope: ConversationScope): Promise<unknown>;
}
export interface WorkItemService {
  getOrCreate(input:{accountId:string;conversationId:string;customerId:string;sourceMessageId?:string;goalSummary?:string;idempotencyKey:string;actorType?:WorkspaceActorType;actorId?:string}): MaybePromise<WorkItemContract>;
  read(id:string): MaybePromise<WorkItemContract|undefined>;
  transition(input:{workItemId:string;accountId:string;conversationId:string;to:WorkspaceState;expectedRevision:number;idempotencyKey:string;actorType:WorkspaceActorType;actorId?:string;sourceMessageId?:string;reason?:string}): MaybePromise<WorkItemContract>;
  bindSentQuotation(input:{workItemId:string;accountId:string;conversationId:string;customerId:string;draftId:string;quotationId:string;expectedRevision:number;idempotencyKey:string}): MaybePromise<WorkItemContract>;
}
export interface OrderDraftService {
  read(id:string): MaybePromise<OrderDraftContract|undefined>;
  create(input:{workItemId:string;accountId:string;conversationId:string;customerId:string;sourceMessageId?:string;requestedDeliveryDate?:string|null;warehouseId?:string|null;currency?:string|null;lines:Array<{lineNo:number;requestedWording:string;quantity:string|number;requestedUom:string;rowRemark?:string}>},opts:{idempotencyKey:string;actorType?:WorkspaceActorType;actorId?:string;expectedWorkItemRevision:number}): MaybePromise<OrderDraftContract>;
  update(draftId:string,input:{sourceMessageId?:string;requestedDeliveryDate?:string|null;warehouseId?:string|null;currency?:string|null;lines:Array<{lineNo:number;requestedWording:string;quantity:string|number;requestedUom:string;rowRemark?:string}>},opts:{idempotencyKey:string;actorType?:WorkspaceActorType;actorId?:string;expectedDraftRevision:number;expectedWorkItemRevision:number}): MaybePromise<OrderDraftContract>;
}
export interface OrderValidationService {
  validateForQuotation(input: { draftId: string; revision: number; expectedWorkItemRevision?: number }): Promise<ServiceResult<unknown>>;
}
export interface QuotationService {
  prepare(input: { scope: ConversationScope; draftId: string; revision: number; expectedWorkItemRevision?: number }): Promise<ServiceResult<QuoteRef>>;
  send(quotationId: string, customerMessage?: string): Promise<ServiceResult<QuoteRef>>;
  reconcile(): Promise<ServiceResult<unknown>>;
}
export interface AcceptanceCommitmentService {
  record(input: { message: IncomingChannelMessage; quotationId?: string }): Promise<ServiceResult<SalesOrderDraftRef>>;
}
export interface SalesOrderDraftService {
  createFromAcceptedQuotation(quotationId: string): Promise<ServiceResult<SalesOrderDraftRef>>;
}
export interface StaffCommitService {
  commit(input: { action: 'post' | 'confirm' | 'do'; capability: unknown; idempotencyKey: string; evidence?: string; salesOrderNo: string }): Promise<unknown>;
}
export interface OutboundMessageService {
  send(message: OutgoingChannelMessage): Promise<ServiceResult<{ externalMessageId?: string }>>;
  sendTurnResponse(input: { authorization: FreshGroundingAuthorization; replyToExternalMessageId?: string }): Promise<unknown>;
  reconcile(): Promise<ServiceResult<unknown>>;
}
