import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect as baseExpect, type Locator, type Page, test } from '@playwright/test';
import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { keyboardReach, type Findings } from './g-743-matrix.ts';

const expect = baseExpect.configure({ timeout: 30_000 });

interface SeededWork {
  handle: 'anime' | 'manga';
  longWork: string;
  title: string;
  undatedWork: string;
  undatedTitle: string;
}

interface Seeded {
  anime: SeededWork;
  manga: SeededWork;
}

interface PrivateFixture {
  member: { email: string; password: string };
}

let hub: Seeded;
let member: PrivateFixture['member'];

test.use({ actionTimeout: 15_000, reducedMotion: 'reduce' });

const uuid = (iri: string) => iri.slice(-36);
const at = (work: string) => localizedPath(resourceHref('/w/', uuid(work)), 'en');

function seedPath(): string {
  const run = process.env.REZICS_QA_RUN_ID;
  if (!run) throw new Error('REZICS_QA_RUN_ID must identify the isolated anime and manga seed');
  return resolve('.temp/anime-manga-zones', run, 'seed.json');
}

function loadSeed(): Seeded {
  const path = seedPath();
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as Seeded;

  const result = spawnSync('bun', ['apps/web/tests/anime-manga-zones-seed.ts', '--work-hub'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`anime and manga seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  if (!existsSync(path)) {
    const output = result.stdout.trim().split('\n').at(-1);
    if (!output) throw new Error('anime and manga seed returned no JSON record');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, output);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Seeded;
}

async function waitForStableWork(work: string): Promise<void> {
  const port = process.env.MAIN_PORT;
  if (!port) throw new Error('MAIN_PORT must name the isolated Main service');
  const url = `http://127.0.0.1:${port}/v1/works/${uuid(work)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(url).catch(() => null);
    const position = response?.ok
      ? JSON.stringify(((await response.json()) as { sourcePosition: unknown }).sourcePosition)
      : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (still < 4) throw new Error(`Main’s graph kept moving for 90 seconds after ${work} was seeded`);
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  hub = loadSeed();
  const authPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!authPath) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must identify the isolated QA reader');
  member = (JSON.parse(readFileSync(authPath, 'utf8')) as PrivateFixture).member;
  await Promise.all([
    hub.anime.longWork,
    hub.anime.undatedWork,
    hub.manga.longWork,
    hub.manga.undatedWork,
  ].map(waitForStableWork));
});

async function openChoice(page: Page, control: Locator, found: Findings, label: string): Promise<Locator> {
  await keyboardReach(page, control, found, label);
  await page.keyboard.press('Enter');
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  return list.getByRole('option');
}

async function closeChoice(page: Page, control: Locator): Promise<void> {
  const list = page.getByRole('listbox');
  if (await list.isVisible()) await control.press('Escape');
  await expect(list).toBeHidden({ timeout: 3_000 });
}

