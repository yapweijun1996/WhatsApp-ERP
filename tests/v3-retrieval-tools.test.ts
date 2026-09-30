import test from 'node:test';
import assert from 'node:assert/strict';
import {V1Database} from '../src/database.js';
import {AgentTurnCoordinator} from '../src/v2-agent-turn-coordinator.js';
import {V2QueueService} from '../src/v2-queue.js';
import {buildV3ConversationMemory, type ConversationMemoryDerivationProposal} from '../src/v3-conversation-memory.js';
import {buildV3RetrievalIndexes, createV3RetrievalHostAuthority} from '../src/v3-retrieval-index.js';
import {
  createV3RetrievalTools,
  V3_RETRIEVAL_TOOL_NAMES,
  type V3ConversationRecentRequest,
  type V3ConversationSearchRequest,
} from '../src/v3-retrieval-tools.js';

const A='demo-account', C='conv-001';
const GENERIC_SCOPE=/^Error: V3_RETRIEVAL_SCOPE_UNAVAILABLE$/;
const GENERIC_TOOL=/^Error: V3_RETRIEVAL_TOOL_UNAVAILABLE$/;
const INVALID=/V3_RETRIEVAL_TOOL_INVALID/;

type Setup=ReturnType<typeof setup>;
function setup(){
  const db=new V1Database(':memory:');db.resetAndSeed();
  const rows=[
    ['m1','x-1','INBOUND','2026-09-10T00:00:00Z','alpha beta amber',null],
    ['m2','x-2','OUTBOUND','2026-09-10T00:01:00Z','alpha neutral','x-1'],
    ['m3','x-3','INBOUND','2026-09-10T00:02:00Z','alpha beta violet','x-2'],
    ['m4','x-4','OUTBOUND','2026-09-10T00:03:00Z','gamma neutral','x-3'],
    ['m5','x-5','INBOUND','2026-09-10T00:04:00Z','delta gamma','foreign-external'],
    ['m6','x-6','OUTBOUND','2026-09-10T00:05:00Z','omega delta','x-5'],
  ] as const;
  for(const [id,external,direction,at,text,reply] of rows)db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,reply_to_external_message_id,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,C,external,direction,'text',text,reply,A,at);
  const proposal:ConversationMemoryDerivationProposal={
    sections:[
      {id:'s-alpha',title:'Amber segment',topic:'alpha continuity',summary:'violet alpha notes',sourceMessageIds:['m1','m2','m3']},
      {id:'s-gamma',title:'Gamma segment',topic:'delta continuity',summary:'omega gamma notes',sourceMessageIds:['m4','m5','m6']},
    ],
    rollingMemory:{text:'neutral derived continuity',sourceMessageIds:['m1','m2','m3','m4','m5','m6'],sectionIds:['s-alpha','s-gamma']},
  };
  const memory=buildV3ConversationMemory(db.db,{accountId:A,conversationId:C,proposal});
  const turn=new AgentTurnCoordinator(db).start({accountId:A,conversationId:C,inboundMessageId:'m1',timezone:'UTC',nowIso:'2026-09-10T00:00:00Z'});
  const authority=createV3RetrievalHostAuthority(db.db,{subject:'host-A',tenantId:'tenant-host-A',channelAccountId:A});
  const token=authority.issue(turn.turnId);
  const index=buildV3RetrievalIndexes(db.db,authority,token,{memory});
  const tools=createV3RetrievalTools(db.db,authority,token,index,memory);
  return {db,memory,turn,authority,token,index,tools};
}

function ids(messages:readonly {sourceMessageId:string}[]){return messages.map(message=>message.sourceMessageId)}

function addForeignScope(s:Setup){
  const B='foreign-account',D='foreign-conversation',K='CUST-FOREIGN';
  s.db.db.prepare('INSERT INTO channel_accounts VALUES (?,?,?,?,?,?)').run(B,'simulated',B,'CONNECTED','2026-09-10','2026-09-10');
  s.db.db.prepare('INSERT INTO customers VALUES (?,?,?,?,?,?)').run(K,K,'Foreign Customer','SGD','OK','SG-MAIN');
  s.db.db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run(D,B,D,K,'OPEN','2026-09-10');
  s.db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,reply_to_external_message_id,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)').run('fm1',D,'foreign-1','INBOUND','text','foreign neutral',null,B,'2026-09-10T00:00:00Z');
  const turn=new AgentTurnCoordinator(s.db).start({accountId:B,conversationId:D,inboundMessageId:'fm1',timezone:'UTC',nowIso:'2026-09-10T00:00:00Z'});
  const authority=createV3RetrievalHostAuthority(s.db.db,{subject:'host-B',tenantId:'tenant-host-B',channelAccountId:B});
  return {authority,token:authority.issue(turn.turnId)};
}

