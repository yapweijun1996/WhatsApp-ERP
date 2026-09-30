import { test, expect } from '@playwright/test';

test('V2-EVAL-002 browser surface captures Demo/native parity, state, provenance, and safety', async ({ page }) => {
  const response = await page.request.get('/api/test-only/v2-eval-002');
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.evaluation).toBe('V2-EVAL-002');
  expect(result.status).toBe('PASS');
  expect(result.parity.equal).toBe(true);
  expect(result.transports.map((transport: { mode: string }) => transport.mode)).toEqual(['native-tools', 'demo-text']);
  expect(result.captured.state.workItem.state).toBe('DRAFTING');
  expect(result.captured.provenance).toEqual({ sourceMessageId: 'eval-002-message-001', evidenceRefs: ['eval-002-erp-evidence-001'] });
  expect(result.safety).toEqual({ v2CustomerTraffic: 'OFF', aiCutoff: 'SALES_ORDER.DRAFT', liveProviders: false, qrWhatsApp: false, salesOrderPostConfirmDo: false });
  await page.goto('/');
  await expect(page.locator('#authority')).toContainText('V1_ONLY');
});
