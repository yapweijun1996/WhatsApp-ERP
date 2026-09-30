import { PROSPECT_ONBOARDING_REPLY } from './v2-inbound-abuse-guard.js';
import type { PublicCatalogReadContract } from './erp.js';
import {
  executeProspectCatalogTool,
  PROSPECT_CATALOG_MAX_TOOL_CALLS,
  type ProspectCatalogResult,
} from './v2-prospect-public-catalog.js';
import {
  assertProspectConnectiveTextSafe,
  buildCatalogEvidencePrompt,
  collectCatalogEvidence,
  composeGroundedProspectReply,
  parseProspectModelOutput,
  type ProspectModelTurn,
} from './v2-prospect-catalog-grounding.js';

/**
 * Bounded AI routing seam for NORMAL prospects.
 *
 * The caller supplies a function that makes a single AI exchange with no ERP
 * tools available. This class enforces the bounded contract: fail-closed on
 * any error, text-only reply, no chain-of-thought storage.
 *
 * Customer-scoped capability isolation is structural: the ProspectModelCaller
 * type is a plain text-in / text-out function. It cannot call ERP tools by
 * construction — the interface exposes no executor, no capability registry, and
 * no customer scope.
 *
 * The one ERP surface a prospect may reach is the optional PUBLIC_CATALOG_READ
 * reader held by *this* class, never by the model function. When the model asks
 * for a catalog lookup, the host performs the allowlisted bounded read and hands
 * back only safe projected fields, then requires the final answer to be grounded
 * in what was actually returned.
 */
export type ProspectModelCaller = (messageText: string, signal?: AbortSignal) => Promise<string>;

export type ProspectClassification = 'AI_ROUTED' | 'FALLBACK';

/**
 * Closed set of fallback reason codes. Nothing outside this list can ever be
 * produced, so no gateway message, token, URL, or origin string can leak into
 * the audit trail through this seam.
 */
export type ProspectFallbackReason =
  | 'MODEL_UNAVAILABLE'
  | 'GATEWAY_ORIGIN_UNREGISTERED'
  | 'GATEWAY_SESSION_UNAUTHORIZED'
  | 'GATEWAY_QUOTA_EXCEEDED'
  | 'GATEWAY_DISABLED'
  | 'GATEWAY_UNAVAILABLE'
  | 'EMPTY_REPLY'
  | 'MODEL_ERROR'
  /** No public catalog reader available, or the bounded read itself failed. */
  | 'CATALOG_UNAVAILABLE'
  /** Model asked for more catalog lookups than one prospect turn permits. */
  | 'CATALOG_TOOL_BUDGET'
  /** Proposed tool call was outside the allowlist or its argument bounds. */
  | 'CATALOG_TOOL_REJECTED'
  /** Final answer was not grounded in the catalog evidence actually returned. */
  | 'CATALOG_GROUNDING_REJECTED';

/**
 * Exact-match table from the Demo Gateway's own bounded error codes to audit
 * reason codes. Exact match only — an unrecognized error collapses to the
 * generic `MODEL_ERROR` rather than echoing its text.
 */
const GATEWAY_REASONS: ReadonlyMap<string, ProspectFallbackReason> = new Map([
  ['DEMO_GPT_ORIGIN_UNREGISTERED', 'GATEWAY_ORIGIN_UNREGISTERED' as const],
  ['DEMO_GPT_SESSION_UNAUTHORIZED', 'GATEWAY_SESSION_UNAUTHORIZED' as const],
  ['DEMO_GPT_QUOTA_EXCEEDED', 'GATEWAY_QUOTA_EXCEEDED' as const],
  ['DEMO_GPT_DISABLED', 'GATEWAY_DISABLED' as const],
  ['DEMO_GPT_NETWORK_ERROR', 'GATEWAY_UNAVAILABLE' as const],
  ['DEMO_GPT_SESSION_NETWORK_ERROR', 'GATEWAY_UNAVAILABLE' as const],
  ['DEMO_GPT_ABORTED', 'GATEWAY_UNAVAILABLE' as const],
]);

/** Maps a thrown model error to a closed-set reason code. Never echoes error text. */
export function prospectFallbackReasonFor(error: unknown): ProspectFallbackReason {
  const message = error instanceof Error ? error.message : '';
  return GATEWAY_REASONS.get(message) ?? 'MODEL_ERROR';
}

