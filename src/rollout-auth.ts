export type RolloutApproval = object;
export type RolloutAction = 'ENABLE'|'DISABLE'|'ROLLBACK';
export type RolloutIntent = Readonly<{action:RolloutAction; capability:string; accountId:string|null; conversationId:string|null; enabled:boolean}>;
export type VerifiedRolloutApproval = Readonly<RolloutIntent & {subject:string}>;
const subjectPattern=/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const targetPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function validateIntent(intent:RolloutIntent){
  if(!intent||!['ENABLE','DISABLE','ROLLBACK'].includes(intent.action)||typeof intent.capability!=='string'||!targetPattern.test(intent.capability))throw Error('ROLLOUT_APPROVAL_INTENT_INVALID');
  if((intent.accountId!==null&&!targetPattern.test(intent.accountId))||(intent.conversationId!==null&&!targetPattern.test(intent.conversationId))||typeof intent.enabled!=='boolean')throw Error('ROLLOUT_APPROVAL_INTENT_INVALID');
  if(intent.conversationId!==null&&intent.accountId===null)throw Error('ROLLOUT_ACCOUNT_SCOPE_REQUIRED');
  if((intent.action==='ENABLE')!==intent.enabled)throw Error('ROLLOUT_APPROVAL_ACTION_ENABLED_MISMATCH');
}

/** Process-local capability to change rollout configuration. Request bodies never create one. */
export function createRolloutApprovalAuthority(){
  const issued=new WeakMap<object,VerifiedRolloutApproval>();
  return {
    issue(subject:string,intent:RolloutIntent):RolloutApproval{
      if(!subjectPattern.test(subject))throw Error('ROLLOUT_APPROVAL_SUBJECT_INVALID');
      validateIntent(intent);
      const token=Object.freeze(Object.create(null)) as object; issued.set(token,Object.freeze({...intent,subject})); return token;
    },
    verify(candidate:unknown,expected?:RolloutIntent):VerifiedRolloutApproval|undefined{
      if((typeof candidate!=='object'&&typeof candidate!=='function')||candidate===null)return undefined;
      const value=issued.get(candidate as object);
      if(!value||expected&&(['action','capability','accountId','conversationId','enabled'] as const).some(key=>value[key]!==expected[key]))return undefined;
      return value;
    }
  };
}
export type RolloutApprovalAuthority=ReturnType<typeof createRolloutApprovalAuthority>;
