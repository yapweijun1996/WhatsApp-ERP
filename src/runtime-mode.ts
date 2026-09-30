export type RuntimeMode = 'V1' | 'V2';
export type RequestedRuntimeMode = RuntimeMode | 'UNSUPPORTED';
export type ModelMode = 'deterministic' | 'demo-gpt' | 'configured-gateway';
export type EffectiveModelMode = Exclude<ModelMode, 'configured-gateway'>;
export type TransportMode = 'simulated' | 'whatsapp-qr' | 'meta-cloud';
export type EffectiveTransportMode = TransportMode | 'unsupported';

export type RuntimeTelemetry = {
  requestedRuntimeMode: RequestedRuntimeMode;
  runtimeMode: 'V1';
  requestedModelMode: ModelMode;
  modelMode: EffectiveModelMode;
  /** Safe, allowlisted model id; null unless Demo GPT is active. */
  modelId: string | null;
  /** Model protocol, intentionally separate from the WhatsApp channel transport. */
  modelTransportMode: 'deterministic' | 'demo-text';
  requestedTransportMode: TransportMode | 'UNSUPPORTED';
  transportMode: EffectiveTransportMode;
  aiCutoff: 'SALES_ORDER.DRAFT';
  v2TrafficEnabled: false;
  fallbackReasons: string[];
};

function env(name: string): string | undefined { const value=process.env[name]?.trim(); return value||undefined; }
function enabledFlag(name: string): boolean { return /^(1|true|yes)$/i.test(env(name) ?? 'false'); }

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SECRET_LOOKING_MODEL_ID = /(secret|token|api[._-]?key|password|bearer|credential|private[._-]?key|dmo_|(?:^|[/_.:-])sk(?:[-_/.:]|$))/i;
const NETWORK_LOCATION_MODEL_ID = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^\/\//;

/** Project only a bounded model identifier; raw environment values never enter telemetry. */
function safeDemoModelId(): string | null {
  const value = env('DEMO_GPT_MODEL') ?? 'demo-fast';
  return SAFE_MODEL_ID.test(value) && !NETWORK_LOCATION_MODEL_ID.test(value) && !SECRET_LOOKING_MODEL_ID.test(value)
    ? value
    : 'redacted';
}

export function requestedRuntimeMode(): RequestedRuntimeMode {
  const value=env('ORDER_RUNTIME_MODE');
  if(!value||value==='V1') return 'V1';
  if(value==='V2') return 'V2';
  return 'UNSUPPORTED';
}
/** Phase 0 never routes customer traffic to V2. */
export function runtimeMode(): 'V1' { return 'V1'; }

export function requestedModelMode(): ModelMode {
  if(enabledFlag('DEMO_GPT_ENABLED')) return 'demo-gpt';
  if(env('GPT_GATEWAY_BASE_URL')||env('GPT_GATEWAY_URL')) return 'configured-gateway';
  return 'deterministic';
}
/** Current Pi runtime uses Demo GPT when enabled; otherwise the V1 deterministic provider. */
export function modelMode(): EffectiveModelMode { return enabledFlag('DEMO_GPT_ENABLED')?'demo-gpt':'deterministic'; }

export function requestedTransportMode(): TransportMode|'UNSUPPORTED' {
  const configured=env('ORDER_CHANNEL')??env('WHATSAPP_CHANNEL');
  if(!configured||configured==='simulated') return 'simulated';
  if(configured==='whatsapp-qr') return 'whatsapp-qr';
  if(configured==='meta-cloud') return 'meta-cloud';
  return 'UNSUPPORTED';
}
/** Report the actual configured mode; unsupported modes never masquerade as simulated. */
export function transportMode(): EffectiveTransportMode {
  const requested=requestedTransportMode();
  return requested==='UNSUPPORTED' ? 'unsupported' : requested;
}

export function runtimeTelemetry(): RuntimeTelemetry {
  const requestedRuntime=requestedRuntimeMode();
  const requestedModel=requestedModelMode();
  const requestedTransport=requestedTransportMode();
  const fallbackReasons:string[]=[];
  if(requestedRuntime==='V2') fallbackReasons.push('PHASE0_V2_TRAFFIC_DISABLED');
  if(requestedRuntime==='UNSUPPORTED') fallbackReasons.push('UNSUPPORTED_RUNTIME_MODE');
  if(requestedModel==='configured-gateway') fallbackReasons.push('PRIVATE_GATEWAY_NOT_ACTIVE_IN_V1_PI_RUNTIME');
  if(requestedTransport==='meta-cloud') fallbackReasons.push('META_CLOUD_ADAPTER_NOT_ACTIVE');
  if(requestedTransport==='UNSUPPORTED') fallbackReasons.push('UNSUPPORTED_CHANNEL_MODE');
  const effectiveModel = modelMode();
  return {
    requestedRuntimeMode: requestedRuntime,
    runtimeMode: 'V1',
    requestedModelMode: requestedModel,
    modelMode: effectiveModel,
    modelId: effectiveModel === 'demo-gpt' ? safeDemoModelId() : null,
    modelTransportMode: effectiveModel === 'demo-gpt' ? 'demo-text' : 'deterministic',
    requestedTransportMode: requestedTransport,
    transportMode: transportMode(),
    aiCutoff: 'SALES_ORDER.DRAFT',
    v2TrafficEnabled: false,
    fallbackReasons,
  };
}
