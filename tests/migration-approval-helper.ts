import type { MigrationAction, MigrationOwner, MigrationApprovalAuthority } from '../src/migration-auth.js';
import { canonicalSha256 } from '../src/v2-canonical.js';
import type { WorkspaceMigrationService } from '../src/v2-workspace-migration.js';

export type MigrationApprovalBindingOverrides = Readonly<{
  expectedHash?: string;
  expectedWorkItemId?: string | null;
  expectedDraftRevision?: number | null;
  compatibilityConfirmed?: boolean | null;
}>;

function currentLegacyHash(migration: WorkspaceMigrationService, customerId: string, conversationId: string): string {
  const row = migration.database.db.prepare("SELECT value_json FROM customer_order_memory WHERE customer_id=? AND memory_type='pending_order' AND key_text=? ORDER BY rowid DESC LIMIT 1").get(customerId, conversationId) as { value_json: string } | undefined;
  if (!row) return canonicalSha256(null);
  try { return canonicalSha256(JSON.parse(row.value_json)); }
  catch { return canonicalSha256(row.value_json); }
}

/** Test-only issuer that mirrors the server's exact descriptor binding without weakening production authority. */
export function issueBoundMigrationApproval(
  authority: MigrationApprovalAuthority,
  migration: WorkspaceMigrationService,
  subject: string,
  owner: MigrationOwner,
  action: MigrationAction,
  scope: { accountId: string; conversationId: string; customerId: string },
  overrides: MigrationApprovalBindingOverrides = {},
) {
  const current = migration.getAuthority(scope.accountId, scope.conversationId);
  const expectedHash = overrides.expectedHash ?? (action === 'SHADOW_IMPORT' ? currentLegacyHash(migration, scope.customerId, scope.conversationId) : current.legacy_source_hash ?? '');
  const expectedWorkItemId = overrides.expectedWorkItemId !== undefined ? overrides.expectedWorkItemId : current.work_item_id ?? null;
  const currentDraft = action === 'PROMOTE_CANARY' && expectedWorkItemId ? migration.database.db.prepare("SELECT current_revision FROM order_drafts WHERE work_item_id=? AND status='CURRENT'").get(expectedWorkItemId) as { current_revision: number } | undefined : undefined;
  const expectedDraftRevision = overrides.expectedDraftRevision !== undefined ? overrides.expectedDraftRevision : currentDraft?.current_revision ?? null;
  const compatibilityConfirmed = overrides.compatibilityConfirmed !== undefined ? overrides.compatibilityConfirmed : action === 'RETIRE_LEGACY' ? true : null;
  return authority.issue(subject, owner, action, {
    accountId: scope.accountId,
    conversationId: scope.conversationId,
    customerId: scope.customerId,
    expectedState: current.migration_state,
    expectedHash,
    expectedRevision: current.revision,
    expectedWorkItemId,
    expectedDraftRevision,
    compatibilityConfirmed,
  });
}
