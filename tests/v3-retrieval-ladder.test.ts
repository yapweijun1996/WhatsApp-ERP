import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {V1Database} from '../src/database.js';
import {V2QueueService} from '../src/v2-queue.js';
import {AgentTurnCoordinator} from '../src/v2-agent-turn-coordinator.js';
import {buildInboundBundle} from '../src/v3-inbound-bundle.js';
import {buildV3ConversationMemory, type ConversationMemoryDerivationProposal} from '../src/v3-conversation-memory.js';
import {buildV3RetrievalIndexes,createV3RetrievalHostAuthority} from '../src/v3-retrieval-index.js';
import {buildConversationGoal} from '../src/v3-conversation-goal.js';
import {V3GoalGraphStore} from '../src/v3-goal-graph.js';
import {createV3RetrievalLadderTools,V3_RETRIEVAL_LADDER_LAYERS,V3_RETRIEVAL_LADDER_TOOL_NAMES,type V3ConversationGoalListRequest} from '../src/v3-retrieval-ladder.js';

const A='demo-account',C='conv-001',K='CUST-001';
const LADDER_INVALID=/V3_RETRIEVAL_LADDER_INVALID/;
const LADDER_UNAVAILABLE=/^Error: V3_RETRIEVAL_LADDER_UNAVAILABLE$/;
const RET3_SCOPE=/^Error: V3_RETRIEVAL_SCOPE_UNAVAILABLE$/;

type Fixture=ReturnType<typeof fixture>;
function appendGoal(f:Omit<Fixture,'tools'>,input:{goalId:string;description:string;messageId:string;attachmentIds?:string[];objectId:string;objectType?:string}){
  const goal=buildConversationGoal({goalId:input.goalId,accountId:A,conversationId:C,sourceMessageIds:[input.messageId],sourceAttachmentIds:input.attachmentIds??[],erpObjectRefs:[{objectType:input.objectType??'WORK_ITEM',objectId:input.objectId,accountId:A,conversationId:C}],parentGoalId:null,dependsOnGoalIds:[],relatedGoalIds:[],description:input.description,status:'OPEN',createdBy:'AGENT',createdAt:'2026-09-17T00:00:00.000Z',updatedAt:'2026-09-17T00:00:00.000Z',fulfillmentEvidenceRefs:[]});
  new V3GoalGraphStore(f.db).appendGoalEvent({scope:{accountId:A,conversationId:C},eventId:`ev-${input.goalId}`,goal,eventType:'CREATED',idempotencyKey:`idem-${input.goalId}`,createdAt:'2026-09-17T00:00:00.000Z'});
  return goal;
}
function fixture(){
  const db=new V1Database(':memory:');db.resetAndSeed();const queue=new V2QueueService(db);
  const first=queue.enqueueInbound({accountId:A,conversationId:C,externalMessageId:'ret5-a',occurredAt:'2026-09-16T23:59:00Z',text:'amber current request',rawRef:'authorized://attachment/red-photo'});
  const second=queue.enqueueInbound({accountId:A,conversationId:C,externalMessageId:'ret5-b',occurredAt:'2026-09-17T00:00:00Z',text:'violet current detail'});
  db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,reply_to_external_message_id,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)').run('m-history',C,'hist-1','OUTBOUND','text','historical amber context',null,A,'2026-09-10T00:00:00Z');
  const bundle=buildInboundBundle(db.db,{accountId:A,conversationId:C,messageIds:[first.messageId,second.messageId],bundleRevision:2,hardCapAt:'2026-09-17T00:00:03Z',closedAt:'2026-09-17T00:00:01Z',closeReason:'QUIET_WINDOW'});
  const proposal:ConversationMemoryDerivationProposal={sections:[{id:'s-history',title:'Historical',topic:'amber archive',summary:'older derived context',sourceMessageIds:['m-history']},{id:'s-current',title:'Current',topic:'current details',summary:'newer derived context',sourceMessageIds:[first.messageId,second.messageId]}],rollingMemory:{text:'derived continuity',sourceMessageIds:['m-history',first.messageId,second.messageId],sectionIds:['s-history','s-current']}};
  const memory=buildV3ConversationMemory(db.db,{accountId:A,conversationId:C,proposal});
  const turn=new AgentTurnCoordinator(db).start({accountId:A,conversationId:C,inboundMessageId:first.messageId,timezone:'UTC',nowIso:'2026-09-17T00:00:00Z'}),authority=createV3RetrievalHostAuthority(db.db,{subject:'ret5-host',tenantId:'tenant-ret5',channelAccountId:A}),token=authority.issue(turn.turnId);
  db.db.prepare("INSERT INTO work_items(id,account_id,conversation_id,customer_id,type,state,revision,goal_summary,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('wi-main',A,C,K,'SALES_ORDER_REQUEST','DRAFTING',1,'amber work',first.messageId,'2026-09-17T00:00:00Z','2026-09-17T00:00:00Z');
  db.db.prepare("INSERT INTO order_drafts(id,work_item_id,account_id,conversation_id,customer_id,status,current_revision,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,'CURRENT',?,?,?,?)").run('draft-other','wi-main',A,C,K,1,second.messageId,'2026-09-17T00:00:00Z','2026-09-17T00:00:00Z');
  const index=buildV3RetrievalIndexes(db.db,authority,token,{memory});
  const base={db,queue,first,second,bundle,memory,turn,authority,token,index};
  appendGoal(base as any,{goalId:'goal-main',description:'amber history objective',messageId:first.messageId,attachmentIds:[`raw-ref:${first.messageId}`],objectId:'wi-main'});
  appendGoal(base as any,{goalId:'goal-other',description:'violet followup objective',messageId:second.messageId,objectId:'draft-other',objectType:'ORDER_DRAFT'});
  const tools=createV3RetrievalLadderTools(db,authority,token,index,memory,bundle);
  return {...base,tools};
}
function layer(f:Fixture,name:typeof V3_RETRIEVAL_LADDER_LAYERS[number],extra:Record<string,unknown>={}){return f.tools.conversation_retrieval_ladder({layer:name,...extra} as any)}

