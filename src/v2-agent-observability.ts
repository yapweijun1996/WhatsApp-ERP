import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { redactContextText } from './v2-context-projection.js';

const MAX_JSON_CHARS = 48_000;
const MAX_TRACE_CALLS = 24;
const SENSITIVE_KEY = /(authorization|api[_-]?key|password|passwd|pwd|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|phone|senderexternalid)/i;

function fail(code:string):never{throw new Error(`AGENT_TRACE_INVALID:${code}`)}
function plain(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype}
function boundedText(value:string,max=12_000){const clean=redactContextText(value);return clean.length<=max?clean:clean.slice(0,max)+'…[TRUNCATED]'}
function sanitize(value:unknown,depth=0):unknown{
  if(depth>12)return '[TRUNCATED_DEPTH]';
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:'[NON_FINITE]';
  if(typeof value==='string')return boundedText(value);
  if(Array.isArray(value))return value.slice(0,100).map(item=>sanitize(item,depth+1));
  if(plain(value)){
    const out:Record<string,unknown>={};
    for(const [key,child] of Object.entries(value).slice(0,120)) out[key]=SENSITIVE_KEY.test(key)?'[REDACTED]':sanitize(child,depth+1);
    return out;
  }
  return '[UNSUPPORTED]';
}
function safeJson(value:unknown):string{
  const text=JSON.stringify(sanitize(value));
  if(text.length>MAX_JSON_CHARS) return JSON.stringify({truncated:true,preview:boundedText(text,MAX_JSON_CHARS-200)});
  return text;
}
function parseStored(raw:unknown):unknown{if(typeof raw!=='string'||raw.length>MAX_JSON_CHARS*2)return null;try{return sanitize(JSON.parse(raw))}catch{return null}}
function safeError(error:unknown):string{const raw=error instanceof Error?error.message:String(error);const clean=redactContextText(raw);return /^[A-Z0-9_:-]{1,160}$/.test(clean)?clean:'MODEL_ENDPOINT_FAILED'}

export type DemoEndpointTraceInput=Readonly<{
  turnId:string;
  attemptSequence:number;
  attemptKind:'MODEL'|'REPAIR';
  endpoint:string;
  model:string;
  requestBody:unknown;
  responseBody?:unknown;
  status:'SUCCEEDED'|'FAILED';
  errorCode?:string;
  latencyMs:number;
  inputTokens?:number;
  outputTokens?:number;
  totalTokens?:number;
}>;

export class AgentEndpointTraceRecorder{
  constructor(private readonly db:Database.Database){}
  latestAttempt(turnId:string){return this.db.prepare('SELECT sequence,attempt_kind FROM agent_model_attempts WHERE turn_id=? ORDER BY sequence DESC LIMIT 1').get(turnId) as {sequence:number;attempt_kind:'MODEL'|'REPAIR'}|undefined}
  record(input:DemoEndpointTraceInput){
    if(!input.turnId||!Number.isSafeInteger(input.attemptSequence)||input.attemptSequence<1)fail('SCOPE');
    const endpoint=boundedText(input.endpoint,500),model=boundedText(input.model,200),createdAt=new Date().toISOString();
    const requestJson=safeJson(input.requestBody),responseJson=input.responseBody===undefined?null:safeJson(input.responseBody);
    const latency=Math.max(0,Math.min(86_400_000,Math.round(Number(input.latencyMs)||0)));
    const token=(value:unknown)=>Math.max(0,Math.min(100_000_000,Math.round(Number(value)||0)));
    this.db.prepare(`INSERT INTO agent_endpoint_traces(id,turn_id,attempt_sequence,attempt_kind,endpoint,model,request_json,response_json,status,error_code,latency_ms,input_tokens,output_tokens,total_tokens,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(turn_id,attempt_sequence) DO NOTHING`).run(randomUUID(),input.turnId,input.attemptSequence,input.attemptKind,endpoint,model,requestJson,responseJson,input.status,input.errorCode?safeError(input.errorCode):null,latency,token(input.inputTokens),token(input.outputTokens),token(input.totalTokens),createdAt);
  }
}

