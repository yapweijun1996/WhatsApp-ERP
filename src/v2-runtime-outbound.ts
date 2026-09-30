import type { V1Database } from './database.js';
import { ResponseGroundingGuard, type FreshGroundingAuthorization } from './v2-response-grounding.js';

export type RuntimeOutboundOwner = {
  sendTurnResponse(input: { authorization: FreshGroundingAuthorization }): Promise<unknown>;
  /** Optional transport UX. Absent on owners/stubs that do not support presence. */
  sendPresenceComposing?(conversationId: string): Promise<void>;
  sendPresencePaused?(conversationId: string): Promise<void>;
};

/** Shared host seam: completion is durable first, then this is the sole send path. */
export function deliverGroundedResponse(database: V1Database, owner: RuntimeOutboundOwner, turnId: string) {
  return owner.sendTurnResponse({ authorization: new ResponseGroundingGuard(database).authorize(turnId) });
}
