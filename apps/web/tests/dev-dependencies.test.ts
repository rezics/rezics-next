import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join, resolve, sep } from 'node:path';
import { chromium, type Browser } from 'playwright';
import fixtures from '../src/kernel/fixtures.json';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const temporary = join(root, '.temp');
mkdirSync(temporary, { recursive: true });
const storybookOutput = mkdtempSync(join(temporary, 'dev-dependencies-storybook-'));
const storybook = join(app, 'node_modules/.bin/storybook');
const subjectId = fixtures.subjects[0]!.id;
const paths = ['/en', `/en/subjects/${subjectId}`, '/en/search', '/en/library'];

let devServer: ChildProcess | undefined;
let devOutput = '';
let browser: Browser | undefined;
let staticServer: ReturnType<typeof Bun.serve> | undefined;

function appendOutput(chunk: Buffer) {
  devOutput = (devOutput + chunk.toString()).slice(-64_000);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolvePort(port));
    });
  });
}

async function startDevServer(): Promise<string> {
  const port = await freePort();
  devServer = spawn(
    'bun',
    ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--force'],
    { cwd: app, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  devServer.stdout!.on('data', appendOutput);
  devServer.stderr!.on('data', appendOutput);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (devServer.exitCode !== null) throw new Error(`Vite exited with ${devServer.exitCode}:\n${devOutput}`);
    try {
      const response = await fetch(`${origin}/en`, { signal: AbortSignal.timeout(10_000) });
      if (response.status < 500) return origin;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Vite did not serve /en in time:\n${devOutput}`);
    await Bun.sleep(500);
  }
}

async function buildStorybook(): Promise<void> {
  const run = Bun.spawn(
    [storybook, 'build', '--config-dir', join(app, '.storybook'), '--output-dir', storybookOutput],
    { cwd: app, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1' } },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}

afterAll(async () => {
  await browser?.close();
  staticServer?.stop(true);
  if (devServer?.pid)
    try {
      process.kill(-devServer.pid, 'SIGTERM');
    } catch {}
  rmSync(storybookOutput, { recursive: true, force: true });
});

test(
  'the cold client optimizer serves first page loads without reloads or unresolved dependencies',
  async () => {
    const origin = await startDevServer();
    browser = await chromium.launch();

    for (const path of paths) {
      const context = await browser.newContext();
      const page = await context.newPage();
      let loadEvents = 0;
      page.on('load', () => loadEvents++);
      await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
      expect(loadEvents, path).toBe(1);
      await context.close();
    }

    expect(devOutput).not.toMatch(/Failed to resolve dependency|Cannot optimize dependency/i);
    expect(devOutput).not.toMatch(/optimized dependencies changed\. reloading/i);
  },
  900_000,
);

test(
  'Storybook builds and serves a page story with the development optimizer configuration',
  async () => {
    await buildStorybook();
    staticServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const pathname = decodeURIComponent(new URL(request.url).pathname);
        const file = resolve(storybookOutput, `.${pathname}`);
        if (file !== storybookOutput && !file.startsWith(`${storybookOutput}${sep}`))
          return new Response('Not found', { status: 404 });
        const target = Bun.file(file);
        return (await target.exists()) ? new Response(target) : new Response('Not found', { status: 404 });
      },
    });
    const origin = `http://127.0.0.1:${staticServer.port}`;
    const response = await fetch(`${origin}/index.json`);
    expect(response.ok).toBe(true);
    const index = (await response.json()) as {
      entries: Record<string, { id: string; importPath: string; name: string; type: string }>;
    };
    const home = Object.values(index.entries).find(
      (entry) => entry.type === 'story' && basename(entry.importPath) === 'home.stories.tsx' && entry.name === 'Signed Out',
    );
    expect(home, 'the home page story is included in the built Storybook').toBeDefined();

    const storyBrowser = browser ?? (browser = await chromium.launch());
    const context = await storyBrowser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/iframe.html?id=${home!.id}&viewMode=story`, { waitUntil: 'networkidle' });
    await page.getByRole('main').waitFor();
    await context.close();
  },
  900_000,
);
