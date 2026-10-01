import {createHash} from 'node:crypto';
import type {ChannelAdapter,ChannelSendResult,OutgoingChannelMessage} from './channel-contract.js';
import {V1Database} from './database.js';

/** Host-only test policy. Not customer identity, workspace authority or consent. */
export type ControlledTestSendPolicy=Readonly<{
  policyId:string;accountId:string;canonicalConversationId:string;recipient:string;
}>;
const LIMIT=3;
function snapshot(input:ControlledTestSendPolicy|undefined):ControlledTestSendPolicy|undefined {
  if(input===undefined)return undefined;
  const out={} as Record<string,string>;
  for(const key of ['policyId','accountId','canonicalConversationId','recipient'] as const){
    const descriptor=Object.getOwnPropertyDescriptor(input,key);
    const value=descriptor && 'value' in descriptor?descriptor.value:undefined;
    if(typeof value!=='string'||!value||value.length>256||value.trim()!==value||/[\s*\u0000]/.test(value))throw Error('CONTROLLED_TEST_POLICY_INVALID');
    out[key]=value;
  }
  if(/@(g\.us|broadcast|newsletter)$/.test(out.recipient!))throw Error('CONTROLLED_TEST_POLICY_SINGLE_RECIPIENT_REQUIRED');
  return Object.freeze(out) as ControlledTestSendPolicy;
}

/** Durable provider-attempt ceiling, not an exactly-once delivery guarantee.
 * No policy means no provider operation. No timer/reset/refund is supported. */
export class ControlledTestSendGuard {
  private readonly policy:ControlledTestSendPolicy|undefined;
  constructor(private readonly database:V1Database,policy:ControlledTestSendPolicy|undefined,
    private readonly providerSend:(message:OutgoingChannelMessage)=>Promise<ChannelSendResult>){this.policy=snapshot(policy)}

  async send(message:OutgoingChannelMessage):Promise<ChannelSendResult>{
    const policy=this.policy;
    if(!policy)throw Error('CONTROLLED_TEST_POLICY_REQUIRED');
    // Freeze the exact submitted wire object before the first async boundary.
    const wire={...message,attachments:message.attachments?.map(a=>({...a}))};
    if(wire.accountId!==policy.accountId||wire.conversationId!==policy.recipient)throw Error('CONTROLLED_TEST_RECIPIENT_DENIED');
    if(typeof wire.clientMessageId!=='string'||!wire.clientMessageId||wire.clientMessageId.length>256)throw Error('CONTROLLED_TEST_MESSAGE_ID_REQUIRED');
    const fingerprint=createHash('sha256').update(JSON.stringify(policy)).digest('hex');
    const attempt=this.database.runImmediate(()=>{
      const db=this.database.db;
      const conversation=db.prepare('SELECT external_conversation_id FROM conversations WHERE id=? AND channel_account_id=?').get(policy.canonicalConversationId,policy.accountId) as {external_conversation_id:string}|undefined;
      if(conversation?.external_conversation_id!==policy.recipient)throw Error('CONTROLLED_TEST_CONVERSATION_DENIED');
      db.prepare('INSERT OR IGNORE INTO controlled_test_send_budgets(policy_id,fingerprint,account_id,conversation_id,recipient,used_attempts) VALUES(?,?,?,?,?,0)')
        .run(policy.policyId,fingerprint,policy.accountId,policy.canonicalConversationId,policy.recipient);
      const row=db.prepare('SELECT fingerprint,used_attempts FROM controlled_test_send_budgets WHERE policy_id=?').get(policy.policyId) as {fingerprint:string;used_attempts:number}|undefined;
      if(!row||row.fingerprint!==fingerprint)throw Error('CONTROLLED_TEST_POLICY_CONFLICT');
      if(row.used_attempts>=LIMIT)throw Error('CONTROLLED_TEST_ATTEMPT_LIMIT');
      const ordinal=row.used_attempts+1;
      const changed=db.prepare('UPDATE controlled_test_send_budgets SET used_attempts=? WHERE policy_id=? AND used_attempts=? AND used_attempts<3').run(ordinal,policy.policyId,row.used_attempts);
      const persisted=db.prepare('SELECT used_attempts FROM controlled_test_send_budgets WHERE policy_id=?').get(policy.policyId) as {used_attempts:number}|undefined;
      if(changed.changes!==1||persisted?.used_attempts!==ordinal)throw Error('CONTROLLED_TEST_BUDGET_PERSISTENCE_REQUIRED');
      // UNKNOWN precedes provider call: crash/throw/ambiguity still consumes slot.
      db.prepare("INSERT INTO controlled_test_send_attempts(policy_id,ordinal,client_message_id,status,attempted_at) VALUES(?,?,?,'UNKNOWN',?)")
        .run(policy.policyId,ordinal,wire.clientMessageId,new Date().toISOString());
      if(!db.prepare('SELECT 1 FROM controlled_test_send_attempts WHERE policy_id=? AND ordinal=?').get(policy.policyId,ordinal))throw Error('CONTROLLED_TEST_ATTEMPT_PERSISTENCE_REQUIRED');
      return ordinal;
    });
    const result=await this.providerSend(wire);
    // Never refund on provider failure or a disposition write failure.
    const status=result?.status==='submitted'?'SUBMITTED':result?.status==='failed'?'FAILED':'UNKNOWN';
    this.database.db.prepare('UPDATE controlled_test_send_attempts SET status=? WHERE policy_id=? AND ordinal=?').run(status,policy.policyId,attempt);
    return result && ['submitted','failed','unknown'].includes(result.status)?result:{status:'unknown',clientMessageId:wire.clientMessageId};
  }
}

/** Installed once before startup; all sole-owner adapter sends use this fence. */
export function installControlledTestSendGuard(database:V1Database,channel:ChannelAdapter,policy?:ControlledTestSendPolicy){
  const guard=new ControlledTestSendGuard(database,policy,channel.send.bind(channel));
  channel.send=guard.send.bind(guard);
  return guard;
}
