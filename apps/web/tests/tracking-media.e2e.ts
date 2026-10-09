import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type Browser, expect as playwrightExpect, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import type { MediaFixture } from './tracking-media-seed.ts';

// A manga chapter, a game and an episode past a thousand, on the real stack. Two browser contexts
// are two devices of one reader. The records are written once through Main's routes
// (`tracking-media-seed.ts`).

const expect = playwrightExpect.configure({ timeout: 20_000 });
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };
let seeded: MediaFixture;

function seed(): Promise<MediaFixture> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['apps/web/tests/tracking-media-seed.ts'], { cwd: process.cwd(), env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      console.log(err);
      if (code !== 0) reject(new Error(`tracking media seed failed: ${err || code}`));
      else resolve(JSON.parse(out.trim().split('\n').at(-1)!) as MediaFixture);
    });
  });
}

async function settle(work: string) {
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${work.slice(-36)}`;
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

test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(600_000);
  seeded = await seed();
  await settle(seeded.manga.work);
});

const home = (work: string) => localizedPath(resourceHref('/w/', work.slice(-36)), 'en');
const at = (work: string) => `${home(work)}/connections`;

function member() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return (JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } }).member;
}

async function device(browser: Browser, info: TestInfo, viewport: { width: number; height: number }, work: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport,
    hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  const page = await context.newPage();
  await signInAtAccounts(page, home(work), member());
  await page.goto(at(work));
  return page;
}

async function loaded(page: Page, marker: string, timeout = 90_000) {
  await expect(async () => {
    if (await page.getByText('Your place in this series could not be loaded.').count()) await page.reload();
    await expect(page.locator(marker)).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout });
}

async function shot(page: Page, info: TestInfo, name: string, target?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), `${name} overflows`).toBe(false);
  await (target ?? page).screenshot({ path: info.outputPath(`${name}.png`) });
}

const chapters = (page: Page) => page.locator('[data-chapter-progress]');
const play = (page: Page) => page.locator('[data-game-progress]');

test('a manga chapter marked on a phone resumes on the desktop, including from an omnibus, and a simultaneous mark keeps both versions', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const handset = await device(browser, info, phone, seeded.manga.work);
  const phoneChapters = chapters(handset);
  await loaded(handset, '[data-chapter-progress]');
  await expect(phoneChapters.getByText('No chapter read yet')).toBeVisible();
  await expect(phoneChapters.getByText('Continue from Volume 1, chapter 1')).toBeVisible();

  await phoneChapters.getByRole('button', { name: 'Volume 2, chapter 3', exact: true }).click();
  await expect(phoneChapters.locator('[data-selected]')).toContainText('Volume 2, chapter 3');
  await phoneChapters.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(phoneChapters.getByText('Last read: Volume 2, chapter 3')).toBeVisible();
  await expect(phoneChapters.getByText('Continue from Volume 2, chapter 4')).toBeVisible();
  await shot(handset, info, 'manga-phone', phoneChapters);

  const wide = await device(browser, info, desktop, seeded.manga.work);
  const desktopChapters = chapters(wide);
  await loaded(wide, '[data-chapter-progress]');
  await expect(desktopChapters.getByText('Last read: Volume 2, chapter 3')).toBeVisible();
  await expect(desktopChapters.getByText('Continue from Volume 2, chapter 4')).toBeVisible();
  const last = await desktopChapters.getAttribute('data-last');
  const next = await desktopChapters.getAttribute('data-continue');
  expect(last).toBeTruthy();
  await shot(wide, info, 'manga-desktop', desktopChapters);

  // The omnibus places the same volume, so it resumes at that chapter's occurrence.
  await wide.goto(at(seeded.manga.omnibus));
  await loaded(wide, '[data-chapter-progress]');
  const omnibusChapters = chapters(wide);
  await expect(omnibusChapters).toHaveAttribute('data-last', last!);
  await expect(omnibusChapters).toHaveAttribute('data-continue', next!);
  await wide.goto(at(seeded.manga.work));
  await loaded(wide, '[data-chapter-progress]');

  // Both devices write chapter 4. The phone's write is held until the desktop's has landed,
  // so the phone still carries the version it read and Main answers that it is stale.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const putStarted = new Promise<void>(resolve => { started = resolve; });
  await handset.route('**/api/main/v1/compositions/*/occurrences/*/progress*', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    started();
    await gate;
    await route.fallback();
  });
  await phoneChapters.getByRole('button', { name: 'Volume 2, chapter 4', exact: true }).click();
  await desktopChapters.getByRole('button', { name: 'Volume 2, chapter 4', exact: true }).click();
  await expect(phoneChapters.locator('[data-selected]')).toContainText('Volume 2, chapter 4');
  const marking = phoneChapters.getByRole('button', { name: 'Mark read', exact: true }).click();
  await putStarted;
  await desktopChapters.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(desktopChapters.getByText('Last read: Volume 2, chapter 4')).toBeVisible();
  release();
  await marking;
  await expect(phoneChapters.getByText('Changed on another device')).toBeVisible();
  await expect(phoneChapters.getByRole('columnheader', { name: 'Your change' })).toBeVisible();
  await shot(handset, info, 'manga-conflict', phoneChapters);
  await phoneChapters.getByRole('button', { name: 'Keep my change' }).click();
  await expect(phoneChapters.getByText('Changed on another device')).toHaveCount(0);
  await expect(phoneChapters.locator('[data-selected] [data-state="done"]')).toBeVisible();
});

test('a game marked completed on one device is completed on the other', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const handset = await device(browser, info, phone, seeded.game.work);
  const phonePlay = play(handset);
  await loaded(handset, '[data-game-progress]');
  await expect(phonePlay.getByText('Not played yet')).toBeVisible();
  await expect(phonePlay.getByRole('button', { name: seeded.game.route })).toBeVisible();
  await phonePlay.getByRole('button', { name: 'Mark completed' }).click();
  await expect(phonePlay.locator('[data-where]')).toHaveText('Completed');
  await expect(phonePlay).toHaveAttribute('data-play-state', 'completed');
  await expect(phonePlay.locator('[data-route-state="none"]')).toBeVisible();
  await shot(handset, info, 'game-phone', phonePlay);

  const wide = await device(browser, info, desktop, seeded.game.work);
  const desktopPlay = play(wide);
  await loaded(wide, '[data-game-progress]');
  await expect(desktopPlay.locator('[data-where]')).toHaveText('Completed');
  await expect(desktopPlay.getByRole('button', { name: seeded.game.route })).toBeVisible();
  await shot(wide, info, 'game-desktop', desktopPlay);
  await desktopPlay.getByRole('button', { name: 'Mark not completed' }).click();
  await expect(desktopPlay.locator('[data-where]')).toHaveText('Not played yet');
});

test('episode 1001 of a real series is watched on another device, and episode 1002 is the next one', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const handset = await device(browser, info, phone, seeded.episodes.work);
  const phoneEpisodes = handset.locator('[data-episode-progress]');
  await loaded(handset, '[data-episode-progress]', 180_000);
  // Nothing is watched yet. Episode 1001 is opened by its number, and marking it is the only progress write.
  await expect(phoneEpisodes.getByText('Continue from episode 1')).toBeVisible();
  await expect(phoneEpisodes.getByText('No episode watched yet')).toBeVisible();
  await phoneEpisodes.getByLabel('Go to episode number').fill('1001');
  await phoneEpisodes.getByRole('button', { name: 'Go' }).click();
  await expect(phoneEpisodes.locator('[data-selected="main"]')).toContainText('Episode 1001', { timeout: 180_000 });
  await expect(phoneEpisodes.locator('[data-selected="main"]')).toContainText('Not watched');
  const saved = handset.waitForResponse(response => response.request().method() === 'PUT'
    && response.url().includes('/progress') && response.ok());
  await phoneEpisodes.getByRole('button', { name: 'Mark watched', exact: true }).click();
  await saved;
  await expect(phoneEpisodes.locator('[data-selected="main"] [data-state="done"]')).toBeVisible();
  await shot(handset, info, 'episode-1001-phone', phoneEpisodes);

  const wide = await device(browser, info, desktop, seeded.episodes.work);
  const desktopEpisodes = wide.locator('[data-episode-progress]');
  await loaded(wide, '[data-episode-progress]', 180_000);
  await expect(desktopEpisodes.getByText('Continue from episode 1002')).toBeVisible();
  await desktopEpisodes.getByLabel('Go to episode number').fill('1001');
  await desktopEpisodes.getByRole('button', { name: 'Go' }).click();
  await expect(desktopEpisodes.locator('[data-selected="main"]')).toContainText('Episode 1001', { timeout: 180_000 });
  await expect(desktopEpisodes.locator('[data-selected="main"] [data-state="done"]')).toBeVisible();
  await desktopEpisodes.getByLabel('Go to episode number').fill('1002');
  await desktopEpisodes.getByRole('button', { name: 'Go' }).click();
  await expect(desktopEpisodes.locator('[data-selected="main"]')).toContainText('Episode 1002', { timeout: 180_000 });
  await expect(desktopEpisodes.locator('[data-selected="main"]')).toContainText('Not watched');
  await shot(wide, info, 'episode-1001-desktop', desktopEpisodes);
});
