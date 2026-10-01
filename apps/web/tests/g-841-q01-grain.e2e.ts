import { expect } from '@playwright/test';
import { acrossViews, desktop, firstLinks, linked, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Query 1 of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
// compared with what Main answered for the same fixture (`answers`, recorded by `g-841-catalogue.ts`), so a
// page that disagrees with the API fails.

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
  // A Work can sit in several franchises (the crossover Zone's collection also lists it); this is the Index's own.
  const members = page.locator('#franchises section').filter({ has: page.getByRole('heading', { name: 'A Certain Magical Index', exact: true }) })
    .locator('xpath=.//ol[not(ancestor::ol)]/li');
  expect(await firstLinks(members)).toEqual(index);
  expect(index.some(id => saoSeries.includes(id))).toBe(false);
});

