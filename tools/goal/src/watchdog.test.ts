import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { violations, watch } from './watchdog.ts';
import type { Attempt, RetryIntent, Task } from './types.ts';

const now = Date.parse('2026-10-26T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function store(tasks: Partial<Task>[], attempts: Partial<Attempt>[], intents: Partial<RetryIntent>[] = []) {
  return {
    tasks: () => tasks.map((task) => ({ brief: { goal: 'accounts' }, ...task }) as Task),
    attempt: (ref: { taskId: string; attempt: number }) =>
      attempts.find((attempt) => attempt.taskId === ref.taskId && attempt.attempt === ref.attempt) as Attempt,
    retryIntents: () => intents as RetryIntent[],
  };
}

test('a running task whose attempt ended and that nothing will retry is a violation after ten minutes', () => {
  const tasks = [
    { id: 'stuck', state: 'running' as const, currentAttempt: 2 },
    { id: 'recent', state: 'running' as const, currentAttempt: 1 },
    { id: 'live', state: 'running' as const, currentAttempt: 1 },
    { id: 'queued', state: 'ready' as const, currentAttempt: 1 },
    { id: 'lost', state: 'ready' as const, currentAttempt: 3 },
  ];
  const attempts = [
    { taskId: 'stuck', attempt: 2, state: 'exited' as const, endedAt: minutesAgo(30) },
    { taskId: 'recent', attempt: 1, state: 'exited' as const, endedAt: minutesAgo(2) },
    { taskId: 'live', attempt: 1, state: 'running' as const, endedAt: null },
    { taskId: 'queued', attempt: 1, state: 'exited' as const, endedAt: minutesAgo(30) },
    { taskId: 'lost', attempt: 3, state: 'exited' as const, endedAt: minutesAgo(45) },
  ];
  const intents = [{ taskId: 'lost', attempt: 3, status: 'pending' as const }];
  const found = violations(store(tasks, attempts, intents), now);
  expect(found.map((violation) => violation.key)).toEqual(['no-worker:stuck:2', 'no-worker:lost:3']);
  expect(found[1]!.summary).toContain('pending retry for 45 min');
});

test('stabilize missing from dev is reported after thirty minutes, once per period, and forgotten once merged', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-watchdog-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  try {
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
    git('branch', 'dev');
    git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fix');
    git('branch', 'stabilize');
    const empty = store([], []);
    const branches = { stabilize: 'stabilize', integration: 'dev' };
    const delivered: string[] = [];
    const deliver = (summary: string) => delivered.push(summary);

    expect(watch(empty, root, branches, root, deliver, now)).toBe(0);
    expect(watch(empty, root, branches, root, deliver, now + 31 * 60_000)).toBe(1);
    expect(watch(empty, root, branches, root, deliver, now + 40 * 60_000)).toBe(0);
    expect(delivered[0]).toContain('dev has not contained stabilize for 31 min');

    git('branch', '-f', 'dev', 'stabilize');
    expect(watch(empty, root, branches, root, deliver, now + 50 * 60_000)).toBe(0);
    git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'next');
    git('branch', '-f', 'stabilize', 'main');
    expect(watch(empty, root, branches, root, deliver, now + 60 * 60_000)).toBe(0);
    expect(watch(empty, root, branches, root, deliver, now + 95 * 60_000)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
