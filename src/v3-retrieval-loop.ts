import {isProxy} from 'node:util/types';
import {canonicalSha256} from './v2-canonical.js';
import type {V3RetrievalScope} from './v3-retrieval-index.js';

export const V3_RETRIEVAL_LOOP_CONTRACT_VERSION='V3-RET-006';
export const V3_RETRIEVAL_LOOP_SCHEMA_VERSION=1;

export const V3_RETRIEVAL_LOOP_TOOLS=Object.freeze([
  'conversation_recent','conversation_search','conversation_find_sections','conversation_open_section',
  'conversation_get_message','conversation_get_thread','conversation_find_by_date',
  'conversation_goal_list','conversation_business_objects','conversation_retrieval_ladder',
] as const);
export type V3RetrievalLoopToolName=typeof V3_RETRIEVAL_LOOP_TOOLS[number];

export type V3RetrievalLoopBudgets=Readonly<{
  maxSteps:number;
  maxToolCalls:number;
  maxEvidenceItems:number;
  maxEvidenceBytes:number;
  maxReadBytes:number;
  maxCandidateItems:number;
  maxEvidenceTokens:number;
  maxConsecutiveNoNewEvidence:number;
  maxElapsedMs:number;
}>;
export type V3RetrievalLoopEvidence=Readonly<{
  fingerprint:string;
  sourceMessageIds:readonly string[];
  sourceRefs:readonly string[];
  bytes:number;
}>;
export type V3RetrievalLoopState=Readonly<{
  contractVersion:'V3-RET-006';
  steps:number;
  toolCalls:number;
  evidenceItems:number;
  evidenceBytes:number;
  readBytes:number;
  candidateItems:number;
  evidenceTokens:number;
  consecutiveNoNewEvidence:number;
  evidence:readonly V3RetrievalLoopEvidence[];
  stopReason:string|null;
}>;
export type V3RetrievalLoopClarification=Readonly<{missingFact:string;question:string}>;
export type V3RetrievalLoopOutcome=Readonly<{
  contractVersion:'V3-RET-006';
  schemaVersion:1;
  outcome:'SUCCESS'|'CLARIFY'|'ABSTAIN';
  stopReason:string;
  state:V3RetrievalLoopState;
  clarification:V3RetrievalLoopClarification|null;
}>;

export type V3RetrievalLoopAction=Readonly<{
  kind:'RETRIEVE'|'CLARIFY'|'FINAL';
  tool?:V3RetrievalLoopToolName;
  request?:Readonly<Record<string,unknown>>;
  missingFact?:string;
  question?:string;
}>;
export type V3RetrievalLoopOptions=Readonly<{
  scope:V3RetrievalScope;
  indexVersion:string;
  scopeVersion:string;
  budgets:V3RetrievalLoopBudgets;
  nextAction:(state:V3RetrievalLoopState)=>V3RetrievalLoopAction|null;
  tools:Readonly<Partial<Record<V3RetrievalLoopToolName,(request:Readonly<Record<string,unknown>>)=>unknown>>>;
  isSufficient:(evidence:readonly V3RetrievalLoopEvidence[],state:V3RetrievalLoopState)=>boolean;
  allowClarification?:(declaration:V3RetrievalLoopClarification,state:V3RetrievalLoopState)=>boolean;
  clock?:()=>number;
}>;

