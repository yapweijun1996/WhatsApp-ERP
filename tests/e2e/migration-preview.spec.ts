import {test,expect} from '@playwright/test';
test('paused preview explains state, hides writes and never promises a missing QR',async({page})=>{
 await page.route('**/health',r=>r.fulfill({contentType:'application/json',body:'{"ok":true,"startupMode":"paused"}'}));
 await page.route('**/api/channel/status',r=>r.fulfill({contentType:'application/json',body:'{"status":"disconnected","mode":"whatsapp-qr","adapter":"test-only","qrReady":false,"qr":null}'}));
 await page.goto('/');await page.locator('#navSettings').click();
 await expect(page.locator('#migrationBanner')).toBeVisible();
 await expect(page.locator('#migrationBanner')).toContainText('WhatsApp and AI processing are paused');
 await expect(page.locator('#simulatorControls')).not.toBeVisible();
 await expect(page.locator('#send')).toBeDisabled();
 await expect(page.locator('#reset')).toBeDisabled();
 await expect(page.locator('#channel')).toContainText('Owner QR pairing has not started');
 await expect(page.locator('#channel')).not.toContainText('Waiting for a QR');
});
