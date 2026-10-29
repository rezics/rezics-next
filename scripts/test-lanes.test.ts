import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runWebTestLanes } from '../apps/web/scripts/check.ts';
import {
  classifyLoadInducedFailures,
  classifyLoadInducedOutput,
  capture,
  captureDefaults,
  classifyGrowthFailures,
  fileBounds,
  laneConcurrency,
  orderFiles,
  readLatest,
  retainStoppedTimings,
  rerunLoadFailures,
  runLaneSuite,
  scheduleFiles,
  timingsDirectory,
  writeTimings,
  testCommand,
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

test('test commands emit dots and file bounds follow recorded test, hook and wall times', () => {
  expect(captureDefaults).toEqual({ killGraceMs: 10_000, progressInterval: 60 });
  expect(testCommand('test/a.test.ts', 'a.xml')).toContain('--dots');
  expect(fileBounds()).toEqual({ silence: 1800, wall: 7200 });
  expect(fileBounds({ ...timing(100), outsideTests: 250, tests: [{ name: 'slow', time: 400 }] })).toEqual({
    silence: 1200,
    wall: 1800,
  });
  expect(fileBounds({ ...timing(900), outsideTests: 1, tests: [] })).toEqual({ silence: 600, wall: 2700 });
});

test('a silent captured process fails with its bound, recorded times and output tail', async () => {
  const result = await capture('/bin/sh', ['-c', 'echo started; sleep 5'], process.env, root, {
    file: 'test/hung.test.ts',
    silence: 0.15,
    wall: 1,
    record: timing(7),
    progressInterval: 60,
    killGraceMs: 50,
  });
  expect(result.status).toBe(124);
  expect(result.stopped).toContain('test/hung.test.ts printed nothing for 0.15 s');
  expect(result.stopped).toContain('"wall":7');
  expect(result.stopped).toContain('started');
});

test('a process that keeps printing is stopped at its wall bound', async () => {
  const result = await capture('/bin/sh', ['-c', 'while :; do echo tick; sleep 0.03; done'], process.env, root, {
    file: 'test/endless.test.ts',
    silence: 1,
    wall: 0.15,
    progressInterval: 60,
    killGraceMs: 50,
  });
  expect(result.status).toBe(124);
  expect(result.stopped).toContain('test/endless.test.ts did not finish within 0.15 s');
  expect(result.stopped).toContain('no record');
});

test('capture prints split UTF-8 intact and preserves each child stream', async () => {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  let printedOut = '';
  let printedErr = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { printedOut += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { printedErr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const script = "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => { process.stderr.write('err1\\n'); process.stdout.write(Buffer.from([0x82,0xac])); process.stderr.write('err2\\n'); }, 20)";
    const result = await capture('bun', ['-e', script], process.env, root);
    expect(result.status).toBe(0);
    expect(printedOut).toBe('€');
    expect(printedErr).toBe('err1\nerr2\n');
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
});

test('a running file emits a heartbeat with elapsed time, bounds and silence', async () => {
  const stderr = process.stderr.write.bind(process.stderr);
  let printed = '';
  process.stderr.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    await capture(
      'bun',
      ['-e', "console.log('started'); setInterval(() => console.log('tick'), 20); setTimeout(() => process.exit(0), 180)"],
      process.env,
      root,
      { file: 'test/heartbeat.test.ts', silence: 1, wall: 2, progressInterval: 0.05, killGraceMs: 50 },
    );
  } finally {
    process.stderr.write = stderr;
  }
  const heartbeats = printed.match(/test file test\/heartbeat\.test\.ts: elapsed \d+ s; silence bound 1 s; wall bound 2 s; since output \d+ s/g);
  expect(heartbeats?.length).toBeGreaterThanOrEqual(2);
});

test('the process group is killed after the leader exits and capture completes', async () => {
  const started = Date.now();
  const script = "const { spawn } = require('node:child_process'); const child = spawn('/bin/sh', ['-c', \"trap '' TERM; while :; do sleep 1; done\"], { stdio: 'inherit' }); console.log(child.pid); process.exit(0)";
  const result = await capture('bun', ['-e', script], process.env, root, {
    file: 'test/orphan.test.ts', silence: 0.15, wall: 2, progressInterval: 60, killGraceMs: 100,
  });
  expect(result.status).toBe(124);
  expect(Date.now() - started).toBeLessThan(1_000);
  const childPid = Number(result.output.trim());
  expect(Number.isInteger(childPid)).toBe(true);
  let processState: string | undefined;
  try {
    processState = readFileSync(`/proc/${childPid}/stat`, 'utf8').split(' ')[2];
  } catch {}
  expect([undefined, 'Z']).toContain(processState);
});

test('the load and growth classifiers accept Bun dot reporter failure output', () => {
  const loadOutput =
    '.\n(fail) overload case [1.23ms]\nError: Command unavailable for partition 976: overloaded\n1 tests failed:\n';
  expect(classifyLoadInducedOutput(loadOutput)?.map((item) => item.kind)).toEqual(['load']);
  const growthOutput =
    '.\nGrowthBoundError: examined rows exceeded the bound\n(fail) bounded query [1.23ms]\n1 tests failed:\n';
  expect(
    classifyGrowthFailures(
      { file: 'test/growth.test.ts', database: 'fixture', error: new Error(growthOutput) },
      undefined,
    ),
  ).toEqual([{ title: 'bounded query', message: 'examined rows exceeded the bound' }]);
});

test('a file stopped at a bound is never classified for load or growth rerun', () => {
  for (const tail of [
    '(fail) a [1ms]\nthis test timed out after 100ms',
    '(fail) a [1ms]\nAccess unavailable: overloaded',
  ]) {
    const outcome = {
      file: 'test/stopped.test.ts', database: 'fixture',
      error: new Error(`test file test/stopped.test.ts printed nothing for 600 s; Last output lines:\n${tail}`),
    };
    expect(classifyLoadInducedFailures(outcome, undefined)).toBeNull();
    expect(classifyGrowthFailures(outcome, undefined)).toBeNull();
  }
});

test('a file stopped at a bound keeps its previously recorded timings', () => {
  const previous = timing(45);
  const fresh = { ...timing(600), tests: [{ name: 'partial', time: 600 }] };
  expect(retainStoppedTimings({ 'test/stopped.test.ts': fresh }, { 'test/stopped.test.ts': previous }, new Set(['test/stopped.test.ts']))[
    'test/stopped.test.ts'
  ]).toEqual(previous);
});

function laneEnvironment(directory: string, concurrency: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FIXTURE_CHECK_TIMINGS: resolve(directory, 'timings'),
    FIXTURE_CHECK_CONCURRENCY: String(concurrency),
    REZICS_STACK_LEASE_DIR: resolve(directory, 'lease'),
    REZICS_STACK_SLOTS: '1',
  };
  delete env.REZICS_STACK_SLOT;
  delete env.REZICS_STACK_LEASE;
  return env;
}

function writeTestFiles(module: string, files: Record<string, string>): void {
  for (const [file, source] of Object.entries(files)) {
    const path = resolve(module, file);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, source);
  }
}

