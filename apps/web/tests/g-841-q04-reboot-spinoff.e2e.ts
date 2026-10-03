import type { UiLocale } from '../i18n/define.ts';
import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { expect, type Page } from '@playwright/test';
import { acrossViews, linked, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Query 4 of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
// compared with what Main answered for the same fixture (`answers`, recorded by `g-841-catalogue.ts`), so a
// page that disagrees with the API fails.

let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  test.setTimeout(540_000);
  data = seeded();
});

const work = (key: string) => data.manifest.works[key]!.work;
const connections = (locale: UiLocale, key: string) =>
  localizedPath(`${resourceHref('/w/', uuid(work(key)))}/connections`, locale);
const rowLinks = (page: Page) => linked(page.locator('[data-relation-row] a'));
/** The Works a Work's relations name in Main's answer: the rows the page must carry, in either direction. */
const counterparts = (key: string, role?: string) => [
  ...new Set(
    data.answers.relations[key]!.filter((item) => !role || item.viewingRole === role)
      .flatMap((item) => item.counterparts)
      .filter((iri) => Object.values(data.manifest.works).some((item) => item.work === iri))
      .map(uuid),
  ),
];

test('query 4: Progressive shows Reboot; Alternative GGO shows SpinOff with Sigsawa as author', async ({
  page,
}, info) => {
  test.setTimeout(420_000);
  expect(counterparts('sao.progressive', 'reboot')).toContain(uuid(work('sao.bunko')));
  expect(counterparts('sao.aggo', 'spin-off')).toContain(uuid(work('sao.bunko')));

  await acrossViews(
    page,
    info,
    'q4-progressive',
    (locale) => connections(locale, 'sao.progressive'),
    '[data-relation-row]',
    async () => {
      expect(await rowLinks(page)).toEqual(
        expect.arrayContaining(counterparts('sao.progressive', 'reboot')),
      );
    },
  );
  await page.goto(connections('en', 'sao.progressive'));
  await expect(
    page.locator('[data-relation-row]').filter({ hasText: 'Reboot of' }).getByRole('link').first(),
  ).toHaveAttribute(
    'href',
    new RegExp(localizedPath(`${resourceHref('/w/', uuid(work('sao.bunko')))}$`, 'en')),
  );

  const sigsawa = data.answers.credits['sao.aggo']!.find(
    (credit) => credit.role === 'author' && credit.displayName === 'Keiichi Sigsawa',
  );
  expect(sigsawa).toBeDefined();
  await acrossViews(
    page,
    info,
    'q4-aggo',
    (locale) => connections(locale, 'sao.aggo'),
    '[data-relation-row]',
    async () => {
      expect(await rowLinks(page)).toEqual(
        expect.arrayContaining(counterparts('sao.aggo', 'spin-off')),
      );
      // The author is the one Main credits, named in the Work's header.
      await expect(page.getByRole('link', { name: 'Keiichi Sigsawa' }).first()).toBeVisible();
    },
  );
  await page.goto(connections('en', 'sao.aggo'));
  await expect(
    page
      .locator('[data-relation-row]')
      .filter({ hasText: 'Spin-off of' })
      .getByRole('link')
      .first(),
  ).toHaveAttribute(
    'href',
    new RegExp(localizedPath(`${resourceHref('/w/', uuid(work('sao.bunko')))}$`, 'en')),
  );
  // The bunko Work sees both from its side: what reboots it and what spins off from it.
  await page.goto(connections('en', 'sao.bunko'));
  await expect(
    page.locator('[data-relation-row]').filter({ hasText: 'Reboot' }).first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-relation-row]').filter({ hasText: 'Spin-off' }).first(),
  ).toBeVisible();
  const bunko = await rowLinks(page);
  expect(bunko).toEqual(
    expect.arrayContaining([uuid(work('sao.progressive')), uuid(work('sao.aggo'))]),
  );
});
