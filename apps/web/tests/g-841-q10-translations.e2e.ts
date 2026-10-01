import { expect } from '@playwright/test';
import { acrossViews, desktop, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Query 10 of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
// compared with what Main answered for the same fixture (`answers`, recorded by `g-841-catalogue.ts`), so a
// page that disagrees with the API fails.

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