export interface ProspectRoutingResult {
  readonly classification: ProspectClassification;
  readonly reply: string;
  readonly routedByAI: boolean;
  /** Present only when `classification === 'FALLBACK'`. Always from the closed set. */
  readonly fallbackReason?: ProspectFallbackReason;
  /** Bounded catalog reads performed this turn, in retrieval order. Never chain-of-thought. */
  readonly catalogCalls: readonly ProspectCatalogResult[];
  /** True when the customer-visible reply was composed from catalog evidence. */
  readonly grounded: boolean;
  /** Product ids whose host-rendered lines were sent. Always a subset of the evidence. */
  readonly groundedProductIds: readonly string[];
}

/** Maps a protocol/tool/grounding rejection to its closed-set audit reason. */
function protocolFallbackReasonFor(error: unknown): ProspectFallbackReason {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('PROSPECT_CATALOG_DENIED:')) return 'CATALOG_TOOL_REJECTED';
  if (message.startsWith('PROSPECT_GROUNDING_REJECTED:')) return 'CATALOG_GROUNDING_REJECTED';
  return prospectFallbackReasonFor(error);
}

export class ProspectSemanticRouter {
  constructor(
    private readonly model: ProspectModelCaller | undefined,
    private readonly catalog?: PublicCatalogReadContract,
  ) {}

  async route(messageText: string, signal?: AbortSignal): Promise<ProspectRoutingResult> {
    if (!this.model) return this.fallback('MODEL_UNAVAILABLE');
    const customerText = messageText?.slice(0, 2000) ?? '';
    const calls: ProspectCatalogResult[] = [];
    let prompt = customerText;
    try {
      // One final answer plus at most PROSPECT_CATALOG_MAX_TOOL_CALLS lookups.
      for (let exchange = 0; exchange <= PROSPECT_CATALOG_MAX_TOOL_CALLS; exchange++) {
        const raw = await this.model(prompt, signal);
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (text.length === 0) return this.fallback('EMPTY_REPLY', calls);

        let turn: ProspectModelTurn;
        try { turn = parseProspectModelOutput(text); }
        catch (error) { return this.fallback(protocolFallbackReasonFor(error), calls); }

        if (turn.kind === 'TOOL_CALL') {
          if (!this.catalog) return this.fallback('CATALOG_UNAVAILABLE', calls);
          if (calls.length >= PROSPECT_CATALOG_MAX_TOOL_CALLS) return this.fallback('CATALOG_TOOL_BUDGET', calls);
          let result: ProspectCatalogResult;
          try { result = await executeProspectCatalogTool(turn.call, this.catalog); }
          catch (error) {
            // An allowlist/projection rejection is a contract breach; anything
            // else (a failed read) is reported as the surface being unavailable.
            const denied = error instanceof Error && error.message.startsWith('PROSPECT_CATALOG_DENIED:');
            return this.fallback(denied ? 'CATALOG_TOOL_REJECTED' : 'CATALOG_UNAVAILABLE', calls);
          }
          calls.push(result);
          prompt = buildCatalogEvidencePrompt(customerText, calls);
          continue;
        }

        // A turn that retrieved catalog evidence must answer from it. Plain prose
        // at this point is exactly the ungrounded answer this seam exists to stop.
        if (calls.length > 0) {
          if (turn.kind !== 'FINAL') return this.fallback('CATALOG_GROUNDING_REJECTED', calls);
          try {
            const composed = composeGroundedProspectReply(turn, collectCatalogEvidence(calls));
            return {
              classification: 'AI_ROUTED', reply: composed.reply.slice(0, 4000), routedByAI: true,
              catalogCalls: calls, grounded: true, groundedProductIds: composed.productIds,
            };
          } catch (error) { return this.fallback(protocolFallbackReasonFor(error), calls); }
        }

        // No catalog lookup happened, so no product may be claimed at all.
        if (turn.kind === 'FINAL' && turn.productIds.length > 0) return this.fallback('CATALOG_GROUNDING_REJECTED', calls);
        const reply = turn.kind === 'FINAL' ? turn.connectiveText : turn.text;
        try { assertProspectConnectiveTextSafe(reply, { catalogAnswer: false }); }
        catch (error) { return this.fallback(protocolFallbackReasonFor(error), calls); }
        return {
          classification: 'AI_ROUTED', reply: reply.slice(0, 4000), routedByAI: true,
          catalogCalls: calls, grounded: false, groundedProductIds: [],
        };
      }
      return this.fallback('CATALOG_TOOL_BUDGET', calls);
    } catch (error) {
      return this.fallback(prospectFallbackReasonFor(error), calls);
    }
  }

  private fallback(fallbackReason: ProspectFallbackReason, calls: readonly ProspectCatalogResult[] = []): ProspectRoutingResult {
    return {
      classification: 'FALLBACK', reply: PROSPECT_ONBOARDING_REPLY, routedByAI: false, fallbackReason,
      catalogCalls: calls, grounded: false, groundedProductIds: [],
    };
  }
}