test('RET-005 exposes exactly three shadow retrieval capabilities and the seven-layer order',()=>{
  const f=fixture();
  assert.deepEqual([...V3_RETRIEVAL_LADDER_TOOL_NAMES],['conversation_goal_list','conversation_business_objects','conversation_retrieval_ladder']);
  assert.deepEqual([...V3_RETRIEVAL_LADDER_LAYERS],['CURRENT_BUNDLE','RECENT_RAW','GOALS','SECTIONS','RAW_HISTORY','ATTACHMENTS','HISTORICAL_ERP']);
  const result=layer(f,'CURRENT_BUNDLE');
  assert.equal(result.contractVersion,'V3-RET-005');assert.equal(result.authority,'NON_AUTHORITATIVE_DERIVED');assert.equal(result.grantsEffects,false);assert.equal(result.aiAuthorityCutoff,'SALES_ORDER.DRAFT');assert.equal(result.requiresCurrentErpReverificationBeforeConsequentialDecision,true);assert.equal(result.currentTruthOwner,'EXISTING_CANONICAL_HOST_CAPABILITIES');assert.deepEqual(result.progressiveOrder,[...V3_RETRIEVAL_LADDER_LAYERS]);
  assert.equal(result.result.layer,'CURRENT_BUNDLE');assert.equal(result.result.depth,0);assert.equal(result.result.nextDeeperLayer,'RECENT_RAW');assert.equal(result.bundleRevision,f.bundle.bundleRevision);assert.equal(result.conversationRevisionAtBuild,f.bundle.conversationRevisionAtBuild);assert.equal(result.bundleCompletenessDerivation,'V2_RECEIPT_CP002_LATEST_COLLECTION');
});

