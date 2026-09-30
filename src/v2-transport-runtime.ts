import type { V1Database } from './database.js';
import { AgentTurnCoordinator, type AgentActionProjection, type AgentTurnProjection, type AgentTurnStart } from './v2-agent-turn-coordinator.js';
import { getCapability } from './v2-capability-registry.js';
import { normalizeCapabilityResult, type CapabilityResult, type JsonValue } from './v2-capability-result.js';
import type { AgentDecision, AgentModelTransport, AgentObservation } from './v2-agent-model-transport.js';
import type { GroundedResponsePlan } from './v2-grounded-response-plan.js';
import { isRepairableDemoTextModelOutputFailure } from './v2-demo-text-tool-bridge.js';
import { canonicalJson, canonicalSha256 } from './v2-canonical.js';
import { deliverGroundedResponse, type RuntimeOutboundOwner } from './v2-runtime-outbound.js';

/** Optional transport hook for a host-owned wire correlation envelope. */
export type HostResultCorrelation = (input: Readonly<{
  turnId: string;
  sequence: number;
  correlationId: string;
  actionId: string;
  name: string;
  result: CapabilityResult;
}>) => unknown;

export type TransportRuntimeOptions = Readonly<{
  transport: AgentModelTransport;
  execute: (action: AgentActionProjection, signal?: AbortSignal) => Promise<unknown> | unknown;
  /** The bridge supplies this hook; native transports leave it unset. */
  encodeHostCapabilityResult?: HostResultCorrelation;
  signal?: AbortSignal;
  /** Optional production wiring; omitted by existing V2-disabled callers. */
  outbound?: RuntimeOutboundOwner;
}>;

export type TransportRuntimeOutcome = Readonly<{
  turnId: string;
  status: 'TERMINAL' | 'FAIL_CLOSED';
  reasonCode: string;
  responsePlan: GroundedResponsePlan | null;
  projection: AgentTurnProjection;
}>;

const FAILED_RESULT = normalizeCapabilityResult({ status: 'FAILED', evidence: [], stateChanges: [], reasonCode: 'CAPABILITY_EXECUTION_FAILED' });

/**
 * Host loop shared by text and native semantic transports.
 *
 * The transport can parse/propose a decision, but this class is the only place
 * that crosses into AgentTurnCoordinator. Consequently the bridge has no
 * executor, domain service, authorization, or result-ledger authority.
 */
export class V2TransportRuntime {
  private readonly coordinator: AgentTurnCoordinator;

  constructor(private readonly database: V1Database, private readonly options: TransportRuntimeOptions) {
    this.coordinator = new AgentTurnCoordinator(database);
  }