function slotIsFree(env: NodeJS.ProcessEnv): boolean {
  const result = Bun.spawnSync(['flock', '-n', '-E', '75', join(env.REZICS_STACK_LEASE_DIR!, 'slot-1.lock'), 'true'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return result.exitCode === 0;
}

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

test('timings in a checkout without git metadata require an explicit directory', () => {
  const outside = mkdtempSync(join(tmpdir(), 'test-lanes-outside-'));
  try {
    const module = join(outside, 'services', 'kernel');
    mkdirSync(module, { recursive: true });
    expect(() => timingsDirectory('fixture', module, {})).toThrow(/Could not find the git common directory/);
    expect(timingsDirectory('fixture', module, { FIXTURE_CHECK_TIMINGS: join(outside, 'timings') })).toBe(
      resolve(outside, 'timings'),
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a service timing directory set by the remote command applies to a scoped environment', () => {
  const previous = process.env.AUTH_CHECK_TIMINGS;
  process.env.AUTH_CHECK_TIMINGS = '/remote/auth/timings';
  try {
    expect(timingsDirectory('auth', '/remote/checkout/services/auth', { KERNEL_CHECK_TIMINGS: '/kernel/timings' })).toBe(
      '/remote/auth/timings',
    );
  } finally {
    if (previous === undefined) delete process.env.AUTH_CHECK_TIMINGS;
    else process.env.AUTH_CHECK_TIMINGS = previous;
  }
});

type FixtureFailure = { title: string; message: string; type?: string; duration?: string };

function loadFailureFixture(input: Array<string | FixtureFailure>) {
  const failures = input.map((failure, index): FixtureFailure =>
    typeof failure === 'string' ? { title: `failure ${index}`, message: failure } : failure,
  );
  const xml = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const output = failures
    .map(({ title, message, duration }) => `(fail) ${title} [${duration ?? '1.23ms'}]\n${message}\n`)
    .join('');
  const reports = [
    undefined,
    ...['attribute', 'body'].map(
      (format) =>
        `<testsuites failures="${failures.length}" errors="0"><testsuite>` +
        failures
          .map(
            ({ title, message, type }) =>
              `<testcase name="${xml(title)}">` +
              (format === 'attribute'
                ? `<failure type="${xml(type ?? 'Error')}" message="${xml(message)}"/>`
                : `<failure type="${xml(type ?? 'Error')}"><![CDATA[${message}]]></failure>`) +
              '</testcase>',
          )
          .join('') +
        '</testsuite></testsuites>',
    ),
  ];
  return {
    outcome: { file: 'test/load.test.ts', database: 'fixture_test_1', error: new Error(output) },
    output,
    reports,
  };
}

async function expectLoadFailureRetry(messages: string[]) {
  for (const message of messages) {
    const { outcome, reports } = loadFailureFixture([message]);
    for (const report of reports) {
      const reruns: string[] = [];
      const result = await rerunLoadFailures(
        [outcome],
        async (file) => {
          reruns.push(file);
          return { file, database: 'fixture_retry_1' };
        },
        (failure) => classifyLoadInducedFailures(failure, report),
        () => undefined,
      );
      expect(reruns).toEqual([outcome.file]);
      expect(result.failed).toEqual([]);
    }
  }
}

test('a file with any load failure is rerun alone and its other failures are cascades', async () => {
  const { outcome, reports } = loadFailureFixture([
    {
      title: 'retry exhaustion',
      message:
        'Error: Step content.import.step has exceeded its maximum of 100 retries. Previous errors: ... Command unavailable for partition 976: overloaded',
    },
    {
      title: 'problem body',
      message:
        'Error: Setup POST http://127.0.0.1:41234/v1/grants failed (503): {"type":"about:blank","title":"Service Unavailable","status":503,"code":"overloaded"}',
    },
    { title: 'workflow cascade', message: 'Error: Account workflow step failed: pending-account' },
    { title: 'public helper', message: 'Error: Public /v1/grants subject:create: HTTP 503' },
    { title: 'assertion cascade', message: 'Error: expect(received).toBe(expected)' },
  ]);
  for (const report of reports) {
    const classified = report
      ? classifyLoadInducedFailures(outcome, report)
      : classifyLoadInducedOutput(outcome.error!.message);
    expect(classified?.map((failure) => failure.kind)).toEqual(['load', 'load', 'cascade', 'load', 'cascade']);

    const reruns: string[] = [];
    let printed = '';
    const result = await rerunLoadFailures(
      [outcome],
      async (file) => {
        reruns.push(file);
        return { file, database: 'fixture_retry_1' };
      },
      (failure) => classifyLoadInducedFailures(failure, report),
      (text) => void (printed += text),
    );
    expect(reruns).toEqual([outcome.file]);
    expect(result.failed).toEqual([]);
    expect(printed).toContain('Load-sensitive tests (passed alone): 5');
    expect(printed).toContain('workflow cascade :: Error: Account workflow step failed: pending-account (cascade)');
    expect(printed).toContain('assertion cascade :: Error: expect(received).toBe(expected) (cascade)');
  }
});

test('wrapped overload signals are recognized in console and JUnit messages', async () => {
  await expectLoadFailureRetry([
    'AccessUnavailableError: Access unavailable: overloaded\n reason: "overloaded",',
    'Access unavailable: deadline',
    'CommandUnavailableError: Command unavailable for partition 1315: overloaded\n    reason: "overloaded",\n partition: 1315,\n   movedTo: null,',
    'Command unavailable for partition 976: deadline',
    'Step content.import.step has exceeded its maximum of 100 retries. Previous errors: Command unavailable for partition 976: overloaded',
    'Setup POST http://127.0.0.1:41234/v1/grants failed (503): {"type":"about:blank","title":"Service Unavailable","status":503,"code":"overloaded"}',
    'Public /v1/grants subject:create: HTTP 503',
    '{"type":"about:blank","title":"Service Unavailable","status":503,"code":"deadline_exceeded"}',
    "{ type: 'about:blank', title: 'Unavailable', status: 503, code: 'transaction_retry_exhausted' }",
  ]);
});

test('a file that failed only on database storage or connection refusal is rerun alone', async () => {
  await expectLoadFailureRetry([
    'error: sorry, too many clients already',
    'error: too many connections for database "kernel"',
    'error: remaining connection slots are reserved for non-replication superuser connections',
    'error: the database system is starting up',
    'error: the database system is shutting down',
    'error: could not extend file "base/123/456": No space left on device',
    'error: No space left on device',
    ...['53300', '53100', '57P03'].map((code) => `PostgresError: database unavailable\n code: "${code}",`),
  ]);
});

test('source excerpts, stack frames, Expected lines and passing tests do not make failures load-induced', () => {
  const passing = [
    '(pass) eligibility prepare: 53300 closes the request without effects [1.83ms]',
    '(pass) eligibility prepare: 57P03 closes the request without effects [2.59ms]',
    '(pass) eligibility prepare: 53100 closes the request without effects',
    '(pass) handles code: "53300"',
    '(pass) handles AccessUnavailableError: Access unavailable: overloaded',
    '(pass) handles this test timed out after 60000ms',
  ].join('\n');
  const noise = [
    '12 | AccessUnavailableError: Access unavailable: overloaded',
    '    at AccessUnavailableError: Access unavailable: overloaded',
    'Expected: CommandUnavailableError: Command unavailable for partition 976: overloaded',
    passing,
    'Error: unexpected result',
  ].join('\n');
  const { outcome, reports } = loadFailureFixture([noise]);
  expect(classifyLoadInducedOutput(outcome.error!.message)).toBeNull();
  for (const report of reports) expect(classifyLoadInducedFailures(outcome, report)).toBeNull();
});

test('a file whose only failures have no load signal is not rerun', async () => {
  const { outcome, reports } = loadFailureFixture(['Error: expect(received).toBe(expected)\nExpected: 1\nReceived: 2']);
  for (const report of reports) {
    const reruns: string[] = [];
    const result = await rerunLoadFailures(
      [outcome],
      async (file) => {
        reruns.push(file);
        return { file, database: 'fixture_retry_1' };
      },
      (failure) => classifyLoadInducedFailures(failure, report),
      () => undefined,
    );
    expect(reruns).toEqual([]);
    expect(result.failed).toEqual([outcome]);
  }
});

test('an unhandled overload error makes a file eligible in console and JUnit output', async () => {
  const output = '# Unhandled error: Command unavailable for partition 976: overloaded';
  const outcome = { file: 'test/unhandled.test.ts', database: 'fixture_test_1', error: new Error(output) };
  const reports = [
    undefined,
    '<testsuites failures="0" errors="1"><testsuite><error type="Error" message="Command unavailable for partition 976: overloaded"/></testsuite></testsuites>',
  ];
  for (const report of reports) {
    const reruns: string[] = [];
    const result = await rerunLoadFailures(
      [outcome],
      async (file) => {
        reruns.push(file);
        return { file, database: 'fixture_retry_1' };
      },
      (failure) => classifyLoadInducedFailures(failure, report),
      () => undefined,
    );
    expect(reruns).toEqual([outcome.file]);
    expect(result.failed).toEqual([]);
  }
});

test('database cleanup failures keep a file ineligible even when a test reported overload', () => {
  const { outcome, reports } = loadFailureFixture(['Access unavailable: overloaded']);
  const cleanupFailure = {
    ...outcome,
    error: new Error(`${outcome.error!.message}\nDatabase cleanup failed: fixture_test_1`),
  };
  expect(classifyLoadInducedOutput(cleanupFailure.error!.message)).toBeNull();
  for (const report of reports) expect(classifyLoadInducedFailures(cleanupFailure, report)).toBeNull();
});

test('a Received line carrying an overload signal makes its failure eligible', async () => {
  const { outcome, reports } = loadFailureFixture([
    {
      title: 'wrong received value',
      message:
        'Error: expect(received).toBe(expected)\nExpected: successful response\nReceived: CommandUnavailableError: Command unavailable for partition 976: overloaded',
    },
  ]);
  for (const report of reports) {
    const classified = report
      ? classifyLoadInducedFailures(outcome, report)
      : classifyLoadInducedOutput(outcome.error!.message);
    expect(classified?.map((failure) => failure.kind)).toEqual(['load']);
  }
});

test('a timeout printed after its fail line belongs to that failure and JUnit timeouts are load failures', async () => {
  const { outcome, reports } = loadFailureFixture([
    {
      title: 'times out',
      message: '  ^ this test timed out after 180000ms.',
      type: 'TimeoutError',
      duration: '180000.12ms',
    },
    { title: 'following assertion', message: 'Error: expect(received).toBe(expected)' },
  ]);
  expect(outcome.error!.message).toContain('(fail) times out [180000.12ms]\n  ^ this test timed out after 180000ms.');
  for (const report of reports) {
    const classified = report
      ? classifyLoadInducedFailures(outcome, report)
      : classifyLoadInducedOutput(outcome.error!.message);
    expect(classified?.map((failure) => failure.kind)).toEqual(['load', 'cascade']);
  }
  const junitTimeout =
    '<testsuites failures="1" errors="1"><testsuite>' +
    '<testcase name="times out"><failure type="Error" message="no failure detail"/></testcase>' +
    '<error type="TimeoutError" message="this test timed out after 180000ms"/>' +
    '</testsuite></testsuites>';
  expect(classifyLoadInducedFailures(outcome, junitTimeout)?.map((failure) => [failure.title, failure.kind])).toEqual([
    ['times out', 'load'],
  ]);
});

test('a load signal makes a mixed file eligible without classifying unrelated failures as load-induced', () => {
  for (const other of [
    'GrowthBoundError: query count exceeded its bound',
    'Error: unexpected result',
    'Error: unexpected SQLSTATE 53300, 53100 or 57P03',
    'PostgresError: unrelated failure\n code: "533001",',
    'AccessUnavailableError: Access unavailable: contention',
    'CommandUnavailableError: Command unavailable for partition 1315: fenced',
  ]) {
    const { outcome: plainOutcome, reports: plainReports } = loadFailureFixture([other]);
    expect(classifyLoadInducedOutput(plainOutcome.error!.message)).toBeNull();
    for (const report of plainReports) expect(classifyLoadInducedFailures(plainOutcome, report)).toBeNull();

    const { outcome, reports } = loadFailureFixture(['Access unavailable: overloaded', other]);
    expect(classifyLoadInducedOutput(outcome.error!.message)?.map((failure) => failure.kind)).toEqual([
      'load',
      'cascade',
    ]);
    for (const report of reports) {
      expect(classifyLoadInducedFailures(outcome, report)?.map((failure) => failure.kind)).toEqual(['load', 'cascade']);
    }
  }
});

test('the verdict of an overload rerun is final even if it is overloaded again', async () => {
  const { outcome, reports } = loadFailureFixture(['AccessUnavailableError: Access unavailable: overloaded']);
  for (const report of reports) {
    for (const message of ['AccessUnavailableError: Access unavailable: overloaded', 'Error: unexpected result']) {
      let attempts = 0;
      const result = await rerunLoadFailures(
        [outcome],
        async (file) => {
          attempts++;
          return { file, database: 'fixture_retry_1', error: new Error(message) };
        },
        (failure) => classifyLoadInducedFailures(failure, report),
        () => undefined,
      );
      expect(attempts).toBe(1);
      expect(result.failed).toEqual([outcome]);
    }
  }
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
    const env = { ...laneEnvironment(directory, 1), FIXTURE_CHECK_TIMINGS: timings };
    const base = {
      service: 'fixture',
      directory: module,
      files: names.map((name) => `test/${name}.test.ts`),
      partial: false,
      createDatabase: async (database: string) => void events.push(`create ${database}`),
      dropDatabase: async (database: string) => void events.push(`drop ${database}`),
      environment: (database: string) => ({ ...env, DATABASE_URL: `postgres://host/${database}` }),
      env,
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
    // Recorded files run longest first, followed by files with no timing.
    expect(events).toEqual([
      'create fixture_test_1',
      'drop fixture_test_1',
      'create fixture_test_2',
      'drop fixture_test_2',
      'create fixture_test_3',
      'drop fixture_test_3',
    ]);
    expect(printed.match(/database=postgres:\/\/host\/lane_\d+/g)).toHaveLength(3);
    expect(printed.indexOf('slow database=')).toBeLessThan(printed.indexOf('fast database='));
    expect(printed.indexOf('fast database=')).toBeLessThan(printed.indexOf('unknown database='));
    const latest = readLatest(timings);
    expect(Object.keys(latest).sort()).toEqual(['test/fast.test.ts', 'test/slow.test.ts', 'test/unknown.test.ts']);
    expect(latest['test/unknown.test.ts']!.result).toBe('pass');
    expect(latest['test/unknown.test.ts']!.tests).toHaveLength(1);
  });
});

test('a suite lets the check record each completed file peak in its timing', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    mkdirSync(resolve(module, 'test'), { recursive: true });
    writeFileSync(
      resolve(module, 'test/peak.test.ts'),
      "import { test } from 'bun:test';\ntest('passes', () => {});\n",
    );
    const env = laneEnvironment(directory, 1);
    const completed: Array<{ file: string; result: string; peak: number }> = [];

    const result = await runLaneSuite({
      service: 'fixture',
      directory: module,
      files: ['test/peak.test.ts'],
      partial: false,
      createDatabase: async () => undefined,
      dropDatabase: async () => undefined,
      environment: () => ({ ...env }),
      env,
      onFileComplete: (outcome, timing) => {
        timing.peakConnections = 4;
        completed.push({ file: outcome.file, result: outcome.error ? 'fail' : 'pass', peak: timing.peakConnections });
      },
    });

    expect(result.failed).toEqual([]);
    expect(completed).toEqual([{ file: 'test/peak.test.ts', result: 'pass', peak: 4 }]);
    expect(readLatest(resolve(directory, 'timings'))['test/peak.test.ts']!.peakConnections).toBe(4);
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
    const env = laneEnvironment(directory, 1);
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
        environment: () => ({ ...env }),
        env,
      });
      expect(result.failed).toEqual(['test/bad.test.ts']);
      expect(dropped).toEqual(['fixture_test_1']);
      expect(readLatest(resolve(directory, 'timings'))['test/bad.test.ts']!.result).toBe('fail');
      expect(slotIsFree(env)).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

test('a file whose only failures are timeouts or deadline errors is rerun once alone and reported as load-sensitive when it passes', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    const attempts = resolve(directory, 'attempts.txt');
    const attemptsLiteral = JSON.stringify(attempts);
    writeTestFiles(module, {
      'test/retry.test.ts': [
        "import { test } from 'bun:test';",
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        `const attempts = ${attemptsLiteral};`,
        "test('a timeout passes alone', () => {",
        "  const count = existsSync(attempts) ? Number(readFileSync(attempts, 'utf8')) : 0;",
        '  writeFileSync(attempts, String(count + 1));',
        "  if (count === 0) throw new Error('this test timed out after 60000ms');",
        '});',
        '',
      ].join('\n'),
    });
    const env = laneEnvironment(directory, 1);
    const originalWrite = process.stderr.write.bind(process.stderr);
    let printed = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await runLaneSuite({
        service: 'fixture',
        directory: module,
        files: ['test/retry.test.ts'],
        partial: false,
        createDatabase: async () => undefined,
        dropDatabase: async () => undefined,
        environment: () => ({ ...env }),
        env,
      });
      expect(result.failed).toEqual([]);
      expect(readFileSync(attempts, 'utf8')).toBe('2');
      expect(printed).toContain('Load-sensitive tests (passed alone): 1');
      expect(printed).toContain('test/retry.test.ts :: a timeout passes alone');
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

test('a load-induced failure that fails again alone fails the run', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    const attempts = resolve(directory, 'attempts.txt');
    const attemptsLiteral = JSON.stringify(attempts);
    writeTestFiles(module, {
      'test/retry.test.ts': [
        "import { test } from 'bun:test';",
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        `const attempts = ${attemptsLiteral};`,
        "const count = existsSync(attempts) ? Number(readFileSync(attempts, 'utf8')) : 0;",
        'writeFileSync(attempts, String(count + 1));',
        "test('the timeout remains alone', () => { throw new Error('this test timed out after 60000ms'); });",
        '',
      ].join('\n'),
    });
    const env = laneEnvironment(directory, 1);
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const result = await runLaneSuite({
        service: 'fixture',
        directory: module,
        files: ['test/retry.test.ts'],
        partial: false,
        createDatabase: async () => undefined,
        dropDatabase: async () => undefined,
        environment: () => ({ ...env }),
        env,
      });
      expect(result.failed).toEqual(['test/retry.test.ts']);
      expect(readFileSync(attempts, 'utf8')).toBe('2');
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

test('another failure does not prevent a timeout file from being rerun alone', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    const attempts = resolve(directory, 'attempts.txt');
    const attemptsLiteral = JSON.stringify(attempts);
    writeTestFiles(module, {
      'test/retry.test.ts': [
        "import { expect, test } from 'bun:test';",
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        `const attempts = ${attemptsLiteral};`,
        "const count = existsSync(attempts) ? Number(readFileSync(attempts, 'utf8')) : 0;",
        'writeFileSync(attempts, String(count + 1));',
        "test('a timeout failure', () => { throw new Error('this test timed out after 60000ms'); });",
        "test('an assertion failure', () => expect(1).toBe(2));",
        '',
      ].join('\n'),
    });
    const env = laneEnvironment(directory, 1);
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const result = await runLaneSuite({
        service: 'fixture',
        directory: module,
        files: ['test/retry.test.ts'],
        partial: false,
        createDatabase: async () => undefined,
        dropDatabase: async () => undefined,
        environment: () => ({ ...env }),
        env,
      });
      expect(result.failed).toEqual(['test/retry.test.ts']);
      expect(readFileSync(attempts, 'utf8')).toBe('2');
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

test('the rerun summary reports attempted files, elapsed seconds and passes', async () => {
  const outcomes = ['a', 'b', 'c'].map((file) => ({
    file: `test/${file}.test.ts`,
    database: `fixture_${file}`,
    error: new Error('failed in the suite'),
  }));
  const printed: string[] = [];
  const result = await rerunLoadFailures(
    outcomes,
    async (file) =>
      file === 'test/b.test.ts'
        ? { file, database: 'fixture_b_alone', error: new Error('still fails alone') }
        : { file, database: `${file}_alone` },
    () => [{ title: 'overloaded', message: 'Access unavailable: overloaded', kind: 'load' }],
    (text) => void printed.push(text),
  );
  expect(result.failed).toEqual([outcomes[1]]);
  expect(printed.join('')).toMatch(/Load reruns: 3 files, \d+(?:\.\d+)? s alone \(2 passed alone\)/);
});

test('the web check reruns load-induced browser failures alone', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'web');
    const attempts = resolve(directory, 'attempts.txt');
    const attemptsLiteral = JSON.stringify(attempts);
    writeTestFiles(module, {
      'scripts/isolated.ts': [
        "import { spawnSync } from 'node:child_process';",
        "const result = spawnSync(process.argv[2]!, process.argv.slice(3), { stdio: 'inherit' });",
        'process.exit(result.status ?? 1);',
        '',
      ].join('\n'),
      'tests/browser-timeout.test.ts': [
        "import { test } from 'bun:test';",
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        '// browser.launch marks this fixture as a browser lane.',
        `const attempts = ${attemptsLiteral};`,
        "test('the browser timeout passes alone', () => {",
        "  const count = existsSync(attempts) ? Number(readFileSync(attempts, 'utf8')) : 0;",
        '  writeFileSync(attempts, String(count + 1));',
        "  if (count === 0) throw new Error('TimeoutError: page.goto: Timeout 30000ms exceeded');",
        '});',
        '',
      ].join('\n'),
    });
    const env = laneEnvironment(directory, 1);
    env.WEB_BROWSER_CHECK_CONCURRENCY = '1';
    env.WEB_UNIT_CHECK_CONCURRENCY = '1';
    const originalWrite = process.stderr.write.bind(process.stderr);
    let printed = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await runWebTestLanes({
        files: ['tests/browser-timeout.test.ts'],
        directory: module,
        timingsFile: resolve(directory, 'timings.json'),
        reportDirectory: resolve(directory, 'reports'),
        env,
      });
      expect(result.failed).toEqual([]);
      expect(readFileSync(attempts, 'utf8')).toBe('2');
      expect(printed).toContain('Load-sensitive tests (passed alone): 1');
      expect(printed).toContain('tests/browser-timeout.test.ts :: the browser timeout passes alone');
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

test('each test file holds one stack slot from its database copy to its drop', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    writeTestFiles(module, {
      'test/a.test.ts': "import { test } from 'bun:test'; test('a', () => {});\n",
      'test/b.test.ts': "import { test } from 'bun:test'; test('b', () => {});\n",
    });
    const env = laneEnvironment(directory, 2);
    const events: string[] = [];
    const result = await runLaneSuite({
      service: 'fixture',
      directory: module,
      files: ['test/a.test.ts', 'test/b.test.ts'],
      partial: false,
      createDatabase: async (database) => {
        events.push('create ' + database);
        await Bun.sleep(10);
      },
      dropDatabase: async (database) => {
        await Bun.sleep(25);
        events.push('drop ' + database);
      },
      environment: (database) => {
        events.push('run ' + database);
        return { ...env, DATABASE_URL: 'postgres://host/' + database };
      },
      env,
    });
    expect(result).toEqual({ failed: [], concurrency: 2 });
    expect(events).toHaveLength(6);
    for (let index = 0; index < events.length; index += 3) {
      const database = events[index]!.replace('create ', '');
      expect(events[index]).toBe('create ' + database);
      expect(events[index + 1]).toBe('run ' + database);
      expect(events[index + 2]).toBe('drop ' + database);
    }

    const createEnv = laneEnvironment(resolve(directory, 'create-failure'), 1);
    const createFailure = await runLaneSuite({
      service: 'fixture',
      directory: module,
      files: ['test/a.test.ts'],
      partial: false,
      createDatabase: async () => {
        throw new Error('copy failed');
      },
      dropDatabase: async () => undefined,
      environment: () => createEnv,
      env: createEnv,
    });
    expect(createFailure.failed).toEqual(['test/a.test.ts']);
    expect(slotIsFree(createEnv)).toBe(true);

    const dropEnv = laneEnvironment(resolve(directory, 'drop-failure'), 1);
    const dropFailure = await runLaneSuite({
      service: 'fixture',
      directory: module,
      files: ['test/a.test.ts'],
      partial: false,
      createDatabase: async () => undefined,
      dropDatabase: async () => {
        throw new Error('drop failed');
      },
      environment: () => dropEnv,
      env: dropEnv,
    });
    expect(dropFailure.failed).toEqual(['test/a.test.ts']);
    expect(slotIsFree(dropEnv)).toBe(true);
  });
});

test("a file's test process gets its slot in the environment", async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    writeTestFiles(module, {
      'test/slot.test.ts': [
        "import { expect, test } from 'bun:test';",
        "test('inherits its lane slot', () => expect(process.env.REZICS_STACK_SLOT).toBe('1/1'));",
        '',
      ].join('\n'),
    });
    const env = laneEnvironment(directory, 1);
    const result = await runLaneSuite({
      service: 'fixture',
      directory: module,
      files: ['test/slot.test.ts'],
      partial: false,
      createDatabase: async () => undefined,
      dropDatabase: async () => undefined,
      environment: (database) => ({ ...env, DATABASE_URL: 'postgres://host/' + database }),
      env,
    });
    expect(result.failed).toEqual([]);
  });
});

