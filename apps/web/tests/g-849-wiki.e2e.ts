import type { UiLocale } from '../i18n/define.ts';
import { spaceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';
import { axeViolations, formatViolations } from './a11y-axe.ts';

// A franchise wiki Zone for Pride and Prejudice, written once into this isolated QA stack through Main's routes
// (`g-849-seed.ts`): three chapters, three characters revealed at chapters 1 and 3, a reviewed bundle applied by a
// steward. The browser reads it as an anonymous visitor and as the stack's web member, on a phone and a desktop, in
// English and Japanese.
interface Seed {
  realm: string;
  zone: string;
  work: string;
  structure: string;
  chapters: string[];
  entities: Record<'elizabeth' | 'jane' | 'darcy', string>;
  evidence: string[];
}
let seed: Seed;
test.use({ actionTimeout: 15_000 });
const main = (path: string) => `http://127.0.0.1:${process.env.MAIN_PORT}${path}`;
const uuid = (iri: string) => iri.slice(-36);

test.beforeAll(async () => {
  test.setTimeout(420_000);
  // Playwright starts a new worker after a failed test and runs this again; the records are written once per stack.
  const cache = `.temp/g849-seed-${process.env.REZICS_QA_RUN_ID}.json`;
  if (existsSync(cache)) seed = JSON.parse(readFileSync(cache, 'utf8')) as Seed;
  else {
    const result = spawnSync('bun', ['apps/web/tests/g-849-seed.ts'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 360_000,
    });
    if (result.status !== 0 || result.error) {
      throw new Error(
        `G-849 seed failed: ${result.stderr || result.error?.message || result.status}`,
      );
    }
    seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
    mkdirSync('.temp', { recursive: true });
    writeFileSync(cache, JSON.stringify(seed));
  }
  // Main keeps processing the seed's events for a while, moving the graph under every read (409).
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main(`/v1/works/${uuid(seed.work)}`)).catch(() => null);
    const position = response?.ok
      ? JSON.stringify(((await response.json()) as { sourcePosition: unknown }).sourcePosition)
      : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for two minutes after the seed');
  // The Zone is read through its route segment, and its package runs only once Main reports it approved.
  let state = '';
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && state !== 'package';) {
    const zone = await fetch(main('/v1/addresses/resolve?scope=space&key=franchise-wiki')).catch(
      () => null,
    );
    const id = zone?.ok
      ? ((await zone.json()) as { capabilities: { zone?: string } }).capabilities.zone?.slice(-36)
      : null;
    const presentation = id
      ? await fetch(main(`/v1/zones/${id}/presentation`)).catch(() => null)
      : null;
    state = presentation?.ok
      ? ((await presentation.json()) as { execution: { state: string } }).execution.state
      : '';
    if (state !== 'package') await new Promise((done) => setTimeout(done, 1000));
  }
  if (state !== 'package')
    throw new Error('The franchise wiki Zone never reported its package approved');
  // The Realm's public header comes from a projection that can trail the Zone.
  let found = false;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && !found;) {
    const header = await fetch(main(`/v1/realms/${uuid(seed.realm)}`)).catch(() => null);
    found = Boolean(header?.ok);
    if (!found) await new Promise((done) => setTimeout(done, 1000));
  }
  if (!found) throw new Error('The Realm never became readable');
});

const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;
const locales = ['en', 'ja'] as const;
const words = {
  en: {
    upTo: 'Up to:',
    start: 'start of the story',
    progress: 'your progress',
    characters: 'Main characters',
    everything: 'Show everything',
    elizabeth: 'Elizabeth Bennet',
    jane: 'Jane Bennet',
    darcy: 'Fitzwilliam Darcy',
    revealed: 'Revealed in this chapter',
    notFound: 'This page isn’t here',
    sister: 'Sister',
    acquaintance: 'Acquaintance',
    passages: 'Passages and sources',
    alias: 'Lizzy',
    edition: 'text/plain edition',
    beyond: 'beyond your reading position',
  },
  ja: {
    upTo: 'ここまで:',
    start: '物語の始まり',
    progress: 'あなたの進行状況',
    characters: '主要人物',
    everything: 'すべて表示',
    elizabeth: 'エリザベス・ベネット',
    jane: 'ジェーン・ベネット',
    darcy: 'Fitzwilliam Darcy',
    revealed: 'この章で明かされること',
    notFound: 'このページは見つかりません',
    sister: '姉妹',
    acquaintance: '知人',
    passages: '引用と出典',
    alias: 'Lizzy',
    edition: 'text/plain 版',
    beyond: '現在の読み進めた位置より先',
  },
} as const;

function credentials() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path)
    throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return JSON.parse(readFileSync(path, 'utf8')) as {
    actingSubject: string;
    member: { email: string; password: string };
  };
}