test('RET-005 Golden progressive disclosure exposes every layer without forcing previous-layer calls',()=>{
  const f=fixture();
  const current=layer(f,'CURRENT_BUNDLE').result.payload as any;assert.deepEqual(current.messages.map((m:any)=>m.sourceMessageId),[f.first.messageId,f.second.messageId]);
  const recent=layer(f,'RECENT_RAW',{limit:2}).result.payload as any;assert.deepEqual(recent.messages.map((m:any)=>m.sourceMessageId),[f.first.messageId,f.second.messageId]);
  const goals=layer(f,'GOALS',{query:'amber'}).result.payload as any;assert.deepEqual(goals.goals.map((g:any)=>g.goalId),['goal-main']);
  const sections=layer(f,'SECTIONS',{query:'amber'}).result.payload as any;assert.deepEqual(sections.sections.map((s:any)=>s.sectionId),['s-history']);
  const raw=layer(f,'RAW_HISTORY',{query:'historical amber'}).result.payload as any;assert.equal(raw.hits[0]?.message.sourceMessageId,'m-history');assert.deepEqual(raw.hits[0]?.matchedTerms,['amber','historical']);
  const attachments=layer(f,'ATTACHMENTS',{goalId:'goal-main'}).result.payload as any;assert.deepEqual(attachments.attachments.map((a:any)=>a.attachmentId),[`raw-ref:${f.first.messageId}`]);
  const erp=layer(f,'HISTORICAL_ERP',{goalId:'goal-main'}).result.payload as any;assert.deepEqual(erp.objects.map((o:any)=>o.objectId),['wi-main']);assert.equal(erp.capabilityHandoff.capability,'get_order_history');
});

test('RET-005 current bundle and raw evidence are exact RET-003/004-reopened evidence',()=>{
  const f=fixture(),result=layer(f,'CURRENT_BUNDLE');const payload=result.result.payload as any;
  assert.deepEqual(payload.messages.map((m:any)=>m.sourceRef),[`messages/${f.first.messageId}`,`messages/${f.second.messageId}`]);
  assert.ok(payload.messages.every((m:any)=>m.citation.indexVersion===f.index.indexVersion&&m.citation.scopeVersion===f.index.scopeVersion));
  assert.deepEqual(result.scopeLineage,f.index.scope);assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(payload.messages[0]),true);
});

test('RET-005 goal list returns active current Goal Graph state with exact source links',()=>{
  const f=fixture(),all=f.tools.conversation_goal_list({}),amber=f.tools.conversation_goal_list({query:'amber'});
  assert.deepEqual(all.goals.map(g=>g.goalId),['goal-main','goal-other']);assert.deepEqual(amber.goals.map(g=>g.goalId),['goal-main']);
  assert.deepEqual(amber.goals[0]?.sourceMessageIds,[f.first.messageId]);assert.deepEqual(amber.goals[0]?.sourceRefs,[`messages/${f.first.messageId}`]);
  assert.deepEqual(amber.goals[0]?.sourceAttachmentIds,[`raw-ref:${f.first.messageId}`]);assert.equal(amber.goals[0]?.erpObjectRefs[0]?.objectId,'wi-main');assert.equal(amber.goals[0]?.erpObjectRefsAuthority,'DESCRIPTIVE_GOAL_LINKS_ONLY');
});

test('RET-005 goal-specific business-object retrieval narrows rather than widens scope',()=>{
  const f=fixture(),all=f.tools.conversation_business_objects({}),main=f.tools.conversation_business_objects({goalId:'goal-main'});
  assert.deepEqual(all.objects.map(x=>x.objectId),['draft-other','wi-main']);assert.deepEqual(main.objects.map(x=>x.objectId),['wi-main']);
  assert.equal(main.objects[0]?.source,'RET002_INDEX');assert.deepEqual(main.objects[0]?.goalIds,['goal-main']);assert.deepEqual(main.objects[0]?.sourceMessageIds,[f.first.messageId]);
  assert.equal(main.objects[0]?.historicalOnly,true);assert.equal(main.objects[0]?.requiresCurrentErpReverification,true);assert.equal(main.objects[0]?.currentTruthOwner,'EXISTING_CANONICAL_HOST_CAPABILITIES');
  assert.throws(()=>f.tools.conversation_business_objects({objectType:'UNKNOWN_ERP_TYPE'}),LADDER_UNAVAILABLE);
});

test('RET-005 attachment layer opens only existing authorized refs and grants no extraction authority',()=>{
  const f=fixture(),result=layer(f,'ATTACHMENTS',{goalId:'goal-main'}),attachment=(result.result.payload as any).attachments[0];
  assert.equal(attachment.attachmentId,`raw-ref:${f.first.messageId}`);assert.equal(attachment.sourceMessageId,f.first.messageId);assert.equal(attachment.sourceRef,'authorized://attachment/red-photo');assert.equal(attachment.messageSourceRef,`messages/${f.first.messageId}`);
  assert.equal(attachment.extractionAuthorityGranted,false);assert.equal(attachment.historicalOnly,true);assert.equal(attachment.requiresCurrentErpReverification,true);
});

