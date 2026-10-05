import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resourceHref, spaceHref } from '../features/address/path.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// Scoped judgments from the pages people already visit: a character rated in an episode, a player on a map and the ranking,
// a character read in Canon and in Legends, inside a franchise wiki Zone too, and a variant's family. Each step is captured on a desktop and on a phone.

interface Seeded {
  works: Record<string, { work: string }>;
  subjects: Record<string, string>;
  projections: Record<string, string>;
  questions: { character: { context: string }; performance: { context: string }; unit: { context: string } };
  secondEpisode: string;
}
let data: Seeded;
// A step that cannot proceed fails in a minute, not in the test's whole allowance.
test.use({ actionTimeout: 45_000 });
// scoped-subjects-journey.prepare.ts runs before Playwright and leaves seed.json for this run.
test.beforeAll(() => {
  const retained = resolve('.temp/scoped-subjects-journey', process.env.REZICS_QA_RUN_ID!, 'seed.json');
  data = JSON.parse(readFileSync(retained, 'utf8'));
});

const pictures = resolve('.temp/scoped-subjects-journey');
const desktop = { width: 1280, height: 900 };
const phone = { width: 390, height: 844 };
/** Where a person reads: all of the story, since the demo's places are spread through it. */
const at = (resource: string, query = '') =>
  `/en${resourceHref('/e/', resource)}?position=all${query}`;

/** What the browser and the server answered badly, in the run's output, so a failed step says why. */
function watch(page: Page) {
  page.on('pageerror', error => console.log(`[page error] ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') console.log(`[console] ${message.text().slice(0, 300)}`); });
  page.on('response', response => {
    if (response.status() >= 400 && !response.url().includes('/api/media-viewer'))
      console.log(`[${response.status()}] ${response.request().method()} ${response.url()} ${response.url().includes('graph') ? response.request().postData()?.slice(0, 300) : ''}`);
    if (response.status() === 422) void response.text().then(text => console.log(`[422 body] ${text.slice(0, 300)}`), () => undefined);
  });
}


/**
 * The franchise wiki Zone around the demo, written once per stack the first time a step needs it, or null when another journey
 * in the same stack already holds the official route segment (the Zone's package is found by that segment alone).
 */
function franchiseZone(): { zone: string; realm: string; segment: string; character: string } | null {
  const retained = resolve('.temp/scoped-subjects-journey', process.env.REZICS_QA_RUN_ID!, 'zone.json');
  if (existsSync(retained)) return JSON.parse(readFileSync(retained, 'utf8'));
  const made = spawnSync('bun', ['apps/web/tests/scoped-subjects-journey-zone.ts'], { env: process.env, encoding: 'utf8', timeout: 480_000 });
  if (made.status === 3) { console.log(made.stderr); return null; }
  if (made.status !== 0 || made.error) throw new Error(`franchise wiki Zone seed failed: ${made.stderr || made.error?.message || made.status}`);
  return JSON.parse(made.stdout.trim().split('\n').at(-1)!);
}

const web = () => JSON.parse(readFileSync(process.env.REZICS_WEB_AUTH_PUBLIC_PATH!, 'utf8')) as { actingSubject: string };

async function signIn(page: Page) {
  watch(page);
  const credentials = JSON.parse(readFileSync(process.env.REZICS_WEB_AUTH_PRIVATE_PATH!, 'utf8')) as {
    member: { email: string; password: string };
  };
  await signInAtAccounts(page, '/en', credentials.member);
}

/** The step on a desktop and on a phone, which must not scroll sideways, kept for review. */
async function capture(page: Page, name: string) {
  mkdirSync(pictures, { recursive: true });
  // Pictures are of what people read, not of a read still under way.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  await page.evaluate(async () => { await document.fonts.ready; });
  const fullPage = (await page.getByRole('dialog').count()) === 0;
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  for (const [label, size] of [['desktop', desktop], ['phone', phone]] as const) {
    await page.setViewportSize(size);
    // The layout follows the viewport a moment later: measure until it has, and fail with what overflows.
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 ? [] : [...document.querySelectorAll('body *')]
      .filter(element => element.getBoundingClientRect().right > window.innerWidth + 1
        && ![...element.children].some(child => child.getBoundingClientRect().right > window.innerWidth + 1))
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right).slice(0, 8)
      .map(element => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)} ${Math.round(element.getBoundingClientRect().right)} ${element.textContent?.slice(0, 40)}`)), { message: `${name} fits a ${label}`, timeout: 5_000 }).toEqual([]);
    // A sheet is fixed to the viewport, so a page with one open is kept as it is seen.
    await page.screenshot({ path: resolve(pictures, `${name}-${label}.png`), fullPage });
  }
  await page.setViewportSize(desktop);
}