const overflows = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

async function check(page: Page, info: TestInfo, name: string) {
  expect(await overflows(page), `${name} overflows`).toBe(false);
  const violations = await axeViolations(page);
  expect(violations, formatViolations(violations)).toEqual([]);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  // Passing tests keep no output; the screenshots are reviewed from here.
  await page.screenshot({ path: `.temp/g849-shots/${name}.png`, fullPage: true });
}

/** The page and its scripts have loaded; the Zone's own markup is server-rendered, so assertions wait on it directly. */
const ready = (page: Page) => page.waitForLoadState('load');
const section = (page: Page, segment: string) => page.locator(`[data-wiki-section="${segment}"]`);
const count = (page: Page, segment: string) => section(page, segment).locator('[data-wiki-count]');
const site = (locale: UiLocale, path = '') =>
  localizedPath(`${spaceHref('franchise-wiki', 'site')}${path}`, locale);

for (const viewport of viewports) {
  for (const locale of locales) {
    const w = words[locale];
    test(`anonymous ${locale} ${viewport.name}: only chapter 1 is revealed, and a later character is not here`, async ({
      page,
    }, info) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await page.goto(site(locale));
      await ready(page);
      // The visitor has finished no chapter, so the story starts at its first.
      const bar = page.getByRole('region', {
        name: locale === 'en' ? 'Reading position' : '読み進めた位置',
      });
      await expect(bar.locator('[data-position-current]')).toContainText(`${w.upTo} Chapter 1`);
      await expect(bar.locator('[data-position-note]')).toHaveText(w.start);
      await expect(
        section(page, 'characters').getByRole('heading', { name: new RegExp(w.characters) }),
      ).toBeVisible();
      await expect(count(page, 'characters')).toHaveAttribute('data-wiki-count', '2');
      await expect(
        section(page, 'characters').getByRole('link', { name: new RegExp(w.elizabeth) }),
      ).toBeVisible();
      await expect(
        section(page, 'characters').getByRole('link', { name: new RegExp(w.jane) }),
      ).toBeVisible();
      await expect(page.getByText(w.darcy)).toHaveCount(0);
      await check(page, info, `home-${locale}-${viewport.name}`);

      // The list agrees with the home, and the later character's own address is the Zone's not-found page.
      await page.goto(site(locale, '/characters'));
      await ready(page);
      await expect(page.locator('[data-wiki-index="characters"] li')).toHaveCount(2);
      // The Zone answers as it does for any address it has no page for; the page is not a stub of the character.
      await page.goto(site(locale, `/characters/${uuid(seed.entities.darcy)}`));
      await expect(page.getByRole('heading', { level: 1, name: w.notFound })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(w.darcy)).toHaveCount(0);
      await check(page, info, `hidden-${locale}-${viewport.name}`);

      // A chapter beyond the visitor's position lists nothing it reveals.
      await page.goto(site(locale, `/chapters/${uuid(seed.chapters[2]!)}`));
      await ready(page);
      await expect(page.locator('[data-wiki-unreached]')).toContainText(w.beyond);
      await expect(page.locator('[data-wiki-reveals]')).toHaveCount(0);
      await check(page, info, `chapter-ahead-${locale}-${viewport.name}`);
    });
  }
}

test('anonymous: Show everything reveals the rest, and the choice stays in the address', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await page.setViewportSize(viewports[1]);
  await page.goto(site('en'));
  await ready(page);
  await expect(count(page, 'characters')).toHaveAttribute('data-wiki-count', '2');
  await page.locator('[data-position-bar] [data-position-everything]').click();
  await expect(page).toHaveURL(/\?position=all$/);
  await expect(count(page, 'characters')).toHaveAttribute('data-wiki-count', '3');
  await expect(
    section(page, 'characters').getByRole('link', { name: /Fitzwilliam Darcy/ }),
  ).toBeVisible();
  await expect(page.locator('[data-position-current]')).toHaveText('Showing everything');
  // The list keeps the choice; the later character is a page now.
  await page.goto(site('en', '/characters?position=all'));
  await ready(page);
  await expect(page.locator('[data-wiki-index="characters"] li')).toHaveCount(3);
  await page.getByRole('link', { name: /Fitzwilliam Darcy/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Fitzwilliam Darcy' })).toBeVisible();
  expect(page.url()).toContain('position=all');
  await check(page, info, 'everything-darcy');
});

test('the position control works by keyboard and leads to a chapter', async ({ page }, info) => {
  test.setTimeout(240_000);
  await page.setViewportSize(viewports[0]);
  await page.goto(site('en'));
  await ready(page);
  const button = page.getByRole('button', { name: /^Up to:/ });
  await expect(button).toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });
  await button.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link')).toHaveText([
    /Your own progress/,
    'Chapter 1',
    'Chapter 2',
    'Chapter 3',
    /Show everything/,
  ]);
  await check(page, info, 'position-sheet');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await button.click();
  await dialog.getByRole('link', { name: 'Chapter 2' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\?position=[0-9a-f-]{36}$/);
  await expect(page.locator('[data-position-current]')).toContainText('Up to: Chapter 2');
  await expect(page.locator('[data-position-note]')).toHaveText('your choice');
  // Chapter 2 adds an alias to Elizabeth, no new page: the count is still two.
  await expect(count(page, 'characters')).toHaveAttribute('data-wiki-count', '2');
});

