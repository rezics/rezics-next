import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { acquireStackSlot } from './stack-lease.ts';
import {
  firstRedactedDiagnostic,
  isStartupTransportError,
  kernelLaunchCommand,
  nativeJwksUrl,
  seedJournalDatabaseIdentity,
  seedJournalsNameDifferentDatabase,
  stackStartPlan,
  walkStackPortsAvailable,
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
  expect(firstRedactedDiagnostic('secret-line\nlater', ['secret-line'])).toBe('[redacted]');
});
