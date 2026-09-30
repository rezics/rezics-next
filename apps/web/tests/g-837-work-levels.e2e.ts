import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import type { Catalogue } from './g-837-catalogue.ts';

// The franchise records are written once into this isolated QA stack through Main's routes
// (`g-837-catalogue.ts`); the browser then signs in as the stack's web member and reads them
// on desktop and on a phone, in English and in Simplified Chinese.
let catalogue: Catalogue;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  const result = spawnSync('bun', ['apps/web/tests/g-837-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 240_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`G-837 seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  catalogue = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Catalogue;
  // Main keeps processing the seed's events for a while, moving the graph under every read (409).
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${uuid(catalogue.index.overall.work)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok ? JSON.stringify((await response.json() as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for 90 seconds after the seed');
});

const uuid = (iri: string) => iri.slice(-36);
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };
const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

/** One screenshot per viewport in light and dark, none with horizontal overflow. */
async function shoot(page: Page, context: BrowserContext, path: string, name: string, info: TestInfo) {
  for (const theme of ['light', 'dark'] as const) {
    await context.addCookies([{ name: 'rezics_theme', value: theme, url: page.url() }]);
    for (const [label, viewport] of [['desktop', desktop], ['phone', phone]] as const) {
      await page.setViewportSize(viewport);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      expect(await overflows(page), `${name} ${theme} ${label}`).toBe(false);
      await page.screenshot({ path: info.outputPath(`${name}-${theme}-${label}.png`), fullPage: true });
    }
  }
  await page.setViewportSize(desktop);
}

test('parts, connections and editions read from Main for the franchise records', async ({ page, context }, info) => {
  test.setTimeout(420_000);
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  const { member } = JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } };
  const { sao, index, railgun, volumeOne } = catalogue;
  const at = (work: { work: string }, tab: string) => `/en/w/${uuid(work.work)}/${tab}`;
  await page.setViewportSize(desktop);
  await signInAtAccounts(page, at(index.newTestament, 'connections'), member);

  // Index: New Testament lists "22" and "22 Reverse" as separate parts, in Main's order, and is concluded.
  const parts = page.getByRole('list', { name: 'Parts in publication order' });
  await expect(parts.getByRole('listitem')).toHaveCount(4);
  await expect(parts.getByRole('listitem')).toHaveText([/^1\s*New Testament 1/, /^2/, /^22\s*New Testament 22$/, /^22 Reverse/]);
  await expect(page.getByText('Concluded')).toBeVisible();
  // The whole that places it is named and leads to it.
  const partOf = page.getByRole('list', { name: 'Wholes that contain this Work' });
  await expect(partOf).toContainText('Part of');
  await expect(partOf.getByRole('link', { name: 'A Certain Magical Index' })).toHaveAttribute('href', `/en/w/${uuid(index.overall.work)}`);
  // The sequel relation reads as a row with Main's label.
  await expect(page.locator('[data-relation-row]').filter({ hasText: 'Sequel' })).toContainText('Genesis Testament');

  // Genesis Testament restarts at 1.
  await page.goto(at(index.genesisTestament, 'connections'));
  await expect(page.getByRole('list', { name: 'Parts in publication order' }).getByRole('listitem')).toHaveText([/^1\s*Genesis Testament 1$/, /^2\s*Genesis Testament 2$/]);
  await expect(page.locator('[data-relation-row]').filter({ hasText: 'Sequel to' })).toContainText('New Testament');

  // Sword Art Online: the franchise switches between series and volumes, visibly.
  await page.goto(at(sao.bunko, 'connections'));
  const franchises = page.locator('#franchises');
  const series = franchises.getByRole('list', { name: 'Series' });
  await expect(series.getByRole('listitem')).toHaveCount(4);
  await expect(series.getByRole('listitem').filter({ hasText: 'This Work' })).toContainText('Sword Art Online');
  await expect(franchises.getByText('Sword Art Online, Vol. 1')).toHaveCount(0);
  await franchises.getByRole('link', { name: 'Volumes and parts' }).click();
  await expect(page).toHaveURL(/grain=parts#franchises$/);
  await expect(franchises.getByRole('link', { name: 'Volumes and parts' })).toHaveAttribute('aria-current', 'true');
  await expect(franchises.getByText('Sword Art Online, Vol. 1')).toBeVisible();
  await expect(franchises.getByText('Sword Art Online Progressive, Vol. 2')).toBeVisible();
  // Relations in both directions: the bunko Work links to the web Work and to what reboots and spins off from it.
  const rows = page.locator('[data-relation-row]');
  await expect(rows.filter({ hasText: 'Rewrite of' }).getByRole('link', { name: 'Sword Art Online (web)' }))
    .toHaveAttribute('href', `/en/w/${uuid(sao.web.work)}`);
  await expect(rows.filter({ hasText: 'Reboot' })).toContainText('Sword Art Online Progressive');
  await expect(rows.filter({ hasText: 'Spin-off' })).toContainText('Alternative Gun Gale Online');

  // Progressive shows Reboot and Alternative GGO shows SpinOff, each from its own side.
  await page.goto(at(sao.progressive, 'connections'));
  await expect(page.locator('[data-relation-row]').filter({ hasText: 'Reboot of' })).toContainText('Sword Art Online');
  await page.goto(at(sao.aggo, 'connections'));
  await expect(page.locator('[data-relation-row]').filter({ hasText: 'Spin-off of' })).toContainText('Sword Art Online');

  // The Railgun anime traverses to the Index novel; the unresolved source is visible, not hidden.
  await page.goto(at(railgun.anime, 'connections'));
  const adapted = page.locator('[data-relation-row]').filter({ hasText: 'Adapted from' });
  await expect(adapted.getByText('Source version unresolved')).toBeVisible();
  await adapted.getByRole('link', { name: 'A Certain Scientific Railgun (manga)' }).click();
  await expect(page).toHaveURL(new RegExp(`/en/w/${uuid(railgun.manga.work)}`));
  await page.goto(at(railgun.manga, 'connections'));
  await page.locator('[data-relation-row]').filter({ hasText: 'Spin-off of' })
    .getByRole('link', { name: 'A Certain Magical Index (novel)' }).click();
  await expect(page).toHaveURL(/\/en\/w\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'A Certain Magical Index (novel)' })).toBeVisible();

  // Volume 1 editions: zh-Hant and zh-Hans stay apart; each says who stands behind it.
  await page.goto(at(volumeOne.work, 'editions'));
  const hant = page.locator('[data-language-group="zh-Hant"]');
  const hans = page.locator('[data-language-group="zh-Hans"]');
  await expect(hant).toBeVisible();
  await expect(hans).toBeVisible();
  await expect(hant.getByText('Verified')).toBeVisible();
  await expect(hant.getByText('Official')).toBeVisible();
  await expect(hant.getByText(/Source text:/)).toBeVisible();
  await expect(hans.getByText('Unverified')).toBeVisible();
  await expect(hans.getByText('Unofficial')).toBeVisible();
  await expect(hans.getByText('Source not resolved yet')).toBeVisible();
  await expect(page.locator('[data-language-group]')).toHaveCount(4);
  // Releases: format, identifiers, platform and territory, and an omnibus listing the volumes it covers.
  const releases = page.getByRole('region', { name: 'Releases' });
  await expect(releases.getByRole('link', { name: '9780316371247' })).toHaveAttribute('href', '/en/isbn/9780316371247');
  await expect(releases).toContainText('paperback');
  await expect(releases).toContainText('US');
  await expect(releases.getByText('Covers 3 Works')).toBeVisible();

  // The ISBN reaches the release, its realization and its Work.
  await page.goto(`/en/isbn/${volumeOne.isbn}`);
  await expect(page).toHaveURL(new RegExp(`/en/releases/${uuid(volumeOne.release)}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Sword Art Online 1: Aincrad' })).toBeVisible();
  await expect(page.getByText('English').first()).toBeVisible();
  await expect(page.getByText('Main Version').first()).toBeVisible();
  await page.getByRole('region', { name: 'What it covers' }).getByRole('link', { name: 'Sword Art Online, Vol. 1' }).click();
  await expect(page).toHaveURL(`/en/w/${uuid(volumeOne.work.work)}`);
  expect((await page.goto('/en/isbn/9780316371248'))?.status()).toBe(404);
  expect((await page.goto('/en/isbn/9780306406157'))?.status()).toBe(404);

  // Every page in Simplified Chinese keeps names in their own language and the interface in the reader's.
  await page.goto(`/zh-Hans/w/${uuid(index.newTestament.work)}/connections`);
  await expect(page.getByRole('region', { name: '组成部分' })).toBeVisible();
  await expect(page.getByText('已完结')).toBeVisible();
  await page.goto(`/zh-Hans/w/${uuid(volumeOne.work.work)}/editions`);
  await expect(page.getByRole('region', { name: '文本与译本' })).toBeVisible();
  await expect(page.locator('[data-language-group="zh-Hant"]')).toBeVisible();

  // Screenshots, desktop and phone in both themes, none overflowing.
  await shoot(page, context, at(index.newTestament, 'connections'), 'index-connections', info);
  await shoot(page, context, at(sao.bunko, 'connections') + '?grain=parts', 'sao-connections-parts', info);
  await shoot(page, context, at(railgun.anime, 'connections'), 'railgun-connections', info);
  await shoot(page, context, at(volumeOne.work, 'editions'), 'volume-editions', info);
  await shoot(page, context, `/en/releases/${uuid(volumeOne.release)}`, 'release', info);
  await shoot(page, context, `/zh-Hans/w/${uuid(sao.bunko.work)}/connections`, 'sao-connections-zh-Hans', info);
});
