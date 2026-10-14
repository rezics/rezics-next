import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect as baseExpect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { localizedPath } from '../../i18n/locale.ts';
import { realmWorkHref, siteHref } from '../../features/realm/route.ts';
import { parseAddressSegment } from '../../features/address/path.ts';
import { credentials } from '../g-743-stack.ts';
import { signInAtAccounts } from '../account-sign-in.ts';
import { expectClean, type Findings, keyboardReach, pressByKeyboard } from '../g-743-matrix.ts';
import type { GamesCatalogue } from '../games-seed.ts';

const expect = baseExpect.configure({ timeout: 30_000 });
export function registerGamesJourneys() {
  let games: GamesCatalogue;
  test.use({ reducedMotion: 'reduce', actionTimeout: 30_000 });
  test.beforeAll(() => {
    const run = process.env.REZICS_QA_RUN_ID;
    if (!run) throw new Error('Run Games journeys through isolated browser QA');
    games = JSON.parse(readFileSync(resolve('.temp/games-journeys', run, 'seed.json'), 'utf8')) as GamesCatalogue;
    expect(games.works).toHaveLength(3);
    expect(games.releases).toHaveLength(2);
  });

  const copy = {
    en: { region: 'Your edition and availability', language: 'Language', english: 'English',
      edition: 'Edition', save: 'Save choice', saved: 'Saved.', search: 'Search Games', retry: 'Try again', error: 'Something went wrong' },
    ja: { region: 'あなたの版と入手状況', language: '言語', english: '英語',
      edition: '版', save: '選択を保存', saved: '保存しました。', search: 'Gamesを検索', retry: 'もう一度試す', error: '問題が発生しました' },
  } as const;

  async function choose(page: Page, control: Locator, name: string, found: Findings, retry?: Locator): Promise<string> {
    const options = page.getByRole('listbox').getByRole('option');
    for (let attempt = 0; ; attempt++) {
      await pressByKeyboard(page, control, found, name);
      await expect(options.first()).toBeVisible();
      const wanted = options.filter({ hasText: name });
      await expect(retry ? wanted.or(retry.filter({ visible: true })).first() : wanted).toBeVisible();
      if (await wanted.count() === 1 || !retry || attempt >= 2) break;
      await control.press('Escape');
      await pressByKeyboard(page, retry, found, 'retry edition read');
    }
    await expect(options.filter({ hasText: name })).toHaveCount(1);
    const names = (await options.allTextContents()).map(text => text.trim());
    const matches = names.filter(text => text === name || text.startsWith(`${name} · `));
    expect(matches, `one offered choice for ${name}`).toHaveLength(1);
    const selected = matches[0]!;
    await page.keyboard.press('Home');
    for (let index = 0; index < names.indexOf(selected); index++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    if (await page.getByRole('listbox').isVisible()) await control.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect(control).toHaveText(selected);
    return selected;
  }

  async function capture(page: Page, info: TestInfo, name: string) {
    const path = resolve('.temp/games-journeys', process.env.REZICS_QA_RUN_ID!, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await info.attach(name, { path, contentType: 'image/png' });
  }

  for (const locale of ['en', 'ja'] as const) {
    test(`games-hub: ${locale} player chooses a named platform edition by keyboard and keeps it after reload`, async (
      { page }, info,
    ) => {
      test.setTimeout(240_000);
      const found: Findings = [];
      const work = games.works[0]!;
      const words = copy[locale];
      await signInAtAccounts(page, '/en', credentials().member);
      await page.goto(localizedPath(realmWorkHref(games.handle, work.work), locale));
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1, name: work.title, exact: true })).toBeVisible();
      const availability = page.getByRole('region', { name: words.region, exact: true });
      await expect(availability).toBeVisible();
      const language = availability.getByRole('combobox', { name: words.language, exact: true });
      let recoveries = 0;
      await expect(async () => {
        if (await language.isVisible()) return;
        if (recoveries < 3 && await page.getByRole('heading', { name: words.error, exact: true }).isVisible()) {
          recoveries++;
          await pressByKeyboard(page, page.getByRole('button', { name: words.retry, exact: true }), found, 'retry Work page');
        } else if (recoveries < 3 && await availability.getByRole('alert').isVisible()) {
          recoveries++;
          await page.reload();
        }
        await expect(language).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000, intervals: [1_000] });
      if ((await language.textContent())?.trim() !== words.english) {
        await choose(page, language, words.english, found);
      }
      const edition = availability.getByRole('combobox', { name: words.edition, exact: true });
      const current = (await edition.textContent())?.trim() ?? '';
      const release = games.releases.find(item => !current.startsWith(item.title))!;
      const selected = await choose(page, edition, release.title, found,
        availability.getByRole('button', { name: words.retry, exact: true }));
      expect(selected).toContain(release.platform);
      const failedRequests: string[] = [];
      page.on('requestfailed', request => failedRequests.push(
        `${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
      await keyboardReach(page, availability.getByRole('button', { name: words.save, exact: true }), found, words.save);
      const write = page.waitForResponse(response => response.request().method() === 'PUT'
        && new URL(response.url()).pathname.endsWith(`/edition-preferences/${work.work.slice(-36)}`));
      await page.keyboard.press('Enter');
      const response = await write.catch(async error => {
        await info.attach('failed-edition-requests', { body: failedRequests.join('\n'), contentType: 'text/plain' });
        throw error;
      });
      await info.attach('edition-save-request', {
        body: JSON.stringify({ method: 'PUT', path: new URL(response.url()).pathname,
          request: response.request().postDataJSON(), status: response.status(), response: await response.text() }),
        contentType: 'application/json',
      });
      expect(response.status()).toBe(200);
      await expect(availability.getByRole('status')).toHaveText(words.saved);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(edition).toHaveText(selected);
      await expect(language).toHaveText(words.english);
      await capture(page, info, `${locale}-saved-game-edition`);
      expectClean(found);
    });

    test(`games-catalogue: ${locale} visitor browses and searches the Games Zone by keyboard and returns after reload`, async (
      { page }, info,
    ) => {
      test.setTimeout(180_000);
      const found: Findings = [];
      const words = copy[locale];
      await page.goto(siteHref(locale, games.handle, ['browse']));
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const cards = page.locator('main h3 a');
      await expect(cards).toHaveCount(games.works.length);
      expect((await cards.allTextContents()).map(text => text.trim()).sort())
        .toEqual(games.works.map(work => work.title).sort());
      const search = page.getByRole('searchbox', { name: words.search, exact: true });
      await keyboardReach(page, search, found, words.search);
      await page.keyboard.type('Starfall');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(url => url.searchParams.get('q') === 'Starfall');
      await expect(cards).toHaveCount(2);
      const matches = games.works.filter(work => work.title.startsWith('Starfall'));
      const expected = matches.map(work => work.title).sort();
      expect((await cards.allTextContents()).map(text => text.trim()).sort()).toEqual(expected);
      await page.reload();
      await expect(search).toHaveValue('Starfall');
      await expect(cards).toHaveCount(2);
      expect((await cards.allTextContents()).map(text => text.trim()).sort()).toEqual(expected);
      const result = cards.filter({ hasText: matches[0]!.title });
      await pressByKeyboard(page, result, found, matches[0]!.title);
      const workPath = localizedPath(realmWorkHref(games.handle, matches[0]!.work), locale);
      await expect(page).toHaveURL(url => {
        const split = url.pathname.lastIndexOf('/');
        const address = parseAddressSegment(url.pathname.slice(split + 1));
        return url.pathname.slice(0, split) === workPath.slice(0, workPath.lastIndexOf('/'))
          && address?.kind !== 'alias' && address?.id === matches[0]!.work.slice(-36);
      });
      await expect(page.getByRole('heading', { level: 1, name: matches[0]!.title, exact: true })).toBeVisible();
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1, name: matches[0]!.title, exact: true })).toBeVisible();
      await capture(page, info, `${locale}-game-search-result`);
      expectClean(found);
    });
  }

}
