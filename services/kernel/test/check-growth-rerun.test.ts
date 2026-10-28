import { expect, test } from 'bun:test';
import { rerunGrowthFailures, scheduleFiles } from '../scripts/check.ts';

type Outcome = Awaited<ReturnType<typeof scheduleFiles<string>>>[number];

const growth = (title: string, message: string): string =>
  [
    `1 | test(${JSON.stringify(title)}, () => {`,
    'GrowthBoundError: ' + message,
    '      at <anonymous> (growth.ts:1:1)',
    `(fail) ${title} [4.00ms]`,
  ].join('\n');
const expectFailure = (title: string): string =>
  [
    'error: expect(received).toBe(expected)',
    '',
    'Expected: 2',
    'Received: 1',
    '      at <anonymous> (x.test.ts:4:33)',
    `(fail) ${title} [1.00ms]`,
  ].join('\n');
const summary = (failures: number): string =>
  `\n 0 pass\n ${failures} fail\nRan ${failures} tests across 1 file. [9.00ms]`;

function failed(file: string, ...blocks: string[]): Outcome {
  const output = `${blocks.join('\n')}${summary(blocks.length)}`;
  return { file, database: 'kernel_test_1', error: new Error(`bun test ./${file} failed:\n${output}`) };
}

/** Records create, run, drop and lease events in order; `results` gives each rerun's output or failure. */
function fakes(results: Record<string, string | Error>) {
  const events: string[] = [];
  let held = 0;
  const log: string[] = [];
  const runner = {
    create: (file: string) => void events.push(`create ${file} held=${held}`),
    run: async (file: string) => {
      events.push(`run ${file} held=${held}`);
      await Bun.sleep(5);
      const result = results[file] ?? 'ok';
      if (result instanceof Error) throw result;
      return result;
    },
    drop: (file: string) => void events.push(`drop ${file} held=${held}`),
  };
  const lease = async <T>(label: string, run: (env: Record<string, string>) => Promise<T>): Promise<T> => {
    events.push(`lease ${label}`);
    held++;
    try {
      return await run({ REZICS_STACK_SLOT: '0/1' });
    } finally {
      held--;
      events.push('release');
    }
  };
  return { events, log, runner, lease, write: (text: string) => void log.push(text) };
}

test('a file whose only failures are growth bound errors is rerun alone under a stack slot and, passing, is reported as load-sensitive without failing the run', async () => {
  const { events, log, runner, lease, write } = fakes({});
  const suiteEvents: string[] = [];
  const suite = await scheduleFiles(['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'], 3, {
    create: () => {},
    run: async (file) => {
      suiteEvents.push(`suite ${file}`);
      await Bun.sleep(5);
      return file === 'test/c.test.ts' ? 'ok' : `${growth('first', `rows ${file}\nsecond line`)}${summary(1)}`;
    },
    drop: () => {},
  });
  // The suite reports a growth failure as a failed run; build the outcomes the way main sees them.
  const outcomes = suite.map((outcome) =>
    outcome.output?.includes('(fail)')
      ? { file: outcome.file, database: outcome.database, error: new Error(`bun test failed:\n${outcome.output}`) }
      : outcome,
  );

  const result = await rerunGrowthFailures(outcomes, runner, lease, write);

  expect(result.failed).toEqual([]);
  // Only the failed files are rerun, one at a time and each under its own lease, after the whole suite.
  expect(events).toEqual([
    'lease kernel growth rerun',
    'create test/a.test.ts held=1',
    'run test/a.test.ts held=1',
    'drop test/a.test.ts held=1',
    'release',
    'lease kernel growth rerun',
    'create test/b.test.ts held=1',
    'run test/b.test.ts held=1',
    'drop test/b.test.ts held=1',
    'release',
  ]);
  expect(suiteEvents).toHaveLength(3);
  const text = log.join('');
  expect(text).toContain('load-sensitive growth check: test/a.test.ts :: first :: rows test/a.test.ts\n');
  expect(text).toContain('load-sensitive growth check: test/b.test.ts :: first :: rows test/b.test.ts\n');
  expect(text).not.toContain('second line');
  expect(text).toContain('Load-sensitive growth checks (passed alone): 2\n');
  expect(text.indexOf('Load-sensitive growth checks')).toBeLessThan(text.indexOf('load-sensitive growth check:'));
});

