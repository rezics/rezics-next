import { afterAll, expect, test } from 'bun:test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
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

async function open(path: string, options: BrowserContextOptions = {}, beforeHydration = false): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  if (beforeHydration)
    await page.route('**/*', (route) =>
      route.request().resourceType() === 'script' ? route.abort() : route.continue(),
    );
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  if (options.javaScriptEnabled !== false && !beforeHydration)
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

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await Bun.sleep(100);
  }
}

// Measurements and audits wait until transitions and animations have finished.
const settled = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));

const navigationWidth = async (page: Page, name: string) =>
  (await page.getByRole('navigation', { name, exact: true }).boundingBox())?.width ?? 0;

const isFocused = (page: Page, name: string) =>
  page.getByRole('link', { name, exact: true }).evaluate((element) => element === document.activeElement);

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

async function violations(page: Page, where: string): Promise<string[]> {
  await settled(page);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return result.violations.map(
    (violation) => `${where}: ${violation.id} ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

test(
  'the skip link stays out of sight and takes no space until it is focused',
  async () => {
    const en = await messages('en');
    for (const javaScriptEnabled of [true, false])
      for (const viewport of [desktop, phone]) {
        const where = `${viewport.width}px${javaScriptEnabled ? '' : ' without JavaScript'}`;
        const page = await open('/en', { javaScriptEnabled, viewport });
        const skip = page.getByRole('link', { name: en.shell_skip_to_content!, exact: true });
        expect(await skip.count(), where).toBe(1);
        expect(await page.getByRole('banner').count(), where).toBe(1);
        expect((await page.getByRole('banner').boundingBox())?.y, where).toBe(0);
        const before = await skip.boundingBox();
        expect(
          !before ||
            before.width * before.height <= 1 ||
            before.x + before.width <= 0 ||
            before.y + before.height <= 0 ||
            before.x >= viewport.width ||
            before.y >= viewport.height,
          where,
        ).toBe(true);
        await page.keyboard.press('Tab');
        expect(await isFocused(page, en.shell_skip_to_content!), where).toBe(true);
        const focused = await skip.boundingBox();
        expect(
          focused !== null &&
            focused.width >= 24 &&
            focused.height >= 24 &&
            focused.x >= 0 &&
            focused.y >= 0 &&
            focused.x + focused.width <= viewport.width &&
            focused.y + focused.height <= viewport.height,
          where,
        ).toBe(true);
        await page.context().close();
      }
  },
  timeout,
);

test(
  'the desktop navigation collapses to icons that keep their names, and the first paint remembers it',
  async () => {
    for (const locale of locales) {
      const text = await messages(locale);
      expect(text.shell_expand_navigation?.trim(), locale).toBeTruthy();
      expect(text.shell_expand_navigation, locale).not.toBe(text.shell_collapse_navigation);
    }
    const en = await messages('en');
    const nav = en.shell_navigation!;
    const page = await open('/en');
    const home = page
      .getByRole('navigation', { name: nav, exact: true })
      .getByRole('link', { name: en.nav_home!, exact: true });
    expect(await navigationWidth(page, nav)).toBeGreaterThanOrEqual(160);
    const before = await page.context().cookies();

    await page.getByRole('button', { name: en.shell_collapse_navigation!, exact: true }).click();
    await page.getByRole('button', { name: en.shell_expand_navigation!, exact: true }).waitFor();
    await until(async () => (await navigationWidth(page, nav)) <= 96, 'the navigation collapses');
    expect(await home.count()).toBe(1);
    expect(await home.isVisible()).toBe(true);
    expect(await home.getAttribute('aria-current')).toBe('page');

    // One preference is kept in one cookie; the inline script restores it before hydration.
    const cookies = await page.context().cookies();
    expect(cookies.filter((cookie) => !before.some((old) => old.name === cookie.name)).length).toBe(1);
    const again = await open('/en', { storageState: { cookies, origins: [] } }, true);
    expect(await navigationWidth(again, nav)).toBeLessThanOrEqual(96);
    expect(await again.locator('html[data-hydrated]').count()).toBe(0);
    await again.context().close();
    const hydrated = await open('/en', { storageState: { cookies, origins: [] } });
    expect(await hydrated.getByRole('button', { name: en.shell_expand_navigation!, exact: true }).count()).toBe(1);
    await hydrated.context().close();

    await page.getByRole('button', { name: en.shell_expand_navigation!, exact: true }).click();
    await until(async () => (await navigationWidth(page, nav)) >= 160, 'the navigation expands');
    await page.context().close();
  },
  timeout,
);

test(
  'the collapsed navigation has no accessibility violations in either theme',
  async () => {
    const origin = await site();
    const en = await messages('en');
    const found: string[] = [];
    for (const theme of ['light', 'dark']) {
      const wide = await open('/en', { storageState: themed(origin, theme) });
      await wide.getByRole('button', { name: en.shell_collapse_navigation!, exact: true }).click();
      await wide.getByRole('button', { name: en.shell_expand_navigation!, exact: true }).waitFor();
      await until(async () => (await navigationWidth(wide, en.shell_navigation!)) <= 96, 'the navigation collapses');
      found.push(...(await violations(wide, `${theme} collapsed`)));
      await wide.context().close();
    }
    expect(found).toEqual([]);
  },
  timeout,
);
