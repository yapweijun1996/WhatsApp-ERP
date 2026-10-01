import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { V1Database } from './database.js';
import { CommerceService, type OrderSemanticAgentFactory } from './commerce.js';
import { SimulatedChannel, QrDemoAdapter, UnsupportedChannel, type WhatsAppChannelAdapter } from './channels.js';
import { createStaffCapabilityAuthority, type StaffCapability } from './staff-auth.js';
import { createV1ServiceSeams } from './v2-service-seams.js';
import { requestedTransportMode, runtimeTelemetry } from './runtime-mode.js';
import { V2RolloutService } from './v2-rollout.js';
import { createRolloutApprovalAuthority } from './rollout-auth.js';
import { runV2Eval002 } from './v2-eval-002-harness.js';
import { V2CanaryIngressRouter, type ProspectReplyScope } from './v2-canary-ingress-router.js';
import { DemoGatewaySession, demoGatewayConfig, demoGatewayModel } from './gateway.js';
import { V2PiHarness } from './v2-pi-harness.js';
import { createPiDemoStream } from './v2-pi-demo-stream.js';
import { AgentEndpointTraceRecorder, projectAgentTrace, traceFailureCode, traceRequestBody, traceResponseBody } from './v2-agent-observability.js';
import { V3ShadowRollout } from './v3-shadow-rollout.js';
import { createMigrationApprovalAuthority } from './migration-auth.js';
import { V3Mig003Control } from './v3-mig-003-control.js';
import { V3LiveCanaryBridge } from './v3-live-canary-bridge.js';
import { createV3CanaryComposition, createV3CanaryRuntimeRunner } from './v3-canary-runtime-composition.js';
import { createProspectModelCaller } from './v2-prospect-model-caller.js';

import {renderConversationPrint} from './conversation-print.js';
import {listConversations,selectedConversation} from './conversation-view.js';
import {pairingOwnerControlFromEnv,type PairingOwnerControl} from './pairing-owner-auth.js';