test('RET-004 exposes exactly seven closed shadow retrieval tools and all happy paths',()=>{
  const s=setup();
  assert.deepEqual([...V3_RETRIEVAL_TOOL_NAMES],[
    'conversation_recent','conversation_search','conversation_find_sections','conversation_open_section','conversation_get_message','conversation_get_thread','conversation_find_by_date',
  ]);
  const recent=s.tools.conversation_recent({limit:2});
  assert.deepEqual(ids(recent.messages),['m5','m6']);
  assert.equal(recent.order,'CHRONOLOGICAL_ASC_WITHIN_RECENT_WINDOW');

  const search=s.tools.conversation_search({query:'alpha beta',limit:10});
  assert.deepEqual(search.hits.map(hit=>hit.message.sourceMessageId),['m3','m1','m2']);
  assert.deepEqual(search.hits.map(hit=>hit.matchedTerms.length),[2,2,1]);
  assert.deepEqual(search.queryTerms,['alpha','beta']);

  const found=s.tools.conversation_find_sections({query:'gamma'});
  assert.deepEqual(found.sections.map(section=>section.sectionId),['s-gamma']);
  assert.deepEqual(found.sections[0]?.sourceMessageIds,['m4','m5','m6']);

  const opened=s.tools.conversation_open_section({sectionId:'s-alpha',limit:2});
  assert.deepEqual(ids(opened.messages),['m1','m2']);
  assert.equal(opened.truncated,true);

  const message=s.tools.conversation_get_message({messageId:'m4'});
  assert.equal(message.message.text,'gamma neutral');

  const thread=s.tools.conversation_get_thread({messageId:'m2'});
  assert.deepEqual(ids(thread.messages),['m1','m2','m3','m4']);
  assert.equal(thread.truncated,false);

  const dated=s.tools.conversation_find_by_date({fromIso:'2026-09-10T00:02:00Z',toIso:'2026-09-10T00:04:00Z'});
  assert.deepEqual(ids(dated.messages),['m3','m4','m5']);
});

test('RET-004 result envelope, citations and nested evidence are exact and immutable',()=>{
  const s=setup(),result=s.tools.conversation_get_message({messageId:'m3'}),message=result.message;
  assert.equal(result.contractVersion,'V3-RET-004');assert.equal(result.schemaVersion,1);assert.equal(result.tool,'conversation_get_message');
  assert.equal(result.authority,'NON_AUTHORITATIVE_DERIVED');assert.equal(result.untrustedAsInstruction,true);assert.equal(result.requiresCanonicalReverification,true);assert.equal(result.deterministic,true);assert.equal(result.bounded,true);
  assert.equal(result.indexVersion,s.index.indexVersion);assert.equal(result.scopeVersion,s.index.scopeVersion);assert.deepEqual(result.scopeLineage,s.index.scope);
  assert.deepEqual(message.citation,{sourceMessageId:'m3',sourceRef:'messages/m3',indexVersion:s.index.indexVersion,scopeVersion:s.index.scopeVersion});
  assert.equal(message.externalMessageId,'x-3');assert.equal(message.occurredAt,'2026-09-10T00:02:00Z');assert.equal(message.replyToExternalMessageId,'x-2');
  const closedDirection:'INBOUND'|'OUTBOUND'=message.direction;assert.equal(closedDirection,'INBOUND');
  assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.scopeLineage),true);assert.equal(Object.isFrozen(message),true);assert.equal(Object.isFrozen(message.citation),true);
});

