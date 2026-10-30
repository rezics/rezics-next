import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { resolve } from 'node:path';
import { startDevServer } from './support/dev-server';

const fixturePath = '/tests/fixtures/subject-reactions-phone.html';
const fixtureUrl = (origin: string, locale = 'en', signedIn = true, full = false) => {
  const query = new URLSearchParams({ locale, signedIn: String(signedIn), full: String(full) });
  return `${origin}${fixturePath}?${query}`;
};
const timeout = 120_000;

let origin: string;
let server: { origin: string; stop: () => Promise<void> } | undefined;
let browser: Browser | undefined;

beforeAll(async () => {
  server = await startDevServer({
    cwd: resolve(import.meta.dir, '..'),
    firstPath: fixturePath,
    warmUpPaths: [fixturePath],
    command: ({ port }) => [
      'bun',
      'run',
      'vite',
      '--config',
      'vite.reactions-test.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
  });
  origin = server.origin;
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

async function openPage(
  locale = 'en',
  signedIn = true,
  full = false,
  width = 390,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser!.newContext({ viewport: { width, height: 844 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  try {
    await page.goto(fixtureUrl(origin, locale, signedIn, full), { waitUntil: 'networkidle' });
    await page.locator('html[data-reaction-harness="ready"]').waitFor({ state: 'attached', timeout: 10_000 });
    if (signedIn) {
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-slot="reactions"] button')].every(
          (button) => !(button as HTMLButtonElement).disabled,
        ),
      );
    }
    return { context, page };
  } catch (error) {
    await context.close();
    throw new Error(`${String(error)}\nBrowser errors: ${pageErrors.join('\n') || 'none'}`);
  }
}

async function insideViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
}

test.serial(
  'subject reactions and their menu stay inside the phone viewport in both locales and session states',
  async () => {
    for (const locale of ['en', 'zh-Hans']) {
      for (const signedIn of [true, false]) {
        for (const full of [false, true]) {
          const { context, page } = await openPage(locale, signedIn, full);
          try {
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
            const actions = page.locator('[data-slot="subject-header-actions"]');
            const reactions = actions.locator('[data-slot="reactions"]');
            const chips = reactions.locator('[data-slot="reaction-chip"]:visible');
            for (let index = 0; index < (await chips.count()); index += 1) await insideViewport(page, chips.nth(index));
            const react = reactions
              .locator('a, button')
              .filter({ hasText: /React|表态/ })
              .first();
            await insideViewport(page, react);
            const menu = actions.locator(':scope > div:last-child button');
            await insideViewport(page, menu);
            expect(await reactions.evaluate((node) => getComputedStyle(node).flexWrap)).toBe('wrap');
            const reactionsBox = (await reactions.boundingBox())!;
            const menuBox = (await menu.boundingBox())!;
            const actionsBox = (await actions.boundingBox())!;
            expect(Math.abs(menuBox.y - reactionsBox.y)).toBeLessThanOrEqual(2);
            expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(actionsBox.x + actionsBox.width + 1);
          } finally {
            await context.close();
          }
        }
      }
    }
  },
  timeout,
);

test.serial(
  'subject actions keep the reaction cluster and overflow menu at the top right on desktop',
  async () => {
    const { context, page } = await openPage('en', true, true, 1280);
    try {
      const header = page.locator('[data-slot="subject-overview-header"]');
      const actions = header.locator('[data-slot="subject-header-actions"]');
      const reactions = actions.locator('[data-slot="reactions"]');
      const react = reactions.getByRole('button', { name: 'React', exact: true });
      const menu = actions.locator(':scope > div:last-child button');
      const reactBox = (await react.boundingBox())!;
      const menuBox = (await menu.boundingBox())!;
      const headerBox = (await header.boundingBox())!;
      expect(Math.abs(reactBox.y - menuBox.y)).toBeLessThanOrEqual(2);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1);
      expect(menuBox.x).toBeGreaterThan(headerBox.x + headerBox.width / 2);
    } finally {
      await context.close();
    }
  },
  timeout,
);

test.serial(
  'phone reaction and overflow menus stay reachable by keyboard and inside the viewport',
  async () => {
    const { context, page } = await openPage('en', true, true);
    try {
      const actions = page.locator('[data-slot="subject-header-actions"]');
      const reactions = actions.locator('[data-slot="reactions"]');
      const react = reactions.getByRole('button', { name: 'React', exact: true });
      await react.click();

      const picker = page.locator('[data-slot="drawer-popup"]:visible, [data-slot="dropdown-menu-content"]:visible');
      await picker.waitFor({ state: 'visible' });
      expect(await picker.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      const choices = picker.getByRole('button');
      for (let index = 0; index < (await choices.count()); index += 1) await insideViewport(page, choices.nth(index));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.keyboard.press('Escape');
      await picker.waitFor({ state: 'hidden' });
      const reactHandle = await react.elementHandle();
      await page.waitForFunction((element) => document.activeElement === element, reactHandle);

      const menu = actions.locator(':scope > div:last-child button');
      await page.keyboard.press('Tab');
      expect(await menu.evaluate((node) => node === document.activeElement)).toBe(true);
      await menu.click();
      const overflow = page.locator('[data-slot="drawer-popup"]:visible, [data-slot="dropdown-menu-content"]:visible');
      await overflow.waitFor({ state: 'visible' });
      const overflowHandle = await overflow.elementHandle();
      await page.waitForFunction((node) => node?.contains(document.activeElement), overflowHandle);
      expect(await overflow.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      const menuItems = overflow.getByRole('button');
      for (let index = 0; index < (await menuItems.count()); index += 1)
        await insideViewport(page, menuItems.nth(index));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.keyboard.press('Escape');
      await overflow.waitFor({ state: 'hidden' });
      const menuHandle = await menu.elementHandle();
      await page.waitForFunction((element) => document.activeElement === element, menuHandle);
    } finally {
      await context.close();
    }
  },
  timeout,
);

test.serial(
  'a thread post reaction row stays within a 390 px viewport',
  async () => {
    const { context, page } = await openPage('en', false, true);
    try {
      const reactions = page.locator('[data-slot="thread-post-actions"] [data-slot="reactions"]');
      await reactions.waitFor({ state: 'visible' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      const box = (await reactions.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(391);
      expect(await reactions.evaluate((node) => getComputedStyle(node).flexWrap)).toBe('wrap');
      const chips = reactions.locator('[data-slot="reaction-chip"]:visible');
      expect(await chips.count()).toBe(7);
      const rows = new Set<number>();
      for (let index = 0; index < (await chips.count()); index += 1) {
        const chip = chips.nth(index);
        await insideViewport(page, chip);
        rows.add(Math.round((await chip.boundingBox())!.y));
      }
      const react = reactions.locator('a, button').filter({ hasText: 'React' }).first();
      await insideViewport(page, react);
      expect(rows.size).toBeGreaterThan(1);
    } finally {
      await context.close();
    }
  },
  timeout,
);
