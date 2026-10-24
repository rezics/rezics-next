import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt, Task } from './types.ts';
import type { FirstFailure } from './contracts.ts';
import { git } from './tasks.ts';

/** No session text enters the evidence directory. All consultation input is assembled here. */
export function evidenceBundle(task: Task, attempt: Attempt, failure: FirstFailure | null = attempt.failure): string {
  const directory = attempt.evidencePath;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'contract.md'), task.brief.markdown);
  // Include uncommitted edits and staged changes as well as branch commits.
  let diff = git(task.worktree, ['diff', '--no-ext-diff', '--binary', task.base, '--']);
  const untracked = git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const path of untracked) {
    const patch = spawnSync('git', ['diff', '--no-ext-diff', '--binary', '--no-index', '--', '/dev/null', path], { cwd: task.worktree, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (patch.status !== 0 && patch.status !== 1) throw new Error('could not capture untracked diff');
    diff += `\n${patch.stdout}`;
  }
  writeFileSync(join(directory, 'diff.patch'), diff);
  writeFileSync(join(directory, 'failure.json'), JSON.stringify(failure, null, 2));
  writeFileSync(join(directory, 'approaches.json'), JSON.stringify(attempt.approaches, null, 2));
  return directory;
}