test('RET-005 historical ERP is capability handoff only and cannot replace current truth',()=>{
  const f=fixture(),result=layer(f,'HISTORICAL_ERP',{goalId:'goal-main'}),payload=result.result.payload as any;
  assert.equal(result.result.truthClass,'HISTORICAL_CONTEXT_ONLY');assert.equal(result.result.historicalOnly,true);assert.equal(result.result.requiresCurrentErpReverification,true);assert.equal(result.result.currentTruthOwner,'EXISTING_CANONICAL_HOST_CAPABILITIES');
  assert.deepEqual(payload.capabilityHandoff,{capability:'get_order_history',sideEffect:'READ_ONLY',scopeOwner:'EXISTING_V2_CAPABILITY_REGISTRY',historicalOnly:true,requiresCurrentErpReverification:true,currentTruthOwner:'EXISTING_CANONICAL_HOST_CAPABILITIES'});
  const serialized=JSON.stringify(payload);for(const forbidden of ['unitPriceCents','availableBase','creditStatus','salesOrderStatus'])assert.equal(serialized.includes(forbidden),false);
});

test('RET-005 deeper historical layers always require current ERP reverification',()=>{
  const f=fixture();
  for(const [name,extra] of [['RAW_HISTORY',{query:'historical'}],['ATTACHMENTS',{goalId:'goal-main'}],['HISTORICAL_ERP',{goalId:'goal-main'}]] as const){const result=layer(f,name,extra as any);assert.equal(result.result.historicalOnly,true);assert.equal(result.result.requiresCurrentErpReverification,true);assert.equal(result.result.currentTruthOwner,'EXISTING_CANONICAL_HOST_CAPABILITIES')}
  for(const name of ['CURRENT_BUNDLE','RECENT_RAW','GOALS','SECTIONS'] as const){const extra=name==='GOALS'||name==='SECTIONS'?{query:'amber'}:{};const result=layer(f,name,extra);assert.equal(result.result.historicalOnly,false);assert.equal(result.result.requiresCurrentErpReverification,false)}
});

test('RET-005 raw history requires exactly one explicit retrieval strategy',()=>{
  const f=fixture();assert.throws(()=>layer(f,'RAW_HISTORY'),LADDER_INVALID);assert.throws(()=>layer(f,'RAW_HISTORY',{query:'amber',sectionId:'s-history'}),LADDER_INVALID);
  const section=layer(f,'RAW_HISTORY',{sectionId:'s-history'}).result.payload as any;assert.deepEqual(section.messages.map((m:any)=>m.sourceMessageId),['m-history']);
});

test('RET-005 request contracts reject scope injection, extras, accessors, benign proxies and UTF-8 overflow',()=>{
  const f=fixture();
  for(const bad of [{accountId:A},{customerId:K},{layer:'GOALS',tenantId:'x'},{layer:'GOALS',extra:true},Object.create(null),[]])assert.throws(()=>f.tools.conversation_retrieval_ladder(bad as any),LADDER_INVALID);
  const accessor={};Object.defineProperty(accessor,'query',{enumerable:true,get(){return 'amber'}});assert.throws(()=>f.tools.conversation_goal_list(accessor as any),LADDER_INVALID);
  assert.throws(()=>f.tools.conversation_goal_list(new Proxy({query:'amber'}, {}) as any),LADDER_INVALID);
  assert.throws(()=>f.tools.conversation_goal_list({query:'界'.repeat(200)}),LADDER_INVALID);assert.throws(()=>f.tools.conversation_business_objects({goalId:'界'.repeat(100)}),LADDER_INVALID);
  for(const limit of [0,51,1.5,NaN])assert.throws(()=>f.tools.conversation_goal_list({limit} as any),LADDER_INVALID);
});

test('RET-005 wrong authority/token and stale source fail before ladder evidence returns',()=>{
  {const f=fixture(),other=createV3RetrievalHostAuthority(f.db.db,{subject:'other',tenantId:'tenant-ret5',channelAccountId:A});assert.throws(()=>createV3RetrievalLadderTools(f.db,other,f.token,f.index,f.memory,f.bundle),RET3_SCOPE)}
  {const f=fixture();f.db.db.prepare('UPDATE messages SET text=? WHERE id=?').run('tampered historical','m-history');assert.throws(()=>layer(f,'RAW_HISTORY',{query:'historical'}),/INDEX_STALE|SECTION_PROVENANCE/)}
});

