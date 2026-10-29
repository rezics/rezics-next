import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const desktop = { width: 1280, height: 860 };
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
    const spawnedAt = Date.now();
    let readyAt = 0;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
      console.info('[measure hydration output]', chunk.toString());
      if (!readyAt && /ready in/.test(output)) {
        readyAt = Date.now();
        console.info('[measure hydration] spawn to ready', readyAt - spawnedAt);
      }
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
        if (response.status < 500) {
          console.info('[measure hydration] ready to first /en', Date.now() - readyAt);
          return origin;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en/ in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function context(options: BrowserContextOptions = {}) {
  browser ??= await chromium.launch();
  return browser.newContext({ viewport: desktop, reducedMotion: 'reduce', ...options });
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
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
