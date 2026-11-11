import { expect, test } from 'bun:test';
import { run } from './cli.ts';
import { parseWorkerCommandArguments } from './command-arguments.ts';
import { runWorkerCommand } from './worker-commands.ts';

test('Reject invalid worker commands before recovery', async () => {
  const cases = [
    { argv: ['retry', 'task-1', '--typo', 'value'], usage: 'Error: invalid retry option: --typo' },
    { argv: ['stop', 'task-1', 'extra'], usage: 'Error: usage: stop <task>' },
    { argv: ['dispatch', 'brief.md', 'extra'], usage: 'Error: usage: dispatch [--urgent] <brief>' },
    { argv: ['retry', 'task-1', '--brief'], usage: 'Error: missing value for --brief' },
    { argv: ['retry', 'task-1', '--expected-attempt', '-1'], usage: 'Error: invalid retry option: --expected-attempt' },
    { argv: ['retry', 'task-1', '--proof-start'], usage: 'Error: --proof-start requires --expected-attempt' },
    { argv: ['amend', 'task-1'], usage: 'Error: usage: amend <task> --expected-attempt 0 --brief <file>' },
    { argv: ['typing-recover', 'task-1'], usage: 'Error: usage: typing-recover <task> --expected-attempt <n>' },
    {
      argv: ['typing-recover', 'task-1', '--expected-attempt', '0'],
      usage: 'Error: usage: typing-recover <task> --expected-attempt <n>',
    },
    {
      argv: ['amend', 'task-1', '--expected-attempt', '1', '--brief', 'input.md'],
      usage: 'Error: usage: amend <task> --expected-attempt 0 --brief <file>',
    },
    ...['0', '-1', '1.5'].map((attempt) => ({
      argv: ['amend', 'task-1', '--active', '--expected-attempt', attempt, '--brief', 'input.md'],
      usage: 'Error: usage: amend <task> --active --expected-attempt <n> --brief <file>',
    })),
    { argv: ['priority', 'grant', 'task-1', 'extra'], usage: 'Error: usage: priority grant <task>' },
    { argv: ['cancel'], usage: 'Error: usage: cancel <task>' },
    { argv: ['consult', 'task-1', 'extra'], usage: 'Error: usage: consult <task>' },
    { argv: ['retarget', 'task-1'], usage: 'Error: usage: retarget <task> stabilize' },
    { argv: ['event', 'task-1', 'bad', 'done'], usage: 'Error: usage: event <task> <attempt> <kind> [json]' },
    {
      argv: ['attempts', '--task', 'task-1', '--limit', '101'],
      usage:
        'Error: usage: attempts [--json] [--all] | attempts --task <task> [--after <attempt>] [--limit <count>] [--json]',
    },
  ];
  const originalError = console.error;
  try {
    for (const { argv, usage } of cases) {
      let factoryCalls = 0;
      const errors: string[] = [];
      console.error = (...values: unknown[]) => errors.push(values.map(String).join(' '));
      const status = await run(argv, () => {
        factoryCalls++;
        throw new Error('invalid arguments reached runtime creation');
      });
      expect(status).toBe(1);
      expect(factoryCalls).toBe(0);
      expect(errors).toEqual([usage]);
    }
  } finally {
    console.error = originalError;
  }
});

test('direct worker callers retain usage rejections before loading services', async () => {
  await expect(runWorkerCommand('priority', ['grant', 'task-1', 'extra'])).rejects.toThrow(
    'usage: priority grant <task>',
  );
});

test('flow report bounds normalize to UTC and require a non-reversed exclusive end', () => {
  expect(
    parseWorkerCommandArguments('report', [
      '--flow',
      '--since',
      '2026-11-10T08:00:00+08:00',
      '--until',
      '2026-11-11T00:00:00Z',
      '--json',
    ]),
  ).toEqual({
    command: 'report',
    flow: true,
    json: true,
    since: '2026-11-10T00:00:00.000Z',
    until: '2026-11-11T00:00:00.000Z',
  });
  expect(() =>
    parseWorkerCommandArguments('report', [
      '--flow',
      '--since',
      '2026-11-11T00:00:00Z',
      '--until',
      '2026-11-10T00:00:00Z',
    ]),
  ).toThrow('--since must be at or before --until');
  expect(() => parseWorkerCommandArguments('report', ['--until', '2026-11-11T00:00:00Z'])).toThrow(
    'usage: report [--flow] [--since <time>] [--until <time>] [--json]',
  );
});
