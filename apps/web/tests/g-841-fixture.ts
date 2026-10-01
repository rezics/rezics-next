import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test as base, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Seeded } from './g-841-catalogue.ts';

export type { Seeded };

/**
 * The G-840 fixtures, written once per QA run: the first file to ask seeds the stack (about two minutes) and
 * keeps the answer next to the run's scratch directory; the other files of the run read it.
 */
export function seeded(): Seeded {
  const run = process.env.REZICS_QA_RUN_ID;
  if (!run) throw new Error('REZICS_QA_RUN_ID must name the isolated QA run');
  const directory = resolve('.temp', `g841-${run}`);
  const file = resolve(directory, 'seed.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Seeded;
  const result = spawnSync('bun', ['apps/web/tests/g-841-seed.ts'], { cwd: process.cwd(), env: process.env,
    encoding: 'utf8', timeout: 480_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`G-841 seed failed: ${result.stderr || result.error?.message || result.status}`);
  }
  const catalogue = result.stdout.trim().split('\n').at(-1)!;
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, catalogue);
  return JSON.parse(catalogue) as Seeded;
}

export const uuid = (iri: string) => iri.slice(-36);
export const phone = { width: 390, height: 844 };
export const desktop = { width: 1280, height: 860 };

/** The two interface languages every query is read in; the second is the one the brief leaves a choice of. */
export const locales = ['en', 'zh-Hant'] as const;
export type Locale = (typeof locales)[number];

export function member() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return (JSON.parse(readFileSync(path, 'utf8')) as { actingSubject: string; member: { email: string; password: string } });
}

export const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

/**
 * Every query is read at both widths in both languages. `check` is the assertion that holds in all of them
 * (the page against Main's answer); the page must not overflow, and a screenshot is kept for review.
 */
export async function acrossViews(page: Page, info: TestInfo, name: string, path: (locale: Locale) => string,
  ready: string, check: (locale: Locale, width: 'phone' | 'desktop') => Promise<void>) {
  for (const locale of locales) {
    for (const [width, viewport] of [['phone', phone], ['desktop', desktop]] as const) {
      await page.setViewportSize(viewport);
      await page.goto(path(locale));
      await expect(page.locator(ready).first(), `${name} ${locale} ${width}`).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await check(locale, width);
      expect(await overflows(page), `${name} ${locale} ${width} overflows`).toBe(false);
      await page.screenshot({ path: info.outputPath(`${name}-${locale}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize(desktop);
}

/**
 * The sign-in journey of `account-sign-in.ts`, bounded and retried: on a loaded host the Accounts site is
 * sometimes slow to answer. The Accounts origin is whatever the web app redirects to.
 */
export async function signIn(page: Page, next: string): Promise<void> {
  const { member: credentials } = member();
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`/auth/start?next=${encodeURIComponent(next)}`);
      await page.waitForURL(url => url.pathname === '/sign-in', { timeout: 40_000 });
      await page.locator('html[data-hydrated]').waitFor({ timeout: 40_000 });
      await page.getByRole('textbox', { name: 'Email' }).fill(credentials.email);
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByLabel('Enter your password').fill(credentials.password);
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page).toHaveURL(next, { timeout: 40_000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

/** A device: its own browser context, signed in as the web member, at the first page it is asked for. */
export async function device(browser: Browser, info: TestInfo, viewport: { width: number; height: number },
  first: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport, hasTouch: viewport.width < 600,
    isMobile: viewport.width < 600 });
  const page = await context.newPage();
  await signIn(page, first);
  return page;
}

/** The Work or release UUIDs a set of links point at, in page order. */
export const linked = (links: Locator, segment = 'w') => links.evaluateAll((elements, name) => elements.map(element =>
  new RegExp(`/${name}/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`).exec(element.getAttribute('href') ?? '')?.[1] ?? ''),
segment);

/** The Work UUID each item's first link points at: the entry's own Work, before any link nested in it. */
export const firstLinks = (items: Locator) => items.evaluateAll(elements => elements.map(element =>
  /\/w\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(element.querySelector('a')?.getAttribute('href') ?? '')?.[1] ?? ''));

/**
 * `test` whose `page` is the web member's, signed in once per QA run: the first test signs in and keeps the
 * browser state next to the seed; the others start from it.
 */
export const test = base.extend({
  page: async ({ browser }, use, info) => {
    const state = resolve('.temp', `g841-${process.env.REZICS_QA_RUN_ID}`, 'state.json');
    const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: desktop,
      ...(existsSync(state) ? { storageState: state } : {}) });
    const page = await context.newPage();
    if (!existsSync(state)) {
      await signIn(page, '/en');
      await context.storageState({ path: state });
    }
    await use(page);
    await context.close();
  },
});
