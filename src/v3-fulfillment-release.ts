import type { GroundedResponsePlan } from './v2-grounded-response-plan.js';
import { OutboundMessageService, type V3DeliveryUnitSendInput } from './outbound-message-service.js';
import { V3DurableContinuationStore } from './v3-durable-continuation.js';
import { validateV3FulfillmentGate } from './v3-fulfillment-gate.js';
import { V3GoalGraphStore, type GoalGraphScope } from './v3-goal-graph.js';

/**
 * Host-owned V3 release seam. It composes the existing fulfillment gate and
 * the sole V2 outbound/effect owner; it does not create a transport owner.
 */
export type V3FulfillmentReleaseInput = Readonly<{
  accountId: string;
  conversationId: string;
  turnId: string;
  plan: GroundedResponsePlan;
  scope: GoalGraphScope;
  goalGraphStore: V3GoalGraphStore;
  continuationStore?: V3DurableContinuationStore;
  outbound: OutboundMessageService;
  replyToExternalMessageId?: string;
}>;

function reject(code: string): never {
  throw new Error(`V3_FUL007_REJECTED:${code}`);
}

/**
 * Reconcile durable uncertainty before any new provider attempt. This is safe
 * on reconnect and deliberately delegates provider reconciliation to V2.
 */
export async function recoverV3Fulfillment(outbound: OutboundMessageService): Promise<void> {
  if (!(outbound instanceof OutboundMessageService)) reject('OUTBOUND_OWNER_REQUIRED');
  await outbound.reconcile();
}

/**
 * Release only a structurally complete plan. Durable reconciliation happens
 * first so UNKNOWN/PENDING effects cannot be blindly resent by this release.
 */
export async function releaseV3Fulfillment(input: V3FulfillmentReleaseInput) {
  if (!input || !(input.outbound instanceof OutboundMessageService)) reject('OUTBOUND_OWNER_REQUIRED');
  if (input.accountId !== input.scope.accountId || input.conversationId !== input.scope.conversationId) reject('SCOPE_MISMATCH');
  if (!Array.isArray(input.plan.deliveryUnits) || input.plan.deliveryUnits.length === 0) reject('EMPTY_DELIVERY');

  validateV3FulfillmentGate({
    goalGraphStore: input.goalGraphStore,
    continuationStore: input.continuationStore,
    scope: input.scope,
    plan: input.plan,
  });
  await recoverV3Fulfillment(input.outbound);

  const delivery: V3DeliveryUnitSendInput = {
    accountId: input.accountId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    plan: input.plan,
    ...(input.replyToExternalMessageId === undefined ? {} : { replyToExternalMessageId: input.replyToExternalMessageId }),
  };
  return input.outbound.sendDeliveryUnits(delivery);
}