test('under an inherited slot the files run one at a time in it', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    const marker = resolve(directory, 'running-file');
    const markerJson = JSON.stringify(marker);
    const source = [
      "import { expect, test } from 'bun:test';",
      "import { existsSync, unlinkSync, writeFileSync } from 'node:fs';",
      "test('uses the parent slot without overlap', async () => {",
      "  expect(process.env.REZICS_STACK_SLOT).toBe('1/2');",
      '  expect(existsSync(' + markerJson + ')).toBe(false);',
      '  writeFileSync(' + markerJson + ", 'running');",
      '  try { await Bun.sleep(40); } finally { unlinkSync(' + markerJson + '); }',
      '});',
      '',
    ].join('\n');
    writeTestFiles(module, {
      'test/a.test.ts': source,
      'test/b.test.ts': source,
      'test/c.test.ts': source,
    });
    const env = laneEnvironment(directory, 3);
    env.REZICS_STACK_SLOT = '1/2';
    const events: string[] = [];
    const result = await runLaneSuite({
      service: 'fixture',
      directory: module,
      files: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'],
      partial: false,
      createDatabase: async (database) => void events.push('create ' + database),
      dropDatabase: async (database) => void events.push('drop ' + database),
      environment: (database) => {
        events.push('run ' + database);
        return { ...env, DATABASE_URL: 'postgres://host/' + database };
      },
      env,
    });
    expect(result).toEqual({ failed: [], concurrency: 1 });
    expect(events).toEqual([
      'create fixture_test_1',
      'run fixture_test_1',
      'drop fixture_test_1',
      'create fixture_test_2',
      'run fixture_test_2',
      'drop fixture_test_2',
      'create fixture_test_3',
      'run fixture_test_3',
      'drop fixture_test_3',
    ]);
    expect(existsSync(env.REZICS_STACK_LEASE_DIR!)).toBe(false);
  });
});

test('with the lease off the lanes run at full concurrency and take no slot', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    const source = [
      "import { expect, test } from 'bun:test';",
      "test('does not receive a stack slot', () => expect(process.env.REZICS_STACK_SLOT).toBeUndefined());",
      '',
    ].join('\n');
    writeTestFiles(module, {
      'test/a.test.ts': source,
      'test/b.test.ts': source,
      'test/c.test.ts': source,
    });
    const env = laneEnvironment(directory, 2);
    env.REZICS_STACK_LEASE = 'off';
    let active = 0;
    let maximumActive = 0;
    const result = await runLaneSuite({
      service: 'fixture',
      directory: module,
      files: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'],
      partial: false,
      createDatabase: async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(30);
        active--;
      },
      dropDatabase: async () => undefined,
      environment: (database) => ({ ...env, DATABASE_URL: 'postgres://host/' + database }),
      env,
    });
    expect(result).toEqual({ failed: [], concurrency: 2 });
    expect(maximumActive).toBe(2);
    expect(existsSync(env.REZICS_STACK_LEASE_DIR!)).toBe(false);
  });
});
