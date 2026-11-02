import { expect, test } from 'bun:test';
import { run } from './cli.ts';
import { runWorkerCommand } from './worker-commands.ts';

test('Reject invalid worker commands before recovery', async () => {
  const cases = [
    { argv: ['retry', 'task-1', '--typo', 'value'], usage: 'Error: invalid retry option: --typo' },
    { argv: ['stop', 'task-1', 'extra'], usage: 'Error: usage: stop <task>' },
    { argv: ['dispatch', 'brief.md', 'extra'], usage: 'Error: usage: dispatch <brief>' },
    { argv: ['retry', 'task-1', '--brief'], usage: 'Error: missing value for --brief' },
    { argv: ['retry', 'task-1', '--expected-attempt', '-1'], usage: 'Error: invalid retry option: --expected-attempt' },
    { argv: ['retry', 'task-1', '--proof-start'], usage: 'Error: --proof-start requires --expected-attempt' },
    { argv: ['amend', 'task-1'], usage: 'Error: usage: amend <task> --expected-attempt 0 --brief <file>' },
    { argv: ['priority', 'grant', 'task-1', 'extra'], usage: 'Error: usage: priority grant <task>' },
    { argv: ['cancel'], usage: 'Error: usage: cancel <task>' },
    { argv: ['consult', 'task-1', 'extra'], usage: 'Error: usage: consult <task>' },
    { argv: ['retarget', 'task-1'], usage: 'Error: usage: retarget <task> stabilize' },
    { argv: ['event', 'task-1', 'bad', 'done'], usage: 'Error: usage: event <task> <attempt> <kind> [json]' },
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
