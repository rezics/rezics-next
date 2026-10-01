import { expect } from '@playwright/test';
import { acrossViews, linked, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Query 2 of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
// compared with what Main answered for the same fixture (`answers`, recorded by `g-841-catalogue.ts`), so a
// page that disagrees with the API fails.

let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  test.setTimeout(540_000);
  data = seeded();
});

const work = (key: string) => data.manifest.works[key]!.work;

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

