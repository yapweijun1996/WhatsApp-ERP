import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PiOrderAgent, forbiddenPiToolNames, parseOrderIntentResult } from '../src/pi-agent.js';
import { DemoGatewaySession, gatewayConfig, createGatewayProvider } from '../src/gateway.js';
import { normalizeBaileysMessage } from '../src/channels.js';

test('legacy fallback is an explicit non-semantic clarify stub', async () => {
  let calls=0; const agent=new PiOrderAgent(intent=>{calls++;return Promise.resolve(intent)});
  const result=await agent.run('Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?');
  assert.equal(result.intent,'clarify'); assert.equal(result.reason,'NO_SEMANTIC_MODEL_AVAILABLE'); assert.equal(calls,1);
  assert.deepEqual(forbiddenPiToolNames(),['post_sales_order','confirm_sales_order','create_delivery_order','DO_READY']);
  assert.ok(!agent.allowedToolNames.some(name=>forbiddenPiToolNames().includes(name)));
});

test('gateway configuration is env-only and provider uses configured model/base URL', () => {
  const old={base:process.env.GPT_GATEWAY_BASE_URL,key:process.env.GPT_GATEWAY_API_KEY,model:process.env.GPT_GATEWAY_MODEL};
  process.env.GPT_GATEWAY_BASE_URL='https://gateway.example/v1'; process.env.GPT_GATEWAY_API_KEY='test-key'; process.env.GPT_GATEWAY_MODEL='model-a';
  assert.deepEqual(gatewayConfig(),{baseUrl:'https://gateway.example/v1',apiKey:'test-key',model:'model-a'});
  const provider=createGatewayProvider(); const model=provider.getModels()[0]; assert.equal(model.id,'model-a'); assert.equal(model.baseUrl,'https://gateway.example/v1');
  if(old.base===undefined)delete process.env.GPT_GATEWAY_BASE_URL;else process.env.GPT_GATEWAY_BASE_URL=old.base;
  if(old.key===undefined)delete process.env.GPT_GATEWAY_API_KEY;else process.env.GPT_GATEWAY_API_KEY=old.key;
  if(old.model===undefined)delete process.env.GPT_GATEWAY_MODEL;else process.env.GPT_GATEWAY_MODEL=old.model;
});

test('customer paraphrases are not host-hardcoded', () => {
  const source = readFileSync(new URL('../src/pi-agent.ts', import.meta.url), 'utf8');
  for (const phrase of ['Yes please', 'OK confirm', 'same as last week', 'tomorrow']) assert.equal(source.includes(phrase), false);
});

test('Demo intent parser is strict and rejects malformed or unsafe JSON', () => {
  assert.deepEqual(parseOrderIntentResult('{"intent":"prepare_quote","reason":"yes"}').intent, 'prepare_quote');
  assert.deepEqual(
    parseOrderIntentResult('{"intent":"offer_quote","reason":"order","lines":[{"product":"Ayam","quantity":10,"uom":"ctn"}],"requestedDeliveryDate":"2026-09-09"}'),
    { intent: 'offer_quote', reason: 'order', lines: [{ query: 'Ayam', quantity: 10, uom: 'ctn' }], requestedDeliveryDate: '2026-09-09' },
  );
  assert.deepEqual(
    parseOrderIntentResult('{"intent":"prepare_quote","reason":"yes","lines":[],"requestedDeliveryDate":null}'),
    { intent: 'prepare_quote', reason: 'yes' },
  );
  assert.throws(() => parseOrderIntentResult('{"intent":"offer_quote","reason":"x","lines":[{"sku":"ABC","quantity":1,"uom":"CTN"}]}'), /INVALID_ORDER_INTENT_JSON/);
  assert.throws(() => parseOrderIntentResult('{"intent":"prepare_quote","reason":"yes","unexpected":true}'), /INVALID_ORDER_INTENT_JSON/);
  assert.throws(() => parseOrderIntentResult('{"intent":"accept_quote","reason": {"toString":"x"}}'), /INVALID_ORDER_INTENT_JSON/);
  assert.throws(() => parseOrderIntentResult('not json'), /INVALID_ORDER_INTENT_JSON/);
  assert.throws(() => parseOrderIntentResult('Here is the result: {"intent":"prepare_quote","reason":"yes"}'), /INVALID_ORDER_INTENT_JSON/);
  assert.throws(() => parseOrderIntentResult('{"intent":"offer_quote","reason":"x","requestedDeliveryDate":"tomorrow"}'), /INVALID_ORDER_INTENT_JSON/);
});

test('Demo session request shape and one 401 refresh use mocked fetch only', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let inferenceCalls = 0;
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/demo/session')) return new Response(JSON.stringify({ dmo_token: 'token-a', expires_in: 60 }), { status: 200, headers: { 'content-type': 'application/json' } });
    inferenceCalls++;
    return inferenceCalls === 1 ? new Response('', { status: 401 }) : new Response('{}', { status: 200 });
  };
  const session = new DemoGatewaySession({ enabled: true, baseUrl: 'https://gpt.example', projectId: 'project-a', origin: 'http://127.0.0.1:32111', model: 'demo-fast' }, mockFetch as typeof fetch);
  await session.fetch('https://gpt.example/demo/v1/responses', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(calls[0].url, 'https://gpt.example/demo/session');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { project_id: 'project-a' });
  assert.equal(new Headers(calls[0].init?.headers).get('Origin'), 'http://127.0.0.1:32111');
  assert.equal(calls.filter(c => c.url.endsWith('/demo/session')).length, 2);
  assert.equal(new Headers(calls.at(-1)?.init?.headers).get('Authorization'), 'Bearer token-a');
});

