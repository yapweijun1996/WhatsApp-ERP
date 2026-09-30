import type Database from 'better-sqlite3';
import { DemoErpAdapter, type Evidence, type PublicCatalogItem, type PublicCatalogReadContract } from './erp.js';

/**
 * Bounded PUBLIC_CATALOG_READ tool surface for unverified prospect/unknown senders.
 *
 * Three independent fences make the boundary hold:
 *  1. Reachability — `createPublicCatalogReader` hands back exactly two bound
 *     methods, so nothing customer-scoped is reachable at runtime, not merely
 *     hidden behind a narrower type.
 *  2. Allowlist — only the two names in `PROSPECT_CATALOG_TOOL_NAMES` dispatch.
 *     Every employee capability name is unknown here and fails closed.
 *  3. Projection — each returned row is rebuilt from the safe-field allowlist and
 *     any unexpected output key fails the call rather than being dropped, so a
 *     future widening of the ERP projection cannot silently leak.
 *
 * Read-only by construction: the contract has no mutation method.
 */
export const PUBLIC_CATALOG_SAFE_FIELDS = Object.freeze(['productId', 'stockCode', 'description', 'baseUom'] as const);
export const PROSPECT_CATALOG_TOOL_NAMES = Object.freeze(['search_public_catalog', 'list_public_catalog'] as const);
export type ProspectCatalogToolName = typeof PROSPECT_CATALOG_TOOL_NAMES[number];

export const PROSPECT_CATALOG_MAX_LIMIT = 10;
export const PROSPECT_CATALOG_DEFAULT_LIMIT = 5;
export const PROSPECT_CATALOG_MAX_QUERY_CHARS = 64;
/** Model-facing tool budget for one prospect turn. Exceeding it fails closed. */
export const PROSPECT_CATALOG_MAX_TOOL_CALLS = 2;

export type ProspectCatalogToolCall = Readonly<{ name: ProspectCatalogToolName; query: string | null; limit: number }>;
export type ProspectCatalogResult = Readonly<{
  tool: ProspectCatalogToolName;
  query: string | null;
  limit: number;
  items: readonly PublicCatalogItem[];
}>;

function fail(code: string): never { throw new Error(`PROSPECT_CATALOG_DENIED:${code}`); }
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function isProspectCatalogToolName(name: unknown): name is ProspectCatalogToolName {
  return typeof name === 'string' && (PROSPECT_CATALOG_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Validates a model-proposed tool call against the allowlist and its bounds.
 * `query` is required for search and forbidden for the full listing, so neither
 * shape can be used to smuggle the other's arguments.
 */
export function normalizeProspectCatalogToolCall(candidate: unknown): ProspectCatalogToolCall {
  if (!isPlainObject(candidate)) fail('MALFORMED_TOOL_CALL');
  const name = candidate.tool ?? candidate.name;
  if (!isProspectCatalogToolName(name)) fail('TOOL_NOT_ALLOWLISTED');
  for (const key of Object.keys(candidate)) {
    if (!['tool', 'name', 'query', 'limit'].includes(key)) fail(`UNKNOWN_ARGUMENT_${key}`);
  }
  const rawLimit = candidate.limit;
  let limit = PROSPECT_CATALOG_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== 'number' || !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > PROSPECT_CATALOG_MAX_LIMIT) fail('LIMIT_OUT_OF_BOUNDS');
    limit = rawLimit;
  }
  if (name === 'list_public_catalog') {
    if (candidate.query !== undefined && candidate.query !== null) fail('QUERY_NOT_APPLICABLE');
    return Object.freeze({ name, query: null, limit });
  }
  const rawQuery = candidate.query;
  if (typeof rawQuery !== 'string') fail('QUERY_REQUIRED');
  const query = rawQuery.trim();
  if (query.length === 0) fail('QUERY_REQUIRED');
  if (query.length > PROSPECT_CATALOG_MAX_QUERY_CHARS) fail('QUERY_TOO_LONG');
  return Object.freeze({ name, query, limit });
}

/**
 * Rebuilds one catalog row from the safe-field allowlist. An output key outside
 * the allowlist fails the whole call: a leak must be loud, never trimmed away.
 */
export function projectPublicCatalogItem(evidence: Evidence): PublicCatalogItem {
  const output = evidence.output;
  if (!isPlainObject(output)) fail('MALFORMED_CATALOG_EVIDENCE');
  for (const key of Object.keys(output)) {
    if (!(PUBLIC_CATALOG_SAFE_FIELDS as readonly string[]).includes(key)) fail(`UNSAFE_CATALOG_FIELD_${key}`);
  }
  const item: Record<string, string> = {};
  for (const field of PUBLIC_CATALOG_SAFE_FIELDS) {
    const value = output[field];
    if (typeof value !== 'string' || value.length === 0) fail(`MISSING_CATALOG_FIELD_${field}`);
    item[field] = value;
  }
  return Object.freeze(item as unknown as PublicCatalogItem);
}

/** Executes one allowlisted, bounded, read-only public catalog lookup. */
export async function executeProspectCatalogTool(
  call: ProspectCatalogToolCall,
  reader: PublicCatalogReadContract,
): Promise<ProspectCatalogResult> {
  if (!isProspectCatalogToolName(call.name)) fail('TOOL_NOT_ALLOWLISTED');
  const evidence = call.name === 'search_public_catalog'
    ? await reader.searchPublicCatalog(call.query ?? fail('QUERY_REQUIRED'), call.limit)
    : await reader.listPublicCatalog(call.limit);
  if (!Array.isArray(evidence)) fail('MALFORMED_CATALOG_EVIDENCE');
  const items = evidence.slice(0, call.limit).map(projectPublicCatalogItem);
  return Object.freeze({ tool: call.name, query: call.query, limit: call.limit, items: Object.freeze(items) });
}

/**
 * The prospect-reachable ERP surface: exactly two bound reads over the canonical
 * product source. The underlying adapter is the same one the verified-customer
 * path uses, so there is no second ERP client and no divergent catalog truth.
 */
export function createPublicCatalogReader(db: Database.Database): PublicCatalogReadContract {
  const adapter = new DemoErpAdapter(db);
  return Object.freeze({
    searchPublicCatalog: (query: string, limit: number, toolCallId?: string) => adapter.searchPublicCatalog(query, limit, toolCallId),
    listPublicCatalog: (limit: number, toolCallId?: string) => adapter.listPublicCatalog(limit, toolCallId),
  });
}
