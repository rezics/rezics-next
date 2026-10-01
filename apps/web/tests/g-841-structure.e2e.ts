import { expect } from '@playwright/test';
import { acrossViews, desktop, firstLinks, linked, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Queries 1, 8, 9 and 12 (the membership half) of the catalogue acceptance fixtures, read through the web
// UI as the stack's web member. Each page is compared with what Main answered for the same fixture
// (`answers`, recorded by `g-841-catalogue.ts`), so a page that disagrees with the API fails.
let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  test.setTimeout(540_000);
  data = seeded();
});

const work = (key: string) => data.manifest.works[key]!.work;
const at = (locale: string, key: string, rest = '/connections') => `/${locale}/w/${uuid(work(key))}${rest}`;
const ids = (iris: string[]) => iris.map(uuid);

test('query 1: one Main Version per series Work in a franchise, and the grain is an explicit choice', async ({ page }, info) => {
  test.setTimeout(420_000);
  const saoSeries = ids(data.answers.franchises['sao.franchise']);

  await acrossViews(page, info, 'q1-series', locale => at(locale, 'sao.bunko'), '#franchises section ol li', async () => {
    const lists = page.locator('#franchises section');
    await expect(lists).toHaveCount(1);
    const members = lists.first().locator('xpath=.//ol[not(ancestor::ol)]/li');
    // The series grain: exactly Main's members of the franchise, in Main's order, one entry per Work.
    expect(await firstLinks(members)).toEqual(saoSeries);
    // Releases are not part of a franchise: no entry reaches a release.
    await expect(page.locator('#franchises a[href*="/releases/"]')).toHaveCount(0);
    // Both Works named "Sword Art Online" are two entries, never one.
    expect(new Set(saoSeries).size).toBe(saoSeries.length);
    expect(saoSeries).toEqual(expect.arrayContaining([uuid(work('sao.web')), uuid(work('sao.bunko'))]));
  });

  // Changing the grain to volumes changes the list explicitly: the parts of the series join the entries.
  await acrossViews(page, info, 'q1-parts', locale => `${at(locale, 'sao.bunko')}?grain=parts`,
    '#franchises [aria-current="true"]', async () => {
      const franchise = page.locator('#franchises section').first();
      const bunko = franchise.locator('xpath=.//ol[not(ancestor::ol)]/li').filter({
        has: page.locator(`a[href$="${uuid(work('sao.bunko'))}"]`) }).first();
      expect(await linked(bunko.locator('ol a'))).toEqual(data.answers.seriesParts['sao.bunko'].map(part => uuid(part.work)));
      await expect(franchise.locator('xpath=.//ol[not(ancestor::ol)]/li')).toHaveCount(saoSeries.length);
    });
  await page.setViewportSize(desktop);
  await page.goto(at('en', 'sao.bunko'));
  const switchTo = page.locator('#franchises').getByRole('link', { name: 'Volumes and parts' });
  await expect(page.locator('#franchises').getByRole('link', { name: 'Series' })).toHaveAttribute('aria-current', 'true');
  // A press before hydration navigates nowhere; press again until the URL has the grain.
  await expect(async () => {
    await switchTo.click();
    await expect(page).toHaveURL(/grain=parts#franchises$/, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(switchTo).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#franchises').getByText('Sword Art Online 1', { exact: true })).toBeVisible();

  // The Index franchise reads the same way and shares no entry with SAO.
  const index = ids(data.answers.franchises['index.franchise']);
  await page.goto(at('en', 'index.original'));
  const members = page.locator('#franchises section').first().locator('xpath=.//ol[not(ancestor::ol)]/li');
  expect(await firstLinks(members)).toEqual(index);
  expect(index.some(id => saoSeries.includes(id))).toBe(false);
});

test('query 8: reading order and publication order differ without changing identifiers', async ({ page }, info) => {
  test.setTimeout(420_000);
  const published = data.answers.seriesParts['index.original'].map(part => uuid(part.work));
  const reading = ids(data.answers.readingOrder);
  expect(reading).not.toEqual(published);
  expect(new Set(reading)).toEqual(new Set(published));

  // The publication order is the series' own parts list: 1–22, then SS1 and SS2.
  await acrossViews(page, info, 'q8-publication', locale => at(locale, 'index.original'), '[aria-labelledby="parts"] ol li',
    async () => {
      const parts = page.locator('[aria-labelledby="parts"] ol > li');
      expect(await linked(parts.locator('a'))).toEqual(published);
      expect(await parts.evaluateAll(items => items.map(item => item.querySelector('span')?.textContent?.trim())))
        .toEqual(data.answers.seriesParts['index.original'].map(part => part.label));
    });

  // The reading order is a Collection of the same Works: a volume names it, and it starts with SS1.
  const volume = work('index.original.1');
  await acrossViews(page, info, 'q8-reading', locale => at(locale, 'index.original.1'), '#franchises section ol li', async () => {
    const order = page.locator('#franchises section').filter({ hasText: 'Index Original reading order' });
    const first = order.locator('xpath=.//ol[not(ancestor::ol)]/li');
    expect(await firstLinks(first)).toEqual(reading.slice(0, 12));
    // The same Work carries the same identifier in both orders.
    expect(await firstLinks(first)).toContain(uuid(volume));
  });
  await page.goto(at('en', 'index.original.1'));
  const order = page.locator('#franchises section').filter({ hasText: 'Index Original reading order' });
  await order.getByRole('link', { name: 'Show more' }).click();
  await expect(page).toHaveURL(/membersAfter=/);
  const next = page.locator('#franchises section').filter({ hasText: 'Index Original reading order' })
    .locator('xpath=.//ol[not(ancestor::ol)]/li');
  expect(await firstLinks(next)).toEqual(reading.slice(12, 24));
});

test('query 9: "22" and "22 Reverse" stay distinct, Genesis Testament restarts at 1, an omnibus covers its books', async ({ page }, info) => {
  test.setTimeout(420_000);
  const labels = (key: 'index.nt' | 'index.gt') => data.answers.seriesParts[key].map(part => part.label);
  const partsOf = async () => ({
    works: await linked(page.locator('[aria-labelledby="parts"] ol > li a')),
    labels: await page.locator('[aria-labelledby="parts"] ol > li').evaluateAll(items =>
      items.map(item => item.querySelector('span')?.textContent?.trim())) });

  await acrossViews(page, info, 'q9-new-testament', locale => at(locale, 'index.nt'), '[aria-labelledby="parts"] ol li', async () => {
    const parts = await partsOf();
    expect(parts.labels).toEqual(labels('index.nt'));
    expect(parts.works).toEqual(data.answers.seriesParts['index.nt'].map(part => uuid(part.work)));
    // The two spellings are two entries on two Works.
    expect(parts.labels.filter(label => label === '22')).toHaveLength(1);
    expect(parts.labels).toContain('22 Reverse');
    expect(new Set(parts.works).size).toBe(parts.works.length);
  });
  await page.goto(at('en', 'index.nt'));
  await expect(page.getByText('Concluded')).toBeVisible();

  await acrossViews(page, info, 'q9-genesis-testament', locale => at(locale, 'index.gt'), '[aria-labelledby="parts"] ol li', async () => {
    const parts = await partsOf();
    expect(parts.labels).toEqual(labels('index.gt'));
    expect(parts.labels[0]).toBe('1');
    // Its first volume is its own Work, not the New Testament's first.
    expect(parts.works).toEqual(data.answers.seriesParts['index.gt'].map(part => uuid(part.work)));
    expect(parts.works).not.toContain(uuid(data.answers.seriesParts['index.nt'][0]!.work));
  });

  // The omnibus covers the Index Original volumes and adds no Work of its own.
  const omnibus = data.manifest.releases['index.original:omnibus']!.release;
  const originals = data.answers.seriesParts['index.original'].map(part => uuid(part.work));
  await acrossViews(page, info, 'q9-omnibus', locale => `/${locale}/releases/${uuid(omnibus)}`, '[data-coverage]', async () => {
    const covered = (await linked(page.locator('[data-coverage] a'))).filter(Boolean);
    const distinct = [...new Set(covered)];
    expect(distinct).toHaveLength(data.answers.omnibusCoverage.length);
    expect(new Set(distinct)).toEqual(new Set(ids(data.answers.omnibusCoverage)));
    expect(new Set(distinct)).toEqual(new Set(originals));
    await expect(page.locator('[data-coverage]')).toHaveCount(data.answers.omnibusCoverage.length);
  });
  await page.goto(`/en/releases/${uuid(omnibus)}`);
  await expect(page.getByRole('region', { name: 'What it covers' }).locator('[data-coverage]')).toHaveCount(data.answers.omnibusCoverage.length);
  // The same release on its Work's Editions page says how many Works it covers.
  await page.goto(`/en/w/${uuid(data.manifest.releases['index.original:omnibus']!.work)}/editions`);
  await expect(page.getByText(`Covers ${data.answers.omnibusCoverage.length} Works`)).toBeVisible();
});

test('query 12: franchise membership never merges Works', async ({ page }, info) => {
  test.setTimeout(420_000);
  const franchise = ids(data.answers.franchises['sao.franchise']);
  for (const key of ['sao.web', 'sao.bunko'] as const) {
    await acrossViews(page, info, `q12-${key}`, locale => at(locale, key), '#franchises section ol li', async () => {
      // Each Work sees the whole franchise as separate entries and marks only itself.
      const entries = page.locator('#franchises section').first().locator('xpath=.//ol[not(ancestor::ol)]/li');
      expect(await firstLinks(entries)).toEqual(franchise);
      expect(await entries.evaluateAll(items => items.filter(item => item.getAttribute('aria-current') === 'true').length)).toBe(1);
      expect(await firstLinks(entries.and(page.locator('[aria-current="true"]')))).toEqual([uuid(work(key))]);
    });
  }
});
