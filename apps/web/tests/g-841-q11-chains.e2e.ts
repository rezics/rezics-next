import { expect, type Page } from '@playwright/test';
import { acrossViews, linked, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Query 11 of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
// compared with what Main answered for the same fixture (`answers`, recorded by `g-841-catalogue.ts`), so a
// page that disagrees with the API fails.

let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  test.setTimeout(540_000);
  data = seeded();
});

const work = (key: string) => data.manifest.works[key]!.work;
const connections = (locale: string, key: string) => `/${locale}/w/${uuid(work(key))}/connections`;
const rowLinks = (page: Page) => linked(page.locator('[data-relation-row] a'));
/** The Works a Work's relations name in Main's answer: the rows the page must carry, in either direction. */
const counterparts = (key: string, role?: string) => [...new Set(data.answers.relations[key]!
  .filter(item => !role || item.viewingRole === role).flatMap(item => item.counterparts)
  .filter(iri => Object.values(data.manifest.works).some(item => item.work === iri)).map(uuid))];

test('query 11: anime to manga to novel source chains are traversable, with unresolved links visible', async ({ page }, info) => {
  test.setTimeout(420_000);
  const anime = data.answers.relations['index.railgun.anime']!.find(item => item.kind === 'derivation');
  expect(anime).toMatchObject({ unresolved: true });
  expect(anime?.counterparts.map(uuid)).toContain(uuid(work('index.railgun')));

  for (const key of ['index.railgun.anime', 'index.railgun', 'index.original'] as const) {
    await acrossViews(page, info, `q11-${key}`, locale => connections(locale, key), '[data-relation-row]', async () => {
      // Every Work Main names as related is a link on the page.
      expect(await rowLinks(page)).toEqual(expect.arrayContaining(counterparts(key)));
      // A source revision shows as unresolved exactly where Main says it is.
      const unresolved = page.locator('[data-relation-row] [data-slot="badge"]');
      await expect(unresolved).toHaveCount(data.answers.relations[key]!.filter(item => item.unresolved).length);
    });
  }
  // Traverse the chain by clicking: anime → manga → novel.
  await page.goto(connections('en', 'index.railgun.anime'));
  const adapted = page.locator('[data-relation-row]').filter({ hasText: 'Adapted from' });
  await expect(adapted.getByText('Source version unresolved')).toBeVisible();
  await adapted.getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/en/w/${uuid(work('index.railgun'))}$`));
  await page.goto(connections('en', 'index.railgun'));
  await page.locator('[data-relation-row]').filter({ hasText: 'Spin-off of' }).getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/en/w/${uuid(work('index.original'))}$`));
});

