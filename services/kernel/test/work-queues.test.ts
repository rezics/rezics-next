import { expect, test } from 'bun:test';
import { CommandUnavailableError, IdempotencyConflictError } from '../src/command/command.ts';
import { WORK_QUEUES } from '../src/work/queues.ts';
import { COMMAND_STEP_RETRIES } from '../src/work/retries.ts';

test('every work queue except workflows bounds its per-process concurrency', () => {
  const unbounded = Object.entries(WORK_QUEUES)
    .filter(([, options]) => options.workerConcurrency === undefined)
    .map(([name]) => name);

  expect(unbounded).toEqual(['workflows']);
  for (const [name, options] of Object.entries(WORK_QUEUES)) {
    if (name === 'workflows') continue;
    expect(Number.isInteger(options.workerConcurrency) && options.workerConcurrency! > 0 && options.workerConcurrency! <= 8)
      .toBe(true);
  }
});

test('command step retries retry transient command unavailability only', () => {
  for (const reason of ['overloaded', 'contention', 'deadline', 'fenced'] as const) {
    expect(COMMAND_STEP_RETRIES.shouldRetry(new CommandUnavailableError(reason, 1))).toBe(true);
  }

  expect(COMMAND_STEP_RETRIES.shouldRetry(new CommandUnavailableError('moved', 1, 'node-b'))).toBe(false);
  expect(COMMAND_STEP_RETRIES.shouldRetry(new IdempotencyConflictError(1))).toBe(false);
  expect(COMMAND_STEP_RETRIES.shouldRetry(new Error('other failure'))).toBe(false);
});
