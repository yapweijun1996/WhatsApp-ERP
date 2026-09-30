import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { DemoGatewaySession, type DemoGatewayConfig } from './gateway.js';
import { AgentEndpointTraceRecorder, traceFailureCode, traceRequestBody, traceResponseBody } from './v2-agent-observability.js';
import { redactContextText } from './v2-context-projection.js';

const MAX_PROMPT_CHARS=24_000;
function plain(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype}
function bounded(value:string,max:number){const redacted=redactContextText(value);return redacted.length<=max?redacted:redacted.slice(0,max)}
function latestUserText(context:any){const message=[...(context?.messages??[])].reverse().find((candidate:any)=>candidate?.role==='user');if(typeof message?.content==='string')return bounded(message.content,1500);if(Array.isArray(message?.content))return bounded(message.content.filter((part:any)=>part?.type==='text').map((part:any)=>String(part.text??'')).join('\n'),1500);return ''}
function workflowPhase(systemPrompt:string){const match=/"piHarnessWorkflow":\{"phase":"([A-Z0-9_:-]+)"/.exec(systemPrompt);return match?.[1]??'GENERAL'}
function turnId(systemPrompt:string){const match=/"turnId":"([^"\\]{1,160})"/.exec(systemPrompt);return match?.[1]}
function compactSchema(schema:any):string{
  if(!plain(schema))return 'json';
  if(Array.isArray(schema.enum))return schema.enum.map((item:unknown)=>String(item)).join('|');
  if(schema.type==='array')return `[${compactSchema(schema.items)}]`;
  if(schema.type==='object'){
    const properties=plain(schema.properties)?schema.properties:{};
    const required=new Set(Array.isArray(schema.required)?schema.required.filter((item:unknown):item is string=>typeof item==='string'):[]);
    return `{${Object.entries(properties).map(([name,child])=>`${name}${required.has(name)?'':'?'}:${compactSchema(child)}`).join(',')}}`;
  }
  if(schema.type==='integer')return 'int';
  if(['string','number','boolean'].includes(String(schema.type)))return String(schema.type);
  return 'json';
}
function toolGuides(context:any){return (context?.tools??[]).map((tool:any)=>({name:String(tool.name),description:bounded(String(tool.description??''),360),arguments:compactSchema(tool.parameters)}));}
function buildPrompt(context:any){
  const system=bounded(String(context?.systemPrompt??''),18_000),phase=workflowPhase(system),tools=toolGuides(context),expectedTurnId=turnId(system)??'';
  const requiredTool=phase!=='GENERAL'&&tools.length===1?tools[0].name:null;
  const finalOnly=phase!=='GENERAL'&&tools.length===0;
  const input={
    protocol:'PI_HARNESS_V1',workflowState:{phase,requiredTool,finalOnly},expectedTurnId,
    instruction:'Return exactly one plain JSON object, with no markdown/fences/prose outside JSON. Every decision MUST be one envelope: either {"kind":"tool_call","name":"...","arguments":{...}} or {"kind":"final_response","responsePlan":{...}}. Never output bare tool arguments and never concatenate multiple JSON objects. The tools array is exhaustive. If workflowState.requiredTool is non-null, you MUST return exactly {"kind":"tool_call","name":workflowState.requiredTool,"arguments":{...}} and a final response is invalid. If workflowState.finalOnly is true, you MUST return exactly {"kind":"final_response","responsePlan":{...}} and any tool call is invalid. Otherwise infer the customer goal semantically from the full supplied observation and choose at most one available tool or a final response. When an authorized listed capability can advance the customer-requested action, call the appropriate capability instead of merely saying you will do it; continue one tool at a time until the requested goal is complete, genuinely needs clarification, or no authorized capability can advance it. For final_response, responsePlan must have turnId=expectedTurnId; intent ANSWER|CLARIFY|HANDOFF|ACKNOWLEDGE; factClaims must be [] or exact grounded claim objects; outboundPurpose must be customer_reply|clarification|handoff|acknowledgement and map to intent. ACKNOWLEDGE uses factClaims:[]. safeReasonCode is optional for CLARIFY, required for HANDOFF, and forbidden for ANSWER/ACKNOWLEDGE; handoff is required only for HANDOFF; never use null. Natural connectiveText must not repeat quantities, numeric dates, prices, stock, document numbers, accepted/confirmed/draft/status claims, or other protected commercial facts; acknowledge them generically unless you provide valid grounded factClaims. Do not invent IDs, revisions or commercial facts. Tool arguments must exactly match the listed guide.',
    system,
    turnRequest:latestUserText(context),
    tools,
  };
  const text=JSON.stringify(input);
  if(text.length>MAX_PROMPT_CHARS)throw new Error('PI_DEMO_PROMPT_TOO_LARGE');
  return text;
}
function usage(result:any){return{input:result.usage?.inputTokens??0,output:result.usage?.outputTokens??0,cacheRead:0,cacheWrite:0,totalTokens:result.usage?.totalTokens??0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}
function baseMessage(model:Model<any>,result:any,stopReason:'stop'|'toolUse',content:any[]):AssistantMessage{return{role:'assistant',content,api:model.api,provider:model.provider,model:model.id,...(result.responseId?{responseId:result.responseId}:{}),usage:usage(result),stopReason,timestamp:Date.now()}}
function emitMessage(stream:any,message:AssistantMessage){
  const partial:any={...message,content:[],stopReason:'pending'};
  stream.push({type:'start',partial:{...partial}});
  message.content.forEach((block:any,index:number)=>{
    if(block.type==='text'){
      partial.content=[...partial.content,{type:'text',text:''}];
      stream.push({type:'text_start',contentIndex:index,partial:{...partial}});
      partial.content[index].text=block.text;
      stream.push({type:'text_delta',contentIndex:index,delta:block.text,partial:{...partial}});
      stream.push({type:'text_end',contentIndex:index,content:block.text,partial:{...partial}});
    }else if(block.type==='toolCall'){
      partial.content=[...partial.content,{type:'toolCall',id:block.id,name:block.name,arguments:{}}];
      stream.push({type:'toolcall_start',contentIndex:index,partial:{...partial}});
      const delta=JSON.stringify(block.arguments);
      stream.push({type:'toolcall_delta',contentIndex:index,delta,partial:{...partial}});
      partial.content[index].arguments=block.arguments;
      stream.push({type:'toolcall_end',contentIndex:index,toolCall:block,partial:{...partial}});
    }
  });
  stream.push({type:'done',reason:message.stopReason,message});stream.end(message);
}
function emitError(stream:any,model:Model<any>,reason:'error'|'aborted',code:string){const message:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:reason,errorMessage:code,timestamp:Date.now()};stream.push({type:'error',reason,error:message});stream.end(message)}
function parseEnvelope(raw:string,context:any):{kind:'tool_call';name:string;arguments:Record<string,unknown>}|{kind:'final_response';responsePlan:unknown}|null{
  let value:unknown;try{value=JSON.parse(raw)}catch{return null}if(!plain(value))return null;
  const system=String(context?.systemPrompt??''),phase=workflowPhase(system),available=[...(context?.tools??[])].map((tool:any)=>String(tool.name)),allowed=new Set(available);
  const requiredTool=phase!=='GENERAL'&&available.length===1?available[0]:null,finalOnly=phase!=='GENERAL'&&available.length===0;
  if(value.kind==='tool_call'&&typeof value.name==='string'&&allowed.has(value.name)&&plain(value.arguments)&&Object.keys(value).every(key=>['kind','name','arguments'].includes(key))){
    if(finalOnly||requiredTool&&value.name!==requiredTool)return null;
    return{kind:'tool_call',name:value.name,arguments:value.arguments};
  }
  if(value.kind==='final_response'&&value.responsePlan!==undefined&&Object.keys(value).every(key=>['kind','responsePlan'].includes(key))){
    if(requiredTool)return null;
    return{kind:'final_response',responsePlan:value.responsePlan};
  }
  // Native-style direct response-plan text is accepted only when no workflow tool is required.
  if(!requiredTool&&('turnId' in value)&&('intent' in value)&&('factClaims' in value)&&('outboundPurpose' in value))return{kind:'final_response',responsePlan:value};
  return null;
}

