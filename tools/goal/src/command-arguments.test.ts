import { expect, test } from 'bun:test';
import { run } from './cli.ts';

test('Reject invalid worker commands before recovery', async () => {
  const cases = [
    { argv: ['retry', 'task-1', '--typo', 'value'], usage: 'Error: invalid retry option: --typo' },
    { argv: ['stop', 'task-1', 'extra'], usage: 'Error: usage: stop <task>' },
    { argv: ['dispatch', 'brief.md', 'extra'], usage: 'Error: usage: dispatch <brief>' },
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
