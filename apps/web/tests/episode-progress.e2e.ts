import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type Browser, expect, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import type { Series, SeriesKey } from './episode-progress-seed.ts';

// A viewer marks episodes watched, sees where they are with the specials apart, and resumes the same
// place on a second device. Two browser contexts are two devices of one reader: a desktop and a
// phone, each signed in on its own. The series are written once into this isolated QA stack through
// Main's routes (`episode-progress-seed.ts`).

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };
let short: Series;
let long: Promise<Series>;

/** Seeds one series in its own process, which writes through Main's routes into this run's stack. */
function seed(key: SeriesKey): Promise<Series> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['apps/web/tests/episode-progress-seed.ts', key], { cwd: process.cwd(), env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      console.log(err);
      if (code !== 0) reject(new Error(`episode progress seed (${key}) failed: ${err || code}`));
      else resolve(JSON.parse(out.trim().split('\n').at(-1)!) as Series);
    });
  });
}

/** Main keeps processing a seed's events for a while, moving the graph under every read (409). */
async function settle(series: Series) {
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${uuid(series.work)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok ? JSON.stringify(((await response.json()) as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for 120 seconds after the seed');
}

// A stuck step should fail in seconds, with its error.
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(300_000);
  // The thousand-episode series takes minutes to compose; it is written while the first journey runs.
  long = seed('long');
  long.catch(() => undefined);
  short = await seed('short');
});

const uuid = (iri: string) => iri.slice(-36);
const home = (series: { work: string }) => localizedPath(resourceHref('/w/', uuid(series.work)), 'en');
const at = (series: { work: string }) => `${home(series)}/connections`;

function member() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return (JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } }).member;
}

/** A device: its own browser context, signed in as the reader, then on the series' progress page. */
async function device(browser: Browser, info: TestInfo, viewport: { width: number; height: number }, series: { work: string }): Promise<Page> {
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport,
    hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  const page = await context.newPage();
  // The sign-in lands on the Work's canonical address, so it is asked for the Work itself.
  await signInAtAccounts(page, home(series), member());
  await page.goto(at(series));
  return page;
}

const episodes = (page: Page) => page.getByRole('region', { name: 'Episodes' });

