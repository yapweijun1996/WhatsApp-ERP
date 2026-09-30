/** V3-GOAL-003: shadow-only Host admission for Agent goal proposals. */
import type {V1Database} from './database.js';
import {buildConversationGoal, validateConversationGoal, CONVERSATION_GOAL_STATUSES, type ConversationGoal, type ConversationGoalStatus} from './v3-conversation-goal.js';
import {V3GoalGraphStore, type GoalGraphScope, type V3GoalEventType} from './v3-goal-graph.js';

export const V3_GOAL_PROPOSAL_OPERATIONS=['CREATE','UPDATE','SUPERSEDE','CANCEL'] as const;
export type V3GoalProposalOperation=typeof V3_GOAL_PROPOSAL_OPERATIONS[number];
type Expected=Readonly<{goalId:string|null;revision:number|null;status:ConversationGoalStatus|null}>;
/** Exact Agent-owned semantic proposal. Host identity, replay, and time are deliberately absent. */
export type V3GoalProposal=Readonly<{scope:GoalGraphScope;operation:V3GoalProposalOperation;expected:Expected;goal:ConversationGoal}>;
/** Exact Host-owned admission envelope. Its createdAt is the persisted ledger/order timestamp. */
export type V3GoalProposalHostEnvelope=Readonly<{proposalId:string;idempotencyKey:string;createdAt:string}>;

const ACTIVE_STATUSES=['OPEN','IN_PROGRESS','NEEDS_CLARIFICATION','WAITING_EXTERNAL','BLOCKED_BY_AUTHORITY'] as const;
const fail=(code:string):never=>{throw Error(`V3_GOAL_PROPOSAL_INVALID:${code}`)};
const text=(v:unknown,c:string):string=>{if(typeof v!=='string'||v.trim()===''||v.length>512)fail(c);return v as string};
function exact(v:unknown,required:readonly string[]):Record<string,unknown>{
  if(v===null||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('INPUT_SHAPE');
  const object=v as object, keys=Reflect.ownKeys(object), allowed=new Set(required);
  if(keys.some(k=>typeof k!=='string'||!allowed.has(k))||required.some(k=>!keys.includes(k)))fail('INPUT_SHAPE');
  const out:Record<string,unknown>={};
  for(const key of required) if(keys.includes(key)) {
    const descriptor=Object.getOwnPropertyDescriptor(object,key);
    if(!descriptor||descriptor.enumerable!==true||!Object.prototype.hasOwnProperty.call(descriptor,'value'))fail('INPUT_SHAPE');
    out[key]=(descriptor as PropertyDescriptor & {value:unknown}).value;
  }
  return out;
}
const status=(v:unknown,c:string):ConversationGoalStatus=>{if(!CONVERSATION_GOAL_STATUSES.includes(v as ConversationGoalStatus))fail(c);return v as ConversationGoalStatus};
const operationEvent=(op:V3GoalProposalOperation):V3GoalEventType=>op==='CREATE'?'CREATED':op==='UPDATE'?'UPDATED':op==='SUPERSEDE'?'SUPERSEDED':'CANCELLED';
const active=(value:ConversationGoalStatus|null):boolean=>value!==null&&ACTIVE_STATUSES.includes(value as typeof ACTIVE_STATUSES[number]);

function parseProposal(value:unknown):V3GoalProposal{
  const p=exact(value,['scope','operation','expected','goal']);
  const scope=exact(p.scope,['accountId','conversationId']) as GoalGraphScope;
  const operation=p.operation; if(!V3_GOAL_PROPOSAL_OPERATIONS.includes(operation as V3GoalProposalOperation))fail('OPERATION');
  const e=exact(p.expected,['goalId','revision','status']);
  const expected:Expected={goalId:e.goalId===null?null:text(e.goalId,'EXPECTED_GOAL_ID'),revision:e.revision===null?null:e.revision as number,status:e.status===null?null:status(e.status,'EXPECTED_STATUS')};
  if(expected.revision!==null&&(!Number.isSafeInteger(expected.revision)||expected.revision<1))fail('EXPECTED_REVISION');
  const goal=validateConversationGoal(p.goal);
  if(goal.accountId!==scope.accountId||goal.conversationId!==scope.conversationId)fail('SCOPE');
  if(operation==='CREATE'){
    if(expected.goalId!==null||expected.revision!==null||expected.status!==null||goal.status!=='OPEN')fail('CREATE_EXPECTATION');
  } else if(expected.goalId===null||expected.revision===null||expected.status===null||goal.goalId!==expected.goalId) fail('IDENTITY');
  if(operation==='UPDATE'&&(!active(expected.status)||!(active(goal.status)||goal.status==='FULFILLED')))fail('ILLEGAL_TRANSITION');
  if(operation==='SUPERSEDE'&&(!active(expected.status)||goal.status!=='SUPERSEDED'))fail('ILLEGAL_TRANSITION');
  if(operation==='CANCEL'&&(!active(expected.status)||goal.status!=='CANCELLED'))fail('ILLEGAL_TRANSITION');
  return Object.freeze({scope,operation:operation as V3GoalProposalOperation,expected,goal});
}
function parseEnvelope(value:unknown):V3GoalProposalHostEnvelope{
  const e=exact(value,['proposalId','idempotencyKey','createdAt']);
  return Object.freeze({proposalId:text(e.proposalId,'PROPOSAL_ID'),idempotencyKey:text(e.idempotencyKey,'IDEMPOTENCY_KEY'),createdAt:text(e.createdAt,'CREATED_AT')});
}
export class V3GoalProposalHost{
  readonly #graph:V3GoalGraphStore;
  constructor(private readonly database:V1Database, graph=new V3GoalGraphStore(database)){this.#graph=graph;}
  admit(proposalValue:unknown,envelopeValue:unknown){
    const p=parseProposal(proposalValue), envelope=parseEnvelope(envelopeValue);
    // Provenance is Host-owned and authoritative only when checked by the
    // serialized admission transaction. The callback is intentionally invoked
    // after exact replay detection, so replay does not depend on live source
    // rows or on the current goal revision.
    return this.#graph.appendGoalEventIfCurrent({scope:p.scope,eventId:envelope.proposalId,goal:p.goal,eventType:operationEvent(p.operation),idempotencyKey:envelope.idempotencyKey,createdAt:envelope.createdAt},p.expected,()=>{
      const count=(this.database.db.prepare('SELECT count(*) AS n FROM messages WHERE account_id=? AND conversation_id=? AND id IN ('+p.goal.sourceMessageIds.map(()=>'?').join(',')+')').get(p.scope.accountId,p.scope.conversationId,...p.goal.sourceMessageIds) as {n:number}).n;
      if(count!==p.goal.sourceMessageIds.length)fail('SOURCE_PROVENANCE');
    });
  }
}
export {buildConversationGoal};
