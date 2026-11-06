import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { acquireStackSlot } from './stack-lease.ts';
import {
  publishedHostPorts,
  walkPortAllocated,
  walkStackEnvironment,
  walkStackPortsAvailable,
} from './walk-stack.ts';
import { databaseRunArgs } from '../services/kernel/scripts/database.ts';
import { searchRunArgs } from '../services/kernel/scripts/search.ts';

test('walk stacks cap OpenSearch, Postgres and bun heaps inside the host run slice', () => {
  const env = walkStackEnvironment('24256f23-7a74-4949-881c-7dbaea6b0207', 1);
  expect(env).toMatchObject({
    OPENSEARCH_JAVA_OPTS: '-Xms128m -Xmx128m',
    KERNEL_SEARCH_ALLOW_MMAP: '0',
    KERNEL_SEARCH_MEMORY: '512m',
    KERNEL_DATABASE_MEMORY: '384m',
    KERNEL_DATABASE_BOUNDED: '1',
    KERNEL_WORKER_POOL_SIZE: '4',
    REZICS_WALK_SMOL: '1',
  });
  const search = searchRunArgs('native-policy-test-image', env);
  const environment = search.flatMap((arg, i) => (arg === '-e' ? [search[i + 1]] : []));
  expect(environment).toContain('OPENSEARCH_JAVA_OPTS=-Xms128m -Xmx128m');
  expect(environment).toContain('node.store.allow_mmap=false');
  expect(search).toContain('--memory');
  expect(search[search.indexOf('--memory') + 1]).toBe('512m');
  expect(search[search.indexOf('--memory-swap') + 1]).toBe('512m');
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
  const env = { REZICS_STACK_LEASE_DIR: directory, REZICS_STACK_SLOTS: '2' };
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