const stars = (page: Page, context: string) => page.locator(`[data-question="${context}"] [data-slot="rating-item"]`);
const question = (page: Page, context: string) => page.locator(`[data-question="${context}"]`);
/** The score and its histogram, which is what must not move when a place is rated. */
const figure = async (page: Page, context: string) =>
  (await question(page, context).locator('[data-rating-mean], [aria-label="Rating distribution"]').allInnerTexts()).join('|');

test('a character rated in an episode keeps her overall score, and the rating survives clearing the browser', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto(at(data.subjects.misaka!));
  const overall = question(page, data.questions.character.context);
  await expect(overall).toContainText('5 ratings', { timeout: 60_000 });
  await expect(overall).toContainText('8.00');
  for (const name of ['Other versions', 'Units', 'Titles'])
    await expect(page.getByRole('region', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Ability', exact: true })).toBeVisible();
  await expect(page.locator('#main-content').getByText(/^(semanticWork|ability)$/)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Relations', exact: true })).toContainText('Appears in');
  await expect(page.getByRole('region', { name: 'Relations', exact: true })).toContainText('Role');
  const before = await figure(page, data.questions.character.context);
  await expect(page.locator('[data-projection]')).toHaveCount(2, { timeout: 60_000 });
  await capture(page, '1-misaka-page');

  // The episode she has been rated in is listed with its own figure, apart from the overall one.
  const episode = page.locator(`[data-projection="${data.projections['misaka-episode']}"]`);
  await expect(episode).toContainText('Season 1, episode 3');
  await expect(episode).toContainText('10 ratings');
  await episode.getByRole('link', { name: 'Rate, review and discuss' }).click();
  // The place's own page leads with its header; the subject's page has none.
  await expect(page.locator('[data-projection-header]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-fact-reach="wider"]')).toContainText('Electromaster');
  // A place is a part to a reader; no model word names it.
  await expect(page.getByRole('link', { name: 'Discuss this part' }).first()).toBeVisible();
  await expect(page.locator('#main-content')).not.toContainText(/projection/i);
  const place = question(page, data.questions.performance.context);
  await expect(place).toContainText('10 ratings', { timeout: 60_000 });
  await capture(page, '2-misaka-in-episode');

  await stars(page, data.questions.performance.context).nth(8).click();
  await expect(place).toContainText('Your rating: 9/10');
  await expect(place).toContainText('11 ratings');
  await capture(page, '3-misaka-rated-in-episode');

  // Her overall score is not the episode's: it reads exactly as before.
  await page.goto(at(data.subjects.misaka!));
  await expect(question(page, data.questions.character.context)).toContainText('5 ratings', { timeout: 60_000 });
  expect(await figure(page, data.questions.character.context)).toBe(before);
  await expect(page.locator(`[data-projection="${data.projections['misaka-episode']}"]`)).toContainText('11 ratings');

  // A new device: nothing is remembered in the browser, and Main still knows the rating and its head.
  await page.goto(at(data.projections['misaka-episode']!));
  await expect(question(page, data.questions.performance.context)).toContainText('Your rating: 9/10', { timeout: 60_000 });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  const again = question(page, data.questions.performance.context);
  await expect(again).toContainText('Your rating: 9/10', { timeout: 60_000 });
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('scoped-rating')))).toEqual([]);
  await stars(page, data.questions.performance.context).nth(5).click();
  await expect(again).toContainText('Your rating: 6/10');
  await expect(again).toContainText('11 ratings');
  await capture(page, '4-misaka-rerated-after-clearing-storage');
});

