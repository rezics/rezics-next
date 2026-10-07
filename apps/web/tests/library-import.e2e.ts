import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { messages } from '../features/library/messages.ts';
import { signInAtAccounts } from './account-sign-in.ts';

// The Library import on the seeded demo stack (`task dev:seed`): the same Goodreads-shaped file twice
// (the second upload is Main's replay of the first), then a 200-row file whose rows Main matches and
// reports a page at a time. G-855's own journeys, on a fresh QA stack, are in `g-855-library-import.e2e.ts`.
const member = { email: 'rezics-demo-daniel@example.test', password: 'Rezics-demo-2026-daniel' };
const t = materializeData(messages, { locale: 'en' });
const sample = readFileSync(resolve('tests/fixtures/library-exports/goodreads.csv'));
const known = [['Pride and Prejudice', 'Jane Austen'], ['Jane Eyre', 'Charlotte Brontë'], ['Frankenstein', 'Mary Shelley'],
  ['Little Women', 'Louisa May Alcott'], ['The Odyssey', 'Homer'], ['Moby-Dick', 'Herman Melville'],
  ['Great Expectations', 'Charles Dickens'], ['Wuthering Heights', 'Emily Brontë']];
const synthetic = ['Book Id,Title,Author,ISBN13,My Rating,Date Read,Bookshelves,Exclusive Shelf,My Review',
  ...Array.from({ length: 200 }, (_, index) => index < 160
    ? `${index + 1},${known[index % known.length]![0]},${known[index % known.length]![1]},,5,2026/08/01,classics,read,`
    : `${index + 1},Unknown import title ${index - 159},Nobody Real,,0,,to-read,to-read,`)].join('\n');

test('G428: Daniel imports a Goodreads file, then a 200-row export, and Main reports every row', async ({ page }, info) => {
  test.skip(process.env.REZICS_LIBRARY_IMPORT_DEMO !== '1', 'Requires task dev:seed on the isolated worktree stack');
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
  await page.getByRole('heading', { name: t.importTitle }).click();
  await page.locator('#library-import-file').setInputFiles({ name: 'goodreads.csv', mimeType: 'text/csv', buffer: sample });
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
  await page.locator('#library-import-file').setInputFiles({ name: 'goodreads-200.csv', mimeType: 'text/csv', buffer: Buffer.from(synthetic) });
  await expect(page.getByText(/Checking matches: \d+ of 200/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Checking matches:/)).toHaveCount(0, { timeout: 240_000 });
  await expect(page.getByText(/Page 1 of \d+/).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('import-200-review.png') });
});