test('RET-005 missing goal attachment ref fails closed instead of fabricating attachment evidence',()=>{
  const f=fixture();appendGoal(f as any,{goalId:'goal-missing-att',description:'opaque',messageId:f.first.messageId,attachmentIds:['missing-attachment'],objectId:'wi-main'});
  assert.throws(()=>f.tools.conversation_goal_list({}),LADDER_UNAVAILABLE);assert.throws(()=>layer(f,'ATTACHMENTS',{goalId:'goal-missing-att'}),LADDER_UNAVAILABLE);
});

test('RET-005 reads Goal Graph at call time and binds payload to the same graph fingerprint',()=>{
  const f=fixture(),before=f.tools.conversation_goal_list({});appendGoal(f as any,{goalId:'goal-later',description:'later neutral objective',messageId:f.second.messageId,objectId:'draft-other',objectType:'ORDER_DRAFT'});const after=f.tools.conversation_goal_list({});
  assert.notEqual(before.goalGraphFingerprint,after.goalGraphFingerprint);assert.equal(after.goals.some(g=>g.goalId==='goal-later'),true);
  const ladder=layer(f,'GOALS'),nested=(ladder.result.payload as any);assert.equal(ladder.goalGraphFingerprint,nested.goalGraphFingerprint);
});

test('RET-005 per-call bounds and deterministic filtering apply to goals, objects and attachments',()=>{
  const f=fixture();assert.equal(f.tools.conversation_goal_list({limit:1}).goals.length,1);assert.equal(f.tools.conversation_business_objects({limit:1}).objects.length,1);assert.equal((layer(f,'ATTACHMENTS',{limit:1}).result.payload as any).attachments.length,1);
  assert.deepEqual(f.tools.conversation_business_objects({objectType:'WORK_ITEM',objectId:'wi-main'}).objects.map(x=>x.objectId),['wi-main']);assert.throws(()=>f.tools.conversation_business_objects({goalId:'foreign-goal'}),LADDER_UNAVAILABLE);
});

test('RET-005 is semantic-neutral and does not directly query current price/stock/status tables',()=>{
  const source=readFileSync(new URL('../src/v3-retrieval-ladder.ts',import.meta.url),'utf8');
  for(const forbidden of ['customer_prices','stock_balances','SELECT * FROM sales_orders','adapter.send(','keyword','intentRegex'])assert.equal(source.includes(forbidden),false);
  const f=fixture();assert.deepEqual(f.tools.conversation_goal_list({query:'amber'}).goals.map(g=>g.goalId),['goal-main']);assert.deepEqual(f.tools.conversation_goal_list({query:'violet'}).goals.map(g=>g.goalId),['goal-other']);
});

test('RET-005 TypeScript model requests do not expose authority scope selectors',()=>{
  const f=fixture();if(false){const request:V3ConversationGoalListRequest={
    // @ts-expect-error model-facing RET-005 request cannot select account scope.
    accountId:A,
  };f.tools.conversation_goal_list(request)}assert.ok(f.tools);
});

test('RET-005 Goal Graph ERP refs require RET-002 canonical entity corroboration',()=>{
  const f=fixture();
  const forged=buildConversationGoal({goalId:'goal-forged-object',accountId:A,conversationId:C,sourceMessageIds:[f.first.messageId],sourceAttachmentIds:[],erpObjectRefs:[{objectType:'WORK_ITEM',objectId:'missing-work-item',accountId:A,conversationId:C}],parentGoalId:null,dependsOnGoalIds:[],relatedGoalIds:[],description:'opaque forged object reference',status:'OPEN',createdBy:'AGENT',createdAt:'2026-09-17T00:00:00.000Z',updatedAt:'2026-09-17T00:00:00.000Z',fulfillmentEvidenceRefs:[]});
  new V3GoalGraphStore(f.db).appendGoalEvent({scope:{accountId:A,conversationId:C},eventId:'ev-forged-object',goal:forged,eventType:'CREATED',idempotencyKey:'idem-forged-object',createdAt:'2026-09-17T00:00:00.000Z'});
  assert.equal(f.tools.conversation_goal_list({query:'forged'}).goals[0]?.erpObjectRefsAuthority,'DESCRIPTIVE_GOAL_LINKS_ONLY');
  assert.throws(()=>f.tools.conversation_business_objects({goalId:'goal-forged-object'}),LADDER_UNAVAILABLE);
});

