import {test,expect} from '@playwright/test';
import {useInboxFixtures,fixtureState} from './inbox-fixtures';

const permissionNames=['CHAT_SEND','CHAT_TAKEOVER','CHAT_RESUME'];
const session={authenticated:true,subject:'synthetic-owner',role:'CHAT_ONLY',permissions:permissionNames,scope:{accountId:'test-only-account',conversationIds:['synthetic-alpha']},expiresAt:'2030-01-01T00:00:00Z'};
const human={mode:'HUMAN',revision:1,subject:'synthetic-owner',authenticated:true,available:true,owned:true,connected:true,draining:false,unresolved:false,permissions:{send:true,takeover:true,resume:true},canSend:true,canResume:true,canTakeover:false};
test('chat-only role displays its limits, keeps chat enabled and disables every commercial action',async({page})=>{
 await useInboxFixtures(page);let status='DRAFT',posts=0;page.on('request',r=>{if(r.method()==='POST')posts++});
 await page.route('**/health',r=>r.fulfill({json:{startupMode:'active',channel:'whatsapp-qr'}}));
 await page.route('**/api/staff/session',r=>r.fulfill({json:session}));
 await page.route('**/api/state?*',r=>{const id=new URL(r.request().url()).searchParams.get('conversationId')!;const s=fixtureState(id);return r.fulfill({json:{...s,so:s.so?{...s.so,status}:undefined,staffChat:id==='synthetic-alpha'?human:{...human,permissions:{send:false,takeover:false,resume:false},canSend:false,canResume:false}}})});
 await page.goto('/');await expect(page.locator('#composerText')).toBeEnabled();await expect(page.locator('#chatResume')).toBeEnabled();
 await page.locator('#so details summary').click();await expect(page.locator('#so')).toContainText('Chat-only session · no commercial permissions');await expect(page.locator('#post')).toBeDisabled();await expect(page.locator('#evidence')).toBeDisabled();
 status='POSTED';await page.reload();await expect(page.locator('#confirm')).toBeDisabled({timeout:7000});status='CONFIRMED';await page.reload();await expect(page.locator('#ready')).toBeDisabled({timeout:7000});
 await page.locator('#navSettings').click();await expect(page.locator('#staffAccessSummary')).toContainText('POST, confirmation and DO are not permitted');await expect(page.locator('#staffAccessSummary')).toContainText('Expires');
 await page.locator('#navInbox').click();await page.locator('[data-conversation-id="synthetic-beta"]').click();await expect(page.locator('#composerText')).toBeDisabled();await expect(page.locator('#chatResume')).toBeDisabled();await expect(page.locator('#composerStatus')).toContainText('does not permit chat actions');expect(posts).toBe(0);
});
test('broad staff retains commercial controls and permission revocation updates them during polling',async({page})=>{
 await useInboxFixtures(page);let permissions=[...permissionNames,'POST','CONFIRM','DO','RESET'];
 await page.route('**/health',r=>r.fulfill({json:{startupMode:'active',channel:'simulated'}}));
 await page.route('**/api/staff/session',r=>r.fulfill({json:{...session,role:'LEGACY_STAFF',permissions}}));
 await page.goto('/');await page.locator('#so details summary').click();await expect(page.locator('#post')).toBeEnabled();await expect(page.locator('#evidence')).toBeEnabled();
 permissions=[];await expect(page.locator('#post')).toBeDisabled({timeout:7000});await expect(page.locator('#evidence')).toBeDisabled();expect(await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}))).toEqual({local:{},session:{}});
});
