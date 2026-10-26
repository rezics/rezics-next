import { expect, test } from 'bun:test';
import { attemptEnvironment } from './launch.ts';

test("a worker's kernel check selects the tests its change affects since the task's base", () => {
  expect(attemptEnvironment({ id: 'task', base: 'abc123' }, { attempt: 2 })).toEqual({
    GOAL_TASK_ID: 'task',
    GOAL_ATTEMPT: '2',
    KERNEL_CHECK_AFFECTED: 'abc123',
  });
});
