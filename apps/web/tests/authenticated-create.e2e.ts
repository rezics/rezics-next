import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

interface PublicFixture { actingSubject: string }
interface PrivateFixture { member: { email: string; password: string } }

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function signIn(page: Page, next = '/studio'): Promise<void> {
  const privateFixture = fixture<PrivateFixture>('REZICS_WEB_AUTH_PRIVATE_PATH');
  await page.goto(next);
  await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(next)}`);
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Email' }).fill(privateFixture.member.email);
  await page.getByLabel('Password').fill(privateFixture.member.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Opens the shell's account menu; a click that lands before hydration does nothing, so retry. */
async function openAccountMenu(page: Page): Promise<void> {
  const trigger = page.getByRole('banner').getByRole('button', { name: 'Account menu' });
  await expect(async () => {
    if (await page.getByRole('menu').isVisible()) return;
    await trigger.click();
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

async function cookie(context: BrowserContext, name: string) {
  return (await context.cookies()).find(item => item.name === name);
}

test('IAM02: invalid OAuth state is rejected at the web callback', async ({ page }) => {
  const invalidCallback = await page.goto('/auth/callback?code=invalid&state=invalid');
  expect(invalidCallback?.status()).toBe(400);
  await expect(page.getByText('Authorization state is invalid or expired')).toBeVisible();
});

test('IAM01: a web session outlives its access token, keeps its Agent and signs out', async ({ page, context }) => {
  const publicFixture = fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH');
  await signIn(page);
  // The member may act as exactly one Agent, so the new session starts with it.
  await expect(page).toHaveURL('/studio');
  expect(decodeURIComponent((await cookie(context, 'rezics_subject'))?.value ?? '')).toBe(publicFixture.actingSubject);
  for (const name of ['rezics_access', 'rezics_refresh', 'rezics_session']) {
    expect((await cookie(context, name))?.httpOnly, name).toBe(true);
  }
  expect(await page.evaluate(() => document.cookie)).not.toContain('rezics_');

  // Forced expiry: the next request refreshes and rotates, and the person stays signed in.
  const refresh = (await cookie(context, 'rezics_refresh'))?.value;
  await context.clearCookies({ name: 'rezics_access' });
  await page.reload();
  await expect(page).toHaveURL('/studio');
  expect(await cookie(context, 'rezics_access')).toBeDefined();
  expect((await cookie(context, 'rezics_refresh'))?.value).not.toBe(refresh);

  // Choosing an Agent Main does not list is refused, and the session Agent stays.
  const forged = await page.request.post('/identity/select', { maxRedirects: 0,
    form: { agent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', next: '/studio' } });
  expect(forged.headers().location).toContain('/identity?error=invalid');
  expect(decodeURIComponent((await cookie(context, 'rezics_subject'))?.value ?? '')).toBe(publicFixture.actingSubject);
  // The shell's account menu shows the session Agent and switches it explicitly.
  await page.goto('/studio');
  const account = page.getByRole('banner').getByRole('button', { name: 'Account menu' });
  await expect(account).toContainText(`Agent ${publicFixture.actingSubject.split('/').at(-1)!.slice(0, 8)}`);
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Switch Agent' }).click();
  await expect(page).toHaveURL('/identity?next=%2Fstudio');
  await expect(page.getByRole('radio', { checked: true })).toHaveValue(publicFixture.actingSubject);

  // Signing out from the menu ends the session and returns to the page, which asks to sign in.
  await page.goto('/studio');
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in?next=%2Fstudio');
  for (const name of ['rezics_access', 'rezics_refresh', 'rezics_session', 'rezics_subject']) {
    expect(await cookie(context, name), name).toBeUndefined();
  }
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();
});

test('WORK01: authenticated member creates a metadata-only Work with an empty Main Version', async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await signIn(page);
  await expect(page).toHaveURL('/studio');
  const title = `Browser Work ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Work title' }).fill(title);
  await page.getByRole('button', { name: 'Create Work' }).click();
  const receipt = page.getByRole('status', { name: 'Work created' });
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText(title);
  await expect(receipt).toContainText('Main Version');
  const work = await receipt.locator('dd').nth(0).innerText();
  const mainVersion = await receipt.locator('dd').nth(1).innerText();
  const revision = await receipt.locator('dd').nth(2).innerText();
  expect(work).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
  expect(mainVersion).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
  expect(mainVersion).not.toBe(work);
  await expect(receipt.locator('dd').nth(3)).toContainText(/^\d+$/);
  // The BFF serves the same Main paths to the browser as Main does.
  const selection = await page.request.get(`/api/main/v1/main-versions/${mainVersion.split('/').at(-1)}/selection`);
  expect(selection.status()).toBe(404);
  expect((await selection.json() as { code: string }).code).toBe('selection_unavailable');
  const grant = spawnSync('bun', ['apps/web/tests/grant-read.ts'], { cwd: process.cwd(),
    env: { ...process.env, REZICS_QA_WORK: work }, encoding: 'utf8', timeout: 30_000 });
  if (grant.status !== 0 || grant.error) {
    throw new Error(`QA Work read grant failed: ${grant.stderr || grant.error?.message || grant.status}`);
  }
  await page.screenshot({ path: testInfo.outputPath('work-created-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('work-created-mobile.png') });

  await page.request.post('/locale/select', { form: { locale: 'zh-CN' } });
  await page.goto(`/works/${revision.split('/').at(-1)}`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('heading', { name: '修订详情' })).toBeVisible();
  await expect(page.getByText(/此元数据修订的标识为/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('work-revision-chinese-mobile.png') });
  expect(browserErrors).toEqual([]);
});