for (const viewport of viewports) {
  for (const locale of locales) {
    const w = words[locale];
    test(`the reader ${locale} ${viewport.name}: finishing chapter 3 reveals more, and a character page is a wiki page`, async ({
      page,
    }, info) => {
      test.setTimeout(300_000);
      await page.setViewportSize(viewport);
      const { actingSubject, member } = credentials();
      // The Accounts sign-in page is read in English; the Zone is read in `locale` once signed in.
      await signInAtAccounts(page, site('en'), member);
      await page.goto(site(locale));
      await ready(page);
      // Before any chapter is finished the reader starts at the first.
      if (viewport.name === 'phone' && locale === 'en') {
        await expect(count(page, 'characters')).toHaveAttribute('data-wiki-count', '2');
        const written = await page.request.put(
          `/api/main/v1/compositions/${uuid(seed.structure)}/occurrences/${uuid(seed.chapters[2]!)}/progress`,
          {
            headers: { 'idempotency-key': crypto.randomUUID() },
            data: { actingSubject, expectedVersion: 0, completed: true, position: null },
          },
        );
        expect(written.status(), await written.text()).toBe(200);
      }
      await page.goto(site(locale));
      await ready(page);
      await expect(page.locator('[data-position-current]')).toContainText(`${w.upTo} Chapter 3`);
      await expect(page.locator('[data-position-note]')).toHaveText(w.progress);
      await expect(count(page, 'characters')).toHaveAttribute('data-wiki-count', '3');
      await expect(
        section(page, 'characters').getByRole('link', { name: new RegExp(w.darcy) }),
      ).toBeVisible();
      await check(page, info, `reader-home-${locale}-${viewport.name}`);

      // A character page: names and aliases by language, relationships as rows, a passage with its source.
      await page.goto(site(locale, `/characters/${uuid(seed.entities.elizabeth)}`));
      await ready(page);
      await expect(page.getByRole('heading', { level: 1, name: w.elizabeth })).toBeVisible();
      const aliases = page.locator('[data-wiki-aliases]');
      await expect(aliases).toContainText(w.alias);
      await expect(aliases).toContainText(
        locale === 'en' ? 'エリザベス・ベネット' : 'Elizabeth Bennet',
      );
      const rows = page.locator('[data-wiki-relationships]');
      await expect(rows.getByText(w.sister, { exact: true })).toBeVisible();
      await expect(rows.getByRole('link', { name: w.jane })).toBeVisible();
      await expect(rows.getByText(w.acquaintance, { exact: true })).toBeVisible();
      await expect(rows.getByRole('link', { name: w.darcy })).toBeVisible();
      const passages = page.locator('[data-wiki-passages]');
      await expect(passages.getByRole('heading', { name: w.passages })).toBeVisible();
      // Sources are not ordered: verify the citation belonging to this quotation.
      const sisterEvidence = passages
        .locator('[data-wiki-evidence]')
        .filter({ hasText: 'Elizabeth and Jane were sisters' });
      await expect(sisterEvidence).toHaveCount(1);
      await expect(sisterEvidence.locator('blockquote')).toContainText(
        'Elizabeth and Jane were sisters',
      );
      await expect(sisterEvidence).toContainText(w.edition);
      await expect(sisterEvidence).toContainText('Holder extraction agent');
      await check(page, info, `reader-character-${locale}-${viewport.name}`);

      // A chapter page lists what it reveals, and its neighbours.
      await page.goto(site(locale, `/chapters/${uuid(seed.chapters[2]!)}`));
      await ready(page);
      await expect(page.locator('[data-wiki-reveals]')).toContainText(w.darcy);
      await expect(page.getByRole('link', { name: /Chapter 2/ }).first()).toBeVisible();
      await check(page, info, `reader-chapter-${locale}-${viewport.name}`);
      await page.goto(site(locale, `/chapters/${uuid(seed.chapters[0]!)}`));
      await ready(page);
      await expect(page.locator('[data-wiki-reveals]')).toContainText(w.elizabeth);
      await expect(page.locator('[data-wiki-reveals]')).toContainText(w.jane);
    });
  }
}
