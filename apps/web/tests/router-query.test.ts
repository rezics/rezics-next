import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import spaceAddressRecording from '../src/kernel/recorded/space-address.json';

const app = join(import.meta.dir, '..');
const fake = createStoryRecordedKernelFetch();
const calls: string[] = [];
const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    calls.push(new URL(request.url).pathname);
    return fake(request);
  },
});
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let started: Promise<string> | undefined;
function site() {
  return (started ??= (async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        server.close(() => resolve(port));
      });
    });
    let output = '';
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KERNEL_ORIGIN: kernel.url.origin },
    });
    child.stdout!.on('data', (data) => (output += data));
    child.stderr!.on('data', (data) => (output += data));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        if ((await fetch(`${origin}/en/`)).status < 500) return origin;
      } catch {}
      await Bun.sleep(250);
    }
    throw new Error(output);
  })());
}
afterAll(async () => {
  await browser?.close();
  kernel.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test('router creates an isolated query client, integrates SSR and sets navigation defaults', async () => {
  const source = await Bun.file(join(app, 'src/router.tsx')).text();
  const root = await Bun.file(join(app, 'src/routes/__root.tsx')).text();
  const presets = await Bun.file(join(app, 'src/kernel/query.ts')).text();
  expect(source).toContain('new QueryClient(');
  expect(source).toContain('setupRouterSsrQueryIntegration');
  expect(source).toContain("defaultPreload: 'intent'");
  expect(source).toContain('defaultPreloadStaleTime: 0');
  expect(source).toContain('defaultPendingComponent:');
  expect(source).toContain('defaultErrorComponent:');
  expect(source).toContain('defaultNotFoundComponent:');
  expect(root).toContain('createRootRouteWithContext');
  expect(presets).toContain('60_000');
  expect(presets).toContain('personalRead');
});

test('reference routes use the same query for loading and rendering', async () => {
  const queries = await Bun.file(join(app, 'src/community/space-queries.ts')).text();
  expect(queries).toContain("['space', address, locale]");
  expect(queries).toContain("['realm-page', id, locale]");
  for (const path of ['spaces/$address.tsx', 'realms/$id.tsx']) {
    const source = await Bun.file(join(app, 'src/routes', path)).text();
    expect(source).toContain('ensureQueryData');
    expect(source).toContain('useSuspenseQuery');
  }
});

test('server Space read is not repeated during hydration', async () => {
  const origin = await site();
  browser ??= await chromium.launch();
  const page = await browser.newPage();
  calls.length = 0;
  const response = await page.goto(`${origin}/en/spaces/${spaceAddressRecording.address}`);
  expect(response?.status()).toBe(200);
  await page.locator('html[data-hydrated]').waitFor();
  await page.waitForTimeout(500);
  expect(calls.filter((path) => path === `/v1/spaceAddresses/${spaceAddressRecording.address}`)).toHaveLength(1);
  await page.close();
}, 300_000);