test('RET-005 bounds nested Goal Graph references before projecting one goal',()=>{
  const f=fixture(),refs=Array.from({length:51},(_,i)=>({objectType:'WORK_ITEM',objectId:`missing-${i}`,accountId:A,conversationId:C}));
  const oversized=buildConversationGoal({goalId:'goal-oversized',accountId:A,conversationId:C,sourceMessageIds:[f.first.messageId],sourceAttachmentIds:[],erpObjectRefs:refs,parentGoalId:null,dependsOnGoalIds:[],relatedGoalIds:[],description:'opaque oversized reference set',status:'OPEN',createdBy:'AGENT',createdAt:'2026-09-17T00:00:00.000Z',updatedAt:'2026-09-17T00:00:00.000Z',fulfillmentEvidenceRefs:[]});
  new V3GoalGraphStore(f.db).appendGoalEvent({scope:{accountId:A,conversationId:C},eventId:'ev-oversized',goal:oversized,eventType:'CREATED',idempotencyKey:'idem-oversized',createdAt:'2026-09-17T00:00:00.000Z'});
  assert.throws(()=>f.tools.conversation_goal_list({}),/V3_RETRIEVAL_LADDER_INVALID:GOAL_REF_COUNT/);
  assert.throws(()=>layer(f,'GOALS'),/V3_RETRIEVAL_LADDER_INVALID:GOAL_REF_COUNT/);
});


test('RET-005 rejects an old current-bundle projection after newer inbound arrives',()=>{
  const f=fixture();f.queue.enqueueInbound({accountId:A,conversationId:C,externalMessageId:'ret5-newer',occurredAt:'2026-09-17T00:01:00Z',text:'newer opaque input'});
  assert.throws(()=>f.tools.conversation_goal_list({}),LADDER_UNAVAILABLE);assert.throws(()=>layer(f,'CURRENT_BUNDLE'),LADDER_UNAVAILABLE);
});


test('RET-005 current bundle is never model-truncated',()=>{
  const f=fixture(),current=layer(f,'CURRENT_BUNDLE').result.payload as any;
  assert.deepEqual(current.messages.map((m:any)=>m.sourceMessageId),[f.first.messageId,f.second.messageId]);assert.equal(current.truncated,false);
  assert.throws(()=>layer(f,'CURRENT_BUNDLE',{limit:1}),LADDER_INVALID);
});

test('RET-005 fails safety-bound current bundles instead of silently truncating them',()=>{
  const db=new V1Database(':memory:');db.resetAndSeed();const queue=new V2QueueService(db),messageIds:string[]=[];
  for(let i=0;i<51;i++)messageIds.push(queue.enqueueInbound({accountId:A,conversationId:C,externalMessageId:`ret5-big-${i}`,occurredAt:'2026-09-17T01:00:00Z',text:`opaque ${i}`}).messageId);
  const bundle=buildInboundBundle(db.db,{accountId:A,conversationId:C,messageIds,bundleRevision:51,hardCapAt:'2026-09-17T01:00:03Z',closedAt:'2026-09-17T01:00:01Z',closeReason:'HARD_CAP'});
  const proposal:ConversationMemoryDerivationProposal={sections:[{id:'s-big',title:'Big',topic:'opaque',summary:'bounded',sourceMessageIds:messageIds}],rollingMemory:{text:'derived',sourceMessageIds:messageIds,sectionIds:['s-big']}};
  const memory=buildV3ConversationMemory(db.db,{accountId:A,conversationId:C,proposal}),turn=new AgentTurnCoordinator(db).start({accountId:A,conversationId:C,inboundMessageId:messageIds[0],timezone:'UTC',nowIso:'2026-09-17T01:00:00Z'}),authority=createV3RetrievalHostAuthority(db.db,{subject:'ret5-big',tenantId:'tenant-ret5',channelAccountId:A}),token=authority.issue(turn.turnId),index=buildV3RetrievalIndexes(db.db,authority,token,{memory});
  assert.throws(()=>createV3RetrievalLadderTools(db,authority,token,index,memory,bundle),/V3_RETRIEVAL_LADDER_INVALID:CURRENT_BUNDLE_SIZE/);
});

