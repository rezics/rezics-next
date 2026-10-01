import { spawnSync } from 'node:child_process';
import { expect, type Page, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { messages } from '../features/library/messages.ts';
import ko from '../features/library/messages/ko.ts';
import { clean, credentials, signIn } from './g-855-library.ts';

// G-855 in a real browser on a fresh QA stack: a Goodreads file imported from the Library page (matched,
// ambiguous and not-found rows, a choice, a row kept private, the connection dropping in the middle of
// applying and a reload), at a phone and a desktop width in English and Korean. Main parses and matches;
// the browser only shows what it reports. The download and the round trip are in the other G-855 files.

interface Seed { matched: string[]; ambiguous: string }
let seed: Seed;
test.use({ actionTimeout: 20_000 });

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
    // Accounts shows its sign-in in the language of the page it returns to; sign in in English, then change language.
    await signIn(page, '/en/library', account.member);
    await page.goto(`/${locale}/library`);
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

    // Apply. Main answers its first group (eight rows) with more pending; the connection then drops, as a
    // closed laptop would, and the reader reloads. Nothing is lost: the import is listed to continue.
    const applies = /\/library-imports\/[^/]+\/apply$/;
    let calls = 0;
    await page.route(applies, route => ++calls === 1 ? route.continue() : route.abort());
    await page.getByRole('button', { name: t.importApply }).click();
    await expect(page.getByText(t.importApplyStopped)).toBeVisible({ timeout: 120_000 });
    expect(calls).toBe(2);
    await page.unroute(applies);
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
