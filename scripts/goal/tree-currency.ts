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

/** Follow a local wave only while HEAD shares wave work that has not reached main. */
export function worktreeBase(cwd: string): string {
  const main = git(cwd, ['rev-parse', 'main']);
  const waves = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/wave/']).split('\n').filter(Boolean);
  const carrying: { wave: string; base: string }[] = [];
  for (const wave of waves) {
    const base = spawnSync('git', ['merge-base', 'HEAD', wave], { cwd, encoding: 'utf8' });
    if (base.status === 1) continue; // An unrelated local wave carries none of this branch's work.
    if (base.status !== 0) throw new Error(base.stderr);
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', base.stdout.trim(), main], { cwd, encoding: 'utf8' });
    if (ancestor.status === 1) carrying.push({ wave, base: base.stdout.trim() });
    else if (ancestor.status !== 0) throw new Error(ancestor.stderr);
  }
  // A later wave contains an earlier one, so both share wave work with this tree: follow the wave whose shared
  // history is newest, the one whose merge base descends from every other's.
  const isAncestor = (older: string, newer: string) =>
    spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd }).status === 0;
  const newest = carrying.find(candidate => carrying.every(other => isAncestor(other.base, candidate.base)));
  return (newest ?? carrying[0])?.wave ?? 'main';
}

/** Pin the same source revision for changed-file selection and inherited check failures. */
export function checkBaseRevision(cwd: string): string {
  return git(cwd, ['merge-base', 'HEAD', worktreeBase(cwd)]);
}

/** Ancestry, rather than a patch comparison, detects whether this tree has its base's last harness fix. */
export function warnHarnessCurrency(cwd: string, print: (line: string) => void = console.log): number {
  if (!workerBranch(cwd)) return 0;
  const base = worktreeBase(cwd);
  const head = git(cwd, ['rev-parse', base]);
  const last = git(cwd, ['log', '-1', '--format=%H', head, '--', ...HARNESS_PATHS]);
  if (!last) return 0;
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', last, 'HEAD'], { cwd, encoding: 'utf8' });
  if (ancestor.status === 0) return 0;
  if (ancestor.status !== 1) throw new Error(ancestor.stderr);
  const count = Number(git(cwd, ['rev-list', '--count', `HEAD..${head}`, '--', ...HARNESS_PATHS]));
  print(`Harness: ${count} commits behind ${base}; a harness failure on this tree may already be fixed. Commit your changes, run task goal -- check or rebase onto ${base}, and run again.`);
  return count;
}

export interface WorktreeUpdate { before: string; after: string; failed: boolean; line: string }

/** Resume and check use the same base snapshot, with no autostash and no updates to other refs. */
export function updateWorktree(cwd: string, id: string, liveSharers: readonly string[] = []): WorktreeUpdate {
  const before = git(cwd, ['rev-parse', 'HEAD']);
  const base = worktreeBase(cwd);
  const head = git(cwd, ['rev-parse', base]);
  const behind = Number(git(cwd, ['rev-list', '--count', `${before}..${head}`]));
  let action: string;
  let failed = false;
  if (liveSharers.length) {
    action = `left alone: live task ${[...liveSharers].sort().join(', ')} shares the worktree`;
  } else if (git(cwd, ['status', '--porcelain', '--untracked-files=all'])) {
    action = 'left alone: uncommitted changes';
  } else if (!behind) {
    action = 'already current';
  } else if (git(cwd, ['rev-list', '--count', `${head}..${before}`]) === '0') {
    git(cwd, ['merge', '--ff-only', head]);
    action = 'fast-forwarded';
  } else {
    const rebased = spawnSync('git', ['rebase', '--no-autostash', '--no-update-refs', head], {
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
  return { before, after, failed, line: `${id} worktree: ${before} -> ${after}; ${behind} commits behind ${base}; ${action}` };
}

export function prepareCheckTree(cwd: string, print: (line: string) => void = console.log): WorktreeUpdate | undefined {
  const branch = workerBranch(cwd);
  if (!branch) return;
  if (git(cwd, ['status', '--porcelain', '--untracked-files=all'])) {
    warnHarnessCurrency(cwd, print);
    return;
  }
  const id = branch.replace(/^goal\//, '').replace(/^g-(\d+)$/i, 'G-$1');
  const result = updateWorktree(cwd, id);
  print(result.line);
  return result;
}