  async run(input: AgentTurnStart, externalSignal?: AbortSignal): Promise<TransportRuntimeOutcome> {
    let projection = this.coordinator.startOrResume(input);
    if (projection.status === 'RECONCILE_ACTION') return this.fail('TRANSPORT_RECONCILE_ACTION_PENDING', projection);
    if (projection.status === 'TERMINAL') {
      const reason = this.coordinator.terminalReason(projection.turnId) ?? 'TRANSPORT_TERMINAL_ALREADY_COMPLETE';
      if (this.isDurableFailure(reason) && reason !== 'PI_BUDGET_EXHAUSTED_HANDOFF') return this.fail(reason, projection);
      const plan = reason === 'PI_FINAL_PENDING_GROUNDING' || reason === 'PI_BUDGET_EXHAUSTED_HANDOFF' ? this.coordinator.finalResponsePlan(projection.turnId) : null;
      if (plan && this.options.outbound) {
        try { await deliverGroundedResponse(this.database, this.options.outbound, projection.turnId); }
        catch { return this.fail('TRANSPORT_OUTBOUND_FAILED', projection); }
      }
      return { turnId: projection.turnId, status: 'TERMINAL', reasonCode: reason, responsePlan: plan, projection };
    }

    const signal = externalSignal ?? this.options.signal;
    const budget = this.coordinator.budget(projection.turnId);
    const runtimeController = new AbortController();
    let interruption: 'CANCELLED' | 'TIMEOUT' | null = null;
    const cancel = (kind: 'CANCELLED' | 'TIMEOUT') => {
      if (!interruption) { interruption = kind; runtimeController.abort(); }
    };
    const onCancel = () => cancel('CANCELLED');
    signal?.addEventListener('abort', onCancel, { once: true });
    if (signal?.aborted) cancel('CANCELLED');
    const turnTimer = setTimeout(() => cancel('TIMEOUT'), Math.max(1, Date.parse(budget.deadlineAt) - Date.now()));
    const cleanup = () => { clearTimeout(turnTimer); signal?.removeEventListener('abort', onCancel); };
    const finish = async (reason: string): Promise<TransportRuntimeOutcome> => { cleanup(); return this.fail(reason, this.coordinator.read(projection.turnId)); };
    const fingerprints = (observation: AgentObservation) => ({ observationHash: canonicalSha256(canonicalJson(observation)), projectionHash: canonicalSha256(canonicalJson(observation.availableCapabilities)) });
    const interrupted = async <T>(operation: Promise<T>): Promise<T | undefined> => {
      if (runtimeController.signal.aborted) return undefined;
      let listener: (() => void) | undefined;
      const stop = new Promise<undefined>(resolve => {
        listener = () => resolve(undefined);
        runtimeController.signal.addEventListener('abort', listener, { once: true });
      });
      const value = await Promise.race([operation, stop]);
      if (listener) runtimeController.signal.removeEventListener('abort', listener);
      return value;
    };
    try { while (true) {
      if (runtimeController.signal.aborted) return finish(interruption === 'TIMEOUT' ? 'PI_BUDGET_EXHAUSTED_HANDOFF' : 'PI_CANCELLED');
      if (Date.now() >= Date.parse(budget.deadlineAt)) {
        projection = this.coordinator.exhaust({ turnId: projection.turnId, reason: 'PI_BUDGET_EXHAUSTED_HANDOFF' });
        cleanup();
        return { turnId: projection.turnId, status: 'FAIL_CLOSED', reasonCode: 'PI_BUDGET_EXHAUSTED_HANDOFF', responsePlan: null, projection };
      }
      const observation = this.observation(projection);
      const fp = fingerprints(observation);
      const recovery = this.coordinator.modelAttemptRecovery(projection.turnId);
      if (recovery === 'UNCERTAIN') return finish('PI_MODEL_RECOVERY_HANDOFF');
      let repair = this.coordinator.repairEvidence(projection.turnId);
      let modelSequence: number | undefined;
      if (repair && repair.phase !== 'COMMITTED' && repair.phase !== 'FAILED') {
        if (repair.phase !== 'PENDING') return finish('PI_REPAIR_RECOVERY_HANDOFF');
        this.coordinator.reserveRepairAttempt({ turnId: projection.turnId, decisionSequence: repair.decision_sequence, ...fp, reasonCode: 'PI_TRANSPORT_MODEL_REPAIR' });
        repair = this.coordinator.repairEvidence(projection.turnId);
      } else {
        if (this.coordinator.usage(projection.turnId).modelAttempts >= budget.budgets.maxModelTurns) return finish('PI_BUDGET_EXHAUSTED_HANDOFF');
        modelSequence = this.coordinator.reserveModelAttempt({ turnId: projection.turnId, kind: 'MODEL', reasonCode: 'PI_TRANSPORT_MODEL_TURN', ...fp });
        repair = undefined;
      }
      const decisionSequence = repair?.decision_sequence ?? modelSequence;
      const attemptKind: 'MODEL'|'REPAIR' = repair?.phase === 'RESERVED' ? 'REPAIR' : 'MODEL';
      let usedRepair = attemptKind === 'REPAIR';
      let decision: AgentDecision;
      try {
        const decided = await interrupted(this.options.transport.decide(observation, runtimeController.signal, attemptKind));
        if (!decided) return finish(interruption === 'TIMEOUT' ? 'PI_BUDGET_EXHAUSTED_HANDOFF' : 'PI_CANCELLED');
        decision = decided;
      } catch (error) {
        // Only the host may decide to repair. The bridge's retry boundary is
        // merely a same-observation protocol guard; it does not loop.
        const repairable = attemptKind === 'MODEL' && this.options.transport.mode === 'demo-text' && isRepairableDemoTextModelOutputFailure(error);
        const usageBeforeRepair = this.coordinator.usage(projection.turnId);
        const repairAvailable = repairable
          && usageBeforeRepair.repairAttempts < budget.budgets.maxRepairAttempts
          && usageBeforeRepair.modelAttempts < budget.budgets.maxModelTurns
          && Date.now() < Date.parse(budget.deadlineAt);
        // Never create a second repair scope after the turn's repair budget is
        // already consumed. A later malformed decision must exhaust cleanly.
        if (repairAvailable) this.coordinator.recordRepairPending({ turnId: projection.turnId, decisionSequence: decisionSequence!, ...fp });
        if (!repairAvailable) {
          const exhausted = this.options.transport.mode === 'demo-text'
            && isRepairableDemoTextModelOutputFailure(error)
            && (this.coordinator.usage(projection.turnId).repairAttempts >= budget.budgets.maxRepairAttempts
              || this.coordinator.usage(projection.turnId).modelAttempts >= budget.budgets.maxModelTurns
              || Date.now() >= Date.parse(budget.deadlineAt));
          return finish(exhausted ? 'PI_BUDGET_EXHAUSTED_HANDOFF' : 'PI_MODEL_FAILED');
        }
        this.coordinator.reserveRepairAttempt({ turnId: projection.turnId, decisionSequence: decisionSequence!, ...fp, reasonCode: 'PI_TRANSPORT_MODEL_REPAIR' });
        usedRepair = true;
        try {
          const repaired = await interrupted(this.options.transport.decide(observation, runtimeController.signal, 'REPAIR'));
          if (!repaired) return finish(interruption === 'TIMEOUT' ? 'PI_BUDGET_EXHAUSTED_HANDOFF' : 'PI_CANCELLED');
          decision = repaired;
        } catch (repairError) {
          if (interruption) return finish(interruption === 'TIMEOUT' ? 'PI_BUDGET_EXHAUSTED_HANDOFF' : 'PI_CANCELLED');
          this.coordinator.failRepair({ turnId: projection.turnId, decisionSequence: decisionSequence!, ...fp });
          return finish(isRepairableDemoTextModelOutputFailure(repairError) ? 'PI_BUDGET_EXHAUSTED_HANDOFF' : 'PI_MODEL_FAILED');
        }
      }
      if (attemptKind === 'MODEL') this.coordinator.recordModelValid({ turnId: projection.turnId, sequence: decisionSequence!, ...fp });
      if (usedRepair) this.coordinator.recordRepairValid({ turnId: projection.turnId, decisionSequence: decisionSequence!, ...fp });
      if (decision.turnId !== projection.turnId || decision.sequence !== projection.actions.length + 1) return finish('TRANSPORT_DECISION_CORRELATION');

      if (decision.kind === 'final_response') {
        projection = this.coordinator.completeWithResponsePlan(projection.turnId, decision.responsePlan);
        if (usedRepair) this.coordinator.recordRepairCommitted({ turnId: projection.turnId, decisionSequence: decisionSequence!, ...fp });
        if (this.options.outbound) {
          try { await deliverGroundedResponse(this.database, this.options.outbound, projection.turnId); }
          catch { return finish('TRANSPORT_OUTBOUND_FAILED'); }
        }
        cleanup();
        return { turnId: projection.turnId, status: 'TERMINAL', reasonCode: 'PI_FINAL_PENDING_GROUNDING', responsePlan: decision.responsePlan, projection };
      }

      const definition = getCapability(decision.capabilityName);
      if (!definition || definition.version !== decision.capabilityVersion) return finish('TRANSPORT_CAPABILITY_UNAVAILABLE');
      let proposed: AgentTurnProjection;
      try {
        proposed = this.coordinator.propose({
          turnId: projection.turnId,
          sequence: decision.sequence,
          actionId: decision.actionId,
          capability: { name: decision.capabilityName, version: decision.capabilityVersion },
          arguments: decision.arguments,
          idempotencyKey: `transport:${projection.turnId}:${decision.sequence}:${definition.name}`,
        });
      } catch { return finish('TRANSPORT_ACTION_REJECTED'); }
      const action = proposed.actions.find(candidate => candidate.sequence === decision.sequence);
      if (!action) return finish('TRANSPORT_ACTION_NOT_PERSISTED');
      projection = proposed;
      if (usedRepair) this.coordinator.recordRepairCommitted({ turnId: projection.turnId, decisionSequence: decisionSequence!, ...fp });

      // Proposal is durable, so an interruption here must become reconciliation
      // state before the executor is even scheduled.
      if (runtimeController.signal.aborted) {
        const outcome: 'TIMEOUT' | 'CANCELLED' = interruption === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED';
        const reasonCode = interruption === 'TIMEOUT' ? 'PI_TURN_TIMEOUT' : 'PI_CANCELLED';
        projection = this.coordinator.recordExecutionInterruption({ turnId: projection.turnId, actionId: action.id, sequence: action.sequence, outcome, reasonCode });
        cleanup();
        return this.fail('PI_RECONCILE_ACTION_PENDING', projection);
      }

      let result: CapabilityResult;
      const callController = new AbortController();
      let localTimeout = false;
      const abortCall = () => callController.abort();
      runtimeController.signal.addEventListener('abort', abortCall, { once: true });
      const timeout = setTimeout(() => { localTimeout = true; callController.abort(); }, budget.budgets.perCallTimeoutMs);
      const executor = Promise.resolve().then(async () => {
        if (callController.signal.aborted) return { kind: 'INTERRUPTED' as const };
        try { return { kind: 'RESULT' as const, value: await this.options.execute(action, callController.signal) }; }
        catch { return { kind: 'ERROR' as const }; }
      });
      let callListener: (() => void) | undefined;
      const callInterrupted = new Promise<{ kind: 'INTERRUPTED' }>(resolve => {
        callListener = () => resolve({ kind: 'INTERRUPTED' });
        if (callController.signal.aborted) callListener();
        else callController.signal.addEventListener('abort', callListener, { once: true });
      });
      const winner = await Promise.race([executor, callInterrupted]);
      clearTimeout(timeout);
      runtimeController.signal.removeEventListener('abort', abortCall);
      if (callListener) callController.signal.removeEventListener('abort', callListener);
      if (winner.kind === 'INTERRUPTED' || callController.signal.aborted) {
        const outcome: 'TIMEOUT' | 'CANCELLED' = interruption === 'CANCELLED' || (!localTimeout && interruption !== 'TIMEOUT') ? 'CANCELLED' : 'TIMEOUT';
        const reasonCode = interruption === 'TIMEOUT' ? 'PI_TURN_TIMEOUT' : outcome === 'CANCELLED' ? 'PI_CANCELLED' : 'PI_CAPABILITY_TIMEOUT';
        projection = this.coordinator.recordExecutionInterruption({ turnId: projection.turnId, actionId: action.id, sequence: action.sequence, outcome, reasonCode });
        cleanup();
        return this.fail('PI_RECONCILE_ACTION_PENDING', projection);
      }
      result = winner.kind === 'RESULT' ? (() => { try { return normalizeCapabilityResult(winner.value); } catch { return FAILED_RESULT; } })() : FAILED_RESULT;
      const terminal = result.status === 'SUCCEEDED' && (definition.outbound.disposition === 'CAPABILITY_OWNED_QUOTATION' || definition.outbound.disposition === 'HANDOFF_NO_CUSTOMER_MESSAGE');
      if (terminal) {
        const reason = definition.outbound.disposition === 'CAPABILITY_OWNED_QUOTATION' ? 'PI_CAPABILITY_OWNED_QUOTATION' : 'PI_HANDOFF_NO_CUSTOMER_MESSAGE';
        try { projection = this.coordinator.recordResultAndComplete({ turnId: projection.turnId, actionId: action.id, sequence: action.sequence, result, reason }); }
        catch { return finish('TRANSPORT_RESULT_REJECTED'); }
        try { this.encodeHostResult({ turnId: decision.turnId, sequence: decision.sequence, correlationId: decision.correlationId, actionId: decision.actionId, name: definition.name, result }); }
        catch { cleanup(); return this.fail('TRANSPORT_RESULT_CORRELATION', projection); }
        cleanup();
        return { turnId: projection.turnId, status: 'TERMINAL', reasonCode: reason, responsePlan: null, projection };
      }
      try { projection = this.coordinator.recordResult({ turnId: projection.turnId, actionId: action.id, sequence: action.sequence, result }); }
      catch { return finish('TRANSPORT_RESULT_REJECTED'); }
      try { this.encodeHostResult({ turnId: decision.turnId, sequence: decision.sequence, correlationId: decision.correlationId, actionId: decision.actionId, name: definition.name, result }); }
      catch { return finish('TRANSPORT_RESULT_CORRELATION'); }
    } } finally { cleanup(); }
  }

