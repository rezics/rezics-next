import { startDevServer } from './support/dev-server.ts';
import { afterAll, expect, test } from 'bun:test';
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
let browser: Browser | undefined;
let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let started: Promise<string> | undefined;

function site(): Promise<string> {
  started ??= startDevServer({
    env: {
      KERNEL_ORIGIN: kernel.url.origin,
    },
    warmUpPaths: [],
  }).then((running) => {
    server = running;
    return running.origin;
  });
  return started;
}
afterAll(async () => {
  await browser?.close();
  kernel.stop(true);
  await server?.stop();
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
