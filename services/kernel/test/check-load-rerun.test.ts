import { expect, test } from 'bun:test';
import { rerunGrowthFailures } from '../scripts/check.ts';

type Outcome = { file: string; database: string; error?: Error; output?: string };

const summary = (failures: number): string =>
  `\n 0 pass\n ${failures} fail\nRan ${failures} tests across 1 file. [9.00ms]`;

function failed(file: string, ...blocks: string[]): Outcome {
  return {
    file,
    database: 'kernel_test_1',
    error: new Error(`bun test ./${file} failed:\n${blocks.join('\n')}${summary(blocks.length)}`),
  };
}

function testFailure(title: string, message: string): string {
  return `${message}\n      at query (/app/test.ts:1:1)\n(fail) ${title} [4.00ms]`;
}

function expectRerunSummary(log: string[], files: number, passed: number): void {
  const lines = log.join('').split('\n').filter((line) => line.startsWith('Load reruns:'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(
    new RegExp(`^Load reruns: ${files} files, \\d+\\.\\d{2} s alone \\(${passed} passed alone\\)$`),
  );
}

/** This failure block is copied from the stabilize gate log, including its quoted deadline source line. */
const gateOverloadFailure = [
  '580 |         await pause(Math.min(Math.random() * maximum, Math.max(0, deadline - Date.now())));',
  "581 |         if (Date.now() >= deadline) throw new CommandUnavailableError('contention', partition);",
  '582 |         continue;',
  '583 |       }',
  "584 |       if (Date.now() >= deadline) throw new CommandUnavailableError('deadline', partition);",
  "585 |       if (reason === 'overloaded') throw new CommandUnavailableError('overloaded', partition);",
  '                                                   ^',
  'CommandUnavailableError: Command unavailable for partition 556: overloaded',
  '    reason: "overloaded",',
  ' partition: 556,',
  '   movedTo: null,',
  '',
  '      at runCommand (/srv/rezics-check/runs/mvrehj2k-66ab964a/services/kernel/src/command/command.ts:585:42)',
  '      at async createSubject (/srv/rezics-check/runs/mvrehj2k-66ab964a/services/kernel/src/semantic/subject.ts:75:25)',
  '      at async subject (/srv/rezics-check/runs/mvrehj2k-66ab964a/services/kernel/test/library/copies.test.ts:61:24)',
  '      at async <anonymous> (/srv/rezics-check/runs/mvrehj2k-66ab964a/services/kernel/test/library/copies.test.ts:224:24)',
  '(fail) replays return the original copy and a reused key with a different body conflicts [21.75ms]',
].join('\n');

function fakes(results: Record<string, string | Error> = {}) {
  const events: string[] = [];
  let held = false;
  const log: string[] = [];
  const runner = {
    create: (file: string) => void events.push(`create ${file} held=${held}`),
    run: async (file: string, _database: string, env?: Record<string, string>) => {
      events.push(`run ${file} held=${held} slot=${env?.REZICS_STACK_SLOT ?? 'none'}`);
      const result = results[file] ?? 'ok';
      if (result instanceof Error) throw result;
      return result;
    },
    drop: (file: string) => void events.push(`drop ${file} held=${held}`),
  };
  const lease = async <T>(label: string, run: (env: Record<string, string>) => Promise<T>): Promise<T> => {
    events.push(`lease ${label}`);
    held = true;
    try {
      return await run({ REZICS_STACK_SLOT: '0/1' });
    } finally {
      held = false;
      events.push('release');
    }
  };
  return { events, log, runner, lease, write: (text: string) => void log.push(text) };
}

test('overload and deadline failures are rerun alone under a stack slot and passing files are reported as load-sensitive', async () => {
  const { events, log, runner, lease, write } = fakes();
  const outcome = failed(
    'test/loaded.test.ts',
    gateOverloadFailure,
    testFailure('access deadline', 'AccessUnavailableError: Access unavailable: deadline'),
    testFailure('command deadline', 'CommandUnavailableError: Command unavailable for partition 0: deadline'),
  );

  const result = await rerunGrowthFailures([outcome], runner, lease, write);

  expect(result.failed).toEqual([]);
  expect(events).toEqual([
    'lease kernel growth rerun',
    'create test/loaded.test.ts held=true',
    'run test/loaded.test.ts held=true slot=0/1',
    'drop test/loaded.test.ts held=true',
    'release',
  ]);
  expect(log.join('')).toContain('Load-sensitive tests (passed alone): 3\n');
  expect(log.join('')).toContain(
    'load-sensitive test: test/loaded.test.ts :: replays return the original copy and a reused key with a different body conflicts :: CommandUnavailableError: Command unavailable for partition 556: overloaded\n',
  );
  expect(log.join('')).toContain(
    'load-sensitive test: test/loaded.test.ts :: access deadline :: AccessUnavailableError: Access unavailable: deadline\n',
  );
  expect(log.join('')).toContain(
    'load-sensitive test: test/loaded.test.ts :: command deadline :: CommandUnavailableError: Command unavailable for partition 0: deadline\n',
  );
  expectRerunSummary(log, 1, 1);
});

test('database storage, connection, startup, and timeout errors are load-induced', async () => {
  const messages = [
    ['clients', 'error: sorry, too many clients already'],
    ['database connections', 'error: too many connections for database'],
    ['reserved connections', 'error: remaining connection slots are reserved'],
    ['starting up', 'error: the database system is starting up'],
    ['shutting down', 'error: the database system is shutting down'],
    ['database storage', 'error: could not extend file "base/16384/99123": No space left on device'],
    ['53300 code', 'error: database command failed\n    code: "53300",'],
    ['53100 code', 'error: database command failed\n    code: "53100",'],
    ['57P03 code', 'error: database command failed\n    code: "57P03",'],
    ['deadline_exceeded', 'error: deadline_exceeded'],
    ['problem JSON code', 'error: {"code":"deadline_exceeded"}'],
    ['problem object code', 'error: helper returned code: "transaction_retry_exhausted"'],
    ['unprefixed access overload', 'error: Access unavailable: overloaded'],
    ['test timeout', 'error: this test timed out after 60000ms'],
    ['hook timeout', 'beforeAll hook timed out after 5000ms'],
  ] as const;
  const { events, log, runner, lease, write } = fakes();
  const outcomes = messages.map(([title, message], index) =>
    failed(`test/load-${index}.test.ts`, testFailure(title, message)),
  );

  const result = await rerunGrowthFailures(outcomes, runner, lease, write);

  expect(result.failed).toEqual([]);
  expect(events.filter((event) => event.startsWith('lease '))).toHaveLength(messages.length);
  expect(events.filter((event) => event.startsWith('run '))).toHaveLength(messages.length);
  expect(events.filter((event) => event.includes('held=true slot=0/1'))).toHaveLength(messages.length);
  expect(log.join('')).toContain(`Load-sensitive tests (passed alone): ${messages.length}\n`);
  for (const [title] of messages) expect(log.join('')).toContain(`:: ${title} ::`);
  expectRerunSummary(log, messages.length, messages.length);
});

test('a passing test, source excerpts, stack frames and Expected values naming load errors do not qualify a file', async () => {
  const { events, log, runner, lease, write } = fakes();
  const output = [
    '(pass) remaining connection slots are reserved [1.00ms]',
    "1 | throw new Error('No space left on device');",
    'error: expect(received).toBe(expected)',
    'Expected: "Command unavailable for partition 5: overloaded"',
    '      at CommandUnavailableError: Command unavailable for partition 5: overloaded (/tmp/overloaded.ts:1:1)',
    '(fail) unrelated assertion [1.00ms]',
    summary(1).trimStart(),
  ].join('\n');

  const result = await rerunGrowthFailures(
    [{ file: 'test/unrelated.test.ts', database: 'kernel_test_1', error: new Error(output) }],
    runner,
    lease,
    write,
  );

  expect(result.failed.map((outcome) => outcome.file)).toEqual(['test/unrelated.test.ts']);
  expect(events).toEqual([]);
  expectRerunSummary(log, 0, 0);
});

test('wrapped overload messages qualify mixed failures and mark the unrelated failures as cascades', async () => {
  const { events, log, runner, lease, write } = fakes();
  const outcome = failed(
    'test/mixed.test.ts',
    testFailure(
      'retry exhaustion',
      'error: Step content.import.step has exceeded its maximum of 100 retries. Previous errors: Command unavailable for partition 2: overloaded',
    ),
    testFailure(
      'problem response',
      'error: Setup POST http://127.0.0.1:41234/v1/grants failed (503): {"type":"about:blank","title":"Service Unavailable","status":503,"code":"overloaded"}',
    ),
    testFailure('http helper', 'error: Public /v1/grants subject:create: HTTP 503'),
    testFailure('assertion', 'error: expect(received).toBe(expected)'),
  );

  const result = await rerunGrowthFailures([outcome], runner, lease, write);

  expect(result.failed).toEqual([]);
  expect(events.filter((event) => event.startsWith('run '))).toEqual([
    'run test/mixed.test.ts held=true slot=0/1',
  ]);
  expect(log.join('')).toContain('Load-sensitive tests (passed alone): 4\n');
  expect(log.join('')).toContain(':: retry exhaustion ::');
  expect(log.join('')).toContain(':: problem response ::');
  expect(log.join('')).toContain(':: http helper ::');
  expect(log.join('')).toContain(':: assertion (cascade) :: error: expect(received).toBe(expected)');
  expectRerunSummary(log, 1, 1);
});

test('an unhandled error with a load signal makes the file eligible', async () => {
  const { events, log, runner, lease, write } = fakes();
  const unhandled = {
    file: 'test/unhandled.test.ts',
    database: 'kernel_test_1',
    error: new Error(
      `bun test failed:\n${testFailure('assertion', 'error: expect(received).toBe(expected)')}\n# Unhandled error: Access unavailable: overloaded${summary(1)}`,
    ),
  };

  const result = await rerunGrowthFailures([unhandled], runner, lease, write);

  expect(result.failed).toEqual([]);
  expect(events.filter((event) => event.startsWith('run '))).toEqual([
    'run test/unhandled.test.ts held=true slot=0/1',
  ]);
  expect(log.join('')).toContain(':: assertion (cascade) ::');
  expect(log.join('')).toContain(':: unhandled error :: error: Access unavailable: overloaded');
  expectRerunSummary(log, 1, 1);
});

test('a Received value carrying a load signal makes its assertion failure eligible', async () => {
  const { events, log, runner, lease, write } = fakes();
  const outcome = failed(
    'test/received.test.ts',
    [
      'error: expect(received).toBe(expected)',
      'Expected: "granted"',
      'Received: Command unavailable for partition 91: overloaded',
      '      at <anonymous> (received.test.ts:1:1)',
      '(fail) returned grant [2.00ms]',
    ].join('\n'),
  );

  const result = await rerunGrowthFailures([outcome], runner, lease, write);

  expect(result.failed).toEqual([]);
  expect(events.filter((event) => event.startsWith('run '))).toEqual([
    'run test/received.test.ts held=true slot=0/1',
  ]);
  expect(log.join('')).toContain('Load-sensitive tests (passed alone): 1\n');
  expectRerunSummary(log, 1, 1);
});

test('a timeout printed after the failed test line makes the file eligible', async () => {
  const { events, log, runner, lease, write } = fakes();
  const outcome = failed(
    'test/timeout.test.ts',
    [
      'error: expect(received).toBe(expected)',
      '(fail) access remains available [180000.12ms]',
      '  ^ this test timed out after 180000ms.',
    ].join('\n'),
  );

  const result = await rerunGrowthFailures([outcome], runner, lease, write);

  expect(result.failed).toEqual([]);
  expect(events.filter((event) => event.startsWith('run '))).toEqual([
    'run test/timeout.test.ts held=true slot=0/1',
  ]);
  expect(log.join('')).toContain(':: this test timed out after 180000ms.');
  expectRerunSummary(log, 1, 1);
});

test('the rerun summary counts files, total alone time and files that passed alone', async () => {
  const again = failed('test/repeats.test.ts', testFailure('query', 'error: remaining connection slots are reserved'));
  const { events, log, runner, lease, write } = fakes({ 'test/repeats.test.ts': again.error! });
  const outcomes = [
    failed('test/passes.test.ts', testFailure('query', 'error: sorry, too many clients already')),
    failed('test/repeats.test.ts', testFailure('query', 'error: remaining connection slots are reserved')),
  ];

  const result = await rerunGrowthFailures(outcomes, runner, lease, write);

  expect(result.failed).toEqual([outcomes[1]!]);
  expect(events.filter((event) => event.startsWith('run '))).toHaveLength(2);
  expectRerunSummary(log, 2, 1);
});

test('a load-induced file that fails again alone remains failed after one rerun', async () => {
  const again = failed('test/repeats.test.ts', testFailure('query', 'error: remaining connection slots are reserved'));
  const { events, log, runner, lease, write } = fakes({ 'test/repeats.test.ts': again.error! });
  const outcome = failed(
    'test/repeats.test.ts',
    testFailure('query', 'error: remaining connection slots are reserved'),
  );

  const result = await rerunGrowthFailures([outcome], runner, lease, write);

  expect(result.failed).toEqual([outcome]);
  expect(events.filter((event) => event.startsWith('run '))).toEqual(['run test/repeats.test.ts held=true slot=0/1']);
  expect(events.filter((event) => event.startsWith('lease '))).toEqual(['lease kernel growth rerun']);
  expect(log.join('')).toContain('remaining connection slots are reserved');
  expect(log.join('')).toContain('failed again alone:');
  expect(log.join('')).not.toContain('Load-sensitive tests (passed alone)');
  expectRerunSummary(log, 1, 0);
});
