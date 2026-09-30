import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type Browser, expect, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import type { Catalogue } from './g-838-catalogue.ts';

// Two browser contexts are two devices of one reader: a desktop and a phone, each signed in on its own.
// The records are written once into this isolated QA stack through Main's routes (`g-838-catalogue.ts`).
let catalogue: Catalogue;
// The QA tier gives the whole Playwright run 300 s; these marks show where it goes.
const began = Date.now();
const mark = (step: string) => console.log(`[g-838] ${step} at ${Math.round((Date.now() - began) / 1000)}s`);
test.beforeAll(async () => {
  test.setTimeout(300_000);
  const result = spawnSync('bun', ['apps/web/tests/g-838-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 240_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`G-838 seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  catalogue = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Catalogue;
  mark('seeded');
  // Main keeps processing the seed's events for a while, moving the graph under every read (409).
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${uuid(catalogue.sao.series.work)}`;
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
  mark('settled');
});

const uuid = (iri: string) => iri.slice(-36);
const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };
const at = (work: { work: string }, tab = '') => `/en/w/${uuid(work.work)}${tab}`;

function credentials() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return JSON.parse(readFileSync(path, 'utf8')) as { actingSubject: string; member: { email: string; password: string } };
}

/** A device: its own browser context, signed in as the reader, at the first page it is asked for. */
async function device(browser: Browser, info: TestInfo, viewport: { width: number; height: number }, first: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport, hasTouch: viewport.width < 600,
    isMobile: viewport.width < 600 });
  const page = await context.newPage();
  await signInAtAccounts(page, first, credentials().member);
  return page;
}

/** The status button's menu → Details, whatever shelf the Work is on. */
async function openDetails(page: Page): Promise<Locator> {
  const more = page.getByRole('button', { name: 'More shelves' });
  if (await more.count()) await more.click();
  else await page.getByRole('button', { name: /— Shelve/ }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Reading details' })).toBeVisible();
  await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0);
  return dialog;
}

const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

async function shot(page: Page, info: TestInfo, name: string, target?: Locator) {
  expect(await overflows(page), `${name} overflows`).toBe(false);
  await (target ?? page).screenshot({ path: info.outputPath(`${name}.png`) });
}

test('attempts on two devices, series progress and the offered correspondence', async ({ browser }, info) => {
  test.setTimeout(540_000);
  const { sao, index, spider } = catalogue;
  const volume = sao.volumes[0]!;
  const [a, b] = await Promise.all([device(browser, info, desktop, at(volume)), device(browser, info, phone, at(volume))]);

  mark('signed in');
  // Device A starts an attempt on volume 1 in print, then adds the audiobook.
  let sheetA = await openDetails(a);
  await expect(sheetA.getByText('No attempts recorded yet.')).toBeVisible();
  const start = sheetA.getByRole('region', { name: 'Start an attempt' });
  await start.getByLabel('Edition').selectOption({ label: 'Sword Art Online 1: Aincrad · paperback' });
  await start.getByLabel('Format').selectOption({ label: 'Print' });
  await start.getByRole('button', { name: 'Start reading' }).click();
  const first = sheetA.getByRole('article', { name: 'First read' });
  await expect(first.getByText('Reading', { exact: true })).toBeVisible();
  await expect(first).toContainText('Sword Art Online 1: Aincrad · paperback');
  await expect(first).toContainText('Print');
  await first.getByLabel('Edition', { exact: true }).selectOption({ label: 'Sword Art Online 1: Aincrad (audiobook) · audiobook' });
  await first.getByLabel('Format', { exact: true }).selectOption({ label: 'Audiobook' });
  await first.getByRole('button', { name: 'Add' }).click();
  await expect(first).toContainText('Audiobook');
  // A page belongs to an edition: it is recorded against the paperback, current apart from furthest.
  const position = first.locator('[data-selection="release"]').filter({ hasText: 'paperback' });
  await position.getByLabel('Value').fill('200');
  await position.getByRole('button', { name: 'Save position' }).click();
  await position.getByLabel('Value').fill('50');
  await position.getByRole('button', { name: 'Save position' }).click();
  await expect(position).toContainText('Now page 50');
  await expect(position).toContainText('Furthest page 200');
  await shot(a, info, 'attempt-desktop');

  mark('first attempt');
  // Device B loads the same attempt; A then pauses it, so B's version is stale.
  await b.reload();
  const sheetB = await openDetails(b);
  const firstB = sheetB.getByRole('article', { name: 'First read' });
  await expect(firstB.getByText('Reading', { exact: true })).toBeVisible();
  await shot(b, info, 'attempt-phone');
  await first.getByRole('button', { name: 'Pause' }).click();
  await expect(first.getByText('Paused', { exact: true })).toBeVisible();

  // B finishes on its old version: the conflict shows both sides, and B keeps its own.
  await firstB.getByRole('button', { name: 'Mark finished' }).click();
  const conflict = sheetB.getByRole('alert').filter({ hasText: 'Changed on another device' });
  await expect(conflict).toBeVisible();
  await expect(conflict.locator('[data-conflict-field="state"]')).toContainText('Finished');
  await expect(conflict.locator('[data-conflict-field="state"]')).toContainText('Paused');
  await shot(b, info, 'conflict-phone');
  await conflict.getByRole('button', { name: 'Keep my change' }).click();
  await expect(firstB.getByText('Finished', { exact: true })).toBeVisible();
  await expect(conflict).toHaveCount(0);

  mark('conflict kept');
  // A, still on Paused, resumes: stale again; A takes the other device's version.
  await first.getByRole('button', { name: 'Resume' }).click();
  const conflictA = sheetA.getByRole('alert').filter({ hasText: 'Changed on another device' });
  await expect(conflictA).toBeVisible();
  await shot(a, info, 'conflict-desktop');
  await conflictA.getByRole('button', { name: 'Use the other version' }).click();
  await expect(first.getByText('Finished', { exact: true })).toBeVisible();

  // A starts a reread with the omnibus, which covers all three volumes, and finishes it.
  const reread = sheetA.getByRole('region', { name: 'Start a reread' });
  await reread.getByLabel('Edition').selectOption({ label: 'Sword Art Online: Volumes 1–3 omnibus · ebook' });
  await reread.getByRole('button', { name: 'Start reading' }).click();
  const second = sheetA.getByRole('article', { name: 'Reread 1' });
  await expect(second).toBeVisible();
  await second.getByRole('button', { name: 'Mark finished' }).click();
  await expect(second.getByText('Finished', { exact: true })).toBeVisible();
  await a.keyboard.press('Escape');

  mark('reread');
  // Both the volume and the omnibus that covers it are finished, and each Work counts once.
  await a.goto(at(sao.series, '/connections'));
  const saoPanel = a.getByRole('region', { name: 'Series progress' });
  await expect(saoPanel).toBeVisible();
  await expect(saoPanel.locator('[data-state="finishedPublishedParts"]')).toHaveAttribute('data-value', 'true');
  await expect(saoPanel).toContainText('3 of 3 required parts finished');
  await expect(saoPanel).toContainText('3 parts finished in all');
  await shot(a, info, 'series-sao-desktop', saoPanel);

  mark('sao panel');
  // Index in Traditional Chinese: volumes 1 and 2 are finished (in any language), volume 3 has no such text.
  const { actingSubject } = credentials();
  for (const finished of index.volumes.slice(0, 2)) {
    const response = await a.request.post('/api/main/v1/me/sessions', { headers: { 'idempotency-key': crypto.randomUUID() },
      data: { actingSubject, target: finished.work, expectedVersion: 0, state: 'finished' } });
    expect(response.status(), await response.text()).toBe(201);
  }
  await a.goto(at(index.series, '/connections'));
  const indexPanel = a.getByRole('region', { name: 'Series progress' });
  await expect(indexPanel).toBeVisible();
  await indexPanel.getByLabel('Language').selectOption('zh-Hant');
  await indexPanel.getByRole('button', { name: 'Save choice' }).click();
  await expect(indexPanel.getByText('Saved.')).toBeVisible();
  await expect(indexPanel.locator('[data-state="caughtUpWithAvailableMaterial"]')).toHaveAttribute('data-value', 'true');
  await expect(indexPanel.locator('[data-state="finishedPublishedParts"]')).toHaveAttribute('data-value', 'false');
  await expect(indexPanel.locator('[data-state]')).toHaveCount(4);
  await expect(indexPanel).toContainText('Caught up with available material');
  await expect(indexPanel).toContainText('Finished the published parts');
  await expect(indexPanel).toContainText('The next required part, which has no text in this language yet.');
  await shot(a, info, 'series-index-desktop', indexPanel);
  await b.goto(at(index.series, '/connections'));
  await expect(b.getByRole('region', { name: 'Series progress' })).toBeVisible();
  await shot(b, info, 'series-index-phone');

  mark('index panel');
  // Spider: finishing the web serial leaves the book unstarted until the reader accepts the offer.
  await a.goto(at(spider.book));
  await expect(a.getByRole('button', { name: 'Want to read' })).toBeVisible();
  await a.goto(at(spider.web));
  await a.getByRole('button', { name: 'More shelves' }).click();
  await a.getByRole('menuitemradio', { name: 'Read' }).click();
  await expect(a.getByRole('button', { name: /^Read — Shelve/ })).toBeVisible();
  await a.goto(at(spider.web, '/connections'));
  const spiderPanel = a.getByRole('region', { name: 'Series progress' });
  await expect(spiderPanel).toContainText('Nothing is marked until you choose');
  await a.goto(at(spider.book));
  await expect(a.getByRole('button', { name: 'Want to read' })).toBeVisible();
  await a.goto(at(spider.web, '/connections'));
  await shot(a, info, 'spider-offer-desktop', a.getByRole('region', { name: 'Series progress' }));
  await a.getByRole('button', { name: /^Also mark .* as read$/ }).click();
  await expect(a.getByText(/is marked as read\.$/)).toBeVisible();
  await a.goto(at(spider.book));
  await expect(a.getByRole('button', { name: /^Read — Shelve/ })).toBeVisible();

  // The same panel in Simplified Chinese.
  await a.goto(`/zh-Hans/w/${uuid(index.series.work)}/connections`);
  await expect(a.getByRole('region', { name: '系列进度' })).toBeVisible();
  await expect(a.getByText('已追上现有内容')).toBeVisible();
  await expect(a.getByText('已读完已出版的各部')).toBeVisible();
});
