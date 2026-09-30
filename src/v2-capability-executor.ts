import type { AgentActionProjection } from './v2-agent-turn-coordinator.js';
import { getCapability } from './v2-capability-registry.js';
import { WorkItemService } from './v2-work-item.js';
import { OrderDraftService } from './v2-order-draft.js';
import { OrderValidationService } from './v2-order-validation.js';
import { V2QuotationService } from './v2-quotation.js';
import { CommitmentGuard, narrowCommitmentProposal } from './v2-commitment-guard.js';
import type { CommerceService } from './commerce.js';
import { V1Database } from './database.js';

/** Host-only dispatcher. Model projections never select a handler or authority. */
export class V2CapabilityExecutor {
  private readonly work: WorkItemService;
  private readonly drafts: OrderDraftService;
  private readonly validation: OrderValidationService;
  private readonly quotation: V2QuotationService;
  private readonly commitment: CommitmentGuard;
  constructor(private readonly database: V1Database, private readonly commerce: CommerceService) {
    this.work = new WorkItemService(database); this.drafts = new OrderDraftService(database, this.work);
    this.validation = new OrderValidationService(database); this.quotation = new V2QuotationService(database, commerce);
    this.commitment = new CommitmentGuard(database.db);
  }
  async execute(action: AgentActionProjection, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw Error('V2_CAPABILITY_CANCELLED');
    const name = action.capability.name, a = action.arguments as any;
    if (!getCapability(name)) throw Error('UNKNOWN_CAPABILITY');
    const scope = { accountId: String(a.accountId), conversationId: String(a.conversationId) };
    const turnSource = this.database.db.prepare('SELECT t.inbound_message_id FROM agent_actions aa JOIN agent_turns t ON t.id=aa.turn_id WHERE aa.id=?').get(action.id) as {inbound_message_id:string}|undefined;
    const sourceMessageId = a.sourceMessageId ?? turnSource?.inbound_message_id;
    const opts = { idempotencyKey: `v2:${action.id}`, actorType: 'AI' as const, sourceMessageId, expectedWorkItemRevision: a.expectedWorkItemRevision };
    switch (name) {
      case 'get_customer_context': return this.result(this.database.db.prepare('SELECT id AS customerId,code,name,currency,default_warehouse_id AS warehouseId,credit_status AS creditStatus FROM customers WHERE id=?').get(a.customerId));
      case 'get_order_history': return this.ok({ orders: this.database.db.prepare('SELECT id,sales_order_no AS salesOrderNo,delivery_date AS date,grand_total_cents AS grandTotalCents FROM sales_orders WHERE customer_id=? ORDER BY posted_at DESC,rowid DESC LIMIT ?').all(a.customerId, Math.min(Number(a.limit ?? 5), 20)) });
      case 'get_or_create_work_item': return this.ok(this.workItemData(this.work.getOrCreate({ ...scope, customerId:a.customerId, sourceMessageId:opts.sourceMessageId, goalSummary:a.goalSummary, idempotencyKey:opts.idempotencyKey, actorType:'AI' })));
      case 'read_order_draft': { const draft=this.drafts.read(a.draftId); return draft ? this.ok(this.draftData(draft,true)) : { status:'BLOCKED', evidence:[], stateChanges:[], reasonCode:'NOT_FOUND' }; }
      case 'create_order_draft': return this.ok(this.draftData(this.drafts.create({ ...scope, customerId:a.customerId, workItemId:a.workItemId, sourceMessageId:opts.sourceMessageId, requestedDeliveryDate:a.requestedDeliveryDate, warehouseId:a.warehouseId, currency:a.currency, lines:a.lines }, opts)));
      case 'reuse_previous_order': return this.ok(this.draftData(this.drafts.reusePreviousOrder({ ...scope, customerId:a.customerId, workItemId:a.workItemId, previousSalesOrderId:a.previousSalesOrderId, sourceMessageId:opts.sourceMessageId, requestedDeliveryDate:a.requestedDeliveryDate, warehouseId:a.warehouseId, currency:a.currency }, opts),true));
      case 'add_line': return this.ok(this.draftData(this.drafts.addLine(a.draftId, { lineNo:a.lineNo, requestedWording:a.requestedWording, quantity:a.quantity, requestedUom:a.requestedUom, rowRemark:a.rowRemark }, { ...opts, expectedDraftRevision:a.expectedDraftRevision })));
      case 'change_line': return this.ok(this.draftData(this.drafts.changeLine(a.draftId, a.lineNo, a.change, { ...opts, expectedDraftRevision:a.expectedDraftRevision })));
      case 'remove_line': return this.ok(this.draftData(this.drafts.removeLine(a.draftId, a.lineNo, { ...opts, expectedDraftRevision:a.expectedDraftRevision })));
      case 'set_delivery_request': return this.ok(this.draftData(this.drafts.setDeliveryRequest(a.draftId, a.requestedDeliveryDate, { ...opts, expectedDraftRevision:a.expectedDraftRevision })));
      case 'validate_order_draft': return this.validationResult(await this.drafts.validate(a.draftId, { ...opts, expectedDraftRevision:a.revision }));
      case 'check_availability': return this.availabilityResult(await this.validation.validateDraft({ draftId:a.draftId, revision:a.revision }));
      case 'prepare_quotation': return this.quotationPrepareResult(await this.quotation.prepare({ scope, draftId:a.draftId, revision:a.draftRevision ?? a.revision, expectedWorkItemRevision:a.expectedWorkItemRevision }), a.draftId, a.draftRevision ?? a.revision);
      case 'send_quotation': return this.quotationSendResult(await this.quotation.send(a.quotationId, a.customerMessage));
      case 'get_commerce_status': return this.ok(this.database.db.prepare("SELECT q.id AS quotationId,q.status AS quotationStatus,s.id AS salesOrderId,s.status AS salesOrderStatus FROM quotations q LEFT JOIN sales_orders s ON s.source_quotation_id=q.id WHERE q.source_conversation_id=? ORDER BY q.rowid DESC LIMIT 1").get(scope.conversationId) ?? {});
      case 'record_customer_commitment': {
        const proposal = narrowCommitmentProposal({ kind:a.commitment }, { accountId:scope.accountId, conversationId:scope.conversationId, inboundMessageId:a.inboundMessageId });
        const guard = this.commitment.authorize(proposal);
        if (guard.outcome === 'APPLIED' && guard.reasonCode === 'ACCEPTED') this.commerce.acceptV2(a.inboundMessageId);
        const so=this.database.db.prepare('SELECT id FROM sales_orders WHERE source_quotation_id=?').get(guard.quoteRef?.id ?? '') as {id:string}|undefined;
        return this.ok({ commitmentStatus:guard.reasonCode, ...(guard.quoteRef?.id?{quotationId:guard.quoteRef.id}:{}), ...(so?.id?{salesOrderDraftId:so.id}:{}) });
      }
      case 'create_sales_order_draft': {
        const so = this.database.db.prepare("SELECT id AS salesOrderDraftId,status,source_quotation_id AS sourceQuotationId,sales_order_no AS salesOrderNo FROM sales_orders WHERE source_quotation_id=? AND status='DRAFT'").get(a.quotationId);
        if (!so) throw Error('ACCEPTANCE_REQUIRED');
        return this.ok(so);
      }
      case 'request_human_handoff': { const work=this.work.transition({ workItemId:a.workItemId, accountId:scope.accountId, conversationId:scope.conversationId, to:'HANDED_OFF', expectedRevision:a.expectedWorkItemRevision, idempotencyKey:opts.idempotencyKey, actorType:'AI', sourceMessageId:opts.sourceMessageId, reason:a.reasonCode }); return this.ok({workItemId:work.id,state:work.state,reasonCode:work.blocking_reason??a.reasonCode}); }
      default: throw Error('UNKNOWN_CAPABILITY');
    }
  }
  private workItemData(row:any){ return {workItemId:row.id,state:row.state,revision:row.revision}; }
  private draftData(row:any,includeLines=false){ const data:any={draftId:row.id,revision:row.current_revision,status:row.status}; if(includeLines)data.lines=(row.lines??[]).map((line:any)=>({lineNo:line.line_no,requestedWording:line.requested_wording,quantity:String(line.quantity),requestedUom:line.requested_uom,...(line.row_remark?{rowRemark:line.row_remark}:{})})); return data; }
  private validationResult(result:any){ if(result?.status!=='SUCCEEDED'||!result.data)return result; const d=result.data; return {...result,data:{draftId:d.draftId,draftRevision:d.draftRevision,lines:(d.lines??[]).map((line:any)=>({lineNo:line.lineNo,productId:line.productId,quantity:String(line.quantity),unitPriceCents:line.unitPriceCents,availableBaseQuantity:String(line.availableBaseQuantity)})),subtotalCents:d.subtotalCents,grandTotalCents:d.grandTotalCents,evidenceRefs:d.evidenceRefs??[]}}; }
  private availabilityResult(result:any){ if(result?.status!=='SUCCEEDED'||!result.data)return result; const d=result.data; return {...result,data:{draftId:d.draftId,revision:d.draftRevision??d.revision,lines:(d.lines??[]).map((line:any)=>({lineNo:line.lineNo,availableBaseQuantity:String(line.availableBaseQuantity),requestedBaseQuantity:String(line.baseQuantity??line.requestedBaseQuantity),available:Number(line.availableBaseQuantity)>=Number(line.baseQuantity??line.requestedBaseQuantity)})),evidenceRefs:d.evidenceRefs??[]}}; }
  private quotationPrepareResult(result:any,draftId:string,draftRevision:number){ if(result?.status!=='SUCCEEDED'||!result.data)return result; return {...result,data:{quotationId:result.data.id,status:result.data.status,sourceDraftId:draftId,sourceDraftRevision:draftRevision,validationEvidenceRefs:(result.evidence??[]).map((ref:any)=>ref.sourceId)}}; }
  private quotationSendResult(result:any){ if(result?.status!=='SUCCEEDED'||!result.data)return result; return {...result,data:{quotationId:result.data.id,status:result.data.status,...(result.data.quotationNo?{quotationNo:result.data.quotationNo}:{}),evidenceRefs:(result.evidence??[]).map((ref:any)=>ref.sourceId)}}; }
  private ok(data:unknown){ return { status:'SUCCEEDED', data, evidence:[], stateChanges:[] }; }
  private result(data:unknown){ return data ? this.ok(data) : { status:'BLOCKED', evidence:[], stateChanges:[], reasonCode:'NOT_FOUND' }; }
}
