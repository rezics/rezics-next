import type { UiLocale } from '../i18n/define.ts';
import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { expect } from '@playwright/test';
import {
  acrossViews,
  firstLinks,
  linked,
  seeded,
  test,
  uuid,
  type Seeded,
} from './g-841-fixture.ts';

// Query 8 of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
// compared with what Main answered for the same fixture (`answers`, recorded by `g-841-catalogue.ts`), so a
// page that disagrees with the API fails.

let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  test.setTimeout(540_000);
  data = seeded();
});

const work = (key: string) => data.manifest.works[key]!.work;
const at = (locale: UiLocale, key: string, rest = '/connections') =>
  localizedPath(`${resourceHref('/w/', uuid(work(key)))}${rest}`, locale);
const ids = (iris: string[]) => iris.map(uuid);

test('query 8: reading order and publication order differ without changing identifiers', async ({
  page,
}, info) => {
  test.setTimeout(420_000);
  const published = data.answers.seriesParts['index.original'].map((part) => uuid(part.work));
  const reading = ids(data.answers.readingOrder);
  expect(reading).not.toEqual(published);
  expect(new Set(reading)).toEqual(new Set(published));

  // The publication order is the series' own parts list: 1–22, then SS1 and SS2.
  await acrossViews(
    page,
    info,
    'q8-publication',
    (locale) => at(locale, 'index.original'),
    '[aria-labelledby="parts"] ol li',
    async () => {
      const parts = page.locator('[aria-labelledby="parts"] ol > li');
      expect(await linked(parts.locator('a'))).toEqual(published);
      expect(
        await parts.evaluateAll((items) =>
          items.map((item) => item.querySelector('span')?.textContent?.trim()),
        ),
      ).toEqual(data.answers.seriesParts['index.original'].map((part) => part.label));
    },
  );

  // The reading order is a Collection of the same Works: a volume names it, and it starts with SS1.
  const volume = work('index.original.1');
  await acrossViews(
    page,
    info,
    'q8-reading',
    (locale) => at(locale, 'index.original.1'),
    '#franchises section ol li',
    async () => {
      const order = page
        .locator('#franchises section')
        .filter({ hasText: 'Index Original reading order' });
      const first = order.locator('xpath=.//ol[not(ancestor::ol)]/li');
      expect(await firstLinks(first)).toEqual(reading.slice(0, 12));
      // The same Work carries the same identifier in both orders.
      expect(await firstLinks(first)).toContain(uuid(volume));
    },
  );
  await page.goto(at('en', 'index.original.1'));
  const order = page
    .locator('#franchises section')
    .filter({ hasText: 'Index Original reading order' });
  await order.getByRole('link', { name: 'Show more' }).click();
  await expect(page).toHaveURL(/membersAfter=/);
  const next = page
    .locator('#franchises section')
    .filter({ hasText: 'Index Original reading order' })
    .locator('xpath=.//ol[not(ancestor::ol)]/li');
  expect(await firstLinks(next)).toEqual(reading.slice(12, 24));
});
