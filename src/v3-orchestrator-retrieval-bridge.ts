import { createHash } from 'node:crypto';
import { runV3RetrievalLoop, V3_RETRIEVAL_LOOP_TOOLS, type V3RetrievalLoopBudgets, type V3RetrievalLoopToolName } from './v3-retrieval-loop.js';
import type { V3RetrievalScope } from './v3-retrieval-index.js';

export type V3OrchestratorRetrievalTrace = Readonly<{sequence:number;tool:V3RetrievalLoopToolName;depth:number;resultClass:'EVIDENCE'|'NO_EVIDENCE'|'REJECTED'|'BUDGET_STOP';stopReason:string}>;
export type V3OrchestratorRetrievalBudgets = Readonly<V3RetrievalLoopBudgets & {maxDepth:number}>;
export type V3OrchestratorRetrievalSessionOptions = Readonly<{scope:V3RetrievalScope;indexVersion:string;scopeVersion:string;budgets:V3OrchestratorRetrievalBudgets;tools:Readonly<Partial<Record<V3RetrievalLoopToolName,(request:Readonly<Record<string,unknown>>)=>unknown>>>}>;
const allowed=new Set<string>(V3_RETRIEVAL_LOOP_TOOLS);
const freeze=<T>(value:T):T=>Object.freeze(value);

