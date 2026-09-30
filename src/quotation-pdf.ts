import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { normalizeQuantity } from './v2-order-draft.js';

export type FrozenQuotationSnapshot = {
  quotationNo: string; quotationDate?: string; validUntil?: string; customerId: string; customerName?: string;
  deliveryDate?: string | null; warehouseId?: string | null; currency: string; remark?: string | null;
  lines: Array<{ rowItemNo: number; productId?: string; stockCode: string; description: string; rowItemRemark?: string | null; quantity: string | number; uom: string; unitPriceCents: number; subtotalCents: number }>;
  subtotalCents: number; taxCents: number; grandTotalCents: number;
};

const MAX_STRING = 256, MAX_LINES = 1000, PAGE_LINES = 48;
export const MAX_QUOTATION_PDF_BYTES = 2_000_000;
export const QUOTATION_PDF_DATA_URI_PREFIX = 'data:application/pdf;base64,';
const text = (value: unknown) => String(value ?? '');
const money = (currency: string, cents: number) => `${currency} ${(cents / 100).toFixed(2)}`;
function boundedAscii(value: unknown, name: string, required = false) { if (typeof value !== 'string' || value.length > MAX_STRING || (required && value.length === 0) || /[^\x20-\x7e]/.test(value)) throw Error(`QUOTATION_SNAPSHOT_${name}_INVALID`); return value; }
function cents(value: unknown) { if (!Number.isInteger(value) || Math.abs(value as number) > 9_000_000_000_000) throw Error('QUOTATION_SNAPSHOT_AMOUNT_INVALID'); return value as number; }
function validSnapshot(input: unknown): FrozenQuotationSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('QUOTATION_SNAPSHOT_INVALID');
  const s = input as any; boundedAscii(s.quotationNo, 'QUOTATION_NO', true); boundedAscii(s.customerId, 'CUSTOMER_ID', true); boundedAscii(s.currency, 'CURRENCY', true);
  for (const key of ['quotationDate', 'validUntil', 'customerName', 'warehouseId', 'remark', 'deliveryDate']) if (s[key] !== undefined && s[key] !== null) boundedAscii(s[key], key.toUpperCase());
  if (!Array.isArray(s.lines) || s.lines.length < 1 || s.lines.length > MAX_LINES) throw Error('QUOTATION_SNAPSHOT_LINES_INVALID');
  s.lines.forEach((line: any) => { if (!line || typeof line !== 'object' || !Number.isInteger(line.rowItemNo) || line.rowItemNo < 1 || line.rowItemNo > MAX_LINES) throw Error('QUOTATION_SNAPSHOT_LINE_INVALID'); boundedAscii(line.stockCode, 'STOCK_CODE', true); boundedAscii(line.description, 'DESCRIPTION', true); boundedAscii(line.uom, 'UOM', true); if (line.productId !== undefined) boundedAscii(line.productId, 'PRODUCT_ID', true); if (line.rowItemRemark !== undefined && line.rowItemRemark !== null) boundedAscii(line.rowItemRemark, 'ROW_ITEM_REMARK'); if (!['string', 'number'].includes(typeof line.quantity) || text(line.quantity).length > 64 || /[^\x20-\x7e]/.test(text(line.quantity)) || !text(line.quantity).trim()) throw Error('QUOTATION_SNAPSHOT_QUANTITY_INVALID'); try { normalizeQuantity(line.quantity); } catch { throw Error('QUOTATION_SNAPSHOT_QUANTITY_INVALID'); } cents(line.unitPriceCents); cents(line.subtotalCents); });
  return { ...s, lines: s.lines.map((line: any) => ({ ...line })), subtotalCents: cents(s.subtotalCents), taxCents: cents(s.taxCents), grandTotalCents: cents(s.grandTotalCents) };
}
/** Validates and normalizes only the current frozen snapshot shape. '{}' and missing snapshots are not legacy compatibility cases. */
export function normalizeFrozenQuotationSnapshot(input: unknown): FrozenQuotationSnapshot { return validSnapshot(input); }
const pdfText = (value: string) => value.replace(/[\\()\r\n]/g, c => c === '\\' ? '\\\\' : c === '(' ? '\\(' : c === ')' ? '\\)' : ' ');
// Helvetica's widest permitted ASCII glyph at 9pt is below one em. Using one
// full em for every non-space glyph and 2.25pt for spaces is deliberately
// conservative: 55 such glyphs occupy 495pt, exactly the A4 text width.
const HELVETICA_9_TEXT_WIDTH = 495;
const measuredWidth = (value: string) => [...value].reduce((sum, character) => sum + (character === ' ' ? 2.25 : 9), 0);
const wrap = (value: string) => {
  const result: string[] = [];
  let current = '';
  for (const word of value.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measuredWidth(candidate) <= HELVETICA_9_TEXT_WIDTH) { current = candidate; continue; }
    if (current) result.push(current);
    current = '';
    // A single unbroken token must also be width-safe (SKU/description input
    // is bounded ASCII but may contain repeated W/M or no spaces).
    for (const character of word) {
      if (measuredWidth(current + character) > HELVETICA_9_TEXT_WIDTH && current) { result.push(current); current = ''; }
      current += character;
    }
  }
  if (current || !result.length) result.push(current);
  return result;
};

