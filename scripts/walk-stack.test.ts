import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { acquireStackSlot } from './stack-lease.ts';
import {
  dropFileCache,
  publishedHostPorts,
  reclaimBytesFromStat,
  reclaimInactiveFileCache,
  releaseWalkFileCache,
  walkCgroupPath,
  walkDockerOutput,
  walkIssuerForward,
  walkParentInvocation,
  walkPortAllocated,
  walkReadyUrls,
  walkStackEnvironment,
  walkStackPorts,
  walkStackPortsAvailable,
} from './walk-stack.ts';
import { databaseRunArgs } from '../services/kernel/scripts/database.ts';
import { searchRunArgs } from '../services/kernel/scripts/search.ts';

test('walk stacks cap OpenSearch, Postgres and bun heaps inside the host run slice', () => {
  const env = walkStackEnvironment('24256f23-7a74-4949-881c-7dbaea6b0207', 1);
  expect(env).toMatchObject({
    OPENSEARCH_JAVA_OPTS: '-Xms128m -Xmx128m',
    KERNEL_SEARCH_ALLOW_MMAP: '0',
    KERNEL_SEARCH_MEMORY: '768m',
    KERNEL_DATABASE_MEMORY: '384m',
    KERNEL_DATABASE_BOUNDED: '1',
    KERNEL_WORKER_POOL_SIZE: '1',
    REZICS_WALK_SMOL: '1',
    REZICS_WALK_DEFER_FRONTENDS: '1',
    MALLOC_ARENA_MAX: '2',
  });
  expect(walkReadyUrls(walkStackPorts(1), env)).toEqual([
    'http://127.0.0.1:20012/.well-known/jwks.json',
    'http://127.0.0.1:20013/health',
  ]);
  expect(walkReadyUrls(walkStackPorts(1), {})).toEqual([
    'http://127.0.0.1:20010/',
    'http://127.0.0.1:20011/',
    'http://127.0.0.1:20013/',
  ]);
  const search = searchRunArgs('native-policy-test-image', env);
  const environment = search.flatMap((arg, i) => (arg === '-e' ? [search[i + 1]] : []));
  expect(environment).toContain('OPENSEARCH_JAVA_OPTS=-Xms128m -Xmx128m');
  expect(environment).toContain('node.store.allow_mmap=false');
  expect(search).toContain('--memory');
  expect(search[search.indexOf('--memory') + 1]).toBe('768m');
  expect(search[search.indexOf('--memory-swap') + 1]).toBe('768m');
  const database = databaseRunArgs(env);
  expect(database[database.indexOf('--memory') + 1]).toBe('384m');
  expect(database[database.indexOf('--memory-swap') + 1]).toBe('384m');
  expect(database).toContain('shared_buffers=32MB');
  expect(database).toContain('max_connections=50');
  expect(searchRunArgs('native-policy-test-image', {})).not.toContain('--memory');
  expect(databaseRunArgs({})).not.toContain('--memory');
  expect(() => searchRunArgs('native-policy-test-image', { KERNEL_SEARCH_MEMORY: '1g' })).toThrow(
    'KERNEL_SEARCH_MEMORY',
  );
});

test('the walk parent and Docker teardown stay inside the 6 GiB slice', () => {
  expect(
    walkParentInvocation({}, ['/pinned/bun', 'services/auth/scripts/dev-stack.ts', 'walk', '--', 'true']),
  ).toEqual(['/pinned/bun', '--smol', 'services/auth/scripts/dev-stack.ts', 'walk', '--', 'true']);
  expect(
    walkParentInvocation({ REZICS_WALK_SMOL: '1' }, [
      '/pinned/bun',
      'services/auth/scripts/dev-stack.ts',
      'walk',
    ]),
  ).toBeUndefined();
  expect(walkParentInvocation({}, ['/pinned/bun', '--smol', 'services/auth/scripts/dev-stack.ts', 'walk'])).toBeUndefined();
  expect(walkDockerOutput({ status: 0, stdout: 'abc\n' })).toBe('abc');
  expect(walkDockerOutput({ status: null, stdout: '' })).toBe('');
  expect(walkDockerOutput({ status: 1, stdout: 'ignored' })).toBe('');
  expect(() => reclaimInactiveFileCache(1024)).not.toThrow();
  expect(() => dropFileCache('/tmp/rezics-walk-missing-dump')).not.toThrow();
  expect(() => releaseWalkFileCache()).not.toThrow();
  expect(reclaimBytesFromStat('anon 100\ninactive_file 2147483648\nactive_file 10\n')).toBe(2147483648);
  expect(reclaimBytesFromStat('inactive_file 0\n')).toBe(0);
  expect(reclaimBytesFromStat('anon 99\n')).toBe(0);
  expect(reclaimBytesFromStat('inactive_file 8589934592\n', 4096)).toBe(4096);
  expect(walkCgroupPath('0::/user.slice/rezics-check-run_1.slice/job.scope', 'rezics-check-run_1.slice')).toBe(
    '/user.slice/rezics-check-run_1.slice',
  );
  expect(walkCgroupPath('0::/user.slice/job.scope')).toBe('/user.slice/job.scope');
});

test('the seeded walk loads Playwright, the worker and the Kernel client only after dump import', async () => {
  const source = await Bun.file(join(import.meta.dir, '../apps/web/scripts/vndb-seeded-journey.ts')).text();
  expect(source.includes("from 'playwright/test'")).toBe(false);
  expect(source.includes("from '@rezics/client'")).toBe(false);
  expect(source).toContain("await import('playwright')");
  expect(source).toContain("await import('playwright/test')");
  expect(source).toContain("await import('@rezics/client')");
  expect(source).toContain("spawn('worker')");
  expect(source).toContain('releaseWalkFileCache');
  const seed = await Bun.file(join(import.meta.dir, 'datasets/cross-media-seed.ts')).text();
  expect(seed).toContain('onDumpTableReleased: releaseWalkFileCache');
});

test('walk issuer forwarding keeps POST bodies for native Auth', async () => {
  const request = new Request('http://127.0.0.1:20011/signin/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:20011' },
    body: JSON.stringify({ account_id: '99e7b230-90dd-83ae-b5dc-67cacb45ae35' }),
  });
  const forwarded = walkIssuerForward(request, 'http://127.0.0.1:20012');
  expect(forwarded.url).toBe('http://127.0.0.1:20012/signin/key');
  expect(forwarded.method).toBe('POST');
  expect(forwarded.headers.get('origin')).toBe('http://127.0.0.1:20011');
  expect(await forwarded.json()).toEqual({ account_id: '99e7b230-90dd-83ae-b5dc-67cacb45ae35' });
});

test('Docker published mappings occupy a walk slot even when nothing is listening', () => {
  expect(
    publishedHostPorts('127.0.0.1:20014->5432/tcp\n127.0.0.1:20015->9200/tcp, 127.0.0.1:20020->80/tcp'),
  ).toEqual(new Set([20014, 20015, 20020]));
  expect(publishedHostPorts('[::]:20014->5432/tcp')).toEqual(new Set([20014]));
  expect(publishedHostPorts('5432/tcp')).toEqual(new Set());
  expect(
    walkPortAllocated(
      'docker: Error response from daemon: Bind for 127.0.0.1:20014 failed: port is already allocated.',
    ),
  ).toBe(true);
  expect(walkPortAllocated('walk: services/kernel/scripts/database.ts up failed')).toBe(false);
});

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