test('RET-004 requests reject unknown scope selectors, accessors, proxies and non-plain shapes',()=>{
  const s=setup();
  for(const value of [{tenantId:'x'},{accountId:A},{conversationId:C},{customerId:'CUST-001'},{limit:1,extra:true},Object.create(null),[]])assert.throws(()=>s.tools.conversation_recent(value as any),INVALID);
  const accessor={};Object.defineProperty(accessor,'limit',{enumerable:true,get(){return 1}});assert.throws(()=>s.tools.conversation_recent(accessor as any),INVALID);
  const proxy=new Proxy({}, {ownKeys(){throw new Error('trap')}});assert.throws(()=>s.tools.conversation_recent(proxy as any),INVALID);
  const benignProxy=new Proxy({limit:1},{});assert.throws(()=>s.tools.conversation_recent(benignProxy as any),INVALID);
  assert.throws(()=>s.tools.conversation_search({query:'alpha',tenantId:'x'} as any),INVALID);
});

test('RET-004 enforces per-call bounds and strict query/id/date shapes',()=>{
  const s=setup();
  for(const limit of [0,51,1.5,NaN])assert.throws(()=>s.tools.conversation_recent({limit} as any),INVALID);
  for(const query of ['', ' '.repeat(5),'x'.repeat(513),'界'.repeat(200),Array.from({length:33},(_,i)=>`term${i}`).join(' ')])assert.throws(()=>s.tools.conversation_search({query} as any),INVALID);
  for(const messageId of ['', 'x'.repeat(257),'界'.repeat(100)])assert.throws(()=>s.tools.conversation_get_message({messageId} as any),INVALID);
  for(const req of [
    {fromIso:'2026-09-10',toIso:'2026-09-10T00:01:00Z'},
    {fromIso:'2026-02-31T00:00:00Z',toIso:'2026-03-01T00:00:00Z'},
    {fromIso:'2026-09-10T00:02:00',toIso:'2026-09-10T00:03:00Z'},
    {fromIso:'2026-09-10T00:03:00Z',toIso:'2026-09-10T00:02:00Z'},
  ])assert.throws(()=>s.tools.conversation_find_by_date(req as any),INVALID);
  assert.equal(s.tools.conversation_recent({limit:1}).messages.length,1);
  assert.equal(s.tools.conversation_open_section({sectionId:'s-alpha',limit:1}).truncated,true);
  assert.equal(s.tools.conversation_get_thread({messageId:'m2',limit:1}).truncated,true);
});

test('RET-004 foreign message, section and thread references fail with one generic unavailable error',()=>{
  const s=setup();
  assert.throws(()=>s.tools.conversation_get_message({messageId:'foreign-message'}),GENERIC_TOOL);
  assert.throws(()=>s.tools.conversation_open_section({sectionId:'foreign-section'}),GENERIC_TOOL);
  assert.throws(()=>s.tools.conversation_get_thread({messageId:'foreign-message'}),GENERIC_TOOL);
});

test('RET-004 revalidates RET-003 scope/token authority before returning any evidence',()=>{
  const s=setup();
  const second=createV3RetrievalHostAuthority(s.db.db,{subject:'host-A-2',tenantId:'tenant-host-A',channelAccountId:A});
  assert.throws(()=>createV3RetrievalTools(s.db.db,second,s.token,s.index,s.memory).conversation_recent({}),GENERIC_SCOPE);
  const foreign=addForeignScope(s);
  assert.throws(()=>createV3RetrievalTools(s.db.db,foreign.authority,foreign.token,s.index,s.memory).conversation_recent({}),GENERIC_SCOPE);
  assert.throws(()=>createV3RetrievalTools(s.db.db,s.authority,foreign.token,s.index,s.memory).conversation_recent({}),GENERIC_SCOPE);
});

test('RET-004 stale or tampered index, memory and source state fail before evidence leaves the tool',()=>{
  {
    const s=setup(),tampered=structuredClone(s.index) as any;tampered.scopeVersion='V3-RET-003:v1:forged';
    assert.throws(()=>createV3RetrievalTools(s.db.db,s.authority,s.token,tampered,s.memory).conversation_search({query:'not-present'}),GENERIC_SCOPE);
  }
  {
    const s=setup(),stale=structuredClone(s.memory) as any;stale.projectionHash='forged';
    assert.throws(()=>createV3RetrievalTools(s.db.db,s.authority,s.token,s.index,stale).conversation_recent({}),/SECTION_PROVENANCE|MEMORY_STALE/);
  }
  {
    const s=setup();s.db.db.prepare('UPDATE messages SET text=? WHERE id=?').run('mutated','m1');
    assert.throws(()=>s.tools.conversation_recent({}),/INDEX_STALE|SECTION_PROVENANCE/);
  }
});

