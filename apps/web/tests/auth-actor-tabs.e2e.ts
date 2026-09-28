import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

test('an Agent changed in another tab leaves the prepared picker choice for review', async ({ page, context }) => {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  test.skip(!path, 'REZICS_WEB_AUTH_PRIVATE_PATH names the isolated web-auth fixture');
  const fixture = JSON.parse(readFileSync(path!, 'utf8')) as {
    member: { email: string; password: string } };
  await signInAtAccounts(page, '/en/identity', fixture.member);
  const other = await context.newPage();
  await other.goto('/en/identity');
  const selected = other.getByRole('radio', { checked: true });
  const agent = await selected.inputValue();
  const sessionKey = (await context.cookies()).find(cookie => cookie.name === 'rezics_session_key')?.value;
  expect(sessionKey).toBeTruthy();
  const state = await page.request.get('/api/main/v1/me/session-agent', {
    headers: { 'x-session-key': sessionKey! } });
  expect(state.status()).toBe(200);
  const revision = (await state.json() as { sessionAgent: { revision: string | null } }).sessionAgent.revision;
  const clear = await page.request.put('/api/main/v1/me/session-agent', {
    headers: { 'x-session-key': sessionKey!, 'idempotency-key': crypto.randomUUID() },
    data: { actingSubject: null, expectedRevision: revision } });
  expect(clear.ok()).toBe(true);
  await other.getByRole('button', { name: 'Use this Agent' }).click();
  await expect(other).toHaveURL(/\/en\/identity\?error=stale-session/);
  await expect(other.getByRole('alert')).toContainText('another tab');
  await expect(other.getByRole('radio', { name: new RegExp(agent.split('/').at(-1)!) })).toBeVisible();
  await other.close();
});

test('declined consent keeps the requested destination for a fresh sign-in', async ({ page }) => {
  await page.goto('/en/identity/consent?next=%2Fen%2Fstudio');
  await expect(page.getByRole('heading', { name: 'Sign-in was not completed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try signing in again' }))
    .toHaveAttribute('href', '/auth/start?next=%2Fen%2Fstudio');
});

test('a client sign-in link opens Accounts through a document navigation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/en/identity/consent?next=%2Fen%2Fstudio');
  const document = page.waitForRequest(request => new URL(request.url()).pathname === '/auth/authorize'
    && request.isNavigationRequest());
  await page.getByRole('link', { name: 'Try signing in again' }).click();
  expect((await document).isNavigationRequest()).toBe(true);
  const accountOrigin = new URL(process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004').origin;
  await page.waitForURL(url => url.origin === accountOrigin && url.pathname === '/sign-in');
  expect(errors).toEqual([]);
});

test('the cached header follows a session changed between client navigations', async ({ page, context }) => {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  test.skip(!path, 'REZICS_WEB_AUTH_PRIVATE_PATH names the isolated web-auth fixture');
  const fixture = JSON.parse(readFileSync(path!, 'utf8')) as {
    member: { email: string; password: string } };
  await signInAtAccounts(page, '/en/identity', fixture.member);
  const names = ['rezics_access', 'rezics_refresh', 'rezics_session', 'rezics_session_key'];
  const original = (await context.cookies(page.url())).filter(cookie => names.includes(cookie.name));
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account menu' })).toBeVisible();
  for (const name of names) await context.clearCookies({ name });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL('/en');
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();

  await context.addCookies(original);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Discover' }).click();
  await expect(page).toHaveURL('/en/discover');
  await expect(page.getByRole('banner').getByRole('button', { name: 'Account menu' })).toBeVisible();
});
