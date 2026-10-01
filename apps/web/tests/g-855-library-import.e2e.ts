import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { messages } from '../features/library/messages.ts';
import ko from '../features/library/messages/ko.ts';
import { axeViolations, formatViolations } from './a11y-axe.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// G-855 in a real browser on a fresh QA stack: a Goodreads file imported from the Library page (matched,
// ambiguous and not-found rows, a choice, a row kept private, a reload in the middle of applying), then a
// 1,200-record library downloaded with a reload in the middle, resumed, and imported back. Main parses and
// matches; the browser only shows what it reports. The QA harness has one web member, so the library is
// imported back into the same account: the second-account comparison is covered by G-854's integration test.

interface Seed { matched: string[]; ambiguous: string }
let seed: Seed;
test.use({ actionTimeout: 20_000 });

function credentials() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return JSON.parse(readFileSync(path, 'utf8')) as { actingSubject: string; member: { email: string; password: string } };
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const result = spawnSync('bun', ['apps/web/tests/g-855-seed.ts'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 180_000 });
  if (result.status !== 0 || result.error) throw new Error(`G-855 seed failed: ${result.stderr || result.error?.message || result.status}`);
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
  // Main keeps processing the seed's events for a while, moving the graph under every read (409).
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/search/typeahead?prefix=${encodeURIComponent(seed.ambiguous)}`;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
    const response = await fetch(main).catch(() => null);
    const body = response?.ok ? await response.json() as { items: unknown[] } : null;
    if (body && body.items.length >= 2) return;
    await new Promise(done => setTimeout(done, 1_000));
  }
  throw new Error('Search never indexed the seeded Works');
});

const combos = [
  { locale: 'en', viewport: { width: 1440, height: 900 } },
  { locale: 'ko', viewport: { width: 390, height: 844 } },
] as const;
const words = (locale: 'en' | 'ko') => materializeData(locale === 'ko' ? { ...messages, ...ko } : messages, { locale });

const header = 'Book Id,Title,Author,ISBN13,ISBN,My Rating,Exclusive Shelf,Bookshelves,Date Started,Date Read,My Review,Read Count,Private Notes';
/** Three rows each naming one seeded Work, one naming the two that share a title, and seven nothing matches. */
function goodreads(offset: number): Buffer {
  const rows = [...seed.matched.map((title, index) => `${offset + index},${title},,,,0,${index ? 'to-read' : 'read'},,,,,0,`),
    `${offset + 3},${seed.ambiguous},,,,0,to-read,,,,,0,`,
    ...Array.from({ length: 7 }, (_, index) => `${offset + 4 + index},Nothing Here ${offset} ${index + 1},Nobody Real,,,0,to-read,,,,,0,`)];
  return Buffer.from([header, ...rows].join('\n'));
}

const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
async function clean(page: Page, info: TestInfo, name: string) {
  expect(await overflows(page), `${name} overflows`).toBe(false);
  const violations = await axeViolations(page);
  expect(violations, formatViolations(violations)).toEqual([]);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

/** Open the section once the page has hydrated; a press before hydration opens nothing. */
async function openSection(page: Page, title: string) {
  const summary = page.getByRole('heading', { name: title }).first();
  await expect(async () => {
    await summary.click();
    await expect(summary.locator('xpath=ancestor::details[1]')).toHaveAttribute('open', '');
  }).toPass({ timeout: 30_000 });
}

for (const { locale, viewport } of combos) {
  test(`${locale} ${viewport.width}: a Goodreads file is reviewed, chosen from, applied across a reload and shows what each row became`, async ({ page }, info) => {
    test.setTimeout(420_000);
    const t = words(locale);
    const account = credentials();
    await page.setViewportSize(viewport);
    await signInAtAccounts(page, `/${locale}/library`, account.member);
    if (await page.getByRole('heading', { name: t.deniedTitle }).isVisible()) return;
    await openSection(page, t.importTitle);
    await expect(page.getByText(t.importAnilist)).toBeVisible();
    await page.locator('#library-import-file').setInputFiles({ name: 'goodreads_library_export.csv', mimeType: 'text/csv', buffer: goodreads(viewport.width) });

    const tab = (label: string, count: number) => page.getByRole('button', { name: `${label} ${count}`, exact: true });
    await expect(tab(t.importGroupAmbiguous, 1)).toBeVisible({ timeout: 180_000 });
    await expect(tab(t.importGroupNotFound, 7)).toBeVisible();
    await expect(tab(t.importGroupMatched, 3)).toBeVisible();
    await expect(page.getByRole('button', { name: t.importApply })).toBeDisabled();
    await clean(page, info, `review-${locale}-${viewport.width}`);

    // The ambiguous row: choose one of its candidates.
    const ambiguous = page.locator('[data-group="ambiguous"]').first();
    await expect(ambiguous).toContainText(seed.ambiguous);
    await ambiguous.getByRole('button', { name: new RegExp(seed.ambiguous) }).first().click();
    await expect(tab(t.importGroupAmbiguous, 0)).toBeVisible();
    // A not-found row: keep it private; the others stay private when apply starts.
    await tab(t.importGroupNotFound, 7).click();
    await page.locator('[data-group="not-found"]').first().getByRole('button', { name: new RegExp(`^${t.importKeepPrivate}`) }).click();
    await expect(tab(t.importGroupPrivate, 1)).toBeVisible();
    await expect(page.getByRole('button', { name: t.importApply })).toBeEnabled();

    // Apply, and reload once Main has answered its first group with more still pending.
    const firstGroup = page.waitForResponse(response => /\/library-imports\/[^/]+\/apply$/.test(response.url()) && response.status() === 202);
    await page.getByRole('button', { name: t.importApply }).click();
    await firstGroup;
    await page.reload();
    await openSection(page, t.importTitle);
    await expect(page.getByRole('heading', { name: t.importUnfinishedTitle })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(`^${t.importContinue}`) }).click();
    await expect(page.getByText(new RegExp(t.importApplyDone({ done: '(\\d+)', total: '11' }).replace(/\s+/g, '\\s+')))).toBeVisible({ timeout: 240_000 });
    await page.getByRole('button', { name: new RegExp(`^${t.importTabAll}`) }).click();
    await expect(page.getByText(t.importRowKeptPrivate).first()).toBeVisible();
    await expect(page.getByText(t.importRowAdded).first()).toBeVisible();
    await clean(page, info, `finished-${locale}-${viewport.width}`);
    // Finished, so it is no longer listed as unfinished.
    await page.reload();
    await openSection(page, t.importTitle);
    await expect(page.getByRole('heading', { name: t.importUnfinishedTitle })).toHaveCount(0);
  });
}

test('a 1,200-record library downloads across a reload, resumes, and imports back to the same contents', async ({ page }, info) => {
  test.setTimeout(900_000);
  const t = words('en');
  const account = credentials();
  await signInAtAccounts(page, '/en/library', account.member);
  if (await page.getByRole('heading', { name: t.deniedTitle }).isVisible()) return;
  const api = async <T>(method: 'get' | 'post', path: string, data?: object): Promise<T> => {
    const response = await page.request[method](`/api/main${path}`, { headers: { 'idempotency-key': `g855-${crypto.randomUUID()}` }, ...data ? { data } : {} });
    expect(response.status(), await response.text()).toBeLessThan(300);
    return await response.json() as T;
  };
  // A library of 1,200 retained source records, beyond every page bound, written through the import API.
  const retained = Array.from({ length: 1_200 }, (_, index) => ({ kind: 'retained', sourceId: `unmatched-${index}`, title: `Private title ${index}`,
    creators: [], work: null, target: null, identifiers: [], status: null, startedOn: null, finishedOn: null, score: null, review: null,
    shelves: [], readCount: null, progress: null, session: null, raw: { progress: `c${index}`, extra: `private-${index}` } }));
  const created = await api<{ id: string; total: number }>('post', '/v1/me/library-imports',
    { actingSubject: account.actingSubject, format: 'rezics', file: JSON.stringify({ profile: 'rezics-library-export-v1', rows: retained }) });
  for (let cursor: number | null = -1; cursor !== null;) {
    cursor = (await api<{ nextCursor: number | null }>('get', `/v1/me/library-imports/${created.id}/rows?actingSubject=${encodeURIComponent(account.actingSubject)}${cursor >= 0 ? `&cursor=${cursor}` : ''}`)).nextCursor;
  }
  for (let progress = { pending: true }; progress.pending;) {
    progress = await api('post', `/v1/me/library-imports/${created.id}/apply`, { actingSubject: account.actingSubject, context: null, language: 'und' });
  }

  // Slow each page a little, so the reload lands in the middle of the download.
  await page.route('**/v1/me/library-export?**', async route => { await new Promise(done => setTimeout(done, 120)); await route.continue(); });
  await page.reload();
  await openSection(page, t.backupTitle);
  await expect(page.getByText(t.backupContains)).toBeVisible();
  await expect(page.getByText(t.backupNever)).toBeVisible();
  await clean(page, info, 'export-idle');
  await page.getByRole('button', { name: t.backupStart }).click();
  await expect(page.getByText(/Collected [4-9]\d records/)).toBeVisible({ timeout: 120_000 });
  await page.reload();
  await openSection(page, t.backupTitle);
  const paused = page.getByText(/The download stopped after (\d+) records/);
  await expect(paused).toBeVisible();
  const stoppedAt = Number((await paused.textContent())!.match(/after (\d+) records/)![1]);
  expect(stoppedAt).toBeGreaterThanOrEqual(40);
  await clean(page, info, 'export-paused');
  await page.getByRole('button', { name: t.backupResume }).click();
  const ready = page.getByText(/Your file is ready: ([\d,]+) records/);
  await expect(ready).toBeVisible({ timeout: 300_000 });
  const records = Number((await ready.textContent())!.match(/ready: ([\d,]+) records/)![1].replaceAll(',', ''));
  expect(records).toBeGreaterThanOrEqual(1_200);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: t.backupSave }).click();
  const file = await (await download).path();
  const bundle = JSON.parse(readFileSync(file!, 'utf8')) as { profile: string; rows: Array<Record<string, unknown>> };
  expect(bundle.profile).toBe('rezics-library-export-v1');
  expect(bundle.rows).toHaveLength(records);
  await clean(page, info, 'export-ready');

  // Back in through the Library page: every row is matched, applies without a problem, and a new export has the same contents.
  await page.unroute('**/v1/me/library-export?**');
  await page.getByRole('heading', { name: t.importTitle }).click();
  await page.getByRole('radio', { name: 'REZICS' }).check();
  await page.locator('#library-import-file').setInputFiles({ name: 'rezics-library.json', mimeType: 'application/json', buffer: readFileSync(file!) });
  await expect(page.getByRole('button', { name: t.importApply })).toBeEnabled({ timeout: 300_000 });
  await page.getByRole('button', { name: t.importApply }).click();
  await expect(page.getByText(/Finished: \d+ of \d+ rows/)).toBeVisible({ timeout: 600_000 });
  const again = [];
  for (let cursor: string | null = null, snapshot: string | undefined; ;) {
    const query: string = `actingSubject=${encodeURIComponent(account.actingSubject)}${cursor ? `&cursor=${encodeURIComponent(cursor)}&snapshot=${encodeURIComponent(snapshot!)}` : ''}`;
    const next = await api<{ rows: Array<Record<string, unknown>>; snapshot: string; nextCursor: string | null }>('get', `/v1/me/library-export?${query}`);
    snapshot ??= next.snapshot; again.push(...next.rows);
    if (!next.nextCursor) break;
    cursor = next.nextCursor;
  }
  const digest = (rows: Array<Record<string, unknown>>) => rows.filter(row => row.kind === 'retained').map(row => JSON.stringify(row.raw)).sort();
  expect(digest(again)).toEqual(digest(bundle.rows));
});
