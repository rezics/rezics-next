import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Settings, Task } from './types.ts';
import type { WorkerStore } from './store.ts';
import type { SqliteManagerInbox } from './inbox.ts';
import { matchesPath } from './briefs.ts';
import { gateRunner, git, type GateRunner } from './merge.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';

const ref = (branch: string) => `refs/heads/${branch}`;
const verifiedBranch = 'dev-verified';
const skippedKinds = new Set(['specification', 'research']);
type Check = { command: string[]; closure: string[]; taskId?: string };

function head(cwd: string, branch: string): string {
  return git(cwd, 'rev-parse', '--verify', ref(branch));
}
function changedFiles(cwd: string, base: string, target: string): string[] {
  return git(cwd, 'diff', '--name-only', '-z', `${base}..${target}`).split('\0').filter(Boolean);
}
function commits(cwd: string, base: string, target: string): string[] {
  return git(cwd, 'rev-list', '--reverse', `${base}..${target}`).split('\n').filter(Boolean);
}
function matches(file: string, paths: readonly string[]): boolean {
  return paths.some((path) => matchesPath(file, [path]));
}
function taskCommits(task: Task, cwd: string): string[] {
  if (task.integratedCommits?.length) return task.integratedCommits;
  if (!task.integratedCommit) return [];
  return git(cwd, 'rev-list', '--reverse', `${task.integratedBase ?? task.base}..${task.integratedCommit}`)
    .split('\n').filter(Boolean);
}
function filesInCommits(cwd: string, commitList: readonly string[]): string[] {
  const files = new Set<string>();
  for (const commit of commitList)
    for (const file of git(cwd, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit).split('\n').filter(Boolean))
      files.add(file);
  return [...files];
}
function taskLandings(settings: Settings, store: WorkerStore, base: string, target: string): Task[] {
  const landed = new Set(commits(settings.mainCheckout, base, target));
  return store.tasks().filter((task) => task.state === 'integrated' && task.integratedCommit &&
    landed.has(task.integratedCommit) && task.brief.kind !== undefined && !skippedKinds.has(task.brief.kind));
}
function createChecks(settings: Settings, store: WorkerStore, base: string, target: string): Check[] {
  const checkout = settings.mainCheckout;
  const files = changedFiles(checkout, base, target);
  if (!files.length) return [];
  const typecheck = ['bun', 'scripts/typecheck.ts'];
  const checks: Check[] = [{ command: ['env', `TYPECHECK_CHANGED=${files.join('\n')}`, ...typecheck], closure: ['**'] }];
  for (const affected of settings.affectedTests ?? []) {
    const selected = files.some((file) => matches(file, affected.paths));
    if (selected) checks.push({ command: [...affected.command], closure: [...affected.paths] });
  }
  for (const task of taskLandings(settings, store, base, target))
    checks.push({ command: [...task.brief.acceptance.command], closure: [...task.brief.paths], taskId: task.id });
  return checks;
}
function infraFailure(output: string, timedOut: boolean): boolean {
  return timedOut || /ETIMEDOUT|timed out|timeout while (?:starting|creating|setting up).*docker|(?:ssh|rsync).*?(?:exit(?:ed)? 255|code 255|status 255)/i.test(output);
}

export type DevVerifierOptions = {
  settings: Settings;
  store: Pick<WorkerStore, 'tasks' | 'task' | 'updateTask'>;
  inbox: Pick<SqliteManagerInbox, 'deliver'>;
  runGate?: GateRunner;
};

