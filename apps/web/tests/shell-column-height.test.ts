import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 900_000;
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let storybookPromise: Promise<string> | undefined;

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

async function storybook(): Promise<string> {
  const port = await freePort();
  let output = '';
  const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8000));
  child = spawn(
    join(app, 'node_modules/.bin/storybook'),
    ['dev', '--ci', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1' },
    },
  );
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Storybook exited with ${child.exitCode}:\n${output}`);
    try {
      if ((await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(10_000) })).ok) return origin;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Storybook did not serve its index in time:\n${output}`);
    await Bun.sleep(500);
  }
}

async function open(width: number) {
  storybookPromise ??= storybook();
  const origin = await storybookPromise;
  const index = (await (await fetch(`${origin}/index.json`)).json()) as {
    entries: Record<string, { id: string; importPath: string; name: string; type: string }>;
  };
  const entry = Object.values(index.entries).find(
    (candidate) =>
      candidate.type === 'story' &&
      candidate.importPath.endsWith('/library-collection.stories.tsx') &&
      candidate.name === 'Signed In',
  );
  if (!entry) throw new Error('Missing signed-in Collection page story.');
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height: width === 1280 ? 600 : 844 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto(`${origin}/iframe.html?id=${entry.id}&viewMode=story&globals=locale:en`, {
    waitUntil: 'networkidle',
  });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('main').waitFor();
  return { context, page };
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test(
  'the desktop navigation background fills a long page and its links stay below the sticky header',
  async () => {
    const { context, page } = await open(1280);
    const main = page.getByRole('main');
    const height = await main.evaluate((element) =>
      Math.max(element.scrollHeight, document.documentElement.scrollHeight),
    );
    expect(height).toBeGreaterThan(600);

    const sidebar = page.locator('[data-sidebar="sidebar"]:not([data-mobile="true"])');
    const initial = await sidebar.boundingBox();
    expect(initial).not.toBeNull();
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(Math.abs(initial!.y + initial!.height - pageHeight)).toBeLessThanOrEqual(2);

    await page.evaluate(() => window.scrollTo(0, 500));
    const navigation = sidebar.getByRole('navigation');
    const navBox = await navigation.boundingBox();
    expect(navBox?.y).toBe(64);
    await context.close();
  },
  timeout,
);

test(
  'the 390px navigation remains the header button sheet',
  async () => {
    const { context, page } = await open(390);
    const openNavigation = page.locator('[data-open-navigation]');
    await openNavigation.click();
    const sheet = page.getByRole('dialog');
    await sheet.waitFor({ state: 'visible' });
    expect(await sheet.getByRole('navigation').count()).toBe(1);
    await context.close();
  },
  timeout,
);
