import {test,expect} from '@playwright/test';
import {useInboxFixtures,fixtureState} from './inbox-fixtures';
const ai={mode:'AI',revision:0,subject:null,available:true,authenticated:true,owned:false,draining:false,unresolved:false,canTakeover:true,canSend:false,canResume:false};
const human={...ai,mode:'HUMAN',revision:1,subject:'synthetic-staff',owned:true,canTakeover:false,canSend:true,canResume:true};
test('staff manually takes over, retains an uncertain request identity, and checks its outcome without a second provider submission',async({page})=>{
 await useInboxFixtures(page);let control={...ai},reply=false,attempts:any[]=[],providerCalls=0;
 await page.route('**/health',r=>r.fulfill({json:{startupMode:'active',channel:'whatsapp-qr'}}));
 await page.route('**/api/staff/session',r=>r.fulfill({json:{authenticated:true,subject:'synthetic-staff'}}));
 await page.route('**/api/state?*',r=>{const id=new URL(r.request().url()).searchParams.get('conversationId')!;const s=fixtureState(id);return r.fulfill({json:{...s,staffChat:id==='synthetic-alpha'?control:ai,messages:reply?[...s.messages,{from:'staff',text:'Synthetic explicit staff reply',deliveryState:'SUBMITTED'}]:s.messages}})});
 await page.route('**/api/staff/chat/*',async r=>{
  const action=r.request().url().split('/').pop();const b=r.request().postDataJSON();expect(r.request().headers()['x-waerp-staff-action']).toBe('1');expect(b.conversationId).toBe('synthetic-alpha');
  if(action==='takeover'){control={...human};return r.fulfill({json:control})}
  if(action==='resume'){control={...ai,revision:2};return r.fulfill({json:control})}
  attempts.push(b);if(attempts.length===1){providerCalls++;reply=true;return r.abort('failed')}
  expect(b).toEqual(attempts[0]);return r.fulfill({json:{deliveryState:'SUBMITTED',physicalDeliveryConfirmed:false,duplicate:true}});
 });
 await page.goto('/');await expect(page.locator('#composerText')).toBeDisabled();await page.locator('#chatTakeover').click();await expect(page.locator('#composerText')).toBeEnabled();await page.locator('#composerText').fill('Synthetic explicit staff reply');await page.locator('#composerSend').click();
 await expect(page.locator('#composerText')).toBeDisabled();await expect(page.locator('#composerSend')).toHaveAttribute('aria-label','Check previous submission');await expect(page.locator('#composerStatus')).toContainText('retained');await page.locator('#composerSend').click();await expect(page.locator('#composerText')).toHaveValue('');await expect(page.locator('#chat')).toContainText('员工回复');await expect(page.locator('#chat')).toContainText('delivery not confirmed');expect(providerCalls).toBe(1);expect(attempts.length).toBe(2);
 await page.locator('#chatResume').click();await expect(page.locator('#composerText')).toBeDisabled();await expect(page.locator('#composerStatus')).toContainText('AI handles new inbound');
});
test('control-state polling blocks draining/unknown delivery and retains drafts separately on mobile conversation switches',async({page})=>{
 await useInboxFixtures(page);let control={...human};await page.setViewportSize({width:390,height:844});
 await page.route('**/health',r=>r.fulfill({json:{startupMode:'active',channel:'whatsapp-qr'}}));await page.route('**/api/staff/session',r=>r.fulfill({json:{authenticated:true,subject:'synthetic-staff'}}));
 await page.route('**/api/state?*',r=>{const id=new URL(r.request().url()).searchParams.get('conversationId')!;return r.fulfill({json:{...fixtureState(id),staffChat:id==='synthetic-alpha'?control:{...human,revision:3}}})});
 await page.goto('/');await page.locator('[data-conversation-id="synthetic-alpha"]').click();await page.locator('#composerText').fill('Unsent Alpha staff draft');await page.locator('#chatBack').click();await page.locator('[data-conversation-id="synthetic-beta"]').click();await expect(page.locator('#composerText')).toHaveValue('');await page.locator('#composerText').fill('Unsent Beta staff draft');await page.locator('#chatBack').click();await page.locator('[data-conversation-id="synthetic-alpha"]').click();await expect(page.locator('#composerText')).toHaveValue('Unsent Alpha staff draft');
 control={...human,draining:true,canSend:false,canResume:false};await expect(page.locator('#composerText')).toBeDisabled({timeout:7000});await expect(page.locator('#composerStatus')).toContainText('Waiting');await expect(page.locator('#chatResume')).toBeDisabled();
 control={...human,unresolved:true,canSend:false,canResume:false};await expect(page.locator('#composerStatus')).toContainText('Delivery unconfirmed',{timeout:7000});await expect(page.locator('#composerSend')).toBeDisabled();
 control={...human};await expect(page.locator('#composerText')).toBeEnabled({timeout:7000});await expect(page.locator('#composerText')).toHaveValue('Unsent Alpha staff draft');
});
test('paused preview and unauthenticated Access user cannot activate the manual composer',async({page})=>{
 await useInboxFixtures(page);let posts=0;page.on('request',r=>{if(r.method()==='POST')posts++});
 await page.route('**/api/state?*',r=>r.fulfill({json:{...fixtureState('synthetic-alpha'),staffChat:human}}));await page.goto('/');await expect(page.locator('#composerText')).toBeDisabled();await expect(page.locator('#chatTakeover')).toBeDisabled();await expect(page.locator('#chatResume')).toBeDisabled();
 await page.route('**/health',r=>r.fulfill({json:{startupMode:'active',channel:'whatsapp-qr'}}));await page.route('**/api/state?*',r=>r.fulfill({json:{...fixtureState('synthetic-alpha'),staffChat:{...ai,authenticated:false,canTakeover:false}}}));await page.reload();await expect(page.locator('#composerText')).toBeDisabled();await expect(page.locator('#chatTakeover')).toBeDisabled();await expect(page.locator('#chatStaffLogin')).toBeVisible();await expect(page.locator('#composerStatus')).toContainText('Cloudflare login does not grant reply authority');expect(posts).toBe(0);
});
