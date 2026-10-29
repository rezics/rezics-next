import { afterAll, expect, test } from 'bun:test';
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
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const bambooCutter = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e03';

test(
  'a subject page lists each property once, as one term followed by its values',
  async () => {
    for (const viewport of [desktop, phone]) {
      const page = await open(`/en/subjects/${bambooCutter}`, { viewport });
      const terms = await page.evaluate(() =>
        [...document.querySelectorAll('main dt')].map((term) => ({
          text: term.textContent?.trim() ?? '',
          hidden: term.closest('[aria-hidden="true"]') !== null,
          nested: term.parentElement?.closest('dd') !== null,
        })),
      );
      // Every term names something; an empty term is announced as a blank entry.
      expect(terms.filter((term) => term.text === '' || term.hidden)).toEqual([]);
      const properties = terms.filter((term) => !term.nested).map((term) => term.text);
      expect(properties).toEqual(['Author', 'Genre']);
      const genre = page.getByRole('term').filter({ hasText: /^Genre$/ });
      const values = await genre.evaluate((term) => {
        const values: string[] = [];
        for (let next = term.nextElementSibling; next?.tagName === 'DD'; next = next.nextElementSibling)
          values.push(next.textContent?.trim() ?? '');
        return values;
      });
      expect(values).toHaveLength(2);
      await page.context().close();
    }
  },
  timeout,
);

test(
  "the phone navigation sheet names the site, outside the navigation's landmark",
  async () => {
    const en = await messages('en');
    for (const locale of locales) {
      const own = await messages(locale);
      const page = await open(`/${locale}`, { viewport: phone });
      await page.getByRole('button', { name: own.shell_open_navigation!, exact: true }).click();
      const sheet = page.getByRole('dialog');
      await sheet.waitFor();
      expect(await sheet.getByText('REZICS', { exact: true }).isVisible(), locale).toBe(true);
      const navigation = sheet.getByRole('navigation', { name: own.shell_navigation!, exact: true });
      expect(await navigation.getByRole('link', { name: 'REZICS', exact: true }).count(), locale).toBe(0);
      expect(await navigation.getByRole('button').count(), locale).toBe(0);
      expect(await sheet.getByRole('button', { name: own.shell_close_navigation!, exact: true }).count(), locale).toBe(
        1,
      );
      await page.context().close();
    }
    expect(en.shell_close_navigation).toBe('Close navigation');
  },
  timeout,
);
