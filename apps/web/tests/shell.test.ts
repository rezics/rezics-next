import { afterAll, expect, test } from 'bun:test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const endonyms = {
  en: 'English',
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
};
const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };
const timeout = 300_000;

type Messages = Record<string, string>;
async function messages(locale: string): Promise<Messages> {
  return (await Bun.file(join(app, 'messages', `${locale}.json`)).json()) as Messages;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
let browser: Browser | undefined;

// The documented command, in its own process group so that Vite and workerd stop with it.
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en/ in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function open(path: string, options: BrowserContextOptions = {}): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  if (options.javaScriptEnabled !== false)
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const focusedInMain = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest('main')));
const any = (...locators: Locator[]) => locators.reduce((all, locator) => all.or(locator)).first();

test(
  'the server-rendered shell has a skip link, one labelled navigation and one main landmark',
  async () => {
    const en = await messages('en');
    for (const viewport of [desktop, phone]) {
      const page = await open('/en', { javaScriptEnabled: false, viewport });
      await page.keyboard.press('Tab');
      const skip = page.locator(':focus');
      expect((await skip.textContent())?.trim()).toBe(en.shell_skip_to_content);
      expect(await skip.getAttribute('href')).toMatch(/^#./);
      await page.keyboard.press('Enter');
      expect(await focusedInMain(page)).toBe(true);
      expect(await page.getByRole('main').count()).toBe(1);
      const navigation = page.getByRole('navigation', { name: en.shell_navigation!, exact: true });
      expect(await navigation.count(), `${viewport.width}px`).toBe(1);
      const home = navigation.getByRole('link', { name: en.nav_home!, exact: true });
      expect(await home.getAttribute('aria-current')).toBe('page');
      await page.context().close();
    }
  },
  timeout,
);

test(
  'every locale renders the shell in its own language',
  async () => {
    const english = await messages('en');
    for (const locale of locales) {
      const own = await messages(locale);
      for (const key of [
        'shell_skip_to_content',
        'shell_navigation',
        'shell_language',
        'shell_theme',
        'shell_theme_system',
        'shell_theme_light',
        'shell_theme_dark',
        'nav_home',
      ])
        expect(own[key]?.trim(), `${locale} ${key}`).toBeTruthy();
      if (locale !== 'en') expect(own.shell_skip_to_content).not.toBe(english.shell_skip_to_content);
      const page = await open(`/${locale}`, { javaScriptEnabled: false });
      await page.keyboard.press('Tab');
      expect((await page.locator(':focus').textContent())?.trim()).toBe(own.shell_skip_to_content);
      const navigation = page.getByRole('navigation', { name: own.shell_navigation!, exact: true });
      expect(await navigation.getByRole('link', { name: own.nav_home!, exact: true }).count(), locale).toBe(1);
      await page.context().close();
    }
  },
  timeout,
);

test(
  'every page has one URL without a trailing slash and names its other locales for search engines',
  async () => {
    const origin = await site();
    const slashed = await fetch(`${origin}/ja/`, { redirect: 'manual' });
    expect([301, 307, 308]).toContain(slashed.status);
    expect(new URL(slashed.headers.get('location')!, origin).pathname).toBe('/ja');
    for (const locale of ['en', 'ja']) {
      const page = await open(`/${locale}`, { javaScriptEnabled: false });
      const alternates = await page
        .locator('link[rel="alternate"][hreflang]')
        .evaluateAll((links) => links.map((link) => [link.getAttribute('hreflang')!, link.getAttribute('href')!]));
      const expected = Object.fromEntries([
        ...locales.map((other) => [other, `${origin}/${other}`]),
        ['x-default', `${origin}/`],
      ]);
      expect(Object.fromEntries(alternates)).toEqual(expected);
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the theme choice renders on the first paint and persists',
  async () => {
    const origin = await site();
    const htmlClass = async (cookie?: string) => {
      const html = await (await fetch(`${origin}/en`, cookie ? { headers: { cookie } } : {})).text();
      return (/<html[^>]*\sclass="([^"]*)"/.exec(html)?.[1] ?? '').split(/\s+/);
    };
    expect(await htmlClass('rezics_theme=dark')).not.toContain('dark');
    expect(await htmlClass('rezics_theme=light')).not.toContain('light');
    for (const cookie of [undefined, 'rezics_theme=system']) {
      const classes = await htmlClass(cookie);
      expect(classes).not.toContain('dark');
      expect(classes).not.toContain('light');
    }

    const en = await messages('en');
    const page = await open('/en');
    await page.getByRole('button', { name: en.shell_theme!, exact: true }).click();
    await any(
      page.getByRole('menuitemradio', { name: en.shell_theme_dark!, exact: true }),
      page.getByRole('radio', { name: en.shell_theme_dark!, exact: true }),
    ).click();
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
    const cookies = await page.context().cookies();
    expect(cookies.find((cookie) => cookie.name === 'rezics_theme')?.value).toBe('dark');
    await page.context().close();
  },
  timeout,
);

test(
  'the language choice moves to the same page in that language and remembers it',
  async () => {
    const origin = await site();
    const en = await messages('en');
    const page = await open('/en');
    await any(
      page.getByRole('combobox', { name: en.shell_language!, exact: true }),
      page.getByRole('button', { name: en.shell_language!, exact: true }),
    ).click();
    await any(
      page.getByRole('option', { name: endonyms.ja, exact: true }),
      page.getByRole('menuitemradio', { name: endonyms.ja, exact: true }),
      page.getByRole('link', { name: endonyms.ja, exact: true }),
    ).click();
    await page.waitForURL(`${origin}/ja`);
    const cookie = (await page.context().cookies()).find((entry) => entry.name === 'rezics_locale');
    expect(cookie?.value).toBe('ja');
    const redirect = await fetch(`${origin}/`, {
      headers: { cookie: 'rezics_locale=ja', 'accept-language': 'en' },
      redirect: 'manual',
    });
    expect(new URL(redirect.headers.get('location')!, origin).pathname.replace(/\/$/, '')).toBe('/ja');
    await page.context().close();
  },
  timeout,
);

test(
  'a client-side navigation keeps the document and moves focus to the new page',
  async () => {
    const origin = await site();
    const de = await messages('de');
    const page = await open('/de/no-such-page');
    await page.evaluate(() => {
      (window as unknown as { kept: boolean }).kept = true;
    });
    await page
      .getByRole('navigation', { name: de.shell_navigation!, exact: true })
      .getByRole('link', { name: de.nav_home!, exact: true })
      .click();
    await page.waitForURL(`${origin}/de`);
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
    await page.waitForFunction(() => Boolean(document.activeElement?.closest('main')));
    expect(await focusedInMain(page)).toBe(true);
    await page.context().close();
  },
  timeout,
);

test(
  'the shell has no accessibility violations in either theme at phone and desktop widths',
  async () => {
    const found: string[] = [];
    for (const theme of ['light', 'dark'])
      for (const viewport of [phone, desktop])
        for (const path of ['/en', '/ja', '/de/no-such-page']) {
          const origin = await site();
          const page = await open(path, {
            viewport,
            storageState: {
              cookies: [
                {
                  name: 'rezics_theme',
                  value: theme,
                  domain: new URL(origin).hostname,
                  path: '/',
                  expires: -1,
                  httpOnly: false,
                  secure: false,
                  sameSite: 'Lax',
                },
              ],
              origins: [],
            },
          });
          const result = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
            .analyze();
          for (const violation of result.violations)
            found.push(
              `${theme} ${viewport.width}px ${path}: ${violation.id} ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
            );
          await page.context().close();
        }
    expect(found).toEqual([]);
  },
  timeout,
);