test('RET-004 search ranking is deterministic from neutral RET-002 postings only',()=>{
  const s=setup(),first=s.tools.conversation_search({query:'beta alpha'}),second=s.tools.conversation_search({query:'alpha beta'});
  assert.deepEqual(first.queryTerms,['alpha','beta']);
  assert.deepEqual(first.hits.map(hit=>({id:hit.message.sourceMessageId,terms:hit.matchedTerms})),second.hits.map(hit=>({id:hit.message.sourceMessageId,terms:hit.matchedTerms})));
  assert.deepEqual(first.hits.map(hit=>hit.message.sourceMessageId),['m3','m1','m2']);
  assert.deepEqual(s.tools.conversation_search({query:'zephyrvoid'}).hits,[]);
});

test('RET-004 thread traversal uses only indexed reply links and never fabricates a foreign external parent',()=>{
  const s=setup();
  assert.deepEqual(ids(s.tools.conversation_get_thread({messageId:'m3'}).messages),['m1','m2','m3','m4']);
  const foreignParent=s.tools.conversation_get_thread({messageId:'m5'});
  assert.deepEqual(ids(foreignParent.messages),['m5','m6']);
  assert.equal(foreignParent.messages[0]?.replyToExternalMessageId,'foreign-external');
  assert.equal(foreignParent.messages.some(message=>message.sourceMessageId==='foreign-external'),false);
});

test('RET-004 section navigation is bounded, source-linked and query-neutral',()=>{
  const s=setup(),all=s.tools.conversation_find_sections({limit:1});
  assert.deepEqual(all.sections.map(section=>section.sectionId),['s-alpha']);
  assert.equal(all.sections[0]?.truncated,false);
  const gamma=s.tools.conversation_find_sections({query:'omega gamma'});
  assert.deepEqual(gamma.sections.map(section=>section.sectionId),['s-gamma']);
  assert.deepEqual(gamma.sections[0]?.matchedTerms,['gamma','omega']);
  assert.deepEqual(gamma.sections[0]?.sourceRefs,['messages/m4','messages/m5','messages/m6']);
});

test('RET-004 TypeScript request contracts expose no authority scope selectors',()=>{
  const s=setup();
  if(false){
    const recent:V3ConversationRecentRequest={
      // @ts-expect-error model-facing request cannot select tenant scope.
      tenantId:'tenant-host-A',
    };
    const search:V3ConversationSearchRequest={query:'alpha',
      // @ts-expect-error model-facing request cannot select customer scope.
      customerId:'CUST-001',
    };
    s.tools.conversation_recent(recent);s.tools.conversation_search(search);
  }
  assert.ok(s.tools);
});

test('RET-004 bounds returned message text bytes even when the authorized source is larger',()=>{
  const db=new V1Database(':memory:');db.resetAndSeed();
  const large='🙂'.repeat(5_000); // 10,000 UTF-16 code units but 20,000 UTF-8 bytes
  db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,reply_to_external_message_id,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)').run('m-large',C,'x-large','INBOUND','text',large,null,A,'2026-09-10T00:00:00Z');
  const proposal:ConversationMemoryDerivationProposal={sections:[{id:'s-large',title:'Large',topic:'neutral',summary:'bounded source',sourceMessageIds:['m-large']}],rollingMemory:{text:'derived',sourceMessageIds:['m-large'],sectionIds:['s-large']}};
  const memory=buildV3ConversationMemory(db.db,{accountId:A,conversationId:C,proposal});
  const turn=new AgentTurnCoordinator(db).start({accountId:A,conversationId:C,inboundMessageId:'m-large',timezone:'UTC',nowIso:'2026-09-10T00:00:00Z'});
  const authority=createV3RetrievalHostAuthority(db.db,{subject:'host-large',tenantId:'tenant-host-A',channelAccountId:A}),token=authority.issue(turn.turnId),index=buildV3RetrievalIndexes(db.db,authority,token,{memory});
  const tools=createV3RetrievalTools(db.db,authority,token,index,memory);
  assert.throws(()=>tools.conversation_get_message({messageId:'m-large'}),/V3_RETRIEVAL_TOOL_INVALID:MESSAGE_TEXT_SIZE/);
});

