import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import type { IntakeCatalogue } from './g-843-catalogue.ts';

// The records are written once into this isolated QA stack through Main's catalogue routes
// (`g-843-catalogue.ts`); the browser signs in as the stack's web member and adds to the catalogue
// the way a contributor does: search first, then say what it is, on desktop and on a phone.
let catalogue: IntakeCatalogue;
test.beforeAll(async () => {
  test.setTimeout(300_000);
  const result = spawnSync('bun', ['apps/web/tests/g-843-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 240_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`G-843 seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  catalogue = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as IntakeCatalogue;
});

const started = Date.now();
/** Progress lines in the Playwright log, so a run that hits its budget says where it was. */
const mark = (step: string) => process.stderr.write(`[g-843 +${Math.round((Date.now() - started) / 1000)}s] ${step}\n`);
test.use({ actionTimeout: 15_000 });
const uuid = (iri: string) => iri.slice(-36);
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };
const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

/** One screenshot per viewport, none with horizontal overflow. */
async function shoot(page: Page, name: string, info: TestInfo) {
  for (const [label, viewport] of [['desktop', desktop], ['phone', phone]] as const) {
    await page.setViewportSize(viewport);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(await overflows(page), `${name} ${label}`).toBe(false);
    await page.screenshot({ path: info.outputPath(`${name}-${label}.png`), fullPage: true });
  }
  await page.setViewportSize(desktop);
}

const searchbox = (page: Page) => page.getByRole('searchbox', { name: 'Title, alias, creator or ISBN' });
const titles = (page: Page) => page.getByRole('list', { name: 'Existing records' }).getByRole('heading', { level: 3 });

/** Types a title and waits until its results have returned. */
async function search(page: Page, text: string) {
  // Typing before the page has hydrated is lost, so type again until the results come back.
  await expect(async () => {
    await searchbox(page).fill('');
    await searchbox(page).fill(text);
    await expect(page.getByTestId('intake-count')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

/** Searches, says "a new story", and creates; the record shows as unverified. */
async function addStory(page: Page, title: string) {
  await search(page, title);
  await page.getByRole('button', { name: 'Add something new' }).click();
  await page.getByRole('radio', { name: /A new story or series/ }).check();
  await page.getByRole('combobox', { name: 'Kind of work' }).selectOption({ label: 'Book' });
  await page.getByRole('button', { name: 'Create record' }).click();
}

test('a contributor searches first, adds a translation to an existing volume, and is stopped at the pending limit', async ({ page }, info) => {
  test.setTimeout(600_000);
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  const { member } = JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } };
  const { series, volumeOne } = catalogue;
  await page.setViewportSize(desktop);

  // Signed out, the wizard offers no search, only the way to sign in.
  await page.goto('/en/catalogue/new');
  await expect(page.getByRole('heading', { name: 'Sign in to add to the catalogue' })).toBeVisible();
  await expect(searchbox(page)).toHaveCount(0);
  await signInAtAccounts(page, '/en/catalogue/new', member);

  mark('signed in');
  // Nothing offers to create before a search has returned.
  await expect(page.getByRole('button', { name: 'Add something new' })).toHaveCount(0);
  await search(page, 'Sword Art Online');
  await expect(titles(page).filter({ hasText: series.title }).first()).toBeVisible();
  await shoot(page, 'search-english', info);

  mark('english search');
  // Japanese and romaji find the same series.
  for (const text of ['ソードアート・オンライン', 'Sōdo Āto Onrain']) {
    await search(page, text);
    await expect(page.locator(`[data-candidate="${uuid(series.work)}"]`)).toBeVisible();
  }
  await shoot(page, 'search-japanese', info);

  mark('japanese and romaji');
  // "Translation" of volume 1 goes to its realizations; no Work is made.
  await search(page, volumeOne.title);
  await expect(titles(page).filter({ hasText: volumeOne.title })).toHaveCount(1);
  await shoot(page, 'search-volume', info);
  const row = page.locator(`[data-candidate="${uuid(volumeOne.work)}"]`);
  await row.getByRole('button', { name: 'Add a translation or edition' }).click();
  await page.waitForURL(new RegExp(`/en/w/${uuid(volumeOne.work)}/edit/editions$`));
  mark('editions page');
  const realization = page.getByRole('form', { name: 'Add a realization' });
  await realization.getByRole('textbox', { name: 'Language', exact: true }).fill('zh-Hans');
  await realization.getByRole('checkbox', { name: 'I am the translator' }).check();
  await realization.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Unofficial' });
  await realization.getByRole('button', { name: 'Add realization' }).click();
  await expect(page.getByText(/Receipt: /).first()).toBeVisible();
  await expect(async () => {
    await page.goto(`/en/w/${uuid(volumeOne.work)}/editions`);
    await expect(page.locator('[data-language-group="zh-Hans"]')).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 45_000 });
  mark('realization listed');
  await page.goto('/en/catalogue/new');
  await search(page, volumeOne.title);
  await expect(titles(page)).toHaveCount(1);

  mark('no new work');
  // A new record: step two asks what it is; the record shows as unverified with its provenance.
  const first = 'Alternative Intake Story A';
  await addStory(page, first);
  await expect(page.getByText('Record created')).toBeVisible();
  await expect(page.locator('[data-provisional]').getByText('Unverified', { exact: true })).toBeVisible();
  await page.getByText('Where these fields came from').click({ timeout: 30_000 });
  await expect(page.locator('[data-provenance-fields]').getByText('Title')).toBeVisible();
  await shoot(page, 'created', info);
  await page.getByRole('link', { name: 'Open the record' }).click();
  await expect(page.getByRole('heading', { level: 1, name: first })).toBeVisible();
  await expect(page.locator('[data-provisional]').getByText('Unverified', { exact: true })).toBeVisible();

  mark('first created');
  // Two more fill the pending quota; the fourth is explained with Main's Retry-After.
  for (const title of ['Alternative Intake Story B', 'Alternative Intake Story C']) {
    await page.goto('/en/catalogue/new');
    await addStory(page, title);
    await expect(page.getByText('Record created')).toBeVisible();
  }
  mark('b and c created');
  await page.goto('/en/catalogue/new');
  await addStory(page, 'Alternative Intake Story D');
  const limit = page.getByRole('alert');
  await expect(limit).toContainText('Three records are waiting for review');
  await expect(limit).toContainText('60 seconds');
  await shoot(page, 'limit', info);
});
