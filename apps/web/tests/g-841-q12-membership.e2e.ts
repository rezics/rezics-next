import type { UiLocale } from '../i18n/define.ts';
import { resourceHref, zoneMemberHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { profileHref } from '../features/profile/route.ts';
import { expect } from '@playwright/test';
import { acrossViews, firstLinks, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Query 12 (the membership half) of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
// compared with what Main answered for the same fixture (`answers`, recorded by `g-841-catalogue.ts`), so a
// page that disagrees with the API fails.

let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(540_000);
  data = seeded();
  // A Zone's site reads projections that trail the Zone: the Realm's header, its Zone, and the route to a mounted Work.
  const main = (path: string) =>
    fetch(`http://127.0.0.1:${process.env.MAIN_PORT}${path}`).catch(() => null);
  const mounted = {
    sao: data.manifest.works['sao.bunko']!.work,
    crossover: data.manifest.works['sao.aggo']!.work,
  };
  for (const [name, { realm, zone }] of Object.entries(data.acceptance.zones)) {
    const paths = [
      `/v1/realms/${uuid(realm)}`,
      `/v1/realms/${uuid(realm)}/zone`,
      `/v1/zones/${uuid(zone)}/routes?path=${encodeURIComponent(`/franchise/${uuid(mounted[name as keyof typeof mounted])}`)}`,
    ];
    for (const path of paths) {
      let last = '';
      for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
        const response = await main(path);
        last = response
          ? `${response.status} ${(await response.text()).slice(0, 200)}`
          : 'no answer';
        if (response?.ok) break;
        await new Promise((done) => setTimeout(done, 1000));
      }
      if (!last.startsWith('200')) throw new Error(`${path} never became readable: ${last}`);
    }
  }
});

const work = (key: string) => data.manifest.works[key]!.work;
const at = (locale: UiLocale, key: string, rest = '/connections') =>
  localizedPath(`${resourceHref('/w/', uuid(work(key)))}${rest}`, locale);
const ids = (iris: string[]) => iris.map(uuid);

test('query 12: franchise membership never merges Works', async ({ page }, info) => {
  test.setTimeout(420_000);
  const franchise = ids(data.answers.franchises['sao.franchise']);
  for (const key of ['sao.web', 'sao.bunko'] as const) {
    await acrossViews(
      page,
      info,
      `q12-${key}`,
      (locale) => at(locale, key),
      '#franchises section ol li',
      async () => {
        // Each Work sees the whole franchise as separate entries and marks only itself.
        const entries = page
          .locator('#franchises section')
          .first()
          .locator('xpath=.//ol[not(ancestor::ol)]/li');
        expect(await firstLinks(entries)).toEqual(franchise);
        expect(
          await entries.evaluateAll(
            (items) => items.filter((item) => item.getAttribute('aria-current') === 'true').length,
          ),
        ).toBe(1);
        expect(await firstLinks(entries.and(page.locator('[aria-current="true"]')))).toEqual([
          uuid(work(key)),
        ]);
      },
    );
  }
});

test("query 12: a contributor's link resolves to one identity from both Zones", async ({
  page,
}, info) => {
  test.setTimeout(420_000);
  const { zones, contributor } = data.acceptance;
  const profile = new RegExp(`${profileHref(contributor.handle)}$`);
  expect(contributor.displayName).toBe('Reki Kawahara');
  // Two Zones, two Realms, neither one the other's: the contributor is named in the pages of both.
  expect(zones.sao.realm).not.toBe(zones.crossover.realm);
  const inZone = (locale: UiLocale, zone: keyof typeof zones, key: string) =>
    localizedPath(zoneMemberHref(uuid(zones[zone].realm), 'franchise', uuid(work(key))), locale);

  // The SAO Zone names him as the story's author; the crossover Zone, whose Works he did not write, as the
  // concept supervisor of Alternative GGO. Each link is the person's profile, never a page of the Zone.
  const links: string[] = [];
  const cases = [
    {
      zone: 'sao',
      key: 'sao.bunko',
      link: (p: typeof page) => p.locator(`a[href$="/@${contributor.handle}"]`).first(),
    },
    {
      zone: 'crossover',
      key: 'sao.aggo',
      link: (p: typeof page) => p.locator(`[data-contributor="${contributor.agent}"]`),
    },
  ] as const;
  for (const { zone, key, link } of cases) {
    await acrossViews(
      page,
      info,
      `q12-${zone}`,
      (locale) => inZone(locale, zone, key),
      `a[href$="/@${contributor.handle}"]`,
      async () => {
        const anchor = link(page);
        await expect(anchor).toBeVisible();
        await expect(anchor).toHaveText(contributor.displayName);
        await expect(anchor).toHaveAttribute('href', profile);
      },
    );
    await page.goto(inZone('en', zone, key));
    const anchor = link(page);
    links.push((await anchor.getAttribute('href'))!);
    await anchor.click();
    await expect(page).toHaveURL(profile);
    await expect(
      page.getByRole('heading', { name: contributor.displayName }).first(),
    ).toBeVisible();
  }
  // Both Zones led to the same address, so to the same identity.
  expect(new Set(links).size).toBe(1);
});
