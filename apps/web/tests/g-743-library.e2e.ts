import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { messages } from '../features/library/messages.ts';
import ja from '../features/library/messages/ja.ts';
import { checkScreen, expectClean, type Findings, keyboardReach, locales, motionRunning, pressByKeyboard } from './g-743-matrix.ts';
import { device, hubRecords, libraryRecords, uuid } from './g-743-stack.ts';
import type { Hub } from './g-850-seed.ts';

// Launch journey `library-import-progress-export`: a Goodreads file imported from the Library page, progress
// recorded on one device and read on another, and the library downloaded (G-855's import and export, G-838's
// two-device progress; their records and steps are in `g-855-library-*.e2e.ts` and `g-838-tracking.e2e.ts`). The
// matrix of `g-743-matrix.ts` on each screen, every control reached and operated by keyboard under reduced motion
// (the file chooser excepted: a keyboard opens the native dialog, which no test drives), and the Library page in
// Japanese.
let hub: Hub;
let books: { matched: string[]; ambiguous: string };
test.use({ actionTimeout: 20_000 });
test.beforeAll(async () => {
  test.setTimeout(540_000);
  hub = await hubRecords();
  books = await libraryRecords();
});

const words = (locale: 'en' | 'ja') => materializeData(locale === 'ja' ? { ...messages, ...ja } : messages, { locale });
const header = 'Book Id,Title,Author,ISBN13,ISBN,My Rating,Exclusive Shelf,Bookshelves,Date Started,Date Read,My Review,Read Count,Private Notes';
/** Three rows each naming one seeded Work, one naming the two that share a title, and three nothing matches. */
function goodreads(): Buffer {
  const rows = [...books.matched.map((title, index) => `${index + 1},${title},,,,0,${index ? 'to-read' : 'read'},,,,,0,`),
    `4,${books.ambiguous},,,,0,to-read,,,,,0,`,
    ...Array.from({ length: 3 }, (_, index) => `${5 + index},Nothing Here ${index + 1},Nobody Real,,,0,to-read,,,,,0,`)];
  return Buffer.from([header, ...rows].join('\n'));
}

