import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireWorkerFixture,
  readWorkerFixtureOverlay,
  workerFixtureEnvFile,
  workerFixtureLockDirectory,
  workerFixtureOverlay,
} from './dev-server-fixture.ts';

const temporary = mkdtempSync(join(tmpdir(), 'rezics-dev-server-fixture-'));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

test('workerFixtureOverlay copies only the Worker keys the file named', () => {
  expect(
    workerFixtureOverlay({
      KERNEL_ORIGIN: 'http://kernel.test',
      PATH: '/bin',
      AUTH_ISSUER: '',
      LOCAL_MEDIA_ORIGIN: '',
      LOCAL_MEDIA_TOKEN: '',
    }),
  ).toEqual({
    KERNEL_ORIGIN: 'http://kernel.test',
    AUTH_ISSUER: '',
    LOCAL_MEDIA_ORIGIN: '',
    LOCAL_MEDIA_TOKEN: '',
  });
  expect(workerFixtureOverlay({ PATH: '/bin' })).toBeUndefined();
});

test('an overlay lock serializes files and a later acquire replaces the previous env', async () => {
  const directory = join(temporary, 'overlay');
  const first = await acquireWorkerFixture(directory, { KERNEL_ORIGIN: 'http://one.test' });
  expect(existsSync(join(directory, workerFixtureLockDirectory))).toBe(true);
  expect(readWorkerFixtureOverlay(directory)).toEqual({ KERNEL_ORIGIN: 'http://one.test' });

  const second = acquireWorkerFixture(directory, { KERNEL_ORIGIN: 'http://two.test' }, { pollIntervalMs: 10 });
  await Bun.sleep(30);
  expect(JSON.parse(readFileSync(join(directory, workerFixtureEnvFile), 'utf8'))).toEqual({
    KERNEL_ORIGIN: 'http://one.test',
  });
  first();
  const releaseSecond = await second;
  expect(readWorkerFixtureOverlay(directory)).toEqual({ KERNEL_ORIGIN: 'http://two.test' });
  releaseSecond();
  expect(existsSync(join(directory, workerFixtureLockDirectory))).toBe(false);
  expect(readWorkerFixtureOverlay(directory)).toBeUndefined();
});
