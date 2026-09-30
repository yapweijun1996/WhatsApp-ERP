/**
 * Host-owned EVAL-005 ingress bridge.
 *
 * This is intentionally only a router seam. It does not implement an agent,
 * provider send, or commerce operation. The supplied V3 runner must compose
 * the existing V3 ORCH/FUL path and retain OutboundMessageService ownership.
 */
import type { IncomingChannelMessage } from './channel-contract.js';
import type { V2CanaryIngressRouter, CanonicalTurnRunner } from './v2-canary-ingress-router.js';
import type { CanonicalIngress } from './v2-conversation-ingress-persistence.js';
import { V3Mig003Control, type V3Mig003CanonicalEvidence, type V3Mig003Scope, type V3Mig003State } from './v3-mig-003-control.js';
import type { V3Mig002Evidence } from './v3-mig-002-policy.js';
import type { MigrationApproval } from './migration-auth.js';
import { V3TraceRecorder, type V3TraceEvent } from './v3-observability.js';
import type { AgentTurnStart } from './v2-agent-turn-coordinator.js';
import type { CapabilityExecutor } from './v2-pi-runtime.js';
import type { V2PiHarness } from './v2-pi-harness.js';
import type { V3ObservationInput } from './v3-orchestrator-observation.js';
import type { V3OrchestratorRetrievalSessionOptions } from './v3-orchestrator-retrieval-bridge.js';
import type { V3OrchestratorGoalReverifySession } from './v3-orchestrator-goal-reverify.js';
import type { V3GoalGraphStore, GoalGraphScope } from './v3-goal-graph.js';
import type { V3DurableContinuationStore } from './v3-durable-continuation.js';
import type { OutboundMessageService } from './outbound-message-service.js';

export type V3LiveCanaryRunner = (input: IncomingChannelMessage) => Promise<unknown>;
export type V3CanaryHostContext = Readonly<{
  observation: V3ObservationInput;
  retrieval?: V3OrchestratorRetrievalSessionOptions;
  goalReverify?: V3OrchestratorGoalReverifySession;
  fulfillment: Readonly<{scope: GoalGraphScope; goalGraphStore: V3GoalGraphStore; continuationStore?: V3DurableContinuationStore; outbound: OutboundMessageService; replyToExternalMessageId?: string}>;
}>;
/** Composes V3 host-built context onto the existing V2PiHarness/Pi loop. */
export type V3CanaryRuntimeComposition = Readonly<{
  pi: Pick<V2PiHarness, 'runV3'>;
  build: (input: {start: AgentTurnStart}) => V3CanaryHostContext;
}>;

export function createV3CanaryRuntimeRunner(composition: V3CanaryRuntimeComposition): CanonicalTurnRunner {
  return async ({start, execute}) => {
    const context = composition.build({start});
    const scope = {accountId:start.accountId, conversationId:start.conversationId};
    if (context.observation.scope.accountId !== scope.accountId || context.observation.scope.conversationId !== scope.conversationId) throw Error('V3_RUNTIME_SOURCE_SCOPE_REQUIRED');
    if (context.fulfillment.scope.accountId !== scope.accountId || context.fulfillment.scope.conversationId !== scope.conversationId) throw Error('V3_RUNTIME_FULFILLMENT_SCOPE_REQUIRED');
    return composition.pi.runV3(start, execute, {
      v3Observation:{enabled:true, get:() => { const {scope: _scope, ...rest} = context.observation; return rest; }},
      ...(context.retrieval ? {v3Retrieval:{...context.retrieval, enabled:true}} : {}),
      ...(context.goalReverify ? {v3GoalReverify:{enabled:true, session:context.goalReverify}} : {}),
      v3Canary:{enabled:true, ...context.fulfillment},
    });
  };
}
export type V3LiveCanaryBridgeOptions = Readonly<{
  v2: Pick<V2CanaryIngressRouter, 'canonicalize' | 'receiveCanonical'> & Partial<Pick<V2CanaryIngressRouter, 'receiveCanonicalWithRunner'>>;
  runner?: V3LiveCanaryRunner;
  /** Host-only runtime continuation. It is invoked by the V2 queue drain. */
  runtimeRunner?: CanonicalTurnRunner;
}>;

