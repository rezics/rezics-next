import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scheduleFiles, testCommand } from '../scripts/check.ts';
import {
  createRecorder,
  orderFiles,
  parseJunit,
  readLatestRun,
  readLatest,
  timingsDirectory,
  writeTimings,
  type CheckRunTiming,
  type FileTiming,
} from '../scripts/check-timings.ts';

const PROJECT_ROOT = resolve(import.meta.dir, '../../..');

/** A temporary directory removed after `use` returns. */
async function withDirectory(use: (directory: string) => void | Promise<void>): Promise<void> {
  const temporaryRoot = resolve(PROJECT_ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(resolve(temporaryRoot, 'kernel-check-timings-'));
  try {
    await use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" time="0.9">
  <testsuite name="a.test.ts" file="a.test.ts" tests="3" time="0.8">
    <testsuite name="group" file="a.test.ts" line="4" tests="1" time="0.1">
      <testcase name="one" classname="group" time="0.1" file="a.test.ts" line="4" />
    </testsuite>
    <testcase name="two &quot;q&quot; &lt;x&gt;" classname="" time="0.25" file="a.test.ts" line="5" />
    <testcase name="bad" classname="" time="0.5" file="a.test.ts" line="6">
      <failure type="AssertionError" message="no">trace</failure>
    </testcase>
  </testsuite>
</testsuites>
`;

const reported = [
  { name: 'first', time: 0.01 },
  { name: 'second', time: 0.005 },
];

function timing(wall: number): FileTiming {
  return { wall, create: 0, drop: 0, outsideTests: 0, result: 'pass', tests: [] };
}

test('a check run records each file’s wall time and per-test times', async () => {
  await withDirectory(async (directory) => {
    const recorder = createRecorder();
    const runner = recorder.wrap(
      {
        create: () => Bun.sleep(5),
        run: async (file) => {
          await Bun.sleep(40);
          if (file === 'bad.test.ts') throw new Error('bun test failed\nREZICS_KERNEL_MODULE_IMPORT_SECONDS=0.0250');
          return `${file} output\nREZICS_KERNEL_MODULE_IMPORT_SECONDS=0.0250`;
        },
        drop: () => Bun.sleep(5),
      },
      async (file) => (file === 'bad.test.ts' ? [] : reported),
    );
    await scheduleFiles(['ok.test.ts', 'bad.test.ts'], 2, runner);
    writeTimings(directory, recorder.timings(), { partial: false, now: new Date('2026-10-26T01:02:03.456Z') });

    expect(readdirSync(directory).sort()).toEqual(['20261026T010203.456Z.json', 'latest.json']);
    const latest = readLatest(directory);
    expect(JSON.parse(readFileSync(resolve(directory, '20261026T010203.456Z.json'), 'utf8')).files).toEqual(latest);
    expect(Object.keys(latest).sort()).toEqual(['bad.test.ts', 'ok.test.ts']);

    const ok = latest['ok.test.ts']!;
    expect(ok.result).toBe('pass');
    expect(ok.wall).toBeGreaterThanOrEqual(0.04);
    expect(ok.create).toBeGreaterThanOrEqual(0.004);
    expect(ok.drop).toBeGreaterThanOrEqual(0.004);
    expect(ok.tests).toEqual(reported);
    expect(ok.moduleLoad).toBe(0.025);
    // Module load and hooks: the wall time minus the tests' own time.
    expect(ok.outsideTests).toBeCloseTo(ok.wall - 0.015, 3);

    expect(latest['bad.test.ts']!.result).toBe('fail');
    expect(latest['bad.test.ts']!.moduleLoad).toBe(0.025);
    expect(latest['bad.test.ts']!.tests).toEqual([]);
  });
});

test('check-wide compiler and test phases are retained with file timings', async () => {
  await withDirectory((directory) => {
    const run: CheckRunTiming = {
      compilerSeconds: 12.5,
      qualitySeconds: 3.25,
      testSeconds: 41.75,
      totalSeconds: 70,
      otherSeconds: 12.5,
      analysisEntries: { compilerBefore: 0, compilerAfter: 42, sharedAfter: 42 },
    };
    writeTimings(directory, { 'a.test.ts': timing(10) }, { partial: false, run });
    expect(readLatestRun(directory)).toEqual(run);
    expect(JSON.parse(readFileSync(resolve(directory, 'latest.json'), 'utf8')).run).toEqual(run);
  });
});

test('test-emitted fixture boundaries are retained separately from hooks and test cases', async () => {
  const recorder = createRecorder();
  const runner = recorder.wrap(
    {
      create: () => undefined,
      run: () =>
        'REZICS_KERNEL_FIXTURE_PHASES={"databaseSetup":0.25,"authSetup":0.5}\nREZICS_KERNEL_FIXTURE_PHASES={"workerBoot":0.75}',
      drop: () => undefined,
    },
    async () => [],
  );
  await scheduleFiles(['fixture.test.ts'], 1, runner);
  expect(recorder.timings()['fixture.test.ts']?.fixturePhases).toEqual({
    databaseSetup: 0.25,
    authSetup: 0.5,
    workerBoot: 0.75,
  });
});

test('the JUnit report gives each test’s name and time', () => {
  expect(parseJunit(junit)).toEqual([
    { name: 'group one', time: 0.1 },
    { name: 'two "q" <x>', time: 0.25 },
    { name: 'bad', time: 0.5 },
  ]);
});

test('a run with named files merges them into the last recorded timings', async () => {
  await withDirectory((directory) => {
    writeTimings(directory, { 'a.test.ts': timing(10), 'b.test.ts': timing(20) }, { partial: false });
    writeTimings(directory, { 'b.test.ts': timing(5), 'c.test.ts': timing(7) }, { partial: true });
    expect(Object.fromEntries(Object.entries(readLatest(directory)).map(([file, { wall }]) => [file, wall]))).toEqual({
      'a.test.ts': 10,
      'b.test.ts': 5,
      'c.test.ts': 7,
    });
    // A full run replaces the file set, so deleted test files do not linger.
    writeTimings(directory, { 'a.test.ts': timing(1) }, { partial: false });
    expect(Object.keys(readLatest(directory))).toEqual(['a.test.ts']);
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

test('timings that cannot be written warn once and never fail the check', async () => {
  await withDirectory((directory) => {
    const blocker = resolve(directory, 'file');
    writeFileSync(blocker, '');
    const warnings: string[] = [];
    expect(() =>
      writeTimings(
        resolve(blocker, 'timings'),
        { 'a.test.ts': timing(1) },
        { partial: false, warn: (m) => warnings.push(m) },
      ),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
  });
});

test('the timings directory is shared by worktrees and can be overridden', () => {
  expect(timingsDirectory(import.meta.dir, { KERNEL_CHECK_TIMINGS: '/somewhere/else' })).toBe('/somewhere/else');
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: import.meta.dir,
    encoding: 'utf8',
  }).stdout.trim();
  expect(timingsDirectory(import.meta.dir, {})).toBe(resolve(dirname(common), '.temp/kernel-check/timings'));
});

test('files run longest first from the last recorded timings, unknown files first', async () => {
  await withDirectory(async (directory) => {
    writeTimings(
      directory,
      { 'b.test.ts': timing(5), 'c.test.ts': timing(50), 'd.test.ts': timing(5), 'e.test.ts': timing(1) },
      { partial: false },
    );
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts', 'f.test.ts'];
    const expected = ['a.test.ts', 'f.test.ts', 'c.test.ts', 'b.test.ts', 'd.test.ts', 'e.test.ts'];
    expect(orderFiles(files, readLatest(directory), {})).toEqual(expected);
    expect(orderFiles(files, readLatest(directory), { KERNEL_CHECK_ORDER: 'name' })).toEqual(files);

    const started: string[] = [];
    await scheduleFiles(orderFiles(files, readLatest(directory), {}), 1, {
      create: async () => undefined,
      run: async (file) => {
        started.push(file);
      },
      drop: async () => undefined,
    });
    expect(started).toEqual(expected);
  });
});

test('no recorded timings leaves name order', async () => {
  await withDirectory((directory) => {
    expect(readLatest(resolve(directory, 'missing'))).toEqual({});
    expect(orderFiles(['a', 'b'], {}, {})).toEqual(['a', 'b']);
  });
});

test('each file’s bun test writes a JUnit report beside its console output', () => {
  const args = testCommand('test/a.test.ts', '/tmp/report.xml');
  expect(args).toEqual([
    'test',
    '--timeout',
    '60000',
    '--reporter=junit',
    '--reporter-outfile=/tmp/report.xml',
    './test/a.test.ts',
  ]);
});
