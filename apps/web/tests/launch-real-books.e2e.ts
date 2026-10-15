import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import type { LaunchBooksCorpus } from '../../../scripts/load/launch-corpus-types.ts';
import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { keyboardReach, type Findings } from './g-743-matrix.ts';

interface PreparedBooks {
  corpus: LaunchBooksCorpus;
  restored: false;
}

interface Reader {
  actingSubject: string;
  member: { email: string; password: string };
}

let prepared: PreparedBooks;
let reader: Reader;
const uuid = (iri: string) => iri.slice(-36);

test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(600_000);
  // The QA launcher owns the browser's stack. This preparation writes the real
  // pinned records through its APIs; restored-stack qualification is separate.
  const result = spawnSync('bun', ['scripts/load/launch-corpus.ts', '--browser-prepare'], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 570_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Books browser preparation failed: ${result.stderr || result.error?.message || result.status}`);
  }
  prepared = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as PreparedBooks;
  expect(prepared.corpus.counts).toMatchObject({ works: 1, releases: 6, covers: 0 });
  expect(prepared.restored).toBe(false);
  const credentials = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!credentials) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must identify the isolated QA reader');
  reader = JSON.parse(readFileSync(credentials, 'utf8')) as Reader;
  // The seed's outbox continues moving the public read basis after the last
  // command. Start the reader journey once that shared projection has settled.
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(`http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${uuid(prepared.corpus.work)}`).catch(() => null);
    const position = response?.ok ? JSON.stringify((await response.json() as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for 90 seconds after the books seed');
});

/** Reach the control through tab order, then select through the list's own keyboard navigation. */
async function openChoice(page: Page, control: Locator, findings: Findings): Promise<Locator> {
  await expect(control).toBeVisible();
  await keyboardReach(page, control, findings, await control.getAttribute('aria-label') ?? 'edition chooser');
  await page.keyboard.press('Enter');
  const options = page.getByRole('option');
  await expect(options.first()).toBeVisible();
  await expect(page.getByRole('listbox')).toBeFocused();
  return options;
}

async function chooseOpenOption(page: Page, options: Locator, name: string): Promise<void> {
  const names = (await options.allTextContents()).map(text => text.trim());
  const index = names.indexOf(name);
  expect(index, `a unique option named ${name}`).toBeGreaterThanOrEqual(0);
  expect(names.filter(item => item === name)).toHaveLength(1);
  await page.keyboard.press('Home');
  for (let step = 0; step < index; step++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeHidden();
}

const journeys = [
  { title: 'books / Choose among ambiguous editions of one Work', choices: [
    { source: 'OL51673567M', publisher: 'Dell Publishing Co. Inc.', year: '1960', format: 'paperback' },
    { source: 'OL51047237M', publisher: 'Cambridge University Press', year: '2024', format: null },
  ] },
  { title: 'books / Choose among mixed formats', choices: [
    { source: 'OL24284619M', publisher: 'Penguin USA, Inc.', year: '2009', format: 'E-book' },
    { source: 'OL26394110M', publisher: 'Librivox', year: '2006', format: 'Audiobook' },
  ] },
];

for (const journey of journeys) test(journey.title, async ({ browser }, info) => {
  test.setTimeout(300_000);
  const { corpus } = prepared;
  const workPath = localizedPath(resourceHref('/w/', uuid(corpus.work)), 'en');
  const viewports = [{ width: 390, height: 844 }, { width: 1440, height: 900 }];
  for (const viewport of viewports) {
    const chosen = journey.choices[viewport.width === 390 ? 0 : 1]!;
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL, viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.width < 600, isMobile: viewport.width < 600, reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      // Authentication uses the existing Accounts journey; the Work's edition
      // choice, confirmation and return are all operated through keyboard input.
      await signInAtAccounts(page, workPath, reader.member);
      await expect(page.getByRole('heading', { level: 1, name: 'Pride and Prejudice', exact: true })).toBeVisible();
      const availability = page.getByRole('region', { name: 'Your edition and availability' });
      await expect(availability).toBeVisible();
      const findings: Findings = [];
      const language = availability.getByRole('combobox', { name: 'Language', exact: true });
      const edition = availability.getByRole('combobox', { name: 'Edition', exact: true });
      // The server renders the section before the signed-in reader actions and
      // private preference reads finish. Wait for this feature's client readiness.
      await expect(language).toBeVisible({ timeout: 30_000 });

      // The French pin is offered in its own content language, rather than
      // disappearing because the interface is English.
      await chooseOpenOption(page, await openChoice(page, language, findings), 'French');
      let options = await openChoice(page, edition, findings);
      const translation = options.filter({ hasText: 'Independently Published' });
      await expect(translation).toHaveCount(1);
      await expect(translation).toContainText('Pride and Prejudice');
      await expect(translation).toContainText('French');
      await expect(translation).toContainText('2017');
      await page.keyboard.press('Escape');
      await chooseOpenOption(page, await openChoice(page, language, findings), 'English');

      // Several source records really have the same title. A reader can tell
      // which publisher and year each names, alongside the usable formats.
      options = await openChoice(page, edition, findings);
      const names = (await options.allTextContents()).map(text => text.trim());
      expect(names, 'option names distinguish every offered edition').toHaveLength(new Set(names).size);
      for (const publisher of ['Dell Publishing Co. Inc.', 'Cambridge University Press', 'Penguin USA, Inc.', 'Librivox']) {
        await expect(options.filter({ hasText: publisher })).toHaveCount(1);
      }
      expect(names.join('\n')).toContain('paperback');
      expect(names.join('\n')).toContain('E-book');
      expect(names.join('\n')).toContain('Audiobook');
      const chosenOption = options.filter({ hasText: chosen.publisher });
      await expect(chosenOption).toContainText('Pride and Prejudice');
      await expect(chosenOption).toContainText('English');
      await expect(chosenOption).toContainText(chosen.year);
      if (chosen.format) await expect(chosenOption).toContainText(chosen.format);
      const chosenName = (await chosenOption.textContent())!.trim();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), 'open chooser fits the viewport').toBeLessThanOrEqual(viewport.width);
      await info.attach(`books-chooser-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' });
      await chooseOpenOption(page, options, chosenName);

      const save = availability.getByRole('button', { name: 'Save choice', exact: true });
      await keyboardReach(page, save, findings, 'Save choice');
      await page.keyboard.press('Enter');
      await expect(availability.getByRole('status')).toHaveText('Saved.');
      await page.reload();
      await expect(availability.getByRole('combobox', { name: 'Edition', exact: true })).toContainText(chosen.publisher, { timeout: 30_000 });
      await expect(availability.getByRole('combobox', { name: 'Edition', exact: true })).toContainText(chosen.year);
      if (chosen.format) await expect(availability.getByRole('combobox', { name: 'Edition', exact: true })).toContainText(chosen.format);

      // Titles are deliberately identical. The saved API identity proves the
      // control retained the selected pinned release, rather than its sibling.
      const selected = corpus.editions.find(item => item.externalId === chosen.source)!;
      expect(selected.title).toBe('Pride and Prejudice');
      const response = await page.request.get(`/api/main/v1/me/edition-preferences/${uuid(corpus.work)}?actingSubject=${encodeURIComponent(reader.actingSubject)}`);
      expect(response.status(), await response.text()).toBe(200);
      expect(await response.json()).toMatchObject({ work: corpus.work, language: 'en',
        edition: { kind: 'release', resource: selected.release, revision: selected.revision } });
      expect(await page.evaluate(() => document.documentElement.scrollWidth), 'saved chooser fits the viewport').toBeLessThanOrEqual(viewport.width);
      await info.attach(`books-saved-${viewport.width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      expect(findings, `keyboard focus at ${viewport.width}px`).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
