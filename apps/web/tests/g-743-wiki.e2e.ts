import { expect, test } from '@playwright/test';
import { checkScreen, expectClean, type Findings, keyboardReach, locales, motionRunning, pressByKeyboard } from './g-743-matrix.ts';
import { uuid, visitor, wikiRecords, type WikiRecords } from './g-743-stack.ts';

// Launch journey `franchise-wiki`: the franchise wiki Zone for Pride and Prejudice, read inside the spoiler position
// (G-849's records and steps, `g-849-wiki.e2e.ts`). A visitor with no account starts at chapter 1: a later
// character is not on the page and its own address is the Zone's not-found page. The matrix of `g-743-matrix.ts`
// on each screen, the position control by keyboard alone under reduced motion, and the same in Japanese.
let seed: WikiRecords;
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(480_000);
  seed = await wikiRecords();
});

const site = (locale: string, path = '') => `/${locale}/r/franchise-wiki${path}`;
const section = (page: import('@playwright/test').Page, segment: string) => page.locator(`[data-wiki-section="${segment}"]`);

test('franchise-wiki: the spoiler position is set by keyboard alone under reduced motion, in the Latin locale', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const found: Findings = [];
  const page = await visitor(browser, info, { reducedMotion: true });
  await page.goto(site(locales.latin));
  await page.waitForLoadState('load');
  const bar = page.getByRole('region', { name: 'Reading position' });
  await expect(bar.locator('[data-position-current]')).toContainText('Up to: Chapter 1');
  await expect(section(page, 'characters').locator('[data-wiki-count]')).toHaveAttribute('data-wiki-count', '2');
  await expect(page.getByText('Fitzwilliam Darcy')).toHaveCount(0);
  await checkScreen(page, 'wiki-home', found, info);

  // The position control opens from the keyboard, keeps focus inside, and Escape returns focus to it.
  const button = page.getByRole('button', { name: /^Up to:/ });
  await expect(button).toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });
  await pressByKeyboard(page, button, found, 'Reading position');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await checkScreen(page, 'wiki-position-sheet', found, info);
  for (let stop = 0; stop < 8; stop += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement)), 'focus stays in the position sheet').toBe(true);
  }
  expect(await motionRunning(page), 'running animations under reduced motion').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();

  // Chapter 2 by keyboard: the address carries the choice.
  await pressByKeyboard(page, button, found, 'Reading position');
  await pressByKeyboard(page, dialog.getByRole('link', { name: 'Chapter 2' }), found, 'Chapter 2');
  await expect(page).toHaveURL(/\?position=[0-9a-f-]{36}$/);
  await expect(page.locator('[data-position-current]')).toContainText('Up to: Chapter 2');
  await checkScreen(page, 'wiki-home-chapter-2', found, info);

  // The list, the hidden character's address and a chapter beyond the position, all inside the position.
  await page.goto(site(locales.latin, '/characters'));
  await expect(page.locator('[data-wiki-index="characters"] li')).toHaveCount(2);
  await checkScreen(page, 'wiki-characters', found, info);
  await page.goto(site(locales.latin, `/characters/${uuid(seed.entities.darcy)}`));
  await expect(page.getByRole('heading', { level: 1, name: 'This page isn’t here' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Fitzwilliam Darcy')).toHaveCount(0);
  await checkScreen(page, 'wiki-hidden-character', found, info);
  await page.goto(site(locales.latin, `/chapters/${uuid(seed.chapters[2]!)}`));
  await expect(page.locator('[data-wiki-unreached]')).toContainText('beyond your reading position');
  await checkScreen(page, 'wiki-chapter-ahead', found, info);

  // Show everything is a link the keyboard reaches; what it reveals is a page like any other.
  await page.goto(site(locales.latin));
  const everything = page.locator('[data-position-bar] [data-position-everything]');
  await pressByKeyboard(page, everything, found, 'Show everything');
  await expect(page).toHaveURL(/\?position=all$/);
  await expect(section(page, 'characters').getByRole('link', { name: /Fitzwilliam Darcy/ })).toBeVisible();
  await checkScreen(page, 'wiki-everything', found, info);
  await page.goto(site(locales.latin, `/characters/${uuid(seed.entities.elizabeth)}?position=all`));
  await expect(page.getByRole('heading', { level: 1, name: 'Elizabeth Bennet' })).toBeVisible();
  await checkScreen(page, 'wiki-character', found, info);
  await keyboardReach(page, page.locator('[data-wiki-relationships]').getByRole('link', { name: 'Fitzwilliam Darcy' }), found, 'relationship link');

  await page.context().close();
  expectClean(found);
});

test('franchise-wiki: the Zone inside the spoiler position in the CJK locale', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const found: Findings = [];
  const page = await visitor(browser, info);
  await page.goto(site(locales.cjk));
  await page.waitForLoadState('load');
  await expect(page.locator('html')).toHaveAttribute('lang', locales.cjk);
  const bar = page.getByRole('region', { name: '読み進めた位置' });
  await expect(bar.locator('[data-position-current]')).toContainText('ここまで: Chapter 1');
  await expect(section(page, 'characters').getByRole('link', { name: /エリザベス・ベネット/ })).toBeVisible();
  await expect(page.getByText('Fitzwilliam Darcy')).toHaveCount(0);
  await checkScreen(page, 'wiki-home-ja', found, info);
  await keyboardReach(page, page.getByRole('button', { name: /^ここまで:/ }), found, 'reading position (ja)');
  await page.goto(site(locales.cjk, `/characters/${uuid(seed.entities.darcy)}`));
  await expect(page.getByRole('heading', { level: 1, name: 'このページは見つかりません' })).toBeVisible({ timeout: 30_000 });
  await checkScreen(page, 'wiki-hidden-character-ja', found, info);
  await page.goto(site(locales.cjk, `/chapters/${uuid(seed.chapters[2]!)}`));
  await expect(page.locator('[data-wiki-unreached]')).toContainText('現在の読み進めた位置より先');
  await checkScreen(page, 'wiki-chapter-ahead-ja', found, info);
  await page.goto(site(locales.cjk, `/characters/${uuid(seed.entities.elizabeth)}?position=all`));
  await expect(page.getByRole('heading', { level: 1, name: 'エリザベス・ベネット' })).toBeVisible();
  await checkScreen(page, 'wiki-character-ja', found, info);
  await page.context().close();
  expectClean(found);
});
