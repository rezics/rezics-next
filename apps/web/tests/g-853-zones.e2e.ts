import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import { axeViolations, formatViolations } from './a11y-axe.ts';

// Two official Zones over one library, written once into this isolated QA stack through Main's routes
// (`g-853-seed.ts`): Visual Novels, where a reader finds a release that is playable in their language,
// and Light Novels, where a signed-in reader finds the next volume. Both packages run, approved for the
// source this build carries; the browser then reads them on a phone and a desktop, in English and in
// Traditional Chinese.
interface Work { work: string }
interface Seed {
  sao: { series: Work; volumes: Work[] };
  vn: { garden: Work; trial: Work; fable: Work; shared: Work };
  translator: string;
  zones: { visual: string; light: string };
}
let seed: Seed;
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(420_000);
  const result = spawnSync('bun', ['apps/web/tests/g-853-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 360_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`G-853 seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
  // Main keeps processing the seed's events for a while, moving the graph under every read (409).
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${uuid(seed.vn.shared.work)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok ? JSON.stringify((await response.json() as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for two minutes after the seed');
});

const uuid = (iri: string) => iri.slice(-36);
const viewports = [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }] as const;
const locales = ['en', 'zh-Hant'] as const;
const filtered = (locale: string, extra = '') =>
  `/${locale}/r/visual-novels/browse?releaseLanguage=en&releasePlatform=Windows&releaseCompleteness=complete${extra}`;

function credentials() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return JSON.parse(readFileSync(path, 'utf8')) as { actingSubject: string; member: { email: string; password: string } };
}

const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

async function check(page: Page, info: TestInfo, name: string) {
  expect(await overflows(page), `${name} overflows`).toBe(false);
  const violations = await axeViolations(page);
  expect(violations, formatViolations(violations)).toEqual([]);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

/** The page and its scripts have loaded; the Zone's own markup is server-rendered, so assertions wait on it directly. */
const ready = (page: Page) => page.waitForLoadState('load');

for (const viewport of viewports) {
  for (const locale of locales) {
    test(`Visual Novels ${locale} ${viewport.name}: English + Windows + complete finds one release, and a trial or a title does not`,
      async ({ page }, info) => {
        test.setTimeout(180_000);
        await page.setViewportSize(viewport);
        await page.goto(`/${locale}/r/visual-novels/browse`);
        await ready(page);
        const form = page.getByRole('form', { name: locale === 'en' ? 'Find a playable release' : '尋找可玩的發行版' });
        await expect(form).toBeVisible();
        // The Zone brings its own words for every field, and the URL carries the choice.
        await page.goto(filtered(locale));
        await ready(page);
        const results = page.locator('[data-release-results]');
        await expect(results).toBeVisible();
        await expect(results.getByRole('link', { name: 'Moonlit Garden' }).first()).toBeVisible();
        await expect(results.getByRole('link', { name: 'Fan Translated Fable' }).first()).toBeVisible();
        // A Work whose only English Windows release is a trial, and one with no Windows release, are not results.
        await expect(results.getByRole('link', { name: 'Trial Only Tale' })).toHaveCount(0);
        await expect(results.getByRole('link', { name: 'Starlit Crossing' })).toHaveCount(0);
        // Each result says which release matched; a fan translation names its translator.
        const fan = results.locator('li').filter({ hasText: 'Fan Translated Fable' });
        const line = fan.locator('[data-release-line]');
        await expect(line).toContainText(locale === 'en' ? 'English · Windows · complete · fan translation by'
          : '英文 · Windows · 完整 ·');
        await expect(line).toContainText('Moonlight Translators');
        const official = results.locator('li').filter({ hasText: 'Moonlit Garden' }).locator('[data-release-line]');
        await expect(official).toContainText(locale === 'en' ? 'English · Windows · complete · official release'
          : '英文 · Windows · 完整 · 官方發行');
        await check(page, info, `vn-filtered-${locale}-${viewport.name}`);

        // Trial is its own answer: the same Work appears when the reader asks for trials.
        await page.goto(`/${locale}/r/visual-novels/browse?releaseLanguage=en&releasePlatform=Windows&releaseCompleteness=trial`);
        await ready(page);
        await expect(page.locator('[data-release-results]').getByRole('link', { name: 'Trial Only Tale' }).first()).toBeVisible();
        await expect(page.locator('[data-release-results]').getByRole('link', { name: 'Moonlit Garden' })).toHaveCount(0);

        // Nothing meets this one: it says so and offers to clear, and lists no look-alike.
        await page.goto(`/${locale}/r/visual-novels/browse?releaseLanguage=th&releasePlatform=Windows`);
        await ready(page);
        await expect(page.locator('[data-release-results]')).toHaveCount(0);
        await expect(page.getByRole('heading', { name: locale === 'en' ? 'No release meets every filter'
          : '沒有發行版符合全部篩選條件' })).toBeVisible();
        await check(page, info, `vn-no-match-${locale}-${viewport.name}`);
      });
  }
}

test('Visual Novels: the filter works by keyboard alone', async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.goto('/en/r/visual-novels/browse');
  await ready(page);
  // Native selects take letters; Tab moves on and Enter submits.
  await page.getByLabel('Language').focus();
  await page.keyboard.type('English');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Platform')).toBeFocused();
  await page.keyboard.type('Windows');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Completeness')).toBeFocused();
  await page.keyboard.type('Complete');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Show matching novels' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/releaseLanguage=en&releasePlatform=Windows&releaseCompleteness=complete/);
  await expect(page.locator('[data-release-results]').getByRole('link', { name: 'Moonlit Garden' }).first()).toBeVisible();
  await expect(page.locator('[data-release-results]').getByRole('link', { name: 'Trial Only Tale' })).toHaveCount(0);
  // A chip removes one condition; the rest stay.
  await page.getByRole('link', { name: 'Remove filter: Complete' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/releaseLanguage=en&releasePlatform=Windows(&|$)/);
  await expect(page).not.toHaveURL(/releaseCompleteness/);
  await expect(page.locator('[data-release-results]').getByRole('link', { name: 'Trial Only Tale' }).first()).toBeVisible();
  await check(page, info, 'vn-keyboard');
});

test('Visual Novels: a page leads with where the novel can be played, and credits its source', async ({ page }, info) => {
  test.setTimeout(120_000);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(`/en/r/visual-novels/catalogue/${uuid(seed.vn.garden.work)}`);
    await ready(page);
    const availability = page.locator('#vn-availability');
    await expect(availability).toBeAttached();
    await expect(page.locator('#vn-about')).toBeAttached();
    // Availability comes first in the page's order.
    const order = await page.evaluate(() => {
      const first = document.getElementById('vn-availability')!;
      const second = document.getElementById('vn-about')!;
      return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(order).toBe(true);
    await expect(page.locator('.vn-availability')).toContainText('Moonlit Garden release');
    await expect(page.locator('.vn-availability')).toContainText('Windows');
    await expect(page.locator('.vn-source').first()).toContainText('VNDB');
    await expect(page.getByRole('link', { name: 'Open the Light Novels Zone' })).toBeVisible();
    await expect(page.getByText('does not sell games, link to stores, show prices')).toBeVisible();
    await check(page, info, `vn-detail-${viewport.name}`);
  }
});

test('Light Novels and Visual Novels show the same Works with the same library state; the next volume is Main’s', async ({ page }, info) => {
  test.setTimeout(300_000);
  await page.setViewportSize(viewports[1]);
  const { actingSubject, member } = credentials();
  await signInAtAccounts(page, `/en/r/light-novels`, member);
  await ready(page);
  const idempotency = () => ({ 'idempotency-key': crypto.randomUUID() });
  // The reader read volume 1 of Sword Art Online, and shelved the shared novel as read.
  const volume = seed.sao.volumes[0]!, second = seed.sao.volumes[1]!;
  const finished = await page.request.post('/api/main/v1/me/sessions', { headers: idempotency(),
    data: { actingSubject, target: volume.work, expectedVersion: 0, state: 'finished' } });
  expect(finished.status(), await finished.text()).toBe(201);
  const shelved = await page.request.put(`/api/main/v1/works/${uuid(seed.vn.shared.work)}/reader-status`, {
    headers: idempotency(), data: { actingSubject, expectedVersion: 0, status: 'read' } });
  expect(shelved.status(), await shelved.text()).toBeLessThan(300);

  // Light Novels: "Continue your series" names volume 2 as next, in the reader's language.
  await page.goto('/en/r/light-novels');
  await ready(page);
  const shelf = page.locator('[data-next-volume-shelf]');
  await expect(shelf).toBeVisible({ timeout: 30_000 });
  await expect(shelf).toContainText('Sword Art Online');
  await expect(shelf.locator('[data-next-volume]')).toContainText('Next part: 2');
  await expect(shelf.getByRole('link', { name: '2', exact: true })).toHaveAttribute('href', new RegExp(`/w/${uuid(second.work)}$`));
  await check(page, info, 'ln-home-desktop');

  // The series page shows Main's progress panel with the same next volume.
  await page.goto(`/en/r/light-novels/catalogue/${uuid(seed.sao.series.work)}`);
  await ready(page);
  const panel = page.getByRole('region', { name: 'Series progress' });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('[data-next]')).toContainText('2');
  await check(page, info, 'ln-series-desktop');

  // One Work, one library state: shelved as read in the Light Novels Zone, the Visual Novels Zone and on its own page.
  const shared = uuid(seed.vn.shared.work);
  const mark = (name: RegExp) => page.getByRole('button', { name }).first();
  await page.goto('/en/r/light-novels');
  await ready(page);
  await expect(page.getByRole('button', { name: /Starlit Crossing.*· Read/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.goto('/en/r/visual-novels/browse?releaseLanguage=en&releasePlatform=Switch');
  await ready(page);
  await expect(page.locator('[data-release-results]').getByRole('link', { name: 'Starlit Crossing' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Starlit Crossing.*· Read/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.goto(`/en/w/${shared}`);
  await ready(page);
  await expect(mark(/^Read — Shelve/)).toBeVisible({ timeout: 30_000 });
});
