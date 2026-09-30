import assert from 'node:assert/strict';
import {test} from 'node:test';
import {V1Database} from '../src/database.js';
import {V3GoalGraphStore} from '../src/v3-goal-graph.js';
import {V3GoalProposalHost} from '../src/v3-goal-proposal.js';
import {buildConversationGoal} from '../src/v3-conversation-goal.js';
import {V3DurableContinuationStore, buildV3DurableContinuation, v3FreshnessVectorRef, v3ResumeConditionRef, type V3ContinuationHostCondition} from '../src/v3-durable-continuation.js';
import {buildV3FreshnessVectorFromDatabase, type V3FreshnessVectorInput} from '../src/v3-freshness-vector.js';
import {validateGroundedResponsePlan, type GroundedResponsePlan} from '../src/v2-grounded-response-plan.js';
import {validateV3FulfillmentGate} from '../src/v3-fulfillment-gate.js';

const scope={accountId:'demo-account',conversationId:'conv-001'} as const;
const now='2026-09-20T00:00:00.000Z';
const condition=(trigger:'EXTERNAL_EVENT'|'NEW_INBOUND'='EXTERNAL_EVENT'):V3ContinuationHostCondition=>({accountId:scope.accountId,conversationId:scope.conversationId,resumeTriggerType:trigger,condition:'ful-006'});
function freshnessInput():Omit<V3FreshnessVectorInput,'authoritativeV2FreshnessFingerprint'>{return {identityScope:{accountId:scope.accountId,conversationId:scope.conversationId,customerId:'CUST-001',channelAccountId:scope.accountId},employeeProfile:{id:'sales-digital-employee',version:1},capabilityPolicy:{policyVersion:1,availableCapabilities:[]},workItemOrderDraftRefs:{workItem:null,orderDraft:null},canonicalBusiness:{quotations:[],acceptances:[],outbound:[],salesOrders:[]},relevantErpEvidence:[],goalGraph:{version:null,dependencyRefs:[]},attachmentExtraction:{version:null,dependencyRefs:[]},retentionAccess:{version:1,dependencyRefs:[]},conversationBundle:{conversationRevision:0,bundleRevision:0,messageRefs:[]}}}
function fixture(status:'WAITING_EXTERNAL'|'OPEN'|'IN_PROGRESS'='OPEN'){
  const database=new V1Database(':memory:'); database.resetAndSeed();
  database.db.prepare("INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,sender_external_id,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)").run('m-006',scope.conversationId,'m-006','INBOUND','TEXT','opaque','customer',scope.accountId,now);
  database.db.prepare("INSERT INTO work_items(id,account_id,conversation_id,customer_id,type,state,revision,goal_summary,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('wi-006',scope.accountId,scope.conversationId,'CUST-001','SALES_ORDER_REQUEST','DRAFTING',1,'goal','m-006',now,now);
  const host=new V3GoalProposalHost(database); const initial=buildConversationGoal({goalId:'goal-006',...scope,sourceMessageIds:['m-006'],sourceAttachmentIds:[],erpObjectRefs:[],parentGoalId:null,dependsOnGoalIds:[],relatedGoalIds:[],description:'goal',status:'OPEN',createdBy:'AGENT',createdAt:now,updatedAt:now,fulfillmentEvidenceRefs:[]});
  host.admit({scope,operation:'CREATE',expected:{goalId:null,revision:null,status:null},goal:initial},{proposalId:'p-006',idempotencyKey:'p-006',createdAt:now});
  if(status!=='OPEN') host.admit({scope,operation:'UPDATE',expected:{goalId:'goal-006',revision:1,status:'OPEN'},goal:{...initial,status,updatedAt:'2026-09-20T00:00:01.000Z'}},{proposalId:`p-${status}`,idempotencyKey:`p-${status}`,createdAt:'2026-09-20T00:00:01.000Z'});
  return {database,graph:new V3GoalGraphStore(database),store:new V3DurableContinuationStore(database),host};
}
function continuation(f:ReturnType<typeof fixture>,disposition:'WAITING_EXTERNAL'|'STILL_IN_PROGRESS'){
  const c=condition(disposition==='WAITING_EXTERNAL'?'EXTERNAL_EVENT':'NEW_INBOUND'); const vector=buildV3FreshnessVectorFromDatabase(f.database.db,freshnessInput());
  return buildV3DurableContinuation({continuationId:`c-${disposition}`,workItemId:'wi-006',goalId:'goal-006',...scope,disposition,ownerType:'HOST',ownerId:'ful-006',state:disposition==='WAITING_EXTERNAL'?'WAITING':'READY',resumeTriggerType:c.resumeTriggerType,resumeConditionRef:v3ResumeConditionRef(c),nextEligibleAt:null,deadlineAt:null,expectedFreshnessVectorRef:v3FreshnessVectorRef(vector),lastEvidenceRefs:[],lastEffectRefs:[],attempt:0,budgetState:{maxAttempts:3,consumed:0,deadlineAt:null},idempotencyKey:`c-${disposition}`,createdAt:'2026-09-20T00:00:02.000Z',updatedAt:'2026-09-20T00:00:02.000Z'});
}
function plan(disposition:'WAITING_EXTERNAL'|'STILL_IN_PROGRESS',continuationRef:string|undefined):GroundedResponsePlan{return validateGroundedResponsePlan({turnId:'ful-006-turn',intent:'ANSWER',connectiveText:'I can help.',factClaims:[],outboundPurpose:'customer_reply',goalDispositions:[{goalId:'goal-006',disposition,capabilityEvidenceRefs:[],groundingRefs:[],...(continuationRef===undefined?{}:{continuationRef})}]},'ful-006-turn');}
function admit(f:ReturnType<typeof fixture>,p:GroundedResponsePlan){return validateV3FulfillmentGate({goalGraphStore:f.graph,continuationStore:f.store,scope,plan:p});}

test('FUL-006 admits structurally resolved WAITING_EXTERNAL and STILL_IN_PROGRESS continuations',()=>{
  for(const disposition of ['WAITING_EXTERNAL','STILL_IN_PROGRESS'] as const){const f=fixture(disposition==='WAITING_EXTERNAL'?'WAITING_EXTERNAL':'OPEN');const value=continuation(f,disposition);f.store.create(value,buildV3FreshnessVectorFromDatabase(f.database.db,freshnessInput()),condition(disposition==='WAITING_EXTERNAL'?'EXTERNAL_EVENT':'NEW_INBOUND'));assert.doesNotThrow(()=>admit(f,plan(disposition,value.continuationId)));f.database.db.close();}
});

test('FUL-006 rejects missing, mismatched, and cross-scope continuation references',()=>{
  const missing=fixture(); assert.throws(()=>admit(missing,plan('STILL_IN_PROGRESS',undefined)),/CONTINUATION_INVALID|CONTINUATION_STORE_REQUIRED|CONTINUATION_REQUIRED/); missing.database.db.close();
  const f=fixture(); const value=continuation(f,'STILL_IN_PROGRESS'); f.store.create(value,buildV3FreshnessVectorFromDatabase(f.database.db,freshnessInput()),condition('NEW_INBOUND'));
  assert.throws(()=>validateV3FulfillmentGate({goalGraphStore:f.graph,scope,plan:plan('STILL_IN_PROGRESS',value.continuationId)}),/CONTINUATION_STORE_REQUIRED/);
  assert.throws(()=>admit(f,plan('WAITING_EXTERNAL',value.continuationId)),/CONTINUATION_INVALID/);
  assert.throws(()=>validateV3FulfillmentGate({goalGraphStore:f.graph,continuationStore:f.store,scope:{...scope,accountId:'other'},plan:plan('STILL_IN_PROGRESS',value.continuationId)}),/V3_GOAL_GRAPH_SCOPE/); f.database.db.close();
});

test('FUL-006 rejects stale active-work and terminal-goal structure without inspecting wording',()=>{
  const f=fixture(); const value=continuation(f,'STILL_IN_PROGRESS'); f.store.create(value,buildV3FreshnessVectorFromDatabase(f.database.db,freshnessInput()),condition('NEW_INBOUND'));
  f.database.db.prepare("UPDATE work_items SET state='COMPLETED' WHERE id='wi-006'").run(); assert.throws(()=>admit(f,plan('STILL_IN_PROGRESS',value.continuationId)),/CONTINUATION_INVALID/); f.database.db.close();
  const terminal=fixture(); const terminalValue=continuation(terminal,'STILL_IN_PROGRESS'); terminal.store.create(terminalValue,buildV3FreshnessVectorFromDatabase(terminal.database.db,freshnessInput()),condition('NEW_INBOUND')); const current=terminal.graph.readGoalGraph(scope).goals[0]!; terminal.host.admit({scope,operation:'CANCEL',expected:{goalId:'goal-006',revision:1,status:'OPEN'},goal:{...current,status:'CANCELLED',updatedAt:'2026-09-20T00:00:01.000Z'}},{proposalId:'p-cancel',idempotencyKey:'p-cancel',createdAt:'2026-09-20T00:00:01.000Z'}); assert.throws(()=>admit(terminal,plan('STILL_IN_PROGRESS',terminalValue.continuationId)),/TERMINAL_GOAL_DISPOSITION|CONTINUATION_INVALID/); terminal.database.db.close();
});
