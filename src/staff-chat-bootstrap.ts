import {CHAT_ACTIONS, snapshotStaffGrant, type StaffGrant} from './staff-auth.js';

export type StaffChatBootstrap = {credential: string; subject: string; accountId: string; conversationIds: readonly string[]; expiresAt: number};
export function staffChatBootstrapFromEnv(env: NodeJS.ProcessEnv): StaffChatBootstrap | undefined {
  const credential = env.STAFF_CHAT_BOOTSTRAP_CREDENTIAL, configuration = env.STAFF_CHAT_ACCESS_JSON;
  if (!credential && !configuration) return undefined;
  try {
    if (!credential || !configuration) throw Error();
    const value = JSON.parse(configuration);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['subject', 'accountId', 'conversationIds', 'expiresAt'].includes(key)) || typeof value.expiresAt !== 'string') throw Error();
    return snapshotStaffChatBootstrap({credential, ...value, expiresAt: Date.parse(value.expiresAt)});
  } catch { throw Error('STAFF_CHAT_BOOTSTRAP_CONFIGURATION_INVALID'); }
}
export function snapshotStaffChatBootstrap(value: StaffChatBootstrap): StaffChatBootstrap {
  if (typeof value.credential !== 'string' || !value.credential.trim() || typeof value.subject !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.subject)) throw Error('STAFF_CHAT_BOOTSTRAP_CONFIGURATION_INVALID');
  const grant = snapshotStaffGrant({role: 'CHAT_ONLY', accountId: value.accountId, conversationIds: value.conversationIds, actions: CHAT_ACTIONS, expiresAt: value.expiresAt});
  return Object.freeze({...value, conversationIds: (grant as Extract<StaffGrant, {role: 'CHAT_ONLY'}>).conversationIds});
}