const scopeOf = (input: IncomingChannelMessage): V3Mig003Scope => ({ accountId: input.accountId, conversationId: input.conversationId });

/**
 * MIG-003 remains the only activation authority. Until a real V3 runtime is
 * supplied, an activated scope fails closed rather than falling back to V2 or
 * pretending that the provider-backed canary ran.
 */
export class V3LiveCanaryBridge {
  readonly traces = new V3TraceRecorder();

  constructor(private readonly control: V3Mig003Control, private readonly options: V3LiveCanaryBridgeOptions) {}

  state(scope: V3Mig003Scope): V3Mig003State { return this.control.state(scope); }

  activate(input: { evidence: V3Mig002Evidence; approval: MigrationApproval }): V3Mig003State {
    return this.control.activate(input);
  }

  rollback(input: { evidence: V3Mig002Evidence; approval: MigrationApproval; canonicalEvidence: V3Mig003CanonicalEvidence; derivedState: { ignoreAndRebuild(scope: V3Mig003Scope): void } }) {
    return this.control.rollback(input);
  }

  async receive(input: IncomingChannelMessage): Promise<unknown> {
    const canonical = this.options.v2.canonicalize(input);
    if (!canonical) throw Error('V2_CANONICAL_INGRESS_REQUIRED');
    // Unresolved identity (UNKNOWN/PROSPECT): bypass V3 scope gating, let V2 handle the
    // prospect path (abuse guard + onboarding reply). V3 workspace routing is only for
    // VERIFIED_CUSTOMER contacts that carry a non-null customerId.
    if (!canonical.customerId) return this.options.v2.receiveCanonical(canonical);
    return this.receiveCanonical(canonical);
  }

  private async receiveCanonical(canonical: CanonicalIngress): Promise<unknown> {
    const { message } = canonical;
    const scope = scopeOf(message);
    const route = this.control.route(scope);
    this.record('admission', { status: route === 'V3_CANARY' ? 'V3_CANARY_SELECTED' : 'V2_SELECTED' }, scope);
    if (route !== 'V3_CANARY') return this.options.v2.receiveCanonical(canonical);
    if (!this.options.runtimeRunner && !this.options.runner) {
      this.record('admission', { status: 'FAIL_CLOSED', reasonCode: 'V3_RUNTIME_COMPOSITION_REQUIRED' }, scope);
      throw Error('V3_RUNTIME_COMPOSITION_REQUIRED');
    }
    let result: unknown;
    if (this.options.runtimeRunner && this.options.v2.receiveCanonicalWithRunner) {
      result = await this.options.v2.receiveCanonicalWithRunner(canonical, this.options.runtimeRunner);
    } else if (this.options.runner) {
      result = await this.options.runner(message);
    } else {
      this.record('admission', { status: 'FAIL_CLOSED', reasonCode: 'V3_RUNTIME_COMPOSITION_REQUIRED' }, scope);
      throw Error('V3_RUNTIME_COMPOSITION_REQUIRED');
    }
    this.record('effects', { effectKind: 'V3_CANARY_RESULT', status: 'OBSERVED', authorityCutoff: 'SALES_ORDER.DRAFT' }, scope);
    return result;
  }

  snapshot(): readonly V3TraceEvent[] { return this.traces.snapshot(); }

  private record(kind: 'admission' | 'effects', data: Record<string, unknown>, scope: V3Mig003Scope): void {
    this.traces.record({ sequence: this.traces.snapshot().length + 1, kind, scope, at: new Date().toISOString(), data });
  }
}
