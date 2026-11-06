import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { chromium, type Browser } from 'playwright';
import fixtures from '../src/kernel/fixtures.json';
import { startDevServer } from './support/dev-server.ts';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const temporary = join(root, '.temp');
mkdirSync(temporary, { recursive: true });
const storybookOutput = mkdtempSync(join(temporary, 'dev-dependencies-storybook-'));
const storybook = join(app, 'node_modules/.bin/storybook');
const subjectId = fixtures.subjects[0]!.id;
const paths = ['/en', `/en/subjects/${subjectId}`, '/en/search', '/en/library'];

let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let browser: Browser | undefined;
let staticServer: ReturnType<typeof Bun.serve> | undefined;

async function launchForcedDevServer(): Promise<string> {
  server = await startDevServer({
    exclusive: true,
    cwd: app,
    command: ({ port }) => [
      'bun',
      'run',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
      '--force',
    ],
    warmUpPaths: [],
  });
  return server.origin;
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
  await server?.stop();
  rmSync(storybookOutput, { recursive: true, force: true });
});

test('the cold client optimizer serves first page loads without reloads or unresolved dependencies', async () => {
  const origin = await launchForcedDevServer();
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

  const output = server?.diagnostics() ?? '';
  expect(output).not.toMatch(/Failed to resolve dependency|Cannot optimize dependency/i);
  expect(output).not.toMatch(/optimized dependencies changed\. reloading/i);
}, 900_000);

test('Storybook builds and serves a page story with the development optimizer configuration', async () => {
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
  const homeStories = Object.values(index.entries).filter(
    (entry) => entry.type === 'story' && basename(entry.importPath) === 'home.stories.tsx',
  );
  const home = homeStories.find((entry) => entry.name === 'Signed Out · 0 Continue · 1280 desktop');
  expect(
    home,
    `the built Storybook includes the signed-out desktop Home story; indexed Home stories: ${homeStories
      .map(({ id, name }) => `${id} (${name})`)
      .join(', ')}`,
  ).toBeDefined();

  const storyBrowser = browser ?? (browser = await chromium.launch());
  const context = await storyBrowser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/iframe.html?id=${home!.id}&viewMode=story`, { waitUntil: 'networkidle' });
  await page.getByRole('main').waitFor();
  await context.close();
}, 900_000);
