import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { acquireStackSlot } from './stack-lease.ts';
import {
  dropFileCache,
  firstRedactedDiagnostic,
  hydrationMonitorMessage,
  isStartupTransportError,
  kernelLaunchCommand,
  nativeJwksUrl,
  publishedHostPorts,
  reclaimBytesFromStat,
  reclaimInactiveFileCache,
  releaseWalkFileCache,
  SEEDED_WEB_READY_PATH,
  seedJournalDatabaseIdentity,
  seedJournalsNameDifferentDatabase,
  stackStartPlan,
  waitUntilWalkReady,
  walkCgroupPath,
  walkDockerOutput,
  walkIssuerForward,
  walkOriginProbe,
  walkPageBodyIsUseful,
  walkParentInvocation,
  walkPortAllocated,
  walkReadyResponse,
  walkReadyUrls,
  walkReadyWaitingMessage,
  walkStackEnvironment,
  walkStackLogExcerpt,
  walkStackPorts,
  walkStackPortsAvailable,
  walkUrlNeedsHtml,
  walkUsefulPageResponse,
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
    walkParentInvocation({ REZICS_WALK_SMOL: '1' }, ['/pinned/bun', 'services/auth/scripts/dev-stack.ts', 'walk']),
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
  expect(source).toContain('Issuer JWKS through native Auth must answer before seed');
  const seed = await Bun.file(join(import.meta.dir, 'datasets/cross-media-seed.ts')).text();
  expect(seed).toContain('onDumpTableReleased: releaseWalkFileCache');
  expect(seed).toContain('seedFailureDetail');
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

test('a failed walk stack reprint drops DBOS chatter and keeps Kernel create errors', () => {
  const recorded = `{
  code: "dbos_diagnostic",
  operation: "workflow_runtime",
  severity: "info",
}
TypeError: Unsealed or mismatched native Semantic source set
{
  "code": "dbos_diagnostic",
  "operation": "workflow_runtime",
  "severity": "debug"
}
`;
  const excerpt = walkStackLogExcerpt(recorded);
  expect(excerpt).toContain('Unsealed or mismatched native Semantic source set');
  expect(excerpt).not.toContain('dbos_diagnostic');
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

test('seed journals that name another database are stale, and observed ECONNREFUSED is startup', () => {
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

test('a closed origin probe keeps the socket error instead of a boolean false', async () => {
  const result = await walkOriginProbe('http://127.0.0.1:1/');
  expect(result.listening).toBe(false);
  if (result.listening) throw new Error('expected a closed probe');
  expect(result.error.code).toBe('ECONNREFUSED');
});

test('untilReady retains observed probe, fetch and child-exit causes instead of inventing ECONNREFUSED', async () => {
  const url = 'http://127.0.0.1:20000/en';
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const timedOut = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });
  expect(walkReadyWaitingMessage({ kind: 'probe', url, error: refused })).toBe(`stack: hydration ${url} ECONNREFUSED`);
  expect(walkReadyWaitingMessage({ kind: 'probe', url, error: timedOut })).toBe(`stack: probe ${url} ETIMEDOUT`);
  expect(walkReadyWaitingMessage({ kind: 'probe', url, error: timedOut })).not.toContain('ECONNREFUSED');
  expect(walkReadyWaitingMessage({ kind: 'probe', url, error: new Error('listener closed') })).toBe(
    `stack: probe ${url} closed`,
  );
  expect(walkReadyWaitingMessage({ kind: 'fetch', url, status: 503 })).toBe(`stack: fetch ${url} HTTP 503`);
  expect(walkReadyWaitingMessage({ kind: 'child-exit', url, code: '1' })).toBe(
    `stack: child exited 1 waiting for ${url}`,
  );

  const reports: string[][] = [];
  await waitUntilWalkReady({
    urls: [url],
    children: [{ exitCode: null, signalCode: null }],
    deadlineMs: 5_000,
    pollMs: 0,
    probe: async () => ({ listening: false, error: timedOut }),
    fetchReady: async () => ({ ready: true }),
    report: (waiting) => reports.push(waiting),
    sleep: async () => {
      throw new Error('stop after the observed probe report');
    },
  }).catch((error: Error) => error);
  expect(reports[0]).toEqual([`stack: probe ${url} ETIMEDOUT`]);
  expect(JSON.stringify(reports)).not.toContain('ECONNREFUSED');

  const closed: string[][] = [];
  await waitUntilWalkReady({
    urls: [url],
    children: [{ exitCode: null, signalCode: null }],
    deadlineMs: 5_000,
    pollMs: 0,
    probe: async () => ({ listening: false, error: new Error('listener closed') }),
    fetchReady: async () => ({ ready: true }),
    report: (waiting) => closed.push(waiting),
    sleep: async () => {
      throw new Error('stop after the closed-listener report');
    },
  }).catch((error: Error) => error);
  expect(closed[0]).toEqual([`stack: probe ${url} closed`]);
  expect(JSON.stringify(closed)).not.toContain('ECONNREFUSED');

  await expect(
    waitUntilWalkReady({
      urls: [url],
      children: [{ exitCode: 7, signalCode: null }],
      probe: async () => ({ listening: true }),
      fetchReady: async () => ({ ready: true }),
    }),
  ).rejects.toThrow('walk: the local stack exited (7) before it was ready');

  const fetches: string[][] = [];
  await waitUntilWalkReady({
    urls: [url],
    children: [{ exitCode: null, signalCode: null }],
    deadlineMs: 5_000,
    pollMs: 0,
    probe: async () => ({ listening: true }),
    fetchReady: async () => ({ ready: false, status: 503 }),
    report: (waiting) => fetches.push(waiting),
    sleep: async () => {
      throw new Error('stop after the fetch report');
    },
  }).catch((error: Error) => error);
  expect(fetches[0]).toEqual([`stack: fetch ${url} HTTP 503`]);
  expect(JSON.stringify(fetches)).not.toContain('ECONNREFUSED');
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
