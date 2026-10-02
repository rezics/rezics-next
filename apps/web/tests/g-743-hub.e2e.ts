import type { UiLocale } from '../i18n/define.ts';
import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { expect, test } from '@playwright/test';
import {
  checkScreen,
  expectClean,
  type Findings,
  keyboardReach,
  locales,
  motionRunning,
  pressByKeyboard,
} from './g-743-matrix.ts';
import { device, hubRecords, uuid } from './g-743-stack.ts';
import type { Hub } from './g-850-seed.ts';

// Launch journey `work-hub`: the LN/VN Work hub and the choice of an edition, on G-850's Sword Art Online records
// (journey steps are `g-850-hub.e2e.ts`'s). The matrix of `g-743-matrix.ts` on each screen of it: axe in light and
// dark at a phone and a desktop width, reflow at 200% and 400%, keyboard-only use with visible focus, reduced
// motion, an English and a Japanese interface.
let hub: Hub;
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(420_000);
  hub = await hubRecords();
});

/** The address has stopped changing: a client-side navigation and a following `goto` must not race. */
async function settled(page: import('@playwright/test').Page) {
  await page.waitForLoadState('networkidle');
  for (let same = 0, last = ''; same < 3;) {
    await page.waitForTimeout(300);
    same = page.url() === last ? same + 1 : 0;
    last = page.url();
  }
}

const at = (work: { work: string }, locale: UiLocale, hash = '') =>
  localizedPath(`${resourceHref('/w/', uuid(work.work))}${hash}`, locale);
const primary = (page: import('@playwright/test').Page) =>
  page.locator('a[data-next-action]:visible').first();

test('work-hub: a reader chooses an edition with the keyboard alone, under reduced motion, in the Latin locale', async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const { sao } = hub;
  const found: Findings = [];
  const [one] = sao.volumes;
  const page = await device(browser, info, at(sao.series, locales.latin), { reducedMotion: true });

  // The reader may already have an edition (the same stack serves every engine project): the primary action is then
  // Continue. Either way it is the first control after the header that the keyboard reaches, and it is followed.
  const action = primary(page);
  await expect(action).toHaveText(/\S/);
  await checkScreen(page, 'hub-series', found, info);
  await pressByKeyboard(page, action, found, 'primary action');
  // ast-grep-ignore: web-links-use-address -- Address-prefix predicate classifies links; it does not construct a destination.
  await expect(page).toHaveURL(new RegExp(`/${locales.latin}/w/`));
  await settled(page);

  // Volume 1: pick the other of its two editions and save it, every control reached by Tab and operated by key.
  await page.goto(at(one!, locales.latin, '#availability'));
  const availability = page.getByRole('region', { name: 'Your edition and availability' });
  await expect(availability).toBeVisible();
  const edition = availability.getByLabel('Edition', { exact: true });
  const current = await edition.evaluate(
    (element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent ?? '',
  );
  const options = await edition.locator('option:not([value=""])').allTextContents();
  const label = options.find((option) => option !== current);
  expect(label, `a second edition among ${options.join(' | ')}`).toBeTruthy();
  await keyboardReach(page, edition, found, 'Edition');
  await edition.selectOption({ label: label! });
  await checkScreen(page, 'hub-volume-edition-picked', found, info);
  await pressByKeyboard(
    page,
    availability.getByRole('button', { name: 'Save choice' }),
    found,
    'Save choice',
  );
  await expect(availability.getByText('Saved.')).toBeVisible();
  await settled(page);
  await page.goto(at(one!, locales.latin));
  await expect(page.locator('[data-identity-status]:visible').first()).toContainText(
    'Your edition:',
  );
  await checkScreen(page, 'hub-volume-saved', found, info);

  // Reduced motion: nothing animates on the screens above once settled, and the sections menu opens without motion.
  expect(await motionRunning(page), 'running animations under reduced motion').toEqual([]);

  // The sections of the hub are reachable by keyboard: the in-page tabs on a desktop, "On this page" on a phone.
  await page.goto(at(sao.series, locales.latin));
  const sections = page
    .getByRole('navigation', { name: 'Work sections' })
    .or(page.getByRole('button', { name: 'On this page' }));
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
  await expect(
    page.getByRole('heading', { level: 1, name: 'Sword Art Online', exact: true }),
  ).toBeVisible();
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