const MAX_STRING_BYTES=4_096;
const ABSOLUTE_BUDGET_CAPS={maxSteps:1_000,maxToolCalls:1_000,maxEvidenceItems:1_000,maxEvidenceBytes:4_194_304,maxReadBytes:8_388_608,maxCandidateItems:10_000,maxEvidenceTokens:8_388_608,maxConsecutiveNoNewEvidence:100,maxElapsedMs:60_000} as const;
const DETACHED_LIMITS={maxDepth:64,maxNodes:10_000,maxBytes:8_388_608} as const;
const SCOPE_FIELDS=['tenantId','accountId','channelAccountId','conversationId','customerId'] as const;
const isRecord=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&!isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype;
function freeze<T>(value:T,seen=new WeakSet<object>()):T{if(value&&typeof value==='object'){const object=value as object;if(seen.has(object))return value;seen.add(object);for(const child of Object.values(value as Record<string,unknown>))freeze(child,seen);Object.freeze(value)}return value}
function bytes(value:string):number{return Buffer.byteLength(value,'utf8')}
function fail(code:string):never{throw new Error(`V3_RETRIEVAL_LOOP_INVALID:${code}`)}
function bounded(value:unknown,code:string):string{if(typeof value!=='string'||value.trim()===''||bytes(value)>MAX_STRING_BYTES)fail(code);return value}
function positive(value:unknown,code:string):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)fail(code);return value}
function exactScope(actual:unknown,expected:V3RetrievalScope):boolean{
  if(!isRecord(actual))return false;
  const keys=Reflect.ownKeys(actual);
  if(keys.length!==SCOPE_FIELDS.length||keys.some(key=>typeof key!=='string'||!SCOPE_FIELDS.includes(key as typeof SCOPE_FIELDS[number])))return false;
  for(const field of SCOPE_FIELDS){const descriptor=Object.getOwnPropertyDescriptor(actual,field);if(!descriptor||!('value'in descriptor)||descriptor.value!==expected[field])return false;}
  return true;
}
function validateScope(value:unknown,code:string):V3RetrievalScope{
  const detached=detachedData(value);
  if(!isRecord(detached)||!exactScope(detached,detached as V3RetrievalScope))fail(code);
  const customerId=detached.customerId;
  return Object.freeze({tenantId:bounded(detached.tenantId,`${code}_TENANT`),accountId:bounded(detached.accountId,`${code}_ACCOUNT`),channelAccountId:bounded(detached.channelAccountId,`${code}_CHANNEL`),conversationId:bounded(detached.conversationId,`${code}_CONVERSATION`),customerId:customerId===null?null:bounded(customerId,`${code}_CUSTOMER`)}) as V3RetrievalScope;
}
type DetachedLimits={depth:number;nodes:number;bytes:number};
function detachedData(value:unknown,active=new WeakSet<object>(),limits:DetachedLimits={depth:0,nodes:0,bytes:0}):unknown{
  if(limits.depth>DETACHED_LIMITS.maxDepth)fail('SNAPSHOT_DEPTH');
  if(++limits.nodes>DETACHED_LIMITS.maxNodes)fail('SNAPSHOT_NODES');
  if(value===null){limits.bytes+=1;if(limits.bytes>DETACHED_LIMITS.maxBytes)fail('SNAPSHOT_BYTES');return null;}
  if(typeof value==='string'||typeof value==='boolean'){
    limits.bytes+=typeof value==='string'?bytes(value):1;
    if(limits.bytes>DETACHED_LIMITS.maxBytes)fail('SNAPSHOT_BYTES');
    return value;
  }
  if(typeof value==='number'){if(!Number.isFinite(value))fail('NON_JSON_VALUE');limits.bytes+=bytes(String(value));if(limits.bytes>DETACHED_LIMITS.maxBytes)fail('SNAPSHOT_BYTES');return value;}
  if(typeof value!=='object')fail('NON_JSON_VALUE');
  if(isProxy(value)||active.has(value))fail('ACCESSOR_OR_CYCLE');
  active.add(value);
  try{
    if(Array.isArray(value)){
      const lengthDescriptor=Object.getOwnPropertyDescriptor(value,'length');
      if(!lengthDescriptor||!('value' in lengthDescriptor)||typeof lengthDescriptor.value!=='number'||!Number.isSafeInteger(lengthDescriptor.value)||lengthDescriptor.value<0||lengthDescriptor.value>DETACHED_LIMITS.maxNodes-1)fail('ARRAY_SHAPE');
      const out:unknown[]=[];
      for(let index=0;index<lengthDescriptor.value;index++){
        const key=String(index),descriptor=Object.getOwnPropertyDescriptor(value,key);
        if(!descriptor||!('value' in descriptor))fail('ARRAY_ACCESSOR_OR_SPARSE');
        limits.depth++;try{out.push(detachedData(descriptor.value,active,limits));}finally{limits.depth--;}
      }
      // for-in is incremental; symbols and non-enumerable presentation fields are ignored.
      for(const key in value){
        const descriptor=Object.getOwnPropertyDescriptor(value,key);
        if(!descriptor)continue;
        if(!descriptor.enumerable||key==='length')continue;
        if(!/^0$|^[1-9][0-9]*$/.test(key)||Number(key)>=lengthDescriptor.value)fail('ARRAY_HOSTILE_KEY');
      }
      return out;
    }
    if(!isRecord(value))fail('DATA_ONLY_OBJECT');
    const out:Record<string,unknown>={};
    // for-in avoids materializing an unbounded own-key list. The detached node
    // budget is charged before each value is read and therefore bounds work.
    for(const key in value){
      const ownDescriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!ownDescriptor)continue;
      if(!ownDescriptor.enumerable)continue;
      const descriptor=ownDescriptor;
      if(!descriptor||!('value' in descriptor))fail('ACCESSOR_FIELD');
      limits.bytes+=bytes(key);if(limits.bytes>DETACHED_LIMITS.maxBytes)fail('SNAPSHOT_BYTES');
      limits.depth++;try{Object.defineProperty(out,key,{value:detachedData(descriptor.value,active,limits),enumerable:true,writable:true,configurable:true});}finally{limits.depth--;}
    }
    return out;
  }finally{active.delete(value)}
}
function plainAction(value:unknown):V3RetrievalLoopAction|null{
  if(value===null)return null;if(!isRecord(value))fail('ACTION_SHAPE');
  const detached=detachedData(value) as Record<string,unknown>;
  const allowed=['kind','tool','request','missingFact','question'];
  if(Reflect.ownKeys(detached).some(key=>typeof key!=='string'||!allowed.includes(key)))fail('ACTION_FIELD');
  if(detached.kind!=='RETRIEVE'&&detached.kind!=='CLARIFY'&&detached.kind!=='FINAL')fail('ACTION_KIND');
  return detached as V3RetrievalLoopAction;
}
const REQUEST_FIELDS:Readonly<Record<V3RetrievalLoopToolName,readonly string[]>>=Object.freeze({
  conversation_recent:['limit'],conversation_search:['query','limit'],conversation_find_sections:['query','limit'],
  conversation_open_section:['sectionId','limit'],conversation_get_message:['messageId'],conversation_get_thread:['messageId','limit'],
  conversation_find_by_date:['fromIso','toIso','limit'],conversation_goal_list:['query','limit'],
  conversation_business_objects:['goalId','objectType','objectId','limit'],
  conversation_retrieval_ladder:['layer','query','sectionId','goalId','objectType','objectId','limit'],
});
function validateRequest(value:unknown,tool:V3RetrievalLoopToolName):Readonly<Record<string,unknown>>{
  if(!isRecord(value))fail('REQUEST_SHAPE');
  // Scope and budget are Host-owned; no model request may smuggle either into a closed tool.
  const forbidden=new Set(['tenantId','accountId','channelAccountId','conversationId','customerId','scope','budgets','maxSteps','maxToolCalls','maxEvidenceItems','maxEvidenceBytes','maxReadBytes','maxCandidateItems','maxEvidenceTokens','maxConsecutiveNoNewEvidence','maxElapsedMs']);
  const detached=detachedData(value) as Record<string,unknown>;
  const allowed=REQUEST_FIELDS[tool];
  if(Reflect.ownKeys(detached).some(key=>typeof key!=='string'||forbidden.has(key)||!allowed.includes(key)))fail('REQUEST_FIELD');
  const has=(field:string):boolean=>Object.prototype.hasOwnProperty.call(detached,field)&&detached[field]!==undefined;
  const scalarString=(field:string,max:number):void=>{const value=detached[field];if(typeof value!=='string'||value.trim()===''||bytes(value)>max)fail(`REQUEST_${field.toUpperCase()}`);};
  const optionalString=(field:string,max:number):void=>{if(has(field))scalarString(field,max);};
  const requiredString=(field:string,max:number):void=>{if(!has(field))fail(`REQUEST_${field.toUpperCase()}`);scalarString(field,max);};
  const requestLimit=():void=>{if(has('limit')){const limit=detached.limit;if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1||limit>50)fail('REQUEST_LIMIT');}};
  requestLimit();
  switch(tool){
    case 'conversation_recent':break;
    case 'conversation_search':requiredString('query',512);break;
    case 'conversation_find_sections':optionalString('query',512);break;
    case 'conversation_open_section':requiredString('sectionId',256);break;
    case 'conversation_get_message':requiredString('messageId',256);break;
    case 'conversation_get_thread':requiredString('messageId',256);break;
    case 'conversation_find_by_date':requiredString('fromIso',64);requiredString('toIso',64);break;
    case 'conversation_goal_list':optionalString('query',512);break;
    case 'conversation_business_objects':optionalString('goalId',256);optionalString('objectType',256);optionalString('objectId',256);break;
    case 'conversation_retrieval_ladder':
      requiredString('layer',64);if(!['CURRENT_BUNDLE','RECENT_RAW','GOALS','SECTIONS','RAW_HISTORY','ATTACHMENTS','HISTORICAL_ERP'].includes(detached.layer as string))fail('REQUEST_LAYER');
      optionalString('query',512);optionalString('sectionId',256);optionalString('goalId',256);optionalString('objectType',256);optionalString('objectId',256);break;
  }
  return Object.freeze(detached);
}
type ValidatedToolRead={evidence:V3RetrievalLoopEvidence|null;readBytes:number;candidateItems:number;evidenceTokens:number;sourcePairs:readonly string[];dependencyUnits:readonly string[]};
// Conservative Host token estimate: one token per UTF-8 byte, so this never understates the budget charged here.
function sourceEvidence(result:unknown,tool:V3RetrievalLoopToolName,request:Readonly<Record<string,unknown>>,scope:V3RetrievalScope,indexVersion:string,scopeVersion:string):ValidatedToolRead{
  const snapshot=detachedData(result);if(!isRecord(snapshot))fail('EVIDENCE_SHAPE');
  const ids=new Set<string>(),refs=new Set<string>(),pairs=new Set<string>();
  let candidateItems=0;
  const dependencyLineage:Array<{context:string;key:string;value:unknown}>=[];
  const common=(value:Record<string,unknown>,version:'V3-RET-004'|'V3-RET-005',expectedTool:string,context:string):void=>{
    if(value.contractVersion!==version||value.schemaVersion!==1||value.tool!==expectedTool||value.authority!=='NON_AUTHORITATIVE_DERIVED'||value.deterministic!==true||value.bounded!==true)fail('EVIDENCE_CONTRACT');
    if(value.indexVersion!==indexVersion||value.scopeVersion!==scopeVersion||!exactScope(value.scopeLineage,scope))fail('EVIDENCE_SCOPE');
    for(const key of ['goalGraphFingerprint','bundleReplayIdentity','bundleRevision','conversationRevisionAtBuild'])if(key in value)dependencyLineage.push({context,key,value:value[key]});
  };
  const pair=(id:unknown,ref:unknown):void=>{const sourceMessageId=bounded(id,'EVIDENCE_SOURCE_ID'),sourceRef=bounded(ref,'EVIDENCE_SOURCE_REF');ids.add(sourceMessageId);refs.add(sourceRef);pairs.add(JSON.stringify([sourceMessageId,sourceRef]))};
  const parallel=(rawIds:unknown,rawRefs:unknown):void=>{if(!Array.isArray(rawIds)||!Array.isArray(rawRefs)||rawIds.length!==rawRefs.length)fail('EVIDENCE_SOURCE_PARALLEL');for(let i=0;i<rawIds.length;i++)pair(rawIds[i],rawRefs[i])};
  const messages=(value:unknown):void=>{if(!Array.isArray(value))fail('EVIDENCE_SHAPE');for(const message of value){if(!isRecord(message))fail('EVIDENCE_SHAPE');candidateItems++;pair(message.sourceMessageId,message.sourceRef)}};
  const ret4=(value:unknown,expectedTool?:V3RetrievalLoopToolName):void=>{
    if(!isRecord(value))fail('EVIDENCE_SHAPE');const nestedTool=expectedTool??(value.tool as V3RetrievalLoopToolName);if(expectedTool!==undefined)common(value,'V3-RET-004',nestedTool,'result.payload');
    switch(nestedTool){case 'conversation_recent':case 'conversation_open_section':case 'conversation_get_thread':case 'conversation_find_by_date':messages(value.messages);break;case 'conversation_search':if(!Array.isArray(value.hits))fail('EVIDENCE_SHAPE');for(const hit of value.hits){if(!isRecord(hit))fail('EVIDENCE_SHAPE');messages([hit.message])}break;case 'conversation_find_sections':if(!Array.isArray(value.sections))fail('EVIDENCE_SHAPE');for(const section of value.sections){if(!isRecord(section))fail('EVIDENCE_SHAPE');candidateItems++;parallel(section.sourceMessageIds,section.sourceRefs)}break;case 'conversation_get_message':messages([value.message]);break;default:fail('EVIDENCE_TOOL');}
  };
  const expectedVersion=tool==='conversation_goal_list'||tool==='conversation_business_objects'||tool==='conversation_retrieval_ladder'?'V3-RET-005':'V3-RET-004';
  common(snapshot,expectedVersion,tool,'root');
  if(expectedVersion==='V3-RET-004')ret4(snapshot);
  else if(tool==='conversation_goal_list'||tool==='conversation_business_objects'){
    const key=tool==='conversation_goal_list'?'goals':'objects';if(!Array.isArray(snapshot[key]))fail('EVIDENCE_SHAPE');for(const item of snapshot[key] as unknown[]){if(!isRecord(item))fail('EVIDENCE_SHAPE');candidateItems++;parallel(item.sourceMessageIds,item.sourceRefs)}
  }else if(tool==='conversation_retrieval_ladder'){
    if(!isRecord(snapshot.result)||typeof snapshot.requestedLayer!=='string'||snapshot.requestedLayer!==request.layer||snapshot.result.layer!==snapshot.requestedLayer)fail('EVIDENCE_SHAPE');
    const payload=snapshot.result.payload;
    switch(snapshot.requestedLayer){
      case 'CURRENT_BUNDLE':if(!isRecord(payload))fail('EVIDENCE_SHAPE');messages(payload.messages);break;
      case 'RECENT_RAW':ret4(payload,'conversation_recent');break;
      case 'SECTIONS':ret4(payload,'conversation_find_sections');break;
      case 'RAW_HISTORY':{
        if(!isRecord(payload)||!['conversation_open_section','conversation_search'].includes(payload.tool as string))fail('EVIDENCE_TOOL');
        ret4(payload,payload.tool as 'conversation_open_section'|'conversation_search');break;
      }
      case 'GOALS':{if(!isRecord(payload))fail('EVIDENCE_SHAPE');common(payload,'V3-RET-005','conversation_goal_list','result.payload');if(!Array.isArray(payload.goals))fail('EVIDENCE_SHAPE');for(const item of payload.goals as unknown[]){if(!isRecord(item))fail('EVIDENCE_SHAPE');candidateItems++;parallel(item.sourceMessageIds,item.sourceRefs)}break;}
      case 'ATTACHMENTS':{if(!isRecord(payload)||!Array.isArray(payload.attachments))fail('EVIDENCE_SHAPE');for(const attachment of payload.attachments as unknown[]){if(!isRecord(attachment))fail('EVIDENCE_SHAPE');candidateItems++;const sourceMessageId=bounded(attachment.sourceMessageId,'EVIDENCE_SOURCE_ID');pair(sourceMessageId,attachment.messageSourceRef);if('sourceRef'in attachment){const sourceRef=bounded(attachment.sourceRef,'EVIDENCE_SOURCE_REF');refs.add(sourceRef);pairs.add(JSON.stringify([sourceMessageId,sourceRef]));}}break;}
      case 'HISTORICAL_ERP':{if(!isRecord(payload)||!Array.isArray(payload.objects))fail('EVIDENCE_SHAPE');for(const item of payload.objects as unknown[]){if(!isRecord(item))fail('EVIDENCE_SHAPE');candidateItems++;parallel(item.sourceMessageIds,item.sourceRefs)}break;}
      default:fail('EVIDENCE_LAYER');
    }
  }else fail('EVIDENCE_TOOL');
  const sourceMessageIds=[...ids].sort(),sourceRefs=[...refs].sort(),sourcePairValues=[...pairs].map(pair=>JSON.parse(pair) as [string,string]).sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
  const sourcePairUnits=sourcePairValues.map(pair=>JSON.stringify(pair));
  const dependencyUnits=dependencyLineage.map(unit=>canonicalSha256(unit)).sort();
  const payload=JSON.stringify(snapshot);
  if(typeof payload!=='string')fail('EVIDENCE_SERIALIZATION');
  const readBytes=bytes(payload),evidenceTokens=readBytes;
  if(sourceMessageIds.length===0&&sourceRefs.length===0)return {evidence:null,readBytes,candidateItems,evidenceTokens,sourcePairs:[],dependencyUnits:[]};
  const identity=canonicalSha256({indexVersion,scopeVersion,scopeLineage:SCOPE_FIELDS.map(field=>[field,scope[field]]),sourcePairs:sourcePairValues,dependencyLineage:dependencyLineage.sort((a,b)=>a.context.localeCompare(b.context)||a.key.localeCompare(b.key))});
  return {evidence:{fingerprint:identity,sourceMessageIds,sourceRefs,bytes:readBytes},readBytes,candidateItems,evidenceTokens,sourcePairs:sourcePairUnits,dependencyUnits};
}
function immutableState(state:{steps:number;toolCalls:number;evidence:V3RetrievalLoopEvidence[];evidenceBytes:number;readBytes:number;candidateItems:number;evidenceTokens:number;consecutiveNoNewEvidence:number;stopReason:string|null}):V3RetrievalLoopState{
  return freeze({contractVersion:'V3-RET-006' as const,steps:state.steps,toolCalls:state.toolCalls,evidenceItems:state.evidence.length,evidenceBytes:state.evidenceBytes,readBytes:state.readBytes,candidateItems:state.candidateItems,evidenceTokens:state.evidenceTokens,consecutiveNoNewEvidence:state.consecutiveNoNewEvidence,evidence:[...state.evidence],stopReason:state.stopReason});
}
function outcome(outcome:'SUCCESS'|'CLARIFY'|'ABSTAIN',reason:string,state:V3RetrievalLoopState,clarification:V3RetrievalLoopClarification|null=null):V3RetrievalLoopOutcome{
  return freeze({contractVersion:'V3-RET-006' as const,schemaVersion:1 as const,outcome,stopReason:reason,state,clarification});
}