test('RET-005 bounds goal references nested inside one business-object candidate',()=>{
  const f=fixture();for(let i=0;i<50;i++)appendGoal(f as any,{goalId:`goal-shared-${i}`,description:`shared ${i}`,messageId:f.first.messageId,objectId:'wi-main'});
  assert.throws(()=>f.tools.conversation_business_objects({objectId:'wi-main'}),/V3_RETRIEVAL_LADDER_INVALID:OBJECT_GOAL_REF_COUNT/);
});

test('RET-005 rejects a latest-tail bundle that omits an earlier bubble from the same adaptive collection',()=>{
  const f=fixture(),incomplete=buildInboundBundle(f.db.db,{accountId:A,conversationId:C,messageIds:[f.second.messageId],bundleRevision:1,hardCapAt:'2026-09-17T00:00:03Z',closedAt:'2026-09-17T00:00:01Z',closeReason:'QUIET_WINDOW'});
  assert.throws(()=>createV3RetrievalLadderTools(f.db,f.authority,f.token,f.index,f.memory,incomplete),LADDER_UNAVAILABLE);
});

test('RET-005 rechecks Goal ERP reference scope at the consumption boundary',()=>{
  const source=readFileSync(new URL('../src/v3-retrieval-ladder.ts',import.meta.url),'utf8');
  assert.match(source,/accountId!==this\.index\.scope\.accountId/);assert.match(source,/conversationId!==this\.index\.scope\.conversationId/);
  assert.throws(()=>buildConversationGoal({goalId:'foreign-ref-goal',accountId:A,conversationId:C,sourceMessageIds:['x'],sourceAttachmentIds:[],erpObjectRefs:[{objectType:'WORK_ITEM',objectId:'wi-main',accountId:'foreign-account',conversationId:C}],parentGoalId:null,dependsOnGoalIds:[],relatedGoalIds:[],description:'scope negative',status:'OPEN',createdBy:'AGENT',createdAt:'2026-09-17T00:00:00.000Z',updatedAt:'2026-09-17T00:00:00.000Z',fulfillmentEvidenceRefs:[]}),/ERP_SCOPE/);
});

test('RET-005 direct ATTACHMENTS skips cannot bypass nested goal-ref bounds',()=>{
  const f=fixture(),attachmentIds=Array.from({length:51},(_,i)=>`missing-attachment-${i}`),goal=buildConversationGoal({goalId:'goal-many-attachments',accountId:A,conversationId:C,sourceMessageIds:[f.first.messageId],sourceAttachmentIds:attachmentIds,erpObjectRefs:[{objectType:'WORK_ITEM',objectId:'wi-main',accountId:A,conversationId:C}],parentGoalId:null,dependsOnGoalIds:[],relatedGoalIds:[],description:'many attachment refs',status:'OPEN',createdBy:'AGENT',createdAt:'2026-09-17T00:00:00.000Z',updatedAt:'2026-09-17T00:00:00.000Z',fulfillmentEvidenceRefs:[]});
  new V3GoalGraphStore(f.db).appendGoalEvent({scope:{accountId:A,conversationId:C},eventId:'ev-many-attachments',goal,eventType:'CREATED',idempotencyKey:'idem-many-attachments',createdAt:'2026-09-17T00:00:00.000Z'});
  assert.throws(()=>layer(f,'ATTACHMENTS',{goalId:'goal-many-attachments'}),/V3_RETRIEVAL_LADDER_INVALID:GOAL_REF_COUNT/);
});


test('RET-005 current-bundle freshness binds conversationRevisionAtBuild to current inbox revision',()=>{
  const f=fixture();
  const lease=f.queue.claimNext({accountId:A,conversationId:C,owner:'ret5-revision-fence',nowIso:'2026-09-17T00:00:02Z',leaseMs:30_000});
  assert.ok(lease);
  assert.throws(()=>f.tools.conversation_goal_list({}),LADDER_UNAVAILABLE);
  assert.throws(()=>layer(f,'CURRENT_BUNDLE'),LADDER_UNAVAILABLE);
});