export function createPiDemoStream(input:{session:DemoGatewaySession;config:DemoGatewayConfig;trace?:AgentEndpointTraceRecorder}):StreamFn{
  return ((model:Model<any>,context:any,options?:any)=>{
    const stream=createAssistantMessageEventStream();
    void(async()=>{
      let prompt='';const started=Date.now(),endpoint=`${input.config.baseUrl}/demo/v1/responses`;
      try{
        prompt=buildPrompt(context);const id=turnId(String(context?.systemPrompt??''));
        const attempt=id?input.trace?.latestAttempt(id):undefined;
        const result=await input.session.completeText(prompt,options?.signal);
        if(id&&attempt&&input.trace)try{input.trace.record({turnId:id,attemptSequence:attempt.sequence,attemptKind:attempt.attempt_kind,endpoint,model:input.config.model,requestBody:traceRequestBody(input.config.model,prompt),responseBody:traceResponseBody(result),status:'SUCCEEDED',latencyMs:Date.now()-started,inputTokens:result.usage?.inputTokens,outputTokens:result.usage?.outputTokens,totalTokens:result.usage?.totalTokens})}catch{/* observability is non-authoritative */}
        const envelope=parseEnvelope(result.text,context);
        if(envelope?.kind==='tool_call'){
          emitMessage(stream,baseMessage(model,result,'toolUse',[{type:'toolCall',id:`pi-demo-${randomUUID()}`,name:envelope.name,arguments:envelope.arguments}]));return;
        }
        if(envelope?.kind==='final_response'){
          emitMessage(stream,baseMessage(model,result,'stop',[{type:'text',text:JSON.stringify(envelope.responsePlan)}]));return;
        }
        // Preserve malformed model output as text so V2PiRuntime can use its
        // single bounded repair turn instead of converting it into a provider error.
        emitMessage(stream,baseMessage(model,result,'stop',[{type:'text',text:bounded(result.text,8_000)}]));
      }catch(error){
        const id=turnId(String(context?.systemPrompt??'')),attempt=id?input.trace?.latestAttempt(id):undefined;
        if(id&&attempt&&input.trace)try{input.trace.record({turnId:id,attemptSequence:attempt.sequence,attemptKind:attempt.attempt_kind,endpoint,model:input.config.model,requestBody:traceRequestBody(input.config.model,prompt||'[PROMPT_BUILD_FAILED]'),status:'FAILED',errorCode:traceFailureCode(error),latencyMs:Date.now()-started})}catch{/* observability is non-authoritative */}
        emitError(stream,model,options?.signal?.aborted?'aborted':'error',options?.signal?.aborted?'PI_DEMO_ABORTED':'PI_DEMO_STREAM_FAILED');
      }
    })();
    return stream;
  }) as StreamFn;
}
