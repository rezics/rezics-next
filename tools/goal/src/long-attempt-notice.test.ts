import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from './watchdog.ts';
import { repository } from './test-support.ts';
import { git } from './tasks.ts';
import type { Attempt, RetryIntent, Task } from './types.ts';

const now = Date.parse('2026-10-29T12:00:00.000Z');

function setup() {
  const repo = repository();
  const worker = repo.branch('long-notice-worker', 'change.txt');
  const state = join(repo.path, 'state');
  mkdirSync(state);
  const logPath = join(worker.worktree, 'run.jsonl');
  const task = {
    id: 'long-notice-task', state: 'running', currentAttempt: 3,
    brief: { goal: 'control-plane', manager: 'manager-a' }, worktree: worker.worktree,
    base: git(repo.main, ['rev-parse', 'main']),
  } as Task;
  const attempt = {
    taskId: task.id, attempt: 3, state: 'running', startedAt: new Date(now - 2 * 60 * 60_000).toISOString(), logPath,
  } as Attempt;
  const store = {
    tasks: () => [task], attempt: () => attempt, retryIntents: () => [] as RetryIntent[],
    attemptsEndedBetween: () => [] as Attempt[],
  };
  const delivered: string[] = [];
  const run = (at: number) => watch(
    store, repo.path, { stabilize: 'missing-stabilize', integration: 'missing-dev' }, state,
    (summary) => delivered.push(summary), at, () => {},
  );
  return { repo, worker, state, logPath, task, delivered, run };
}

test('a long attempt is reported once when it crosses the threshold, then at most once an hour while its last command and commit count are unchanged', () => {
  const value = setup();
  try {
    const firstThreshold = now + 1;
    expect(value.run(firstThreshold)).toBe(1);
    expect(value.run(firstThreshold + 59 * 60_000)).toBe(0);
    expect(value.run(firstThreshold + 60 * 60_000)).toBe(1);
    expect(value.run(firstThreshold + 3 * 60 * 60_000)).toBe(1);
    expect(value.delivered).toHaveLength(3);
  } finally {
    value.repo.close();
  }
});

test('a long attempt is reported again at once when its last command or commit count changes', () => {
  const value = setup();
  try {
    const threshold = now + 1;
    expect(value.run(threshold)).toBe(1);
    appendFileSync(value.logPath, JSON.stringify({ type: 'item.completed', item: { id: 'new-command', type: 'command_execution', command: 'bun test changed.ts' } }) + '\n');
    expect(value.run(threshold + 1_000)).toBe(1);
    writeFileSync(join(value.worker.worktree, 'commit-change.txt'), 'new commit\n');
    git(value.worker.worktree, ['add', 'commit-change.txt']);
    git(value.worker.worktree, ['commit', '-m', 'advance attempt']);
    expect(value.run(threshold + 2_000)).toBe(1);
    expect(value.delivered).toHaveLength(3);
  } finally {
    value.repo.close();
  }
});
