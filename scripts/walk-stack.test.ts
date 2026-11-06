import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { acquireStackSlot } from './stack-lease.ts';
import {
  firstRedactedDiagnostic,
  hydrationMonitorMessage,
  isStartupTransportError,
  kernelLaunchCommand,
  nativeJwksUrl,
  SEEDED_WEB_READY_PATH,
  seedJournalDatabaseIdentity,
  seedJournalsNameDifferentDatabase,
  stackStartPlan,
  walkPageBodyIsUseful,
  walkReadyResponse,
  walkStackPortsAvailable,
  walkUrlNeedsHtml,
  walkUsefulPageResponse,
} from './walk-stack.ts';

test('walk admission preserves an occupied slot and reuses it after its listener closes', async () => {
  const directory = await mkdtemp(join(import.meta.dir, '../.temp/walk-admission-'));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  const env = {
    REZICS_STACK_LEASE_DIR: directory,
    REZICS_STACK_SLOTS: '2',
    KERNEL_CHECK_REMOTE: join(directory, 'no-such-hosts.json'),
  };
  const available = (index: number) =>
    walkStackPortsAvailable({ web: 0, issuer: 0, native: 0, kernel: 0, database: 0, search: index === 1 ? port : 0 });
  try {
    const second = await acquireStackSlot('walk recovery', env, 1, undefined, 60_000, undefined, available);
    try {
      expect(second.index).toBe(2);
      expect(listener.listening).toBe(true);
    } finally {
      await second.release();
    }
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    const first = await acquireStackSlot('walk recovery', env, 1, undefined, 60_000, undefined, available);
    try {
      expect(first.index).toBe(1);
    } finally {
      await first.release();
    }
  } finally {
    if (listener.listening) listener.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('admitted stacks launch Kernel without watch, fetch JWKS from native Auth, and defer pages', () => {
  const origins = {
    web: 'http://127.0.0.1:20000',
    issuer: 'http://127.0.0.1:20001',
    native: 'http://127.0.0.1:20002',
    kernel: 'http://127.0.0.1:20003',
  };
  const admitted = stackStartPlan({ REZICS_WALK_STACK_SLOT: '3' }, origins);
  expect(admitted.deferPages).toBe(true);
  expect(admitted.kernel).toEqual([process.execPath, 'run', '--cwd', 'services/kernel', 'start']);
  expect(admitted.nativeReady).toEqual([nativeJwksUrl(origins.native)]);
  expect(admitted.kernelReady).toEqual(['http://127.0.0.1:20003/v1/definitions']);
  expect(kernelLaunchCommand({})).toEqual([process.execPath, 'run', '--cwd', 'services/kernel', 'dev']);
  expect(stackStartPlan({}, origins).deferPages).toBe(false);
});

test('seed journals that name another database are stale, and ECONNREFUSED is startup', () => {
  const current = seedJournalDatabaseIdentity('postgres://rezics:rezics@127.0.0.1:20024/rezics');
  expect(current).toBe('127.0.0.1:20024/rezics');
  expect(seedJournalsNameDifferentDatabase('127.0.0.1:54329/rezics', current)).toBe(true);
  expect(seedJournalsNameDifferentDatabase(current, current)).toBe(false);
  expect(seedJournalsNameDifferentDatabase(undefined, current)).toBe(false);
  expect(isStartupTransportError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(
    true,
  );
  expect(
    hydrationMonitorMessage(
      'http://127.0.0.1:20000/en',
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ),
  ).toBe('stack: hydration http://127.0.0.1:20000/en ECONNREFUSED');
  expect(firstRedactedDiagnostic('secret-line\nlater', ['secret-line'])).toBe('[redacted]');
});

test('seeded Web is ready only on useful /en HTML, not a Vite missing-module overlay', async () => {
  expect(SEEDED_WEB_READY_PATH).toBe('/en');
  expect(walkUrlNeedsHtml('http://127.0.0.1:20000/en')).toBe(true);
  expect(walkUrlNeedsHtml('http://127.0.0.1:20002/.well-known/jwks.json')).toBe(false);
  expect(walkPageBodyIsUseful('<html><body>Home</body></html>')).toBe(true);
  expect(
    walkPageBodyIsUseful(
      '<html>Failed to resolve import "messages/access_account.js" ENOENT: no such file or directory</html>',
    ),
  ).toBe(false);
  const overlay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response('<html>Failed to resolve import "messages/access_account.js"</html>', {
        headers: { 'content-type': 'text/html' },
      }),
  });
  const page = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('<html><body>en home</body></html>', { headers: { 'content-type': 'text/html' } }),
  });
  const jwks = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('{"keys":[]}', { headers: { 'content-type': 'application/json' } }),
  });
  try {
    expect(await walkUsefulPageResponse(`http://127.0.0.1:${overlay.port}/en`)).toBe(false);
    expect(await walkUsefulPageResponse(`http://127.0.0.1:${page.port}/en`)).toBe(true);
    expect(await walkReadyResponse(`http://127.0.0.1:${jwks.port}/.well-known/jwks.json`)).toBe(true);
  } finally {
    await overlay.stop(true);
    await page.stop(true);
    await jwks.stop(true);
  }
});
