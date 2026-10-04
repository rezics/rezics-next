import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resourceHref } from '../features/address/path.ts';
import { signInAtAccounts } from './account-sign-in.ts';

let data: {
  saber: string;
  alter: string;
  counterpart: string;
  unit: string;
  title: string;
  holder: string;
  realm: string;
  hidden: string;
};
test.beforeAll(() => {
  test.setTimeout(360_000);
  const seed = spawnSync('bun', ['apps/web/tests/identity-pages-seed.ts'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (seed.status !== 0 || seed.error)
    throw new Error(`Identity seed failed: ${seed.stderr || seed.error?.message}`);
  data = JSON.parse(seed.stdout.trim().split('\n').at(-1)!);
});

test('identity pages compare separate figures, preserve credits and show units and title contexts', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const path = (resource: string) => `/en${resourceHref('/e/', resource)}?position=all`;
  const credentials = JSON.parse(
    readFileSync(process.env.REZICS_WEB_AUTH_PRIVATE_PATH!, 'utf8'),
  ) as { member: { email: string; password: string } };
  const denied = await page.request.get(path(data.alter), { maxRedirects: 0 });
  expect(denied.status()).toBe(404);
  expect(denied.headers()['x-robots-tag']).toContain('noindex');
  expect(await denied.text()).toBe('');
  await signInAtAccounts(page, '/en', credentials.member);
  const hidden = await page.request.get(path(data.hidden), { maxRedirects: 0 });
  expect(hidden.status()).toBe(404);
  expect(hidden.headers()['x-robots-tag']).toContain('noindex');
  expect(await hidden.text()).not.toContain('Confidential identity');
  const legacy = `/en${resourceHref('/e/', { prefix: '/e/', key: data.alter.slice(-36), suffixSource: '' })}?position=all`;
  const canonical = await page.request.get(legacy, { maxRedirects: 0 });
  expect(canonical.status()).toBe(301);
  expect(new URL(canonical.headers().location!).pathname).toBe(
    `/en${resourceHref('/e/', data.alter)}`,
  );
  for (const [width, viewport] of [
    ['desktop', { width: 1280, height: 860 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto(path(data.alter));
    const family = page.getByRole('region', { name: 'Other versions', exact: true });
    await expect(family).toBeVisible();
    await expect(family.locator('[data-identity-member]')).toHaveCount(3);
    await expect(family.locator('[data-identity-hub]')).toContainText('Saber');
    const alter = family.locator(`[data-identity-member="${data.alter}"]`);
    await expect(alter).toContainText('Saber Alter');
    await expect(family.locator('[data-credited-name]')).toHaveCount(0);
    await expect(family.locator('[data-role-chip]')).toHaveCount(0);
    await expect(family.locator('[data-identity-question]')).toHaveCount(1);
    await expect(family.locator('[data-identity-question]')).toContainText('Global');
    await expect(family.locator('[data-identity-question]')).toContainText(
      'How would you rate this character?',
    );
    await expect(family).toContainText('Alternate self');
    await expect(family).toContainText('Counterpart from another world');
    await expect(alter).toContainText('1 rating');
    await expect(alter).toContainText('4 more ratings will reveal the average.');
    await expect(alter.locator('[data-rating-mean="withheld"] svg')).toHaveCount(0);
    await expect(alter.locator('[data-rating-strip]')).toBeVisible();
    const empty = family.locator(`[data-identity-member="${data.counterpart}"]`);
    await expect(empty).toContainText('No ratings yet.');
    await expect(empty.locator('[data-rating-strip]')).toHaveCount(0);
    await expect(family.locator(`[data-identity-member="${data.saber}"]`)).toContainText('8/10');
    await expect(
      page
        .getByRole('region', { name: 'Titles held', exact: true })
        .locator('[data-title-context]'),
    ).toContainText('Fate/stay night');
    await expect(family.getByRole('link', { name: 'Saber', exact: true }).first()).toHaveAttribute(
      'href',
      /position=all/,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`variant-${width}.png`), fullPage: true });
    await page.goto(path(data.saber));
    await expect(page.getByRole('region', { name: 'Units', exact: true })).toContainText(
      'Saber unit',
    );
    await expect(
      page.getByRole('region', { name: 'Units', exact: true }).locator('[data-identity-question]'),
    ).toContainText('How would you rate this game unit?');
    await page.goto(path(data.unit));
    await expect(page.getByRole('region', { name: 'Represents', exact: true })).toContainText(
      'Saber',
    );
    await expect(
      page
        .getByRole('region', { name: 'Represents', exact: true })
        .locator('[data-identity-ratings]'),
    ).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`unit-${width}.png`), fullPage: true });
    await page.goto(path(data.title));
    const holders = page.getByRole('region', { name: 'Holders', exact: true });
    await expect(holders).toBeVisible();
    await expect(holders.locator('[data-identity-member]')).toHaveCount(2);
    await expect(holders).toContainText('Fate/stay night');
    await expect(holders).toContainText('Fate/Prototype');
    await expect(holders).toContainText('Arthur');
    await expect(holders.locator('[data-identity-ratings]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Ratings', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`title-${width}.png`), fullPage: true });
  }
});
