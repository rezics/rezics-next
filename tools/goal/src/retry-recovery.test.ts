import { expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { git } from './tasks.ts';
import { harness } from './test-support.ts';

test('a retry recovers a worktree that a setup killed mid-rebase left detached, locked and unabortable', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const first = await h.tasks.retry(task.id);
    await first.exited;
    const gitPath = (name: string) => resolve(task.worktree, git(task.worktree, ['rev-parse', '--git-path', name]));
    // What an interrupted `git rebase` start leaves: HEAD detached at the commit it rebased onto, a rebase state
    // without head-name that `git rebase --abort` cannot read, and the index lock of the killed process.
    git(task.worktree, ['checkout', '-q', '--detach', task.base]);
    mkdirSync(gitPath('rebase-merge'), { recursive: true });
    const lock = gitPath('index.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);

    const second = await h.tasks.retry(task.id);
    await second.exited;

    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(git(task.worktree, ['branch', '--show-current'])).toBe(task.branch);
  } finally {
    h.dispose();
  }
});
