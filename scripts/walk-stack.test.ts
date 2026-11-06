import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { acquireStackSlot } from './stack-lease.ts';
import { walkStackEnvironment, walkStackPortsAvailable } from './walk-stack.ts';
import { searchRunArgs } from '../services/kernel/scripts/search.ts';

test('walk stacks cap OpenSearch heap and disable mmap inside the host run slice', () => {
  const env = walkStackEnvironment('24256f23-7a74-4949-881c-7dbaea6b0207', 1);
  expect(env).toMatchObject({
    OPENSEARCH_JAVA_OPTS: '-Xms256m -Xmx256m',
    KERNEL_SEARCH_ALLOW_MMAP: '0',
  });
  const args = searchRunArgs('native-policy-test-image', env);
  const environment = args.flatMap((arg, i) => (arg === '-e' ? [args[i + 1]] : []));
  expect(environment).toContain('OPENSEARCH_JAVA_OPTS=-Xms256m -Xmx256m');
  expect(environment).toContain('node.store.allow_mmap=false');
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
