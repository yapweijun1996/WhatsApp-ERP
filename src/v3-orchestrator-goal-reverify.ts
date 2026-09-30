/** V3-ORCH-003: bounded Host-owned goal/freshness reverify seam. */
import type { V1Database } from './database.js';
import { projectV3InvalidationEvent, type V3InvalidationProjection } from './v3-invalidation.js';
import { V3GoalProposalHost, type V3GoalProposalHostEnvelope } from './v3-goal-proposal.js';
import type { GoalGraph, GoalGraphScope } from './v3-goal-graph.js';
import type { V3FreshnessDependencyVector } from './v3-freshness-vector.js';

export type V3GoalReverifyTrigger = 'RETRIEVAL_RESULT' | 'CAPABILITY_RESULT' | 'FRESHNESS_INVALIDATION';
export type V3GoalReverifyState = Readonly<{goalGraph: GoalGraph; freshnessVector: V3FreshnessDependencyVector}>;
export type V3GoalReverifyRefresh = () => V3GoalReverifyState;
export type V3GoalReverifyResult = Readonly<{
  trigger: V3GoalReverifyTrigger;
  state: V3GoalReverifyState;
  changed: boolean;
  replanRequired: boolean;
  invalidation: V3InvalidationProjection;
}>;

const freeze = <T>(value: T): T => Object.freeze(value);

/**
 * This session owns only projection/reverification. Semantic goal content is
 * admitted through V3GoalProposalHost; it is never inferred here.
 */
export class V3OrchestratorGoalReverifySession {
  readonly #proposalHost: V3GoalProposalHost;
  #state: V3GoalReverifyState;

  constructor(private readonly database: V1Database, private readonly options: Readonly<{
    scope: GoalGraphScope;
    initial: V3GoalReverifyState;
    refresh: V3GoalReverifyRefresh;
  }>) {
    if (options.initial.goalGraph.scope.accountId !== options.scope.accountId || options.initial.goalGraph.scope.conversationId !== options.scope.conversationId) throw new Error('V3_ORCH_003_SCOPE');
    if (options.initial.freshnessVector.dependencies.identityScope.accountId !== options.scope.accountId || options.initial.freshnessVector.dependencies.identityScope.conversationId !== options.scope.conversationId) throw new Error('V3_ORCH_003_SCOPE');
    this.#proposalHost = new V3GoalProposalHost(database);
    this.#state = options.initial;
  }

  snapshot(): V3GoalReverifyState { return this.#state; }

  admitProposal(proposal: unknown, envelope: V3GoalProposalHostEnvelope) {
    // Expected revision/status comes from the Agent proposal. The Host graph
    // store performs the serialized compare-and-append and fails closed stale.
    return this.#proposalHost.admit(proposal, envelope);
  }
  admit(proposal: unknown, envelope: V3GoalProposalHostEnvelope) { return this.admitProposal(proposal, envelope); }

  reverify(trigger: V3GoalReverifyTrigger, occurredAt = new Date().toISOString()): V3GoalReverifyResult {
    const next = this.options.refresh();
    if (next.goalGraph.scope.accountId !== this.options.scope.accountId || next.goalGraph.scope.conversationId !== this.options.scope.conversationId) throw new Error('V3_ORCH_003_SCOPE');
    const invalidation = projectV3InvalidationEvent(this.#state.freshnessVector, next.freshnessVector, this.options.scope.accountId, this.options.scope.conversationId, occurredAt);
    const changed = invalidation.stale || JSON.stringify(this.#state.goalGraph) !== JSON.stringify(next.goalGraph);
    this.#state = next;
    return freeze({trigger, state: next, changed, replanRequired: changed, invalidation});
  }

  afterRetrievalResult(occurredAt?: string) { return this.reverify('RETRIEVAL_RESULT', occurredAt); }
  afterCapabilityResult(occurredAt?: string) { return this.reverify('CAPABILITY_RESULT', occurredAt); }
  afterFreshnessInvalidation(occurredAt?: string) { return this.reverify('FRESHNESS_INVALIDATION', occurredAt); }
}
