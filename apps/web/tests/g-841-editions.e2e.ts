import { expect } from '@playwright/test';
import { acrossViews, desktop, linked, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Queries 2, 3 and 10 of the catalogue acceptance fixtures: releases and ISBNs, the text that is unavailable
// against the identity that is unknown, and translations that name their source. Each page is compared
// with what Main answered for the same fixture.
let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  test.setTimeout(540_000);
  data = seeded();
});

const work = (key: string) => data.manifest.works[key]!.work;
const editions = (locale: string, key: string) => `/${locale}/w/${uuid(work(key))}/editions`;
/** The realizations Main recorded for one Work: language → what Main said about it. */
const realizationsOf = (key: string) => Object.entries(data.answers.realizations)
  .filter(([id]) => data.manifest.realizations[id]!.work === work(key)).map(([id, answer]) => ({ id, ...answer }));

test('query 2: an ISBN or a digital entry resolves to a release, its realization, and its Work and Main Version', async ({ page }, info) => {
  test.setTimeout(420_000);
  const { isbn, digital } = data.answers;

  // The ISBN reaches the release and, through its coverage, the Work and Main Version Main named.
  await acrossViews(page, info, 'q2-isbn', locale => `/${locale}/isbn/${data.isbn}`, '[data-coverage]', async locale => {
    await expect(page).toHaveURL(new RegExp(`/${locale}/releases/${uuid(isbn.release)}$`));
    expect(await linked(page.locator('[data-coverage] a'))).toContain(uuid(isbn.work));
    expect(uuid(isbn.work)).toBe(uuid(work('sao.bunko')));
    await expect(page.locator('[data-coverage]')).toHaveCount(1);
  });
  await page.goto(`/en/isbn/${data.isbn}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sword Art Online 1: Aincrad' })).toBeVisible();
  await expect(page.getByText('Main Version').first()).toBeVisible();
  await expect(page.getByText('English').first()).toBeVisible();
  // A wrong check digit or an unknown ISBN names no release.
  expect((await page.goto('/en/isbn/9780316371248'))?.status()).toBe(404);
  expect((await page.goto('/en/isbn/9780306406157'))?.status()).toBe(404);

  // The digital entry's release carries its store identifier, and reaches the same Work through its coverage.
  await acrossViews(page, info, 'q2-digital', locale => `/${locale}/releases/${uuid(digital.release)}`, '[data-coverage]', async () => {
    await expect(page.getByText(digital.value)).toBeVisible();
    expect(await linked(page.locator('[data-coverage] a'))).toContain(uuid(digital.work));
    expect(uuid(digital.mainVersion)).toBe(uuid(data.manifest.works['sao.bunko']!.mainVersion));
  });
});

test('query 3: the bunko Work leads to the web Work; unavailable text stays distinct from unknown identity', async ({ page }, info) => {
  test.setTimeout(420_000);
  const rewrite = data.answers.relations['sao.bunko']!.find(item => item.viewingRole === 'rewrite');
  expect(rewrite?.counterparts.map(uuid)).toContain(uuid(work('sao.web')));
  expect(rewrite?.unresolved).toBe(false);

  await acrossViews(page, info, 'q3-bunko', locale => `/${locale}/w/${uuid(work('sao.bunko'))}/connections`, '[data-relation-row]',
    async () => {
      expect(await linked(page.locator('[data-relation-row] a'))).toContain(uuid(work('sao.web')));
      // The web Work's identity is known: the link is a link, with no "unresolved" mark.
      await expect(page.locator('[data-relation-row]').filter({ has: page.locator(`a[href$="${uuid(work('sao.web'))}"]`) })
        .locator('[data-slot="badge"]')).toHaveCount(0);
    });
  await page.goto(`/en/w/${uuid(work('sao.bunko'))}/connections`);
  await expect(page.locator('[data-relation-row]').filter({ hasText: 'Rewrite of' })
    .getByRole('link').first()).toHaveAttribute('href', new RegExp(`/en/w/${uuid(work('sao.web'))}$`));

  // The web serial has no release: its text is unavailable. It still has a name, a page and recorded texts.
  expect(data.answers.webReleases).toBe(0);
  await acrossViews(page, info, 'q3-web-editions', locale => editions(locale, 'sao.web'), '#releases', async () => {
    await expect(page.locator('#releases a[href*="/releases/"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
  await page.goto(editions('en', 'sao.web'));
  await expect(page.getByRole('heading', { name: 'No releases' })).toBeVisible();

  // Unknown identity is its own mark: the anime's source is on record but its revision is not pinned.
  const unresolved = data.answers.relations['index.railgun.anime']!.find(item => item.kind === 'derivation');
  expect(unresolved?.unresolved).toBe(true);
  await page.goto(`/en/w/${uuid(work('index.railgun.anime'))}/connections`);
  await expect(page.locator('[data-relation-row]').filter({ hasText: 'Adapted from' }).getByText('Source version unresolved')).toBeVisible();
});

test('query 10: translations name their source continuity and language; unverified ones stay unverified', async ({ page }, info) => {
  test.setTimeout(420_000);
  const { realizations } = data.answers;

  // The bunko's Traditional Chinese text follows the bunko's Main Version.
  const hant = realizationsOf('sao.bunko').find(item => item.language === 'zh-Hant')!;
  expect(hant).toMatchObject({ status: 'official', verification: 'verified', source: { kind: 'main-version', work: work('sao.bunko') } });
  await acrossViews(page, info, 'q10-bunko', locale => editions(locale, 'sao.bunko'), '[data-language-group="zh-Hant"]', async () => {
    const languages = await page.locator('[data-language-group]').evaluateAll(groups => groups.map(group => group.getAttribute('data-language-group')));
    expect(languages.sort()).toEqual([...new Set(realizationsOf('sao.bunko').map(item => item.language))].sort());
    // Traditional and Simplified are never one group, and Simplified belongs to volume 1.
    await expect(page.locator('[data-language-group="zh-Hans"]')).toHaveCount(0);
  });
  await page.goto(editions('en', 'sao.bunko'));
  const hantGroup = page.locator('[data-language-group="zh-Hant"]');
  await expect(hantGroup.getByText('Verified')).toBeVisible();
  await expect(hantGroup.getByText('Official')).toBeVisible();
  await expect(hantGroup.getByText(/Main Version:/)).toBeVisible();

  // Volume 1's Simplified Chinese text is another Work's text, with its own continuity.
  const hans = Object.entries(realizations).find(([id]) => id === 'sao.bunko.volume1:zh-Hans')!;
  expect(hans[1]).toMatchObject({ language: 'zh-Hans', source: { kind: 'main-version', work: work('sao.bunko.volume1') } });
  expect(hans[1].source.work).not.toBe(hant.source.work);
  await acrossViews(page, info, 'q10-volume', locale => editions(locale, 'sao.bunko.volume1'), '[data-language-group="zh-Hans"]',
    async () => { await expect(page.locator('[data-language-group="zh-Hant"]')).toHaveCount(0); });

  // The unverified fan translation of the web serial: unofficial, unverified, with no source resolved.
  const fan = realizations.fan!;
  expect(fan).toMatchObject({ status: 'unofficial', verification: 'unverified', source: { kind: 'unresolved', work: work('sao.web') } });
  await acrossViews(page, info, 'q10-fan', locale => editions(locale, 'sao.web'), `[data-language-group="${fan.language}"]`,
    async () => { await expect(page.locator(`[data-language-group="${fan.language}"]`)).toHaveCount(1); });
  await page.goto(editions('en', 'sao.web'));
  const fanGroup = page.locator(`[data-language-group="${fan.language}"]`);
  await expect(fanGroup.getByText('Unverified')).toBeVisible();
  await expect(fanGroup.getByText('Unofficial')).toBeVisible();
  await expect(fanGroup.getByText('Source not resolved yet')).toBeVisible();
  await expect(fanGroup.getByText('Verified', { exact: true })).toHaveCount(0);
  await page.setViewportSize(desktop);
});
