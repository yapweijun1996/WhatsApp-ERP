import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { modelMode, runtimeTelemetry } from '../src/runtime-mode.js';
import { runV3OrchestratorGate, V3_ORCHESTRATOR_AI_AUTHORITY_CUTOFF } from '../src/v3-orchestrator-gate.js';

const mode = process.env.V3_EVAL_004_MODE === 'enabled' ? 'enabled' : 'disabled';
const scope = { tenantId: 'tenant', accountId: 'demo-account', channelAccountId: 'demo-account', conversationId: 'conv-001', customerId: 'CUST-001' } as const;
const budgets = { maxSteps: 1, maxToolCalls: 1, maxEvidenceItems: 1, maxEvidenceBytes: 1000, maxReadBytes: 1000, maxCandidateItems: 1, maxEvidenceTokens: 1000, maxConsecutiveNoNewEvidence: 1, maxElapsedMs: 1000 };

test(`EVAL-004 ${mode} deterministic mode preserves the V3 authority cutoff`, () => {
  assert.equal(modelMode(), 'deterministic');
  assert.equal(runtimeTelemetry().aiCutoff, 'SALES_ORDER.DRAFT');
  if (mode === 'disabled') {
    assert.equal(runtimeTelemetry().v2TrafficEnabled, false);
    return;
  }
  const gate = runV3OrchestratorGate({
    retrieval: { scope, indexVersion: 'eval-004', scopeVersion: 'eval-004', budgets, nextAction: () => ({ kind: 'FINAL' }), tools: {}, isSufficient: () => true },
  });
  assert.equal(gate.retrieval.outcome, 'ABSTAIN');
  assert.equal(gate.aiAuthorityCutoff, V3_ORCHESTRATOR_AI_AUTHORITY_CUTOFF);
  assert.equal(gate.aiAuthorityCutoff, 'SALES_ORDER.DRAFT');
});

test(`EVAL-004 ${mode} static authority scan preserves sole outbound owner and forbidden staff boundary`, () => {
  const srcDir = resolve('src');
  const sourceFiles = ['outbound-message-service.ts', 'v2-capability-registry.ts', 'v3-orchestrator-gate.ts'];
  const source = sourceFiles.map(file => [file, readFileSync(resolve(srcDir, file), 'utf8')] as const);
  const directSends = source.filter(([, text]) => /\badapter\.send\s*\(/.test(text)).map(([file]) => file);
  assert.deepEqual(directSends, ['outbound-message-service.ts']);
  const registry = source.find(([file]) => file === 'v2-capability-registry.ts')![1];
  for (const forbidden of ['post_sales_order', 'confirm_sales_order', 'create_delivery_order', 'sales_order_post', 'sales_order_confirm', 'delivery_order_create']) {
    assert.equal(registry.includes(`'${forbidden}'`), false, forbidden);
  }
  assert.equal(V3_ORCHESTRATOR_AI_AUTHORITY_CUTOFF, 'SALES_ORDER.DRAFT');
});
