import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CommerceService } from '../src/commerce.js';
import { SimulatedChannel, type IncomingChannelMessage } from '../src/channels.js';
import { createApp } from '../src/app.js';
import { createV1ServiceSeams } from '../src/v2-service-seams.js';
import { runtimeTelemetry } from '../src/runtime-mode.js';
import { scriptedSemanticAgentFactory, goldenOffer, prepareQuote } from './semantic-agent.js';

const order='Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?';
const message=(text:string,id:string,extra:Partial<IncomingChannelMessage>={}):IncomingChannelMessage=>({channel:'whatsapp',accountId:'demo-account',externalMessageId:id,conversationId:'conv-001',sender:{externalId:'+6591110001',phone:'+6591110001'},type:'text',text,occurredAt:new Date().toISOString(),...extra});
const envKeys=['ORDER_RUNTIME_MODE','DEMO_GPT_ENABLED','GPT_GATEWAY_BASE_URL','GPT_GATEWAY_URL','ORDER_CHANNEL','WHATSAPP_CHANNEL'] as const;
async function cleanEnv(run:()=>Promise<void>|void){const old=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));for(const k of envKeys)delete process.env[k];try{await run()}finally{for(const k of envKeys){const v=old[k];if(v===undefined)delete process.env[k];else process.env[k]=v}}}

test('Phase 0 runtime telemetry is truthful and fail-closed to V1',async()=>cleanEnv(async()=>{
  process.env.ORDER_RUNTIME_MODE='V2';process.env.GPT_GATEWAY_BASE_URL='https://example.invalid/v1';process.env.ORDER_CHANNEL='meta-cloud';
  const t=runtimeTelemetry();
  assert.equal(t.requestedRuntimeMode,'V2');assert.equal(t.runtimeMode,'V1');
  assert.equal(t.requestedModelMode,'configured-gateway');assert.equal(t.modelMode,'deterministic');
  assert.equal(t.requestedTransportMode,'meta-cloud');assert.equal(t.transportMode,'meta-cloud');assert.equal(t.v2TrafficEnabled,false);
  assert.deepEqual(t.fallbackReasons,['PHASE0_V2_TRAFFIC_DISABLED','PRIVATE_GATEWAY_NOT_ACTIVE_IN_V1_PI_RUNTIME','META_CLOUD_ADAPTER_NOT_ACTIVE']);
  const {app,channel}=createApp({dbFilename:':memory:'});await app.ready();try{const h=(await app.inject({method:'GET',url:'/health'})).json();assert.equal(h.runtimeMode,'V1');assert.equal(h.channel,'meta-cloud');assert.equal(h.requestedTransportMode,'meta-cloud');assert.equal(h.transportMode,'meta-cloud');assert.equal((channel as any).getStatusInfo().supported,false);assert.equal(h.aiCutoff,'SALES_ORDER.DRAFT')}finally{await app.close()}
}));

test('Phase 0 compatibility seam exposes only genuinely delegated V1 services',async()=>{
  const channel=new SimulatedChannel();await channel.connect();const service=new CommerceService(undefined,channel,undefined,scriptedSemanticAgentFactory([goldenOffer(),prepareQuote]));service.resetAndSeed();const seams=createV1ServiceSeams(service);
  assert.deepEqual(Object.keys(seams).sort(),['conversation','quotation','staffCommit']);
  await seams.conversation.receive(message(order,'seam-order'));
  assert.equal((service.database.db.prepare("SELECT count(*) AS n FROM messages WHERE external_message_id='seam-order'").get() as any).n,1);
});

test('Phase 0 preserves cutoff, forged staff authority, duplicate inbound, and immutable quote evidence',async()=>{
  const channel=new SimulatedChannel();await channel.connect();const service=new CommerceService(undefined,channel,undefined,scriptedSemanticAgentFactory([goldenOffer(),prepareQuote, {intent:'clarify', reason:'test decision'}, {intent:'accept_quote', reason:'test decision'}]));service.resetAndSeed();
  await service.inbound(message(order,'phase0-order'));await service.inbound(message('Yes please.','phase0-prepare'));
  const quote=service.database.db.prepare('SELECT * FROM quotations').get() as any;const snapshot=quote.sent_snapshot_json,hash=quote.sent_snapshot_hash;
  const evidence=service.database.db.prepare('SELECT lookup_key,output_json FROM erp_evidence ORDER BY rowid LIMIT 1').get() as any;assert.equal(quote.status,'SENT');
  await service.inbound(message('OK confirm.','phase0-forwarded',{forwarding:{isForwarded:true}}));assert.equal((service.database.db.prepare('SELECT count(*) AS n FROM sales_orders').get() as any).n,1);
  await service.inbound(message('OK confirm.','phase0-accept'));assert.equal((service.database.db.prepare('SELECT status FROM sales_orders WHERE source_quotation_id=?').get(quote.id) as any).status,'DRAFT');
  await service.inbound(message('OK confirm.','phase0-accept'));assert.equal((service.database.db.prepare('SELECT count(*) AS n FROM messages WHERE external_message_id=?').get('phase0-accept') as any).n,1);
  const frozen=service.database.db.prepare('SELECT sent_snapshot_json,sent_snapshot_hash FROM quotations WHERE id=?').get(quote.id) as any;assert.equal(frozen.sent_snapshot_json,snapshot);assert.equal(frozen.sent_snapshot_hash,hash);assert.ok(evidence.lookup_key&&evidence.output_json);
  assert.throws(()=>service.staff('post',{actorType:'staff'},'forged','forged','SO-000052'),/STAFF_AUTH_REQUIRED/);
});