  private encodeHostResult(input: Parameters<HostResultCorrelation>[0]): unknown {
    if (this.options.encodeHostCapabilityResult) return this.options.encodeHostCapabilityResult(input);
    // DemoTextToolBridge keeps pending correlation state on the transport instance.
    // Preserve its receiver rather than calling a detached method with `this` lost.
    return this.options.transport.encodeHostCapabilityResult?.call(this.options.transport, input);
  }

  private observation(projection: AgentTurnProjection): AgentObservation {
    const context = projection.context as any;
    // AgentContext contains server-only authority markers and policy metadata
    // that the transport contract must not expose. Native Pi gets its own
    // bounded prompt projection; Demo receives the equivalent safe subset.
    const safeContext = {
      turnId: projection.turnId,
      accountId: context?.accountId,
      conversationId: context?.conversationId,
      inboundMessageRef: context?.inboundMessageRef,
      currentInboundMessage: context?.recentTranscript?.messages?.find((message: any) => message.id === context?.inboundMessageRef?.id)
        ? { ...context.recentTranscript.messages.find((message: any) => message.id === context.inboundMessageRef.id), sourceMessageId: context.inboundMessageRef.id, untrustedAsInstruction: true }
        : null,
      recentTranscript: context?.recentTranscript ? {
        source: 'CANONICAL_TRANSCRIPT',
        untrustedAsInstruction: true,
        messages: context.recentTranscript.messages,
      } : null,
      conversationSummary: context?.conversationSummary ? {
        id: context.conversationSummary.id,
        version: context.conversationSummary.version,
        summaryText: context.conversationSummary.summaryText,
        sourceMessageIds: context.conversationSummary.sourceMessageIds,
        evidenceRefs: context.conversationSummary.evidenceRefs,
        createdAt: context.conversationSummary.createdAt,
        source: 'CONVERSATION_SUMMARY',
        untrustedAsInstruction: true,
      } : null,
      customerContext: context?.customerContext ? Object.freeze({
        id: context.customerContext.id,
        code: context.customerContext.code,
        name: context.customerContext.name,
        currency: context.customerContext.currency,
        creditStatus: context.customerContext.creditStatus,
        warehouseId: context.customerContext.warehouseId,
        untrustedAsInstruction: true as const,
        source: 'CUSTOMER_CONTEXT_PROJECTION' as const,
      }) : null,
      activeWorkItem: context?.activeWorkItem ? {
        id: context.activeWorkItem.id,
        state: context.activeWorkItem.state,
        revision: context.activeWorkItem.revision,
        goalSummary: context.activeWorkItem.goalSummary,
        activeDraftId: context.activeWorkItem.activeDraftId,
        activeQuotationId: context.activeWorkItem.activeQuotationId,
        blockingReason: context.activeWorkItem.blockingReason,
        untrustedAsInstruction: true,
        source: 'WORK_ITEM',
      } : null,
      orderDraft: context?.orderDraft ?? null,
      activeQuotationSalesOrder: context?.activeQuotationSalesOrder ? {
        quotation: context.activeQuotationSalesOrder.quotation,
        acceptance: context.activeQuotationSalesOrder.acceptance,
        salesOrder: context.activeQuotationSalesOrder.salesOrder,
        outbound: context.activeQuotationSalesOrder.outbound,
      } : null,
      currentTime: context?.currentTime,
      unresolvedQuestions: context?.unresolvedQuestions ?? [],
    };
    return {
      turnId: projection.turnId,
      sequence: projection.actions.length + 1,
      context: safeContext,
      availableCapabilities: context?.availableCapabilities ?? [],
      completedActions: projection.actions.filter(action => action.result !== null).map(action => this.modelCompletedAction(action)),
    };
  }

