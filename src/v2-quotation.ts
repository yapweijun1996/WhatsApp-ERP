import { randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { V1Database } from './database.js';
import { CommerceService, quotationCommercialSealPayload } from './commerce.js';
import { OrderValidationService, quoteValidationFreshnessFingerprint, type OrderValidationData } from './v2-order-validation.js';
import { WorkItemService } from './v2-work-item.js';
import type { ConversationScope, QuotationService, ServiceResult, QuoteRef } from './v2-domain-contracts.js';

const now = () => new Date().toISOString();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * V2 quotation boundary. Preparation owns only the immutable draft/ERP
 * snapshot; outbound ownership is delegated to OutboundMessageService.
 */
export class V2QuotationService implements QuotationService {
  constructor(public readonly database = new V1Database(':memory:'), private readonly commerce?: CommerceService) {}

  private get db(): Database.Database { return this.database.db; }

  private result(q: any, out?: any): ServiceResult<QuoteRef> {
    if (!q) return { status: 'FAILED', evidence: [], stateChanges: [], reasonCode: 'QUOTE_NOT_FOUND' };
    const evidence = out ? [{ sourceId: out.id, sourceVersion: out.status }] : [];
    if (q.status === 'SENT' && out?.status === 'SUBMITTED') return { status: 'SUCCEEDED', data: { id: q.id, status: q.status, quotationNo: q.quotation_no }, evidence, stateChanges: [{ entity: 'QUOTATION', id: q.id, to: 'SENT' }] };
    if (out?.status === 'PENDING' || out?.status === 'UNKNOWN') return { status: 'BLOCKED', data: { id: q.id, status: q.status, quotationNo: q.quotation_no }, evidence, stateChanges: [], reasonCode: out.status === 'PENDING' ? 'OUTBOUND_PENDING' : 'OUTBOUND_RECONCILIATION_REQUIRED' };
    if (out?.status === 'FAILED' && String(out.last_error ?? '').startsWith('retryable:')) return { status: 'RETRYABLE', data: { id: q.id, status: q.status, quotationNo: q.quotation_no }, evidence, stateChanges: [], reasonCode: 'OUTBOUND_RETRYABLE_FAILURE', retryable: true };
    if (out?.status === 'FAILED') return { status: 'FAILED', data: { id: q.id, status: q.status, quotationNo: q.quotation_no }, evidence, stateChanges: [], reasonCode: 'OUTBOUND_TERMINAL_FAILURE' };
    return { status: 'BLOCKED', data: { id: q.id, status: q.status, quotationNo: q.quotation_no }, evidence, stateChanges: [], reasonCode: `QUOTE_NOT_SENT:${q.status}` };
  }

  async prepare(input: { scope: ConversationScope; draftId: string; revision: number; expectedWorkItemRevision?: number }): Promise<ServiceResult<QuoteRef>> {
    const work=new WorkItemService(this.database);
    try { work.requireV2Writer(input.scope.accountId,input.scope.conversationId); } catch(error) { return { status:'BLOCKED', evidence:[], stateChanges:[], reasonCode:(error as Error).message }; }
    const draft = this.db.prepare("SELECT * FROM order_drafts WHERE id=? AND status='CURRENT'").get(input.draftId) as any;
    if (!draft || draft.account_id !== input.scope.accountId || draft.conversation_id !== input.scope.conversationId) return { status: 'BLOCKED', evidence: [], stateChanges: [], reasonCode: 'DRAFT_SCOPE' };
    if (draft.current_revision !== input.revision) return { status: 'BLOCKED', evidence: [], stateChanges: [], reasonCode: 'STALE_DRAFT_REVISION' };

    // A replay of preparation is the same immutable quote, never a new quote.
    const existing = (this.db.prepare("SELECT * FROM quotations WHERE source_conversation_id=? AND status='DRAFT' ORDER BY rowid DESC").all(input.scope.conversationId) as any[]).find(q => {
      try { const s = JSON.parse(q.sent_snapshot_json); return s.sourceDraftId === input.draftId && s.sourceDraftRevision === input.revision; } catch { return false; }
    });
    if (existing) return { status: 'SUCCEEDED', data: { id: existing.id, status: existing.status, quotationNo: existing.quotation_no }, evidence: [], stateChanges: [], reasonCode: 'QUOTATION_PREPARED' };
    if (this.db.prepare("SELECT 1 FROM outbound_messages WHERE conversation_id=? AND entity_type='QUOTATION' AND status IN ('PENDING','UNKNOWN')").get(input.scope.conversationId)) return { status: 'BLOCKED', evidence: [], stateChanges: [], reasonCode: 'OUTBOUND_RECONCILIATION_REQUIRED' };
    if (this.db.prepare("SELECT 1 FROM quotations WHERE source_conversation_id=? AND status='DRAFT'").get(input.scope.conversationId)) return { status: 'BLOCKED', evidence: [], stateChanges: [], reasonCode: 'CANONICAL_QUOTE_ACTION_REQUIRED' };
    const oldSent=this.db.prepare("SELECT id FROM quotations WHERE source_conversation_id=? AND status='SENT' LIMIT 1").get(input.scope.conversationId);
    if(oldSent){const wi=this.db.prepare('SELECT id,state FROM work_items WHERE active_order_draft_id=? AND account_id=? AND conversation_id=?').get(input.draftId,input.scope.accountId,input.scope.conversationId) as any;const requote=this.db.prepare("SELECT 1 FROM order_draft_revisions WHERE draft_id=? AND revision=? AND action_type='PREPARE_REQUOTE'").get(input.draftId,input.revision);if(!wi||wi.state!=='CHANGING'||!requote)return {status:'BLOCKED',evidence:[],stateChanges:[],reasonCode:'REQUOTE_PREPARATION_REQUIRED'};}
    const committed = this.db.prepare("SELECT 1 FROM quotations q LEFT JOIN sales_orders s ON s.source_quotation_id=q.id WHERE q.source_conversation_id=? AND (q.status='ACCEPTED' OR s.status='DRAFT')").get(input.scope.conversationId);
    if (committed) return { status: 'BLOCKED', evidence: [], stateChanges: [], reasonCode: 'CANONICAL_COMMITMENT_HANDOFF' };

    const validation = await new OrderValidationService(this.database).validateForQuotation({ draftId: input.draftId, revision: input.revision, expectedWorkItemRevision: input.expectedWorkItemRevision });
    if (validation.status !== 'SUCCEEDED' || !validation.data) return validation as unknown as ServiceResult<QuoteRef>;
    const data = validation.data as OrderValidationData;
    let q:any;
    try { q = this.database.runImmediate(() => {
      const current = this.db.prepare("SELECT * FROM order_drafts WHERE id=? AND status='CURRENT'").get(input.draftId) as any;
      if (!current || current.current_revision !== input.revision) throw Error('STALE_DRAFT_REVISION');
      const wi = this.db.prepare('SELECT * FROM work_items WHERE id=? AND account_id=? AND conversation_id=? AND customer_id=?').get(current.work_item_id, input.scope.accountId, input.scope.conversationId, current.customer_id) as any;
      if (!wi || input.expectedWorkItemRevision !== undefined && wi.revision !== input.expectedWorkItemRevision) throw Error('STALE_WORK_ITEM_REVISION');
      // All eligibility that can change while deterministic validation is
      // running is re-read under the same BEGIN IMMEDIATE as quote creation.
      if (this.db.prepare("SELECT 1 FROM outbound_messages WHERE conversation_id=? AND entity_type='QUOTATION' AND status IN ('PENDING','UNKNOWN')").get(input.scope.conversationId)) throw Error('OUTBOUND_RECONCILIATION_REQUIRED');
      const duplicate = (this.db.prepare("SELECT * FROM quotations WHERE source_conversation_id=? AND status='DRAFT'").get(input.scope.conversationId) as any);
      if (duplicate) return duplicate;
      const oldSent = this.db.prepare("SELECT id FROM quotations WHERE source_conversation_id=? AND status='SENT' LIMIT 1").get(input.scope.conversationId);
      if (oldSent) {
        const requote = this.db.prepare("SELECT 1 FROM order_draft_revisions WHERE draft_id=? AND revision=? AND action_type='PREPARE_REQUOTE'").get(input.draftId, input.revision);
        if (wi.state !== 'CHANGING' || !requote) throw Error('REQUOTE_PREPARATION_REQUIRED');
      }
      if (this.db.prepare("SELECT 1 FROM quotations q LEFT JOIN sales_orders s ON s.source_quotation_id=q.id WHERE q.source_conversation_id=? AND (q.status='ACCEPTED' OR s.status='DRAFT')").get(input.scope.conversationId)) throw Error('CANONICAL_COMMITMENT_HANDOFF');
      if (data.freshnessFingerprint!==quoteValidationFreshnessFingerprint(this.db,input.draftId,input.revision,data)) throw Error('VALIDATION_STALE');
      const id = randomUUID(), quotationNo = this.database.takeDocumentNumber('quotation', 'QT'), t = now();
      const validUntil = new Date(Date.now() + 604800000).toISOString();
      const snapshot = { sourceValidationId:data.validationId, sourceDraftId: input.draftId, sourceDraftRevision: input.revision, validationFreshnessFingerprint:data.freshnessFingerprint, quotationNo, quotationDate:t, validUntil, customerId: data.customer.id, customerName: data.customer.name, warehouseId: data.warehouseId, currency: data.currency, deliveryDate: current.requested_delivery_date, remark: null, lines: data.lines.map(line => ({ rowItemNo: line.lineNo, productId: line.productId, stockCode: line.stockCode, description: line.description, rowItemRemark: (this.db.prepare('SELECT row_remark FROM order_draft_lines WHERE draft_id=? AND line_no=?').get(input.draftId, line.lineNo) as any)?.row_remark ?? null, quantity: line.quantity, uom: line.requestedUom, unitPriceCents: line.unitPriceCents, subtotalCents: line.subtotalCents, availableBase: line.availableBaseQuantity })), subtotalCents: data.subtotalCents, taxCents: data.taxCents, grandTotalCents: data.grandTotalCents, validationEvidenceRefs: data.evidenceRefs };
      const json = JSON.stringify(snapshot);
      this.db.prepare('INSERT INTO quotations(id,quotation_no,customer_id,status,currency,quotation_date,valid_until,delivery_date,warehouse_id,remark,subtotal_cents,tax_cents,grand_total_cents,source_conversation_id,source_message_id,sent_snapshot_json,sent_snapshot_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, quotationNo, data.customer.id, 'DRAFT', data.currency, t, validUntil, current.requested_delivery_date, data.warehouseId, null, data.subtotalCents, data.taxCents, data.grandTotalCents, input.scope.conversationId, current.source_message_id, json, sha(json));
      const evidenceTypes=new Map<string,string>((this.db.prepare(`SELECT id,evidence_type FROM erp_evidence WHERE id IN (${data.evidenceRefs.map(()=>'?').join(',')})`).all(...data.evidenceRefs) as any[]).map(e=>[e.id,e.evidence_type]));
      const roles:Record<string,string>={customer_eligibility:'customer',product_resolution:'product',uom_resolution:'uom',uom_conversion:'uom_conversion',customer_price:'price',warehouse_stock:'stock',order_history:'order_history',warehouse:'warehouse',draft_delivery:'delivery'};
      for (const line of data.lines) {
        const lineId = randomUUID(); this.db.prepare('INSERT INTO quotation_lines VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(lineId, id, line.lineNo, line.productId, line.stockCode, line.description, (this.db.prepare('SELECT row_remark FROM order_draft_lines WHERE draft_id=? AND line_no=?').get(input.draftId, line.lineNo) as any)?.row_remark ?? null, line.quantity, line.requestedUom, line.unitPriceCents, line.subtotalCents);
        for (const evidenceId of data.evidenceRefs) { const role=roles[evidenceTypes.get(evidenceId)??'']; if(!role)throw Error('VALIDATION_EVIDENCE_TYPE_INVALID'); this.db.prepare('INSERT INTO quotation_line_evidence VALUES(?,?,?)').run(lineId, evidenceId, role); this.database.insertGroundingProvenance({ evidenceId, accountId: input.scope.accountId, conversationId: input.scope.conversationId, customerId: data.customer.id, draftId: input.draftId, draftRevision: input.revision, quotationId: id, linkType: 'V2_QUOTATION', createdAt: t }); }
      }
      const payload = quotationCommercialSealPayload(this.db, id, json); this.database.insertCommercialIntegritySeal({ entityType: 'QUOTATION', entityId: id, accountId: input.scope.accountId, conversationId: input.scope.conversationId, customerId: data.customer.id, lineageId: id, payloadJson: payload, payloadHash: sha(payload), sealedAt: t });
      return this.db.prepare('SELECT * FROM quotations WHERE id=?').get(id);
    }); } catch(error) { return {status:'BLOCKED',evidence:[],stateChanges:[],reasonCode:(error as Error).message}; }
    return { status: 'SUCCEEDED', data: { id: q.id, status: q.status, quotationNo: q.quotation_no }, evidence: data.evidenceRefs.map(sourceId => ({ sourceId, sourceVersion: 'v2-erp-sql-1' })), stateChanges: [{ entity: 'QUOTATION', id: q.id, to: 'DRAFT' }], reasonCode: 'QUOTATION_PREPARED' };
  }

  async send(quotationId: string, customerMessage?: string): Promise<ServiceResult<QuoteRef>> {
    if (!this.commerce) return { status: 'FAILED', evidence: [], stateChanges: [], reasonCode: 'COMMERCE_SEND_SEAM_REQUIRED' };
    try {
      if (customerMessage === undefined) throw Error('V2_QUOTATION_MESSAGE_REQUIRED');
      const safeMessage=customerMessage;
      const out = await this.commerce.outbound.sendQuotationV2(quotationId, safeMessage);
      const q = this.db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId) as any;
      return this.result(q, out);
    } catch (error) { return { status: 'FAILED', evidence: [], stateChanges: [], reasonCode: (error as Error).message }; }
  }

  async reconcile(): Promise<ServiceResult<unknown>> {
    if (!this.commerce) return { status: 'FAILED', evidence: [], stateChanges: [], reasonCode: 'COMMERCE_SEND_SEAM_REQUIRED' };
    await this.commerce.outbound.reconcile();
    const unresolved = this.db.prepare("SELECT id,status FROM outbound_messages WHERE entity_type='QUOTATION' AND status IN ('PENDING','UNKNOWN') ORDER BY rowid LIMIT 1").get() as any;
    if (unresolved) return { status: 'BLOCKED', evidence: [{ sourceId: unresolved.id, sourceVersion: unresolved.status }], stateChanges: [], reasonCode: 'OUTBOUND_RECONCILIATION_REQUIRED' };
    return { status: 'SUCCEEDED', evidence: [], stateChanges: [] };
  }
}
