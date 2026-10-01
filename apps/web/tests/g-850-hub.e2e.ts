import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, expect, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { axeViolations, formatViolations } from './a11y-axe.ts';
import type { Hub } from './g-850-seed.ts';

// The Work page as the hub, on the Sword Art Online records the G-838 fixture writes (a series of three
// volumes; volume 1 in English with a paperback, an audiobook and an omnibus) plus one review of the series.
// The browser signs in as the stack's web member. The wiki section is covered by stories here and by the seeded
// wiki in G-856.
let hub: Hub;
// Playwright's actions wait as long as the test does unless bounded; a stuck step should fail in seconds, with its error.
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(300_000);
  // A failed test restarts the worker and this hook with it; the stack is already seeded by then.
  const saved = join('.temp', `g850-seed-${process.env.REZICS_QA_RUN_ID}.json`);
  if (existsSync(saved)) {
    hub = JSON.parse(readFileSync(saved, 'utf8')) as Hub;
  } else {
    const result = spawnSync('bun', ['apps/web/tests/g-850-seed.ts'], { cwd: process.cwd(), env: process.env,
      encoding: 'utf8', timeout: 240_000 });
    if (result.status !== 0 || result.error) {
      throw new Error(`G-850 seed failed: ${result.stderr || result.error?.message || result.status}`);
    }
    const output = result.stdout.trim().split('\n').at(-1)!;
    hub = JSON.parse(output) as Hub;
    mkdirSync('.temp', { recursive: true });
    writeFileSync(saved, output);
  }
  // Main keeps processing the seed's events for a while, moving the graph under every read (409).
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${uuid(hub.sao.series.work)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok ? JSON.stringify((await response.json() as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for 90 seconds after the seed');
});

const uuid = (iri: string) => iri.slice(-36);
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const at = (work: { work: string }, locale = 'en') => `/${locale}/w/${uuid(work.work)}`;

function credentials() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return JSON.parse(readFileSync(path, 'utf8')) as { actingSubject: string; member: { email: string; password: string } };
}

/**
 * The sign-in journey of `account-sign-in.ts`, bounded and retried: on a loaded host the Accounts site is
 * sometimes slow to answer. The Accounts origin is whatever the web app redirects to.
 */
async function signIn(page: Page, next: string, member: { email: string; password: string }): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`/auth/start?next=${encodeURIComponent(next)}`);
      await page.waitForURL(url => url.pathname === '/sign-in', { timeout: 40_000 });
      await page.locator('html[data-hydrated]').waitFor({ timeout: 40_000 });
      await page.getByRole('textbox', { name: 'Email' }).fill(member.email);
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByLabel('Enter your password').fill(member.password);
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page).toHaveURL(next, { timeout: 40_000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

/** A device: its own browser context, signed in as the reader, at the first page it is asked for. */
async function device(browser: Browser, info: TestInfo, viewport: { width: number; height: number }, first: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport, hasTouch: viewport.width < 600,
    isMobile: viewport.width < 600 });
  const page = await context.newPage();
  await signIn(page, first, credentials().member);
  return page;
}

const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

