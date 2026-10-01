import {runtimeTelemetry} from './runtime-mode.js';

/** Project actual host composition, not an environment request/global rollout.
 * Existing telemetry field names remain; scoped inquiry overrides their old
 * Phase0 values only while that approved Pi path can actually process traffic. */
export function effectiveRuntimeStatus(input:{paused:boolean;inquiryConfigured:boolean;inquiryApproved:boolean;piConfigured:boolean;v2Configured:boolean}){
  const legacy=runtimeTelemetry();
  const scoped=!input.paused&&input.inquiryConfigured&&input.inquiryApproved&&input.piConfigured&&input.v2Configured;
  const mode=input.paused?'PAUSED':scoped?'V2':input.inquiryConfigured?'BLOCKED':'V1';
  return {...legacy,runtimeMode:scoped?'V2' as const:legacy.runtimeMode,v2TrafficEnabled:scoped,
    fallbackReasons:scoped?legacy.fallbackReasons.filter(reason=>reason!=='PHASE0_V2_TRAFFIC_DISABLED'):legacy.fallbackReasons,
    effectiveRuntime:{mode,processing:input.paused?'PAUSED':scoped?'SCOPED_INQUIRY':input.inquiryConfigured?'INQUIRY_BLOCKED':'LEGACY',v2Traffic:scoped?'SCOPED':'OFF',aiProcessing:input.paused?'paused':scoped?'enabled':input.inquiryConfigured?'blocked':input.piConfigured?'configured':'disabled',boundary:'SALES_ORDER.DRAFT'}};
}
