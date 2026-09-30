import type {GroundedResponsePlan} from './v2-grounded-response-plan.js';
import {V3GoalGraphStore, type GoalGraphScope} from './v3-goal-graph.js';
import {V3DurableContinuationStore} from './v3-durable-continuation.js';

/** The only goal states that require a response-plan disposition. */
export const FUL002_ACTIVE_GOAL_STATUSES = [
  'OPEN', 'IN_PROGRESS', 'NEEDS_CLARIFICATION', 'WAITING_EXTERNAL', 'BLOCKED_BY_AUTHORITY',
] as const;

export type Ful002GateInput = Readonly<{
  goalGraphStore: V3GoalGraphStore;
  continuationStore?: V3DurableContinuationStore;
  scope: GoalGraphScope;
  plan: GroundedResponsePlan;
}>;

function reject(code: string, detail?: string): never {
  throw new Error(`V3_FUL002_REJECTED:${code}${detail === undefined ? '' : `:${detail}`}`);
}

/**
 * Host-owned admission gate for a FUL-001 response plan.
 *
 * This gate proves only structural admission. Evidence references are required
 * for completion claims but are not semantically verified here; their owners
 * remain responsible for proving them.
 */
export function validateV3FulfillmentGate(input: Ful002GateInput): GroundedResponsePlan {
  if (!input || typeof input !== 'object' || !(input.goalGraphStore instanceof V3GoalGraphStore)) {
    reject('INPUT_INVALID');
  }
  const graph = input.goalGraphStore.readGoalGraph(input.scope);
  if (graph.scope.accountId !== input.scope.accountId || graph.scope.conversationId !== input.scope.conversationId) {
    reject('GRAPH_SCOPE_MISMATCH');
  }

  const active = new Set(graph.goals
    .filter(goal => FUL002_ACTIVE_GOAL_STATUSES.includes(goal.status as typeof FUL002_ACTIVE_GOAL_STATUSES[number]))
    .map(goal => goal.goalId));
  const known = new Map(graph.goals.map(goal => [goal.goalId, goal]));
  const dispositions = input.plan.goalDispositions ?? [];
  const seen = new Set<string>();

  for (const disposition of dispositions) {
    if (seen.has(disposition.goalId)) reject('DUPLICATE_GOAL_DISPOSITION');
    seen.add(disposition.goalId);
    const goal = known.get(disposition.goalId);
    if (!goal) reject('EXTRA_GOAL_DISPOSITION', disposition.goalId);
    if (!active.has(disposition.goalId)) reject('TERMINAL_GOAL_DISPOSITION', disposition.goalId);
    if (disposition.disposition === 'FULFILLED') {
      if (disposition.capabilityEvidenceRefs.length === 0) reject('MISSING_CAPABILITY_EVIDENCE', disposition.goalId);
      if (disposition.groundingRefs.length === 0) reject('MISSING_GROUNDING_EVIDENCE', disposition.goalId);
    }
    if (disposition.disposition === 'WAITING_EXTERNAL' || disposition.disposition === 'STILL_IN_PROGRESS') {
      if (!(input.continuationStore instanceof V3DurableContinuationStore)) reject('CONTINUATION_STORE_REQUIRED', disposition.goalId);
      if (typeof disposition.continuationRef !== 'string') reject('CONTINUATION_INVALID', disposition.goalId);
      try {
        input.continuationStore.validateFulfillmentReference({accountId: input.scope.accountId, conversationId: input.scope.conversationId, goalId: disposition.goalId, continuationId: disposition.continuationRef, disposition: disposition.disposition});
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'INVALID';
        reject('CONTINUATION_INVALID', `${disposition.goalId}:${detail}`);
      }
    }
  }
  for (const goalId of active) {
    if (!seen.has(goalId)) reject('MISSING_GOAL_DISPOSITION', goalId);
  }
  return input.plan;
}