test('RET-004 bounds all DB-derived message identity strings and scope lineage before output',()=>{
  const make=(input:{externalMessageId?:string;messageType?:string;replyToExternalMessageId?:string|null;customerId?:string})=>{
    const db=new V1Database(':memory:');db.resetAndSeed();
    db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)').run('m-auth',C,'x-auth','INBOUND','text','authority seed',A,'2026-09-10T00:00:00Z');
    const turn=new AgentTurnCoordinator(db).start({accountId:A,conversationId:C,inboundMessageId:'m-auth',timezone:'UTC',nowIso:'2026-09-10T00:00:00Z'}),authority=createV3RetrievalHostAuthority(db.db,{subject:'host-bound',tenantId:'tenant-host-A',channelAccountId:A}),token=authority.issue(turn.turnId);
    if(input.customerId){db.db.prepare('INSERT INTO customers VALUES (?,?,?,?,?,?)').run(input.customerId,input.customerId,'Bounded Customer','SGD','OK','SG-MAIN');db.db.prepare('UPDATE conversations SET customer_id=? WHERE id=?').run(input.customerId,C)}
    db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,reply_to_external_message_id,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)').run('m-bound',C,input.externalMessageId??'x-bound','OUTBOUND',input.messageType??'text','bounded',input.replyToExternalMessageId??null,A,'2026-09-10T00:00:01Z');
    const proposal:ConversationMemoryDerivationProposal={sections:[{id:'s-bound',title:'Bound',topic:'neutral',summary:'bounded',sourceMessageIds:['m-bound']}],rollingMemory:{text:'derived',sourceMessageIds:['m-bound'],sectionIds:['s-bound']}};
    const memory=buildV3ConversationMemory(db.db,{accountId:A,conversationId:C,proposal}),index=buildV3RetrievalIndexes(db.db,authority,token,{memory});
    return createV3RetrievalTools(db.db,authority,token,index,memory);
  };
  assert.throws(()=>make({externalMessageId:'e'.repeat(513)}).conversation_get_message({messageId:'m-bound'}),/V3_RETRIEVAL_TOOL_INVALID:EXTERNAL_MESSAGE_ID_SIZE/);
  assert.throws(()=>make({messageType:'t'.repeat(129)}).conversation_get_message({messageId:'m-bound'}),/V3_RETRIEVAL_TOOL_INVALID:MESSAGE_TYPE_SIZE/);
  assert.throws(()=>make({replyToExternalMessageId:'r'.repeat(513)}).conversation_get_message({messageId:'m-bound'}),/V3_RETRIEVAL_TOOL_INVALID:REPLY_EXTERNAL_MESSAGE_ID_SIZE/);
  assert.throws(()=>make({customerId:'c'.repeat(257)}).conversation_get_message({messageId:'m-bound'}),/V3_RETRIEVAL_TOOL_INVALID:SCOPE_ID_SIZE/);
});

test('RET-004 chronology preserves RFC3339 fractional-second precision beyond milliseconds',()=>{
  const db=new V1Database(':memory:');db.resetAndSeed();
  // RET-002's millisecond comparator orders external id `a` before `z`; exact time order is the reverse.
  for(const [id,external,at] of [['n-late','a','2026-09-10T00:00:00.000000002Z'],['n-early','z','2026-09-10T00:00:00.000000001Z']] as const)db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)').run(id,C,external,'INBOUND','text','nano neutral',A,at);
  const proposal:ConversationMemoryDerivationProposal={sections:[{id:'s-nano',title:'Nano',topic:'neutral',summary:'precision',sourceMessageIds:['n-late','n-early']}],rollingMemory:{text:'derived',sourceMessageIds:['n-late','n-early'],sectionIds:['s-nano']}};
  const memory=buildV3ConversationMemory(db.db,{accountId:A,conversationId:C,proposal}),turn=new AgentTurnCoordinator(db).start({accountId:A,conversationId:C,inboundMessageId:'n-late',timezone:'UTC',nowIso:'2026-09-10T00:00:00Z'}),authority=createV3RetrievalHostAuthority(db.db,{subject:'host-nano',tenantId:'tenant-host-A',channelAccountId:A}),token=authority.issue(turn.turnId),index=buildV3RetrievalIndexes(db.db,authority,token,{memory}),tools=createV3RetrievalTools(db.db,authority,token,index,memory);
  assert.deepEqual(index.chronology.map(entry=>entry.sourceMessageId),['n-late','n-early']); // dependency remains millisecond ordered
  assert.deepEqual(ids(tools.conversation_find_by_date({fromIso:'2026-09-10T00:00:00.000000001Z',toIso:'2026-09-10T00:00:00.000000001Z'}).messages),['n-early']);
  assert.deepEqual(ids(tools.conversation_find_by_date({fromIso:'2026-09-10T00:00:00.000000002+00:00',toIso:'2026-09-10T00:00:00.000000002+00:00'}).messages),['n-late']);
  assert.deepEqual(ids(tools.conversation_find_by_date({fromIso:'2026-09-10T00:00:00.000000001Z',toIso:'2026-09-10T00:00:00.000000002Z'}).messages),['n-early','n-late']);
  assert.deepEqual(ids(tools.conversation_recent({limit:1}).messages),['n-late']);
  assert.deepEqual(tools.conversation_search({query:'nano'}).hits.map(hit=>hit.message.sourceMessageId),['n-late','n-early']);
});

