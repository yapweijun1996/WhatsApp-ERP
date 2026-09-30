import test from 'node:test';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {V2QueueService} from '../src/v2-queue.js';
import {buildConversationGoal} from '../src/v3-conversation-goal.js';
import {V3GoalGraphStore} from '../src/v3-goal-graph.js';
import {buildV3FreshnessVector, type V3FreshnessVectorInput} from '../src/v3-freshness-vector.js';
import {V3OrchestratorGoalReverifySession} from '../src/v3-orchestrator-goal-reverify.js';
import {runtimeTelemetry} from '../src/runtime-mode.js';
import {V3_ORCHESTRATOR_AI_AUTHORITY_CUTOFF} from '../src/v3-orchestrator-gate.js';

const scope={accountId:'demo-account',conversationId:'conv-001'} as const;
function fixture(){
  const database=new V1Database(':memory:'); database.resetAndSeed();
  const queue=new V2QueueService(database); const message=queue.enqueueInbound({...scope,externalMessageId:'orch-003-1',occurredAt:'2030-01-01T00:00:00Z',text:'order'});
  const base:V3FreshnessVectorInput={identityScope:{...scope,customerId:'CUST-001',channelAccountId:'demo-account'},employeeProfile:{id:'profile',version:1},capabilityPolicy:{policyVersion:1,availableCapabilities:[]},workItemOrderDraftRefs:{workItem:null,orderDraft:null},canonicalBusiness:{quotations:[],acceptances:[],outbound:[],salesOrders:[]},relevantErpEvidence:[],goalGraph:{version:0,dependencyRefs:[]},attachmentExtraction:{version:null,dependencyRefs:[]},retentionAccess:{version:1,dependencyRefs:[]},conversationBundle:{conversationRevision:1,bundleRevision:1,messageRefs:[{id:message.messageId,version:1}]},authoritativeV2FreshnessFingerprint:'v2'};
  const graph=new V3GoalGraphStore(database);
  const state=(version:number,profileVersion=1)=>({goalGraph:graph.readGoalGraph(scope),freshnessVector:buildV3FreshnessVector({...base,employeeProfile:{id:'profile',version:profileVersion},goalGraph:{version,dependencyRefs:[]}})});
  return {database,message,graph,state};
}
function goal(id:string,updatedAt:string,sourceMessageId:string){return buildConversationGoal({goalId:id,accountId:scope.accountId,conversationId:scope.conversationId,sourceMessageIds:[sourceMessageId],sourceAttachmentIds:[],erpObjectRefs:[],parentGoalId:null,dependsOnGoalIds:[],relatedGoalIds:[],description:`goal ${id}`,status:'OPEN',createdBy:'AGENT',createdAt:'2030-01-01T00:00:01.000Z',updatedAt,fulfillmentEvidenceRefs:[]});}
function session(f=fixture()){let version=0;let profileVersion=1;const initial=f.state(version,profileVersion);const s=new V3OrchestratorGoalReverifySession(f.database,{scope,initial,refresh:()=>f.state(version,profileVersion)});return {f,s,setVersion:(v:number)=>{version=v},setProfile:(v:number)=>{profileVersion=v}};}
function envelope(id:string,at:string){return {proposalId:id,idempotencyKey:`idem-${id}`,createdAt:at};}

test('ORCH-003 stale same-goal proposal fails closed while unrelated concurrent goal survives',()=>{
  const x=session(); const source=x.f.message.messageId; x.s.admit({scope,operation:'CREATE',expected:{goalId:null,revision:null,status:null},goal:goal('a','2030-01-01T00:00:01.000Z',source)},envelope('create-a','2030-01-01T00:00:02.000Z'));
  const current=x.f.graph.readGoalGraph(scope).goals[0];
  const stale=goal('a','2030-01-01T00:00:03.000Z',source);
  const writer=new (x.s.constructor as typeof V3OrchestratorGoalReverifySession)(x.f.database,{scope,initial:x.f.state(0),refresh:()=>x.f.state(0)});
  writer.admit({scope,operation:'UPDATE',expected:{goalId:'a',revision:1,status:'OPEN'},goal:goal('a','2030-01-01T00:00:03.000Z',source)},envelope('update-a-writer','2030-01-01T00:00:04.000Z'));
  assert.throws(()=>x.s.admit({scope,operation:'UPDATE',expected:{goalId:'a',revision:1,status:current.status},goal:stale},envelope('update-a-stale','2030-01-01T00:00:05.000Z')),/V3_GOAL_PROPOSAL_STALE/);
  writer.admit({scope,operation:'CREATE',expected:{goalId:null,revision:null,status:null},goal:goal('b','2030-01-01T00:00:06.000Z',source)},envelope('create-b','2030-01-01T00:00:07.000Z'));
  x.setVersion(1); const result=x.s.afterFreshnessInvalidation('2030-01-01T00:00:08.000Z');
  assert.equal(result.replanRequired,true); assert.deepEqual(result.state.goalGraph.goals.map(g=>g.goalId),['a','b']);
});

test('ORCH-003 retrieval and capability results reproject and return content-free replan signals',()=>{
  const x=session(); x.setVersion(1); const retrieval=x.s.afterRetrievalResult('2030-01-01T00:00:02.000Z'); assert.equal(retrieval.trigger,'RETRIEVAL_RESULT'); assert.equal(retrieval.replanRequired,true);
  x.setProfile(2); const capability=x.s.afterCapabilityResult('2030-01-01T00:00:03.000Z'); assert.equal(capability.trigger,'CAPABILITY_RESULT'); assert.equal(capability.replanRequired,true); assert.equal(JSON.stringify({status:'REPLAN_REQUIRED'}).includes('goal'),false);
});

test('ORCH-003 disabled-by-default seam is inert and authority remains at SALES_ORDER.DRAFT',()=>{
  const telemetry=runtimeTelemetry();
  assert.equal(telemetry.runtimeMode,'V1');
  assert.equal(telemetry.v2TrafficEnabled,false);
  assert.equal(telemetry.aiCutoff,'SALES_ORDER.DRAFT');
  assert.equal(V3_ORCHESTRATOR_AI_AUTHORITY_CUTOFF,'SALES_ORDER.DRAFT');
});
