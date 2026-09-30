import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { scriptedSemanticAgentFactory, goldenOffer, prepareQuote, acceptQuote } from './semantic-agent.js';

// These tests intentionally exercise the isolated legacy compatibility seam.
// Production callers must run with NODE_ENV other than `test`.
process.env.NODE_ENV = 'test';

test('semanticAgentFactory cannot authorize legacy ingress outside test mode', async () => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const { app, service } = createApp({ dbFilename: ':memory:', semanticAgentFactory: scriptedSemanticAgentFactory([goldenOffer()]) });
  await app.ready();
  try {
    const response = await app.inject({ method:'POST', url:'/api/simulated/inbound', payload:{ text:'Ayam 1 ctn', externalMessageId:'production-no-legacy' } });
    assert.notEqual(response.statusCode, 200);
    assert.equal((service.database.db.prepare("SELECT count(*) n FROM messages WHERE external_message_id='production-no-legacy'").get() as any).n, 0);
  } finally {
    await app.close();
    if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old;
  }
});

test('staff writes require server-issued session and double-confirm evidence', async () => {
  const { app } = createApp({ dbFilename: ':memory:', staffBootstrapCredential:'test-only-high-entropy-bootstrap', semanticAgentFactory:scriptedSemanticAgentFactory([goldenOffer(),prepareQuote,acceptQuote]) });
  await app.ready();
  try {
    await app.inject({method:'POST',url:'/api/reset',headers:{authorization:'Bearer test-only-high-entropy-bootstrap'}});
    for (const text of ['Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?','Yes please.','OK confirm.']) {
      const r=await app.inject({method:'POST',url:'/api/simulated/inbound',payload:{text}}); assert.equal(r.statusCode,200);
    }
    const state=await app.inject({method:'GET',url:'/api/state'}); assert.equal(state.json().so.status,'DRAFT');
    const forged=await app.inject({method:'POST',url:'/api/staff/post',payload:{capability:'demo-staff-capability',idempotencyKey:'forged',doubleConfirmationEvidence:'forged'}}); assert.equal(forged.statusCode,401);
    const unauthenticated=await app.inject({method:'POST',url:'/api/staff/session'}); assert.equal(unauthenticated.statusCode,401);
    const login=await app.inject({method:'POST',url:'/api/staff/session',headers:{authorization:'Bearer test-only-high-entropy-bootstrap'}}); assert.equal(login.statusCode,200); const cookie=String(login.headers['set-cookie']).split(';')[0]; assert.match(String(login.headers['set-cookie']),/HttpOnly/);
    const missing=await app.inject({method:'POST',url:'/api/staff/post',headers:{cookie},payload:{salesOrderNo:'SO-000052',idempotencyKey:'missing-evidence'}}); assert.equal(missing.statusCode,400); assert.equal(missing.json().error,'DOUBLE_CONFIRMATION_REQUIRED');
    const post=await app.inject({method:'POST',url:'/api/staff/post',headers:{cookie},payload:{salesOrderNo:'SO-000052',idempotencyKey:'post-1',doubleConfirmationEvidence:'Customer reconfirmed by WhatsApp'}}); assert.equal(post.statusCode,200); assert.equal(post.json().status,'POSTED');
  } finally { await app.close(); }
});

test('authenticated staff route requires an explicit Sales Order target', async () => {
  const { app } = createApp({ dbFilename: ':memory:', staffBootstrapCredential:'test-only-high-entropy-bootstrap', semanticAgentFactory:scriptedSemanticAgentFactory([goldenOffer(),prepareQuote,acceptQuote]) }); await app.ready();
  try {
    await app.inject({method:'POST',url:'/api/reset',headers:{authorization:'Bearer test-only-high-entropy-bootstrap'}});
    for (const text of ['Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?','Yes please.','OK confirm.']) await app.inject({method:'POST',url:'/api/simulated/inbound',payload:{text}});
    const login=await app.inject({method:'POST',url:'/api/staff/session',headers:{authorization:'Bearer test-only-high-entropy-bootstrap'}});const cookie=String(login.headers['set-cookie']).split(';')[0];
    const untargeted=await app.inject({method:'POST',url:'/api/staff/post',headers:{cookie},payload:{idempotencyKey:'no-target',doubleConfirmationEvidence:'Customer reconfirmed'}});
    assert.equal(untargeted.statusCode,400);assert.equal(untargeted.json().error,'SALES_ORDER_REQUIRED');
    const wrong=await app.inject({method:'POST',url:'/api/staff/post',headers:{cookie},payload:{salesOrderNo:'SO-999999',idempotencyKey:'wrong-target',doubleConfirmationEvidence:'Customer reconfirmed'}});
    assert.equal(wrong.statusCode,400);assert.equal(wrong.json().error,'NO_DRAFT');
    const state=await app.inject({method:'GET',url:'/api/state'});assert.equal(state.json().so.status,'DRAFT');
  } finally { await app.close(); }
});

test('staff bootstrap is fail-closed and detailed rollout telemetry is session-gated', async () => {
  const { app } = createApp({ dbFilename: ':memory:' }); await app.ready();
  try {
    assert.equal((await app.inject({method:'POST',url:'/api/staff/session'})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/staff/session',headers:{authorization:'Bearer wrong'}})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/reset'})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/reset',headers:{authorization:'Bearer wrong'}})).statusCode,401);
    assert.equal((await app.inject({method:'GET',url:'/api/state'})).json().rollout.detail,'STAFF_SESSION_REQUIRED');
  } finally { await app.close(); }
});

test('agent trace API is operator-safe and available even before endpoint calls', async () => {
  const { app } = createApp({ dbFilename: ':memory:' }); await app.ready();
  try {
    const response=await app.inject({method:'GET',url:'/api/agent-trace'});assert.equal(response.statusCode,200);
    const trace=response.json();assert.ok(Array.isArray(trace.turns));assert.ok(Array.isArray(trace.endpointCalls));assert.ok(Array.isArray(trace.actions));
    assert.match(trace.privacyNotice,/Private chain-of-thought is not stored or exposed/);
    assert.doesNotMatch(JSON.stringify(trace),/Authorization|dmo_[A-Za-z0-9]/);
  } finally { await app.close(); }
});
