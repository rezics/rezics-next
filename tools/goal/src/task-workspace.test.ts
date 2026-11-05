import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, WorkerTasks } from './tasks.ts';
import { harness } from './test-support.ts';

test('dispatch creates a missing integration branch from main, and retry keeps leftover work across a missing checkout', async () => {
  const h = harness();
  const tasks = new WorkerTasks(h.settings, h.store, undefined, async (store, _task, attempt) => {
    const saved = store.updateAttempt(attempt, (current) => {
      current.state = 'exited';
      current.exitCode = 0;
      current.endedAt = new Date().toISOString();
    });
    store.updateTask(attempt, (current) => {
      current.state = 'stopped';
    });
    return { attempt: saved, exited: Promise.resolve({ code: 0, signal: null }) };
  });
  try {
    expect(() => git(h.root, ['rev-parse', '--verify', 'refs/heads/dev'])).toThrow();
    const task = tasks.dispatch(h.briefFile);
    const main = git(h.root, ['rev-parse', 'refs/heads/main']);
    expect(git(h.root, ['rev-parse', 'refs/heads/dev'])).toBe(main);
    expect(task.base).toBe(main);

    await tasks.retry(task.id);
    const worktree = h.store.task(task.id).worktree;
    writeFileSync(join(worktree, 'leftover.txt'), 'kept leftover\n');
    await tasks.retry(task.id);
    expect(git(worktree, ['log', '--format=%s', '-1'])).toContain('wip: leftovers from attempt 1');
    expect(git(worktree, ['show', 'HEAD:leftover.txt'])).toBe('kept leftover');
    const retained = git(worktree, ['rev-parse', 'HEAD']);

    git(h.root, ['worktree', 'remove', '--force', worktree]);
    expect(existsSync(worktree)).toBe(false);
    await tasks.retry(task.id);
    expect(existsSync(worktree)).toBe(true);
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(retained);
    expect(git(worktree, ['branch', '--show-current'])).toBe(task.branch);
  } finally {
    h.dispose();
  }
});

test('commitFinishedWork commits leftover isolated source and skips verification, shared, conflicted and clean trees', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    expect(h.tasks.commitFinishedWork(task, 1)).toBe(false);

    writeFileSync(join(task.worktree, 'uncommitted.txt'), 'left by the worker\n');
    expect(h.tasks.commitFinishedWork(task, 2)).toBe(true);
    expect(git(task.worktree, ['log', '--format=%s', '-1'])).toBe('chore: commit work left uncommitted by attempt 2');
    expect(git(task.worktree, ['show', 'HEAD:uncommitted.txt'])).toBe('left by the worker');
    expect(h.tasks.commitFinishedWork(task, 2)).toBe(false);

    writeFileSync(join(task.worktree, 'again.txt'), 'dirty\n');
    expect(h.tasks.commitFinishedWork({ ...task, brief: { ...task.brief, kind: 'verification' } }, 3)).toBe(false);
    expect(h.tasks.commitFinishedWork({ ...task, workspace: { module: 'library', taskName: 'page' } }, 3)).toBe(false);
    rmSync(join(task.worktree, 'again.txt'));

    const other = join(h.root, '.temp/conflict');
    mkdirSync(join(h.root, '.temp'), { recursive: true });
    git(h.root, ['worktree', 'add', '-b', 'conflict', other, 'main']);
    writeFileSync(join(other, 'uncommitted.txt'), 'other side\n');
    git(other, ['add', 'uncommitted.txt']);
    git(other, ['commit', '-qm', 'Conflict']);
    expect(Bun.spawnSync(['git', 'merge', '--no-commit', 'conflict'], { cwd: task.worktree }).exitCode).not.toBe(0);
    expect(h.tasks.commitFinishedWork(task, 3)).toBe(false);
  } finally {
    h.dispose();
  }
});