/** Host-owned per-Pi-turn retrieval budget/trace bridge; it never proposes a V2 action. */
export class V3OrchestratorRetrievalSession {
  private calls=0; private steps=0; private evidenceItems=0; private evidenceBytes=0; private readBytes=0; private candidateItems=0; private evidenceTokens=0; private depth=0; private noNew=0; private readonly startedAt=Date.now(); private readonly seen=new Set<string>(); private readonly trace:V3OrchestratorRetrievalTrace[]=[];
  constructor(private readonly options:V3OrchestratorRetrievalSessionOptions){}
  names():readonly string[]{return [...allowed].filter(name=>typeof this.options.tools[name as V3RetrievalLoopToolName]==='function');}
  traces():readonly V3OrchestratorRetrievalTrace[]{return this.trace.map(item=>freeze({...item}));}
  usage(){return freeze({calls:this.calls,steps:this.steps,evidenceItems:this.evidenceItems,evidenceBytes:this.evidenceBytes,readBytes:this.readBytes,candidateItems:this.candidateItems,evidenceTokens:this.evidenceTokens,depth:this.depth,noNewEvidence:this.noNew,elapsedMs:Math.max(0,Date.now()-this.startedAt),traceItems:this.trace.length});}
  async execute(tool:string,request:unknown):Promise<unknown>{
    if(!allowed.has(tool)||typeof this.options.tools[tool as V3RetrievalLoopToolName]!=='function')throw new Error('V3_RETRIEVAL_UNAVAILABLE');
    const b=this.options.budgets;
    const remainingElapsed=b.maxElapsedMs-(Date.now()-this.startedAt);
    if(this.steps>=b.maxSteps||this.calls>=b.maxToolCalls||this.depth>=b.maxDepth||remainingElapsed<=0){this.record(tool as V3RetrievalLoopToolName,'BUDGET_STOP','RETRIEVAL_BUDGET_EXHAUSTED',this.calls+1,this.depth+1);throw new Error('V3_RETRIEVAL_BUDGET_EXHAUSTED');}
    const name=tool as V3RetrievalLoopToolName;
    const used:Record<keyof V3RetrievalLoopBudgets,number>={maxSteps:this.steps,maxToolCalls:this.calls,maxEvidenceItems:this.evidenceItems,maxEvidenceBytes:this.evidenceBytes,maxReadBytes:this.readBytes,maxCandidateItems:this.candidateItems,maxEvidenceTokens:this.evidenceTokens,maxConsecutiveNoNewEvidence:this.noNew,maxElapsedMs:Date.now()-this.startedAt};
    const aggregateBudgetKeys:readonly (keyof V3RetrievalLoopBudgets)[]=['maxEvidenceItems','maxEvidenceBytes','maxReadBytes','maxCandidateItems','maxEvidenceTokens'];
    const aggregateBudgetExhausted=aggregateBudgetKeys.some(key=>used[key]>=b[key]);
    if(aggregateBudgetExhausted){this.record(name,'BUDGET_STOP','RETRIEVAL_BUDGET_EXHAUSTED',this.calls+1,this.depth+1);throw new Error('V3_RETRIEVAL_BUDGET_EXHAUSTED');}
    const remaining=(key:keyof V3RetrievalLoopBudgets)=>Math.max(1,b[key]-used[key]);
    let outcome;
    try { outcome=runV3RetrievalLoop({scope:this.options.scope,indexVersion:this.options.indexVersion,scopeVersion:this.options.scopeVersion,budgets:{maxSteps:1,maxToolCalls:1,maxEvidenceItems:remaining('maxEvidenceItems'),maxEvidenceBytes:remaining('maxEvidenceBytes'),maxReadBytes:remaining('maxReadBytes'),maxCandidateItems:remaining('maxCandidateItems'),maxEvidenceTokens:remaining('maxEvidenceTokens'),maxConsecutiveNoNewEvidence:Math.max(1,b.maxConsecutiveNoNewEvidence-this.noNew),maxElapsedMs:Math.max(1,remainingElapsed)},nextAction:()=>({kind:'RETRIEVE',tool:name,request:request as Readonly<Record<string,unknown>>}),tools:this.options.tools,isSufficient:()=>false}); }
    catch { this.calls++;this.steps++;this.depth++;this.record(name,'REJECTED','INVALID_EVIDENCE',this.calls,this.depth);throw new Error('V3_RETRIEVAL_FAILED'); }
    this.calls++;this.steps++;this.depth++;
    this.readBytes+=outcome.state.readBytes;this.candidateItems+=outcome.state.candidateItems;this.evidenceTokens+=outcome.state.evidenceTokens;
    const fingerprint=outcome.state.evidence[0]?.fingerprint;const isNew=fingerprint!==undefined&&!this.seen.has(fingerprint);
    if(isNew){this.seen.add(fingerprint);this.evidenceItems++;this.evidenceBytes+=outcome.state.evidence[0].bytes;this.noNew=0;}else this.noNew++;
    // A one-step RET-006 invocation normally ends with MAX_STEPS/MAX_TOOL_CALLS
    // after the requested tool has already been validated. Those are not
    // failures for this one-call bridge; the session preflight owns aggregate
    // exhaustion before the next call.
    const budgetStop=['EVIDENCE_BUDGET','READ_BYTE_BUDGET','CANDIDATE_ITEM_BUDGET','EVIDENCE_TOKEN_BUDGET','ELAPSED_TIME_BUDGET'].includes(outcome.stopReason);
    const noNewStop=outcome.stopReason==='NO_NEW_EVIDENCE'||this.noNew>=b.maxConsecutiveNoNewEvidence;
    const rejectedStop=['INVALID_MODEL_ACTION','TOOL_UNAVAILABLE','INVALID_EVIDENCE','HOST_SUFFICIENCY_FAILURE'].includes(outcome.stopReason);
    const resultClass=budgetStop||noNewStop?'BUDGET_STOP':rejectedStop?'REJECTED':isNew?'EVIDENCE':'NO_EVIDENCE';
    this.record(name,resultClass,noNewStop?'NO_NEW_EVIDENCE':outcome.stopReason,this.calls,this.depth);
    if(budgetStop)throw new Error('V3_RETRIEVAL_BUDGET_EXHAUSTED');
    if(noNewStop)throw new Error('V3_RETRIEVAL_NO_NEW_EVIDENCE');
    if(resultClass==='REJECTED')throw new Error('V3_RETRIEVAL_FAILED');
    return outcome;
  }
  private record(tool:V3RetrievalLoopToolName,resultClass:V3OrchestratorRetrievalTrace['resultClass'],stopReason:string,sequence:number,depth:number){this.trace.push(freeze({sequence,tool,depth,resultClass,stopReason}));if(this.trace.length>this.options.budgets.maxSteps)this.trace.splice(0,this.trace.length-this.options.budgets.maxSteps);}
}