test('Demo completeText uses the exact restricted responses request shape', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/demo/session')) {
      return new Response(JSON.stringify({ token: 'dmo-test-session', expires_in: 900 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 'resp-1',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"intent":"prepare_quote","reason":"customer said yes"}' }] }],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const session = new DemoGatewaySession({ enabled: true, baseUrl: 'https://gpt.example', projectId: 'project-a', origin: 'http://127.0.0.1:32111', model: 'demo-fast' }, mockFetch as typeof fetch);
  const result = await session.completeText('interpret this');
  const inference = calls.find(call => call.url.endsWith('/demo/v1/responses'))!;
  const body = JSON.parse(String(inference.init?.body));
  const headers = new Headers(inference.init?.headers);
  assert.deepEqual(body, { model: 'demo-fast', input: 'interpret this' });
  assert.equal(Object.hasOwn(body, 'tools'), false);
  assert.equal(Object.hasOwn(body, 'stream'), false);
  assert.equal(Object.hasOwn(body, 'store'), false);
  assert.equal(headers.get('Origin'), 'http://127.0.0.1:32111');
  assert.equal(headers.get('Authorization'), 'Bearer dmo-test-session');
  assert.equal(result.text, '{"intent":"prepare_quote","reason":"customer said yes"}');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
});

test('Pi Demo mode calls demo-fast text endpoint with no tools and locally validates JSON', async () => {
  const oldFetch = globalThis.fetch;
  const keys = ['DEMO_GPT_ENABLED','DEMO_GPT_BASE_URL','DEMO_GPT_PROJECT_ID','DEMO_GPT_ORIGIN','DEMO_GPT_MODEL'] as const;
  const oldEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/demo/session')) {
      return new Response(JSON.stringify({ token: 'dmo-agent-test', expires_in: 900 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(input).endsWith('/demo/v1/responses')) {
      return new Response(JSON.stringify({
        id: 'resp-agent',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"intent":"clarify","reason":"model was conservative"}' }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`UNEXPECTED_URL:${String(input)}`);
  }) as typeof fetch;
  Object.assign(process.env, {
    DEMO_GPT_ENABLED: 'true',
    DEMO_GPT_BASE_URL: 'https://gpt.example',
    DEMO_GPT_PROJECT_ID: 'project-a',
    DEMO_GPT_ORIGIN: 'http://127.0.0.1:32111',
    DEMO_GPT_MODEL: 'demo-fast',
  });
  try {
    let handled: any;
    const agent = new PiOrderAgent(async intent => { handled = intent; return intent; });
    assert.deepEqual(agent.allowedToolNames, []);
    const result = await agent.run('Yes');
    assert.equal(result.intent, 'clarify');
    assert.equal(handled.intent, 'clarify');
    const inference = calls.find(call => call.url.endsWith('/demo/v1/responses'))!;
    const body = JSON.parse(String(inference.init?.body));
    assert.equal(body.model, 'demo-fast');
    assert.equal(typeof body.input, 'string');
    assert.ok(body.input.includes('CUSTOMER MESSAGE:\nYes'));
    assert.doesNotMatch(body.input, /Plain .Yes./);
    assert.deepEqual(Object.keys(body).sort(), ['input','model']);
    assert.equal(new Headers(inference.init?.headers).get('Origin'), 'http://127.0.0.1:32111');
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of keys) {
      const value = oldEnv[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Baileys normalization is provider-neutral and filters unsafe message classes', () => {
  const base:any={key:{remoteJid:'6591110001@s.whatsapp.net',fromMe:false,id:'wamid-1'},messageTimestamp:1,message:{extendedTextMessage:{text:'hello',contextInfo:{stanzaId:'prior'}}}};
  const normalized=normalizeBaileysMessage(base,'qr-account'); assert.equal(normalized?.channel,'whatsapp'); assert.equal(normalized?.text,'hello'); assert.equal(normalized?.sender.phone,'+6591110001'); assert.equal(normalized?.replyToExternalMessageId,'prior');
  const missingTimestamp=normalizeBaileysMessage({...base,messageTimestamp:undefined,key:{...base.key,remoteJid:'65-9111-0001@s.whatsapp.net'}}); assert.equal(missingTimestamp?.sender.phone,'+6591110001'); assert.ok(Number.isFinite(Date.parse(missingTimestamp!.occurredAt)));
  const lid=normalizeBaileysMessage({...base,key:{...base.key,remoteJid:'123456789@lid',remoteJidAlt:'6591110001@s.whatsapp.net'}}); assert.equal(lid?.conversationId,'123456789@lid'); assert.equal(lid?.sender.externalId,'123456789@lid'); assert.equal(lid?.sender.phone,'+6591110001');
  const forwarded=normalizeBaileysMessage({...base,message:{extendedTextMessage:{text:'OK confirm',contextInfo:{isForwarded:true,forwardingScore:1,participant:'6588880000@s.whatsapp.net'}}}}); assert.deepEqual(forwarded?.forwarding,{isForwarded:true,originalSenderKnown:true,originalSenderExternalId:'6588880000@s.whatsapp.net'});
  const imageCaption=normalizeBaileysMessage({...base,message:{imageMessage:{caption:'OK confirm',mimetype:'image/jpeg'}}}); assert.equal(imageCaption?.type,'image'); assert.equal(imageCaption?.text,'OK confirm'); assert.equal(imageCaption?.media?.mimeType,'image/jpeg');
  assert.equal(normalizeBaileysMessage({...base,key:{...base.key,fromMe:true}}),undefined); assert.equal(normalizeBaileysMessage({...base,key:{...base.key,remoteJid:'123@g.us'}}),undefined);
});
