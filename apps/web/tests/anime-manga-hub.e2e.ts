import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect as baseExpect, type Locator, type Page, test } from '@playwright/test';
import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { keyboardReach, type Findings } from './g-743-matrix.ts';

const expect = baseExpect.configure({ timeout: 30_000 });
const DATE_PUBLISHED = 'https://schema.org/datePublished';

interface SeededWork {
  handle: 'anime' | 'manga';
  longWork: string;
  title: string;
  concept: string;
  publicationDate: string;
  releases: { id: string; title: string }[];
  undatedWork: string;
  undatedTitle: string;
  undatedConcept: string;
}

interface Seeded {
  anime: SeededWork;
  manga: SeededWork;
}

interface PrivateFixture {
  member: { email: string; password: string };
  operator: { email: string; password: string };
  actingSubject: string;
}

let hub: Seeded;
let readers: PrivateFixture;
const publicationDates = new Map<string, string[]>();

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

async function publicRead<T>(path: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${process.env.MAIN_PORT}${path}`);
  expect(response.status, path).toBe(200);
  return await response.json() as T;
}

async function verifyFixture(media: SeededWork): Promise<void> {
  for (const [work, concept, dates] of [
    [media.longWork, media.concept, [media.publicationDate]],
    [media.undatedWork, media.undatedConcept, []],
  ] as const) {
    const classifications = await publicRead<{ items: { concept: string; name: { value: string } }[] }>(
      `/v1/works/${uuid(work)}/classifications?language=en`,
    );
    expect(classifications.items, `${media.handle} fixture classification`).toContainEqual(expect.objectContaining({
      concept, name: expect.objectContaining({ value: media.handle === 'anime' ? 'TV' : 'Manga' }),
    }));
    const facts = await publicRead<{ groups: { predicate: string; items: {
      kind: string; value?: { kind: string; lexical?: string };
    }[] }[] }>(`/v1/resources/${uuid(work)}/statements`);
    const recorded = facts.groups.flatMap(group => group.predicate === DATE_PUBLISHED
      ? group.items.filter(item => item.kind === 'statement' && item.value?.kind === 'literal')
        .map(item => item.value!.lexical!)
      : []);
    expect(recorded, `${media.handle} publication dates returned by Main`).toEqual(dates);
    publicationDates.set(work, recorded);
  }
  const releases = await publicRead<{ items: { id: string; title: { value: string } }[] }>(
    `/v1/works/${uuid(media.longWork)}/releases`,
  );
  expect(media.releases).toHaveLength(2);
  for (const release of media.releases) {
    expect(releases.items).toContainEqual(expect.objectContaining({ id: release.id,
      title: expect.objectContaining({ value: release.title }) }));
  }
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  hub = loadSeed();
  const authPath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!authPath) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must identify the isolated QA reader');
  readers = JSON.parse(readFileSync(authPath, 'utf8')) as PrivateFixture;
  await Promise.all([
    hub.anime.longWork,
    hub.anime.undatedWork,
    hub.manga.longWork,
    hub.manga.undatedWork,
  ].map(waitForStableWork));
  for (const media of [hub.anime, hub.manga]) await verifyFixture(media);
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

/** Match a seeded release by its title, including the bibliographic details the chooser adds. */
async function languageWithRelease(
  page: Page,
  availability: Locator,
  found: Findings,
  title: string,
): Promise<{ edition: Locator; name: string }> {
  const language = availability.getByRole('combobox', { name: 'Language', exact: true });
  const edition = availability.getByRole('combobox', { name: 'Edition', exact: true });
  const offered = async () => optionNames(page, edition, found, 'Edition');
  const match = (names: string[]) => {
    const releases = names.filter(name => name === title || name.startsWith(`${title} · `));
    expect(releases.length, `at most one option for the seeded release ${title}`).toBeLessThanOrEqual(1);
    return releases[0];
  };
  let names = await offered();
  let name = match(names);
  if (name) return { edition, name };

  const languageNames = await optionNames(page, language, found, 'Language');
  const current = (await language.textContent())?.trim() ?? '';
  for (const languageName of languageNames) {
    if (languageName === current) continue;
    await chooseOption(page, language, await openChoice(page, language, found, 'Language'), languageName);
    names = await offered();
    name = match(names);
    if (name) return { edition, name };
  }
  throw new Error(`no language offers the seeded release ${title}: ${languageNames.join(' | ')}`);
}

/** The independent Account fixture becomes a reader through the public onboarding and identity APIs. */
async function signInSecondReader(page: Page): Promise<void> {
  await signInAtAccounts(page, '/en', readers.operator, true);
  await expect(page).toHaveURL(/\/en\/onboarding(?:\?|$)/);
  const key = (await page.context().cookies()).find(cookie => cookie.name === 'rezics_session_key')?.value;
  expect(key).toBeTruthy();
  const headers = { 'x-session-key': key! };
  const created = await page.request.post('/api/main/v1/me/onboarding', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { profile: 'person-onboarding-v1', displayName: 'Hub default reader' },
  });
  expect([200, 201], await created.text()).toContain(created.status());
  const person = await created.json() as { agent: string };
  const session = await page.request.get('/api/main/v1/me/session-agent', { headers });
  expect(session.status()).toBe(200);
  const state = await session.json() as { sessionAgent: { revision: string | null } };
  const selected = await page.request.post('/identity/select', {
    maxRedirects: 0,
    form: { agent: person.agent, next: '/en', locale: 'en', sessionRevision: state.sessionAgent.revision ?? '' },
  });
  expect(selected.status(), await selected.text()).toBe(303);
  await page.goto('/en');
  const selectedState = await page.request.get('/api/main/v1/me/session-agent', { headers });
  expect(selectedState.status()).toBe(200);
  expect((await selectedState.json() as { sessionAgent: { actingSubject: string; eligible: boolean } }).sessionAgent)
    .toMatchObject({ actingSubject: person.agent, eligible: true });
  expect(person.agent).not.toBe(readers.actingSubject);
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
  await signInAtAccounts(page, at(hub.anime.longWork), readers.member);

  for (const media of [hub.anime, hub.manga]) {
    await page.goto(at(media.longWork));
    await expect(page.getByRole('heading', { level: 1, name: media.title, exact: true })).toBeVisible();
    const facts = await showFullFacts(page, found);
    for (const date of publicationDates.get(media.longWork)!) {
      await expect(facts.locator('[data-statement-group]').filter({ hasText: date })).toContainText(date);
    }
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

test('anime-manga-hub: a reader chooses named anime and manga releases by keyboard, keeps them after reload, and another reader retains defaults', async (
  { page, browser }, info,
) => {
  test.setTimeout(420_000);
  const found: Findings = [];
  await signInAtAccounts(page, at(hub.anime.longWork), readers.member);

  for (const media of [hub.anime, hub.manga]) {
    const workPath = at(media.longWork);
    await page.goto(workPath);
    await expect(page.getByRole('heading', { level: 1, name: media.title, exact: true })).toBeVisible();
    const availability = page.getByRole('region', { name: 'Your edition and availability' });
    await expect(availability).toBeVisible();
    const choice = media.releases[1]!;
    const { edition, name } = await languageWithRelease(page, availability, found, choice.title);
    const current = (await edition.textContent())?.trim() ?? '';
    expect(current, 'the named release differs from the default').not.toBe(name);

    await chooseOption(page, edition, await openChoice(page, edition, found, 'Edition'), name);
    const save = availability.getByRole('button', { name: 'Save choice', exact: true });
    await keyboardReach(page, save, found, 'Save choice');
    await page.keyboard.press('Enter');
    await expect(availability.getByRole('status')).toHaveText('Saved.');
    const status = page.locator('[data-identity-status]:visible').first();
    // Saving refreshes the server-rendered primary action. Let that refresh
    // finish before a hard reload starts another navigation.
    await expect(status).toContainText(`Your edition: ${choice.title}`);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    const reloadedAvailability = page.getByRole('region', { name: 'Your edition and availability' });
    await expect(reloadedAvailability.getByRole('combobox', { name: 'Edition', exact: true }))
      .toHaveText(name);
    await expect(status).toContainText(`Your edition: ${choice.title}`);
    await test.info().attach(`${media.handle}-saved-edition`, {
      body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
    });
  }

  const second = await browser.newContext({ baseURL: info.project.use.baseURL });
  try {
    const other = await second.newPage();
    await signInSecondReader(other);
    for (const media of [hub.anime, hub.manga]) {
      await other.goto(at(media.longWork));
      await expect(other.getByRole('heading', { level: 1, name: media.title, exact: true })).toBeVisible();
      const availability = other.getByRole('region', { name: 'Your edition and availability' });
      await expect(availability.getByRole('combobox', { name: 'Language', exact: true })).toHaveText('English');
      await expect(availability.getByRole('combobox', { name: 'Edition', exact: true })).toHaveText('Any edition');
      await expect(other.locator('[data-identity-status]').filter({ hasText: 'Your edition:' })).toHaveCount(0);
      await info.attach(`${media.handle}-second-reader-default`, {
        body: await other.screenshot({ fullPage: true }), contentType: 'image/png',
      });
    }
  } finally {
    await second.close();
  }

  expect(found, 'keyboard focus while choosing and saving each edition').toEqual([]);
});
