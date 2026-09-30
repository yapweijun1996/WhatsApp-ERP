import test from 'node:test';
import assert from 'node:assert/strict';
import { V1Database } from '../src/database.js';
import { AgentTurnCoordinator } from '../src/v2-agent-turn-coordinator.js';
import { AgentEndpointTraceRecorder, projectAgentTrace, traceRequestBody, traceResponseBody } from '../src/v2-agent-observability.js';

const A='demo-account',C='conv-001',U='CUST-001',P='sales-digital-employee';
function fixture(){const d=new V1Database(':memory:');d.resetAndSeed();d.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES('trace-in',?,'trace-ext','INBOUND','text','same as last week',?,'2026-09-11T12:00:00Z')").run(C,A);return d}
const start={accountId:A,conversationId:C,inboundMessageId:'trace-in',profileId:P,nowIso:'2026-09-11T20:00:00+08:00',timezone:'Asia/Singapore'} as const;

test('agent endpoint trace exposes sanitized endpoint I/O and durable action evidence without private reasoning or secrets',()=>{
  const d=fixture(),coordinator=new AgentTurnCoordinator(d),turn=coordinator.start(start),recorder=new AgentEndpointTraceRecorder(d.db);
  const attemptSequence=coordinator.reserveModelAttempt({turnId:turn.turnId,kind:'MODEL',reasonCode:'PI_TRANSPORT_MODEL_TURN',observationHash:'obs',projectionHash:'proj'});
  const prompt=JSON.stringify({expected:{turnId:turn.turnId,sequence:1},workflowState:{phase:'ORDER_HISTORY_REQUIRED',requiredCapability:'get_order_history'},observation:{context:{phone:'+6599999999',authorization:'Bearer dmo_abcdef123456'}}});
  const response={text:JSON.stringify({protocolVersion:'v1',kind:'tool_call',name:'get_order_history',arguments:{accountId:A,conversationId:C,customerId:U}}),responseId:'resp-safe',usage:{inputTokens:120,outputTokens:30,totalTokens:150}};
  recorder.record({turnId:turn.turnId,attemptSequence,attemptKind:'MODEL',endpoint:'https://gpt.example/demo/v1/responses',model:'demo-fast',requestBody:traceRequestBody('demo-fast',prompt),responseBody:traceResponseBody(response),status:'SUCCEEDED',latencyMs:321,inputTokens:120,outputTokens:30,totalTokens:150});
  const action=coordinator.propose({turnId:turn.turnId,sequence:1,capabilityName:'get_order_history',capabilityVersion:'v1',arguments:{accountId:A,conversationId:C,customerId:U}} as any);const actionId=(action.actions[0] as any).id;
  coordinator.recordResult({turnId:turn.turnId,actionId,sequence:1,result:{status:'SUCCEEDED',data:{orders:[{id:'so-1',salesOrderNo:'SO-000001'}]},evidence:[],stateChanges:[]}});
  const trace=projectAgentTrace(d.db,A,C) as any,serialized=JSON.stringify(trace);
  assert.equal(trace.endpointCalls.length,1);assert.equal(trace.endpointCalls[0].model,'demo-fast');assert.equal(trace.endpointCalls[0].usage.totalTokens,150);assert.equal(trace.endpointCalls[0].latencyMs,321);
  assert.match(trace.endpointCalls[0].decisionSummary,/ORDER_HISTORY_REQUIRED.*get_order_history/);
  assert.equal(trace.actions[0].capability,'get_order_history');assert.equal(trace.actions[0].result.status,'SUCCEEDED');
  assert.doesNotMatch(serialized,/dmo_abcdef123456|6599999999|Bearer dmo_/);assert.match(serialized,/\[REDACTED\]/);
  assert.match(trace.privacyNotice,/Private chain-of-thought is not stored or exposed/);
  assert.throws(()=>d.db.prepare("UPDATE agent_endpoint_traces SET model='x'").run(),/IMMUTABLE_AGENT_ENDPOINT_TRACE/);
  assert.throws(()=>d.db.prepare('DELETE FROM agent_endpoint_traces').run(),/IMMUTABLE_AGENT_ENDPOINT_TRACE/);
  d.resetAndSeed();assert.equal((d.db.prepare('SELECT count(*) n FROM agent_endpoint_traces').get() as any).n,0);
});

test('failed endpoint calls remain bounded and sanitized',()=>{
  const d=fixture(),coordinator=new AgentTurnCoordinator(d),turn=coordinator.start(start),recorder=new AgentEndpointTraceRecorder(d.db);
  const sequence=coordinator.reserveModelAttempt({turnId:turn.turnId,kind:'MODEL',reasonCode:'PI_TRANSPORT_MODEL_TURN'});
  recorder.record({turnId:turn.turnId,attemptSequence:sequence,attemptKind:'MODEL',endpoint:'https://gpt.example/demo/v1/responses',model:'demo-fast',requestBody:{model:'demo-fast',input:{token:'dmo_should_not_escape'}},status:'FAILED',errorCode:'Authorization: Bearer dmo_should_not_escape',latencyMs:9});
  const trace=projectAgentTrace(d.db,A,C) as any,serialized=JSON.stringify(trace);assert.equal(trace.endpointCalls[0].status,'FAILED');assert.equal(trace.endpointCalls[0].errorCode,'MODEL_ENDPOINT_FAILED');assert.doesNotMatch(serialized,/dmo_should_not_escape/);
});
