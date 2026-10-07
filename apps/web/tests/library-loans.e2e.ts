import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

// A reader records a copy of an exact edition, lends it with a due date already
// past, then extends and returns it. The loan stays private to that reader and
// is still there after a reload. Other books already in the library stay put.

interface Seed { work: string; title: string; release: string }

function member(): { email: string; password: string } {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return (JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } }).member;
}

let seed: Seed;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  const result = spawnSync('bun', ['apps/web/tests/library-loans-seed.ts'], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 120_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Loans seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
  const work = seed.work.slice(-36);
  const releases = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${work}/releases`;
  const workUrl = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${work}`;
  let seen = false;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 45_000; Date.now() < deadline && !(seen && still >= 4);) {
    const [releaseResponse, workResponse] = await Promise.all([
      fetch(releases).catch(() => null), fetch(workUrl).catch(() => null),
    ]);
    if (releaseResponse?.ok) {
      const body = await releaseResponse.json() as { items?: { id?: string }[] };
      seen = body.items?.some(item => item.id === seed.release) ?? false;
    }
    const position = workResponse?.ok
      ? JSON.stringify((await workResponse.json() as { sourcePosition: unknown }).sourcePosition) : '';
    still = seen && position && position === last ? still + 1 : 0;
    last = position;
    if (!(seen && still >= 4)) await new Promise(done => setTimeout(done, 400));
  }
  if (!seen) throw new Error('The seeded edition did not appear on the running Main');
  if (still < 4) throw new Error('Main’s graph kept moving after the seed');
});

const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

/** A full navigation paints the buttons before their click handlers are attached. */
const interactive = (page: Page) => page.locator('button[aria-label="Account menu"][data-hydrated="true"]').first()
  .waitFor({ timeout: 30_000 });

async function localStamp(page: Page, instant: number): Promise<string> {
  return page.evaluate(value => {
    const date = new Date(value);
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }, instant);
}

test('signed out, Loans asks for sign-in and comes back', async ({ page }) => {
  const response = await page.request.get('/en/library/loans', { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()['location']).toBe(`/auth/start?next=${encodeURIComponent('/en/library/loans')}`);
});

test('a reader owns a copy, lends it overdue, extends it and returns it', async ({ page }, info) => {
  test.setTimeout(240_000);
  const workPath = localizedPath(resourceHref('/w/', seed.work.slice(-36)), 'en');
  await signInAtAccounts(page, workPath, member());
  await page.getByRole('button', { name: 'More shelves' }).click();
  await page.getByRole('menuitemradio', { name: 'Currently reading' }).click();
  const shelved = page.getByRole('button', { name: /^Currently reading — Shelve/ });
  await expect(shelved).toBeVisible();
  await expect(shelved).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 });
  await expect(async () => {
    await page.goto('/en/library?shelf=reading');
    await expect(page.getByRole('heading', { level: 3, name: seed.title })).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 20_000 });
  await interactive(page);
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  const own = page.getByRole('button', { name: `I own a copy, ${seed.title}` });
  await expect(own).toHaveAttribute('data-hydrated', 'true');
  await expect(async () => {
    await own.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
  const copy = page.getByRole('dialog', { name: `A copy of “${seed.title}”` });
  if (await copy.count() === 0) {
    const openName = await page.getByRole('dialog').first().getAttribute('aria-label').catch(() => '');
    throw new Error(`The copy dialog did not open (${openName || 'no name'}). ${problems.join(' | ') || 'no page error'}`);
  }
  await expect(copy.getByRole('radio', { name: /Paperback library edition/ })).toBeVisible({ timeout: 15_000 });
  await copy.getByLabel('Format').fill('Paperback');
  await copy.getByRole('textbox', { name: 'Name', exact: true }).fill('City Library');
  await copy.getByLabel('Acquired on').fill('2024-02-01');
  await copy.getByLabel('Owned since').fill('2024-03-01');
  await copy.getByRole('button', { name: 'Save copy' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copy saved' })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: `Lend, ${seed.title}` }).click();
  const lend = page.getByRole('dialog', { name: `Lend “${seed.title}”` });
  await expect(lend.getByRole('radio', { name: /Paperback/ })).toBeVisible();
  await lend.getByRole('textbox', { name: 'Name', exact: true }).fill('City Library');
  await lend.getByLabel('Started').fill(await localStamp(page, Date.now() - 3 * 86_400_000));
  await lend.getByLabel('Due').fill(await localStamp(page, Date.now() - 36 * 3_600_000));
  await lend.getByRole('button', { name: 'Save loan' }).click();
  await expect(page).toHaveURL(/\/en\/library\/loans$/, { timeout: 30_000 });

  const overdue = () => page.getByRole('region', { name: 'Overdue' }).getByRole('listitem').filter({ hasText: seed.title });
  await expect(overdue()).toBeVisible({ timeout: 30_000 });
  await expect(overdue()).toContainText('City Library');
  await expect(overdue().getByText('Overdue', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 860 });
  await expect(overdue()).toBeVisible();
  expect(await overflows(page), '1280').toBe(false);
  await page.screenshot({ path: info.outputPath('loans-overdue-1280.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(overdue()).toBeVisible();
  expect(await overflows(page), '390').toBe(false);
  await page.screenshot({ path: info.outputPath('loans-overdue-390.png'), fullPage: true });

  await page.setViewportSize({ width: 1280, height: 860 });
  await page.reload();
  await interactive(page);
  await expect(overdue()).toContainText('City Library');

  await overdue().getByRole('button', { name: 'Extend' }).click();
  const extend = page.getByRole('dialog', { name: 'Extend the due date' });
  await extend.getByRole('button', { name: 'Extend' }).click();
  await expect(page.getByRole('region', { name: 'Due soon' }).getByRole('listitem').filter({ hasText: seed.title }))
    .toBeVisible({ timeout: 30_000 });
  await page.reload();
  await interactive(page);
  await expect(page.getByRole('region', { name: 'Overdue' }).getByRole('listitem').filter({ hasText: seed.title }))
    .toHaveCount(0);
  const due = page.getByRole('region', { name: 'Due soon' }).getByRole('listitem').filter({ hasText: seed.title });
  await expect(due).toContainText('City Library');

  await due.getByRole('button', { name: 'Return' }).click();
  const returning = page.getByRole('alertdialog', { name: 'Return this loan?' });
  await returning.getByRole('button', { name: 'Return' }).click();
  await expect(page.getByRole('heading', { name: seed.title })).toHaveCount(0, { timeout: 30_000 });
  await page.reload();
  await interactive(page);
  await expect(page.getByRole('heading', { name: seed.title })).toHaveCount(0);
});