test('RET-004 preserves canonical arrival_seq before provider occurred_at chronology',()=>{
  const db=new V1Database(':memory:');db.resetAndSeed();const queue=new V2QueueService(db);
  const first=queue.enqueueInbound({accountId:A,conversationId:C,externalMessageId:'a1',occurredAt:'2026-09-10T00:00:02.000000009Z',text:'arrival neutral'});
  const second=queue.enqueueInbound({accountId:A,conversationId:C,externalMessageId:'a2',occurredAt:'2026-09-10T00:00:01.000000001Z',text:'arrival neutral'});
  const proposal:ConversationMemoryDerivationProposal={sections:[{id:'s-arrival',title:'Arrival',topic:'neutral',summary:'canonical arrival order',sourceMessageIds:[first.messageId,second.messageId]}],rollingMemory:{text:'derived',sourceMessageIds:[first.messageId,second.messageId],sectionIds:['s-arrival']}};
  const memory=buildV3ConversationMemory(db.db,{accountId:A,conversationId:C,proposal}),turn=new AgentTurnCoordinator(db).start({accountId:A,conversationId:C,inboundMessageId:first.messageId,timezone:'UTC',nowIso:'2026-09-10T00:00:03Z'}),authority=createV3RetrievalHostAuthority(db.db,{subject:'host-arrival',tenantId:'tenant-host-A',channelAccountId:A}),token=authority.issue(turn.turnId),index=buildV3RetrievalIndexes(db.db,authority,token,{memory}),tools=createV3RetrievalTools(db.db,authority,token,index,memory);
  assert.deepEqual(index.chronology.map(entry=>entry.sourceMessageId),[first.messageId,second.messageId]);
  assert.deepEqual(ids(tools.conversation_find_by_date({fromIso:'2026-09-10T00:00:00Z',toIso:'2026-09-10T00:00:03Z'}).messages),[first.messageId,second.messageId]);
  assert.deepEqual(ids(tools.conversation_recent({limit:1}).messages),[second.messageId]);
  assert.deepEqual(tools.conversation_search({query:'arrival'}).hits.map(hit=>hit.message.sourceMessageId),[second.messageId,first.messageId]);
});


