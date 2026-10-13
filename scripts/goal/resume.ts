import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, stateDir } from './ledger.ts';
import type { Attempt, Task } from './types.ts';

/** A resume records its launch head separately from the worker's output. Older attempts conservatively
 * use the dispatch base, so existing work cannot be mistaken for an unchanged blocked attempt. */
export function blockedAttemptUnchanged(task: Task, attempt: Attempt): boolean {
  const checkpoint = `${attempt.output}.head`;
  const start = existsSync(checkpoint) ? readFileSync(checkpoint, 'utf8').trim() : task.base;
  return git(task.worktree, ['rev-parse', 'HEAD']) === start
    && git(task.worktree, ['status', '--porcelain', '--untracked-files=all']) === '';
}

export function recordResumeHead(task: Task): void {
  const directory = join(stateDir, 'runs', task.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `attempt-${task.attempts.length + 1}.json.head`), git(task.worktree, ['rev-parse', 'HEAD']));
}

/** Called under the ledger lock after launch admission, before staging or starting the worker. The
 * snapshot of main makes the count and update describe the same revision even if main moves again. */
export function updateResumeWorktree(task: Task, liveSharers: readonly Task[]): string {
  const before = git(task.worktree, ['rev-parse', 'HEAD']);
  const main = git(task.worktree, ['rev-parse', 'main']);
  const behind = Number(git(task.worktree, ['rev-list', '--count', `${before}..${main}`]));
  let action: string;
  if (liveSharers.length) {
    action = `left alone: live task ${liveSharers.map(sharer => sharer.id).sort().join(', ')} shares the worktree`;
  } else if (git(task.worktree, ['status', '--porcelain', '--untracked-files=all'])) {
    action = 'left alone: uncommitted changes';
  } else if (!behind) {
    action = 'already current';
  } else if (git(task.worktree, ['rev-list', '--count', `${main}..${before}`]) === '0') {
    git(task.worktree, ['merge', '--ff-only', main]);
    action = 'fast-forwarded';
  } else {
    // Never autostash a worker's edits or let user configuration rewrite another task's branch.
    const rebased = spawnSync('git', ['rebase', '--no-autostash', '--no-update-refs', main], {
      cwd: task.worktree, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    });
    if (rebased.status === 0) {
      action = 'rebased';
    } else {
      const conflicts = git(task.worktree, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
      // Abort must succeed: starting a worker inside an unfinished rebase would lose the original tree.
      git(task.worktree, ['rebase', '--abort']);
      action = conflicts.length ? `rebase undone; conflicts: ${conflicts.map(file => /[\r\n]/.test(file) ? JSON.stringify(file) : file).join(', ')}`
        : `rebase undone; failed: ${(rebased.stderr || rebased.stdout).trim().replace(/\s+/g, ' ')}`;
    }
  }
  const after = git(task.worktree, ['rev-parse', 'HEAD']);
  return `${task.id} worktree: ${before} -> ${after}; ${behind} commits behind main; ${action}`;
}