export function runV3RetrievalLoop(input:V3RetrievalLoopOptions):V3RetrievalLoopOutcome{
  if(!isRecord(input)||!isRecord(input.budgets)||!isRecord(input.scope))fail('OPTIONS_SHAPE');
  const budget=(key:keyof typeof ABSOLUTE_BUDGET_CAPS)=>{const value=positive(input.budgets[key],key.toUpperCase());if(value>ABSOLUTE_BUDGET_CAPS[key])fail(`${key.toUpperCase()}_CAP`);return value};
  const budgets=Object.freeze({maxSteps:budget('maxSteps'),maxToolCalls:budget('maxToolCalls'),maxEvidenceItems:budget('maxEvidenceItems'),maxEvidenceBytes:budget('maxEvidenceBytes'),maxReadBytes:budget('maxReadBytes'),maxCandidateItems:budget('maxCandidateItems'),maxEvidenceTokens:budget('maxEvidenceTokens'),maxConsecutiveNoNewEvidence:budget('maxConsecutiveNoNewEvidence'),maxElapsedMs:budget('maxElapsedMs')});
  const expectedScope=validateScope(input.scope,'SCOPE'),indexVersion=bounded(input.indexVersion,'INDEX_VERSION'),scopeVersion=bounded(input.scopeVersion,'SCOPE_VERSION');
  const stateData={steps:0,toolCalls:0,evidence:[] as V3RetrievalLoopEvidence[],evidenceBytes:0,readBytes:0,candidateItems:0,evidenceTokens:0,consecutiveNoNewEvidence:0,stopReason:null as string|null};
  const seenSourcePairs=new Set<string>(),seenDependencyUnits=new Set<string>();
  const clock=input.clock??Date.now,started=clock();
  if(!Number.isFinite(started))fail('CLOCK');
  const current=()=>immutableState(stateData);
  const elapsed=():boolean=>{const now=clock();if(!Number.isFinite(now))fail('CLOCK');return now-started>=budgets.maxElapsedMs;};
  while(true){
    const before=current();
    if(elapsed())return outcome('ABSTAIN','ELAPSED_TIME_BUDGET',immutableState({...stateData,stopReason:'ELAPSED_TIME_BUDGET'}));
    if(stateData.steps>=budgets.maxSteps)return outcome('ABSTAIN','MAX_STEPS',immutableState({...stateData,stopReason:'MAX_STEPS'}));
    if(stateData.toolCalls>=budgets.maxToolCalls)return outcome('ABSTAIN','MAX_TOOL_CALLS',immutableState({...stateData,stopReason:'MAX_TOOL_CALLS'}));
    let action:V3RetrievalLoopAction|null;
    let rawAction:V3RetrievalLoopAction|null;
    try{rawAction=input.nextAction(before);}catch{if(elapsed())return outcome('ABSTAIN','ELAPSED_TIME_BUDGET',immutableState({...stateData,stopReason:'ELAPSED_TIME_BUDGET'}));return outcome('ABSTAIN','INVALID_MODEL_ACTION',immutableState({...stateData,stopReason:'INVALID_MODEL_ACTION'}))}
    if(elapsed())return outcome('ABSTAIN','ELAPSED_TIME_BUDGET',immutableState({...stateData,stopReason:'ELAPSED_TIME_BUDGET'}));
    try{action=plainAction(rawAction);}catch{return outcome('ABSTAIN','INVALID_MODEL_ACTION',immutableState({...stateData,stopReason:'INVALID_MODEL_ACTION'}))}
    if(action===null)return outcome('ABSTAIN','NO_ACTION',immutableState({...stateData,stopReason:'NO_ACTION'}));
    if(action.kind==='CLARIFY'){
      if(typeof action.missingFact!=='string'||typeof action.question!=='string')return outcome('ABSTAIN','INVALID_CLARIFICATION',immutableState({...stateData,stopReason:'INVALID_CLARIFICATION'}));
      let clarification:V3RetrievalLoopClarification;
      try{clarification=freeze({missingFact:bounded(action.missingFact,'MISSING_FACT'),question:bounded(action.question,'QUESTION')});}catch{return outcome('ABSTAIN','INVALID_CLARIFICATION',immutableState({...stateData,stopReason:'INVALID_CLARIFICATION'}));}
      let allowed=true;try{if(input.allowClarification){const returned=input.allowClarification(clarification,before);if(typeof returned!=='boolean')fail('CLARIFICATION_RETURN');allowed=returned;}}catch{if(elapsed())return outcome('ABSTAIN','ELAPSED_TIME_BUDGET',immutableState({...stateData,stopReason:'ELAPSED_TIME_BUDGET'}));return outcome('ABSTAIN','CLARIFICATION_FAILURE',immutableState({...stateData,stopReason:'CLARIFICATION_FAILURE'}));}
      if(elapsed())return outcome('ABSTAIN','ELAPSED_TIME_BUDGET',immutableState({...stateData,stopReason:'ELAPSED_TIME_BUDGET'}));
      if(!allowed)return outcome('ABSTAIN','CLARIFICATION_NOT_ALLOWED',immutableState({...stateData,stopReason:'CLARIFICATION_NOT_ALLOWED'}));
      return outcome('CLARIFY','MODEL_DECLARED_MISSING_FACT',immutableState({...stateData,stopReason:'MODEL_DECLARED_MISSING_FACT'}),clarification);
    }
    if(action.kind==='FINAL')return outcome('ABSTAIN','INSUFFICIENT_EVIDENCE',immutableState({...stateData,stopReason:'INSUFFICIENT_EVIDENCE'}));
    if(!action.tool||!V3_RETRIEVAL_LOOP_TOOLS.includes(action.tool))return outcome('ABSTAIN','INVALID_MODEL_ACTION',immutableState({...stateData,stopReason:'INVALID_MODEL_ACTION'}));
    let request:Readonly<Record<string,unknown>>;
    try{request=validateRequest(action.request??{},action.tool);}catch{return outcome('ABSTAIN','INVALID_MODEL_ACTION',immutableState({...stateData,stopReason:'INVALID_MODEL_ACTION'}))}
    if(elapsed())return outcome('ABSTAIN','ELAPSED_TIME_BUDGET',immutableState({...stateData,stopReason:'ELAPSED_TIME_BUDGET'}));
    const tool=input.tools[action.tool];
    if(typeof tool!=='function')return outcome('ABSTAIN','TOOL_UNAVAILABLE',immutableState({...stateData,stopReason:'TOOL_UNAVAILABLE'}));
    stateData.steps++;stateData.toolCalls++;
    let read:ValidatedToolRead;
    try{const returned=tool(request);read=sourceEvidence(returned,action.tool,request,expectedScope,indexVersion,scopeVersion);}catch{if(elapsed())return outcome('ABSTAIN','ELAPSED_TIME_BUDGET',immutableState({...stateData,stopReason:'ELAPSED_TIME_BUDGET'}));return outcome('ABSTAIN','INVALID_EVIDENCE',immutableState({...stateData,stopReason:'INVALID_EVIDENCE'}));}
    if(elapsed())return outcome('ABSTAIN','ELAPSED_TIME_BUDGET',immutableState({...stateData,stopReason:'ELAPSED_TIME_BUDGET'}));
    stateData.readBytes+=read.readBytes;stateData.evidenceTokens+=read.evidenceTokens;stateData.candidateItems+=read.candidateItems;
    if(stateData.readBytes>budgets.maxReadBytes)return outcome('ABSTAIN','READ_BYTE_BUDGET',immutableState({...stateData,stopReason:'READ_BYTE_BUDGET'}));
    if(stateData.evidenceTokens>budgets.maxEvidenceTokens)return outcome('ABSTAIN','EVIDENCE_TOKEN_BUDGET',immutableState({...stateData,stopReason:'EVIDENCE_TOKEN_BUDGET'}));
    if(stateData.candidateItems>budgets.maxCandidateItems)return outcome('ABSTAIN','CANDIDATE_ITEM_BUDGET',immutableState({...stateData,stopReason:'CANDIDATE_ITEM_BUDGET'}));
    const evidence=read.evidence;
    if(evidence===null){stateData.consecutiveNoNewEvidence++;if(stateData.consecutiveNoNewEvidence>=budgets.maxConsecutiveNoNewEvidence)return outcome('ABSTAIN','NO_NEW_EVIDENCE',immutableState({...stateData,stopReason:'NO_NEW_EVIDENCE'}));continue;}
    const hasNewSourcePair=read.sourcePairs.some(unit=>!seenSourcePairs.has(unit));
    const hasNewDependency=read.dependencyUnits.some(unit=>!seenDependencyUnits.has(unit));
    if(hasNewSourcePair||hasNewDependency){
      if(stateData.evidence.length+1>budgets.maxEvidenceItems||stateData.evidence.reduce((sum,item)=>sum+item.bytes,0)+evidence.bytes>budgets.maxEvidenceBytes)return outcome('ABSTAIN','EVIDENCE_BUDGET',immutableState({...stateData,stopReason:'EVIDENCE_BUDGET'}));
      stateData.evidence.push(evidence);stateData.evidenceBytes+=evidence.bytes;stateData.consecutiveNoNewEvidence=0;
      for(const unit of read.sourcePairs)seenSourcePairs.add(unit);
      for(const unit of read.dependencyUnits)seenDependencyUnits.add(unit);
      const after=current();let sufficient=false;try{const returned=input.isSufficient(after.evidence,after);if(typeof returned!=='boolean')fail('SUFFICIENCY_RETURN');sufficient=returned;}catch{if(elapsed())return outcome('ABSTAIN','ELAPSED_TIME_BUDGET',immutableState({...stateData,stopReason:'ELAPSED_TIME_BUDGET'}));return outcome('ABSTAIN','HOST_SUFFICIENCY_FAILURE',immutableState({...stateData,stopReason:'HOST_SUFFICIENCY_FAILURE'}))}if(elapsed())return outcome('ABSTAIN','ELAPSED_TIME_BUDGET',immutableState({...stateData,stopReason:'ELAPSED_TIME_BUDGET'}));if(sufficient){const sufficientState=immutableState({...stateData,stopReason:'SUFFICIENT_EVIDENCE'});return outcome('SUCCESS','SUFFICIENT_EVIDENCE',sufficientState);}
    }else stateData.consecutiveNoNewEvidence++;
    if(stateData.consecutiveNoNewEvidence>=budgets.maxConsecutiveNoNewEvidence)return outcome('ABSTAIN','NO_NEW_EVIDENCE',immutableState({...stateData,stopReason:'NO_NEW_EVIDENCE'}));
  }
}
