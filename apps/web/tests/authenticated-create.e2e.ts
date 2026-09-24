import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

interface PublicFixture { actingSubject: string }
interface PrivateFixture { member: { email: string; password: string } }

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

test('WORK01: authenticated member creates a metadata-only Work with an empty Main Version', async ({ page }, testInfo) => {
  const publicFixture = fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH');
  const privateFixture = fixture<PrivateFixture>('REZICS_WEB_AUTH_PRIVATE_PATH');
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));

  const invalidCallback = await page.goto('/auth/callback?code=invalid&state=invalid');
  expect(invalidCallback?.status()).toBe(400);
  await expect(page.getByText('Authorization state is invalid or expired')).toBeVisible();

  await page.goto('/studio');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fstudio$/);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Email' }).fill(privateFixture.member.email);
  await page.getByLabel('Password').fill(privateFixture.member.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/identity\?next=%2Fstudio$/);
  await expect(page.getByRole('heading', { name: 'Choose an acting identity' })).toBeVisible();

  const deniedSubject = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  expect(deniedSubject).not.toBe(publicFixture.actingSubject);
  await page.getByRole('textbox', { name: 'Identity ID' }).fill(deniedSubject);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Identity' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Work title' }).fill('Unauthorized QA Work');
  await page.getByRole('button', { name: 'Create Work' }).click();
  await expect(page.getByRole('alert')).toHaveText('This identity is not authorized to create a Work.');

  await page.goto('/identity?next=/studio');
  await page.getByRole('textbox', { name: 'Identity ID' }).fill(publicFixture.actingSubject);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/studio$/);
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
  const mainOrigin = process.env.MAIN_ORIGIN;
  if (!mainOrigin) throw new Error('The isolated Main origin is unavailable');
  const selection = await page.request.get(`${mainOrigin}/v1/main-versions/${mainVersion.split('/').at(-1)}/selection`);
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

  await page.getByRole('form', { name: 'Interface language' })
    .getByRole('button', { name: '简体中文' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('heading', { name: '创建作品' })).toBeVisible();
  await page.goto(`/works/${revision.split('/').at(-1)}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('heading', { name: '修订详情' })).toBeVisible();
  await expect(page.getByText(/此元数据修订的标识为/)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('work-revision-chinese-mobile.png') });
  expect(browserErrors).toEqual([]);
});