const STAFF_COOKIE = 'waerp_staff_session';
const staffCookieSecure=()=>process.env.NODE_ENV==='production'?'; Secure':'';
function parseCookies(header?: string): Record<string,string> { return Object.fromEntries((header??'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return i<0?[x,'']:[x.slice(0,i),decodeURIComponent(x.slice(i+1))]})); }

export function createApp(options: { dbFilename?: string; staffBootstrapCredential?: string; semanticAgentFactory?: OrderSemanticAgentFactory; demoDataset?: 'default'|'petshop'; startupMode?: 'active'|'paused'; prospectReplyScopes?:readonly ProspectReplyScope[]; pairingOwnerControl?:PairingOwnerControl; channel?:WhatsAppChannelAdapter } = {}) {
  const app=Fastify({logger:false});
  const paused=options.startupMode==='paused';
  const requestedChannel=requestedTransportMode();
  const isQr=requestedChannel==='whatsapp-qr';
  const channel: WhatsAppChannelAdapter = options.channel ?? (requestedChannel==='simulated' ? new SimulatedChannel() : isQr ? new QrDemoAdapter() : new UnsupportedChannel(requestedChannel));
  const pairingOwner=options.pairingOwnerControl??pairingOwnerControlFromEnv();
  const staffAuthority=createStaffCapabilityAuthority();
  const rolloutAuthority=createRolloutApprovalAuthority();
  const service=new CommerceService(new V1Database(options.dbFilename ?? process.env.ORDER_DB ?? 'order-intelligence.db',undefined,rolloutAuthority,options.demoDataset ?? (process.env.DEMO_DATASET === 'petshop' ? 'petshop' : 'default')),channel,staffAuthority.verify,options.semanticAgentFactory);
  const rollout=new V2RolloutService(service.database,rolloutAuthority);
  const seams=createV1ServiceSeams(service);
  const demoConfig=demoGatewayConfig();
  const canaryEnabled=/^(1|true|yes)$/i.test(process.env.V2_CANARY_RUNTIME_ENABLED??'false');
  const endpointTrace=new AgentEndpointTraceRecorder(service.database.db);
  const demoSession=canaryEnabled&&demoConfig.enabled?new DemoGatewaySession(demoConfig):undefined;
  const piHarness=demoSession?new V2PiHarness(service.database,{
    model:demoGatewayModel(demoConfig),
    streamFn:createPiDemoStream({session:demoSession,config:demoConfig,trace:endpointTrace}),
    outbound:service.outbound,
    roleId:process.env.V2_AGENT_ROLE_ID?.trim()||'sales-digital-employee',
  }):undefined;
  // The semantic V1 agent is retained for isolated tests/demo compatibility only.
  // Live channel traffic has no legacy fallback when V2 is disabled or unavailable.
  // The environment gate is the test-only compatibility switch. An injected
  // semantic factory is never itself authorization for legacy ingress.
  const allowLegacyFallback=process.env.NODE_ENV==='test';
  // Prospect model: text-only AI seam for NORMAL unknown/prospect messages.
  // Available only when the Demo Gateway session is live (canaryEnabled + DEMO_GPT_ENABLED).
  // Fails closed to static onboarding reply when absent — no ERP executor or customer
  // scope is reachable from the ProspectModelCaller interface.
  const prospectModel = demoSession ? createProspectModelCaller(demoSession) : undefined;
  const v2Router=new V2CanaryIngressRouter(service.database,service,rollout,{enabled:canaryEnabled,prospectReplyScopes:options.prospectReplyScopes,piHarness,outbound:service.outbound,allowLegacyFallback,prospectModel});
  // The live V3 bridge is present but fail-closed: activation still requires
  // the process-local opaque MIG-003 approval and an explicitly supplied V3
  // runtime composition. No provider traffic is enabled by this construction.
  const migrationAuthority=createMigrationApprovalAuthority();
  // V3 runtime composition is wired only when a Pi harness is available (requires
  // GATEWAY_URL + API_KEY). Without a harness the bridge remains fail-closed on
  // any activated V3 scope (V3_RUNTIME_COMPOSITION_REQUIRED), which is the safe
  // default for non-gateway deployments.
  const v3CanaryComposition = piHarness
    ? createV3CanaryComposition(service.database, piHarness, service.outbound)
    : undefined;
  const v3CanaryRuntimeRunner = v3CanaryComposition
    ? createV3CanaryRuntimeRunner(v3CanaryComposition)
    : undefined;
  const v3Canary = new V3LiveCanaryBridge(new V3Mig003Control(migrationAuthority), {v2:v2Router, runtimeRunner:v3CanaryRuntimeRunner});
  const v3Shadow = new V3ShadowRollout();
  const receiveWithShadow = async (input: Parameters<V2CanaryIngressRouter['receive']>[0]) => {
    const v2Result = canaryEnabled ? await v3Canary.receive(input) : await v2Router.receive(input);
    return v3Shadow.runShadowOnly({accountId:input.accountId,conversationId:input.conversationId},v2Result,()=>undefined);
  };
  service.ensureSeeded();
  // Channel delivery may begin while an async adapter is connecting. Gate both
  // inbound delivery and the simulated route on recovery completing first.
  const startupReady = (paused ? Promise.resolve() : channel.connect().then(async () => { await service.reconcileOutbound(); }).catch(error => { app.log.error({err:error},'channel startup failed'); throw error; }));
  channel.onMessage(async message=>{if(paused)return;try{await startupReady;await receiveWithShadow(message)}catch(error){app.log.error({err:error},'channel inbound failed')}});
  const staffSessions=new Map<string,{subject:string;expiresAt:number;capability:StaffCapability}>();
  const bootstrapCredential=options.staffBootstrapCredential ?? process.env.STAFF_BOOTSTRAP_CREDENTIAL;
  const validBootstrap=(req:any)=>{
    const header=typeof req.headers?.authorization==='string'?req.headers.authorization:'';
    const supplied=header.startsWith('Bearer ')?header.slice(7):'';
    if(!bootstrapCredential||!supplied)return false;
    const a=Buffer.from(supplied),b=Buffer.from(bootstrapCredential);
    return a.length===b.length&&timingSafeEqual(a,b);
  };
  const session=(req:{headers:{cookie?:string}})=>{const token=parseCookies(req.headers.cookie)[STAFF_COOKIE];if(!token)return undefined;const s=staffSessions.get(token);if(!s||s.expiresAt<=Date.now()){if(s)staffSessions.delete(token);return undefined}return{token,...s}};
  const root=join(fileURLToPath(new URL('.',import.meta.url)),'../public');
  app.register(fastifyStatic,{root});
  app.get('/',async(_,r)=>r.sendFile('index.html'));
  app.addHook('onRequest',async(req,reply)=>{if(paused&&!(req.method==='POST'&&req.url.split('?')[0]==='/api/channel/pairing')&&['POST','PUT','PATCH','DELETE'].includes(req.method))return reply.code(503).send({error:'MIGRATION_RUNTIME_PAUSED'})});
  app.get('/health',async()=>{const operational=runtimeTelemetry();const channel=process.env.ORDER_CHANNEL??process.env.WHATSAPP_CHANNEL??'simulated';return{ok:true,startupMode:paused?'paused':'active',channel,...operational,agentRuntime:piHarness?'pi-harness':'legacy-or-disabled',rollout:{v2Traffic:'OFF',v3Shadow:'PROPOSED'}}});
  if (process.env.NODE_ENV === 'test' && process.env.V2_EVAL_002_SURFACE === '1') app.get('/api/test-only/v2-eval-002', async () => runV2Eval002());
  const channelStatus=async()=>({...('getStatusInfo' in channel ? (channel as any).getStatusInfo() : {status:await channel.getStatus(),mode:'simulated',adapter:'WhatsAppChannelAdapter',qrReady:false,qr:null}),pairingControl:{enabled:Boolean(paused&&isQr&&pairingOwner),processingPaused:paused}});
  app.get('/api/channel/status',async(_,reply)=>{reply.header('cache-control','no-store');return channelStatus()});
  let pairingPending=false;let lastPairingAttempt=0;
  app.post('/api/channel/pairing',async(req,reply)=>{
    reply.header('cache-control','no-store');
    if(!paused||!isQr||!pairingOwner||!('reconnectForPairing' in channel))return reply.code(403).send({error:'PAIRING_CONTROL_UNAVAILABLE'});
    if(req.headers.origin!==pairingOwner.publicOrigin||req.headers['x-waerp-pairing-action']!=='regenerate')return reply.code(403).send({error:'PAIRING_ORIGIN_REQUIRED'});
    const assertion=req.headers['cf-access-jwt-assertion'];
    if(typeof assertion!=='string'||!await pairingOwner.verifyOwner(assertion))return reply.code(403).send({error:'PAIRING_OWNER_REQUIRED'});
    if(await channel.getStatus()==='connected')return reply.code(409).send({error:'WHATSAPP_ALREADY_CONNECTED'});
    if(pairingPending||Date.now()-lastPairingAttempt<5000){reply.header('retry-after','5');return reply.code(429).send({error:'PAIRING_RETRY_LATER'})}
    pairingPending=true;lastPairingAttempt=Date.now();
    try{await (channel as QrDemoAdapter).reconnectForPairing();return {...await channelStatus(),pairingRequested:true}}
    catch{return reply.code(503).send({error:'PAIRING_CONNECT_FAILED'})}
    finally{pairingPending=false}
  });
  const currentAccountId=()=>isQr?(channel as QrDemoAdapter).getStatusInfo().accountId:'demo-account';
  app.get('/api/conversations',async(_,reply)=>{reply.header('cache-control','no-store');return {conversations:listConversations(service.database.db,currentAccountId())}});
  const selection=(req:any)=>{
    const accountId=currentAccountId();const requested=req.query?.conversationId;
    if(requested!==undefined&&(typeof requested!=='string'||!requested||requested.length>200))return undefined;
    const id=requested??(listConversations(service.database.db,accountId)[0] as {id:string}|undefined)?.id;
    return id?selectedConversation(service.database.db,accountId,id):undefined;
  };
  app.get('/api/state',async(req:any,reply)=>{
    reply.header('cache-control','no-store');const selected=selection(req);
    if(!selected)return reply.code(404).send({error:'CONVERSATION_NOT_FOUND'});
    const conversationId=selected.id,accountId=selected.accountId;
    const messages=(service.database.db.prepare('SELECT id,direction,text,message_type messageType,occurred_at occurredAt FROM messages WHERE conversation_id=? AND account_id=? ORDER BY rowid').all(conversationId,accountId) as any[]).map(m=>({...m,from:m.direction==='INBOUND'?'customer':'ai'}));
    const state={...service.state(conversationId),messages,phone:selected.phone??'',conversation:selected,operational:{...runtimeTelemetry(),startupMode:paused?'paused':'active',agentRuntime:piHarness?'pi-harness':'legacy-or-disabled'},v3Shadow:v3Shadow.telemetry({accountId,conversationId})};const s=session(req);
    return s?{...state,rollout:rollout.telemetry({accountId,conversationId})}:{...state,rollout:{detail:'STAFF_SESSION_REQUIRED'}}
  });
  app.get('/api/print',async(req:any,reply)=>{reply.header('cache-control','no-store');const selected=selection(req);if(!selected)return reply.code(404).send({error:'CONVERSATION_NOT_FOUND'});reply.header('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");reply.header('x-content-type-options','nosniff');return reply.type('text/html; charset=utf-8').send(renderConversationPrint(service.state(selected.id),selected))});
  app.get('/api/agent-trace',async(req:any,reply)=>{reply.header('cache-control','no-store');const selected=selection(req);if(!selected)return reply.code(404).send({error:'CONVERSATION_NOT_FOUND'});return projectAgentTrace(service.database.db,selected.accountId,selected.id)});
  app.get('/api/agent-harness',async()=>piHarness?piHarness.describe():{engine:'disabled',role:null,skills:[],tools:[],authority:'NONE'});
  app.post('/api/simulated/inbound',async(req:any)=>{await startupReady;const b=req.body??{};const input={channel:'whatsapp' as const,accountId:'demo-account',externalMessageId:b.externalMessageId??`api-${Date.now()}-${randomBytes(3).toString('hex')}`,conversationId:'conv-001',sender:{externalId:'+6591110001',phone:'+6591110001'},type:b.type??'text',text:b.text,occurredAt:new Date().toISOString()};return receiveWithShadow(input)});
  app.get('/api/staff/session',async req=>{const s=session(req);return{authenticated:Boolean(s),subject:s?.subject??null}});
  app.post('/api/staff/session',async(req:any,reply)=>{if(!validBootstrap(req))return reply.code(401).send({error:'STAFF_BOOTSTRAP_REQUIRED'});const token=randomBytes(24).toString('base64url');staffSessions.set(token,{subject:'demo-staff',expiresAt:Date.now()+3600000,capability:staffAuthority.issue('demo-staff')});reply.header('set-cookie',`${STAFF_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${staffCookieSecure()}`);return{authenticated:true,subject:'demo-staff'}});
  app.delete('/api/staff/session',async(req,reply)=>{const s=session(req);if(s)staffSessions.delete(s.token);reply.header('set-cookie',`${STAFF_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${staffCookieSecure()}`);return{authenticated:false}});
  app.post('/api/staff/:action',async(req:any,reply)=>{const s=session(req);if(!s)return reply.code(401).send({error:'STAFF_SESSION_REQUIRED'});const action=String(req.params.action);if(!['post','confirm','do'].includes(action))return reply.code(400).send({error:'INVALID_STAFF_ACTION'});try{const b=req.body??{};if(!b.salesOrderNo)return reply.code(400).send({error:'SALES_ORDER_REQUIRED'});return await seams.staffCommit.commit({action:action as 'post'|'confirm'|'do',capability:s.capability,idempotencyKey:b.idempotencyKey??`${s.subject}-${action}-${Date.now()}`,evidence:b.doubleConfirmationEvidence,salesOrderNo:String(b.salesOrderNo)})}catch(error){const message=(error as Error).message;return reply.code(message==='STOCK_SHORTAGE'||message==='INVALID_TRANSITION'?409:400).send({error:message})}});
  app.post('/api/reset',async(req:any,reply)=>{if(!session(req)&&!validBootstrap(req))return reply.code(401).send({error:'STAFF_BOOTSTRAP_REQUIRED'});service.resetAndSeed();return service.state()});
  return {app,service,channel,seams,rollout,v3Shadow,v3Canary,migrationAuthority,startupReady};
}
