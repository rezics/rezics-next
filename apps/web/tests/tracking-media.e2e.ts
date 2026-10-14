import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Browser, expect as playwrightExpect, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import type { MediaFixture } from './tracking-media-seed.ts';
import { copyOf } from '../features/tracking/messages.ts';
import { expectClean, type Findings, keyboardReach, pressByKeyboard } from './g-743-matrix.ts';

// A manga chapter, a game and an identified anime episode past a thousand, on the real stack. Two browser contexts
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
  try {
    await expect(async () => {
      if (await page.getByText('Your place in this series could not be loaded.').count()) await page.reload();
      await expect(page.locator(`${marker}:not([data-pending])`)).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout });
  } catch (error) {
    const main = await page.locator('main').innerText().catch(() => '');
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load ${marker} at ${page.url()}; main content: ${main.replace(/\s+/g, ' ').slice(0, 1_200)}; ${detail}`);
  }
}

async function shot(page: Page, info: TestInfo, name: string, target?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), `${name} overflows`).toBe(false);
  await (target ?? page).screenshot({ path: info.outputPath(`${name}.png`) });
}

const chapters = (page: Page) => page.locator('[data-chapter-progress]');
const play = (page: Page) => page.locator('[data-game-progress]');

test('thousand-episodes: an Anime reader reaches the inventory end by keyboard and returns after reload in English and Japanese', async ({ browser }, info) => {
  test.setTimeout(600_000);
  const found: Findings = [];
  const page = await device(browser, info, phone, seeded.episodes.work);
  try {
    for (const locale of ['en', 'ja'] as const) {
      const t = copyOf(locale);
      await page.goto(localizedPath(resourceHref('/w/', seeded.episodes.work.slice(-36)), locale));
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('link', { name: 'Anime', exact: true })).toBeVisible();
      await page.goto(localizedPath(`${resourceHref('/w/', seeded.episodes.work.slice(-36))}/connections`, locale));
      await loaded(page, '[data-episode-progress]', 180_000);
      const panel = page.locator('[data-episode-progress]');
      const jump = async (number: number) => {
        const input = panel.getByLabel(t.jumpTo, { exact: true });
        await keyboardReach(page, input, found, `Episode number (${locale})`);
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.type(String(number));
        await pressByKeyboard(page, panel.getByRole('button', { name: t.jumpGo, exact: true }), found, `Go (${locale})`);
      };
      // Cross the first inventory page, then its fiftieth, and distinguish the last two occurrences.
      for (const number of [1, 21, 1000, 1001, 1002]) {
        await jump(number);
        await expect(panel.locator('[data-selected="main"]')).toContainText(`Episode ${number}`, { timeout: 180_000 });
        await expect(panel.locator('[data-selected="main"] span[data-state]')).toBeVisible();
      }
      await jump(1003);
      await expect(panel.getByText(t.noSuchEpisode({ number: '1003' }), { exact: true })).toBeVisible({ timeout: 180_000 });
      await expect(panel.locator('[data-selected="main"]')).toHaveCount(0);
      await jump(1002);
      const mark = panel.getByRole('button', { name: t.markWatched, exact: true });
      if (await mark.isVisible()) await pressByKeyboard(page, mark, found, `Mark watched (${locale})`);
      await expect(panel.locator('[data-selected="main"] [data-state="done"]')).toBeVisible();
      await page.reload();
      await loaded(page, '[data-episode-progress]', 180_000);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(panel.locator('[data-where]')).toHaveText(t.lastWatched({ place: 'Episode 1002' }));
      await jump(1002);
      await expect(panel.locator('[data-selected="main"]')).toContainText('Episode 1002', { timeout: 180_000 });
      await expect(panel.locator('[data-selected="main"] [data-state="done"]')).toBeVisible();
      await shot(page, info, `thousand-episodes-${locale}-reloaded`, panel);
      await page.setViewportSize(desktop);
    }
    expectClean(found);
  } finally {
    await page.context().close();
  }
});

test('identified manga chapter progress resumes across volumes and devices', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const handset = await device(browser, info, phone, seeded.manga.work);
  await handset.goto(home(seeded.manga.work));
  await expect(handset.getByRole('link', { name: 'Manga', exact: true })).toBeVisible();
  await handset.goto(at(seeded.manga.work));
  const phoneChapters = chapters(handset);
  await loaded(handset, '[data-chapter-progress]');
  await expect(phoneChapters.getByText('Unknown', { exact: true })).toBeVisible();
  await expect(phoneChapters.locator('[data-next], [data-caught-up]')).toHaveCount(0);

  await phoneChapters.getByRole('button', { name: 'Volume 1, chapter 4', exact: true }).click();
  await expect(phoneChapters.locator('[data-selected]')).toContainText('Volume 1, chapter 4');
  await phoneChapters.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(phoneChapters.getByText('Last read: Volume 1, chapter 4')).toBeVisible();
  await expect(phoneChapters.locator('[data-next], [data-caught-up]')).toHaveCount(0);

  await phoneChapters.getByRole('button', { name: 'Volume 2, chapter 3', exact: true }).click();
  await expect(phoneChapters.locator('[data-selected]')).toContainText('Volume 2, chapter 3');
  await phoneChapters.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(phoneChapters.getByText('Last read: Volume 2, chapter 3')).toBeVisible();
  await expect(phoneChapters.locator('[data-next], [data-caught-up]')).toHaveCount(0);
  await shot(handset, info, 'manga-phone', phoneChapters);

  const wide = await device(browser, info, desktop, seeded.manga.work);
  const desktopChapters = chapters(wide);
  await loaded(wide, '[data-chapter-progress]');
  await expect(desktopChapters.getByText('Last read: Volume 2, chapter 3')).toBeVisible();
  await expect(desktopChapters.locator('[data-next], [data-caught-up]')).toHaveCount(0);
  const last = await desktopChapters.getAttribute('data-last');
  await expect(desktopChapters.locator('[data-caught-up]')).toHaveCount(0);
  expect(last).toBeTruthy();
  await shot(wide, info, 'manga-desktop', desktopChapters);

  // The omnibus places the same volume, so it resumes at that chapter's occurrence.
  await wide.goto(at(seeded.manga.omnibus));
  await loaded(wide, '[data-chapter-progress]');
  const omnibusChapters = chapters(wide);
  await expect(omnibusChapters).toHaveAttribute('data-last', last!);
  await expect(omnibusChapters.locator('[data-next], [data-caught-up]')).toHaveCount(0);
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

  // A later conflict carries the other device's unmark. Adopting it changes the selected state too.
  let releaseUnmark!: () => void;
  const unmarkGate = new Promise<void>(resolve => { releaseUnmark = resolve; });
  let unmarkStarted!: () => void;
  const unmarkSent = new Promise<void>(resolve => { unmarkStarted = resolve; });
  await handset.route('**/api/main/v1/compositions/*/occurrences/*/progress*', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    unmarkStarted();
    await unmarkGate;
    await route.fallback();
  });
  await phoneChapters.getByRole('button', { name: 'Volume 2, chapter 4', exact: true }).click();
  await desktopChapters.getByRole('button', { name: 'Volume 2, chapter 4', exact: true }).click();
  const unmarking = phoneChapters.getByRole('button', { name: 'Mark not read', exact: true }).click();
  await unmarkSent;
  await desktopChapters.getByRole('button', { name: 'Mark not read', exact: true }).click();
  await expect(desktopChapters.locator('[data-selected] [data-state="open"]')).toBeVisible();
  releaseUnmark();
  await unmarking;
  await expect(phoneChapters.getByText('Changed on another device')).toBeVisible();
  await phoneChapters.getByRole('button', { name: 'Use the other version', exact: true }).click();
  await expect(phoneChapters.locator('[data-selected] [data-state="open"]')).toBeVisible();
  await expect(phoneChapters.getByRole('button', { name: 'Mark read', exact: true })).toBeVisible();
  await expect(phoneChapters.locator('[data-conflict]')).toHaveCount(0);
  await handset.reload();
  await loaded(handset, '[data-chapter-progress]');
  await phoneChapters.getByRole('button', { name: 'Volume 2, chapter 4', exact: true }).click();
  await expect(phoneChapters.locator('[data-selected] [data-state="open"]')).toBeVisible();
  await shot(handset, info, 'manga-other-unmark', phoneChapters);
});

test('game progress resumes across required and extra routes and a partless game on another device', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const handset = await device(browser, info, phone, seeded.game.work);
  const phonePlay = play(handset);
  await loaded(handset, '[data-game-progress]');
  await expect(phonePlay.getByText('Not played yet')).toBeVisible();
  const phoneRequired = phonePlay.locator('[data-required-parts] [data-route]').filter({ hasText: seeded.game.requiredRoute });
  const phoneExtra = phonePlay.locator('[data-routes] [data-route]').filter({ hasText: seeded.game.extraRoute });
  await expect(phoneRequired).toHaveAttribute('data-route-state', 'none');
  await expect(phoneExtra).toHaveAttribute('data-route-state', 'none');
  const playedResponsePromise = handset.waitForResponse(response => response.request().method() === 'PUT'
    && response.url().includes('/progress') && response.ok());
  await phonePlay.getByRole('button', { name: 'Mark played', exact: true }).click();
  const playedResponse = await playedResponsePromise;
  const played = await playedResponse.json() as { version: number; completed: boolean; position: string | null };
  expect(played).toMatchObject({ version: 1, completed: false, position: 'played' });
  const playedRequest = playedResponse.request().postDataJSON() as { actingSubject: string; expectedVersion: number };
  await expect(phonePlay).toHaveAttribute('data-play-state', 'played');
  await expect(phoneRequired).toHaveAttribute('data-route-state', 'played');
  await expect(phoneExtra).toHaveAttribute('data-route-state', 'none');
  await shot(handset, info, 'game-played-phone', phonePlay);

  const wide = await device(browser, info, desktop, seeded.game.work);
  const desktopPlay = play(wide);
  await loaded(wide, '[data-game-progress]');
  const desktopRequired = desktopPlay.locator('[data-required-parts] [data-route]').filter({ hasText: seeded.game.requiredRoute });
  const desktopExtra = desktopPlay.locator('[data-routes] [data-route]').filter({ hasText: seeded.game.extraRoute });
  await expect(desktopPlay.locator('[data-where]')).toHaveText('Played');
  await expect(desktopRequired).toHaveAttribute('data-route-state', 'played');
  await expect(desktopExtra).toHaveAttribute('data-route-state', 'none');
  const completedResponsePromise = wide.waitForResponse(response => response.request().method() === 'PUT'
    && response.url().includes('/progress') && response.ok());
  await desktopPlay.getByRole('button', { name: 'Mark completed', exact: true }).click();
  await completedResponsePromise;
  await expect(desktopPlay.locator('[data-where]')).toHaveText('Completed');
  await expect(desktopPlay).toHaveAttribute('data-play-state', 'completed');
  await expect(desktopRequired).toHaveAttribute('data-route-state', 'completed');
  await expect(desktopExtra).toHaveAttribute('data-route-state', 'none');
  await shot(wide, info, 'game-desktop', desktopPlay);
  const stale = await handset.request.put(playedResponse.url(), {
    headers: { 'idempotency-key': `game-stale-${randomUUID()}` },
    data: { ...playedRequest, expectedVersion: played.version, completed: true, position: 'completed' },
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'stale_progress' });
  await desktopPlay.getByRole('button', { name: 'Mark not completed' }).click();
  await expect(desktopPlay.locator('[data-where]')).toHaveText('Not played yet');
  await expect(desktopRequired).toHaveAttribute('data-route-state', 'none');
  await expect(desktopExtra).toHaveAttribute('data-route-state', 'none');

  const partlessPhone = await device(browser, info, phone, seeded.partlessGame.work);
  await expect(partlessPhone.getByRole('heading', { name: seeded.partlessGame.title, exact: true }),
    `partless phone should open ${home(seeded.partlessGame.work)}`).toBeVisible();
  const phoneWork = partlessPhone.locator('[data-work-progress][data-verb="play"]');
  await loaded(partlessPhone, '[data-work-progress][data-verb="play"]');
  await expect(phoneWork.locator('[data-where]')).toHaveText('Not started');
  const startedResponsePromise = partlessPhone.waitForResponse(response => response.request().method() === 'PUT'
    && response.url().includes('/progress') && response.ok());
  await phoneWork.getByRole('button', { name: 'Mark playing', exact: true }).click();
  const startedResponse = await startedResponsePromise;
  const started = await startedResponse.json() as { version: number; standing: string };
  expect(started).toMatchObject({ version: 1, standing: 'started' });
  const startedRequest = startedResponse.request().postDataJSON() as { actingSubject: string; expectedVersion: number };
  await expect(phoneWork.locator('[data-where]')).toHaveText('Playing');

  const partlessDesktop = await device(browser, info, desktop, seeded.partlessGame.work);
  await expect(partlessDesktop.getByRole('heading', { name: seeded.partlessGame.title, exact: true }),
    `partless desktop should open ${home(seeded.partlessGame.work)}`).toBeVisible();
  const desktopWork = partlessDesktop.locator('[data-work-progress][data-verb="play"]');
  await loaded(partlessDesktop, '[data-work-progress][data-verb="play"]');
  await expect(desktopWork.locator('[data-where]')).toHaveText('Playing');
  await desktopWork.getByRole('button', { name: 'Mark completed', exact: true }).click();
  await expect(desktopWork.locator('[data-where]')).toHaveText('Completed');
  const stalePartless = await partlessPhone.request.put(startedResponse.url(), {
    headers: { 'idempotency-key': `partless-game-stale-${randomUUID()}` },
    data: { ...startedRequest, expectedVersion: started.version, standing: 'started' },
  });
  expect(stalePartless.status()).toBe(409);
  expect(await stalePartless.json()).toMatchObject({ code: 'stale_progress' });
  await desktopWork.getByRole('button', { name: 'Mark not started', exact: true }).click();
  await expect(desktopWork.locator('[data-where]')).toHaveText('Not started');
  await partlessPhone.reload();
  await loaded(partlessPhone, '[data-work-progress][data-verb="play"]');
  await expect(phoneWork.locator('[data-where]')).toHaveText('Not started');
});

test('identified anime watched progress resumes across devices and rejects stale updates', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const handset = await device(browser, info, phone, seeded.episodes.work);
  const phoneEpisodes = handset.locator('[data-episode-progress]');
  await loaded(handset, '[data-episode-progress]', 180_000);
  await handset.goto(home(seeded.episodes.work));
  await expect(handset.getByRole('link', { name: 'Anime', exact: true })).toBeVisible();
  await handset.goto(at(seeded.episodes.work));
  await loaded(handset, '[data-episode-progress]', 180_000);
  // An accepted Anime classification identifies this series before its progress is changed.
  await expect(phoneEpisodes.locator('[data-next], [data-caught-up]')).toHaveCount(0);
  await expect(phoneEpisodes.getByText('Unknown', { exact: true })).toBeVisible();
  await phoneEpisodes.getByLabel('Go to episode number').fill('1001');
  await phoneEpisodes.getByRole('button', { name: 'Go' }).click();
  await expect(phoneEpisodes.locator('[data-selected="main"]')).toContainText('Episode 1001', { timeout: 180_000 });
  await expect(phoneEpisodes.locator('[data-selected="main"]')).toContainText('Not watched');
  const saved = handset.waitForResponse(response => response.request().method() === 'PUT'
    && response.url().includes('/progress') && response.ok());
  await phoneEpisodes.getByRole('button', { name: 'Mark watched', exact: true }).click();
  const watchedResponse = await saved;
  const watched = await watchedResponse.json() as { version: number; completed: boolean };
  expect(watched.completed).toBe(true);
  const watchedRequest = watchedResponse.request().postDataJSON() as { actingSubject: string; position: string | null };
  await expect(phoneEpisodes.locator('[data-selected="main"] [data-state="done"]')).toBeVisible();
  await shot(handset, info, 'episode-1001-phone', phoneEpisodes);

  const wide = await device(browser, info, desktop, seeded.episodes.work);
  const desktopEpisodes = wide.locator('[data-episode-progress]');
  await loaded(wide, '[data-episode-progress]', 180_000);
  await expect(desktopEpisodes.locator('[data-where]')).toHaveText('Last watched: Episode 1001');
  await expect(desktopEpisodes.locator('[data-next], [data-caught-up]')).toHaveCount(0);
  await desktopEpisodes.getByLabel('Go to episode number').fill('1001');
  await desktopEpisodes.getByRole('button', { name: 'Go' }).click();
  await expect(desktopEpisodes.locator('[data-selected="main"]')).toContainText('Episode 1001', { timeout: 180_000 });
  await expect(desktopEpisodes.locator('[data-selected="main"] [data-state="done"]')).toBeVisible();
  const undone = wide.waitForResponse(response => response.request().method() === 'PUT'
    && response.url() === watchedResponse.url() && response.ok());
  await desktopEpisodes.getByRole('button', { name: 'Mark not watched', exact: true }).click();
  const undoResponse = await undone;
  const current = await undoResponse.json() as { version: number; completed: boolean };
  expect(current).toMatchObject({ version: watched.version + 1, completed: false });
  await expect(desktopEpisodes.locator('[data-selected="main"]')).toContainText('Not watched');

  // The first browser context still holds the watched version. Its delayed write must
  // not undo the newer decision made on the second device.
  const refused = await handset.request.put(watchedResponse.url(), {
    headers: { 'idempotency-key': `anime-stale-${randomUUID()}` },
    data: { ...watchedRequest, expectedVersion: watched.version, completed: true },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'stale_progress' });
  await handset.reload();
  await loaded(handset, '[data-episode-progress]', 180_000);
  await expect(phoneEpisodes.getByText('Unknown', { exact: true })).toBeVisible();
  await expect(phoneEpisodes.locator('[data-next], [data-caught-up]')).toHaveCount(0);
  await phoneEpisodes.getByLabel('Go to episode number').fill('1001');
  await phoneEpisodes.getByRole('button', { name: 'Go' }).click();
  await expect(phoneEpisodes.locator('[data-selected="main"]')).toContainText('Not watched', { timeout: 180_000 });
  await shot(handset, info, 'anime-stale-refused', phoneEpisodes);
  await desktopEpisodes.getByLabel('Go to episode number').fill('1002');
  await desktopEpisodes.getByRole('button', { name: 'Go' }).click();
  await expect(desktopEpisodes.locator('[data-selected="main"]')).toContainText('Episode 1002', { timeout: 180_000 });
  await expect(desktopEpisodes.locator('[data-selected="main"]')).toContainText('Not watched');
  await shot(wide, info, 'episode-1001-desktop', desktopEpisodes);
});
