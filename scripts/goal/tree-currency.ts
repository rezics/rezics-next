import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

/** Only a branch in a linked worktree is mutable here. Detached regression trees stay pinned. */
function workerBranch(cwd: string): string | undefined {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (top.status !== 0 || resolve(top.stdout.trim()) !== resolve(cwd)) return;
  const directories = git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).split('\n');
  if (directories[0] === directories[1]) return;
  const branch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, encoding: 'utf8' });
  if (branch.status === 1) return;
  if (branch.status !== 0) throw new Error(branch.stderr);
  return branch.stdout.trim();
}

const HARNESS_PATHS = ['scripts/goal/', 'scripts/qa/', 'tests/qa/support/'];

/** Ancestry, rather than a patch comparison, detects whether this tree has main's last harness fix. */
export function warnHarnessCurrency(cwd: string, print: (line: string) => void = console.log): number {
  if (!workerBranch(cwd)) return 0;
  const main = git(cwd, ['rev-parse', 'main']);
  const last = git(cwd, ['log', '-1', '--format=%H', main, '--', ...HARNESS_PATHS]);
  if (!last) return 0;
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', last, 'HEAD'], { cwd, encoding: 'utf8' });
  if (ancestor.status === 0) return 0;
  if (ancestor.status !== 1) throw new Error(ancestor.stderr);
  const count = Number(git(cwd, ['rev-list', '--count', `HEAD..${main}`, '--', ...HARNESS_PATHS]));
  print(`Harness: ${count} commits behind main; a harness failure on this tree may already be fixed. Commit your changes, run task goal -- check or rebase onto main, and run again.`);
  return count;
}

export interface WorktreeUpdate { before: string; after: string; failed: boolean; line: string }

/** Resume and check use the same snapshot of main, with no autostash and no updates to other refs. */
export function updateWorktree(cwd: string, id: string, liveSharers: readonly string[] = []): WorktreeUpdate {
  const before = git(cwd, ['rev-parse', 'HEAD']);
  const main = git(cwd, ['rev-parse', 'main']);
  const behind = Number(git(cwd, ['rev-list', '--count', `${before}..${main}`]));
  let action: string;
  let failed = false;
  if (liveSharers.length) {
    action = `left alone: live task ${[...liveSharers].sort().join(', ')} shares the worktree`;
  } else if (git(cwd, ['status', '--porcelain', '--untracked-files=all'])) {
    action = 'left alone: uncommitted changes';
  } else if (!behind) {
    action = 'already current';
  } else if (git(cwd, ['rev-list', '--count', `${main}..${before}`]) === '0') {
    git(cwd, ['merge', '--ff-only', main]);
    action = 'fast-forwarded';
  } else {
    const rebased = spawnSync('git', ['rebase', '--no-autostash', '--no-update-refs', main], {
      cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    });
    if (rebased.status === 0) {
      action = 'rebased';
    } else {
      const conflicts = git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
      git(cwd, ['rebase', '--abort']);
      failed = true;
      action = conflicts.length ? `rebase undone; conflicts: ${conflicts.map(file => /[\r\n]/.test(file) ? JSON.stringify(file) : file).join(', ')}`
        : `rebase undone; failed: ${(rebased.stderr || rebased.stdout).trim().replace(/\s+/g, ' ')}`;
    }
  }
  const after = git(cwd, ['rev-parse', 'HEAD']);
  return { before, after, failed, line: `${id} worktree: ${before} -> ${after}; ${behind} commits behind main; ${action}` };
}

export function prepareCheckTree(cwd: string, print: (line: string) => void = console.log): WorktreeUpdate | undefined {
  const branch = workerBranch(cwd);
  if (!branch) return;
  if (git(cwd, ['status', '--porcelain', '--untracked-files=all'])) {
    warnHarnessCurrency(cwd, print);
    return;
  }
  const result = updateWorktree(cwd, branch.replace(/^goal\//, ''));
  print(result.line);
  return result;
}
