import type { AgentTurnProjection } from './v2-agent-turn-coordinator.js';

export type PiWorkflowPolicy = Readonly<{
  phase:string;
  allowedCapabilityNames?:readonly string[];
  activeSkillIds?:readonly string[];
  finalOnly:boolean;
}>;

/**
 * AI-first production policy.
 *
 * Customer language is never parsed here. Pi chooses intent, skill and tool
 * semantically from Role/Skills + conversation + canonical state. The host may
 * only enforce a canonical safety stop that is independent of natural-language
 * interpretation.
 */
export function piWorkflowPolicy(context:any, _projection:AgentTurnProjection):PiWorkflowPolicy {
  const salesOrder=context?.activeQuotationSalesOrder?.salesOrder;
  if(salesOrder?.status==='DRAFT'){
    return Object.freeze({
      phase:'SALES_ORDER_DRAFT_STOP',
      allowedCapabilityNames:Object.freeze([]),
      activeSkillIds:Object.freeze(['commitment']),
      finalOnly:true,
    });
  }
  return Object.freeze({
    phase:'AI_FIRST',
    activeSkillIds:Object.freeze(['customer-service','order-taking','quotation','commitment']),
    finalOnly:false,
  });
}
