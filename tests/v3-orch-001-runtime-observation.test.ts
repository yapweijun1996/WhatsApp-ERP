import test from 'node:test';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {V2QueueService} from '../src/v2-queue.js';
import {buildInboundBundle} from '../src/v3-inbound-bundle.js';
import {buildV3FreshnessVector, type V3FreshnessVectorInput} from '../src/v3-freshness-vector.js';
import {projectV3OrchestratorObservation} from '../src/v3-orchestrator-observation.js';

const scope = {accountId:'demo-account', conversationId:'conv-001'} as const;
function fixture() {
  const database = new V1Database(':memory:'); database.resetAndSeed(); const queue = new V2QueueService(database);
  const message = queue.enqueueInbound({...scope, externalMessageId:'orch-1', occurredAt:'2030-01-01T00:00:00Z', text:'hello'});
  const bundle = buildInboundBundle(database.db, {...scope, messageIds:[message.messageId], bundleRevision:1, hardCapAt:'2030-01-01T00:00:02Z', closedAt:'2030-01-01T00:00:01Z', closeReason:'QUIET_WINDOW'});
  const input: V3FreshnessVectorInput = {identityScope:{...scope,customerId:'CUST-001',channelAccountId:'demo-account'}, employeeProfile:{id:'profile',version:1}, capabilityPolicy:{policyVersion:1,availableCapabilities:[]}, workItemOrderDraftRefs:{workItem:null,orderDraft:null}, canonicalBusiness:{quotations:[],acceptances:[],outbound:[],salesOrders:[]}, relevantErpEvidence:[], goalGraph:{version:null,dependencyRefs:[]}, attachmentExtraction:{version:null,dependencyRefs:[]}, retentionAccess:{version:1,dependencyRefs:[]}, conversationBundle:{conversationRevision:1,bundleRevision:1,messageRefs:[{id:message.messageId,version:1}]}, authoritativeV2FreshnessFingerprint:'v2'};
  return {database,bundle,vector:buildV3FreshnessVector(input)};
}
function data() { const f=fixture(); return {...f, value:{scope, inboundBundle:f.bundle, goalGraph:{scope,goals:[],edges:[]}, freshnessVector:f.vector, retrievalCapabilities:[{name:'conversation_recent',contractVersion:'V3-RET-004',readOnly:true as const}]}}; }

test('ORCH-001 projects bounded immutable metadata without executable retrieval tools',()=>{
  const {value}=data(), out=projectV3OrchestratorObservation(value);
  assert.equal(out.inboundBundle.bundleId, value.inboundBundle.bundleId); assert.equal(out.freshness.vectorHash, value.freshnessVector.vectorHash);
  assert.deepEqual(out.retrievalCapabilities,[{name:'conversation_recent',contractVersion:'V3-RET-004',readOnly:true}]);
  assert.equal(Object.isFrozen(out),true); assert.equal(Object.isFrozen(out.inboundBundle),true); assert.throws(()=>((out.retrievalCapabilities as any).push({name:'create_order_draft'})),TypeError);
});
test('ORCH-001 fails closed on cross-scope or malformed V3 content',()=>{
  const {value}=data(); assert.throws(()=>projectV3OrchestratorObservation({...value,scope:{accountId:'other',conversationId:scope.conversationId}}),/BUNDLE_SCOPE/);
  assert.throws(()=>projectV3OrchestratorObservation({...value,retrievalCapabilities:[{name:'conversation_recent',contractVersion:'x',readOnly:false as const}]}),/RETRIEVAL_DESCRIPTOR/);
  assert.throws(()=>projectV3OrchestratorObservation({...value,goalGraph:{scope:{accountId:'other',conversationId:scope.conversationId},goals:[],edges:[]}}),/GOAL_GRAPH_SCOPE/);
});
test('ORCH-001 retrieval descriptors are names-only metadata and cannot widen V2 authority',()=>{
  const {value}=data(); const out=projectV3OrchestratorObservation(value) as any;
  assert.equal('execute' in out.retrievalCapabilities[0],false); assert.equal('inputSchema' in out.retrievalCapabilities[0],false); assert.equal(out.aiAuthorityCutoff,'SALES_ORDER.DRAFT');
  assert.throws(()=>projectV3OrchestratorObservation({...value,retrievalCapabilities:[{name:'create_order_draft',contractVersion:'v1',readOnly:true as const}]}),/RETRIEVAL_DESCRIPTOR/);
});
