import assert from 'node:assert/strict';
import test from 'node:test';
import {runV3RetrievalLoop,type V3RetrievalLoopOptions} from '../src/v3-retrieval-loop.js';

const scope={tenantId:'tenant',accountId:'account',channelAccountId:'channel',conversationId:'conversation',customerId:'customer'} as const;
const budgets={maxSteps:8,maxToolCalls:8,maxEvidenceItems:8,maxEvidenceBytes:20_000,maxReadBytes:100_000,maxCandidateItems:100,maxEvidenceTokens:100_000,maxConsecutiveNoNewEvidence:2,maxElapsedMs:1_000} as const;
const result=(ids:readonly string[],refs=ids.map(id=>`messages/${id}`))=>({contractVersion:'V3-RET-004',schemaVersion:1,tool:'conversation_recent',authority:'NON_AUTHORITATIVE_DERIVED',deterministic:true,bounded:true,indexVersion:'index-1',scopeVersion:'scope-1',scopeLineage:scope,messages:ids.map((id,i)=>({sourceMessageId:id,sourceRef:refs[i]}))});
function options(sequence:unknown[],overrides:Partial<V3RetrievalLoopOptions>={}):V3RetrievalLoopOptions{
  let cursor=0;return {scope,indexVersion:'index-1',scopeVersion:'scope-1',budgets,nextAction:()=>({kind:'RETRIEVE',tool:'conversation_recent',request:{limit:1}}),tools:{conversation_recent:()=>sequence[Math.min(cursor++,sequence.length-1)]},isSufficient:()=>false,...overrides};
}

test('RET-006 hard max steps and tool calls terminate deterministically',()=>{
  const step=runV3RetrievalLoop(options([result(['m1']),result(['m2'])],{budgets:{...budgets,maxSteps:1,maxToolCalls:8}}));
  assert.equal(step.outcome,'ABSTAIN');assert.equal(step.stopReason,'MAX_STEPS');assert.equal(step.state.steps,1);
  const call=runV3RetrievalLoop(options([result(['m1']),result(['m2'])],{budgets:{...budgets,maxSteps:8,maxToolCalls:1}}));
  assert.equal(call.stopReason,'MAX_TOOL_CALLS');assert.equal(call.state.toolCalls,1);
});

test('RET-006 duplicate canonical evidence stops after bounded no-new streak',()=>{
  const out=runV3RetrievalLoop(options([result(['m1']),result(['m1']),result(['m1'])]));
  assert.equal(out.stopReason,'NO_NEW_EVIDENCE');assert.equal(out.state.evidenceItems,1);assert.equal(out.state.consecutiveNoNewEvidence,2);
});

test('RET-006 genuinely new evidence resets the no-new streak',()=>{
  const out=runV3RetrievalLoop(options([result(['m1']),result(['m1']),result(['m2']),result(['m2']),result(['m2'])]));
  assert.equal(out.stopReason,'NO_NEW_EVIDENCE');assert.equal(out.state.evidenceItems,2);assert.equal(out.state.steps,5);assert.equal(out.state.consecutiveNoNewEvidence,2);
});

test('RET-006 regrouping and reordering do not reset no-new evidence',()=>{
  const first=result(['m1','m2']);
  const onlyA=result(['m1']);
  const onlyB=result(['m2']);
  const out=runV3RetrievalLoop(options([first,onlyA,onlyB],{budgets:{...budgets,maxConsecutiveNoNewEvidence:2}}));
  assert.equal(out.stopReason,'NO_NEW_EVIDENCE');assert.equal(out.state.evidenceItems,1);assert.equal(out.state.steps,3);assert.equal(out.state.consecutiveNoNewEvidence,2);
});

test('RET-006 bounded detached traversal caps huge arrays and objects before materialization',()=>{
  const hugeArray=new Array(1_000_000_000);
  const arrayOut=runV3RetrievalLoop(options([{...result(['m1']),hugeArray}]));
  assert.equal(arrayOut.stopReason,'INVALID_EVIDENCE');assert.equal(arrayOut.state.readBytes,0);
  const hugeObject:Record<string,unknown>={};
  for(let index=0;index<10_001;index++)hugeObject[`key${index}`]=false;
  const objectOut=runV3RetrievalLoop(options([{...result(['m1']),hugeObject}]));
  assert.equal(objectOut.stopReason,'INVALID_EVIDENCE');assert.equal(objectOut.state.readBytes,0);
});

