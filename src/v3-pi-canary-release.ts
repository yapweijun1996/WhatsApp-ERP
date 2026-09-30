import type { GroundedResponsePlan } from './v2-grounded-response-plan.js';
import { validateV3FulfillmentGate } from './v3-fulfillment-gate.js';
import { releaseV3Fulfillment } from './v3-fulfillment-release.js';
import type { V3GoalGraphStore, GoalGraphScope } from './v3-goal-graph.js';
import type { V3DurableContinuationStore } from './v3-durable-continuation.js';
import type { OutboundMessageService } from './outbound-message-service.js';

export type V3PiCanaryReleaseOptions = Readonly<{
  enabled: true;
  scope: GoalGraphScope;
  goalGraphStore: V3GoalGraphStore;
  continuationStore?: V3DurableContinuationStore;
  outbound: OutboundMessageService;
  replyToExternalMessageId?: string;
}>;

export async function releaseV3PiCanary(
  v3: V3PiCanaryReleaseOptions,
  plan: GroundedResponsePlan,
  turnId: string,
): Promise<void> {
  validateV3FulfillmentGate({goalGraphStore:v3.goalGraphStore, continuationStore:v3.continuationStore, scope:v3.scope, plan});
  await releaseV3Fulfillment({accountId:v3.scope.accountId, conversationId:v3.scope.conversationId, turnId, plan, scope:v3.scope, goalGraphStore:v3.goalGraphStore, continuationStore:v3.continuationStore, outbound:v3.outbound, ...(v3.replyToExternalMessageId === undefined ? {} : {replyToExternalMessageId:v3.replyToExternalMessageId})});
}
