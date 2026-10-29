import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watch } from './watchdog.ts';
import { repository } from './test-support.ts';
import { git } from './tasks.ts';
import type { Attempt, RetryIntent, Task } from './types.ts';

const now = Date.parse('2026-10-29T12:00:00.000Z');

function runningStore(task: Partial<Task>, attempt: Partial<Attempt>) {
  const fullTask = {
    id: 'long-task',
    state: 'running',
    currentAttempt: 1,
    brief: { goal: 'control-plane', manager: 'manager-a' },
    ...task,
  } as Task;
  const fullAttempt = {
    taskId: fullTask.id,
    attempt: 1,
    state: 'running',
    startedAt: new Date(now - 2 * 60 * 60_000 - 20 * 60_000).toISOString(),
    logPath: join(fullTask.worktree, 'run.jsonl'),
    ...attempt,
  } as Attempt;
  return {
    tasks: () => [fullTask],
    attempt: () => fullAttempt,
    retryIntents: () => [] as RetryIntent[],
    attemptsEndedBetween: () => [] as Attempt[],
  };
}

function runWatch(store: ReturnType<typeof runningStore>, state: string, delivered: unknown[], at = now) {
  return watch(
    store,
    state,
    { stabilize: 'missing-stabilize', integration: 'missing-dev' },
    state,
    (summary, managerId, kind) => delivered.push({ summary, managerId, kind }),
    at,
    () => {},
  );
}

test('an attempt over the default two hour limit reports its duration, commits, check wait and ten recent commands once to its manager', () => {
  const repo = repository();
  const worker = repo.branch('long-worker', 'change.txt');
  const state = join(repo.path, 'state');
  mkdirSync(state);
  const logPath = join(worker.worktree, 'run.jsonl');
  const commands = Array.from({ length: 12 }, (_, index) => `bun scripts/worker-check.ts -- bun test test-${index}.ts`);
  writeFileSync(
    logPath,
    commands
      .map((command) => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command } }))
      .join('\n'),
  );
  writeFileSync(logPath.replace(/\.jsonl$/, '.check-wait'), '60000\n120000\n');
  const store = runningStore({ worktree: worker.worktree, base: git(repo.main, ['rev-parse', 'main']) }, { logPath });
  const delivered: { summary: string; managerId?: string; kind?: string }[] = [];
  try {
    expect(runWatch(store, state, delivered)).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ managerId: 'manager-a', kind: 'stalled' });
    expect(delivered[0]!.summary).toContain('2h 20m');
    expect(delivered[0]!.summary).toContain('1 commits');
    expect(delivered[0]!.summary).toContain('3m spent waiting for check slots');
    expect(delivered[0]!.summary).toContain(commands.slice(-10).join(' | '));
    expect(delivered[0]!.summary).not.toContain(commands[0]!);
    expect(runWatch(store, state, delivered, now + 5 * 60_000)).toBe(0);
    expect(runWatch(store, state, delivered, now + 3 * 60 * 60_000)).toBe(0);
    expect(delivered).toHaveLength(1);
  } finally {
    repo.close();
  }
});

test('repeated process inspection in recent commands reports polling once when no worker-check wait appears', () => {
  const repo = repository();
  const worker = repo.branch('polling-worker', 'change.txt');
  const state = join(repo.path, 'state');
  mkdirSync(state);
  const logPath = join(worker.worktree, 'run.jsonl');
  const commands = ['git status --short', 'ps -ef', 'pgrep -af worker', 'rg acceptance tools/goal'];
  appendFileSync(
    logPath,
    commands
      .map((command) => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command } }))
      .join('\n'),
  );
  const store = runningStore({ worktree: worker.worktree, base: git(repo.main, ['rev-parse', 'main']) }, { logPath });
  const delivered: { summary: string; managerId?: string; kind?: string }[] = [];
  try {
    expect(runWatch(store, state, delivered)).toBe(2);
    expect(delivered.map(({ summary }) => summary).join('\n')).toContain('Polling:');
    expect(delivered[1]).toMatchObject({ managerId: 'manager-a', kind: 'stalled' });
    expect(runWatch(store, state, delivered, now + 5 * 60_000)).toBe(0);
    expect(runWatch(store, state, delivered, now + 3 * 60 * 60_000)).toBe(0);
    expect(delivered.filter(({ summary }) => summary.startsWith('Polling:'))).toHaveLength(1);
  } finally {
    repo.close();
  }
});
