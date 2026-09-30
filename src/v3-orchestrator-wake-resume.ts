/** V3-ORCH-004: host-owned wake/resume bridge into the existing V2 Pi runtime. */
import type { AgentTurnStart } from './v2-agent-turn-coordinator.js';
import { V2PiRuntime, type V2PiRuntimeOutcome } from './v2-pi-runtime.js';
import { processV3AttachmentExtractionHostEvent, type V3AttachmentCompletionCandidate, type V3AttachmentExtractionHostEvent, type V3AttachmentCompletionResult } from './v3-attachment-completion.js';
import type { V3AttachmentObservation } from './v3-orchestrator-observation.js';
import type { V3ContinuationDecision } from './v3-continuation-processing.js';
import type { V1Database } from './database.js';

export type V3WakeResumeCandidate = V3AttachmentCompletionCandidate & Readonly<{attachmentEvidence?: readonly V3AttachmentObservation[]}>;
export type V3WakeResumeTrace = Readonly<{
  wakeEventId: string; continuationId: string; disposition: V3ContinuationDecision['disposition']; reasonCode: V3ContinuationDecision['reasonCode'];
  runtimeResumed: boolean; terminalReason: string|null;
}>;
export type V3WakeResumeResult = Readonly<{completion: V3AttachmentCompletionResult; traces: readonly V3WakeResumeTrace[]; outcomes: readonly V2PiRuntimeOutcome[]}>;
export const isV3WakeRuntimeResumeAuthorized = (decision: Pick<V3ContinuationDecision, 'disposition'|'reasonCode'>): boolean =>
  decision.disposition === 'RESUME_AUTHORIZED' && decision.reasonCode === 'LEASE_REACQUIRED';

function runtimeStart(candidate: V3WakeResumeCandidate, event: V3AttachmentExtractionHostEvent): AgentTurnStart {
  const context = candidate.context as any;
  const refs = context.sourceRevisionRefs;
  return {accountId: event.accountId, conversationId: event.conversationId, inboundMessageId: refs.inboundMessageId, nowIso: context.context.currentTime.iso, timezone: context.context.currentTime.timezone, profileId: refs.profileId};
}

/** Runs no model work unless MM-005 granted the first lease-backed resume. */
export async function resumeV3AttachmentCompletion(
  database: V1Database,
  runtime: V2PiRuntime,
  event: unknown,
  currentVector: unknown,
  candidates: readonly V3WakeResumeCandidate[],
): Promise<V3WakeResumeResult> {
  const completion = processV3AttachmentExtractionHostEvent(database, event, currentVector, candidates.map(({attachmentEvidence: _ignored, ...candidate}) => candidate));
  const typedEvent = completion.event;
  const traces: V3WakeResumeTrace[] = [];
  const outcomes: V2PiRuntimeOutcome[] = [];
  for (let index = 0; index < completion.decisions.length; index += 1) {
    const decision = completion.decisions[index]!;
    const candidate = candidates[index]!;
    let outcome: V2PiRuntimeOutcome|undefined;
    const shouldResume = isV3WakeRuntimeResumeAuthorized(decision);
    if (shouldResume) {
      try {
        outcome = await runtime.runWithAttachmentObservation(runtimeStart(candidate, typedEvent), candidate.attachmentEvidence ?? []);
        outcomes.push(outcome);
      } catch {
        // The durable wake remains the audit record; the adapter fails closed.
      }
    }
    traces.push(Object.freeze({
      wakeEventId: typedEvent.eventId, continuationId: decision.continuationId, disposition: decision.disposition, reasonCode: decision.reasonCode,
      runtimeResumed: shouldResume && outcome !== undefined, terminalReason: outcome?.reasonCode ?? (shouldResume ? 'V3_RUNTIME_RESUME_FAILED' : null),
    }));
  }
  return Object.freeze({completion, traces: Object.freeze(traces), outcomes: Object.freeze(outcomes)});
}