test('a character can choose only accepting frame dimensions, select an episode and see her episodes combined', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto(at(data.subjects.misaka!));
  await expect(question(page, data.questions.character.context)).toContainText('5 ratings', { timeout: 60_000 });
  const trigger = page.getByRole('button', { name: 'Rate in a specific part' });
  await expect(trigger).toBeEnabled({ timeout: 60_000 });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Work', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('tab', { name: 'Game versions', exact: true })).toHaveCount(0);
  await dialog.getByRole('tab', { name: /A Certain Scientific Railgun/ }).click();
  const search = dialog.getByRole('combobox').first();
  await search.click();
  await search.fill('episode 4');
  await page.getByRole('option', { name: /Season 1, episode 4/ }).click();
  await capture(page, '5-misaka-choose-an-episode');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog.locator('[data-projection-header]')).toContainText('Season 1, episode 4', { timeout: 60_000 });
  await expect(question(page, data.questions.performance.context)).toContainText('No ratings yet', { timeout: 60_000 });
  await expect(dialog).not.toContainText('No question applies here yet');
  await capture(page, '6-misaka-rateable-episode');
  await page.keyboard.press('Escape');

  // Her two episodes of one Work are combined by a named formula, with how many of them could be counted.
  await page.goto(at(data.subjects.misaka!));
  await expect(page.locator(`[data-projection="${data.secondEpisode}"]`)).toContainText('Season 1, episode 4', { timeout: 60_000 });
  const rollup = page.locator('[data-subject-rollup]');
  await expect(rollup).toBeVisible({ timeout: 60_000 });
  await expect(rollup.getByRole('heading', { name: 'All parts together' })).toBeVisible();
  await expect(rollup).toContainText('Pooled');
  await expect(rollup).toContainText(/of 2 parts have enough ratings to count\./);
  await capture(page, '7-misaka-episodes-together');
});

test('a player is rated on a map chosen from their page, and Main ranks the maps by the published weighted rating', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto(at(data.subjects.player!));
  const maps = page.locator('[data-projection]');
  await expect(maps).toHaveCount(2, { timeout: 60_000 });
  await expect(maps.filter({ hasText: 'Haven' })).toContainText('50 ratings');
  // Nine ratings are short of the display threshold: the count shows, the average waits and says how many more reveal it.
  await expect(maps.filter({ hasText: 'Ascent' })).toContainText('9 ratings');
  await expect(maps.filter({ hasText: 'Ascent' })).toContainText('1 more rating will reveal the average.');
  await capture(page, '8-player-page');
  const trigger = page.getByRole('button', { name: 'Rate in a specific part' });
  await expect(trigger).toBeEnabled({ timeout: 60_000 });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  // The broadcast Work also offers a position source; choose its events and maps.
  await dialog.getByRole('tab', { name: 'Match or event' }).click();
  const search = dialog.getByRole('combobox', { name: 'Match or event' });
  await search.click();
  await search.fill('Haven');
  await page.getByRole('option', { name: /Haven/ }).click();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog.locator('[data-projection-header]')).toContainText('Haven', { timeout: 60_000 });
  const stage = dialog.locator(`[data-question="${data.questions.performance.context}"]`);
  await expect(stage).toContainText('50 ratings', { timeout: 60_000 });
  await dialog.locator('[data-slot="rating-item"]').nth(8).click();
  await expect(stage).toContainText('Your rating: 9/10');
  await expect(stage).toContainText('51 ratings');
  await capture(page, '9-player-rated-on-map');

  // The ranking Main publishes: only a place with the ratings a rank needs is ranked, and the figures say why.
  const ranked = await page.request.post('/api/main/v1/rating-rollups', { data: { profile: 'rating-rollup-v1',
    context: data.questions.performance.context, targets: [data.projections['player-map-a'], data.projections['player-map-b']],
    formula: 'pooled', rank: true, actingSubject: web().actingSubject } });
  expect(ranked.status()).toBe(200);
  const body = await ranked.json() as { rank: { minimumRatings: number; items: { target: string; count: number }[] } };
  expect(body.rank.minimumRatings).toBe(50);
  expect(body.rank.items.map(item => [item.target, item.count])).toEqual([[data.projections['player-map-a'], 51]]);

  // A map's own page ranks the people who have a place in it, by the same figures the rollup gave.
  await page.goto(at(data.subjects['map-a']!));
  await expect(page.getByRole('heading', { level: 1, name: /Haven/ })).toBeVisible({ timeout: 60_000 });
  const ranking = page.locator('[data-ranking]');
  await expect(ranking).toBeVisible({ timeout: 60_000 });
  await expect(ranking.locator('[data-rank="1"]')).toContainText('Alex Chen');
  await expect(ranking.locator('[data-rank="1"]')).toContainText('51 ratings');
  await expect(ranking.locator('[data-rank]')).toHaveCount(1);
  await expect(ranking).not.toContainText(/projection/i);
  await capture(page, '10-map-page');
});

