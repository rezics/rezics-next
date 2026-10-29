import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processIdentity } from './process.ts';
import { watch } from './watchdog.ts';
import type { Attempt, RetryIntent, Task } from './types.ts';

const now = Date.parse('2026-10-29T12:00:00.000Z');

function fixture(prefix: string) {
  const temporaryRoot = join(import.meta.dir, '../../../.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(join(temporaryRoot, prefix));
  mkdirSync(join(root, 'capacity-queue'));
  const task = {
    id: 'retry-task',
    state: 'ready',
    currentAttempt: 2,
    brief: { goal: 'retry goal', manager: 'manager' },
  } as unknown as Task;
  const attempt = {
    taskId: task.id,
    attempt: 2,
    state: 'exited',
    endedAt: new Date(now - 30 * 60_000).toISOString(),
  } as unknown as Attempt;
  const intent = { taskId: task.id, attempt: 2, status: 'pending' } as RetryIntent;
  const store = {
    tasks: () => [task],
    attempt: () => attempt,
    retryIntents: () => [intent],
    attemptsEndedBetween: () => [],
  };
  const delivered: string[] = [];
  const deliver = (summary: string) => delivered.push(summary);
  const run = (at = now) => watch(store, root, { stabilize: 'stabilize', integration: 'dev' }, root, deliver, at);
  return { root, task, delivered, run };
}

test('a ready task with a pending retry whose capacity-queue ticket belongs to a live process is not reported as having no worker', () => {
  const value = fixture('goal-watchdog-live-ticket-');
  try {
    const identity = processIdentity();
    expect(identity).not.toBeNull();
    const ticket = `${String(now).padStart(15, '0')}-${identity!.pid}-${value.task.id}`;
    writeFileSync(join(value.root, 'capacity-queue', ticket), '');

    expect(value.run()).toBe(0);
    expect(value.delivered).toEqual([]);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('a ready task with a pending retry and no live ticket or driver is still reported, once per violation and period', () => {
  const value = fixture('goal-watchdog-orphan-ticket-');
  try {
    writeFileSync(join(value.root, 'capacity-queue', `${String(now).padStart(15, '0')}-0-${value.task.id}`), '');

    expect(value.run()).toBe(1);
    expect(value.run(now + 60 * 60_000)).toBe(0);
    expect(value.run(now + 2 * 60 * 60_000)).toBe(1);
    expect(value.delivered).toHaveLength(2);
    expect(value.delivered[0]).toContain('pending retry for 30 min');
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