/** Verify a fixed dev head; the ref moves only after a compare-and-swap against that exact head. */
export async function verifyDev(options: DevVerifierOptions): Promise<void> {
  const { settings, store } = options, checkout = settings.mainCheckout;
  const lock = acquireDirectoryLease(join(settings.stateDirectory, 'dev-verifier.lease'));
  try {
    const dev = head(checkout, settings.integrationBranch);
    let verified: string;
    try { verified = head(checkout, verifiedBranch); }
    catch {
      // The train already checked every landing before this verifier was introduced.
      try { git(checkout, 'update-ref', ref(verifiedBranch), dev, ''); } catch { /* another verifier initialized it */ }
      return;
    }
    if (verified === dev || spawnSync('git', ['merge-base', '--is-ancestor', verified, dev], { cwd: checkout }).status !== 0) return;
    const checks = createChecks(settings, store, verified, dev);
    const run = options.runGate ?? gateRunner(2 * 60 * 60_000);
    const tree = join(settings.worktreeRoot, `dev-verify-${randomUUID()}`);
    mkdirSync(settings.worktreeRoot, { recursive: true }); mkdirSync(settings.stateDirectory, { recursive: true });
    git(checkout, 'worktree', 'add', '--detach', tree, dev);
    try {
      const runCheck = async (check: Check, commit: string, label: string) => {
        const log = join(settings.stateDirectory, `dev-verify-${label}-${randomUUID()}.log`);
        const result = await run(check.command, tree, log);
        return { ...result, log, commit, check };
      };
      let results = await Promise.all(checks.map((check, i) => runCheck(check, dev, `head-${i}`)));
      let failed = results.find((item) => !item.passed);
      if (!failed) {
        try { git(checkout, 'update-ref', ref(verifiedBranch), dev, verified); } catch { /* dev-verified moved concurrently */ }
        return;
      }
      for (let retry = 0; retry < 2 && failed && infraFailure(failed.output, failed.timedOut); retry++) {
        failed = await runCheck(failed.check, dev, `infra-retry-${retry + 1}`);
      }
      if (!failed) return;
      if (failed.passed) {
        try { git(checkout, 'update-ref', ref(verifiedBranch), dev, verified); } catch { /* dev-verified moved concurrently */ }
        return;
      }
      if (infraFailure(failed.output, failed.timedOut)) return;
      const tasks = taskLandings(settings, store, verified, dev);
      const landingCommits = tasks.map((task) => ({ task, commits: taskCommits(task, checkout) }))
        .filter((item) => item.commits.length);
      const suspect = failed.check.taskId
        ? landingCommits.filter(({ task }) => task.id === failed!.check.taskId)
        : failed.check.closure.includes('**')
          ? landingCommits
          : landingCommits.filter(({ commits: taskCommitList }) =>
              filesInCommits(checkout, taskCommitList).some((file) => matches(file, failed!.check.closure)),
            );
      if (!suspect.length) return;
      // Prefix bisection is restricted to landings whose declared workspace can affect the failed command.
      const boundaries = suspect.map(({ task, commits: taskHeads }) => ({ task, commit: taskHeads.at(-1)! }));
      let low = 0, high = boundaries.length - 1;
      const cache = new Map<number, boolean>();
      const probe = async (index: number) => {
        if (cache.has(index)) return cache.get(index)!;
        const prefix = boundaries[index]!.commit;
        const probeTree = join(settings.worktreeRoot, `dev-verify-probe-${randomUUID()}`);
        git(checkout, 'worktree', 'add', '--detach', probeTree, prefix);
        try {
          const log = join(settings.stateDirectory, `dev-verify-probe-${randomUUID()}.log`);
          const outcome = await run(failed!.check.command, probeTree, log);
          cache.set(index, outcome.passed);
          return outcome.passed;
        } finally { git(checkout, 'worktree', 'remove', '--force', probeTree); }
      };
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (await probe(mid)) low = mid + 1; else high = mid;
      }
      const culprit = boundaries[high]!.task;
      const culpritLog = readFileSync(failed.log, 'utf8');
      const culpritChanges = taskCommits(culprit, checkout);
      const revert = spawnSync('git', ['revert', '--no-commit', ...[...culpritChanges].reverse()], { cwd: tree, encoding: 'utf8' });
      if (revert.status !== 0) throw new Error(`Could not revert verifier culprit ${culprit.id}: ${revert.stderr}`);
      const message = `revert: ${culprit.id} after ${failed.check.command.join(' ')}`;
      const committed = spawnSync('git', ['commit', '-m', message], { cwd: tree, encoding: 'utf8' });
      if (committed.status !== 0) throw new Error(`Could not commit verifier revert for ${culprit.id}: ${committed.stderr}`);
      const revertHead = git(tree, 'rev-parse', 'HEAD');
      git(checkout, 'update-ref', ref(settings.integrationBranch), revertHead, dev);
      const current = store.task(culprit.id);
      store.updateTask({ taskId: culprit.id, attempt: current.currentAttempt }, (task) => {
        task.state = 'stopped'; delete task.integratedCommit; delete task.integratedCommits; delete task.integratedBase;
      });
      options.inbox.deliver({ managerId: culprit.brief.manager, taskId: culprit.id, kind: 'instruction',
        evidencePath: failed.log,
        summary: `Landing ${culprit.id} was reverted from dev after ${failed.check.command.join(' ')} failed. Log: ${failed.log}\n${culpritLog.slice(-6000)}` });
      const postRevert = head(checkout, settings.integrationBranch);
      try { git(checkout, 'update-ref', ref(verifiedBranch), postRevert, verified); } catch { /* retry from new base next sweep */ }
    } finally { git(checkout, 'worktree', 'remove', '--force', tree); }
  } catch (error) {
    if (error instanceof LeaseHeldError) return;
    throw error;
  } finally { lock.release(); }
}

export function devVerificationState(cwd: string, stateDirectory?: string): { head: string | null; behind: number | null; state: string } {
  try {
    const verified = head(cwd, verifiedBranch), dev = head(cwd, 'dev');
    const behind = commits(cwd, verified, dev).length;
    const running = stateDirectory !== undefined && existsSync(join(stateDirectory, 'dev-verifier.lease'));
    return { head: verified, behind, state: running ? 'running' : behind ? 'pending' : 'current' };
  } catch { return { head: null, behind: null, state: 'uninitialized' }; }
}
