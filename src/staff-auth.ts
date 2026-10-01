export type StaffCapability = object;
export const CHAT_ACTIONS = Object.freeze(['CHAT_SEND', 'CHAT_TAKEOVER', 'CHAT_RESUME'] as const);
export const STAFF_ACTIONS = Object.freeze([...CHAT_ACTIONS, 'POST', 'CONFIRM', 'DO', 'RESET'] as const);
export type StaffChatAction = typeof CHAT_ACTIONS[number];
export type StaffAction = typeof STAFF_ACTIONS[number];
export type StaffScope = {accountId: string; conversationId: string};
export type StaffGrant = {role: 'CHAT_ONLY'; accountId: string; conversationIds: readonly string[]; actions: readonly StaffChatAction[]; expiresAt: number}
  | {role: 'LEGACY_STAFF'; expiresAt: number};
export type VerifyStaffCapability = (candidate: unknown, action?: StaffAction, scope?: StaffScope) => string | undefined;

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
/** Copy host configuration so later caller mutation cannot widen authorization. */
export function snapshotStaffGrant(grant: StaffGrant): StaffGrant {
  if (!grant || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0 || !Number.isFinite(new Date(grant.expiresAt).getTime())) throw Error('STAFF_GRANT_INVALID');
  if (grant.role === 'LEGACY_STAFF') return Object.freeze({role: grant.role, expiresAt: grant.expiresAt});
  if (grant.role !== 'CHAT_ONLY' || !identifier(grant.accountId) || !Array.isArray(grant.conversationIds) || !grant.conversationIds.length || grant.conversationIds.length > 100
    || !grant.conversationIds.every(identifier) || new Set(grant.conversationIds).size !== grant.conversationIds.length
    || !Array.isArray(grant.actions) || !grant.actions.length || !grant.actions.every(action => CHAT_ACTIONS.includes(action)) || new Set(grant.actions).size !== grant.actions.length) throw Error('STAFF_GRANT_INVALID');
  return Object.freeze({...grant, conversationIds: Object.freeze([...grant.conversationIds]), actions: Object.freeze([...grant.actions])});
}

/** Opaque process-local capabilities; only the issuing host can grant or revoke. */
export function createStaffCapabilityAuthority(now: () => number = Date.now) {
  const issued = new WeakMap<object, {subject: string; grant?: StaffGrant}>();
  const record = (candidate: unknown) => {
    if ((typeof candidate !== 'object' && typeof candidate !== 'function') || candidate === null) return undefined;
    const value = issued.get(candidate as object);
    return value && (!value.grant || value.grant.expiresAt > now()) ? value : undefined;
  };
  const verify: VerifyStaffCapability = (candidate, action, scope) => {
    const value = record(candidate);
    if (!value) return undefined;
    if (action && !STAFF_ACTIONS.includes(action)) return undefined;
    if (action && value.grant?.role === 'CHAT_ONLY') {
      if (!value.grant.actions.includes(action as StaffChatAction) || !scope || scope.accountId !== value.grant.accountId || !value.grant.conversationIds.includes(scope.conversationId)) return undefined;
    }
    return value.subject;
  };
  return {
    issue(subject: string, grant?: StaffGrant): StaffCapability {
      if (!identifier(subject)) throw Error('STAFF_SUBJECT_INVALID');
      const capability = Object.freeze(Object.create(null)) as object;
      issued.set(capability, {subject, grant: grant ? snapshotStaffGrant(grant) : undefined});
      return capability;
    },
    verify,
    revoke(candidate: StaffCapability) { issued.delete(candidate); },
    describe(candidate: unknown) {
      const value = record(candidate);
      const grant = value?.grant;
      return {authenticated: Boolean(value), subject: value?.subject ?? null, role: value ? grant?.role ?? 'LEGACY_STAFF' : null,
        permissions: value ? grant?.role === 'CHAT_ONLY' ? [...grant.actions] : [...STAFF_ACTIONS] : [],
        scope: grant?.role === 'CHAT_ONLY' ? {accountId: grant.accountId, conversationIds: [...grant.conversationIds]} : null,
        expiresAt: grant ? new Date(grant.expiresAt).toISOString() : null};
    },
  };
}
