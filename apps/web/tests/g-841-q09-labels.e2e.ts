import { expect } from '@playwright/test';
import { acrossViews, linked, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';

// Query 9 of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The page is
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

test('query 9: "22" and "22 Reverse" stay distinct, Genesis Testament restarts at 1, an omnibus covers its books', async ({ page }, info) => {
  test.setTimeout(420_000);
  const labels = (key: 'index.nt' | 'index.gt') => data.answers.seriesParts[key].map(part => part.label);
  const partsOf = async () => ({
    works: await linked(page.locator('[aria-labelledby="parts"] ol > li a')),
    labels: await page.locator('[aria-labelledby="parts"] ol > li').evaluateAll(items =>
      items.map(item => item.querySelector('span')?.textContent?.trim())) });

  await acrossViews(page, info, 'q9-new-testament', locale => at(locale, 'index.nt'), '[aria-labelledby="parts"] ol li', async () => {
    const parts = await partsOf();
    expect(parts.labels).toEqual(labels('index.nt'));
    expect(parts.works).toEqual(data.answers.seriesParts['index.nt'].map(part => uuid(part.work)));
    // The two spellings are two entries on two Works.
    expect(parts.labels.filter(label => label === '22')).toHaveLength(1);
    expect(parts.labels).toContain('22 Reverse');
    expect(new Set(parts.works).size).toBe(parts.works.length);
  });
  await page.goto(at('en', 'index.nt'));
  await expect(page.getByText('Concluded')).toBeVisible();

  await acrossViews(page, info, 'q9-genesis-testament', locale => at(locale, 'index.gt'), '[aria-labelledby="parts"] ol li', async () => {
    const parts = await partsOf();
    expect(parts.labels).toEqual(labels('index.gt'));
    expect(parts.labels[0]).toBe('1');
    // Its first volume is its own Work, not the New Testament's first.
    expect(parts.works).toEqual(data.answers.seriesParts['index.gt'].map(part => uuid(part.work)));
    expect(parts.works).not.toContain(uuid(data.answers.seriesParts['index.nt'][0]!.work));
  });

  // The omnibus covers the Index Original volumes and adds no Work of its own.
  const omnibus = data.manifest.releases['index.original:omnibus']!.release;
  const originals = data.answers.seriesParts['index.original'].map(part => uuid(part.work));
  await acrossViews(page, info, 'q9-omnibus', locale => `/${locale}/releases/${uuid(omnibus)}`, '[data-coverage]', async () => {
    const covered = (await linked(page.locator('[data-coverage] a'))).filter(Boolean);
    const distinct = [...new Set(covered)];
    expect(distinct).toHaveLength(data.answers.omnibusCoverage.length);
    expect(new Set(distinct)).toEqual(new Set(ids(data.answers.omnibusCoverage)));
    expect(new Set(distinct)).toEqual(new Set(originals));
    await expect(page.locator('[data-coverage]')).toHaveCount(data.answers.omnibusCoverage.length);
  });
  await page.goto(`/en/releases/${uuid(omnibus)}`);
  await expect(page.getByRole('region', { name: 'What it covers' }).locator('[data-coverage]')).toHaveCount(data.answers.omnibusCoverage.length);
  // The same release on its Work's Editions page says how many Works it covers.
  await page.goto(`/en/w/${uuid(data.manifest.releases['index.original:omnibus']!.work)}/editions`);
  await expect(page.getByText(`Covers ${data.answers.omnibusCoverage.length} Works`)).toBeVisible();
});

