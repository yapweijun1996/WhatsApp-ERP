/** V3-MIG-002: structural eligibility only. This classifier never routes traffic. */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WRITER_STATES = new Set(['V2_PRIMARY', 'V2_CANARY', 'LEGACY_RETIRED']);

export type V3Mig002Evidence = Readonly<{
  scope: Readonly<{ accountId: string; conversationId: string }>;
  shadow: Readonly<{
    configuredMode: 'OFF' | 'SHADOW';
    effectiveMode: 'OFF' | 'SHADOW';
    configuredScope: Readonly<{ accountId: string | null; conversationId: string | null }> | null;
  }>;
  canonicalScope: Readonly<{ accountId: string; conversationId: string; verified: boolean }>;
  writer: Readonly<{
    currentAuthoritativeWriter: 'V2' | 'V3' | 'LEGACY' | string;
    activeWriters: readonly string[];
    proposedCanaryWriter: 'V3' | string;
    handoffContract: 'V2_TO_V3_EXPLICIT_SINGLE_WRITER' | string;
    migrationState: string;
  }>;
  outbound: Readonly<{
    soleOwner: 'OutboundMessageService' | string;
    alternateOwners: readonly string[];
    providerSendPaths: number;
  }>;
  commerce: Readonly<{
    canonicalOwner: 'V2_CANONICAL_COMMERCE' | string;
    aiAuthorityCutoff: string;
    postDraftCapabilitiesPresent: boolean;
  }>;
  derivedState: Readonly<{ nonAuthoritative: boolean; rebuildable: boolean; scopeBound: boolean }>;
  runtime: Readonly<{ v3TrafficActive: boolean; v3RouteActive: boolean; providerTrafficEnabled: boolean }>;
}>;

export type V3Mig002ReasonCode =
  | 'EVIDENCE_REQUIRED' | 'SCOPE_REQUIRED' | 'SCOPE_MISMATCH' | 'SHADOW_REQUIRED'
  | 'CANONICAL_SCOPE_UNPROVEN' | 'WRITER_PROOF_REQUIRED' | 'DUAL_WRITER'
  | 'WRITER_HANDOFF_INVALID' | 'MIGRATION_STATE_INVALID' | 'OUTBOUND_OWNER_REQUIRED'
  | 'ALTERNATE_OUTBOUND_OWNER' | 'PROVIDER_SEND_PATH_INVALID' | 'COMMERCE_OWNER_INVALID'
  | 'AI_AUTHORITY_WIDENED' | 'DERIVED_STATE_INVALID' | 'TRAFFIC_ALREADY_ACTIVE';

export type V3Mig002Verdict = Readonly<{
  contractVersion: 'V3-MIG-002';
  status: 'INELIGIBLE' | 'ELIGIBLE_TO_REQUEST_CANARY';
  scope: Readonly<{ accountId: string; conversationId: string }> | null;
  reasonCodes: readonly V3Mig002ReasonCode[];
  canaryAuthorityGranted: false;
  activatesTraffic: false;
}>;

const verdict = (status: V3Mig002Verdict['status'], scope: V3Mig002Verdict['scope'], reasonCodes: V3Mig002ReasonCode[]): V3Mig002Verdict =>
  Object.freeze({ contractVersion: 'V3-MIG-002' as const, status, scope, reasonCodes: Object.freeze([...reasonCodes]), canaryAuthorityGranted: false as const, activatesTraffic: false as const });

function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }

/**
 * Classifies a reviewed evidence snapshot. It is deliberately a pure policy
 * function: it has no router, provider, database, or mutation dependency.
 */
export function evaluateV3Mig002CanaryEligibility(input: V3Mig002Evidence | null | undefined): V3Mig002Verdict {
  if (!input || typeof input !== 'object') return verdict('INELIGIBLE', null, ['EVIDENCE_REQUIRED']);
  const scope = input.scope;
  if (!scope || !validId(scope.accountId) || !validId(scope.conversationId)) return verdict('INELIGIBLE', null, ['SCOPE_REQUIRED']);
  const reasons: V3Mig002ReasonCode[] = [];
  const exact = (a: unknown, b: unknown) => a === b;
  if (!input.shadow || input.shadow.configuredMode !== 'SHADOW' || input.shadow.effectiveMode !== 'SHADOW') reasons.push('SHADOW_REQUIRED');
  if (!input.shadow?.configuredScope || !exact(input.shadow.configuredScope.accountId, scope.accountId) || !exact(input.shadow.configuredScope.conversationId, scope.conversationId)) reasons.push('SCOPE_MISMATCH');
  if (!input.canonicalScope || input.canonicalScope.verified !== true || input.canonicalScope.accountId !== scope.accountId || input.canonicalScope.conversationId !== scope.conversationId) reasons.push('CANONICAL_SCOPE_UNPROVEN');

  const writer = input.writer;
  if (!writer || !Array.isArray(writer.activeWriters) || writer.currentAuthoritativeWriter !== 'V2' || writer.proposedCanaryWriter !== 'V3') reasons.push('WRITER_PROOF_REQUIRED');
  if (writer && (!Array.isArray(writer.activeWriters) || writer.activeWriters.length !== 1 || writer.activeWriters[0] !== 'V2')) reasons.push('DUAL_WRITER');
  if (!writer || writer.handoffContract !== 'V2_TO_V3_EXPLICIT_SINGLE_WRITER') reasons.push('WRITER_HANDOFF_INVALID');
  if (!writer || !WRITER_STATES.has(writer.migrationState)) reasons.push('MIGRATION_STATE_INVALID');

  const outbound = input.outbound;
  if (!outbound || outbound.soleOwner !== 'OutboundMessageService') reasons.push('OUTBOUND_OWNER_REQUIRED');
  if (outbound && (!Array.isArray(outbound.alternateOwners) || outbound.alternateOwners.length !== 0)) reasons.push('ALTERNATE_OUTBOUND_OWNER');
  if (!outbound || outbound.providerSendPaths !== 1) reasons.push('PROVIDER_SEND_PATH_INVALID');
  const commerce = input.commerce;
  if (!commerce || commerce.canonicalOwner !== 'V2_CANONICAL_COMMERCE') reasons.push('COMMERCE_OWNER_INVALID');
  if (!commerce || commerce.aiAuthorityCutoff !== 'SALES_ORDER.DRAFT' || commerce.postDraftCapabilitiesPresent !== false) reasons.push('AI_AUTHORITY_WIDENED');
  const derived = input.derivedState;
  if (!derived || derived.nonAuthoritative !== true || derived.rebuildable !== true || derived.scopeBound !== true) reasons.push('DERIVED_STATE_INVALID');
  const runtime = input.runtime;
  if (!runtime || runtime.v3TrafficActive || runtime.v3RouteActive || runtime.providerTrafficEnabled) reasons.push('TRAFFIC_ALREADY_ACTIVE');
  return verdict(reasons.length === 0 ? 'ELIGIBLE_TO_REQUEST_CANARY' : 'INELIGIBLE', scope, reasons);
}