/** The panel on screen: another seed may still be moving Main's graph, so a page that could not read is read again. */
async function loaded(page: Page) {
  await expect(async () => {
    if (await page.getByText('Your place in this series could not be loaded.').count()) await page.reload();
    await expect(page.locator('[data-episode-progress]')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

async function shot(page: Page, info: TestInfo, name: string, target?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), `${name} overflows`).toBe(false);
  await (target ?? page).screenshot({ path: info.outputPath(`${name}.png`) });
}

/** A press before hydration does nothing: press until the page answers. */
async function press(button: Locator, answer: Locator) {
  await expect(async () => {
    if (await button.count()) await button.click();
    await expect(answer).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

async function jumpTo(panel: Locator, number: number) {
  await panel.getByLabel('Go to episode number').fill(String(number));
  await panel.getByRole('button', { name: 'Go' }).click();
}

test('episodes marked on one device resume on another, with specials kept apart', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const series = short;
  // One after the other: two sign-ins at once sometimes stall on the Account service.
  const a = await device(browser, info, desktop, series);
  const b = await device(browser, info, phone, series);

  // Device A has watched nothing: the first episode is the one to mark.
  const panelA = episodes(a);
  await loaded(a);
  await expect(panelA.getByText('No episode watched yet')).toBeVisible();
  await expect(panelA.getByText('Continue from episode 1')).toBeVisible();

  // Marking the next episode in one tap, seven times over.
  for (let number = 1; number <= 7; number++) {
    await press(panelA.getByRole('button', { name: `Mark episode ${number} watched` }),
      panelA.getByText(`Watched through episode ${number} of 12`));
  }
  await expect(panelA.getByText('Continue from episode 8')).toBeVisible();
  await expect(panelA).toHaveAttribute('data-through', '7');
  await shot(a, info, 'episodes-desktop', panelA);

  // Device B, a phone, loads the page and stands at the same place.
  await b.reload();
  const panelB = episodes(b);
  await loaded(b);
  await expect(panelB.getByText('Watched through episode 7 of 12')).toBeVisible();
  await expect(panelB.getByText('Continue from episode 8')).toBeVisible();
  await expect(panelB).toHaveAttribute('data-continue', '8');
  await shot(b, info, 'episodes-phone', panelB);

  // A special, marked on the phone, does not move the main count.
  await press(panelB.getByRole('button', { name: 'Special 1' }), panelB.locator('[data-selected="special"]'));
  await panelB.getByRole('button', { name: 'Mark watched' }).click();
  await expect(panelB.locator('[data-selected="special"] [data-state="done"]')).toBeVisible();
  await expect(panelB.getByText('Watched through episode 7 of 12')).toBeVisible();
  await expect(panelB.getByText('Continue from episode 8')).toBeVisible();
  await shot(b, info, 'special-phone', panelB);
  await a.reload();
  await loaded(a);
  await expect(episodes(a).getByText('Watched through episode 7 of 12')).toBeVisible();
  await expect(episodes(a).getByText('Continue from episode 8')).toBeVisible();
  await expect(episodes(a).getByRole('button', { name: 'Mark episode 8 watched' })).toBeVisible();

  // Jump to an episode by its number: the next one in the run moves the count; one past it only marks itself.
  await jumpTo(panelB, 8);
  await panelB.getByRole('button', { name: 'Mark watched' }).click();
  await expect(panelB.getByText('Watched through episode 8 of 12')).toBeVisible();
  await jumpTo(panelB, 12);
  await panelB.getByRole('button', { name: 'Mark watched' }).click();
  await expect(panelB.locator('[data-selected="main"] [data-state="done"]')).toBeVisible();
  await expect(panelB.getByText('Watched through episode 8 of 12')).toBeVisible();
  for (const number of [9, 10, 11]) {
    await panelB.getByRole('button', { name: `Mark episode ${number} watched` }).click();
    await expect(panelB.getByText(`Watched through episode ${number >= 11 ? 12 : number} of 12`)).toBeVisible();
  }
  await expect(panelB.getByText('You have watched every episode.')).toBeVisible();
  await jumpTo(panelB, 40);
  await expect(panelB.getByText('There is no episode 40 in this series.')).toBeVisible();
  await a.reload();
  await loaded(a);
  await expect(episodes(a).getByText('You have watched every episode.')).toBeVisible();
});

test('episode 1000 of a thousand is reached by its number and shows watched on another device', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const series = await long;
  await settle(series);
  const a = await device(browser, info, desktop, series);
  const panelA = episodes(a);
  await loaded(a);
  await expect(panelA.getByText('No episode watched yet')).toBeVisible();

  // Episode 1000 is ten pages in; its number takes the reader there.
  await expect(async () => {
    await jumpTo(panelA, 1000);
    await expect(panelA.locator('[data-selected="main"]')).toContainText('Episode 1000', { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await panelA.getByRole('button', { name: 'Mark watched' }).click();
  await expect(panelA.locator('[data-selected="main"] [data-state="done"]')).toBeVisible();
  await jumpTo(panelA, 1001);
  await expect(panelA.getByText('There is no episode 1001 in this series.')).toBeVisible();

  // The phone finds episode 1000 watched, and the run from the first still starts at episode 1.
  const b = await device(browser, info, phone, series);
  const panelB = episodes(b);
  await loaded(b);
  await expect(panelB.getByText('No episode watched yet')).toBeVisible();
  await expect(async () => {
    await jumpTo(panelB, 1000);
    await expect(panelB.locator('[data-selected="main"] [data-state="done"]')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await panelB.getByRole('button', { name: 'Mark episode 1 watched' }).click();
  await expect(panelB.getByText('Watched through episode 1')).toBeVisible();
  await expect(panelB.getByText('Continue from episode 2')).toBeVisible();
  await shot(b, info, 'thousand-phone', panelB);
  await shot(a, info, 'thousand-desktop', panelA);
});
