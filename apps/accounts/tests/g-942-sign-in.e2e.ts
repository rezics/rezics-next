import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const accounts = process.env.ACCOUNTS_URL ?? 'http://127.0.0.1:3004';
const web = process.env.WEB_URL ?? 'http://127.0.0.1:3000';
const fixture = process.env.G942_MEMBER_FIXTURE ?? new URL('../../../.temp/stack/rezics-dev/web-auth/private.json', import.meta.url);
const fixtureData = existsSync(fixture) ? JSON.parse(readFileSync(fixture, 'utf8')) as { member?: { email: string; password: string }; email?: string; password?: string } : undefined;
const member = fixtureData?.member ?? (fixtureData?.email && fixtureData.password
  ? { email: fixtureData.email, password: fixtureData.password } : undefined);

async function start(page: Page) {
  await page.goto(`${web}/en/`);
  await page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/sign-in');
  const original = new URL(page.url());
  await page.goto(new URL(original.pathname + original.search, accounts).toString());
  await page.locator('html[data-hydrated]').waitFor();
  return original.searchParams;
}

async function signIn(page: Page) {
  await page.getByRole('textbox', { name: 'Email' }).fill(member!.email);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Enter your password').fill(member!.password);
  const result = page.waitForResponse(response => response.url().endsWith('/api/auth/sign-in/email'));
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  return result;
}

test.describe('G-942 policy-change sign-in against the shared Account service', () => {
  test.skip(!member, 'Provide the shared member fixture through G942_MEMBER_FIXTURE');
  // Decline runs first so it leaves the shared member’s receipts untouched.
  test('declining signs out, explains the result and preserves the requesting app', async ({ page }) => {
    const original = await start(page);
    const response = await signIn(page);
    test.skip(response.status() === 200, 'This fixture member already accepted the current policies; use a member with outstanding acceptance.');
    expect(response.status()).toBe(403);
    await expect(page.getByRole('heading', { name: 'Our policies changed' })).toBeVisible();
    await page.locator('html[data-hydrated]').waitFor();
    const url = new URL(page.url());
    expect(url.pathname).toBe('/accept-policies');
    const resume = new URL(url.searchParams.get('continue')!, accounts);
    for (const key of ['client_id', 'state', 'code_challenge', 'redirect_uri'])
      expect(resume.searchParams.get(key)).toBe(original.get(key));
    await page.screenshot({ path: '.temp/g-942/policy-review.png', fullPage: true });
    await page.getByRole('button', { name: 'Decline and sign out' }).click();
    await expect(page.getByRole('status')).toHaveText(/have been signed out/);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    const back = new URL(page.url());
    expect(back.searchParams.get('state')).toBe(original.get('state'));
    expect(back.searchParams.get('sig')).toBe(original.get('sig'));
    const session = await page.request.get('/api/auth/get-session');
    expect(await session.json()).toBeNull();
    await page.screenshot({ path: '.temp/g-942/policy-declined.png', fullPage: true });
  });

  test('accepting current policies resumes the same PKCE request and reaches the product signed in', async ({ page }) => {
    const original = await start(page);
    const response = await signIn(page);
    test.skip(response.status() === 200, 'This fixture member already accepted the current policies; use a member with outstanding acceptance.');
    expect(response.status()).toBe(403);
    await expect(page.getByRole('heading', { name: 'Our policies changed' })).toBeVisible();
    await page.locator('html[data-hydrated]').waitFor();
    const displayed = await (await page.request.get('/api/account/policies')).json();
    expect(displayed.acceptanceRequired).toBe(true);
    const accepted = page.waitForRequest(request => request.url().endsWith('/api/account/policies/acceptance') && request.method() === 'POST');
    const authorized = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/api/auth/oauth2/authorize' && url.searchParams.get('state') === original.get('state');
    });
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    expect((await accepted).postDataJSON().acceptedPolicies).toEqual(displayed.policies.map((policy: { policyId: string; versionDigest: string }) => ({ policyId: policy.policyId, versionDigest: policy.versionDigest })));
    const resumed = new URL((await authorized).url());
    expect(resumed.searchParams.get('code_challenge')).toBe(original.get('code_challenge'));
    expect((resumed.searchParams.get('prompt') ?? '').split(' ')).not.toContain('login');
    await expect.poll(() => new URL(page.url()).origin).toBe(new URL(web).origin);
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
    await page.screenshot({ path: '.temp/g-942/policy-accepted.png', fullPage: true });
    const session = await page.request.get(`${accounts}/api/auth/get-session`);
    expect((await session.json())?.user.email).toBe(member!.email);
    const policies = await (await page.request.get(`${accounts}/api/account/policies`)).json();
    expect(policies.acceptanceRequired).toBe(false);
    // Leave no browser session behind; the member’s acceptance remains a real receipt.
    await page.request.post(`${accounts}/api/auth/sign-out`, { data: {}, headers: { origin: accounts } });
  });
});
