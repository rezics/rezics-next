import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MAIN_GUARD_REFUSAL = 'main only moves forward; a correction is a new commit.';
const MARKER = '# REZICS main history guard';
const PREVIOUS_SUFFIX = '.rezics-main-guard.previous';

// Keep the installed hook independent of Bun, a checkout and the goal tool. The prepared
// phase holds the reference locks; no commit scans, worktree checks or ledger reads belong here.
// Git's input and ancestry contracts: https://git-scm.com/docs/githooks#_reference_transaction
// and https://git-scm.com/docs/git-merge-base#Documentation/git-merge-base.txt---is-ancestor
function hookSource(previous: boolean): string {
  return `#!/bin/sh
${MARKER}
guard_main() {
  [ "$1" = prepared ] || return 0
  while read -r old_oid new_oid ref_name; do
    [ "$ref_name" = refs/heads/main ] || continue
    # An unconditional update can supply zeroes even when main already exists.
    case "$old_oid" in
      *[!0]*) ;;
      *) old_oid=$(git rev-parse --verify refs/heads/main 2>/dev/null) || continue ;;
    esac
    [ "$old_oid" = "$new_oid" ] && continue
    if ! GIT_NO_REPLACE_OBJECTS=1 git merge-base --is-ancestor "$old_oid" "$new_oid" 2>/dev/null; then
      printf '%s\\n' '${MAIN_GUARD_REFUSAL}' >&2
      return 1
    fi
  done
}
${previous ? `# Replay exactly the same transaction input to both hooks, including trailing newlines.
updates=$(cat; printf '.')
updates=\${updates%.}
printf '%s' "$updates" | guard_main "$@" || exit $?
if [ -x "$0${PREVIOUS_SUFFIX}" ]; then
  printf '%s' "$updates" | "$0${PREVIOUS_SUFFIX}" "$@"
  exit $?
fi
exit 0
` : 'guard_main "$@"\n'}`;
}

function gitPath(cwd: string, args: string[]): string {
  const run = spawnSync('git', ['rev-parse', '--path-format=absolute', ...args], { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr.trim() || 'Cannot locate the common Git directory');
  return run.stdout.trim();
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface MainGuardStatus {
  state: 'absent' | 'installed' | 'modified' | 'inactive';
  hook: string;
  previousHook?: string;
  reason?: string;
}

export function mainGuardStatus(cwd = process.cwd()): MainGuardStatus {
  const hooks = join(gitPath(cwd, ['--git-common-dir']), 'hooks');
  const hook = join(hooks, 'reference-transaction');
  const previousHook = `${hook}${PREVIOUS_SUFFIX}`;
  const prior = exists(previousHook) ? { previousHook } : {};
  if (gitPath(cwd, ['--git-path', 'hooks']) !== hooks) {
    return { state: 'inactive', hook, ...prior, reason: 'core.hooksPath does not use the common Git hooks directory' };
  }
  if (!exists(hook)) return { state: 'absent', hook, ...prior };
  const file = lstatSync(hook);
  // An unowned hook is an absent guard, even when the hook is not a text file.
  if (!file.isFile()) return { state: 'absent', hook, ...prior };
  const content = readFileSync(hook, 'utf8');
  if (!content.includes(MARKER)) return { state: 'absent', hook, ...prior };
  if (content !== hookSource(!!prior.previousHook)) {
    return { state: 'modified', hook, ...prior, reason: 'the installed main guard was modified; leave it in place' };
  }
  if (!(file.mode & 0o111)) return { state: 'inactive', hook, ...prior, reason: 'the installed main guard is not executable' };
  return { state: 'installed', hook, ...prior };
}

/** Preserve another hook under a disclosed sibling name, and restore that exact file on removal. */
export function installMainGuard(cwd = process.cwd()): MainGuardStatus {
  const status = mainGuardStatus(cwd);
  if (status.state === 'modified' || (status.state === 'inactive' && status.reason?.includes('core.hooksPath'))) {
    throw new Error(status.reason);
  }
  if (status.state === 'installed') return status;
  if (status.state === 'inactive') {
    chmodSync(status.hook, 0o755);
    return mainGuardStatus(cwd);
  }
  const previousHook = `${status.hook}${PREVIOUS_SUFFIX}`;
  if (exists(previousHook)) throw new Error(`Cannot install main guard: ${previousHook} already exists`);
  mkdirSync(dirname(status.hook), { recursive: true });
  const previous = exists(status.hook);
  const temporary = join(dirname(status.hook), `.reference-transaction-${randomUUID()}`);
  writeFileSync(temporary, hookSource(previous), { mode: 0o755, flag: 'wx' });
  try {
    if (previous) renameSync(status.hook, previousHook);
    try { renameSync(temporary, status.hook); } catch (error) {
      if (previous) renameSync(previousHook, status.hook);
      throw error;
    }
  } finally { rmSync(temporary, { force: true }); }
  return mainGuardStatus(cwd);
}

export function removeMainGuard(cwd = process.cwd()): MainGuardStatus {
  const status = mainGuardStatus(cwd);
  if (status.state === 'modified' || (status.state === 'inactive' && status.reason?.includes('core.hooksPath'))) {
    throw new Error(status.reason);
  }
  if (status.state === 'absent') return status;
  if (status.previousHook) renameSync(status.previousHook, status.hook);
  else rmSync(status.hook);
  return mainGuardStatus(cwd);
}