  private modelCompletedAction(action: AgentActionProjection) {
    const result = action.result as any;
    return {
      actionId: action.id, name: action.capability.name, status: result?.status,
      ...(result?.data === undefined ? {} : { data: this.modelResultData(result.data) }),
      ...(typeof result?.reasonCode === 'string' ? { reasonCode: result.reasonCode } : {}),
      ...(Array.isArray(result?.stateChanges) && result.stateChanges.length ? { stateChanges: result.stateChanges } : {}),
    };
  }

  private modelResultData(value: unknown): JsonValue {
    if (Array.isArray(value)) return value.slice(0, 20).map(item => this.modelResultData(item));
    if (!value || typeof value !== 'object') return value as JsonValue;
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'evidence' || key === 'evidenceRefs' || key === 'validationEvidenceRefs') continue;
      output[key] = this.modelResultData(child);
    }
    return output;
  }

  private async fail(reasonCode: string, projection: AgentTurnProjection): Promise<TransportRuntimeOutcome> {
    if (projection.status === 'AWAITING_DECISION' && reasonCode === 'PI_BUDGET_EXHAUSTED_HANDOFF') {
      projection = this.coordinator.completeWithSafeHandoff(projection.turnId);
      const responsePlan = this.coordinator.finalResponsePlan(projection.turnId);
      if (this.options.outbound) { try { await deliverGroundedResponse(this.database, this.options.outbound, projection.turnId); } catch { return { turnId: projection.turnId, status: 'FAIL_CLOSED', reasonCode: 'TRANSPORT_OUTBOUND_FAILED', responsePlan, projection }; } }
      return { turnId: projection.turnId, status: 'TERMINAL', reasonCode, responsePlan, projection };
    }
    if (projection.status === 'AWAITING_DECISION') projection = this.coordinator.exhaust({ turnId: projection.turnId, reason: reasonCode });
    return { turnId: projection.turnId, status: 'FAIL_CLOSED', reasonCode, responsePlan: null, projection };
  }

  private isDurableFailure(reason: string): boolean {
    return reason.startsWith('TRANSPORT_') || reason === 'PI_MODEL_FAILED' || reason === 'PI_CANCELLED' || reason === 'PI_BUDGET_EXHAUSTED_HANDOFF' || reason === 'PI_CAPABILITY_ACTION_REJECTED';
  }
}

export { V2TransportRuntime as AgentModelTransportRuntime };