async function chooseOption(page: Page, control: Locator, options: Locator, name: string): Promise<void> {
  const names = (await options.allTextContents()).map((text) => text.trim());
  const index = names.indexOf(name);
  expect(index, `a unique option named ${name}`).toBeGreaterThanOrEqual(0);
  expect(names.filter((item) => item === name)).toHaveLength(1);
  await page.keyboard.press('Home');
  for (let step = 0; step < index; step += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await closeChoice(page, control);
}

async function optionNames(page: Page, control: Locator, found: Findings, label: string): Promise<string[]> {
  const options = await openChoice(page, control, found, label);
  const names = (await options.allTextContents()).map((text) => text.trim());
  await closeChoice(page, control);
  return names;
}

/** A formal release can be listed under a language other than the initial interface language. */
async function languageWithTwoEditions(
  page: Page,
  availability: Locator,
  found: Findings,
): Promise<{ edition: Locator; names: string[] }> {
  const language = availability.getByRole('combobox', { name: 'Language', exact: true });
  const edition = availability.getByRole('combobox', { name: 'Edition', exact: true });
  const offered = async () => optionNames(page, edition, found, 'Edition');
  let names = await offered();
  if (names.length >= 3) return { edition, names };

  const languageNames = await optionNames(page, language, found, 'Language');
  const current = (await language.textContent())?.trim() ?? '';
  for (const name of languageNames) {
    if (name === current) continue;
    await chooseOption(page, language, await openChoice(page, language, found, 'Language'), name);
    names = await offered();
    if (names.length >= 3) return { edition, names };
  }
  throw new Error(`no language offers two releases or editions: ${languageNames.join(' | ')}`);
}

async function showFullFacts(page: Page, found: Findings): Promise<Locator> {
  const facts = page.locator('[data-full-facts]');
  await expect(facts).toBeVisible();
  const summary = facts.locator('summary');
  await keyboardReach(page, summary, found, 'Full facts and sources');
  await page.keyboard.press('Enter');
  await expect(facts).toHaveJSProperty('open', true);
  return facts;
}

test('anime-manga-hub: an anime and a manga Work show their recorded and missing dates', async ({ page }) => {
  test.setTimeout(240_000);
  const found: Findings = [];
  await signInAtAccounts(page, at(hub.anime.longWork), member);

  for (const [media, date] of [[hub.anime, '1980-01-01'], [hub.manga, '1995-01-01']] as const) {
    await page.goto(at(media.longWork));
    await expect(page.getByRole('heading', { level: 1, name: media.title, exact: true })).toBeVisible();
    const facts = await showFullFacts(page, found);
    await expect(facts.locator('[data-statement-group]').filter({ hasText: date })).toContainText(date);
    await test.info().attach(`${media.handle}-publication-date`, {
      body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
    });

    await page.goto(at(media.undatedWork));
    await expect(page.getByRole('heading', { level: 1, name: media.undatedTitle, exact: true })).toBeVisible();
    const undatedFacts = await showFullFacts(page, found);
    await expect(undatedFacts).not.toContainText(/\b\d{4}-\d{2}-\d{2}\b/);
  }

  expect(found, 'keyboard focus on the facts disclosure').toEqual([]);
});

test('anime-manga-hub: a reader chooses anime and manga editions by keyboard and keeps them after reload', async (
  { page },
) => {
  test.setTimeout(300_000);
  const found: Findings = [];
  await signInAtAccounts(page, at(hub.anime.longWork), member);

  for (const media of [hub.anime, hub.manga]) {
    const workPath = at(media.longWork);
    await page.goto(workPath);
    await expect(page.getByRole('heading', { level: 1, name: media.title, exact: true })).toBeVisible();
    const availability = page.getByRole('region', { name: 'Your edition and availability' });
    await expect(availability).toBeVisible();
    const { edition, names } = await languageWithTwoEditions(page, availability, found);
    const current = (await edition.textContent())?.trim() ?? '';
    const choice = names.find((name, index) => index > 0 && name !== current);
    expect(choice, `a second release or edition among ${names.join(' | ')}`).toBeTruthy();
    const selectedLanguage = (await availability.getByRole('combobox', { name: 'Language', exact: true }).textContent())?.trim();

    await chooseOption(page, edition, await openChoice(page, edition, found, 'Edition'), choice!);
    const save = availability.getByRole('button', { name: 'Save choice', exact: true });
    await keyboardReach(page, save, found, 'Save choice');
    await page.keyboard.press('Enter');
    await expect(availability.getByRole('status')).toHaveText('Saved.');
    const status = page.locator('[data-identity-status]:visible').first();
    // Saving refreshes the server-rendered primary action. Let that refresh
    // finish before a hard reload starts another navigation.
    await expect(status).toContainText(`Your edition: ${selectedLanguage}`);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    const reloadedAvailability = page.getByRole('region', { name: 'Your edition and availability' });
    await expect(reloadedAvailability.getByRole('combobox', { name: 'Edition', exact: true }))
      .toContainText(choice!);
    await expect(status).toContainText(`Your edition: ${selectedLanguage}`);
    await test.info().attach(`${media.handle}-saved-edition`, {
      body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
    });
  }

  expect(found, 'keyboard focus while choosing and saving each edition').toEqual([]);
});