/** Every one of these ends inside the first screen of the viewport, with the page not scrolled. */
async function inFirstScreen(page: Page, what: Record<string, Locator>) {
  expect(await page.evaluate(() => scrollY), 'the page starts at the top').toBe(0);
  const height = page.viewportSize()!.height;
  for (const [name, locator] of Object.entries(what)) {
    await expect(locator, name).toBeVisible();
    const box = (await locator.boundingBox())!;
    expect(box.y, `${name} starts on screen`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${name} ends inside the first screen`).toBeLessThanOrEqual(height);
  }
}

/** The page's one primary action: the link the sticky bar repeats. */
const primary = (page: Page) => page.locator('a[data-next-action]').first();

test('choose a usable release and save it, mark progress and return to the right next part', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { sao } = hub;
  const [one, two] = sao.volumes;
  const page = await device(browser, info, phone, at(sao.series));
  const title = page.getByRole('heading', { level: 1, name: 'Sword Art Online', exact: true });

  // A reader with no edition is asked to choose one, and the part it is for is named. It is in the first screen.
  const choose = primary(page);
  await expect(choose).toHaveText('Choose release');
  await expect(choose).toHaveAttribute('href', `/en/w/${uuid(one!.work)}#availability`);
  await inFirstScreen(page, { title, 'the primary action': choose });
  await expect(page.getByText('Next: 1')).toBeVisible();
  // Tabs would overflow on a phone; "On this page" is in their place.
  await expect(page.getByRole('button', { name: 'On this page' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Work sections' })).toBeHidden();

  // Volume 1 has an audiobook and a paperback in English: choose the audiobook and save it.
  await choose.click();
  await expect(page).toHaveURL(new RegExp(`/en/w/${uuid(one!.work)}#availability$`));
  const availability = page.getByRole('region', { name: 'Your edition and availability' });
  await expect(availability).toBeVisible();
  await availability.getByLabel('Edition', { exact: true }).selectOption({ label: 'Sword Art Online 1: Aincrad (audiobook)' });
  await availability.getByRole('button', { name: 'Save choice' }).click();
  await expect(availability.getByText('Saved.')).toBeVisible();
  // The edition is what the page says it is, after a reload and in the first screen.
  await page.goto(at(one!));
  const edition = page.getByRole('list', { name: 'Your edition' });
  await expect(edition).toContainText('Your edition: Sword Art Online 1: Aincrad (audiobook)');
  await inFirstScreen(page, { title: page.getByRole('heading', { level: 1 }), 'the reader’s edition': edition });
  await expect(page.getByRole('region', { name: 'Editions and releases' })).toContainText('Sword Art Online 1: Aincrad');
  await info.attach('volume-1-phone', { body: await page.screenshot(), contentType: 'image/png' });

  // Volume 1 is finished (its status and progress live in the BFF like the shelf's), so volume 2 is next.
  const { actingSubject } = credentials();
  const written = await page.request.post('/api/main/v1/me/sessions', { headers: { 'idempotency-key': crypto.randomUUID() },
    data: { actingSubject, target: one!.work, expectedVersion: 0, state: 'finished' } });
  expect(written.status(), await written.text()).toBe(201);
  await page.goto(at(sao.series));
  await expect(page.getByRole('list', { name: 'Your edition' })).toContainText('1 of 3 required parts finished');
  // Main names volume 2 and, the reader having no edition for it, still asks for one: the right part either way.
  await expect(primary(page)).toHaveAttribute('href', `/en/w/${uuid(two!.work)}#availability`);
  await expect(page.getByText('Next: 2')).toBeVisible();

  // Choosing the series' language is a choice: the action becomes Continue, and it leads to volume 2.
  const seriesChoice = page.getByRole('region', { name: 'Your edition and availability' });
  await seriesChoice.getByLabel('Language').selectOption('en');
  await seriesChoice.getByRole('button', { name: 'Save choice' }).click();
  await expect(seriesChoice.getByText('Saved.')).toBeVisible();
  await expect(primary(page)).toHaveText('Continue');
  await expect(primary(page)).toHaveAttribute('href', `/en/w/${uuid(two!.work)}`);
  await expect(page.getByText('Next: 2')).toBeVisible();
  await inFirstScreen(page, { title: page.getByRole('heading', { level: 1 }), 'the primary action': primary(page),
    'progress': page.getByRole('list', { name: 'Your edition' }) });
  await info.attach('series-phone', { body: await page.screenshot(), contentType: 'image/png' });
  await primary(page).click();
  await expect(page).toHaveURL(`/en/w/${uuid(two!.work)}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sword Art Online, Vol. 2' })).toBeVisible();
});

test('a review names the Work it is about, and the sections follow the documented order', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const { sao, review } = hub;
  const page = await device(browser, info, desktop, at(sao.series));
  const reviews = page.getByRole('region', { name: 'Reviews', exact: true });
  await expect(reviews).toContainText('Reviews of Sword Art Online');
  await expect(reviews).toContainText(review.text);
  // The ratings name their question, who answered, the scale and the count.
  const basis = page.locator('[data-rating-basis]');
  await expect(basis).toContainText('How good is this Work overall?');
  await expect(basis).toContainText('Rated by: Everyone');
  await expect(basis).toContainText('Scale 1–5');
  await expect(basis).toContainText('1 rating');

  // Sections of a series that has parts and relations but no chapters: in the documented order, with stable anchors.
  const sections = await page.locator('[data-hub-section]').evaluateAll(nodes => nodes.map(node => node.id));
  expect(sections).toEqual(['about', 'availability', 'parts', 'wiki', 'ratings', 'discussion', 'lists']);
  await expect(page.getByRole('region', { name: 'Explore the wiki' })).toContainText('No wiki exists for this Work yet.');
  // On a wide screen the cover and the action make a rail beside the title, and tabs return.
  const rail = (await primary(page).boundingBox())!;
  const heading = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
  expect(rail.x + rail.width, 'the action is in the rail, left of the title').toBeLessThanOrEqual(heading.x + 1);
  await expect(page.getByRole('navigation', { name: 'Work sections' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'On this page' })).toBeHidden();
  // A section's anchor leads to it.
  await page.goto(`${at(sao.series)}#ratings`);
  await expect(page.locator('#ratings')).toBeInViewport();
});

const locales = [
  { locale: 'en', onThisPage: 'On this page', title: 'Sword Art Online' },
  { locale: 'zh-Hant', onThisPage: '本頁內容', title: 'Sword Art Online' },
  { locale: 'ja', onThisPage: 'このページの内容', title: 'Sword Art Online' },
];

test('the first screen and accessibility hold in light and dark, on a phone and a desktop, in en, zh-Hant and ja', async ({ browser }, info) => {
  test.setTimeout(280_000);
  const { sao } = hub;
  const page = await device(browser, info, phone, at(sao.series));
  const context = page.context();
  for (const { locale, onThisPage, title } of locales) {
    for (const theme of ['light', 'dark'] as const) {
      await context.addCookies([{ name: 'rezics_theme', value: theme, url: page.url() }]);
      for (const viewport of [phone, desktop]) {
        const name = `${locale}-${theme}-${viewport.width}`;
        await page.setViewportSize(viewport);
        await page.goto(at(sao.series, locale));
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        const heading = page.getByRole('heading', { level: 1, name: title, exact: true });
        await expect(heading, name).toBeVisible();
        const action = primary(page);
        await expect(action, name).toBeVisible();
        if (viewport.width === phone.width) {
          await inFirstScreen(page, { title: heading, 'the primary action': action,
            'the reader’s progress': page.locator('[data-identity-status]') });
          await expect(page.getByRole('button', { name: onThisPage }), name).toBeVisible();
        } else {
          await expect(page.getByRole('button', { name: onThisPage }), name).toBeHidden();
        }
        expect(await overflows(page), `${name} overflows`).toBe(false);
        const violations = await axeViolations(page);
        expect(violations, `${name}\n${formatViolations(violations)}`).toEqual([]);
        await page.screenshot({ path: info.outputPath(`series-${name}.png`) });
      }
    }
  }
});