test('a growth file that fails again alone fails the run', async () => {
  const { events, log, runner, lease, write } = fakes({
    'test/a.test.ts': new Error(`bun test ./test/a.test.ts failed:\n${growth('first', 'rows again')}${summary(1)}`),
  });
  const outcomes = [
    failed('test/a.test.ts', growth('first', 'rows once')),
    failed('test/b.test.ts', growth('second', 'x')),
  ];

  const result = await rerunGrowthFailures(outcomes, runner, lease, write);

  expect(result.failed.map((outcome) => outcome.file)).toEqual(['test/a.test.ts']);
  expect(events.filter((event) => event.startsWith('run'))).toEqual([
    'run test/a.test.ts held=1',
    'run test/b.test.ts held=1',
  ]);
  const text = log.join('');
  // Both outputs of the file that failed twice are printed.
  expect(text).toContain('rows once');
  expect(text).toContain('rows again');
  expect(text).toContain('Load-sensitive growth checks (passed alone): 1\n');
  expect(text).not.toContain('load-sensitive growth check: test/a.test.ts');
});

test('growth failures keep a file eligible despite cascades while files without growth or load signals stay failed', async () => {
  const { events, log, runner, lease, write } = fakes({});
  const unhandled = ['error: unhandled late', '      at <anonymous> (x.test.ts:5:1)', '(fail) late [5.00ms]'].join(
    '\n',
  );
  const beforeAll = ['error: setup failed', '(fail) (unnamed) [0.20ms]'].join('\n');
  const timeout = `${growth('first', 'rows')}\n(fail) slow [60000.00ms]\n  ^ this test timed out after 60000ms.`;
  const outcomes: Outcome[] = [
    failed('test/mixed.test.ts', growth('first', 'rows'), expectFailure('second')),
    failed('test/unhandled.test.ts', growth('first', 'rows'), unhandled),
    failed('test/before.test.ts', beforeAll),
    {
      file: 'test/timeout.test.ts',
      database: 'kernel_test_1',
      error: new Error(`bun test ./test/timeout.test.ts failed:\n${timeout}${summary(2)}`),
    },
    {
      file: 'test/exit.test.ts',
      database: 'kernel_test_1',
      error: new Error('bun test ./test/exit.test.ts failed:\nerror: Cannot find module "./missing"\n'),
    },
    {
      file: 'test/cleanup.test.ts',
      database: 'kernel_test_1',
      output: `${growth('first', 'rows')}${summary(1)}`,
      error: new Error(
        `bun test failed:\n${growth('first', 'rows')}${summary(1)}\nDatabase cleanup failed: drop refused`,
      ),
    },
    { file: 'test/create.test.ts', database: 'kernel_test_1', error: new Error('psql -c CREATE DATABASE failed') },
    { file: 'test/passed.test.ts', database: 'kernel_test_1', output: 'ok' },
  ];

  const result = await rerunGrowthFailures(outcomes, runner, lease, write);

  expect(events.filter((event) => event.startsWith('run'))).toEqual([
    'run test/mixed.test.ts held=1',
    'run test/unhandled.test.ts held=1',
    'run test/timeout.test.ts held=1',
  ]);
  expect(result.failed.map((outcome) => outcome.file)).toEqual([
    'test/before.test.ts',
    'test/exit.test.ts',
    'test/cleanup.test.ts',
    'test/create.test.ts',
  ]);
  expect(log.join('')).toContain(
    'load-sensitive test: test/mixed.test.ts :: second (cascade) :: error: expect(received).toBe(expected)',
  );
  expect(log.join('')).toContain(
    'load-sensitive test: test/unhandled.test.ts :: late (cascade) :: error: unhandled late',
  );
  expect(log.join('')).toContain(
    'load-sensitive test: test/timeout.test.ts :: slow :: this test timed out after 60000ms.',
  );
  expect(log.join('')).toContain('Load-sensitive growth checks (passed alone):');
  expect(log.join('')).toContain('Load reruns: 3 files, ');
  expect(log.join('')).toContain('(3 passed alone)');
});
