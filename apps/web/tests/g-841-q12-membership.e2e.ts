import { expect } from '@playwright/test';
import { acrossViews, firstLinks, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Query 12 (the membership half) of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
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