/** The summary of a section of the Library page. */
const summaryOf = (page: Page, title: string) => page.locator('summary').filter({ has: page.getByRole('heading', { name: title }) }).first();
/** Open a section once the page has hydrated; a press before hydration opens nothing. */
async function openSection(page: Page, title: string, found?: Findings) {
  const summary = summaryOf(page, title);
  const details = summary.locator('xpath=ancestor::details[1]');
  await expect(async () => {
    if (await details.getAttribute('open') !== null) return;
    if (found) { await keyboardReach(page, summary, found, `${title} section`); await page.keyboard.press('Enter'); }
    else await summary.click();
    await expect(details).toHaveAttribute('open', '', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** The status button's menu → Details, whatever shelf the Work is on. */
async function openDetails(page: Page): Promise<Locator> {
  const details = page.getByRole('menuitem', { name: 'Details' });
  await expect(async () => {
    const more = page.getByRole('button', { name: 'More shelves' });
    await (await more.count() ? more : page.getByRole('button', { name: /— Shelve/ })).click();
    await expect(details).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await details.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Reading details' })).toBeVisible();
  await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(0);
  return dialog;
}

test('library-import-progress-export: import, progress on two devices and the download, by keyboard, in the Latin locale', async ({ browser }, info) => {
  test.setTimeout(540_000);
  const t = words('en');
  const found: Findings = [];
  const { sao } = hub;
  const volume = sao.volumes[0]!;
  const a = await device(browser, info, `/${locales.latin}/library`, { reducedMotion: true });
  if (await a.getByRole('heading', { name: t.deniedTitle }).isVisible()) test.skip(true, 'The Library is closed on this stack');

  // Import: the file is chosen, the ambiguous row is decided, one row is kept private, and the rest is applied.
  await openSection(a, t.importTitle, found);
  await checkScreen(a, 'library-import-idle', found, info);
  await a.locator('#library-import-file').setInputFiles({ name: 'goodreads_library_export.csv', mimeType: 'text/csv', buffer: goodreads() });
  const tab = (label: string, count: number) => a.getByRole('button', { name: `${label} ${count}`, exact: true });
  await expect(tab(t.importGroupAmbiguous, 1)).toBeVisible({ timeout: 180_000 });
  await expect(tab(t.importGroupNotFound, 3)).toBeVisible();
  await expect(a.getByRole('button', { name: t.importApply })).toBeDisabled();
  await checkScreen(a, 'library-import-review', found, info);
  const ambiguous = a.locator('[data-group="ambiguous"]').first();
  await pressByKeyboard(a, ambiguous.getByRole('button', { name: new RegExp(books.ambiguous) }).first(), found, 'ambiguous candidate');
  await expect(tab(t.importGroupAmbiguous, 0)).toBeVisible();
  await pressByKeyboard(a, tab(t.importGroupNotFound, 3), found, 'Not found tab');
  await pressByKeyboard(a, a.locator('[data-group="not-found"]').first().getByRole('button', { name: new RegExp(`^${t.importKeepPrivate}`) }), found, 'Keep private');
  await expect(tab(t.importGroupPrivate, 1)).toBeVisible();
  await checkScreen(a, 'library-import-decided', found, info);
  await pressByKeyboard(a, a.getByRole('button', { name: t.importApply }), found, 'Apply');
  await expect(a.getByText(new RegExp(t.importApplyDone({ done: '(\\d+)', total: '7' }).replace(/\s+/g, '\\s+')))).toBeVisible({ timeout: 240_000 });
  await checkScreen(a, 'library-import-finished', found, info);

  // Progress: device A starts an attempt on volume 1, device B (a second context, as a second phone or laptop) reads it.
  await a.goto(`/${locales.latin}/w/${uuid(volume.work)}`);
  const sheetA = await openDetails(a);
  const start = sheetA.getByRole('region', { name: 'Start an attempt' });
  await start.getByLabel('Edition').selectOption({ label: 'Sword Art Online 1: Aincrad · paperback' });
  await keyboardReach(a, start.getByRole('button', { name: 'Start reading' }), found, 'Start reading');
  await a.keyboard.press('Enter');
  const first = sheetA.getByRole('article', { name: 'First read' });
  await expect(first.getByText('Reading', { exact: true })).toBeVisible();
  await checkScreen(a, 'progress-device-a', found, info);
  await a.keyboard.press('Escape');
  const b = await device(browser, info, `/${locales.latin}/w/${uuid(volume.work)}`);
  const sheetB = await openDetails(b);
  await expect(sheetB.getByRole('article', { name: 'First read' }).getByText('Reading', { exact: true })).toBeVisible();
  await checkScreen(b, 'progress-device-b', found, info);
  await b.context().close();

  // Export: the download is started, finished and saved by keyboard.
  await a.goto(`/${locales.latin}/library`);
  await openSection(a, t.backupTitle, found);
  await expect(a.getByText(t.backupContains)).toBeVisible();
  await checkScreen(a, 'library-export-idle', found, info);
  await pressByKeyboard(a, a.getByRole('button', { name: t.backupStart }), found, 'Start download');
  const ready = a.getByText(/Your file is ready: ([\d,]+) records/);
  await expect(ready).toBeVisible({ timeout: 180_000 });
  await checkScreen(a, 'library-export-ready', found, info);
  const download = a.waitForEvent('download');
  await pressByKeyboard(a, a.getByRole('button', { name: t.backupSave }), found, 'Save file');
  const bundle = JSON.parse(readFileSync((await (await download).path())!, 'utf8')) as { profile: string; rows: unknown[] };
  expect(bundle.profile).toBe('rezics-library-export-v1');
  expect(bundle.rows.length).toBeGreaterThan(0);
  expect(await motionRunning(a), 'running animations under reduced motion').toEqual([]);
  await a.context().close();
  expectClean(found);
});

test('library-import-progress-export: the Library page and its import and download in the CJK locale', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const t = words('ja');
  const found: Findings = [];
  const page = await device(browser, info, `/${locales.cjk}/library`);
  await expect(page.locator('html')).toHaveAttribute('lang', locales.cjk);
  await expect(page.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
  await checkScreen(page, 'library-ja', found, info);
  await openSection(page, t.importTitle, found);
  await expect(page.getByText(t.importAnilist)).toBeVisible();
  await checkScreen(page, 'library-import-ja', found, info);
  await openSection(page, t.backupTitle, found);
  await expect(page.getByText(t.backupContains)).toBeVisible();
  await checkScreen(page, 'library-export-ja', found, info);
  await keyboardReach(page, page.getByRole('button', { name: t.backupStart }), found, 'Start download (ja)');
  await page.context().close();
  expectClean(found);
});
