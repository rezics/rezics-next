import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, expect as playwrightExpect, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import type { PartlessWork } from './partless-progress-seed.ts';

// A visual novel with no parts is marked playing, then completed, on one phone, and the other phone
// shows the same mark. The seed writes the Work through Main before Playwright starts.

const expect = playwrightExpect.configure({ timeout: 20_000 });
const phone = { width: 390, height: 844 };
test.use({ actionTimeout: 15_000 });

const seeded = (): PartlessWork => JSON.parse(readFileSync(
  resolve('.temp/partless-progress', process.env.REZICS_QA_RUN_ID!, 'seed.json'), 'utf8')) as PartlessWork;

const uuid = (iri: string) => iri.slice(-36);
const home = (work: string) => localizedPath(resourceHref('/w/', uuid(work)), 'en');
const at = (work: string) => `${home(work)}/connections`;

function member() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return (JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } }).member;
}

async function settle(work: string) {
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${uuid(work)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok ? JSON.stringify(((await response.json()) as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for 120 seconds after the seed');
}

async function device(browser: Browser, info: TestInfo, work: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: phone, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await signInAtAccounts(page, home(work), member());
  await page.goto(at(work));
  return page;
}

const panel = (page: Page) => page.locator('[data-work-progress]');

async function loaded(page: Page) {
  await expect(async () => {
    if (await page.getByText('Your progress could not be loaded.').count()) await page.reload();
    await expect(panel(page)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

async function press(button: Locator, answer: Locator) {
  await expect(async () => {
    if (await button.count()) await button.click();
    await expect(answer).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
}

test('a visual novel with no parts is marked on one phone and seen on the other', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const work = seeded();
  await settle(work.work);
  const a = await device(browser, info, work.work);
  const b = await device(browser, info, work.work);
  await loaded(a);
  await expect(panel(a).getByText('Not started')).toBeVisible();
  await expect(panel(a)).toHaveAttribute('data-verb', 'play');
  await press(panel(a).getByRole('button', { name: 'Mark playing' }), panel(a).getByText('Playing'));
  await expect(panel(a)).toHaveAttribute('data-play-state', 'playing');

  await b.reload();
  await loaded(b);
  await expect(panel(b).getByText('Playing')).toBeVisible();

  await press(panel(a).getByRole('button', { name: 'Mark completed' }), panel(a).getByText('Completed', { exact: true }));
  await expect(panel(a)).toHaveAttribute('data-play-state', 'completed');
  await b.reload();
  await loaded(b);
  await expect(panel(b).getByText('Completed', { exact: true })).toBeVisible();
  expect(await b.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'phone overflows').toBe(false);
  const shot = info.outputPath('partless-phone.png');
  await panel(b).screenshot({ path: shot });
  console.log(`partless progress screenshot: ${shot}`);

  await press(panel(a).getByRole('button', { name: 'Mark not started' }), panel(a).getByText('Not started'));
  await b.reload();
  await loaded(b);
  await expect(panel(b).getByText('Not started')).toBeVisible();
});
