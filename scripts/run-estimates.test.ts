import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  invocationKey,
  MAX_RUN_ESTIMATES,
  readEstimate,
  recordEstimate,
  RUN_ESTIMATES_FILE,
  runEstimatesDirectory,
  type RunEstimate,
} from './run-estimates.ts';

const repository = resolve(import.meta.dir, '..');
const directories: string[] = [];

function temporaryDirectory(): string {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/run-estimates-test-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('invocation keys sort file filters and preserve cwd and remaining flag order', () => {
  const root = join(temporaryDirectory(), 'checkout');
  const cwd = join(root, 'services');
  const first = invocationKey(root, cwd, ['test/b.test.ts', '--timeout', '1000', 'test/a.test.ts', '--bail', '2']);
  const reorderedFiles = invocationKey(root, cwd, [
    'test/a.test.ts',
    '--timeout',
    '1000',
    'test/b.test.ts',
    '--bail',
    '2',
  ]);
  const reorderedFlags = invocationKey(root, cwd, [
    'test/a.test.ts',
    '--bail',
    '2',
    'test/b.test.ts',
    '--timeout',
    '1000',
  ]);

  expect(first).toBe(reorderedFiles);
  expect(first).toBe(
    invocationKey(root, 'services', ['test/a.test.ts', '--timeout', '1000', 'test/b.test.ts', '--bail', '2']),
  );
  expect(first).not.toBe(reorderedFlags);
  expect(invocationKey(root, root, ['test/a.test.ts', 'test/b.test.ts'])).not.toBe(
    invocationKey(root, cwd, ['test/a.test.ts', 'test/b.test.ts']),
  );
});

test('the record keeps at most 2000 invocations, newest first', () => {
  const directory = temporaryDirectory();
  const firstTime = Date.UTC(2026, 0, 1);
  for (let index = 0; index <= MAX_RUN_ESTIMATES; index++) {
    recordEstimate(directory, `run-${index}`, index, new Date(firstTime + index));
  }

  const record = JSON.parse(readFileSync(join(directory, RUN_ESTIMATES_FILE), 'utf8')) as {
    invocations: RunEstimate[];
  };
  expect(record.invocations).toHaveLength(MAX_RUN_ESTIMATES);
  expect(record.invocations[0]?.invocation).toBe(`run-${MAX_RUN_ESTIMATES}`);
  expect(record.invocations.at(-1)?.invocation).toBe('run-1');
  expect(readEstimate(directory, 'run-0')).toBeUndefined();
  expect(readEstimate(directory, `run-${MAX_RUN_ESTIMATES}`)).toBe(MAX_RUN_ESTIMATES);
});

test('an unreadable or concurrently replaced record gives no estimate and never throws', () => {
  const directory = temporaryDirectory();
  const unreadablePath = join(directory, RUN_ESTIMATES_FILE);
  mkdirSync(unreadablePath);
  expect(readEstimate(directory, 'previous-run')).toBeUndefined();
  expect(() => recordEstimate(directory, 'current-run', 12)).not.toThrow();

  rmSync(unreadablePath, { recursive: true });
  recordEstimate(directory, 'previous-run', 91);
  // A concurrent writer replacing the JSON with an incomplete file is treated like a cache miss.
  writeFileSync(unreadablePath, '{');
  expect(readEstimate(directory, 'previous-run')).toBeUndefined();
  expect(() => recordEstimate(directory, 'current-run', 12)).not.toThrow();
});

test('a checkout without Git metadata has no estimates directory', () => {
  const checkout = temporaryDirectory();
  const requestedDirectory = join(checkout, 'estimates');
  const previousGitDirectory = process.env.GIT_DIR;
  process.env.GIT_DIR = join(checkout, 'missing-git-directory');

  try {
    expect(runEstimatesDirectory(checkout, requestedDirectory)).toBeNull();
    expect(existsSync(requestedDirectory)).toBe(false);
  } finally {
    if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDirectory;
  }
});

test('the shared estimates directory is beside the Git common directory', () => {
  const commonDirectory = Bun.spawnSync(
    ['git', '-C', repository, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(commonDirectory.exitCode).toBe(0);
  expect(runEstimatesDirectory(repository)).toBe(
    resolve(dirname(commonDirectory.stdout.toString().trim()), '.temp/check-estimates'),
  );
});
