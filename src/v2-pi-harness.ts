import type { Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { V1Database } from './database.js';
import type { AgentActionProjection, AgentTurnStart } from './v2-agent-turn-coordinator.js';
import { V2PiRuntime, type CapabilityExecutor, type V2PiRuntimeOutcome, type V2PiRuntimeOptions } from './v2-pi-runtime.js';
import type { RuntimeOutboundOwner } from './v2-runtime-outbound.js';
import { projectAgentRole, renderRoleSkillPreamble, resolveAgentRole, roleCapabilityNames } from './v2-agent-role-skill-catalog.js';
import { piWorkflowPolicy } from './v2-pi-workflow-policy.js';

export type V2PiHarnessOptions={
  model:Model<any>;
  streamFn:StreamFn;
  outbound:RuntimeOutboundOwner;
  roleId?:string;
};

/**
 * Production V2 agent harness. Pi owns the observe/decide/tool loop; host
 * capabilities, authorization, grounding, queueing and commerce remain outside
 * the harness and cannot be widened by roles or skills.
 */
export class V2PiHarness{
  private readonly role;
  private readonly allowedCapabilityNames:readonly string[];
  private readonly preamble:string;
  constructor(private readonly database:V1Database,private readonly options:V2PiHarnessOptions){
    this.role=resolveAgentRole(options.roleId??'sales-digital-employee');
    this.allowedCapabilityNames=roleCapabilityNames(this.role);
    this.preamble=renderRoleSkillPreamble(this.role);
  }
  async run(start:AgentTurnStart,execute:CapabilityExecutor):Promise<V2PiRuntimeOutcome>{
    if(this.role.profileId&&this.role.profileId!==start.profileId)throw Error('PI_HARNESS_ROLE_PROFILE_MISMATCH');
    return this.runConfigured(start, execute, {});
  }
  /** Same Pi implementation with host-supplied V3 observation/retrieval and
   * fulfillment policy. This is a configuration seam, not another Agent loop. */
  async runV3(start:AgentTurnStart, execute:CapabilityExecutor, v3: Pick<V2PiRuntimeOptions,'v3Observation'|'v3Retrieval'|'v3GoalReverify'|'v3Canary'>):Promise<V2PiRuntimeOutcome>{
    return this.runConfigured(start, execute, v3);
  }
  private runConfigured(start:AgentTurnStart, execute:CapabilityExecutor, extra: Pick<V2PiRuntimeOptions,'v3Observation'|'v3Retrieval'|'v3GoalReverify'|'v3Canary'>):Promise<V2PiRuntimeOutcome>{
    return new V2PiRuntime(this.database,{
      model:this.options.model,streamFn:this.options.streamFn,execute,outbound:this.options.outbound,
      systemPreamble:this.preamble,allowedCapabilityNames:this.allowedCapabilityNames,capabilityPolicy:piWorkflowPolicy,
      ...extra,
    }).run(start);
  }
  describe(){return projectAgentRole(this.role)}
}

export type PiHarnessRunner=Readonly<{run(start:AgentTurnStart,execute:(action:AgentActionProjection,signal?:AbortSignal)=>Promise<unknown>|unknown):Promise<V2PiRuntimeOutcome>;describe():unknown}>;
