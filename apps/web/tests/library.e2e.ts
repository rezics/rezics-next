import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

// Library in a real browser against a fresh QA stack: the QA member starts
// with nothing shelved, shelves a seeded public Book from its page
// and then manages it from /library. A QA Agent Main does not treat as a
// baseline member has no reader library; Library then says so and stops.

interface Seed {
  work: string;
  title: string;
}

function member(): { email: string; password: string } {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path)
    throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return (JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } })
    .member;
}

let seed: Seed;
test.beforeAll(async () => {
  test.setTimeout(150_000);
  const result = spawnSync('bun', ['apps/web/tests/library-seed.ts'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 90_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Work seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
  // Main keeps processing the seed's events for a while (409 on reads); start once its position holds still.
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${seed.work.slice(-36)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok
      ? JSON.stringify(((await response.json()) as { sourcePosition: unknown }).sourcePosition)
      : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for a minute after the seed');
});

const shelves = (page: Page) => page.getByRole('navigation', { name: 'Shelves' });
const overflows = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

test('signed out, Library asks for sign-in and comes back to the same view', async ({ page }) => {
  // The bare address takes the reader's language first.
  const bare = await page.request.get('/library?shelf=read', {
    maxRedirects: 0,
    headers: { 'accept-language': 'en-US' },
  });
  expect(bare.status()).toBe(307);
  expect(bare.headers().location).toMatch(/\/en\/library\?shelf=read$/);
  const localized = await page.request.get('/en/library?shelf=read&sort=title', {
    maxRedirects: 0,
  });
  expect(localized.status()).toBe(307);
  expect(localized.headers().location).toBe(
    `/auth/start?next=${encodeURIComponent('/en/library?shelf=read&sort=title')}`,
  );
});

test('a reader starts with an empty library, shelves a Work and manages it from Library', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180_000);
  await signInAtAccounts(page, '/en/library', member());
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  if (await page.getByRole('heading', { name: 'This identity has no library' }).isVisible()) {
    await expect(page.getByRole('link', { name: 'Choose identity' })).toHaveAttribute(
      'href',
      `/en/identity?next=${encodeURIComponent('/en/library')}`,
    );
    return;
  }
  await expect(
    page.getByRole('heading', { level: 2, name: 'Your library starts here' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Discover works' })).toHaveAttribute(
    'href',
    '/en/discover',
  );
  await expect(page.getByRole('link', { name: 'Go to your feed' })).toHaveAttribute('href', '/en');

  // Shelved on its page, the Work is in Library under Want to read.
  await page.goto(localizedPath(resourceHref('/w/', seed.work.slice(-36)), 'en'));
  await page.getByRole('button', { name: 'Want to read', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Want to read — Shelve/ })).toBeVisible();
  await page.goto('/en/library');
  await expect(shelves(page).getByRole('link', { name: 'Want to read 1' })).toHaveAttribute(
    'href',
    '/en/library?shelf=want-to-read',
  );
  // All lists the shelves. The Work is on the status shelf Main pages.
  await shelves(page).getByRole('link', { name: 'Want to read 1' }).click();
  await expect(page).toHaveURL(/\/en\/library\?shelf=want-to-read$/);
  await expect(page.getByRole('heading', { level: 3, name: seed.title })).toBeVisible();

  // Select moves it to Read; the counts follow.
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('checkbox', { name: `Select “${seed.title}”` }).check();
  const bar = page.getByRole('toolbar', { name: 'Selected works' });
  await bar.getByRole('button', { name: 'Move to' }).click();
  await page.getByRole('menuitem', { name: 'Read', exact: true }).click();
  await expect(page.getByText('Moved 1 work to Read.')).toBeVisible();
  await expect(shelves(page).getByRole('link', { name: 'Read 1' })).toBeVisible({
    timeout: 15_000,
  });

  // On Read, reading dates are set in place and survive a reload.
  await shelves(page).getByRole('link', { name: 'Read 1' }).click();
  await expect(page).toHaveURL(/\/en\/library\?shelf=read$/);
  await page.getByRole('button', { name: `Add dates — ${seed.title}` }).click();
  const dates = page.getByRole('dialog', { name: `Reading dates for “${seed.title}”` });
  await dates.getByLabel('Started').fill('2026-01-02');
  await dates.getByLabel('Finished').fill('2026-01-12');
  await dates.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Read Jan 2 – 12, 2026')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Read Jan 2 – 12, 2026')).toBeVisible();

  // Who can see the shelves is chosen here and kept by Main.
  await page.getByRole('button', { name: 'Who can see your reading shelves: Everyone' }).click();
  await page.getByRole('menuitemradio', { name: /^Only you/ }).click();
  await expect(
    page.getByRole('button', { name: 'Who can see your reading shelves: Only you' }),
  ).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Who can see your reading shelves: Only you' }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // The page at desktop and phone sizes, light and dark, in English and Chinese, with no sideways scroll.
  for (const locale of ['en', 'zh-Hans'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await context.addCookies([{ name: 'rezics_theme', value: theme, url: page.url() }]);
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(`/${locale}/library?shelf=read`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await overflows(page), `${locale} ${theme} ${viewport.width}`).toBe(false);
        await page.screenshot({
          path: info.outputPath(`library-${locale}-${theme}-${viewport.width}.png`),
          fullPage: true,
        });
      }
    }
  }

  // Removed from the library, the reader is back where they started.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/en/library?shelf=read');
  await page.getByRole('button', { name: /^Read — Shelve/ }).click();
  await page.getByRole('menuitem', { name: 'Remove from my shelves' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Your library starts here' }),
  ).toBeVisible({ timeout: 15_000 });
});
