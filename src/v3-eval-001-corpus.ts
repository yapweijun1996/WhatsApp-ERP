export type V3Eval001Case = Readonly<{
  id: `G${number}`;
  criterion: string;
  testFile: string;
  testName: string;
}>;

/**
 * The EVAL-001 corpus is an index over already accepted executable seams.
 * It deliberately does not reproduce any production scenario or authority.
 */
export const V3_EVAL_001_CASES: readonly V3Eval001Case[] = [
  { id: 'G1', criterion: 'Rapid multi-bubble order', testFile: 'tests/v3-ful-007.test.ts', testName: 'G1 composes eight rapid bubbles into one semantic goal and released response plan' },
  { id: 'G2', criterion: 'Interrupted burst / stale-plan fence', testFile: 'tests/v3-cp-007-gate.test.ts', testName: 'CP-007 G2 interrupted burst fences the stale plan' },
  { id: 'G3', criterion: 'Long conversation recall', testFile: 'tests/v3-ret-008-evaluator.test.ts', testName: 'RET-008 G3 long conversation recall reopens exact source' },
  { id: 'G4', criterion: 'Ambiguous same-as-last-time', testFile: 'tests/v3-ret-008-evaluator.test.ts', testName: 'RET-008 G4 records historical evidence separately' },
  { id: 'G5', criterion: 'Image recall', testFile: 'tests/v3-mm-007-golden.test.ts', testName: 'G5 image Search' },
  { id: 'G6', criterion: 'PDF recall', testFile: 'tests/v3-mm-007-golden.test.ts', testName: 'G6 PDF read' },
  { id: 'G7', criterion: 'Reply relation', testFile: 'tests/v3-ret-008-evaluator.test.ts', testName: 'RET-008 G7 resolves reply relation' },
  { id: 'G8', criterion: 'Open obligation continuation', testFile: 'tests/v3-goal-gate.test.ts', testName: 'G8 keeps an open obligation' },
  { id: 'G9', criterion: 'No empty promise', testFile: 'tests/v3-goal-gate.test.ts', testName: 'G9/G22 enforce the structural no-empty-promise boundary' },
  { id: 'G10', criterion: 'Canonical conflict', testFile: 'tests/v3-retrieval-index.test.ts', testName: 'G10 canonical accepted draft wins over stale pending memory' },
  { id: 'G11', criterion: 'Cross-customer isolation', testFile: 'tests/v3-ret-008-evaluator.test.ts', testName: 'RET-008 G11 foreign evidence fails closed' },
  { id: 'G12', criterion: 'Prompt injection attachment', testFile: 'tests/v3-mm-007-golden.test.ts', testName: 'G12 hostile PDF/image-style instructions' },
  { id: 'G13', criterion: '10,000+ message performance', testFile: 'tests/v3-ret-008-evaluator.test.ts', testName: 'RET-008 G13 benchmark freezes reproducible performance' },
  { id: 'G14', criterion: 'Multilingual/code-switching', testFile: 'tests/v3-ful-007.test.ts', testName: 'G14 mixed-language bubbles produce one coherent semantic goal and result' },
  { id: 'G15', criterion: 'Concurrent Goal Graph', testFile: 'tests/v3-goal-gate.test.ts', testName: 'G15 preserves four independent goals' },
  { id: 'G16', criterion: 'Retrieval budget / abstention', testFile: 'tests/v3-ret-008-evaluator.test.ts', testName: 'RET-008 G16 retrieval budget ends in bounded abstention' },
  { id: 'G17', criterion: 'Server scope tampering', testFile: 'tests/v3-ret-008-evaluator.test.ts', testName: 'RET-008 G17 tampered server scope fails closed' },
  { id: 'G18', criterion: 'Atomic admission TOCTOU race', testFile: 'tests/v3-cp-007-gate.test.ts', testName: 'CP-007 G18 proves both atomic-admission interleavings' },
  { id: 'G19', criterion: 'Fenced lease crash/resume', testFile: 'tests/v3-cp-007-gate.test.ts', testName: 'CP-007 G19 crash/restart reacquisition permanently fences' },
  { id: 'G20', criterion: 'Non-message freshness invalidation', testFile: 'tests/v3-cp-007-gate.test.ts', testName: 'CP-007 G20 invalidates a bound plan with no new inbound' },
  { id: 'G21', criterion: 'Partial multi-unit response interruption', testFile: 'tests/v3-ful-004.test.ts', testName: 'FUL-004 preserves the submitted prefix and fails closed on stale remainder admission' },
  { id: 'G22', criterion: 'Durable continuation / no promise loophole', testFile: 'tests/v3-goal-gate.test.ts', testName: 'G22 negative continuation inputs fail closed' },
  { id: 'G23', criterion: 'Async multimodal extraction wake', testFile: 'tests/v3-mm-007-golden.test.ts', testName: 'G23 AUDIO/TRANSCRIPT completion advances freshness' },
] as const;

if (V3_EVAL_001_CASES.length !== 23 || new Set(V3_EVAL_001_CASES.map((entry) => entry.id)).size !== 23) {
  throw new Error('V3-EVAL-001 corpus must contain exactly one entry for G1-G23');
}
