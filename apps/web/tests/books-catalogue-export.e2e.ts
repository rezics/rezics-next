import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import type { CanonicalRow } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { resourceHref, spaceHref, zoneMemberHref } from '../features/address/path.ts';
import { messages as libraryMessages } from '../features/library/messages.ts';
import libraryJa from '../features/library/messages/ja.ts';
import { localizedPath } from '../i18n/locale.ts';
import type { BooksCatalogue } from './books-catalogue-seed.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { reloadJourney, visitJourney } from './journey-navigation.ts';
import { expectClean, type Findings, keyboardReach, pressByKeyboard } from './g-743-matrix.ts';
import { credentials, uuid, visitor } from './g-743-stack.ts';
import { openLibraryTools } from './library-tools.ts';

let seed: BooksCatalogue;
test.use({ actionTimeout: 20_000 });
test.setTimeout(240_000);
test.beforeAll(async () => {
  test.setTimeout(360_000);
  const result = spawnSync('bun', ['apps/web/tests/books-catalogue-seed.ts'], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 300_000,
  });
  if (result.status !== 0 || result.error) throw new Error(`Books preparation failed: ${result.stderr || result.error?.message || result.status}`);
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as BooksCatalogue;
  const request = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/realms/${uuid(seed.realm)}/modules/browse?limit=20`;
  await expect.poll(async () => {
    const response = await fetch(request);
    if (!response.ok) return `${request}: ${response.status} ${await response.text()}`;
    const body = await response.json() as { items: { id: string }[] };
    return body.items.map(item => item.id).sort();
  }, { message: `The Books Zone must expose its adopted catalogue: GET ${request}`, timeout: 120_000 })
    .toEqual(seed.books.map(book => book.work).sort());
});

async function openBackup(page: Page, title: string, toolsLabel: string, found: Findings) {
  await openLibraryTools(page, toolsLabel, summary => pressByKeyboard(page, summary, found, toolsLabel));
  const summary = page.locator('summary').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const details = summary.locator('..');
  await expect(async () => {
    if (await details.getAttribute('open') !== null) return;
    await pressByKeyboard(page, summary, found, title);
    await expect(details).toHaveAttribute('open', '', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

for (const locale of ['en', 'ja'] as const) {
  test(`books-catalogue: a visitor browses and searches the Books Zone by keyboard and returns after reload (${locale})`, async ({ page }, info) => {
    test.setTimeout(180_000);
    const found: Findings = [];
    const [book, other] = seed.books;
    const browse = localizedPath(spaceHref(seed.handle, 'site', ['browse']), locale);
    await visitJourney(page, browse);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    const results = page.locator('#browse-title').locator('..');
    await expect(results.getByRole('link', { name: book!.title, exact: true }).first()).toBeVisible();
    await expect(results.getByRole('link', { name: other!.title, exact: true }).first()).toBeVisible();
    await expect(results.getByRole('link', { name: seed.outside.title, exact: true })).toHaveCount(0);
    const search = results.getByRole('searchbox');
    await keyboardReach(page, search, found, 'Books search');
    await page.keyboard.type('Lighthouse');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(url => url.pathname === browse && url.searchParams.get('q') === 'Lighthouse', { timeout: 60_000 });
    await expect(results.getByRole('link', { name: book!.title, exact: true }).first()).toBeVisible();
    await expect(results.getByRole('link', { name: other!.title, exact: true })).toHaveCount(0);
    await expect(results.getByRole('link', { name: seed.outside.title, exact: true })).toHaveCount(0);
    await page.waitForLoadState('load');
    await reloadJourney(page);
    await expect(search).toHaveValue('Lighthouse');
    await expect(results.getByRole('link', { name: book!.title, exact: true }).first()).toBeVisible();
    await expect(results.getByRole('link', { name: other!.title, exact: true })).toHaveCount(0);
    await expect(results.getByRole('link', { name: seed.outside.title, exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`books-search-${locale}.png`), fullPage: true });
    const link = results.getByRole('link', { name: book!.title, exact: true }).first();
    const zoneWorkPath = localizedPath(zoneMemberHref(seed.handle, 'w', uuid(book!.work)), locale);
    await expect(link).toHaveAttribute('href', zoneWorkPath);
    await pressByKeyboard(page, link, found, 'Open Book');
    const workPath = localizedPath(resourceHref('/w/', uuid(book!.work)), locale);
    await expect(page).toHaveURL(url => url.pathname.startsWith(zoneWorkPath) || url.pathname.startsWith(workPath), { timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1, name: book!.title, exact: true })).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('load');
    await reloadJourney(page);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.getByRole('heading', { level: 1, name: book!.title, exact: true })).toBeVisible();
    expectClean(found);
  });

  test(`books-library-export: a reader downloads an identified Book after reloading its saved Library shelf (${locale})`, async ({ browser }, info) => {
    test.setTimeout(240_000);
    const found: Findings = [];
    const book = seed.books[locale === 'en' ? 0 : 1]!;
    const t = materializeData(locale === 'ja' ? { ...libraryMessages, ...libraryJa } : libraryMessages, { locale });
    const page = await visitor(browser, info, { reducedMotion: true });
    try {
      // The public API prepares two typed Books on this reader's shelf. This
      // journey proves exporting that existing Library, without a retained-row
      // substitute or a skip when Library is closed.
      await signInAtAccounts(page, `${localizedPath('/library', locale)}?shelf=want-to-read`, credentials().member);
      await expect(page.getByRole('heading', { level: 1, name: t.title, exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 3, name: book.title, exact: true })).toBeVisible();
      await page.waitForLoadState('load');
      await reloadJourney(page);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 3, name: book.title, exact: true })).toBeVisible();
      await openBackup(page, t.backupTitle, t.libraryTools, found);
      await expect(page.getByText(t.backupContains)).toBeVisible();
      await pressByKeyboard(page, page.getByRole('button', { name: t.backupStart, exact: true }), found, t.backupStart);
      const save = page.getByRole('button', { name: t.backupSave, exact: true });
      const resume = page.getByRole('button', { name: t.backupResume, exact: true });
      await expect(save.or(resume)).toBeVisible({ timeout: 120_000 });
      // A failed page read preserves the export checkpoint and offers recovery.
      if (await resume.isVisible()) await pressByKeyboard(page, resume, found, t.backupResume);
      await expect(save).toBeVisible({ timeout: 120_000 });
      const downloading = page.waitForEvent('download');
      await pressByKeyboard(page, save, found, t.backupSave);
      const download = await downloading;
      expect(await download.failure()).toBeNull();
      const bundle = JSON.parse(readFileSync((await download.path())!, 'utf8')) as {
        profile: string; rows: CanonicalRow[];
      };
      expect(bundle.profile).toBe('rezics-library-export-v1');
      for (const saved of seed.books) {
        const entries = bundle.rows.filter(row => row.kind === 'entry' && row.work === saved.work && row.status !== null);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ kind: 'entry', work: saved.work, status: 'want-to-read' });
      }
      await expect(page.getByText(t.backupReady(bundle.rows.length), { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`books-export-${locale}.png`), fullPage: true });
      expectClean(found);
    } finally {
      await page.context().close();
    }
  });
}


test('books: keyboard shelving receives a status response on ten fresh Work visits', async ({ page }, info) => {
  test.setTimeout(600_000);
  const book = seed.outside;
  const account = credentials();
  const path = `/api/main/v1/works/${uuid(book.work)}/reader-status`;
  const statePath = `/api/main/v1/works/${uuid(book.work)}/reader-state?actingSubject=${encodeURIComponent(account.actingSubject)}`;
  const found: Findings = [];
  const requests: string[] = [];
  page.on('request', request => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  page.on('requestfailed', request => requests.push(`FAILED ${request.url()} ${request.failure()?.errorText}`));
  await signInAtAccounts(page, localizedPath(resourceHref('/w/', uuid(book.work)), 'en'), account.member);
  try {
    for (let visit = 0; visit < 10; visit++) {
      const state = await page.request.get(statePath);
      expect(state.status(), await state.text()).toBe(200);
      const current = (await state.json() as { status: { version: number; status: string | null } }).status;
      if (current.status !== null) {
        const removed = await page.request.put(path, { data: {
          actingSubject: account.actingSubject, expectedVersion: current.version, status: null,
        }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
        expect(removed.status(), await removed.text()).toBe(200);
      }
      await visitJourney(page, localizedPath(resourceHref('/w/', uuid(book.work)), 'en'));
      await expect(page.getByRole('heading', { level: 1, name: book.title, exact: true })).toBeVisible({ timeout: 30_000 });
      const add = page.getByRole('button', { name: 'Want to read', exact: true });
      await expect(add).toBeEnabled();
      const written = page.waitForResponse(response => new URL(response.url()).pathname === path
        && response.request().method() === 'PUT', { timeout: 30_000 });
      await pressByKeyboard(page, add, found, 'Want to read');
      const response = await written;
      expect(response.status(), await response.text()).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'want-to-read' });
      const saved = page.getByRole('button', { name: `Want to read — Shelve “${book.title}”`, exact: true });
      await expect(saved).toBeVisible();
      await expect(saved).not.toHaveAttribute('aria-busy', 'true');
      await reloadJourney(page);
      await expect(saved).toBeVisible({ timeout: 30_000 });
    }
    await page.screenshot({ path: info.outputPath('books-keyboard-shelved.png'), fullPage: true });
    expectClean(found);
  } finally {
    await info.attach('shelving-requests', { body: requests.join('\n'), contentType: 'text/plain' });
  }
});