test('RET-006 evidence item and UTF-8 byte budgets are Host-owned hard stops',()=>{
  const item=runV3RetrievalLoop(options([result(['m1']),result(['m2'])],{budgets:{...budgets,maxEvidenceItems:1}}));
  assert.equal(item.stopReason,'EVIDENCE_BUDGET');assert.equal(item.state.evidenceItems,1);
  const wide=result(['界']);const bytes=Buffer.byteLength(JSON.stringify({identity:'x',sourceMessageIds:['界'],sourceRefs:['messages/界']}),'utf8');
  const byte=runV3RetrievalLoop(options([wide],{budgets:{...budgets,maxEvidenceBytes:bytes-1}}));
  assert.equal(byte.stopReason,'EVIDENCE_BUDGET');
});

test('RET-006 duplicate and uncited reads consume Host byte and token budgets',()=>{
  const duplicate=runV3RetrievalLoop(options([result(['m1']),result(['m1'])],{budgets:{...budgets,maxConsecutiveNoNewEvidence:8,maxReadBytes:Buffer.byteLength(JSON.stringify(result(['m1'])),'utf8')+1}}));
  assert.equal(duplicate.stopReason,'READ_BYTE_BUDGET');assert.ok(duplicate.state.readBytes>duplicate.state.evidenceBytes);
  const uncited={...result([]),uncited:'界'.repeat(100)};
  const token=runV3RetrievalLoop(options([uncited],{budgets:{...budgets,maxEvidenceTokens:10}}));
  assert.equal(token.stopReason,'EVIDENCE_TOKEN_BUDGET');assert.ok(token.state.evidenceTokens>0);
});

test('RET-006 detached snapshots have bounded traversal for hostile deep graphs',()=>{
  let hostile:Record<string,unknown>={};
  for(let index=0;index<100;index++)hostile={next:hostile};
  const out=runV3RetrievalLoop(options([{...result(['m1']),hostile}]));
  assert.equal(out.stopReason,'INVALID_EVIDENCE');assert.equal(out.state.readBytes,0);
});

test('RET-006 candidate and evidence-token budgets count validated payload items',()=>{
  const two=result(['m1','m2']);
  const candidates=runV3RetrievalLoop(options([two],{budgets:{...budgets,maxCandidateItems:1}}));
  assert.equal(candidates.stopReason,'CANDIDATE_ITEM_BUDGET');assert.equal(candidates.state.candidateItems,2);
  const tokens=runV3RetrievalLoop(options([result(['m1'])],{budgets:{...budgets,maxEvidenceTokens:1}}));
  assert.equal(tokens.stopReason,'EVIDENCE_TOKEN_BUDGET');assert.ok(tokens.state.evidenceTokens>1);
});

test('RET-006 counts the validated returned payload, not only tiny refs',()=>{
  const large={...result(['m1']),messages:[{sourceMessageId:'m1',sourceRef:'messages/m1',text:'界'.repeat(2_000)}]};
  const out=runV3RetrievalLoop(options([large],{budgets:{...budgets,maxEvidenceBytes:1_000}}));
  assert.equal(out.stopReason,'EVIDENCE_BUDGET');assert.equal(out.state.evidenceItems,0);
});

test('RET-006 rejects absurd Host budgets and enforces elapsed time with an injected clock',()=>{
  assert.throws(()=>runV3RetrievalLoop(options([result(['m1'])],{budgets:{...budgets,maxSteps:1_001}})),/MAXSTEPS_CAP/);
  let now=0;const out=runV3RetrievalLoop(options([result(['m1'])],{budgets:{...budgets,maxElapsedMs:5},clock:()=>{now+=3;return now}}));
  assert.equal(out.stopReason,'ELAPSED_TIME_BUDGET');
});

