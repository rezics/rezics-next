import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { acquireStackSlot } from './stack-lease.ts';
import { walkPortsAvailable, walkProcessEnvironment } from './walk-stack.ts';
import { cgroupArgs } from '../services/kernel/scripts/search.ts';

test('walk process environment does not inherit check-host cgroup placement', () => {
  const env = walkProcessEnvironment('6a6ca25b-b24d-431b-bc8f-615cef277eda', 3, {
    KERNEL_CHECK_ON_REMOTE: '1',
    REZICS_CHECK_SLICE: 'rezics-check.slice',
    PATH: '/bin',
  });
  expect(env.KERNEL_CHECK_ON_REMOTE).toBeUndefined();
  expect(env.REZICS_WALK_STACK_SLOT).toBe('3');
  expect(cgroupArgs(env)).toEqual([]);
});

test('walk admission skips a foreign listener and leaves it running after releasing its own slot', async () => {
  const foreign = createServer();
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  const port = (foreign.address() as AddressInfo).port;
  const directory = await mkdtemp(`${import.meta.dir}/../.temp/walk-port-test-`);
  const slot = await acquireStackSlot(
    'walk ports',
    { REZICS_STACK_LEASE_DIR: directory, REZICS_STACK_SLOTS: '2' },
    1,
    undefined,
    undefined,
    undefined,
    (index) => walkPortsAvailable([index === 1 ? port : 0]),
  );
  try {
    expect(slot.index).toBe(2);
    expect(foreign.listening).toBe(true);
    expect(await walkPortsAvailable([0, port])).toBe(false);
  } finally {
    await slot.release();
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
  expect(await walkPortsAvailable([port])).toBe(true);
});
