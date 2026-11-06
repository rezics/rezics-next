import { startDevServer } from './support/dev-server.ts';
import { afterAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };
const timeout = 300_000;

test('the font preload uses an actual bundler-resolved existing font asset rather than a development node_modules URL', async () => {
  const shell = await Bun.file(join(app, 'src/shell/shell.tsx')).text();
  const preloads = shell.match(/<link\b[^>]*\brel="preload"[^>]*\bas="font"[^>]*\/>/g) ?? [];
  expect(preloads).toHaveLength(1);
  const preload = preloads[0]!;
  expect(preload).toContain('type="font/woff2"');
  expect(preload).toContain('crossOrigin="anonymous"');
  const binding = /href=\{(\w+)\}/.exec(preload)?.[1];
  expect(binding).toBeDefined();
  const imports = [
    ...shell.matchAll(/import\s+(\w+)\s+from\s+['"](@fontsource-variable\/manrope\/files\/[^'"]+\.woff2)\?url['"]/g),
  ];
  const fontImport = imports.find((match) => match[1] === binding);
  expect(fontImport).toBeDefined();

  const require = createRequire(join(app, 'package.json'));
  const fontPath = require.resolve(fontImport![2]!);
  const font = await Bun.file(fontPath).arrayBuffer();
  expect(new TextDecoder().decode(font.slice(0, 4))).toBe('wOF2');

  // Both the preload and the existing typography must resolve to the same installed resource.
  const styles = await Bun.file(join(app, 'src/styles.css')).text();
  expect(styles).toContain("@import '@fontsource-variable/manrope'");
  const cssPath = require.resolve('@fontsource-variable/manrope');
  const css = await Bun.file(cssPath).text();
  const cssFonts = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => resolve(dirname(cssPath), match[1]!));
  expect(cssFonts).toContain(fontPath);
});

type Messages = Record<string, string>;
async function messages(locale: string): Promise<Messages> {
  return (await Bun.file(join(app, 'messages', `${locale}.json`)).json()) as Messages;
}


let browser: Browser | undefined;

// The documented command, in its own process group so that Vite and workerd stop with it.
let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let started: Promise<string> | undefined;

function site(): Promise<string> {
  started ??= startDevServer({
    warmUpPaths: [],
  }).then((running) => {
    server = running;
    return running.origin;
  });
  return started;
}

async function open(path: string, options: BrowserContextOptions = {}): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  // Actions before hydration reach server-rendered markup without handlers.
  if (options.javaScriptEnabled !== false) await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  return page;
}

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

function themed(origin: string, theme: string): NonNullable<BrowserContextOptions['storageState']> {
  return {
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
  };
}

test(
  'the site loads Tailwind once',
  async () => {
    const origin = await site();
    const html = await (await fetch(`${origin}/en`)).text();
    const sheets = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/g)].map(([tag]) =>
      /href="([^"]+)"/.exec(tag)![1]!.replaceAll('&amp;', '&'),
    );
    expect(sheets.length).toBeGreaterThan(0);
    let layers = 0;
    for (const sheet of sheets) {
      const css = await (await fetch(new URL(sheet, origin))).text();
      // Every copy of Tailwind declares its cascade layers once; a second copy's preflight resets what the first set.
      layers += css.split('@layer theme, base, components, utilities').length - 1;
    }
    expect(layers).toBe(1);
  },
  timeout,
);

test(
  "the navigation rail's edge is drawn in the border colour in both themes",
  async () => {
    const origin = await site();
    for (const theme of ['light', 'dark']) {
      const page = await open('/en', { storageState: themed(origin, theme) });
      const edge = await page.evaluate(() => {
        const rail = document.querySelector('[data-slot="sidebar-container"]')!;
        const style = getComputedStyle(rail);
        const side = document.dir === 'rtl' || style.direction === 'rtl' ? 'Left' : 'Right';
        const resolve = (value: string) => {
          const probe = document.createElement('span');
          probe.style.color = value;
          rail.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        return {
          width: parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)),
          color: style.getPropertyValue(`border-${side.toLowerCase()}-color`),
          allowed: [resolve('var(--sidebar-border)'), resolve('var(--border)')],
        };
      });
      expect(edge.width, theme).toBeGreaterThan(0);
      expect(edge.allowed, theme).toContain(edge.color);
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the logo link is named after the site in every locale',
  async () => {
    for (const locale of locales) {
      const page = await open(`/${locale}`, { javaScriptEnabled: false, viewport: phone });
      const logo = page.getByRole('banner').getByRole('link', { name: 'REZICS', exact: true });
      expect(await logo.count(), locale).toBe(1);
      expect(await logo.getAttribute('href'), locale).toBe(`/${locale}`);
      await page.context().close();
    }
  },
  timeout,
);
