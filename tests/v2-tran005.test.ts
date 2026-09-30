import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { demoGatewayConfig, DemoGatewayError, DemoGatewaySession } from '../src/gateway.js';
import { createApp } from '../src/app.js';
import { runtimeTelemetry } from '../src/runtime-mode.js';

test('TRAN-005 keeps the actual Demo-enabled app path from persisting or exposing its session token', async () => {
  const token = 'dmo_TRAN005_memory_only_sentinel';
  const modelRequests: Array<{ url: string; body: string; authorization?: string }> = [];
  let malformedResponse = false;
  const oldFetch = globalThis.fetch;
  const envKeys = ['NODE_ENV', 'V2_CANARY_RUNTIME_ENABLED', 'DEMO_GPT_ENABLED', 'DEMO_GPT_BASE_URL', 'DEMO_GPT_PROJECT_ID', 'DEMO_GPT_ORIGIN', 'DEMO_GPT_MODEL'] as const;
  const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), 'v2-tran005-'));
  const dbFilename = join(dir, 'order.db');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/demo/session')) return new Response(JSON.stringify({ dmo_token: token, expires_in: 60 }), { status: 200 });
    if (url.endsWith('/demo/v1/responses')) {
      const body = String(init?.body ?? '');
      modelRequests.push({ url, body, authorization: new Headers(init?.headers).get('authorization') ?? undefined });
      if (malformedResponse) return new Response(token, { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({
        id: 'demo-response-tran005',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
          intent: 'offer_quote', reason: 'explicit order lines',
          lines: [{ query: 'ayam', quantity: 1, uom: 'CTN' }],
          requestedDeliveryDate: '2026-09-30',
        }) }] }],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  for (const key of envKeys) delete process.env[key];
  // This test asserts the Demo-enabled *V2 runtime* app path. The Demo Gateway
  // session is only constructed when the V2 canary gate is on, so the gate must
  // be explicit here. Production stays fail-closed when it is unset.
  process.env.V2_CANARY_RUNTIME_ENABLED = 'true';
  process.env.DEMO_GPT_ENABLED = 'true';
  process.env.DEMO_GPT_BASE_URL = 'https://gpt.example';
  process.env.DEMO_GPT_PROJECT_ID = 'tran005-test';
  process.env.DEMO_GPT_ORIGIN = 'http://127.0.0.1:32111';
  process.env.DEMO_GPT_MODEL = 'demo-fast';
  // The injected semantic factory is legacy compatibility and is valid only
  // inside this explicitly scoped test environment.
  process.env.NODE_ENV = 'test';

  try {
    const session = new DemoGatewaySession();
    await session.getToken();
    assert.equal(JSON.stringify(session).includes(token), false);
    assert.equal(Object.keys(session).includes('#token'), false);
    const error = new DemoGatewayError(500, 'DEMO_GPT_500');
    assert.equal(JSON.stringify(error).includes(token), false);
    assert.equal(String(error).includes(token), false);

    const { app, service } = createApp({ dbFilename });
    await app.ready();
    try {
      const inbound = await app.inject({ method: 'POST', url: '/api/simulated/inbound', payload: { text: 'Ayam 1 ctn', externalMessageId: 'tran005-actual' } });
      assert.equal(inbound.statusCode, 200);
      const inboundBody = JSON.stringify(inbound.json());
      assert.match(inboundBody, /Stock is available/);
      assert.equal(inboundBody.includes(token), false);
      assert.equal(modelRequests.length, 1);
      assert.equal(modelRequests[0].authorization, `Bearer ${token}`);
      assert.equal(modelRequests[0].body.includes(token), false);
      const modelBody = JSON.parse(modelRequests[0].body) as { input: string };
      assert.equal(modelBody.input.includes('CUSTOMER MESSAGE:\nAyam 1 ctn'), true);
      assert.equal(modelBody.input.includes(token), false);

      malformedResponse = true;
      const malformed = await app.inject({ method: 'POST', url: '/api/simulated/inbound', payload: { text: 'Wings 1 ctn', externalMessageId: 'tran005-malformed' } });
      assert.equal(malformed.statusCode, 200);
      assert.equal(malformed.body.includes(token), false);
      assert.equal(JSON.stringify(service.database.db.prepare('SELECT payload_json FROM audit_events').all()).includes(token), false);
      assert.equal(JSON.stringify(service.state()).includes(token), false);
      assert.equal(modelRequests.length, 2);

      for (const url of ['/health', '/api/state']) {
        const body = (await app.inject({ method: 'GET', url })).json();
        assert.equal(JSON.stringify(body).includes(token), false);
      }
      assert.equal(JSON.stringify(service.state()).includes(token), false);
    } finally {
      await app.close();
      service.database.db.close();
    }

    const filenames = ['', '-wal', '-shm'].map(suffix => `${dbFilename}${suffix}`);
    for (const filename of filenames) {
      if (existsSync(filename)) assert.equal(readFileSync(filename).includes(token), false, filename);
    }
    const db = new Database(dbFilename, { readonly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
      for (const { name } of tables) {
        const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
        assert.equal(JSON.stringify(rows).includes(token), false, name);
      }
      for (const table of ['audit_events', 'agent_runs', 'agent_tool_calls', 'messages', 'outbound_messages']) {
        assert.ok(tables.some(candidate => candidate.name === table));
      }
    } finally {
      db.close();
    }
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of envKeys) {
      const value = oldEnv[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TRAN-005 exposes safe Demo model metadata separately from channel transport', async () => {
  const old = {
    enabled: process.env.DEMO_GPT_ENABLED,
    model: process.env.DEMO_GPT_MODEL,
    base: process.env.DEMO_GPT_BASE_URL,
  };
  process.env.DEMO_GPT_ENABLED = 'true';
  process.env.DEMO_GPT_MODEL = 'demo-ops-v2';
  process.env.DEMO_GPT_BASE_URL = 'https://secret.example/dmo_TRAN005_secret';
  try {
    const telemetry = runtimeTelemetry();
    assert.equal(telemetry.modelId, 'demo-ops-v2');
    assert.equal(telemetry.modelTransportMode, 'demo-text');
    assert.equal(telemetry.transportMode, 'simulated');
    assert.equal(JSON.stringify(telemetry).includes('secret.example'), false);
    assert.equal(JSON.stringify(telemetry).includes('dmo_TRAN005_secret'), false);

    const { app } = createApp({ dbFilename: ':memory:' });
    await app.ready();
    try {
      for (const url of ['/health', '/api/state']) {
        const body = (await app.inject({ method: 'GET', url })).json();
        const operational = url === '/health' ? body : body.operational;
        assert.equal(operational.modelId, 'demo-ops-v2');
        assert.equal(operational.modelTransportMode, 'demo-text');
        assert.equal(operational.transportMode, 'simulated');
        assert.equal(JSON.stringify(body).includes('secret.example'), false);
        assert.equal(JSON.stringify(body).includes('dmo_TRAN005_secret'), false);
      }
    } finally {
      await app.close();
    }
  } finally {
    for (const [key, value] of Object.entries({ DEMO_GPT_ENABLED: old.enabled, DEMO_GPT_MODEL: old.model, DEMO_GPT_BASE_URL: old.base })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('TRAN-005 redacts unsafe model ids and keeps default mode truthful', () => {
  const old = { enabled: process.env.DEMO_GPT_ENABLED, model: process.env.DEMO_GPT_MODEL };
  try {
    delete process.env.DEMO_GPT_ENABLED;
    process.env.DEMO_GPT_MODEL = 'dmo_secret_model_token';
    const disabled = runtimeTelemetry();
    assert.equal(disabled.modelMode, 'deterministic');
    assert.equal(disabled.modelId, null);
    assert.equal(disabled.modelTransportMode, 'deterministic');
    process.env.DEMO_GPT_ENABLED = 'true';
    const active = runtimeTelemetry();
    assert.equal(active.modelId, 'redacted');
    assert.equal(active.modelTransportMode, 'demo-text');
    assert.equal(JSON.stringify(active).includes('dmo_secret_model_token'), false);
    for (const model of [
      'https://internal.example', 'http://internal.example', 'ws://internal.example', 'wss://internal.example', '//internal.example',
      'ftp://internal.example/model', 'ssh://internal.example/model', 'file:///tmp/model',
      'openai/dmo_0123456789abcdef', 'dmo_abcdef', 'sk-proj-0123456789abcdef',
      'openai/api.key-abcdef', 'openai/private.key-abcdef', 'openai/sk/proj/abcdef',
    ]) {
      process.env.DEMO_GPT_MODEL = model;
      assert.equal(runtimeTelemetry().modelId, 'redacted', model);
    }
    process.env.DEMO_GPT_MODEL = 'openai/gpt-x';
    assert.equal(runtimeTelemetry().modelId, 'openai/gpt-x');
  } finally {
    if (old.enabled === undefined) delete process.env.DEMO_GPT_ENABLED; else process.env.DEMO_GPT_ENABLED = old.enabled;
    if (old.model === undefined) delete process.env.DEMO_GPT_MODEL; else process.env.DEMO_GPT_MODEL = old.model;
  }
});


test('TRAN-005 Demo enablement and model telemetry match normalized gateway configuration', () => {
  const old = { enabled: process.env.DEMO_GPT_ENABLED, model: process.env.DEMO_GPT_MODEL };
  try {
    for (const value of ['true', 'TRUE', '1', 'yes', ' true ']) {
      process.env.DEMO_GPT_ENABLED = value;
      assert.equal(demoGatewayConfig().enabled, true, value);
      assert.equal(runtimeTelemetry().modelMode, 'demo-gpt', value);
      assert.equal(runtimeTelemetry().modelTransportMode, 'demo-text', value);
    }
    for (const value of ['false', '0', 'no']) {
      process.env.DEMO_GPT_ENABLED = value;
      assert.equal(demoGatewayConfig().enabled, false, value);
      assert.equal(runtimeTelemetry().modelMode, 'deterministic', value);
      assert.equal(runtimeTelemetry().modelTransportMode, 'deterministic', value);
    }
    process.env.DEMO_GPT_ENABLED = 'true';
    process.env.DEMO_GPT_MODEL = ' demo-ops-v2 ';
    assert.equal(demoGatewayConfig().model, 'demo-ops-v2');
    assert.equal(runtimeTelemetry().modelId, 'demo-ops-v2');
    process.env.DEMO_GPT_MODEL = '';
    assert.equal(demoGatewayConfig().model, 'demo-fast');
    assert.equal(runtimeTelemetry().modelId, 'demo-fast');
  } finally {
    if (old.enabled === undefined) delete process.env.DEMO_GPT_ENABLED; else process.env.DEMO_GPT_ENABLED = old.enabled;
    if (old.model === undefined) delete process.env.DEMO_GPT_MODEL; else process.env.DEMO_GPT_MODEL = old.model;
  }
});


test('TRAN-005 rejects malformed session tokens before header construction can expose them', async () => {
  const sentinel = 'dmo_TRAN005_header_secret';
  const malformedToken = `${sentinel}\ninvalid`;
  const oldFetch = globalThis.fetch;
  const old = {
    enabled: process.env.DEMO_GPT_ENABLED,
    base: process.env.DEMO_GPT_BASE_URL,
    model: process.env.DEMO_GPT_MODEL,
  };
  process.env.DEMO_GPT_ENABLED = 'true';
  process.env.DEMO_GPT_BASE_URL = 'https://gpt.example';
  process.env.DEMO_GPT_MODEL = 'demo-fast';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/demo/session')) {
      return new Response(JSON.stringify({ dmo_token: malformedToken, expires_in: 60 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('MODEL_ENDPOINT_MUST_NOT_BE_CALLED');
  }) as typeof fetch;
  try {
    const direct = new DemoGatewaySession();
    await assert.rejects(() => direct.completeText('hello'), error => {
      assert.match(String(error), /DEMO_GPT_INVALID_SESSION/);
      assert.equal(String(error).includes(sentinel), false);
      return true;
    });

    const { app, service } = createApp({ dbFilename: ':memory:' });
    await app.ready();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/simulated/inbound', payload: { text: 'Ayam 1 ctn', externalMessageId: 'tran005-invalid-token' } });
      const audits = service.database.db.prepare('SELECT payload_json FROM audit_events').all();
      assert.equal(response.body.includes(sentinel), false);
      assert.equal(JSON.stringify(audits).includes(sentinel), false);
      assert.equal(JSON.stringify(service.state()).includes(sentinel), false);
    } finally {
      await app.close();
      service.database.db.close();
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (old.enabled === undefined) delete process.env.DEMO_GPT_ENABLED; else process.env.DEMO_GPT_ENABLED = old.enabled;
    if (old.base === undefined) delete process.env.DEMO_GPT_BASE_URL; else process.env.DEMO_GPT_BASE_URL = old.base;
    if (old.model === undefined) delete process.env.DEMO_GPT_MODEL; else process.env.DEMO_GPT_MODEL = old.model;
  }
});