function decisionSummary(response:unknown,request:unknown){
  const phase=plain(request)&&plain(request.input)&&plain(request.input.workflowState)?String(request.input.workflowState.phase??'GENERAL'):'GENERAL';
  if(plain(response)&&plain(response.output)){
    const out=response.output;
    if(out.kind==='tool_call'&&typeof out.name==='string')return `Workflow ${phase}: model selected capability ${boundedText(out.name,120)}.`;
    if(out.kind==='final_response'&&plain(out.responsePlan)&&typeof out.responsePlan.intent==='string')return `Workflow ${phase}: model selected ${boundedText(out.responsePlan.intent,80)} customer response.`;
  }
  return `Workflow ${phase}: model endpoint returned a bounded decision.`;
}

/** Read-only operator projection. It intentionally exposes no private chain-of-thought. */
export function projectAgentTrace(db:Database.Database,accountId:string,conversationId:string){
  const turns=db.prepare('SELECT id,status,terminal_reason,created_at,completed_at FROM agent_turns WHERE account_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 6').all(accountId,conversationId) as any[];
  const turnIds=turns.map(turn=>turn.id);
  if(!turnIds.length)return Object.freeze({privacyNotice:'Private chain-of-thought is not stored or exposed. This panel shows endpoint I/O, decisions, tools, results, and host state only.',turns:[],endpointCalls:[],actions:[]});
  const slots=turnIds.map(()=>'?').join(',');
  const calls=db.prepare(`SELECT t.* FROM agent_endpoint_traces t WHERE t.turn_id IN (${slots}) ORDER BY t.created_at DESC,t.attempt_sequence DESC LIMIT ?`).all(...turnIds,MAX_TRACE_CALLS) as any[];
  const actions=db.prepare(`SELECT a.id,a.turn_id,a.sequence,a.capability_name,a.arguments_json,a.created_at,r.result_json FROM agent_actions a LEFT JOIN agent_action_results r ON r.action_id=a.id WHERE a.turn_id IN (${slots}) ORDER BY a.created_at DESC,a.sequence DESC LIMIT 60`).all(...turnIds) as any[];
  const plans=new Map((db.prepare(`SELECT turn_id,plan_json FROM agent_response_plans WHERE turn_id IN (${slots})`).all(...turnIds) as any[]).map(row=>[row.turn_id,parseStored(row.plan_json)]));
  const projectedCalls=calls.map(row=>{
    const request=parseStored(row.request_json),response=parseStored(row.response_json);
    return Object.freeze({turnId:row.turn_id,attemptSequence:row.attempt_sequence,attemptKind:row.attempt_kind,endpoint:boundedText(row.endpoint,500),model:boundedText(row.model,200),status:row.status,errorCode:row.error_code??null,latencyMs:row.latency_ms,usage:{inputTokens:row.input_tokens,outputTokens:row.output_tokens,totalTokens:row.total_tokens},decisionSummary:decisionSummary(response,request),request,response,createdAt:row.created_at});
  });
  const projectedActions=actions.map(row=>{const result=parseStored(row.result_json) as any;return Object.freeze({turnId:row.turn_id,sequence:row.sequence,capability:boundedText(row.capability_name,120),arguments:parseStored(row.arguments_json),result:result?{status:result.status??'UNKNOWN',reasonCode:result.reasonCode??null,data:sanitize(result.data)}:null,createdAt:row.created_at});});
  const projectedTurns=turns.map(turn=>Object.freeze({id:turn.id,status:turn.status,terminalReason:turn.terminal_reason??null,responsePlan:plans.get(turn.id)??null,createdAt:turn.created_at,completedAt:turn.completed_at??null}));
  return Object.freeze({privacyNotice:'Private chain-of-thought is not stored or exposed. This panel shows endpoint I/O, decisions, tools, results, and host state only.',turns:projectedTurns,endpointCalls:projectedCalls,actions:projectedActions});
}

export function traceRequestBody(model:string,prompt:string){let input:unknown=boundedText(prompt,24_000);try{input=sanitize(JSON.parse(prompt))}catch{/* text-only fallback */}return sanitize({model,input});}
export function traceResponseBody(result:{text:string;responseId?:string;usage?:unknown}){let output:unknown=boundedText(result.text,16_000);try{output=sanitize(JSON.parse(result.text))}catch{/* text-only fallback */}return sanitize({responseId:result.responseId??null,usage:result.usage??null,output});}
export function traceFailureCode(error:unknown){return safeError(error)}
