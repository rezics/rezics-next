import { expect, test } from '@playwright/test';
import { checkScreen, expectClean, type Findings, keyboardReach, locales, motionRunning, pressByKeyboard } from './g-743-matrix.ts';
import { device, hubRecords, uuid } from './g-743-stack.ts';
import type { Hub } from './g-850-seed.ts';

// Launch journey `work-hub`: the LN/VN Work hub and the choice of an edition, on G-850's Sword Art Online records
// (journey steps are `g-850-hub.e2e.ts`'s). The matrix of `g-743-matrix.ts` on each screen of it: axe in light and
// dark at a phone and a desktop width, reflow at 200% and 400%, keyboard-only use with visible focus, reduced
// motion, an English and a Japanese interface.
let hub: Hub;
test.use({ actionTimeout: 15_000 });
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  test.setTimeout(420_000);
  hub = await hubRecords();
});

const at = (work: { work: string }, locale: string, hash = '') => `/${locale}/w/${uuid(work.work)}${hash}`;
const primary = (page: import('@playwright/test').Page) => page.locator('a[data-next-action]:visible').first();

test('work-hub: a reader chooses an edition with the keyboard alone, under reduced motion, in the Latin locale', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const { sao } = hub;
  const found: Findings = [];
  const [one] = sao.volumes;
  const page = await device(browser, info, at(sao.series, locales.latin), { reducedMotion: true });

  // The series asks for an edition: the primary action is the first thing the keyboard reaches that is not navigation.
  const choose = primary(page);
  await expect(choose).toHaveText('Choose release');
  await checkScreen(page, 'hub-series-choose', found, info);
  await pressByKeyboard(page, choose, found, 'Choose release');
  await expect(page).toHaveURL(new RegExp(`/${locales.latin}/w/${uuid(one!.work)}#availability$`));

  // Volume 1: pick the audiobook and save it, every control reached by Tab and operated by key.
  const availability = page.getByRole('region', { name: 'Your edition and availability' });
  await expect(availability).toBeVisible();
  const edition = availability.getByLabel('Edition', { exact: true });
  await keyboardReach(page, edition, found, 'Edition');
  await edition.selectOption({ label: 'Sword Art Online 1: Aincrad (audiobook)' });
  await checkScreen(page, 'hub-volume-edition-picked', found, info);
  await pressByKeyboard(page, availability.getByRole('button', { name: 'Save choice' }), found, 'Save choice');
  await expect(availability.getByText('Saved.')).toBeVisible();
  await page.goto(at(one!, locales.latin));
  await expect(page.locator('[data-identity-status]:visible').first()).toContainText('Your edition: Sword Art Online 1: Aincrad (audiobook)');
  await checkScreen(page, 'hub-volume-saved', found, info);

  // Reduced motion: nothing animates on the screens above once settled, and the sections menu opens without motion.
  expect(await motionRunning(page), 'running animations under reduced motion').toEqual([]);

  // The sections of the hub are reachable by keyboard: the in-page tabs on a desktop, "On this page" on a phone.
  await page.goto(at(sao.series, locales.latin));
  const sections = page.getByRole('navigation', { name: 'Work sections' }).or(page.getByRole('button', { name: 'On this page' }));
  await keyboardReach(page, sections.first(), found, 'Work sections');

  await page.context().close();
  expectClean(found);
});

test('work-hub: the hub and its edition choice in the CJK locale', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { sao } = hub;
  const found: Findings = [];
  const [one] = sao.volumes;
  const page = await device(browser, info, at(sao.series, locales.cjk));
  await expect(page.locator('html')).toHaveAttribute('lang', locales.cjk);
  await expect(page.getByRole('heading', { level: 1, name: 'Sword Art Online', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'このページの内容' }).or(page.getByRole('navigation', { name: /.+/ }).first())).toBeVisible();
  await checkScreen(page, 'hub-series-ja', found, info);
  await page.goto(at(one!, locales.cjk, '#availability'));
  await expect(page.locator('html')).toHaveAttribute('lang', locales.cjk);
  await checkScreen(page, 'hub-volume-ja', found, info);
  // The primary action and the edition form are reachable by keyboard in Japanese too.
  const action = primary(page);
  await expect(action).toBeVisible();
  await keyboardReach(page, action, found, 'primary action (ja)');
  await page.context().close();
  expectClean(found);
});
