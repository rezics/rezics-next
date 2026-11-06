import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindWorkerFixtureOrigins,
  readSharedDevServer,
  sharedDevServerEnvName,
  workerFixtureBindingsCompatible,
  workerFixtureOverlay,
  writeSharedDevServer,
} from './dev-server-fixture.ts';

const temporary = mkdtempSync(join(tmpdir(), 'rezics-dev-server-fixture-'));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

test('workerFixtureOverlay copies only Worker bindings from the harness environment', () => {
  expect(
    workerFixtureOverlay({
      KERNEL_ORIGIN: 'http://kernel.test',
      PATH: '/bin',
      AUTH_ISSUER: '',
    }),
  ).toEqual({ KERNEL_ORIGIN: 'http://kernel.test', AUTH_ISSUER: '' });
  expect(workerFixtureOverlay({ PATH: '/bin' })).toBeUndefined();
});

test('startup bindings replace only the origin placeholders with the owned server origin', () => {
  expect(
    bindWorkerFixtureOrigins(
      {
        PUBLIC_ORIGIN: 'http://127.0.0.1:${port}',
        SITE_ORIGINS: 'https://site.test,http://localhost:undefined',
        KERNEL_ORIGIN: 'http://kernel.test',
      },
      'http://127.0.0.1:4312',
    ),
  ).toEqual({
    PUBLIC_ORIGIN: 'http://127.0.0.1:4312',
    SITE_ORIGINS: 'https://site.test,http://127.0.0.1:4312',
    KERNEL_ORIGIN: 'http://kernel.test',
  });
});

test('shared server reuse requires each requested Worker binding to match the immutable startup snapshot', () => {
  const startup = { KERNEL_ORIGIN: 'http://one.test', AUTH_ISSUER: 'https://auth.test' };
  expect(workerFixtureBindingsCompatible(undefined, startup)).toBe(true);
  expect(workerFixtureBindingsCompatible({ KERNEL_ORIGIN: 'http://one.test' }, startup)).toBe(true);
  expect(workerFixtureBindingsCompatible({ KERNEL_ORIGIN: 'http://two.test' }, startup)).toBe(false);
  expect(workerFixtureBindingsCompatible({ WEBSITE_CLIENT_ID: 'web' }, startup)).toBe(false);
});

test('shared server records retain the startup bindings and warmed dependency cache', () => {
  const path = join(temporary, 'dev-server.json');
  const record = {
    origin: 'http://127.0.0.1:4312',
    pid: 47,
    workerBindings: { KERNEL_ORIGIN: 'http://kernel.test' },
    cacheDirectory: '/tmp/vite-cache',
    lockHash: 'lock',
  };
  writeSharedDevServer(path, record);
  expect(readSharedDevServer(path)).toEqual(record);
  expect(sharedDevServerEnvName).toBe('WEB_TEST_DEV_SERVER');
});
