export type MigrationOwner = 'MIGRATION_OWNER' | 'V1_OWNER';
export type MigrationAction = 'SHADOW_IMPORT' | 'PROMOTE_CANARY' | 'ROLLBACK' | 'PROMOTE_PRIMARY' | 'RETIRE_LEGACY' | 'CLEANUP_LEGACY';
export type MigrationApprovalDescriptor = Readonly<{action:MigrationAction;owner:MigrationOwner;accountId:string;conversationId:string;customerId:string;expectedState:string;expectedHash:string;expectedRevision:number;expectedWorkItemId:string|null;expectedDraftRevision:number|null;compatibilityConfirmed:boolean|null}>;
export type MigrationApproval = object;
export type VerifiedMigrationApproval = Readonly<{ subject: string; action: MigrationAction; owner: MigrationOwner; descriptor:MigrationApprovalDescriptor }>;

/** Process-local, opaque migration approvals. Request labels are never trusted. */
export function createMigrationApprovalAuthority() {
  const issued = new WeakMap<object, { subject: string; descriptor: MigrationApprovalDescriptor }>();
  return {
    issue(subject: string, owner: MigrationOwner, action: MigrationAction = owner === 'MIGRATION_OWNER' ? 'SHADOW_IMPORT' : 'PROMOTE_CANARY', binding?: Omit<MigrationApprovalDescriptor,'action'|'owner'>): MigrationApproval {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/.test(subject)) throw Error('MIGRATION_APPROVAL_SUBJECT_INVALID');
      if (!/^(SHADOW_IMPORT|PROMOTE_CANARY|ROLLBACK|PROMOTE_PRIMARY|RETIRE_LEGACY|CLEANUP_LEGACY)$/.test(action)) throw Error('MIGRATION_APPROVAL_ACTION_INVALID');
      if (!binding || typeof binding.accountId !== 'string' || typeof binding.conversationId !== 'string' || typeof binding.customerId !== 'string' || typeof binding.expectedState !== 'string' || typeof binding.expectedHash !== 'string' || !Number.isInteger(binding.expectedRevision) || !('expectedWorkItemId' in binding) || !('expectedDraftRevision' in binding) || !('compatibilityConfirmed' in binding)) throw Error('MIGRATION_APPROVAL_DESCRIPTOR_REQUIRED');
      const capability = Object.freeze(Object.create(null)) as object;
      issued.set(capability, { subject, descriptor: Object.freeze({ owner, action, ...binding }) });
      return capability;
    },
    verify(candidate: unknown, action: MigrationAction, owner: MigrationOwner, expected?: Omit<MigrationApprovalDescriptor,'owner'|'action'>): VerifiedMigrationApproval | undefined {
      if ((typeof candidate !== 'object' && typeof candidate !== 'function') || candidate === null) return undefined;
      const value = issued.get(candidate as object);
      if (!value || value.descriptor.owner !== owner || value.descriptor.action !== action) return undefined;
      if (!expected) return Object.freeze({ subject: value.subject, owner, action, descriptor: value.descriptor });
      const keys: (keyof Omit<MigrationApprovalDescriptor,'owner'|'action'>)[] = ['accountId','conversationId','customerId','expectedState','expectedHash','expectedRevision','expectedWorkItemId','expectedDraftRevision','compatibilityConfirmed'];
      if (keys.some(key => value.descriptor[key] !== expected[key])) return undefined;
      return Object.freeze({ subject: value.subject, owner, action, descriptor: value.descriptor });
    },
  };
}
export type MigrationApprovalAuthority = ReturnType<typeof createMigrationApprovalAuthority>;