test('Phase 0 preserves UNKNOWN quotation reconciliation and no blind resend',async()=>{
  const channel=new SimulatedChannel([{status:'unknown',clientMessageId:'unknown'}]);await channel.connect();const service=new CommerceService(undefined,channel,undefined,scriptedSemanticAgentFactory([goldenOffer(),prepareQuote]));service.resetAndSeed();
  await service.inbound(message(order,'unknown-order'));await service.inbound(message('Yes please.','unknown-prepare'));assert.equal(channel.sendCount,1);
  await service.inbound(message(order,'unknown-new-order'));await service.inbound(message('Yes please.','unknown-new-prepare'));assert.equal(channel.sendCount,1);
  assert.equal((service.database.db.prepare('SELECT status FROM outbound_messages').get() as any).status,'UNKNOWN');assert.equal((service.database.db.prepare('SELECT count(*) AS n FROM sales_orders').get() as any).n,1);
});

test('Phase 0 domain contracts are isolated from provider SDK payloads',()=>{
  for(const file of ['src/channel-contract.ts','src/v2-domain-contracts.ts','src/v2-service-seams.ts']){const source=readFileSync(file,'utf8');assert.doesNotMatch(source,/@whiskeysockets|baileys|WAMessage|MetaCloudAdapter|QrDemoAdapter/i)}
});


test('Phase 0 quotation seam reports durable outbound state instead of fabricating success',async()=>{
  const submitted=new SimulatedChannel();await submitted.connect();const okService=new CommerceService(undefined,submitted,undefined,scriptedSemanticAgentFactory([goldenOffer(),prepareQuote]));okService.resetAndSeed();
  await okService.inbound(message(order,'seam-ok-order'));await okService.inbound(message('Yes please.','seam-ok-prepare'));
  const okQuote=okService.database.db.prepare('SELECT id FROM quotations').get() as any;const ok=await createV1ServiceSeams(okService).quotation.send(okQuote.id);assert.equal(ok.status,'SUCCEEDED');assert.equal((ok.data as any).status,'SENT');

  const unknownChannel=new SimulatedChannel([{status:'unknown',clientMessageId:'ignored'}],[{status:'unknown'}]);await unknownChannel.connect();const unknownService=new CommerceService(undefined,unknownChannel,undefined,scriptedSemanticAgentFactory([goldenOffer(),prepareQuote]));unknownService.resetAndSeed();
  await unknownService.inbound(message(order,'seam-unknown-order'));await unknownService.inbound(message('Yes please.','seam-unknown-prepare'));
  const unknownQuote=unknownService.database.db.prepare('SELECT id FROM quotations').get() as any;const unknown=await createV1ServiceSeams(unknownService).quotation.send(unknownQuote.id);assert.equal(unknown.status,'BLOCKED');assert.equal(unknown.reasonCode,'OUTBOUND_RECONCILIATION_REQUIRED');assert.equal(unknownChannel.sendCount,1);
  const reconciled=await createV1ServiceSeams(unknownService).quotation.reconcile();assert.equal(reconciled.status,'BLOCKED');

  const failedChannel=new SimulatedChannel([{status:'failed',retryable:false,errorCode:'terminal'}]);await failedChannel.connect();const failedService=new CommerceService(undefined,failedChannel,undefined,scriptedSemanticAgentFactory([goldenOffer(),prepareQuote]));failedService.resetAndSeed();
  await failedService.inbound(message(order,'seam-failed-order'));await failedService.inbound(message('Yes please.','seam-failed-prepare'));
  const failedQuote=failedService.database.db.prepare('SELECT id FROM quotations').get() as any;const failed=await createV1ServiceSeams(failedService).quotation.send(failedQuote.id);assert.equal(failed.status,'FAILED');assert.equal(failed.reasonCode,'OUTBOUND_TERMINAL_FAILURE');

  const pendingChannel=new SimulatedChannel();await pendingChannel.connect();const pendingService=new CommerceService(undefined,pendingChannel,undefined,scriptedSemanticAgentFactory([goldenOffer(),prepareQuote]));pendingService.resetAndSeed();pendingService.setCrashAfterSubmittedBeforeFinalize();
  await pendingService.inbound(message(order,'seam-pending-order'));await assert.rejects(pendingService.inbound(message('Yes please.','seam-pending-prepare')),/INJECTED_CRASH_AFTER_SUBMITTED/);
  const pendingQuote=pendingService.database.db.prepare('SELECT id FROM quotations').get() as any;const pending=await createV1ServiceSeams(pendingService).quotation.send(pendingQuote.id);assert.equal(pending.status,'BLOCKED');assert.equal(pending.reasonCode,'OUTBOUND_PENDING');assert.equal(pendingChannel.sendCount,1);
});
