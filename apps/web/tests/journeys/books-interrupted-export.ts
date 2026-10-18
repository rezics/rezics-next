import { readFileSync } from 'node:fs';
import { expect, test, type Route } from '@playwright/test';
import { materializeData } from 'native-i18n';
import type { CanonicalRow } from '../../../../services/main/src/modules/library-import/formats/contract.ts';
import { messages } from '../../features/library/messages.ts';
import ja from '../../features/library/messages/ja.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { prepareBook, prepareBookCopies } from '../books-browser-fixture.ts';
import { expectClean, type Findings, pressByKeyboard } from '../g-743-matrix.ts';
import { openLibraryTools } from '../library-tools.ts';

const exportRequests = '**/v1/me/library-export?**';

export function registerBooksExportJourney() {
  for (const [locale, viewport] of [
    ['en', { width: 1440, height: 900 }],
    ['ja', { width: 390, height: 844 }],
  ] as const) {
    test(`books / Resume an interrupted export (${locale}): a reader reloads and saves every Book copy once`, async ({ page }, info) => {
      test.setTimeout(300_000);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const t = materializeData(locale === 'ja' ? { ...messages, ...ja } : messages, { locale });
      const book = await prepareBook(page, locale);
      const { release, copies } = await prepareBookCopies(page, book);
      const findings: Findings = [];
      await page.goto(localizedPath('/library', locale));
      await expect(page.getByRole('heading', { name: t.deniedTitle })).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await openLibraryTools(page, t.libraryTools,
        summary => pressByKeyboard(page, summary, findings, t.libraryTools));
      const section = page.getByRole('region', { name: t.backupTitle, exact: true });
      const disclosure = section.locator('summary');
      await pressByKeyboard(page, disclosure, findings, 'Download library disclosure');
      await expect(section.getByText(t.backupContains, { exact: true })).toBeVisible();

      // Drop only the transport of a continuation. All successful pages come from Main;
      // no response, row, cursor, stored progress or production module is replaced.
      const interrupted: { cursor?: string; snapshot?: string } = {};
      const dropContinuation = async (route: Route) => {
        const query = new URL(route.request().url()).searchParams;
        if (query.has('cursor')) {
          interrupted.cursor = query.get('cursor')!;
          interrupted.snapshot = query.get('snapshot')!;
          await route.abort('internetdisconnected');
        } else await route.continue();
      };
      await page.route(exportRequests, dropContinuation);
      const firstResponse = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/v1/me/library-export') && !url.searchParams.has('cursor');
      });
      await pressByKeyboard(page, section.getByRole('button', { name: t.backupStart, exact: true }), findings, 'Start library download');
      const response = await firstResponse;
      expect(response.ok(), await response.text()).toBe(true);
      const first = await response.json() as { rows: CanonicalRow[]; snapshot: string; nextCursor: string | null };
      expect(first.rows.length).toBeGreaterThan(0);
      expect(first.rows.length).toBeLessThan(copies.length);
      expect(first.nextCursor).toBeTruthy();
      await expect(section.getByRole('alert')).toHaveText(t.backupPaused(first.rows.length), { timeout: 60_000 });
      expect(interrupted.cursor).toBe(first.nextCursor);
      expect(interrupted.snapshot).toBe(first.snapshot);
      await page.unroute(exportRequests, dropContinuation);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await openLibraryTools(page, t.libraryTools,
        summary => pressByKeyboard(page, summary, findings, t.libraryTools));
      await pressByKeyboard(page, disclosure, findings, 'Reopen library download');
      await expect(section.getByRole('alert')).toHaveText(t.backupPaused(first.rows.length));
      await page.screenshot({ path: info.outputPath(`book-export-paused-${locale}.png`), fullPage: true });
      const resumed = page.waitForRequest(request => {
        const url = new URL(request.url());
        return url.pathname.endsWith('/v1/me/library-export');
      });
      await pressByKeyboard(page, section.getByRole('button', { name: t.backupResume, exact: true }), findings, 'Resume library download');
      const resumedQuery = new URL((await resumed).url()).searchParams;
      expect(resumedQuery.get('cursor')).toBe(interrupted.cursor);
      expect(resumedQuery.get('snapshot')).toBe(interrupted.snapshot);
      const save = section.getByRole('button', { name: t.backupSave, exact: true });
      await expect(save).toBeVisible({ timeout: 90_000 });
      const download = page.waitForEvent('download');
      await pressByKeyboard(page, save, findings, 'Save complete library file');
      const file = await (await download).path();
      expect(file).toBeTruthy();
      const bundle = JSON.parse(readFileSync(file!, 'utf8')) as { profile: string; rows: CanonicalRow[] };
      expect(bundle.profile).toBe('rezics-library-export-v1');
      const owned = bundle.rows.filter(row => row.work === book.work && row.raw.libraryCopy);
      expect(owned).toHaveLength(copies.length);
      expect(owned.map(row => row.sourceId).sort()).toEqual(copies.map(copy => `copy:${copy.id}`).sort());
      for (const copy of copies) {
        const row = owned.find(row => row.sourceId === `copy:${copy.id}`)!;
        expect(row.target).toBe(release);
        expect(row.raw.libraryCopy).toMatchObject({ id: copy.id, work: book.work, release, format: copy.format });
      }
      expect(new Set(bundle.rows.map(row => `${row.kind}:${row.sourceId}`)).size).toBe(bundle.rows.length);
      await expect(section.getByRole('status')).toHaveText(t.backupReady(bundle.rows.length));
      await page.screenshot({ path: info.outputPath(`book-export-ready-${locale}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expectClean(findings);
    });
  }
}
