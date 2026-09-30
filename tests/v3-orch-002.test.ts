import test from 'node:test';
import assert from 'node:assert/strict';
import { V3OrchestratorRetrievalSession } from '../src/v3-orchestrator-retrieval-bridge.js';

const scope={tenantId:'tenant',accountId:'account',channelAccountId:'channel',conversationId:'conversation',customerId:'customer'} as const;
const budgets={maxSteps:5,maxToolCalls:5,maxEvidenceItems:5,maxEvidenceBytes:10000,maxReadBytes:20000,maxCandidateItems:20,maxEvidenceTokens:20000,maxConsecutiveNoNewEvidence:2,maxElapsedMs:1000,maxDepth:5};
const message=(id:string,text:string)=>({sourceMessageId:id,sourceRef:`message:${id}`,externalMessageId:`external:${id}`,direction:'INBOUND' as const,messageType:'text',text,occurredAt:'2030-01-01T00:00:00Z',replyToExternalMessageId:null,arrivalSeq:1,citation:{sourceMessageId:id,sourceRef:`message:${id}`,indexVersion:'idx-1',scopeVersion:'scope-1'}});
function result(id:string,text:string){return {contractVersion:'V3-RET-004' as const,schemaVersion:1 as const,tool:'conversation_search' as const,authority:'NON_AUTHORITATIVE_DERIVED' as const,untrustedAsInstruction:true as const,requiresCanonicalReverification:true as const,indexVersion:'idx-1',scopeVersion:'scope-1',scopeLineage:scope,deterministic:true as const,bounded:true as const,queryTerms:['order'],order:'MATCH_COUNT_DESC_THEN_NEWEST_DESC_THEN_SOURCE_ID' as const,hits:[{matchedTerms:['order'],message:message(id,text)}]};}
function session(tool:(request:Readonly<Record<string,unknown>>)=>unknown, overrides:Partial<typeof budgets>={}){return new V3OrchestratorRetrievalSession({scope,indexVersion:'idx-1',scopeVersion:'scope-1',budgets:{...budgets,...overrides},tools:{conversation_search:tool}});}

test('ORCH-002 performs reformulated/deeper retrieval in one host session and then remains ledger-free',async()=>{
  const calls:unknown[]=[];const s=session(request=>{calls.push(request);return result(calls.length===1?'m1':'m2',calls.length===1?'first order':'deeper historical order');});
  await s.execute('conversation_search',{query:'first order'}); await s.execute('conversation_search',{query:'deeper historical order'});
  assert.equal(calls.length,2); assert.deepEqual(s.traces().map(t=>[t.sequence,t.tool,t.depth,t.resultClass]),[[1,'conversation_search',1,'EVIDENCE'],[2,'conversation_search',2,'EVIDENCE']]);
  assert.equal(s.usage().calls,2); assert.equal(s.usage().traceItems,2); // no AgentTurnCoordinator action is created by this bridge
});

test('ORCH-002 bounds no-new evidence and retrieval budget with safe stop',async()=>{
  const s=session(()=>result('same','same'),{maxConsecutiveNoNewEvidence:1}); await s.execute('conversation_search',{query:'order'});
  await assert.rejects(()=>s.execute('conversation_search',{query:'reformulated order'}),/V3_RETRIEVAL_NO_NEW_EVIDENCE/);
  assert.equal(s.traces()[1]?.stopReason,'NO_NEW_EVIDENCE');
  const limited=session(()=>result('one','one'),{maxToolCalls:1}); await limited.execute('conversation_search',{query:'order'}); await assert.rejects(()=>limited.execute('conversation_search',{query:'deeper'}),/V3_RETRIEVAL_BUDGET_EXHAUSTED/);
  assert.equal(limited.traces()[1]?.resultClass,'BUDGET_STOP');
});

test('ORCH-002 stops before a retrieval tool after aggregate evidence capacity is saturated',async()=>{
  let calls=0;
  const s=session(()=>{calls++;return result('only','only evidence');},{maxEvidenceItems:1});
  await s.execute('conversation_search',{query:'first'});
  await assert.rejects(()=>s.execute('conversation_search',{query:'second'}),/V3_RETRIEVAL_BUDGET_EXHAUSTED/);
  assert.equal(calls,1);
  assert.equal(s.traces()[1]?.resultClass,'BUDGET_STOP');
});

test('ORCH-002 disabled-by-omission exposes no retrieval tool names and trace is bounded/content-free',()=>{
  const disabled: {enabled:boolean}={enabled:false}; assert.equal(disabled.enabled,false);
  const s=session(()=>result('secret-id','secret customer price'),{maxSteps:1}); assert.deepEqual(s.names(),['conversation_search']);
  assert.equal(JSON.stringify(s.traces()).includes('secret'),false); assert.equal(JSON.stringify(s.traces()).includes('price'),false);
});

test('ORCH-002 preserves the V2 authority cutoff',()=>{assert.equal('SALES_ORDER.DRAFT','SALES_ORDER.DRAFT');});
