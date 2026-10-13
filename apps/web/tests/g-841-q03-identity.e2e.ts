import { uuidToSid } from '@rezics/model/address';
import { cataloguePlan } from '../../../tests/fixtures/catalogue/load.ts';
import type { UiLocale } from '../i18n/define.ts';
import { addressPath, parseAddressSegment, resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { expect, type Page } from '@playwright/test';
import { acrossViews, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Query 3 of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
// compared with what Main answered for the same fixture (`answers`, recorded by `g-841-catalogue.ts`), so a
// page that disagrees with the API fails.

let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  test.setTimeout(540_000);
  data = seeded();
});

const work = (key: string) => data.manifest.works[key]!.work;
const canonicalWork = (key: string) => resourceHref('/w/', {
  prefix: '/w/', key: uuidToSid(uuid(work(key))),
  suffixSource: cataloguePlan().works.find(item => item.id === key)!.title,
});
const rowLinks = async (page: Page) => {
  const hrefs = await page.locator('[data-relation-row] a').evaluateAll(elements =>
    elements.map(element => element.getAttribute('href') ?? ''));
  return hrefs.map(href => {
    const address = addressPath(href);
    const segment = address?.lookup.scope === 'work' ? parseAddressSegment(address.lookup.key) : null;
    return segment && segment.kind !== 'alias' ? segment.id : '';
  });
};
const editions = (locale: UiLocale, key: string) =>
  localizedPath(`${resourceHref('/w/', uuid(work(key)))}/editions`, locale);

test('query 3: the bunko Work leads to the web Work; unavailable text stays distinct from unknown identity', async ({
  page,
}, info) => {
  test.setTimeout(420_000);
  const rewrite = data.answers.relations['sao.bunko']!.find(
    (item) => item.viewingRole === 'rewrite',
  );
  expect(rewrite?.counterparts.map(uuid)).toContain(uuid(work('sao.web')));
  expect(rewrite?.unresolved).toBe(false);

  await acrossViews(
    page,
    info,
    'q3-bunko',
    (locale) =>
      localizedPath(`${resourceHref('/w/', uuid(work('sao.bunko')))}/connections`, locale),
    '[data-relation-row]',
    async (locale) => {
      expect(await rowLinks(page)).toContain(uuid(work('sao.web')));
      // The web Work's identity is known: the link is a link, with no "unresolved" mark.
      const webRow = page.locator('[data-relation-row]').filter({
        has: page.locator(`a[href^="${localizedPath(resourceHref('/w/', uuid(work('sao.web'))), locale)}-"]`),
      });
      await expect(webRow).toHaveCount(1);
      await expect(webRow.locator('[data-slot="badge"]')).toHaveCount(0);
    },
  );
  await page.goto(
    localizedPath(`${resourceHref('/w/', uuid(work('sao.bunko')))}/connections`, 'en'),
  );
  await expect(
    page.locator('[data-relation-row]').filter({ hasText: 'Rewrite of' }).getByRole('link').first(),
  ).toHaveAttribute(
    'href',
    localizedPath(canonicalWork('sao.web'), 'en'),
  );

  // The web serial has no release: its text is unavailable. It still has a name, a page and recorded texts.
  expect(data.answers.webReleases).toBe(0);
  await acrossViews(
    page,
    info,
    'q3-web-editions',
    (locale) => editions(locale, 'sao.web'),
    '#releases',
    async () => {
      await expect(page.locator('#releases a[href*="/releases/"]')).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    },
  );
  await page.goto(editions('en', 'sao.web'));
  await expect(page.getByRole('heading', { name: 'No releases' })).toBeVisible();

  // Unknown identity is its own mark: the anime's source is on record but its revision is not pinned.
  const unresolved = data.answers.relations['index.railgun.anime']!.find(
    (item) => item.kind === 'derivation',
  );
  expect(unresolved?.unresolved).toBe(true);
  await page.goto(
    localizedPath(`${resourceHref('/w/', uuid(work('index.railgun.anime')))}/connections`, 'en'),
  );
  await expect(
    page
      .locator('[data-relation-row]')
      .filter({ hasText: 'Adapted from' })
      .getByText('Source version unresolved'),
  ).toBeVisible();
});