test('RET-004 mixed sequenced and unsequenced chronology is deterministic and transitive',()=>{
  const db=new V1Database(':memory:');db.resetAndSeed();const queue=new V2QueueService(db);
  const s1=queue.enqueueInbound({accountId:A,conversationId:C,externalMessageId:'s1',occurredAt:'2026-09-10T00:00:03Z',text:'mixed neutral'});
  const s2=queue.enqueueInbound({accountId:A,conversationId:C,externalMessageId:'s2',occurredAt:'2026-09-10T00:00:01Z',text:'mixed neutral'});
  db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)').run('u1',C,'u1','OUTBOUND','text','mixed neutral',A,'2026-09-10T00:00:02Z');
  // Memory must preserve the accepted upstream source order; RET-004 projects a deterministic total chronology for time-oriented tools.
  const proposal:ConversationMemoryDerivationProposal={sections:[{id:'s-mixed',title:'Mixed',topic:'neutral',summary:'mixed chronology',sourceMessageIds:[s1.messageId,s2.messageId,'u1']}],rollingMemory:{text:'derived',sourceMessageIds:[s1.messageId,s2.messageId,'u1'],sectionIds:['s-mixed']}};
  // Build memory with its accepted ordering by deriving the actual upstream order first.
  const rows=[s1.messageId,s2.messageId,'u1'].map(id=>db.db.prepare('SELECT id,arrival_seq,occurred_at,external_message_id FROM messages WHERE id=?').get(id) as any);
  rows.sort((a,b)=>a.arrival_seq!==null&&b.arrival_seq!==null&&a.arrival_seq!==b.arrival_seq?a.arrival_seq-b.arrival_seq:Date.parse(a.occurred_at)-Date.parse(b.occurred_at)||a.external_message_id.localeCompare(b.external_message_id)||a.id.localeCompare(b.id));
  proposal.sections[0]!.sourceMessageIds.splice(0,3,...rows.map(row=>row.id));
  proposal.rollingMemory.sourceMessageIds.splice(0,3,...rows.map(row=>row.id));
  const memory=buildV3ConversationMemory(db.db,{accountId:A,conversationId:C,proposal}),turn=new AgentTurnCoordinator(db).start({accountId:A,conversationId:C,inboundMessageId:s1.messageId,timezone:'UTC',nowIso:'2026-09-10T00:00:04Z'}),authority=createV3RetrievalHostAuthority(db.db,{subject:'host-mixed',tenantId:'tenant-host-A',channelAccountId:A}),token=authority.issue(turn.turnId),index=buildV3RetrievalIndexes(db.db,authority,token,{memory}),tools=createV3RetrievalTools(db.db,authority,token,index,memory);
  const expected=['u1',s1.messageId,s2.messageId];
  assert.deepEqual(ids(tools.conversation_find_by_date({fromIso:'2026-09-10T00:00:00Z',toIso:'2026-09-10T00:00:04Z'}).messages),expected);
  assert.deepEqual(tools.conversation_search({query:'mixed'}).hits.map(hit=>hit.message.sourceMessageId),[s2.messageId,s1.messageId,'u1']);
  assert.deepEqual(ids(tools.conversation_recent({limit:3}).messages),expected);
});


test('RET-004 UTF-8 bounds every emitted section string locally',()=>{
  const cases=[
    {field:'id',value:'界'.repeat(100),error:/SECTION_ID_SIZE/},
    {field:'title',value:'界'.repeat(60),error:/SECTION_TITLE_SIZE/},
    {field:'topic',value:'界'.repeat(90),error:/SECTION_TOPIC_SIZE/},
    {field:'summary',value:'界'.repeat(1_400),error:/SECTION_SUMMARY_SIZE/},
  ] as const;
  for(const item of cases){
    const db=new V1Database(':memory:');db.resetAndSeed();
    db.db.prepare('INSERT INTO messages(id,conversation_id,external_message_id,direction,message_type,text,account_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)').run('m-sec',C,'x-sec','INBOUND','text','section neutral',A,'2026-09-10T00:00:00Z');
    const section:any={id:'s-sec',title:'Title',topic:'topic',summary:'summary',sourceMessageIds:['m-sec']};section[item.field]=item.value;
    const proposal:ConversationMemoryDerivationProposal={sections:[section],rollingMemory:{text:'derived',sourceMessageIds:['m-sec'],sectionIds:[section.id]}};
    const memory=buildV3ConversationMemory(db.db,{accountId:A,conversationId:C,proposal}),turn=new AgentTurnCoordinator(db).start({accountId:A,conversationId:C,inboundMessageId:'m-sec',timezone:'UTC',nowIso:'2026-09-10T00:00:01Z'}),authority=createV3RetrievalHostAuthority(db.db,{subject:'host-section-bound',tenantId:'tenant-host-A',channelAccountId:A}),token=authority.issue(turn.turnId),index=buildV3RetrievalIndexes(db.db,authority,token,{memory}),tools=createV3RetrievalTools(db.db,authority,token,index,memory);
    assert.throws(()=>tools.conversation_find_sections({}),item.error);
    assert.throws(()=>tools.conversation_open_section({sectionId:section.id}),item.field==='id'?/V3_RETRIEVAL_TOOL_INVALID:ID/:item.error);
  }
});