test('RET-006 rejects action and request accessors without executing getters',()=>{
  let actionGetter=0;const action={kind:'RETRIEVE',tool:'conversation_recent',request:{limit:1}} as any;
  Object.defineProperty(action,'kind',{get(){actionGetter++;return 'RETRIEVE'}});
  const actionOut=runV3RetrievalLoop(options([result(['m1'])],{nextAction:()=>action}));
  assert.equal(actionOut.stopReason,'INVALID_MODEL_ACTION');assert.equal(actionGetter,0);
  let requestGetter=0;const request={limit:1} as any;Object.defineProperty(request,'limit',{get(){requestGetter++;return 1}});
  const requestOut=runV3RetrievalLoop(options([result(['m1'])],{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_recent',request})}));
  assert.equal(requestOut.stopReason,'INVALID_MODEL_ACTION');assert.equal(requestGetter,0);
});

test('RET-006 detached snapshots reject nested indexed accessors without executing them',()=>{
  let getterRuns=0;const nested=[{sourceMessageId:'m1',sourceRef:'messages/m1'}] as any[];
  Object.defineProperty(nested,0,{get(){getterRuns++;return {sourceMessageId:'m1',sourceRef:'messages/m1'}}});
  const payload={...result(['m1']),nested};const out=runV3RetrievalLoop(options([payload]));
  assert.equal(out.stopReason,'INVALID_EVIDENCE');assert.equal(getterRuns,0);
});

test('RET-006 deadline after nextAction wins before tool execution',()=>{
  let clockCalls=0,toolCalls=0;const out=runV3RetrievalLoop(options([result(['m1'])],{budgets:{...budgets,maxElapsedMs:5},clock:()=>clockCalls++===2?10:0,tools:{conversation_recent:()=>{toolCalls++;return result(['m1'])}}}));
  assert.equal(out.stopReason,'ELAPSED_TIME_BUDGET');assert.equal(toolCalls,0);
});

test('RET-006 deadline after isSufficient cannot return SUCCESS',()=>{
  let calls=0;const out=runV3RetrievalLoop(options([result(['m1'])],{budgets:{...budgets,maxElapsedMs:5},clock:()=>calls++<4?0:10,isSufficient:()=>true}));
  assert.equal(out.stopReason,'ELAPSED_TIME_BUDGET');assert.notEqual(out.outcome,'SUCCESS');
});

test('RET-006 deadline after clarification policy cannot return CLARIFY',()=>{
  let calls=0;const out=runV3RetrievalLoop(options([],{budgets:{...budgets,maxElapsedMs:5},clock:()=>calls++<3?0:10,nextAction:()=>({kind:'CLARIFY',missingFact:'date',question:'Which date?' }),allowClarification:()=>true}));
  assert.equal(out.stopReason,'ELAPSED_TIME_BUDGET');assert.notEqual(out.outcome,'CLARIFY');
});

test('RET-006 turns a throwing clarification policy into bounded ABSTAIN',()=>{
  const out=runV3RetrievalLoop(options([], {nextAction:()=>({kind:'CLARIFY',missingFact:'date',question:'Which date?' }),allowClarification:()=>{throw new Error('policy failure')}}));
  assert.equal(out.outcome,'ABSTAIN');assert.equal(out.stopReason,'CLARIFICATION_FAILURE');
});

test('RET-006 stable evidence/provenance changes count new while query/presentation changes do not',()=>{
  const base={...result(['m1']),goalGraphFingerprint:'g1',bundleReplayIdentity:'b1',bundleRevision:1,material:{text:'v1'}};
  const changed={...base,material:{text:'v2'}};
  const out=runV3RetrievalLoop(options([base,changed],{budgets:{...budgets,maxConsecutiveNoNewEvidence:1}}));
  assert.equal(out.state.evidenceItems,1);
  const same={...base,matchedTerms:['different'],query:'different',order:'different',truncated:true};
  const noNew=runV3RetrievalLoop(options([base,same],{budgets:{...budgets,maxConsecutiveNoNewEvidence:1}}));
  assert.equal(noNew.stopReason,'NO_NEW_EVIDENCE');assert.equal(noNew.state.evidenceItems,1);
});

test('RET-006 stable dependency lineage changes count new while presentation changes do not',()=>{
  const base={...result(['m1']),goalGraphFingerprint:'g1',bundleReplayIdentity:'b1',bundleRevision:1,conversationRevisionAtBuild:1,matchedTerms:['one'],truncated:false};
  const dependencyChanged={...base,goalGraphFingerprint:'g2',matchedTerms:['two'],truncated:true};
  const changed=runV3RetrievalLoop(options([base,dependencyChanged],{budgets:{...budgets,maxConsecutiveNoNewEvidence:1}}));
  assert.equal(changed.state.evidenceItems,2);
  const presentationChanged={...base,query:'new',order:'new',matchedTerms:['two'],truncated:true};
  const same=runV3RetrievalLoop(options([base,presentationChanged],{budgets:{...budgets,maxConsecutiveNoNewEvidence:1}}));
  assert.equal(same.stopReason,'NO_NEW_EVIDENCE');assert.equal(same.state.evidenceItems,1);
});

test('RET-006 rejects whitespace and oversized source IDs and refs',()=>{
  for(const payload of [result(['   ']),result(['m1'],['   ']),result(['x'.repeat(4_097)]),result(['m1'],['x'.repeat(4_097)])]){
    const out=runV3RetrievalLoop(options([payload]));assert.equal(out.stopReason,'INVALID_EVIDENCE');assert.equal(out.state.evidenceItems,0);
  }
});

test('RET-006 bounded clarification validation returns ABSTAIN, not a throw',()=>{
  const out=runV3RetrievalLoop(options([],{nextAction:()=>({kind:'CLARIFY',missingFact:'x'.repeat(4_097),question:'question'})}));
  assert.equal(out.outcome,'ABSTAIN');assert.equal(out.stopReason,'INVALID_CLARIFICATION');
});

test('RET-006 empty source evidence is no-new, not an evidence item',()=>{
  const empty={...result([]),payload:'large but uncited'};
  const out=runV3RetrievalLoop(options([empty,empty],{budgets:{...budgets,maxConsecutiveNoNewEvidence:1}}));
  assert.equal(out.stopReason,'NO_NEW_EVIDENCE');assert.equal(out.state.evidenceItems,0);
});

test('RET-006 returns explicit clarify and abstain outcomes when evidence is insufficient',()=>{
  const clarify=runV3RetrievalLoop(options([], {nextAction:()=>({kind:'CLARIFY',missingFact:'delivery date',question:'Which delivery date should we use?'})}));
  assert.equal(clarify.outcome,'CLARIFY');assert.equal(clarify.clarification?.missingFact,'delivery date');
  const abstain=runV3RetrievalLoop(options([], {nextAction:()=>({kind:'FINAL'})}));
  assert.equal(abstain.outcome,'ABSTAIN');assert.equal(abstain.stopReason,'INSUFFICIENT_EVIDENCE');
});

test('RET-006 malformed and foreign evidence fail closed',()=>{
  const malformed=runV3RetrievalLoop(options([{contractVersion:'V3-RET-004'}]));
  assert.equal(malformed.stopReason,'INVALID_EVIDENCE');assert.equal(malformed.state.evidenceItems,0);
  const foreign=runV3RetrievalLoop(options([result(['m1'])].map(value=>({...value,scopeLineage:{...scope,accountId:'foreign'}}))));
  assert.equal(foreign.stopReason,'INVALID_EVIDENCE');assert.equal(foreign.state.evidenceItems,0);
});

test('RET-006 output state is deeply immutable',()=>{
  const out=runV3RetrievalLoop(options([result(['m1'])],{isSufficient:()=>true}));
  assert.equal(out.outcome,'SUCCESS');assert.equal(out.stopReason,'SUFFICIENT_EVIDENCE');assert.equal(out.state.stopReason,'SUFFICIENT_EVIDENCE');assert.equal(Object.isFrozen(out),true);assert.equal(Object.isFrozen(out.state),true);assert.equal(Object.isFrozen(out.state.evidence),true);assert.equal(Object.isFrozen(out.state.evidence[0]),true);
  assert.throws(()=>((out.state as any).steps=99),TypeError);assert.throws(()=>((out.state.evidence as any).push({})),TypeError);
});

test('RET-006 rejects model-controlled scope and budget expansion',()=>{
  const scopeAttempt=runV3RetrievalLoop(options([result(['m1'])],{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_recent',request:{accountId:'foreign'}})}));
  assert.equal(scopeAttempt.stopReason,'INVALID_MODEL_ACTION');
  const budgetAttempt=runV3RetrievalLoop(options([result(['m1'])],{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_recent',request:{maxSteps:999,limit:1}})}));
  assert.equal(budgetAttempt.stopReason,'INVALID_MODEL_ACTION');
  const elapsedAttempt=runV3RetrievalLoop(options([result(['m1'])],{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_recent',request:{maxElapsedMs:1,limit:1}})}));
  assert.equal(elapsedAttempt.stopReason,'INVALID_MODEL_ACTION');
  const candidateAttempt=runV3RetrievalLoop(options([result(['m1'])],{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_recent',request:{maxCandidateItems:1,limit:1}})}));
  assert.equal(candidateAttempt.stopReason,'INVALID_MODEL_ACTION');
  const arbitraryAttempt=runV3RetrievalLoop(options([result(['m1'])],{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_recent',request:{limit:1,arbitrary:'model-controlled'}})}));
  assert.equal(arbitraryAttempt.stopReason,'INVALID_MODEL_ACTION');
});

test('RET-006 charges primitive values in dense detached arrays before read budgets',()=>{
  const hostile={...result(['m1']),dense:Array.from({length:10_001},()=>false)};
  const out=runV3RetrievalLoop(options([hostile]));
  assert.equal(out.stopReason,'INVALID_EVIDENCE');assert.equal(out.state.readBytes,0);
});

test('RET-006 validates every RET-004/005 request scalar class locally',()=>{
  const cases:[string,any][]=[
    ['conversation_recent',{limit:51}],['conversation_search',{query:{value:'x'}}],['conversation_find_sections',{query:['x']}],
    ['conversation_open_section',{sectionId:['s']}],['conversation_get_message',{messageId:{value:'m'}}],
    ['conversation_get_thread',{messageId:1}],['conversation_find_by_date',{fromIso:['date'],toIso:'2020-01-01T00:00:00Z'}],
    ['conversation_goal_list',{query:1}],['conversation_business_objects',{objectType:{value:'ORDER_DRAFT'}}],
    ['conversation_retrieval_ladder',{layer:'NOPE'}],['conversation_retrieval_ladder',{limit:0}],
  ];
  for(const [tool,request] of cases){let calls=0;const out=runV3RetrievalLoop(options([result(['m1'])],{nextAction:()=>({kind:'RETRIEVE',tool:tool as any,request}),tools:{[tool]:()=>{calls++;return result(['m1'])}} as any}));assert.equal(out.stopReason,'INVALID_MODEL_ACTION',tool);assert.equal(calls,0,tool);}
});

test('RET-006 binds ladder payloads to the requested layer and approved RAW_HISTORY tools',()=>{
  const common={contractVersion:'V3-RET-004',schemaVersion:1,authority:'NON_AUTHORITATIVE_DERIVED',deterministic:true,bounded:true,indexVersion:'index-1',scopeVersion:'scope-1',scopeLineage:scope};
  const ladder=(layer:string,payload:any)=>({...common,contractVersion:'V3-RET-005',tool:'conversation_retrieval_ladder',requestedLayer:layer,result:{layer,payload}});
  const recent={...common,tool:'conversation_search',hits:[]};
  const arbitrary={...common,tool:'conversation_get_message',message:{sourceMessageId:'m1',sourceRef:'messages/m1'}};
  const recentOut=runV3RetrievalLoop(options([ladder('RECENT_RAW',recent)],{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_retrieval_ladder',request:{layer:'RECENT_RAW'}}),tools:{conversation_retrieval_ladder:()=>ladder('RECENT_RAW',recent)}}));
  assert.equal(recentOut.stopReason,'INVALID_EVIDENCE');
  const rawOut=runV3RetrievalLoop(options([ladder('RAW_HISTORY',arbitrary)],{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_retrieval_ladder',request:{layer:'RAW_HISTORY'}}),tools:{conversation_retrieval_ladder:()=>ladder('RAW_HISTORY',arbitrary)}}));
  assert.equal(rawOut.stopReason,'INVALID_EVIDENCE');
});

test('RET-006 binds expected contract version to the allowlisted tool',()=>{
  const foreignVersion={...result(['m1']),contractVersion:'V3-RET-005',tool:'conversation_recent'};
  const out=runV3RetrievalLoop(options([foreignVersion]));
  assert.equal(out.stopReason,'INVALID_EVIDENCE');
});

test('RET-006 canonical identity preserves exact message-to-ref pairing',()=>{
  const first=result(['m1','m2'],['ref-a','ref-b']);
  const swapped=result(['m1','m2'],['ref-b','ref-a']);
  const out=runV3RetrievalLoop(options([first,swapped],{budgets:{...budgets,maxConsecutiveNoNewEvidence:1}}));
  assert.equal(out.state.evidenceItems,2);
});

test('RET-006 outer and nested dependency lineage each participate in identity',()=>{
  const ladder=(outer:string,nested:string)=>({contractVersion:'V3-RET-005',schemaVersion:1,tool:'conversation_retrieval_ladder',authority:'NON_AUTHORITATIVE_DERIVED',deterministic:true,bounded:true,indexVersion:'index-1',scopeVersion:'scope-1',scopeLineage:scope,goalGraphFingerprint:outer,bundleReplayIdentity:'b1',bundleRevision:1,conversationRevisionAtBuild:1,requestedLayer:'GOALS',result:{layer:'GOALS',payload:{contractVersion:'V3-RET-005',schemaVersion:1,tool:'conversation_goal_list',authority:'NON_AUTHORITATIVE_DERIVED',deterministic:true,bounded:true,indexVersion:'index-1',scopeVersion:'scope-1',scopeLineage:scope,goalGraphFingerprint:nested,bundleReplayIdentity:'b1',bundleRevision:1,conversationRevisionAtBuild:1,goals:[{sourceMessageIds:['m1'],sourceRefs:['messages/m1']}]}}});
  const values=[ladder('outer-1','nested-1'),ladder('outer-2','nested-1'),ladder('outer-2','nested-2')];let cursor=0;
  const out=runV3RetrievalLoop(options(values,{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_retrieval_ladder',request:{layer:'GOALS'}}),tools:{conversation_retrieval_ladder:()=>values[cursor++]},budgets:{...budgets,maxConsecutiveNoNewEvidence:1}}));
  assert.equal(out.state.evidenceItems,3);
});

test('RET-006 attachment sourceRef remains paired to its source message in identity',()=>{
  const ladder=(sourceRef:string)=>({contractVersion:'V3-RET-005',schemaVersion:1,tool:'conversation_retrieval_ladder',authority:'NON_AUTHORITATIVE_DERIVED',deterministic:true,bounded:true,indexVersion:'index-1',scopeVersion:'scope-1',scopeLineage:scope,requestedLayer:'ATTACHMENTS',result:{layer:'ATTACHMENTS',payload:{attachments:[{sourceMessageId:'m1',messageSourceRef:'messages/m1',sourceRef}]}}});
  const values=[ladder('attachments/a'),ladder('attachments/b')];let cursor=0;
  const out=runV3RetrievalLoop(options(values,{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_retrieval_ladder',request:{layer:'ATTACHMENTS'}}),tools:{conversation_retrieval_ladder:()=>values[cursor++]},budgets:{...budgets,maxConsecutiveNoNewEvidence:1}}));
  assert.equal(out.state.evidenceItems,2);
});

test('RET-006 validation deadline is checked before the allowlisted tool executes',()=>{
  let calls=0,toolCalls=0;
  const out=runV3RetrievalLoop(options([result(['m1'])],{budgets:{...budgets,maxElapsedMs:5},clock:()=>calls++===3?10:0,tools:{conversation_recent:()=>{toolCalls++;return result(['m1'])}}}));
  assert.equal(out.stopReason,'ELAPSED_TIME_BUDGET');assert.equal(toolCalls,0);
});

test('RET-006 presentation contract version is excluded from duplicate identity',()=>{
  const ret5={contractVersion:'V3-RET-005',schemaVersion:1,tool:'conversation_goal_list',authority:'NON_AUTHORITATIVE_DERIVED',deterministic:true,bounded:true,indexVersion:'index-1',scopeVersion:'scope-1',scopeLineage:scope,goalGraphFingerprint:'g1',bundleReplayIdentity:'b1',bundleRevision:1,conversationRevisionAtBuild:1,goals:[{sourceMessageIds:['m1'],sourceRefs:['messages/m1']}]};
  const ret4={...result(['m1']),goalGraphFingerprint:'g1',bundleReplayIdentity:'b1',bundleRevision:1,conversationRevisionAtBuild:1};
  let cursor=0;const out=runV3RetrievalLoop(options([ret4,ret5],{nextAction:()=>({kind:'RETRIEVE',tool:cursor++===0?'conversation_recent':'conversation_goal_list',request:{}}),tools:{conversation_recent:()=>ret4,conversation_goal_list:()=>ret5},budgets:{...budgets,maxConsecutiveNoNewEvidence:1}}));
  assert.equal(out.stopReason,'NO_NEW_EVIDENCE');assert.equal(out.state.evidenceItems,1);
});

test('RET-006 callback returns are exact booleans and deadline wins callback throws',()=>{
  const badClarify=runV3RetrievalLoop(options([],{nextAction:()=>({kind:'CLARIFY',missingFact:'x',question:'?' }),allowClarification:()=>undefined as any}));
  assert.equal(badClarify.stopReason,'CLARIFICATION_FAILURE');
  const badSufficient=runV3RetrievalLoop(options([result(['m1'])],{isSufficient:()=>Promise.resolve(true) as any}));
  assert.equal(badSufficient.stopReason,'HOST_SUFFICIENCY_FAILURE');
  let n=0;const deadline=runV3RetrievalLoop(options([],{budgets:{...budgets,maxElapsedMs:1},clock:()=>++n===1?0:10,nextAction:()=>{throw new Error('late')}}));
  assert.equal(deadline.stopReason,'ELAPSED_TIME_BUDGET');
});

test('RET-006 scope lineage is exact data-only and customerId must not be undefined',()=>{
  for(const lineage of [
    {...scope,extra:'x'},
    {tenantId:scope.tenantId,accountId:scope.accountId,channelAccountId:scope.channelAccountId,conversationId:scope.conversationId},
    {...scope,customerId:undefined},
  ]){
    const out=runV3RetrievalLoop(options([{...result(['m1']),scopeLineage:lineage}]));assert.equal(out.stopReason,'INVALID_EVIDENCE');
  }
  let runs=0;const lineage={...scope} as any;Object.defineProperty(lineage,'accountId',{get(){runs++;return scope.accountId}});
  const out=runV3RetrievalLoop(options([{...result(['m1']),scopeLineage:lineage}]));
  assert.equal(out.stopReason,'INVALID_EVIDENCE');assert.equal(runs,0);
});


test('RET-006 rejects __proto__ model keys without prototype-pollution bypass',()=>{
  const action=JSON.parse('{"kind":"RETRIEVE","tool":"conversation_recent","request":{},"__proto__":{"maxSteps":999}}');
  const actionOut=runV3RetrievalLoop(options([result(['m1'])],{nextAction:()=>action}));
  assert.equal(actionOut.stopReason,'INVALID_MODEL_ACTION');
  const request=JSON.parse('{"limit":1,"__proto__":{"accountId":"foreign","maxElapsedMs":999999}}');
  const requestOut=runV3RetrievalLoop(options([result(['m1'])],{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_recent',request})}));
  assert.equal(requestOut.stopReason,'INVALID_MODEL_ACTION');
  assert.equal(({} as any).accountId,undefined);
});

test('RET-006 extracts only documented tool shapes and ignores presentation lookalikes',()=>{
  const fake={...result([]),presentation:{sourceMessageId:'fake',sourceRef:'messages/fake'}};
  assert.equal(runV3RetrievalLoop(options([fake],{budgets:{...budgets,maxConsecutiveNoNewEvidence:1}})).state.evidenceItems,0);
  const bad={...result([]),messages:[{sourceMessageId:'m1',sourceRef:'messages/m1'}],hits:[{message:{sourceMessageId:'fake',sourceRef:'messages/fake'}}]};
  const mixed=runV3RetrievalLoop(options([bad],{isSufficient:()=>true}));assert.deepEqual(mixed.state.evidence[0]?.sourceMessageIds,['m1']);
  const ladder={contractVersion:'V3-RET-005',schemaVersion:1,tool:'conversation_retrieval_ladder',authority:'NON_AUTHORITATIVE_DERIVED',deterministic:true,bounded:true,indexVersion:'index-1',scopeVersion:'scope-1',scopeLineage:scope,requestedLayer:'ATTACHMENTS',result:{layer:'ATTACHMENTS',payload:{attachments:[{sourceMessageId:'m1',messageSourceRef:'messages/m1',sourceRef:'attachments/a'}]}}};
  const attachment=runV3RetrievalLoop(options([ladder],{nextAction:()=>({kind:'RETRIEVE',tool:'conversation_retrieval_ladder',request:{layer:'ATTACHMENTS'}}),tools:{conversation_retrieval_ladder:()=>ladder},isSufficient:()=>true}));
  assert.equal(attachment.outcome,'SUCCESS');assert.deepEqual(attachment.state.evidence[0]?.sourceMessageIds,['m1']);assert.deepEqual(attachment.state.evidence[0]?.sourceRefs,['attachments/a','messages/m1']);
});
