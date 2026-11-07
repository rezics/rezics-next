import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  commandNeedsSharedDevServer,
  privateNetworkCommand,
  runOwnedCommand,
  sharedViteChildEnvironment,
  walkViteChildEnvironment,
  webTestPrivateNetworkEnvName,
} from '../scripts/with-dev-server.ts';
import { readExampleWorkerVars } from '../scripts/dev-vars.ts';
import { processIdentity } from './support/server-custody.ts';

async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename?.toString() !== basename(path) || !existsSync(path)) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`Timed out waiting for child process marker ${path}`));
    }, 10_000);
    if (existsSync(path)) {
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
  });
}

test('the shared Vite child fills example Worker bindings without replacing a caller value', () => {
  const example = readExampleWorkerVars();
  expect(example.WEBSITE_CLIENT_KEY).toContain('"kty":"EC"');
  const filled = sharedViteChildEnvironment({ PATH: '/bin' });
  expect(filled.WEBSITE_CLIENT_KEY).toBe(example.WEBSITE_CLIENT_KEY);
  expect(filled.CLOUDFLARE_VITE_FORCE_LOCAL).toBe('true');
  expect(filled.CLOUDFLARE_CF_FETCH_ENABLED).toBe('false');
  expect(filled.REZICS_TEST_RUNTIME).toBe('1');
  expect(filled.WEB_VITE_CACHE_DIR).toBeUndefined();

  const caller = sharedViteChildEnvironment(
    { WEBSITE_CLIENT_KEY: 'from-caller', WEB_TEST_STATE_DIR: '/tmp/state' },
    { cacheDirectory: '/tmp/vite-cache' },
  );
  expect(caller.WEBSITE_CLIENT_KEY).toBe('from-caller');
  expect(caller.WEB_TEST_STATE_DIR).toBe('/tmp/state');
  expect(caller.WEB_VITE_CACHE_DIR).toBe('/tmp/vite-cache');
  expect(caller.CLOUDFLARE_VITE_FORCE_LOCAL).toBe('true');
  expect(caller.CLOUDFLARE_CF_FETCH_ENABLED).toBe('false');
});

test('walk Vite keeps Cloudflare local without test runtime, fixture bindings or a heap override', () => {
  const child = walkViteChildEnvironment(
    {
      PATH: '/bin',
      REZICS_TEST_RUNTIME: '1',
      NODE_OPTIONS: '--max-old-space-size=8192',
      WEBSITE_CLIENT_KEY: 'from-caller',
    },
    { cacheDirectory: '/tmp/walk-vite' },
  );
  expect(child.REZICS_TEST_RUNTIME).toBeUndefined();
  expect(child.CLOUDFLARE_VITE_FORCE_LOCAL).toBe('true');
  expect(child.CLOUDFLARE_CF_FETCH_ENABLED).toBe('false');
  expect(child.WEB_VITE_CACHE_DIR).toBe('/tmp/walk-vite');
  expect(child.WEBSITE_CLIENT_KEY).toBe('from-caller');
  expect(child.NODE_OPTIONS).toBe('--max-old-space-size=8192');
});

test('first-public journey source pins do not start a shared Vite server', () => {
  expect(commandNeedsSharedDevServer(['bun', 'test', 'tests/first-public-journeys-walk.test.ts'])).toBe(false);
  expect(
    commandNeedsSharedDevServer(['bun', 'test', '--max-concurrency=1', 'tests/first-public-journeys-walk.test.ts']),
  ).toBe(false);
  expect(commandNeedsSharedDevServer(['bun', 'test', 'apps/web/tests/first-public-journeys-walk.test.ts'])).toBe(false);
  expect(commandNeedsSharedDevServer(['bun', 'test', 'tests/with-dev-server.test.ts'])).toBe(false);
  expect(commandNeedsSharedDevServer(['bun', 'test', 'tests/search.test.ts'])).toBe(true);
  expect(
    commandNeedsSharedDevServer(['bun', 'test', 'tests/first-public-journeys-walk.test.ts', 'tests/search.test.ts']),
  ).toBe(true);
  expect(commandNeedsSharedDevServer(['bun', 'test'])).toBe(true);
});

test('private-network wrapping keeps the original command after the namespace setup', () => {
  expect(privateNetworkCommand(['bun', 'test', 'tests/search.test.ts'])).toEqual([
    'unshare',
    '--user',
    '--map-root-user',
    '--net',
    'sh',
    '-c',
    'ip link set lo up && exec "$@"',
    'sh',
    'bun',
    'test',
    'tests/search.test.ts',
  ]);
  expect(webTestPrivateNetworkEnvName).toBe('WEB_TEST_PRIVATE_NETWORK');
});

test('cancellation settles the Web startup child and descendants through the existing wrapper owner', async () => {
  if (process.platform !== 'linux') return;
  const directory = mkdtempSync(join(tmpdir(), 'web-dev-server-cancel-'));
  const pidFile = join(directory, 'descendant.pid');
  const abort = new AbortController();
  const startupRunner = new URL('../scripts/web-startup.ts', import.meta.url).href;
  const childScript = `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const script = `
    import { runWebStartupChild } from ${JSON.stringify(startupRunner)};
    const interruption = new AbortController();
    process.on('SIGTERM', () => interruption.abort('SIGTERM'));
    await runWebStartupChild(process.execPath, ['-e', ${JSON.stringify(childScript)}], process.cwd(), {
      env: process.env,
      signal: interruption.signal,
    });
  `;
  let running: Promise<number> | undefined;
  try {
    running = runOwnedCommand([process.execPath, '-e', script], {
      cwd: join(import.meta.dir, '..'),
      env: process.env,
      signal: abort.signal,
      label: 'test wrapper child tree',
    });
    await waitForFile(pidFile);
    const descendant = Number(readFileSync(pidFile, 'utf8'));
    abort.abort('SIGTERM');
    expect(await running).toBe(143);
    const identity = processIdentity(descendant);
    expect(identity === undefined || identity.state === 'Z').toBe(true);
  } finally {
    abort.abort('SIGTERM');
    try {
      await running;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 15_000);

test('server-independent suites do not start an unused default server', () => {
  expect(commandNeedsSharedDevServer(['bun', 'test', 'tests/check-lanes.test.ts'])).toBe(false);
  expect(commandNeedsSharedDevServer(['bun', 'test', 'tests/post-editing.test.ts'])).toBe(false);
  expect(commandNeedsSharedDevServer(['bun', 'test', '--max-concurrency=1', 'tests/post-editing.test.ts'])).toBe(false);
  expect(
    commandNeedsSharedDevServer(['bun', 'test', 'tests/root-application-shell.test.tsx', 'tests/post-editing.test.ts']),
  ).toBe(false);
  expect(
    commandNeedsSharedDevServer(['bun', 'test', 'tests/post-editing.test.ts', 'tests/thread-reading.test.ts']),
  ).toBe(true);
  expect(commandNeedsSharedDevServer(['bun', 'test', 'tests'])).toBe(true);
  expect(commandNeedsSharedDevServer(['bun', 'test'])).toBe(true);
});
