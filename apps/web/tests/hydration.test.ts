import { afterAll, expect, test } from 'bun:test';
import { startDevServer } from './support/dev-server.ts';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const desktop = { width: 1280, height: 860 };
const timeout = 300_000;

type Messages = Record<string, string>;
async function messages(locale: string): Promise<Messages> {
  return (await Bun.file(join(app, 'messages', `${locale}.json`)).json()) as Messages;
}

let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let started: Promise<string> | undefined;
let browser: Browser | undefined;

function site(): Promise<string> {
  started ??= startDevServer({
    warmUpPaths: [],
  }).then((running) => {
    server = running;
    return running.origin;
  });
  return started;
}

async function context(options: BrowserContextOptions = {}) {
  browser ??= await chromium.launch();
  return browser.newContext({ viewport: desktop, reducedMotion: 'reduce', ...options });
}

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

// A loaded machine, reproduced: the browser runs scripts four times slower, and the test stops waiting as soon as
// the document is parsed, so it acts before hydration unless it waits for the mark.
async function slow(path: string): Promise<Page> {
  const origin = await site();
  const page = await (await context()).newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
}

test(
  'the document marks itself hydrated only in the browser',
  async () => {
    const origin = await site();
    for (const path of ['/en', '/de/no-such-page']) {
      const html = await (await fetch(`${origin}${path}`)).text();
      expect(/<html[^>]*\sdata-hydrated/.test(html), path).toBe(false);
      const page = await (await context({ javaScriptEnabled: false })).newPage();
      await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
      expect(await page.locator('html[data-hydrated]').count(), path).toBe(0);
      await page.context().close();
    }
  },
  timeout,
);

test(
  'once the document is marked hydrated, controls answer the first click even on a slow processor',
  async () => {
    const en = await messages('en');
    const page = await slow('/en');
    await page.getByRole('button', { name: en.shell_theme!, exact: true }).click();
    const dark = page
      .getByRole('menuitemradio', { name: en.shell_theme_dark!, exact: true })
      .or(page.getByRole('radio', { name: en.shell_theme_dark!, exact: true }))
      .first();
    await dark.waitFor({ timeout: 10_000 });
    await dark.click();
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
    await page.context().close();
  },
  timeout,
);

test(
  'once the document is marked hydrated, following a link is a client-side navigation even on a slow processor',
  async () => {
    const origin = await site();
    const de = await messages('de');
    const page = await slow('/de/no-such-page');
    await page.evaluate(() => {
      (window as unknown as { kept: boolean }).kept = true;
    });
    await page
      .getByRole('navigation', { name: de.shell_navigation!, exact: true })
      .getByRole('link', { name: de.nav_home!, exact: true })
      .click();
    await page.waitForURL(`${origin}/de`);
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
    await page.context().close();
  },
  timeout,
);

test(
  'localized Search recovers a failed entry import, settles a rejected session read and uses phone filters',
  async () => {
    const origin = await site();
    const zh = await messages('zh-Hant');
    const ja = await messages('ja');
    const page = await (await context({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' })).newPage();
    try {
      // The captured ERR_NETWORK_CHANGED failed this exact module before hydration could start.
      await page.route('**/src/client.tsx*', (route) => route.abort('internetdisconnected'), { times: 1 });
      await page.goto(`${origin}/zh-Hant/search?q=Steins%3BGate`, { waitUntil: 'domcontentloaded' });
      const recovery = page.getByRole('alert').filter({ hasText: zh.shell_client_unavailable! });
      await recovery.waitFor();
      expect(await page.locator('html[data-hydrated]').count()).toBe(0);
      expect(await page.locator('header [aria-busy="true"]').isVisible()).toBe(false);
      let rejected = 0;
      await page.route('**/_server/**', async (route) => {
        if (route.request().method() === 'GET') {
          rejected++;
          await route.abort('internetdisconnected');
        } else await route.continue();
      });
      await recovery.getByRole('link', { name: zh.shell_client_reload! }).click();
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      await page.getByRole('status').filter({ hasText: zh.shell_account_unavailable! }).waitFor();
      expect(rejected).toBeGreaterThan(0);
      await page
        .locator(
          '[data-search-recovery="closed"], [data-search-recovery="denied"], [data-search-recovery="unavailable"]',
        )
        .waitFor();
      expect(await page.locator('[data-search-recovery="loading"]').count()).toBe(0);
      const population = page.getByLabel(zh.search_population_label!, { exact: true });
      const box = await population.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      const help = await page.locator(`[id="${await population.getAttribute('aria-describedby')}"]`).boundingBox();
      expect(help!.y).toBeGreaterThanOrEqual(box!.y + box!.height);
      await page.getByRole('button', { name: new RegExp(zh.search_filters!) }).click();
      const sheet = page.getByRole('dialog');
      await sheet.waitFor();
      await sheet.getByRole('button', { name: zh.search_close_filters!, exact: true }).click();
      await sheet.waitFor({ state: 'hidden' });
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain(zh.search_filters!);
      // A native order replacement and a locale navigation both retain the executed query.
      await page.getByLabel(zh.search_sort_label!, { exact: true }).selectOption('rating');
      await page.waitForURL((url) => url.searchParams.get('sort') === 'rating');
      expect(new URL(page.url()).searchParams.get('q')).toBe('Steins;Gate');
      const destination = new URL(page.url());
      destination.pathname = '/ja/search';
      await page.goto(destination.href, { waitUntil: 'domcontentloaded' });
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      await page.getByLabel(ja.search_population_label!, { exact: true }).waitFor();
      expect(await page.getByLabel(ja.search_sort_label!, { exact: true }).inputValue()).toBe('rating');
      expect(new URL(page.url()).searchParams.get('q')).toBe('Steins;Gate');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
