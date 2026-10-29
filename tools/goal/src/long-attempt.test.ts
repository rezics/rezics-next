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

test('a configured limit reports a younger attempt without subtracting check waits', () => {
  const repo = repository();
  try {
    const worker = repo.branch('configured-worker', 'change.txt');
    const state = join(repo.path, 'state');
    mkdirSync(state);
    const logPath = join(worker.worktree, 'run.jsonl');
    writeFileSync(logPath.replace(/\.jsonl$/, '.check-wait'), '1200000\n');
    const store = runningStore(
      { worktree: worker.worktree, base: git(repo.main, ['rev-parse', 'main']) },
      { logPath, startedAt: new Date(now - 30 * 60_000).toISOString() },
    );
    const delivered: string[] = [];
    expect(runWatch(store, state, delivered)).toBe(0);
    expect(watch(store, state, { stabilize: 'missing', integration: 'missing' }, state,
      (summary) => delivered.push(summary), now, () => {}, () => 20 * 60_000)).toBe(1);
    expect(delivered[0]).toContain('30m');
    expect(delivered[0]).toContain('20m spent waiting for check slots');
  } finally {
    repo.close();
  }
});

test('command lifecycle entries count once and polling stays reported after a check wait leaves recent commands', () => {
  const repo = repository();
  try {
    const worker = repo.branch('lifecycle-worker', 'change.txt');
    const state = join(repo.path, 'state');
    mkdirSync(state);
    const logPath = join(worker.worktree, 'run.jsonl');
    const store = runningStore(
      { worktree: worker.worktree, base: git(repo.main, ['rev-parse', 'main']) },
      { logPath, startedAt: new Date(now - 5 * 60_000).toISOString() },
    );
    const delivered: string[] = [];
    const record = (id: string, command: string) => {
      for (const type of ['item.started', 'item.completed'])
        appendFileSync(logPath, JSON.stringify({ type, item: { id, type: 'command_execution', command } }) + '\n');
    };
    record('ps', 'ps -ef');
    expect(runWatch(store, state, delivered)).toBe(0);
    record('pgrep', 'pgrep -af worker');
    expect(runWatch(store, state, delivered)).toBe(1);
    record('wait', 'bun scripts/worker-check.ts --wait 00000000-0000-0000-0000-000000000000');
    expect(runWatch(store, state, delivered)).toBe(0);
    for (let index = 0; index < 10; index++) record(`poll-${index}`, 'ps -ef');
    expect(runWatch(store, state, delivered)).toBe(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ summary: expect.stringContaining('Polling:') });
  } finally {
    repo.close();
  }
});

test('rollout and Claude commands expose shell commands and worker-check waits suppress polling', () => {
  const repo = repository();
  try {
    const worker = repo.branch('formats-worker', 'change.txt');
    const state = join(repo.path, 'state');
    mkdirSync(state);
    const logPath = join(worker.worktree, 'run.jsonl');
    const store = runningStore(
      { worktree: worker.worktree, base: git(repo.main, ['rev-parse', 'main']) },
      { logPath },
    );
    const commands = ['ps -ef', 'pgrep -af worker', 'bun scripts/worker-check.ts --wait check-id'];
    writeFileSync(logPath, [
      { type: 'response_item', payload: { type: 'function_call', call_id: 'ps', arguments: JSON.stringify({ cmd: commands[0] }) } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'pgrep', input: { command: commands[1] } }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'wait', arguments: JSON.stringify({ cmd: commands[2] }) } },
    ].map((event) => JSON.stringify(event)).join('\n'));
    const delivered: string[] = [];
    expect(watch(store, state, { stabilize: 'missing', integration: 'missing' }, state,
      (summary) => delivered.push(summary), now, () => {})).toBe(1);
    expect(delivered[0]).toContain(commands.join(' | '));
    expect(delivered[0]).not.toContain('"cmd"');
  } finally {
    repo.close();
  }
});
