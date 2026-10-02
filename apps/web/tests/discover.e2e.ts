import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('Discover browses every resource type and keeps search in the selected tab', async ({
  page,
}) => {
  await page.goto('/en/discover');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Discover' })).toBeVisible();
  await expect(main.getByRole('searchbox', { name: 'Search everything' })).toBeVisible();
  await expect(main.getByRole('combobox', { name: 'Topics', exact: true })).toBeVisible();
  const types = page.getByRole('navigation', { name: 'Type' });
  await expect(types.getByRole('link', { name: 'All', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // A fresh QA stack may have no Discovery generation; unavailable sections stay explicit.
  await expect(main).toContainText(/Couldn’t load this list\.|No matches\.|results/);
  for (const [tab, label] of [
    ['works', 'Works'],
    ['communities', 'Communities'],
    ['sites', 'Sites'],
    ['people', 'People'],
    ['lists', 'Lists'],
    ['topics', 'Topics'],
  ] as const) {
    await types.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/en/discover\\?tab=${tab}$`));
    await expect(types.getByRole('link', { name: label, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(main).toContainText(/Couldn’t load this list\.|No matches\.|results/);
  }
  await types.getByRole('link', { name: 'Works', exact: true }).click();
  await main.getByRole('searchbox', { name: 'Search everything' }).fill('stars and stories');
  await main.getByRole('button', { name: 'Search', exact: true }).click();
  await expect
    .poll(() => Object.fromEntries(new URL(page.url()).searchParams))
    .toEqual({ tab: 'works', q: 'stars and stories' });
  await expect(types.getByRole('link', { name: 'Works', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.goto('/en/r?q=readers');
  await expect(page).toHaveURL(/\/en\/discover\?/);
  const query = new URL(page.url()).searchParams;
  expect(query.get('tab') ?? query.get('type')).toBe('communities');
  expect(query.get('q')).toBe('readers');
  await expect(types.getByRole('link', { name: 'Communities', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('Discover refuses unsupported legacy filters and preserves an unavailable community scope', async ({
  page,
}) => {
  for (const query of ['scope=mine', 'type=book', 'type=podcast', 'tab=unknown', 'ci=invalid']) {
    await page.goto(`/en/discover?${query}`);
    await expect(page.locator('main').getByRole('alert')).toHaveText(
      'This link doesn’t lead anywhere',
    );
    await expect(
      page.getByRole('link', { name: 'Browse everything', exact: true }),
    ).toHaveAttribute('href', '/en/discover');
  }
  const realm = randomUUID();
  await page.goto(`/en/discover?scope=realm&realm=${realm}`);
  await expect(page.locator('main').getByRole('alert')).toContainText('Couldn’t load this list.');
  expect(new URL(page.url()).searchParams.get('realm')).toBe(realm);
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
});

test('Discover fits desktop and phone widths in English and Chinese, light and dark', async ({
  page,
  context,
}, info) => {
  for (const [locale, heading] of [
    ['en', 'Discover'],
    ['zh-Hans', '发现'],
  ] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await context.addCookies([
        {
          name: 'rezics_theme',
          value: theme,
          url: new URL('/', info.project.use.baseURL).toString(),
        },
      ]);
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(`/${locale}/discover`);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
          .toBe(false);
        await page.screenshot({
          path: info.outputPath(`discover-${locale}-${theme}-${viewport.width}.png`),
          fullPage: true,
        });
      }
    }
  }
});