export function validateQuotationPdfAttachment(attachment: unknown) {
  if (!attachment || typeof attachment !== 'object') throw Error('ATTACHMENT_INVALID');
  const candidate = attachment as any;
  if (candidate.mimeType !== 'application/pdf' || typeof candidate.fileName !== 'string' || candidate.fileName.length < 5 || candidate.fileName.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/.test(candidate.fileName) || typeof candidate.ref !== 'string' || typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.sha256) || !candidate.ref.startsWith(QUOTATION_PDF_DATA_URI_PREFIX)) throw Error('ATTACHMENT_INVALID');
  const encoded = candidate.ref.slice(QUOTATION_PDF_DATA_URI_PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Error('ATTACHMENT_INVALID');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 5 || bytes.length > MAX_QUOTATION_PDF_BYTES || bytes.toString('base64') !== encoded || bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || createHash('sha256').update(bytes).digest('hex') !== candidate.sha256) throw Error('ATTACHMENT_INVALID');
  return candidate;
}

export function validateQuotationPdfEnvelope(message: { attachments?: unknown[] }) {
  if (message.attachments === undefined) return;
  if (!Array.isArray(message.attachments) || message.attachments.length !== 1) throw Error('ATTACHMENT_COUNT_UNSUPPORTED');
  validateQuotationPdfAttachment(message.attachments[0]);
}
/** Dependency-free, byte-stable PDF. Unsupported Unicode fails closed. */
export function renderQuotationPdf(input: FrozenQuotationSnapshot): Buffer {
  const snapshot = validSnapshot(input); const lines: string[] = ['QUOTATION', `Quotation no: ${snapshot.quotationNo}`, `Date: ${text(snapshot.quotationDate) || 'N/A'}    Valid until: ${text(snapshot.validUntil) || 'N/A'}`, `Customer: ${snapshot.customerName ? `${snapshot.customerName} (${snapshot.customerId})` : snapshot.customerId}`, `Requested delivery: ${text(snapshot.deliveryDate) || 'N/A'}`, `Warehouse: ${text(snapshot.warehouseId) || 'N/A'}    Currency: ${snapshot.currency}`, '', 'Items:'];
  for (const line of snapshot.lines) { lines.push(...wrap(`${line.rowItemNo}. ${line.stockCode} - ${line.description}`)); lines.push(...wrap(`   Quantity: ${line.quantity} ${line.uom} | Unit price: ${money(snapshot.currency, line.unitPriceCents)} | Subtotal: ${money(snapshot.currency, line.subtotalCents)}`)); if (line.rowItemRemark) lines.push(...wrap(`   Remark: ${line.rowItemRemark}`)); }
  lines.push('', `Subtotal: ${money(snapshot.currency, snapshot.subtotalCents)}`, `Tax: ${money(snapshot.currency, snapshot.taxCents)}`, `TOTAL: ${money(snapshot.currency, snapshot.grandTotalCents)}`, '', 'Staff owns Sales Order posting, confirmation, and delivery progression.', 'This quotation does not create or confirm a Sales Order.');
  const pages: string[][] = []; for (let i = 0; i < lines.length; i += PAGE_LINES) pages.push(lines.slice(i, i + PAGE_LINES));
  const pageObjects: string[] = [], contentObjects: string[] = []; for (const page of pages) { const stream = ['BT', '/F1 9 Tf', '50 790 Td', ...page.map((line, i) => `${i ? '0 -14 Td ' : ''}(${pdfText(line)}) Tj`), 'ET'].join('\n'); contentObjects.push(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`); }
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '']; const pageStart = 3, fontObject = pageStart + pages.length, contentStart = fontObject + 1; objects[1] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageStart + i} 0 R`).join(' ')}] /Count ${pages.length} >>`; pages.forEach((_, i) => pageObjects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentStart + i} 0 R >>`)); objects.push(...pageObjects, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', ...contentObjects);
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')], offsets = [0]; for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.concat(chunks).length); chunks.push(Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`, 'ascii')); } const xref = Buffer.concat(chunks).length; chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'ascii')); const result = Buffer.concat(chunks); if (result.length > MAX_QUOTATION_PDF_BYTES) throw Error('QUOTATION_PDF_TOO_LARGE'); return result;
}
export function quotationPdfAttachment(snapshot: FrozenQuotationSnapshot) { const bytes = renderQuotationPdf(snapshot); const sha256 = createHash('sha256').update(bytes).digest('hex'); return { mimeType: 'application/pdf', fileName: `${snapshot.quotationNo}.pdf`, ref: `data:application/pdf;base64,${bytes.toString('base64')}`, sha256 }; }
