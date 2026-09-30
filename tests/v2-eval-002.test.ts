import assert from 'node:assert/strict';
import test from 'node:test';
import { runV2Eval002 } from '../src/v2-eval-002-harness.js';

test('[V2-EVAL-002] native and Demo bridge produce equal host semantics with captured state/provenance', async () => {
  const result = await runV2Eval002();
  assert.equal(result.status, 'PASS');
  assert.equal(result.parity.equal, true);
  assert.equal(result.parity.mismatchCode, undefined);
  assert.deepEqual(result.transports.map(item => item.mode), ['native-tools', 'demo-text']);
  assert.equal((result.captured.state as any).workItem.state, 'DRAFTING');
  assert.deepEqual(result.captured.provenance, { sourceMessageId: 'eval-002-message-001', evidenceRefs: ['eval-002-erp-evidence-001'] });
  assert.equal(result.safety.v2CustomerTraffic, 'OFF');
  assert.equal(result.safety.aiCutoff, 'SALES_ORDER.DRAFT');
  assert.equal(result.safety.liveProviders, false);
  assert.equal(result.safety.qrWhatsApp, false);
  assert.equal(result.safety.salesOrderPostConfirmDo, false);
});

test('[V2-EVAL-002] harness is deterministic across repeated evaluations', async () => {
  const first = await runV2Eval002();
  const second = await runV2Eval002();
  assert.deepEqual(first, second);
});
