import type { PublicCatalogItem } from './erp.js';
import {
  normalizeProspectCatalogToolCall,
  PROSPECT_CATALOG_MAX_LIMIT,
  type ProspectCatalogResult,
  type ProspectCatalogToolCall,
} from './v2-prospect-public-catalog.js';

/**
 * Text protocol and grounding fence for prospect catalog answers.
 *
 * The Demo Gateway has no provider-native tool API, so the model expresses a
 * tool call or a final answer as one JSON object in its own output. Parsing the
 * model's output is protocol handling, not business-intent routing: nothing here
 * inspects the customer's message, so catalog use stays the model's semantic
 * decision.
 *
 * The customer never sees model-authored product facts. The model may write
 * connective language and may *select* product ids, but every product line the
 * customer receives is rendered by the host from retrieved catalog evidence.
 */
export const PROSPECT_CONNECTIVE_MAX_CHARS = 400;
export const PROSPECT_CATALOG_EVIDENCE_OPEN = '[PUBLIC_CATALOG_EVIDENCE]';
export const PROSPECT_CATALOG_EVIDENCE_CLOSE = '[END_PUBLIC_CATALOG_EVIDENCE]';

/** Code-shaped tokens (e.g. FCH-WING-2KG) belong to host-rendered lines only. */
const CODE_SHAPED_TOKEN = /(?:^|[^A-Za-z0-9])[A-Z][A-Z0-9]*-[A-Z0-9][A-Z0-9-]*(?=$|[^A-Za-z0-9])/;
const DIGIT = /\d/;
const CURRENCY = /[$€£¥]|\b(?:SGD|MYR|USD|RM|IDR|THB)\b/i;

export type ProspectModelTurn =
  | Readonly<{ kind: 'TOOL_CALL'; call: ProspectCatalogToolCall }>
  | Readonly<{ kind: 'FINAL'; connectiveText: string; productIds: readonly string[] }>
  | Readonly<{ kind: 'TEXT'; text: string }>;

function fail(code: string): never { throw new Error(`PROSPECT_GROUNDING_REJECTED:${code}`); }

