import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { messages } from '../features/library/messages.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// The QA reader imports the committed Goodreads file, then a 200-row file whose rows Main matches
// and reports a page at a time. Only the seed editor holds catalogue-import authority.
let member: { email: string; password: string };
let seed: { actingSubject: string; works: string[] };
const t = materializeData(messages, { locale: 'en' });
const sample = readFileSync(resolve('tests/fixtures/library-exports/goodreads.csv'));
const known = [['Pride and Prejudice', 'Jane Austen'], ['Jane Eyre', 'Charlotte Brontë'], ['Frankenstein', 'Mary Shelley'],
  ['Little Women', 'Louisa May Alcott'], ['The Odyssey', 'Homer'], ['Moby-Dick', 'Herman Melville'],
  ['Great Expectations', 'Charles Dickens'], ['Wuthering Heights', 'Emily Brontë']];
const synthetic = ['Book Id,Title,Author,ISBN13,My Rating,Date Read,Bookshelves,Exclusive Shelf,My Review',
  ...Array.from({ length: 200 }, (_, index) => index < 160
    ? `${index + 1},${known[index % known.length]![0]},${known[index % known.length]![1]},,5,2026/08/01,classics,read,`
    : `${index + 1},Unknown import title ${index - 159},Nobody Real,,0,,to-read,to-read,`)].join('\n');

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  const mainOrigin = process.env.MAIN_ORIGIN ?? (process.env.MAIN_PORT ? `http://127.0.0.1:${process.env.MAIN_PORT}` : undefined);
  if (!path || !mainOrigin) throw new Error('Library import needs the isolated QA web-auth fixture and Main origin');
  ({ member } = JSON.parse(readFileSync(path, 'utf8')) as { member: typeof member });
  const records = [['Shared Moon', 'Reader Writer'], ['Dropped Moon', 'Reader Writer'], ...known];
  const result = spawnSync('bun', ['apps/web/tests/library-import-seed.ts', JSON.stringify(records)], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 180_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Library import seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as typeof seed;
  // Search delivery is asynchronous; all title and author matches must be ready before the upload.
  await expect.poll(async () => {
    return Promise.all(records.map(async ([title, author]) => {
      const response = await fetch(`${mainOrigin}/v1/search/typeahead?prefix=${encodeURIComponent(title!)}`);
      if (!response.ok) return { title, status: response.status, ready: false };
      const body = await response.json() as { hasMore: boolean; items: {
        matchedText: string; authors: { displayName: string | null }[];
      }[] };
      return { title, status: response.status,
        ready: !body.hasMore && body.items.some(item => item.matchedText === title
          && item.authors.some(creator => creator.displayName === author)),
        matches: body.items.map(item => ({ title: item.matchedText,
          authors: item.authors.map(creator => creator.displayName) })),
      };
    }));
  }, { timeout: 120_000 }).toMatchObject(records.map(([title]) => ({ title, ready: true })));
});

test('G428: a reader imports a Goodreads file, then a 200-row export, and Main reports every row', async ({ page }, info) => {
  test.setTimeout(600_000);
  await signInAtAccounts(page, '/en/library', member);
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  // Catalogue import is closed at launch. The exposure gate answers before authentication,
  // so an ungranted caller is refused with platform_closed and is not given the importer group.
  const directSource = await page.request.post('/api/main/v1/sources/acquisitions/open-library/works', {
    data: { profile: 'open-library-work-acquisition-v1', workId: 'OL66554W' },
    headers: { 'idempotency-key': 'g428-reader-direct-source-denied' } });
  expect(directSource.status()).toBe(403);
  expect(await directSource.json()).toMatchObject({ status: 403, code: 'platform_closed' });
  const readerState = await page.request.get(`/api/main/v1/works/${seed.works[0]!.slice(-36)}/reader-state`
    + `?actingSubject=${encodeURIComponent(seed.actingSubject)}`);
  expect(readerState.status()).toBe(200);
  expect(await readerState.json()).toMatchObject({ work: seed.works[0], status: { status: null } });
  await page.getByRole('heading', { name: t.importTitle }).click();
  const importFile = page.getByLabel(t.importFile, { exact: true });
  await expect(importFile).toBeEnabled();
  await importFile.setInputFiles({ name: 'goodreads.csv', mimeType: 'text/csv', buffer: sample });
  const group = (label: string) => page.getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
  await expect(group(t.importGroupMatched)).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: info.outputPath('import-review-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('import-review-phone.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  if (await page.getByRole('button', { name: t.importKeepAllPrivate }).isVisible()) {
    await page.getByRole('button', { name: t.importKeepAllPrivate }).click();
  }
  await expect(page.getByRole('button', { name: t.importApply })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('button', { name: t.importApply }).click();
  await expect(page.getByRole('link', { name: t.importViewLibrary })).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: info.outputPath('import-result-desktop.png') });

  await page.getByRole('button', { name: t.importClose }).click();
  await expect(importFile).toBeEnabled();
  await importFile.setInputFiles({ name: 'goodreads-200.csv', mimeType: 'text/csv', buffer: Buffer.from(synthetic) });
  await expect(page.getByText(/Checking matches: \d+ of 200/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Checking matches:/)).toHaveCount(0, { timeout: 240_000 });
  await expect(page.getByText(/Page 1 of \d+/).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('import-200-review.png') });
});
