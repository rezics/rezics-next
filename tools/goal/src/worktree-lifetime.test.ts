import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { harness } from './test-support.ts';
import { git } from './tasks.ts';
import { removeFinishedWorktree, IO_PRESSURE_LIMIT, type LifetimeRuntime } from './worktree-lifetime.ts';

function setup(state: 'integrated' | 'merged' | 'cancelled' | 'running' | 'landing' | 'ready' | 'held' | 'stopped' = 'integrated') {
  const h = harness();
  const task = h.tasks.dispatch(h.briefFile);
  h.store.updateTask({ taskId: task.id, attempt: 0 }, (row) => { row.state = state; });
  return { h, task: h.store.task(task.id) };
}
function fake(overrides: Partial<LifetimeRuntime> = {}): LifetimeRuntime {
  return {
    pressure: () => null,
    sleep: async () => {},
    command: (command, args, cwd) => {
      const gitIndex = args.indexOf('git');
      const actual = args.slice(gitIndex + 1);
      const result = Bun.spawnSync(['git', ...actual], { cwd, stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0 && !(actual[0] === 'worktree' && actual[1] === 'remove' && !existsSync(actual.at(-1)!)))
        throw new Error(new TextDecoder().decode(result.stderr));
      void command;
    },
    ...overrides,
  };
}

test('a task worktree is removed after integration, merge or cancellation while its branch and commits stay', async () => {
  for (const state of ['integrated', 'merged', 'cancelled'] as const) {
    const { h, task } = setup(state);
    try {
      git(task.worktree, ['commit', '--allow-empty', '-m', 'retained task commit']);
      const head = git(task.worktree, ['rev-parse', 'HEAD']);
      await removeFinishedWorktree(h.settings, h.store, fake());
      expect(existsSync(task.worktree)).toBe(false);
      expect(git(h.root, ['rev-parse', task.branch])).toBe(head);
    } finally { h.dispose(); }
  }
}, 30_000);

test('worktrees of running, landing, ready, held and stopped tasks are never removed', async () => {
  const { h, task } = setup('running');
  try {
    for (const state of ['running', 'landing', 'ready', 'held', 'stopped'] as const) {
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (row) => { row.state = state; });
      await removeFinishedWorktree(h.settings, h.store, fake());
      expect(existsSync(task.worktree)).toBe(true);
    }
  } finally { h.dispose(); }
}, 30_000);

test('removal takes one worktree at a time and waits while disk pressure is above the limit', async () => {
  const { h, task } = setup('integrated');
  const second = h.tasks.dispatch(h.briefFile);
  h.store.updateTask({ taskId: second.id, attempt: 0 }, (row) => { row.state = 'cancelled'; });
  const observed: number[] = [];
  let pressure = IO_PRESSURE_LIMIT + 1;
  try {
    const io = fake({ pressure: () => pressure, sleep: async () => { observed.push(pressure); pressure = IO_PRESSURE_LIMIT; } });
    expect(await removeFinishedWorktree(h.settings, h.store, io)).toBe(task.id);
    expect(observed).toEqual([IO_PRESSURE_LIMIT + 1]);
    expect(existsSync(second.worktree)).toBe(true);
  } finally { h.dispose(); }
});

test('a retry recreates a removed task worktree from its task branch and installs dependencies before launch', async () => {
  const { h, task } = setup('stopped');
  writeFileSync(join(task.worktree, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  const install = Bun.spawnSync(['bun', 'install'], { cwd: task.worktree, stdout: 'pipe', stderr: 'pipe' });
  if (install.exitCode !== 0) throw new Error(new TextDecoder().decode(install.stderr));
  git(task.worktree, ['add', 'package.json']);
  git(task.worktree, ['commit', '-m', 'Add dependency manifest']);
  const original = git(task.worktree, ['rev-parse', 'HEAD']);
  git(h.root, ['worktree', 'remove', '--force', task.worktree]);
  try {
    await h.tasks.retry(task.id);
    expect(existsSync(task.worktree)).toBe(true);
    expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(original);
    expect(existsSync(join(task.worktree, 'node_modules'))).toBe(true);
  } finally { h.dispose(); }
});

test('a finished task with a missing directory prunes Git worktree metadata without an error or retry', async () => {
  const { h, task } = setup('merged');
  try {
    rmSync(task.worktree, { recursive: true, force: true });
    await expect(removeFinishedWorktree(h.settings, h.store, fake())).resolves.toBeNull();
    const listed = git(h.root, ['worktree', 'list', '--porcelain']);
    expect(listed).not.toContain(task.worktree);
  } finally { h.dispose(); }
});
