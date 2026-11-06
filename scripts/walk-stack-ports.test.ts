import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { acquireStackSlot } from './stack-lease.ts';
import {
  walkOriginListening,
  walkPortsAvailable,
  walkProcessEnvironment,
  walkReadyUrls,
  walkStackPorts,
  WALK_READY_FETCH_MS,
  WALK_READY_POLL_MS,
  WALK_PROCESS_STOP_MS,
  WALK_DOCKER_REMOVE_MS,
} from './walk-stack.ts';
import { cgroupArgs } from '../services/kernel/scripts/search.ts';

test('walk readiness waits on web, issuer and kernel without aborting a first compile', () => {
  const ports = walkStackPorts(5);
  expect(walkReadyUrls(ports)).toEqual([
    'http://127.0.0.1:20050/',
    'http://127.0.0.1:20051/',
    'http://127.0.0.1:20053/',
  ]);
  expect(WALK_READY_FETCH_MS).toBeGreaterThan(WALK_READY_POLL_MS);
  expect(WALK_READY_FETCH_MS).toBeGreaterThanOrEqual(120_000);
  expect(WALK_PROCESS_STOP_MS).toBeGreaterThan(WALK_READY_POLL_MS);
  expect(WALK_DOCKER_REMOVE_MS).toBeGreaterThanOrEqual(120_000);
});

test('readiness does not treat a closed port as a hung first compile', async () => {
  const started = performance.now();
  expect(await walkOriginListening('http://127.0.0.1:1/')).toBe(false);
  expect(performance.now() - started).toBeLessThan(2_000);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    expect(await walkOriginListening(`http://127.0.0.1:${port}/`)).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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

test('walk docker wrapper keeps attempt labels and omits the check-host cgroup', async () => {
  const directory = await mkdtemp(`${import.meta.dir}/../.temp/walk-docker-`);
  await writeFile(`${directory}/docker`, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  await chmod(`${directory}/docker`, 0o755);
  const wrapperDir = resolve(import.meta.dir, 'check-host');
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync(resolve(wrapperDir, 'docker'), ['run', '--name', 'walk-db', 'postgres'], {
      encoding: 'utf8',
      env: { PATH: `${wrapperDir}:${directory}:/usr/bin:/bin`, ...env },
    });
  try {
    const walk = run({
      REZICS_WALK_STACK_SLOT: '1',
      GOAL_TASK_ID: '6a6ca25b-b24d-431b-bc8f-615cef277eda',
      GOAL_ATTEMPT: '4',
    });
    expect(walk.status).toBe(0);
    expect(walk.stdout).toContain('rezics.worker.attempt=6a6ca25b-b24d-431b-bc8f-615cef277eda/4');
    expect(walk.stdout).not.toContain('--cgroup-parent=');
    const check = run({ REZICS_CHECK_SLICE: 'rezics-check.slice' });
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('--cgroup-parent=rezics-check.slice');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
