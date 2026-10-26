import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  laneConcurrency,
  orderFiles,
  readLatest,
  runLaneSuite,
  scheduleFiles,
  timingsDirectory,
  writeTimings,
  type FileTiming,
} from './test-lanes.ts';

const root = resolve(import.meta.dir, '..');

async function withDirectory(use: (directory: string) => Promise<void>): Promise<void> {
  mkdirSync(resolve(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(resolve(root, '.temp', 'test-lanes-'));
  try {
    await use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const timing = (wall: number): FileTiming => ({ wall, create: 0, drop: 0, outsideTests: 0, result: 'pass', tests: [] });

test('each check names its clones, timings and variables after its service', () => {
  expect(timingsDirectory('auth', import.meta.dir, { AUTH_CHECK_TIMINGS: '/elsewhere' })).toBe('/elsewhere');
  expect(timingsDirectory('auth', import.meta.dir, { KERNEL_CHECK_TIMINGS: '/elsewhere' })).toMatch(
    /\/\.temp\/auth-check\/timings$/,
  );
  expect(orderFiles('auth', ['b', 'a'], { b: timing(1), a: timing(2) }, {})).toEqual(['a', 'b']);
  expect(orderFiles('auth', ['b', 'a'], { b: timing(1), a: timing(2) }, { AUTH_CHECK_ORDER: 'name' })).toEqual([
    'a',
    'b',
  ]);
  expect(orderFiles('kernel', ['b', 'a'], { b: timing(1), a: timing(2) }, { AUTH_CHECK_ORDER: 'name' })).toEqual([
    'a',
    'b',
  ]);
});

test('the lane count is six unless the service names another positive integer', () => {
  expect(laneConcurrency('auth', {})).toBe(6);
  expect(laneConcurrency('auth', { AUTH_CHECK_CONCURRENCY: '3' })).toBe(3);
  expect(laneConcurrency('auth', { KERNEL_CHECK_CONCURRENCY: '3' })).toBe(6);
  expect(() => laneConcurrency('auth', { AUTH_CHECK_CONCURRENCY: '0' })).toThrow(/AUTH_CHECK_CONCURRENCY/);
  expect(() => laneConcurrency('kernel', { KERNEL_CHECK_CONCURRENCY: 'many' })).toThrow(/KERNEL_CHECK_CONCURRENCY/);
});

test('clones take the given prefix and are all dropped, a failed file included', async () => {
  const created: string[] = [];
  const dropped: string[] = [];
  const outcomes = await scheduleFiles('auth_test', ['a', 'b', 'c'], 2, {
    create: (_file, database) => void created.push(database),
    run: (file) => {
      if (file === 'b') throw new Error('failed');
    },
    drop: (_file, database) => void dropped.push(database),
  });
  expect(created.sort()).toEqual(['auth_test_1', 'auth_test_2', 'auth_test_3']);
  expect(dropped.sort()).toEqual(created.sort());
  expect(outcomes.map((outcome) => outcome.error?.message)).toEqual([undefined, 'failed', undefined]);
});

test('a suite runs each file in its own bun test process on its own clone, longest first, and records timings', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    const timings = resolve(directory, 'timings');
    mkdirSync(resolve(module, 'test'), { recursive: true });
    const names = ['slow', 'fast', 'unknown'];
    for (const name of names) {
      writeFileSync(
        resolve(module, `test/${name}.test.ts`),
        `import { expect, test } from 'bun:test';
test('${name} sees its own clone', () => {
  expect(process.env.DATABASE_URL).toMatch(/\\/lane_[0-9]+$/);
  console.log('${name} database=' + process.env.DATABASE_URL);
});
`,
      );
    }
    writeTimings(timings, { 'test/slow.test.ts': timing(9), 'test/fast.test.ts': timing(1) }, { partial: false });

    const events: string[] = [];
    const base = {
      service: 'fixture',
      directory: module,
      files: names.map((name) => `test/${name}.test.ts`),
      partial: false,
      createDatabase: async (database: string) => void events.push(`create ${database}`),
      dropDatabase: async (database: string) => void events.push(`drop ${database}`),
      environment: (database: string) => ({ ...process.env, DATABASE_URL: `postgres://host/${database}` }),
      env: { FIXTURE_CHECK_TIMINGS: timings, FIXTURE_CHECK_CONCURRENCY: '1' },
    };
    const originalWrite = process.stdout.write.bind(process.stdout);
    let printed = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let result;
    try {
      result = await runLaneSuite({
        ...base,
        environment: (database) => ({
          ...base.environment(database),
          DATABASE_URL: `postgres://host/lane_${database.length}`,
        }),
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(result).toEqual({ failed: [], concurrency: 1 });
    // The file with no recorded time first, then the slow file, then the fast one.
    expect(events).toEqual([
      'create fixture_test_1',
      'drop fixture_test_1',
      'create fixture_test_2',
      'drop fixture_test_2',
      'create fixture_test_3',
      'drop fixture_test_3',
    ]);
    expect(printed.match(/database=postgres:\/\/host\/lane_\d+/g)).toHaveLength(3);
    expect(printed.match(/^(\w+) database=/gm)).toEqual(['unknown database=', 'slow database=', 'fast database=']);
    const latest = readLatest(timings);
    expect(Object.keys(latest).sort()).toEqual(['test/fast.test.ts', 'test/slow.test.ts', 'test/unknown.test.ts']);
    expect(latest['test/unknown.test.ts']!.result).toBe('pass');
    expect(latest['test/unknown.test.ts']!.tests).toHaveLength(1);
  });
});

test('a suite names the files whose tests failed and still drops their clones', async () => {
  await withDirectory(async (directory) => {
    mkdirSync(resolve(directory, 'test'));
    writeFileSync(
      resolve(directory, 'test/bad.test.ts'),
      "import { expect, test } from 'bun:test';\ntest('fails', () => expect(1).toBe(2));\n",
    );
    const dropped: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const result = await runLaneSuite({
        service: 'fixture',
        directory,
        files: ['test/bad.test.ts'],
        partial: true,
        createDatabase: async () => undefined,
        dropDatabase: async (database) => void dropped.push(database),
        environment: () => process.env,
        env: { FIXTURE_CHECK_TIMINGS: resolve(directory, 'timings') },
      });
      expect(result.failed).toEqual(['test/bad.test.ts']);
      expect(dropped).toEqual(['fixture_test_1']);
      expect(readLatest(resolve(directory, 'timings'))['test/bad.test.ts']!.result).toBe('fail');
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