test('a reader who is not signed in sees the event without a ranking and without an error', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(at(data.subjects['map-a']!));
  await expect(page.getByRole('heading', { level: 1, name: /Haven/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-ranking]')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#main-content')).not.toContainText(/unavailable|went wrong/i);
});

// These only read, so a page that stalls on a loaded host is tried once more.
test.describe('reading', () => {
  test.describe.configure({ retries: 1 });

  test('Anakin reads in Canon, in Legends and in both', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await page.goto(at(data.subjects.anakin!));
    const main = page.locator('#main-content');
    const facts = main.locator('[data-statement-group]');
    await expect(facts.filter({ hasText: 'Grandfather of Ben Solo' })).toBeVisible({ timeout: 60_000 });
    await expect(facts.filter({ hasText: 'Father of Luke Skywalker' })).toBeVisible();
    // Off by default, each claim says which continuity it holds in.
    await expect(main.locator('[data-holds-in]')).toHaveCount(2);
    await expect(main.locator('[data-continuity-current]')).toContainText('All continuities');
    await expect(page.locator('[data-projection]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Family', exact: true })).toBeVisible();
    await capture(page, '11-anakin-all-continuities');

    const choose = async (name: RegExp | string) => {
      const trigger = main.locator('[data-continuity-switch] [data-hydrated="true"]').first();
      await expect(trigger).toBeEnabled({ timeout: 60_000 });
      await trigger.click();
      await page.getByRole('dialog').getByRole('link', { name }).click();
    };
    await choose('Star Wars Canon');
    await expect(page).toHaveURL(/continuity=/);
    await expect(main.getByText('Grandfather of Ben Solo').first()).toBeVisible({ timeout: 60_000 });
    await expect(main.getByText('Father of Luke Skywalker')).toHaveCount(0);
    await expect(main.locator('[data-continuity-note]').first()).toContainText('Star Wars Canon');
    await capture(page, '12-anakin-canon');

    await choose('Star Wars Legends');
    await expect(main.getByText('Father of Luke Skywalker').first()).toBeVisible({ timeout: 60_000 });
    await expect(main.getByText('Grandfather of Ben Solo')).toHaveCount(0);
    await capture(page, '13-anakin-legends');

    await main.locator('[data-continuity-clear]').click();
    await expect(main.getByText('Grandfather of Ben Solo').first()).toBeVisible({ timeout: 60_000 });
    await expect(main.getByText('Father of Luke Skywalker').first()).toBeVisible();
    await expect(page).not.toHaveURL(/continuity=Star/);
  });

  test('Saber Alter’s page opens his family', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await page.goto(at(data.subjects.alter!));
    const family = page.getByRole('region', { name: 'Other versions', exact: true });
    await expect(family).toBeVisible({ timeout: 60_000 });
    await expect(family.locator('[data-identity-hub]')).toContainText('Artoria Pendragon');
    await expect(family.locator('[data-identity-member]')).toHaveCount(2);
    await capture(page, '14-saber-alter-family');
  });

  test('a place read with a continuity chosen keeps its own facts', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    // Misaka in an episode, opened with Canon chosen: a place is already framed by its coordinates, so the choice neither removes
    // its own facts nor its ratings.
    await page.goto(at(data.projections['misaka-episode']!, `&continuity=${data.subjects.canon!.slice(-36)}`));
    const main = page.locator('#main-content');
    await expect(main.locator('[data-projection-header]')).toBeVisible({ timeout: 60_000 });
    await expect(main.locator('[data-fact-reach="wider"]')).toContainText('Electromaster', { timeout: 60_000 });
    await expect(question(page, data.questions.performance.context)).toContainText('ratings', { timeout: 60_000 });
    await expect(main).not.toContainText(/projection/i);
    await capture(page, '15-misaka-place-with-continuity');
  });

  test('a Character read in the franchise wiki Zone offers the continuity switch, says what is applied and clears it', async ({ page }) => {
    test.setTimeout(600_000);
    const zone = franchiseZone();
    test.skip(!zone, 'another journey already holds the official franchise-wiki route segment in this stack');
    await signIn(page);
    // The Zone's package runs only once Main reports it approved, and the Realm's header trails the Zone.
    const mainUrl = (path: string) => `http://127.0.0.1:${process.env.MAIN_PORT}${path}`;
    await expect.poll(async () => (await fetch(mainUrl(`/v1/zones/${zone!.zone.slice(-36)}/presentation`)).then(
      async response => response.ok ? ((await response.json()) as { execution: { state: string } }).execution.state : '', () => '')),
    { timeout: 120_000 }).toBe('package');
    await expect.poll(async () => (await fetch(mainUrl(`/v1/realms/${zone!.realm.slice(-36)}`)).then(response => response.ok, () => false)),
      { timeout: 120_000 }).toBe(true);
    const character = `/en${spaceHref(zone!.segment, 'site', ['characters', zone!.character.slice(-36)])}?position=all`;
    await page.goto(character);
    // The Zone frames the page, so its switch sits outside the page's own main region.
    const main = page.locator('body');
    await expect(main.getByRole('heading', { level: 1, name: 'Anakin Skywalker' })).toBeVisible({ timeout: 60_000 });
    await expect(main.getByText('Grandfather of Ben Solo').first()).toBeVisible({ timeout: 60_000 });
    await expect(main.getByText('Father of Luke Skywalker').first()).toBeVisible();
    const choose = async (name: string) => {
      const trigger = main.locator('[data-continuity-switch] [data-hydrated="true"]').first();
      await expect(trigger).toBeEnabled({ timeout: 60_000 });
      await trigger.click();
      await page.getByRole('dialog').getByRole('link', { name }).click();
    };
    await choose('Star Wars Canon');
    await expect(page).toHaveURL(/continuity=/, { timeout: 60_000 });
    await expect(main.locator('[data-continuity-note]').first()).toContainText('Star Wars Canon', { timeout: 60_000 });
    await expect(main.getByText('Grandfather of Ben Solo').first()).toBeVisible();
    await expect(main.getByText('Father of Luke Skywalker')).toHaveCount(0);
    await expect(main.locator('[data-continuity-clear]')).toContainText('Show all continuities');
    await expect(main).not.toContainText(/projection/i);
    await capture(page, '16-anakin-in-the-wiki-canon');
    await main.locator('[data-continuity-clear]').click();
    await expect(main.getByText('Father of Luke Skywalker').first()).toBeVisible({ timeout: 60_000 });
    await expect(page).not.toHaveURL(/continuity=Star/);
    await capture(page, '17-anakin-in-the-wiki-all-continuities');
  });
});
