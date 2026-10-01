import { test, expect, type Page } from '@playwright/test';

async function clickAndWait(page: Page, selector: string, path: string) {
  const response = page.waitForResponse(r => r.url().includes(path) && r.request().method() === 'POST');
  await page.locator(selector).click();
  const result = await response;
  expect(result.status()).toBe(200);
}

async function sendMessage(page: Page, text: string) {
  const input = page.getByPlaceholder('Customer WhatsApp message');
  await input.fill(text);
  await clickAndWait(page, '#send', '/api/simulated/inbound');
}

test('Legacy simulated fallback fails closed and preserves AI/staff boundary', async ({ page, request }) => {
  await page.goto('/');await page.locator('#navSettings').click();
  await page.setExtraHTTPHeaders({ authorization: 'Bearer test-only-high-entropy-bootstrap' });
  await clickAndWait(page, '#reset', '/api/reset');
  await expect(page.locator('#authority')).toContainText('V1_ONLY');
  await expect(page.locator('#workspace')).toContainText('STAFF-ONLY BOUNDARY');
  await expect(page.locator('#workspace')).toContainText('AI cutoff: SALES_ORDER.DRAFT');

  // The offline legacy fallback deliberately has no semantic classifier. It must
  // not infer business intent from wording when a real model is unavailable.
  await sendMessage(page, 'Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?');
  await expect(page.locator('#chat')).toContainText('Hi, same as last week. Ayam 10 ctn, red one 5 ctn. Tomorrow deliver can?');
  await expect(page.locator('#doc')).toContainText('No quotation yet.');
  await expect(page.locator('#so')).toContainText('No Draft Sales Order yet.');
  for (const label of ['Customer message received', 'Context loaded', 'Customer reply sent']) {
    await expect(page.locator('#timeline')).toContainText(label);
  }
  await expect(page.locator('#timeline')).not.toContainText('system prompt');
  await expect(page.locator('#timeline')).not.toContainText('chain-of-thought');
  await expect(page.locator('#timeline')).not.toContainText('tool_name');

  const bypass = await request.post('/api/staff/post', { data: { capability: 'demo-staff-capability', idempotencyKey: 'forged', doubleConfirmationEvidence: 'forged' } });
  expect(bypass.status()).toBe(401);

  await page.reload();
  await expect(page.locator('#doc')).toContainText('No quotation yet.');
  await expect(page.locator('#so')).toContainText('No Draft Sales Order yet.');
  await expect(page.locator('#workspace')).toContainText('STAFF-ONLY BOUNDARY');
  await expect(page.locator('#workspace')).toContainText('AI cutoff: SALES_ORDER.DRAFT');
});
