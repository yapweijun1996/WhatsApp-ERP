import { test, expect } from '@playwright/test';

test('staff bootstrap is sent only in the login header and cleared on failure and cancel', async ({ page }) => {
  const fixture = 'test-only-ui-fixture';
  const requests: {header:string|undefined;body:string|null}[]=[];
  await page.route('**/api/staff/session', async route => {
    if(route.request().method()==='POST') {
      requests.push({header:route.request().headers().authorization,body:route.request().postData()});
      await route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:fixture})});
    } else await route.fulfill({contentType:'application/json',body:'{"authenticated":false,"subject":null}'});
  });
  await page.goto('/');
  await page.locator('#staffLogin').click();
  await expect(page.locator('#staffBootstrap')).toHaveAttribute('type','password');
  await page.locator('#staffBootstrap').fill(fixture);
  await page.locator('#staffLoginSubmit').click();
  await expect(page.locator('#staffLoginError')).toContainText('Staff sign-in failed');
  expect(requests).toEqual([{header:`Bearer ${fixture}`,body:'{}'}]);
  await expect(page.locator('#staffBootstrap')).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(fixture);
  expect(await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}))).toEqual({local:{},session:{}});
  await page.locator('#staffBootstrap').fill(fixture);
  await page.locator('#staffLoginCancel').click();
  await expect(page.locator('#staffBootstrap')).toHaveValue('');
  expect(requests).toHaveLength(1);
});

test('successful intercepted login closes the dialog and discards the credential', async ({ page }) => {
  let submitted=false;
  await page.route('**/api/staff/session', async route => {
    if(route.request().method()==='POST') {
      expect(route.request().headers().authorization).toBe('Bearer test-only-ui-success');
      submitted=true;
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify({authenticated:submitted,subject:submitted?'test-fixture':null})});
  });
  await page.goto('/');
  await page.locator('#staffLogin').click();
  await page.locator('#staffBootstrap').fill('test-only-ui-success');
  await page.locator('#staffLoginSubmit').click();
  await expect(page.locator('#staffLoginDialog')).not.toBeVisible();
  await expect(page.locator('#staffBootstrap')).toHaveValue('');
  expect(submitted).toBe(true);
  await expect(page.locator('body')).not.toContainText('test-only-ui-success');
});