/** Strips an optional fenced code block so a fenced JSON envelope still parses. */
function unfence(raw: string): string {
  const text = raw.trim();
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Interprets one model output. An output that is not a JSON envelope is treated
 * as plain final text, which keeps the pre-existing text-only prospect reply
 * path working unchanged.
 */
export function parseProspectModelOutput(raw: string): ProspectModelTurn {
  const text = unfence(raw);
  if (!text.startsWith('{')) return Object.freeze({ kind: 'TEXT' as const, text });
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return Object.freeze({ kind: 'TEXT' as const, text }); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.freeze({ kind: 'TEXT' as const, text });
  const envelope = parsed as Record<string, unknown>;
  if ('tool' in envelope) return Object.freeze({ kind: 'TOOL_CALL' as const, call: normalizeProspectCatalogToolCall(envelope) });
  if ('reply' in envelope) {
    const reply = envelope.reply;
    if (typeof reply !== 'string') fail('REPLY_TYPE');
    const rawIds = envelope.productIds ?? [];
    if (!Array.isArray(rawIds)) fail('PRODUCT_IDS_TYPE');
    const productIds: string[] = [];
    for (const id of rawIds) {
      if (typeof id !== 'string' || id.trim().length === 0) fail('PRODUCT_ID_TYPE');
      if (!productIds.includes(id)) productIds.push(id);
    }
    return Object.freeze({ kind: 'FINAL' as const, connectiveText: reply.trim(), productIds: Object.freeze(productIds) });
  }
  return Object.freeze({ kind: 'TEXT' as const, text });
}

/**
 * Connective text may carry no commercial fact of its own. Codes, digits, and
 * currency are rejected for a catalog answer because those facts exist only in
 * host-rendered evidence lines. Code-shaped tokens and currency are rejected on
 * every AI prospect reply: a prospect turn can reach no price surface at all, so
 * any money amount it names would be guessed, and an unretrieved SKU can never
 * be asserted.
 */
export function assertProspectConnectiveTextSafe(text: string, options: { readonly catalogAnswer: boolean }): void {
  if (text.trim().length === 0) fail('EMPTY_CONNECTIVE_TEXT');
  if (CODE_SHAPED_TOKEN.test(text)) fail('UNGROUNDED_CODE_IN_CONNECTIVE_TEXT');
  if (CURRENCY.test(text)) fail('PROTECTED_FACT_IN_CONNECTIVE_TEXT');
  // Length and bare digits are bounded only for a catalog answer. A general
  // prospect reply may legitimately carry a contact number or opening hours.
  if (!options.catalogAnswer) return;
  if (text.length > PROSPECT_CONNECTIVE_MAX_CHARS) fail('CONNECTIVE_TEXT_TOO_LONG');
  if (DIGIT.test(text)) fail('PROTECTED_FACT_IN_CONNECTIVE_TEXT');
}

/** Distinct evidence items across the turn's catalog calls, in retrieval order. */
export function collectCatalogEvidence(results: readonly ProspectCatalogResult[]): readonly PublicCatalogItem[] {
  const byId = new Map<string, PublicCatalogItem>();
  for (const result of results) for (const item of result.items) if (!byId.has(item.productId)) byId.set(item.productId, item);
  return Object.freeze([...byId.values()]);
}

/** One host-rendered catalog line. Every field comes from retrieved evidence. */
export function renderCatalogLine(item: PublicCatalogItem): string {
  return `- ${item.stockCode} — ${item.description} (${item.baseUom})`;
}

export type GroundedProspectReply = Readonly<{ reply: string; grounded: boolean; productIds: readonly string[] }>;

/**
 * Composes the customer-visible reply for a turn that used the catalog.
 *
 * Fails closed when the model selects a product it did not retrieve, or claims
 * nothing while evidence was available — the two ways an invented answer would
 * otherwise reach the customer. An empty evidence set requires an empty
 * selection, so "we have nothing matching that" stays an honest answer.
 */
export function composeGroundedProspectReply(
  turn: Extract<ProspectModelTurn, { kind: 'FINAL' }>,
  evidence: readonly PublicCatalogItem[],
): GroundedProspectReply {
  assertProspectConnectiveTextSafe(turn.connectiveText, { catalogAnswer: true });
  const byId = new Map(evidence.map(item => [item.productId, item] as const));
  for (const id of turn.productIds) if (!byId.has(id)) fail('UNSUPPORTED_PRODUCT_ID');
  if (evidence.length === 0) {
    if (turn.productIds.length > 0) fail('PRODUCT_WITHOUT_EVIDENCE');
    return Object.freeze({ reply: turn.connectiveText, grounded: true, productIds: Object.freeze([]) });
  }
  if (turn.productIds.length === 0) fail('UNGROUNDED_CATALOG_ANSWER');
  const selected = turn.productIds.slice(0, PROSPECT_CATALOG_MAX_LIMIT);
  const lines = selected.map(id => renderCatalogLine(byId.get(id)!));
  return Object.freeze({
    reply: `${turn.connectiveText}\n\n${lines.join('\n')}`,
    grounded: true,
    productIds: Object.freeze(selected),
  });
}

/**
 * Evidence block appended to the customer's message for the model's next turn.
 * Built from projected safe fields only, so no customer-private value can enter
 * prospect model context.
 */
export function buildCatalogEvidencePrompt(messageText: string, results: readonly ProspectCatalogResult[]): string {
  const blocks = results.map(result => JSON.stringify({
    tool: result.tool,
    query: result.query,
    limit: result.limit,
    resultCount: result.items.length,
    items: result.items,
  }));
  return [
    messageText,
    '',
    PROSPECT_CATALOG_EVIDENCE_OPEN,
    ...blocks,
    PROSPECT_CATALOG_EVIDENCE_CLOSE,
    'Answer the customer now. Use only the items above. Reply with the final JSON object',
    'containing "reply" and "productIds". If no item matches, say so plainly with an empty',
    'productIds list and never name a product that is absent above.',
  ].join('\n');
}
