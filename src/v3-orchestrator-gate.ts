import { authorizeCapability, type AuthorizedCapabilityEnvelope, type HostAuthorizationContext } from './v2-capability-authorization.js';
import { getCapability, listCapabilities } from './v2-capability-registry.js';
import { runV3RetrievalLoop, type V3RetrievalLoopOptions, type V3RetrievalLoopOutcome } from './v3-retrieval-loop.js';

export const V3_ORCHESTRATOR_AI_AUTHORITY_CUTOFF = 'SALES_ORDER.DRAFT' as const;

export type V3OrchestratorCapabilityAttempt = Readonly<{
  name: string;
  arguments: unknown;
  host: HostAuthorizationContext;
}>;

export type V3OrchestratorGateDiagnostic = Readonly<{
  code: string;
  capability: string | null;
}>;

export type V3OrchestratorGateResult = Readonly<{
  retrieval: V3RetrievalLoopOutcome;
  authorizedCapabilities: readonly AuthorizedCapabilityEnvelope[];
  diagnostics: readonly V3OrchestratorGateDiagnostic[];
  aiAuthorityCutoff: typeof V3_ORCHESTRATOR_AI_AUTHORITY_CUTOFF;
  blocked: boolean;
}>;

function diagnosticCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'UNKNOWN_FAILURE';
  const code = message.split(':').at(-1) ?? 'UNKNOWN_FAILURE';
  return /^[A-Za-z0-9_]+$/.test(code) && code.length <= 128 ? code : 'BOUNDARY_REJECTED';
}

function assertAuthorityCatalog(): void {
  const forbidden = /^(post_sales_order|confirm_sales_order|create_delivery_order|sales_order_post|sales_order_confirm|delivery_order_create|delivery_order_ready)$/i;
  for (const definition of listCapabilities()) {
    if (!getCapability(definition.name) || forbidden.test(definition.name)) {
      throw new Error('V3_ORCH006_AUTHORITY_CATALOG');
    }
  }
}

/**
 * Focused Host gate for the existing V2 runtime boundaries. It does not run a
 * model loop or execute effects: retrieval and capability authorization remain
 * owned by their existing Host services.
 */
export function runV3OrchestratorGate(input: Readonly<{
  retrieval: V3RetrievalLoopOptions;
  capabilityAttempts?: readonly V3OrchestratorCapabilityAttempt[];
}>): V3OrchestratorGateResult {
  assertAuthorityCatalog();
  const diagnostics: V3OrchestratorGateDiagnostic[] = [];
  const authorizedCapabilities: AuthorizedCapabilityEnvelope[] = [];
  const retrieval = runV3RetrievalLoop(input.retrieval);
  for (const attempt of input.capabilityAttempts ?? []) {
    try {
      const envelope = authorizeCapability({ name: attempt.name, arguments: attempt.arguments }, attempt.host);
      authorizedCapabilities.push(envelope);
    } catch (error) {
      diagnostics.push(Object.freeze({ code: diagnosticCode(error), capability: typeof attempt.name === 'string' ? attempt.name : null }));
    }
  }
  if (retrieval.outcome === 'ABSTAIN') diagnostics.push(Object.freeze({ code: retrieval.stopReason, capability: null }));
  return Object.freeze({
    retrieval,
    authorizedCapabilities: Object.freeze(authorizedCapabilities),
    diagnostics: Object.freeze(diagnostics),
    aiAuthorityCutoff: V3_ORCHESTRATOR_AI_AUTHORITY_CUTOFF,
    blocked: diagnostics.length > 0,
  });
}
