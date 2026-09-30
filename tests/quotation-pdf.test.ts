import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { quotationPdfAttachment, renderQuotationPdf, type FrozenQuotationSnapshot } from '../src/quotation-pdf.js';

const snapshot: FrozenQuotationSnapshot = { quotationNo: 'QT-000001', quotationDate: '2026-09-12', validUntil: '2026-09-19', customerId: 'CUST-001', deliveryDate: '2026-09-15', warehouseId: 'SG-MAIN', currency: 'SGD', lines: [{ rowItemNo: 1, stockCode: 'FCH-WHOLE-12', description: 'Frozen Whole Chicken', quantity: 10, uom: 'CTN', unitPriceCents: 4800, subtotalCents: 48000 }], subtotalCents: 48000, taxCents: 0, grandTotalCents: 48000 };

test('quotation PDF is valid, deterministic, and contains only frozen snapshot facts', () => {
  const first = renderQuotationPdf(snapshot); const second = renderQuotationPdf(structuredClone(snapshot));
  assert.equal(first.toString('ascii', 0, 5), '%PDF-'); assert.deepEqual(first, second);
  const body = first.toString('latin1');
  for (const fact of ['QT-000001', '2026-09-12', '2026-09-19', 'CUST-001', '2026-09-15', 'SG-MAIN', 'FCH-WHOLE-12', 'Frozen Whole Chicken', '10', 'CTN', 'SGD 480.00', 'SGD 480.00', 'Staff owns Sales Order posting']) assert.match(body, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(createHash('sha256').update(first).digest('hex'), createHash('sha256').update(second).digest('hex'));
});

test('quotation attachment uses safe provider-neutral deterministic data reference', () => {
  const attachment = quotationPdfAttachment(snapshot);
  assert.deepEqual(Object.keys(attachment), ['mimeType', 'fileName', 'ref', 'sha256']);
  assert.equal(attachment.mimeType, 'application/pdf'); assert.equal(attachment.fileName, 'QT-000001.pdf');
  assert.equal(attachment.ref, quotationPdfAttachment(snapshot).ref); assert.match(attachment.ref, /^data:application\/pdf;base64,/);
});

test('quotation PDF paginates without clipping and rejects unsupported Unicode', () => {
  const many = { ...snapshot, lines: Array.from({ length: 80 }, (_, i) => ({ ...snapshot.lines[0], rowItemNo: i + 1, description: `Item ${i} with a deliberately long description that must wrap safely` })) };
  const pdf = renderQuotationPdf(many);
  assert.ok((pdf.toString('ascii').match(/\/Type \/Page\b/g) ?? []).length > 1);
  assert.ok(pdf.length < 2_000_000);
  assert.throws(() => renderQuotationPdf({ ...snapshot, customerName: '客户' }), /QUOTATION_SNAPSHOT_CUSTOMERNAME_INVALID/);
});

test('quotation snapshot validation rejects missing and empty legacy snapshots', () => {
  assert.throws(() => renderQuotationPdf({} as FrozenQuotationSnapshot), /QUOTATION_SNAPSHOT/);
  assert.throws(() => renderQuotationPdf(null as unknown as FrozenQuotationSnapshot), /QUOTATION_SNAPSHOT/);
});

test('quotation snapshot quantity validation is finite, bounded, and preserves valid fractions', () => {
  for (const quantity of [NaN, Infinity, -Infinity, Number.MAX_VALUE, '1e309', '1.2.3', '1.2345']) {
    assert.throws(() => renderQuotationPdf({ ...snapshot, lines: [{ ...snapshot.lines[0], quantity }] } as FrozenQuotationSnapshot), /QUOTATION_SNAPSHOT_QUANTITY_INVALID/);
  }
  assert.doesNotThrow(() => renderQuotationPdf({ ...snapshot, lines: [{ ...snapshot.lines[0], quantity: '1.125' }] }));
});
