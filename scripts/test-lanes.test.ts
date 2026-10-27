import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runWebTestLanes } from '../apps/web/scripts/check.ts';
import {
  classifyLoadInducedFailures,
  classifyLoadInducedOutput,
  laneConcurrency,
  orderFiles,
  readLatest,
  rerunLoadFailures,
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

function loadFailureFixture(messages: string[]) {
  const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const output = messages.map((message, index) => `${message}\n(fail) failure ${index}\n`).join('');
  const reports = [
    undefined,
    ...['attribute', 'body'].map(
      (format) =>
        `<testsuites failures="${messages.length}" errors="0"><testsuite>` +
        messages
          .map(
            (message, index) =>
              `<testcase name="failure ${index}">` +
              (format === 'attribute'
                ? `<failure type="Error" message="${xml(message)}"/>`
                : `<failure><![CDATA[${message}]]></failure>`) +
              '</testcase>',
          )
          .join('') +
        '</testsuite></testsuites>',
    ),
  ];
  return { outcome: { file: 'test/load.test.ts', database: 'fixture_test_1', error: new Error(output) }, reports };
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

test('a file that failed only on database overload is rerun alone', async () => {
  await expectLoadFailureRetry([
    'AccessUnavailableError: Access unavailable: overloaded\n reason: "overloaded",',
    'CommandUnavailableError: Command unavailable for partition 1315: overloaded\n    reason: "overloaded",\n partition: 1315,\n   movedTo: null,',
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

test('a passing test whose title names a SQLSTATE does not make a failure load-induced', () => {
  const passing = [
    '(pass) eligibility prepare: 53300 closes the request without effects [1.83ms]',
    '(pass) eligibility prepare: 57P03 closes the request without effects [2.59ms]',
    '(pass) eligibility prepare: 53100 closes the request without effects',
    '(pass) handles code: "53300"',
    '(pass) handles AccessUnavailableError: Access unavailable: overloaded',
    '(pass) handles this test timed out after 60000ms',
  ].join('\n');
  const { outcome, reports } = loadFailureFixture([`${passing}\nError: unexpected result\n${passing}`]);
  expect(classifyLoadInducedOutput(outcome.error.message)).toBeNull();
  for (const report of reports) expect(classifyLoadInducedFailures(outcome, report)).toBeNull();
});

test('overload does not hide another failure or make bare SQLSTATE numbers retryable', () => {
  for (const other of [
    'GrowthBoundError: query count exceeded its bound',
    'Error: unexpected result',
    'Error: unexpected SQLSTATE 53300, 53100 or 57P03',
    'PostgresError: unrelated failure\n code: "533001",',
    'AccessUnavailableError: Access unavailable: contention',
    'CommandUnavailableError: Command unavailable for partition 1315: fenced',
  ]) {
    for (const messages of [[other], ['AccessUnavailableError: Access unavailable: overloaded', other]]) {
      const { outcome, reports } = loadFailureFixture(messages);
      for (const report of reports) expect(classifyLoadInducedFailures(outcome, report)).toBeNull();
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

test('a file with any other failure is not rerun', async () => {
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
      expect(readFileSync(attempts, 'utf8')).toBe('1');
    } finally {
      process.stderr.write = originalWrite;
    }
  });
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
