import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

type AcceptedQuotationSnapshot = {
  customerId: string;
  currency: string;
  deliveryDate: string | null;
  warehouseId: string;
  remark: string | null;
  subtotalCents: number;
  taxCents: number;
  grandTotalCents: number;
  lines: Array<{
    rowItemNo: number;
    productId: string;
    stockCode: string;
    description: string;
    quantity: number;
    uom: string;
    unitPriceCents: number;
    subtotalCents: number;
  }>;
};

type AcceptanceCommitInput = {
  db: Database.Database;
  quotationId: string;
  inboundMessageId: string;
  verifyQuotationIntegrity: (quotation: any, accountId: string, conversationId: string) => AcceptedQuotationSnapshot;
  audit: (conversationId: string, actor: string, text: string) => void;
};

const uuid = () => randomUUID();
const now = () => new Date().toISOString();

function isBusy(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database (?:is|table is) locked/i.test(String(error));
}

/**
 * The sole accepted-quotation commitment boundary. Authorization is supplied
 * by CommitmentGuard; this function only performs the guarded canonical write.
 * BEGIN IMMEDIATE serializes independent SQLite connections before any
 * acceptance/SO preflight can observe a competing attempt.
 */
export function commitAcceptedQuotation(input: AcceptanceCommitInput): void {
  const { db, quotationId, inboundMessageId, verifyQuotationIntegrity, audit } = input;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const quote = db.prepare("SELECT * FROM quotations WHERE id=? AND status='SENT'").get(quotationId) as any;
        if (!quote) { db.exec('COMMIT'); return; }
        const conversation = db.prepare('SELECT id,channel_account_id,customer_id FROM conversations WHERE id=?')
          .get(quote.source_conversation_id) as any;
        if (!conversation || conversation.channel_account_id == null || conversation.customer_id !== quote.customer_id) {
          throw Error('CANONICAL_SCOPE_MISMATCH');
        }
        const msg = db.prepare("SELECT * FROM messages WHERE id=? AND account_id=? AND conversation_id=? AND direction='INBOUND'")
          .get(inboundMessageId, conversation.channel_account_id, conversation.id) as any;
        if (!msg) throw Error('INBOUND_NOT_PERSISTED');
        // V1 quotations persist the provider/external message id here; V2
        // OrderDraft provenance persists the canonical internal message id.
        // Accept either representation, but keep the same account/conversation
        // and inbound-direction scope so this does not widen authority.
        const source = db.prepare("SELECT id FROM messages WHERE account_id=? AND conversation_id=? AND direction='INBOUND' AND (id=? OR external_message_id=?)")
          .get(conversation.channel_account_id, conversation.id, quote.source_message_id, quote.source_message_id);
        const identity = db.prepare('SELECT 1 FROM customer_channel_identities WHERE channel_account_id=? AND customer_id=? AND external_id=?')
          .get(conversation.channel_account_id, conversation.customer_id, msg.sender_external_id);
        if (!source || !identity) throw Error('CANONICAL_SCOPE_MISMATCH');
        const snapshot = verifyQuotationIntegrity(quote, conversation.channel_account_id, conversation.id);
        if (db.prepare('SELECT id FROM quotation_acceptances WHERE quotation_id=?').get(quotationId) ||
            db.prepare('SELECT id FROM sales_orders WHERE source_quotation_id=?').get(quotationId)) { db.exec('COMMIT'); return; }

        const moved = db.prepare("UPDATE quotations SET status='ACCEPTED',accepted_at=? WHERE id=? AND status='SENT'").run(now(), quotationId);
        if (moved.changes !== 1) { db.exec('COMMIT'); return; }
        db.prepare('INSERT INTO quotation_acceptances VALUES(?,?,?,?,?,?)').run(
          uuid(), quotationId, msg.id, msg.sender_external_id, now(), JSON.stringify({
            text: msg.text, externalMessageId: msg.external_message_id, accountId: msg.account_id,
            conversationId: msg.conversation_id,
          }),
        );

        const sequence = db.prepare("SELECT next_number FROM document_sequences WHERE document_type='sales_order'").get() as any;
        if (!sequence) throw Error('SALES_ORDER_SEQUENCE_MISSING');
        const soId = uuid();
        const soNo = `SO-${String(sequence.next_number).padStart(6, '0')}`;
        db.prepare("UPDATE document_sequences SET next_number=next_number+1 WHERE document_type='sales_order'").run();
        db.prepare('INSERT INTO sales_orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          soId, soNo, snapshot.customerId, 'DRAFT', snapshot.currency, snapshot.deliveryDate,
          snapshot.warehouseId, snapshot.remark, snapshot.subtotalCents, snapshot.taxCents,
          snapshot.grandTotalCents, quotationId, msg.id, null, null,
        );
        const quoteLines = db.prepare('SELECT id,row_item_no FROM quotation_lines WHERE quotation_id=?').all(quotationId) as any[];
        for (const line of snapshot.lines) {
          const source = quoteLines.find(candidate => candidate.row_item_no === line.rowItemNo);
          if (!source) throw Error('QUOTE_INTEGRITY_INVALID');
          db.prepare('INSERT INTO sales_order_lines VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
            uuid(), soId, source.id, line.rowItemNo, line.productId, line.stockCode, line.description,
            line.quantity, line.uom, line.unitPriceCents, line.subtotalCents,
          );
        }
        audit(msg.conversation_id, 'Customer', 'Explicit acceptance recorded.');
        audit(msg.conversation_id, 'AI Employee', `Draft Sales Order ${soNo} created. STAFF ACTION REQUIRED.`);
        db.exec('COMMIT');
        return;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* rollback may already have completed */ }
        throw error;
      }
    } catch (error) {
      if (!isBusy(error)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw Error('ACCEPTANCE_COMMIT_RETRY_EXHAUSTED');
}
