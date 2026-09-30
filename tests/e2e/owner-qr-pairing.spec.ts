import {test,expect} from '@playwright/test';
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS9sAAAAASUVORK5CYII=';
const base={mode:'whatsapp-qr',adapter:'test-only',pairingControl:{enabled:true,processingPaused:true}};
test('owner regenerates once with pending state; disconnected stale QR hidden and fresh code appears without enabling writes',async({page})=>{
 let status:any={...base,status:'disconnected',qrReady:true,qr:pixel};let requests=0;let release:(()=>void)|undefined;
 await page.route('**/health',r=>r.fulfill({json:{startupMode:'paused'}}));
 await page.route('**/api/channel/status',r=>r.fulfill({json:status}));
 await page.route('**/api/channel/pairing',async r=>{requests++;expect(r.request().headers()['x-waerp-pairing-action']).toBe('regenerate');expect(r.request().postData()).toBe('{}');await new Promise<void>(done=>release=done);status={...base,status:'connecting',qrReady:true,qr:pixel,qrExpiresAt:new Date(Date.now()+55000).toISOString()};await r.fulfill({json:{...status,pairingRequested:true}})});
 await page.goto('/');await expect(page.locator('#pairingControls')).toBeVisible();await expect(page.locator('#channel img')).toHaveCount(0);
 await page.locator('#regenerateQr').click();await expect(page.locator('#regenerateQr')).toBeDisabled();await expect(page.locator('#pairingFeedback')).toContainText('Processing stays paused');expect(requests).toBe(1);
 release!();await expect(page.locator('#channel img')).toBeVisible();await expect(page.locator('#migrationBanner')).toBeVisible();await expect(page.locator('#send')).toBeDisabled();
});
test('owner sees fixed connection error, can retry, then paired status never offers another reconnect',async({page})=>{
 await page.clock.install();let status:any={...base,status:'disconnected',qrReady:false,qr:null};let requests=0;
 await page.route('**/health',r=>r.fulfill({json:{startupMode:'paused'}}));await page.route('**/api/channel/status',r=>r.fulfill({json:status}));
 await page.route('**/api/channel/pairing',async r=>{requests++;if(requests===1){await r.fulfill({status:503,json:{error:'PAIRING_CONNECT_FAILED'}});return}status={...base,status:'connected',qrReady:false,qr:null};await r.fulfill({json:status})});
 await page.goto('/');await page.locator('#regenerateQr').click();await expect(page.locator('#pairingFeedback')).toContainText('Connection failed');await expect(page.locator('#regenerateQr')).toBeDisabled();
 await page.clock.fastForward(6500);await expect(page.locator('#regenerateQr')).toBeEnabled();await page.locator('#regenerateQr').click();await expect(page.locator('#channel')).toContainText('Account paired');await expect(page.locator('#regenerateQr')).toBeDisabled();await expect(page.locator('#channel img')).toHaveCount(0);expect(requests).toBe(2);
});
