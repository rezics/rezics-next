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
  expect(log.join('')).toBe(
    [
      'Load-sensitive tests (passed alone): 3',
      'load-sensitive test: test/loaded.test.ts :: replays return the original copy and a reused key with a different body conflicts :: CommandUnavailableError: Command unavailable for partition 556: overloaded',
      'load-sensitive test: test/loaded.test.ts :: access deadline :: AccessUnavailableError: Access unavailable: deadline',
      'load-sensitive test: test/loaded.test.ts :: command deadline :: CommandUnavailableError: Command unavailable for partition 0: deadline',
      '',
    ].join('\n'),
  );
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
});

test('a passing test and source or stack lines naming load errors do not make a failure load-induced', async () => {
  const { events, log, runner, lease, write } = fakes();
  const output = [
    '(pass) remaining connection slots are reserved [1.00ms]',
    "1 | throw new Error('No space left on device');",
    'error: expect(received).toBe(expected)',
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
  expect(log).toEqual([]);
});

test('a file with any other failure is not rerun', async () => {
  const { events, log, runner, lease, write } = fakes();
  const outcome = failed(
    'test/mixed.test.ts',
    testFailure('temporary overload', 'CommandUnavailableError: Command unavailable for partition 2: overloaded'),
    testFailure('assertion', 'error: expect(received).toBe(expected)'),
  );
  const unhandled = {
    file: 'test/unhandled.test.ts',
    database: 'kernel_test_1',
    error: new Error(
      `bun test failed:\n${testFailure('temporary overload', 'CommandUnavailableError: Command unavailable for partition 2: overloaded')}\n# Unhandled error: background task failed${summary(1)}`,
    ),
  };

  const result = await rerunGrowthFailures([outcome, unhandled], runner, lease, write);

  expect(result.failed.map((item) => item.file)).toEqual(['test/mixed.test.ts', 'test/unhandled.test.ts']);
  expect(events).toEqual([]);
  expect(log).toEqual([]);
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
});
