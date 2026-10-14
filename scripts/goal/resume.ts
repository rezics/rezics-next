import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, stateDir } from './ledger.ts';
import type { Attempt, Task } from './types.ts';
import { updateWorktree } from './tree-currency.ts';

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
 * base snapshot makes the count and update describe the same revision even if the branch moves again. */
export function updateResumeWorktree(task: Task, liveSharers: readonly Task[]): string {
  return updateWorktree(task.worktree, task.id, liveSharers.map(sharer => sharer.id)).line;
}
