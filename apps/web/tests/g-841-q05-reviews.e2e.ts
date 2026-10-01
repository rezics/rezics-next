import { expect, type Page } from '@playwright/test';
import { acrossViews, seeded, test, uuid, type Seeded } from './g-841-fixture.ts';
import type { GrainAnswer, GrainLabel } from './g-914-acceptance.ts';

// Query 5 of the catalogue acceptance fixtures, read through the web UI as the stack's web member. The SAO story
// Work's reviews are read in the SAO Zone's Realm, where its edition, its translation and the Works adapted from it
// each have their own rating question. The page is compared with what Main answered (`acceptance.grains`): the
// reviews of one grain are never the reviews of another, and every aggregate names the scope Main states for it.

let data: Seeded;
test.use({ actionTimeout: 15_000 });
test.beforeAll(() => {
  test.setTimeout(540_000);
  data = seeded();
});

const hub = (locale: string) =>
  `/${locale}/w/${uuid(data.manifest.works['sao.bunko']!.work)}?scope=realm&realm=${uuid(data.acceptance.zones.sao.realm)}`;
const labels: GrainLabel[] = ['story', 'edition', 'translation', 'manga', 'anime'];

/** The target button a grain is chosen with: the story is the Work itself, the others are what Main listed for it. */
const choice = (page: Page, answer: GrainAnswer) => page.locator(`[data-review-target="${uuid(answer.target)}"]`);

async function reads(page: Page, answer: GrainAnswer, locale: string) {
  const aggregate = page.locator(`[data-review-aggregate][data-aggregate-grain="${answer.aggregationScope.grain}"]`);
  await expect(aggregate).toBeVisible();
  // The scope is Main's: its grain, population and counted resource, on the element and in its words.
  await expect(aggregate).toHaveAttribute('data-aggregate-population', answer.aggregationScope.population);
  await expect(aggregate).toHaveAttribute('data-aggregate-counted', uuid(answer.aggregationScope.countedTarget));
  await expect(aggregate).toHaveAttribute('data-aggregate-count', String(answer.count));
  await expect(aggregate).toContainText(answer.aggregationScope.question);
  await expect(aggregate).toContainText(new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(answer.mean));
  // Exactly that grain's reviews, as Main lists them.
  const list = page.locator('section[aria-labelledby="work-reviews"] ol > li');
  await expect(list).toHaveCount(answer.reviews.length);
  for (const review of answer.reviews) await expect(page.locator(`#review-${review.id}`)).toContainText(review.text);
  const others = labels.map(label => data.acceptance.grains[label]).filter(other => other.target !== answer.target);
  for (const other of others) {
    for (const review of other.reviews) await expect(page.locator(`#review-${review.id}`)).toHaveCount(0);
  }
}

test('query 5: edition, story, translation, manga and anime reviews filter separately, and every aggregate states its scope', async ({ page }, info) => {
  test.setTimeout(480_000);
  const { grains } = data.acceptance;
  // Main keeps the grains apart: an edition is counted per release, a translation per realization, the rest per Main Version.
  expect(grains.edition.aggregationScope.grain).toBe('release');
  expect(grains.translation.aggregationScope.grain).toBe('realization');
  for (const label of ['story', 'manga', 'anime'] as const) expect(grains[label].aggregationScope.grain).toBe('main-version');
  expect(new Set(labels.map(label => grains[label].reviews[0]!.id)).size).toBe(5);

  await acrossViews(page, info, 'q5', locale => hub(locale), '[data-review-aggregate]', async locale => {
    // The Work's own reviews are the story's.
    await reads(page, grains.story, locale);
    for (const label of ['edition', 'translation', 'manga', 'anime'] as const) {
      await choice(page, grains[label]).click();
      await reads(page, grains[label], locale);
      // What is chosen stays marked, and the story is one choice away.
      await expect(choice(page, grains[label])).toHaveAttribute('aria-pressed', 'true');
      await expect(choice(page, grains.story)).toHaveAttribute('aria-pressed', 'false');
    }
    await choice(page, grains.story).click();
    await reads(page, grains.story, locale);
  });

  // A Work the story is related to but nobody reviewed has no reviews of its own, and the story's are not shown for it.
  const web = page.locator(`[data-review-target="${uuid(data.manifest.works['sao.web']!.work)}"]`);
  await page.goto(hub('en'));
  await web.click();
  await expect(page.locator('section[aria-labelledby="work-reviews"] ol > li')).toHaveCount(0);
  await expect(page.getByText(grains.story.text)).toHaveCount(0);

  // Everyone's view has no rating question for an edition: the Work's own reviews do not appear to answer for it.
  await page.goto(`/en/w/${uuid(data.manifest.works['sao.bunko']!.work)}`);
  await expect(page.locator('[data-review-target]')).toHaveCount(0);
});
