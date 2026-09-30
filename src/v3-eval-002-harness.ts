export type V3Eval002Case = Readonly<{
  id: string;
  scenario: string;
  testFile: string;
  testName: string;
}>;

/**
 * V3-EVAL-002 is an adversarial index over the existing Host-owned gates.
 * Each child is selected exactly, so a renamed/missing oracle cannot pass as
 * an empty test and no second implementation of production semantics exists.
 */
export const V3_EVAL_002_CASES: readonly V3Eval002Case[] = [
  {id: 'TOCTOU', scenario: 'atomic side-effect admission race', testFile: 'tests/v3-cp-007-gate.test.ts', testName: 'CP-007 G18 proves both atomic-admission interleavings on independent SQLite connections'},
  {id: 'STALE_LEASE', scenario: 'crash/restart stale lease fencing', testFile: 'tests/v3-cp-007-gate.test.ts', testName: 'CP-007 G19 crash/restart reacquisition permanently fences the old generation'},
  {id: 'CROSS_SCOPE', scenario: 'server-derived scope tampering', testFile: 'tests/v3-retrieval-index.test.ts', testName: 'RET-003 rejects cross-scope and tampered requested scope generically before any mode returns'},
  {id: 'RETENTION', scenario: 'retention invalidation cannot resurrect evidence', testFile: 'tests/v3-ret-007-retention-access.test.ts', testName: 'RET-007 stale versions and restore/rebuild ordering cannot resurrect old evidence'},
  {id: 'PROMPT_INJECTION', scenario: 'untrusted attachment instructions cannot own effects', testFile: 'tests/v3-mm-007-golden.test.ts', testName: 'G12 hostile PDF/image-style instructions and DOCUMENT evidence remain untrusted and bounded'},
  {id: 'DUPLICATE_WAKE', scenario: 'async wake idempotency and scope fence', testFile: 'tests/v3-mm-005.test.ts', testName: 'MM-005 completion wakes an eligible continuation without a new inbound and is replay-safe'},
  {id: 'PARTIAL_OUTBOUND', scenario: 'submitted prefix is not replayed after stale remainder', testFile: 'tests/v3-ful-004.test.ts', testName: 'FUL-004 preserves the submitted prefix and fails closed on stale remainder admission'},
] as const;

if (V3_EVAL_002_CASES.length !== 7 || new Set(V3_EVAL_002_CASES.map((entry) => entry.id)).size !== 7) {
  throw new Error('V3-EVAL-002 must contain exactly seven unique adversarial scenarios');
}
