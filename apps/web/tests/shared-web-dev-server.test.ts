import { expect, test } from 'bun:test';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer } from './support/dev-server.ts';
import { readSharedDevServer } from './support/dev-server-fixture.ts';

const testsRoot = dirname(fileURLToPath(import.meta.url));
const nativePattern = /(?:^|\/)native\//;
const independentViteSpawn = /spawn\(\s*(?:['"]bun['"]|process\.execPath)[\s\S]{0,400}?['"]run['"]\s*,\s*['"]dev['"]/;

test('migrated Web files acquire the helper and no longer copy a Vite spawn/readiness loop', async () => {
  const remaining: string[] = [];
  const missingHelper: string[] = [];
  for (const file of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: testsRoot })) {
    if (nativePattern.test(file) || file.startsWith('support/vite-dep-cache')) continue;
    if (file === 'support/dev-server.ts' || file === 'worker-persistence-isolation.test.ts') continue;
    const source = await Bun.file(join(testsRoot, file)).text();
    if (!independentViteSpawn.test(source) && !source.includes('startDevServer(')) continue;
    if (independentViteSpawn.test(source)) remaining.push(file);
    if (source.includes('startDevServer(') && !/from ['"][^'"]*dev-server/.test(source)) missingHelper.push(file);
  }
  expect(remaining, remaining.join('\n')).toEqual([]);
  expect(missingHelper, missingHelper.join('\n')).toEqual([]);
}, 30_000);

test('a composed run advertises one server that files acquire with independent fixture overlay', async () => {
  const record = readSharedDevServer();
  if (!record) return;
  const first = await startDevServer({ warmUpPaths: [], firstPath: '/en' });
  expect(first.shared).toBe(true);
  expect(first.origin).toBe(record.origin);
  expect(first.pid).toBe(record.pid);
  const page = await fetch(`${first.origin}/en`, { redirect: 'manual' });
  await page.body?.cancel();
  expect(page.status).toBeLessThan(500);
  await first.stop();
  const second = await startDevServer({
    warmUpPaths: [],
    firstPath: '/en',
    env: { KERNEL_ORIGIN: 'http://overlay.example.test' },
  });
  expect(second.shared).toBe(true);
  expect(second.pid).toBe(record.pid);
  await second.stop();
  expect(readSharedDevServer()?.pid).toBe(record.pid);
});

test('the owning warm launch records a monotonic /en time under 20 seconds', () => {
  const measured = process.env.WEB_TEST_DEV_SERVER_FIRST_EN_MS;
  if (!measured) return;
  const elapsed = Number(measured);
  expect(Number.isFinite(elapsed)).toBe(true);
  expect(elapsed).toBeGreaterThan(0);
  expect(elapsed).toBeLessThan(20_000);
  console.info(
    `[shared-web-dev-server] host=${hostname()} revision=${process.env.GOAL_SOURCE_REVISION ?? 'local'} lock=${process.env.WEB_TEST_DEV_SERVER_LOCK} cache=${process.env.WEB_TEST_DEV_SERVER_CACHE} first-en-ms=${elapsed}`,
  );
});
