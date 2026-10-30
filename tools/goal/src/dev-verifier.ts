import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Settings, Task } from './types.ts';
import { siblingTestCommand } from './affected-tests.ts';
import { runBoundedInstallProcess } from './install-process.ts';
import type { WorkerStore } from './store.ts';
import type { SqliteManagerInbox } from './inbox.ts';
import { matchesPath } from './briefs.ts';
import { gateRunner, git, type GateRunner } from './merge.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { recordFlow } from './flow.ts';
import type { Database } from 'bun:sqlite';
import { CHECK_HOST_TRANSPORT } from './records.ts';

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
function siblingTestFilesAtCommit(changedPaths: readonly string[], cwd: string, commit: string): string[] {
  const tracked = new Set(git(cwd, 'ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean));
  const tests = new Set<string>();
  for (const source of changedPaths) {
    if (
      source.startsWith('services/kernel/') ||
      !/\.(?:[cm]?[jt]sx?)$/i.test(source) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(source)
    )
      continue;
    const extension = parse(source).ext;
    const sameDirectory = join(dirname(source), `${parse(source).name}.test.ts`);
    const workspaceTest = join('tests', `${basename(source, extension)}.test.ts`);
    if (tracked.has(sameDirectory)) tests.add(sameDirectory);
    else if (tracked.has(workspaceTest)) tests.add(workspaceTest);
  }
  return [...tests].sort();
}
function commits(cwd: string, base: string, target: string): string[] {
  return git(cwd, 'rev-list', '--reverse', `${base}..${target}`).split('\n').filter(Boolean);
}
function matches(file: string, paths: readonly string[]): boolean {
  return paths.some((path) => matchesPath(file, [path]));
}
function taskCommits(task: Task, cwd: string): string[] {
  if (task.integratedCommits?.length) return task.integratedCommits;
  const commit = task.integratedCommit ?? task.mergedCommit;
  if (!commit) return [];
  return git(cwd, 'rev-list', '--reverse', `${task.integratedBase ?? task.base}..${commit}`)
    .split('\n')
    .filter(Boolean);
}
function filesInCommits(cwd: string, commitList: readonly string[]): string[] {
  const files = new Set<string>();
  for (const commit of commitList)
    for (const file of git(cwd, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit)
      .split('\n')
      .filter(Boolean))
      files.add(file);
  return [...files];
}
function taskLandings(settings: Settings, store: Pick<WorkerStore, 'tasks'>, base: string, target: string): Task[] {
  const landed = new Set(commits(settings.mainCheckout, base, target));
  return store
    .tasks()
    .filter(
      (task) =>
        ['integrated', 'merged'].includes(task.state) &&
        (task.integratedCommit ?? task.mergedCommit) &&
        [...(task.integratedCommits ?? []), task.integratedCommit ?? task.mergedCommit!].some((commit) =>
          landed.has(commit),
        ) &&
        task.brief.kind !== undefined &&
        !skippedKinds.has(task.brief.kind),
    );
}
function recordVerified(
  settings: Settings,
  store: Pick<WorkerStore, 'tasks'> & { db?: Database },
  base: string,
  target: string,
): void {
  if (!store.db) return;
  const at = new Date().toISOString();
  for (const task of taskLandings(settings, store, base, target))
    recordFlow(store.db, {
      taskId: task.id,
      attempt: task.currentAttempt,
      stage: 'verification',
      action: 'verified',
      at,
    });
}
function createChecks(
  settings: Settings,
  store: Pick<WorkerStore, 'tasks'>,
  base: string,
  target: string,
  candidate = target,
): Check[] {
  const checkout = settings.mainCheckout;
  const files = changedFiles(checkout, base, target);
  if (!files.length) return [];
  const typecheck = ['bun', 'scripts/typecheck.ts'];
  const checks: Check[] = [
    { command: ['env', `TYPECHECK_CHANGED=${files.join('\n')}`, ...typecheck], closure: ['**'] },
  ];
  for (const affected of settings.verifierChecks ?? settings.affectedTests ?? []) {
    const selected = files.some((file) => matches(file, affected.paths));
    if (selected) checks.push({ command: [...affected.command], closure: [...affected.paths] });
  }
  if (settings.siblingTests) {
    const nonSpecFiles = files.filter((file) => !file.startsWith('spec/') && !file.startsWith('specs/'));
    const siblingFiles = siblingTestFilesAtCommit(nonSpecFiles, checkout, candidate);
    const siblingCommand = siblingTestCommand(siblingFiles, settings.siblingTests.command);
    if (siblingCommand) checks.push({ command: siblingCommand, closure: siblingFiles });
  }
  for (const task of taskLandings(settings, store, base, target))
    checks.push({ command: [...task.brief.acceptance.command], closure: [...task.brief.paths], taskId: task.id });
  return checks;
}
function infraFailure(output: string, timedOut: boolean): boolean {
  return (
    timedOut ||
    CHECK_HOST_TRANSPORT.test(output) ||
    /ETIMEDOUT|timed out|timeout while (?:starting|creating|setting up).*docker|(?:ssh|rsync).*?(?:exit(?:ed)? 255|code 255|status 255)/i.test(
      output,
    )
  );
}
function installDependencies(tree: string, stateDirectory: string): boolean {
  if (!existsSync(join(tree, 'package.json')) || !existsSync(join(tree, 'bun.lock'))) return true;
  const installLog = join(stateDirectory, `dev-verify-install-${randomUUID()}.log`);
  for (let attempt = 0; attempt < 3; attempt++) {
    appendFileSync(installLog, `$ bun install --frozen-lockfile (attempt ${attempt + 1})\n`);
    try {
      const result = runBoundedInstallProcess({
        command: 'bun',
        args: ['install', '--frozen-lockfile'],
        cwd: tree,
        step: 'bun install --frozen-lockfile',
        purpose: 'preparation',
      });
      appendFileSync(installLog, `${result.stdout}${result.stderr}`);
      return true;
    } catch (error) {
      appendFileSync(installLog, `${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return false;
}

export type DevVerifierOptions = {
  settings: Settings;
  store: Pick<WorkerStore, 'tasks' | 'task' | 'updateTask'> & { db?: Database };
  inbox: Pick<SqliteManagerInbox, 'deliver'>;
  runGate?: GateRunner;
};

/**
 * Checks the verifier runs at once. It verifies after integration at ordinary priority, so it takes a share of the
 * check hosts, never all of them: on 2026-10-30 one run started 48 checks together and workers waited an hour.
 */
export const VERIFY_CONCURRENCY = 3;
async function mapBounded<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Verify a fixed dev head; the ref moves only after a compare-and-swap against that exact head. */
export async function verifyDev(options: DevVerifierOptions): Promise<void> {
  const { settings, store } = options,
    checkout = settings.mainCheckout;
  const lock = acquireDirectoryLease(join(settings.stateDirectory, 'dev-verifier.lease'));
  try {
    const dev = head(checkout, settings.integrationBranch);
    let verified: string;
    try {
      verified = head(checkout, verifiedBranch);
    } catch {
      // The train already checked every landing before this verifier was introduced.
      try {
        git(checkout, 'update-ref', ref(verifiedBranch), dev, '');
      } catch {
        /* another verifier initialized it */
      }
      return;
    }
    if (
      verified === dev ||
      spawnSync('git', ['merge-base', '--is-ancestor', verified, dev], { cwd: checkout }).status !== 0
    )
      return;
    const checks = createChecks(settings, store, verified, dev);
    const run = options.runGate ?? gateRunner(2 * 60 * 60_000);
    const tree = join(settings.worktreeRoot, `dev-verify-${randomUUID()}`);
    mkdirSync(settings.worktreeRoot, { recursive: true });
    mkdirSync(settings.stateDirectory, { recursive: true });
    git(checkout, 'worktree', 'add', '--detach', tree, dev);
    try {
      if (!installDependencies(tree, settings.stateDirectory)) return;
      const runCheck = async (check: Check, commit: string, label: string) => {
        const log = join(settings.stateDirectory, `dev-verify-${label}-${randomUUID()}.log`);
        const result = await run(check.command, tree, log);
        return { ...result, log, commit, check };
      };
      let results = await mapBounded(checks, VERIFY_CONCURRENCY, (check, i) => runCheck(check, dev, `head-${i}`));
      let failed = results.find((item) => !item.passed);
      if (!failed) {
        try {
          git(checkout, 'update-ref', ref(verifiedBranch), dev, verified);
          recordVerified(settings, store, verified, dev);
        } catch {
          /* dev-verified moved concurrently */
        }
        return;
      }
      for (let retry = 0; retry < 2 && failed && infraFailure(failed.output, failed.timedOut); retry++) {
        failed = await runCheck(failed.check, dev, `infra-retry-${retry + 1}`);
      }
      if (!failed) return;
      if (failed.passed) {
        try {
          git(checkout, 'update-ref', ref(verifiedBranch), dev, verified);
          recordVerified(settings, store, verified, dev);
        } catch {
          /* dev-verified moved concurrently */
        }
        return;
      }
      if (infraFailure(failed.output, failed.timedOut)) return;
      const tasks = taskLandings(settings, store, verified, dev);
      const landingCommits = tasks
        .map((task) => ({ task, commits: taskCommits(task, checkout) }))
        .filter((item) => item.commits.length)
        .sort((a, b) => {
          const order = commits(checkout, verified, dev);
          return (
            order.indexOf(a.task.integratedCommit ?? a.task.mergedCommit!) -
            order.indexOf(b.task.integratedCommit ?? b.task.mergedCommit!)
          );
        });
      const suspect = failed.check.taskId
        ? landingCommits.filter(({ task }) => task.id === failed!.check.taskId)
        : failed.check.closure.includes('**')
          ? landingCommits
          : landingCommits.filter(({ commits: taskCommitList }) =>
              filesInCommits(checkout, taskCommitList).some((file) => matches(file, failed!.check.closure)),
            );
      if (!suspect.length) return;
      // Prefix bisection is restricted to landings whose declared workspace can affect the failed command.
      const boundaries = suspect.map(({ task }) => ({ task, commit: task.integratedCommit ?? task.mergedCommit! }));
      let low = 0,
        high = boundaries.length - 1;
      const cache = new Map<number, boolean>();
      const probe = async (index: number): Promise<boolean | null> => {
        if (cache.has(index)) return cache.get(index)!;
        const prefix = boundaries[index]!.commit;
        const probeTree = join(settings.worktreeRoot, `dev-verify-probe-${randomUUID()}`);
        git(checkout, 'worktree', 'add', '--detach', probeTree, prefix);
        try {
          if (!installDependencies(probeTree, settings.stateDirectory))
            throw new Error('Could not install verifier dependencies for a culprit probe');
          const log = join(settings.stateDirectory, `dev-verify-probe-${randomUUID()}.log`);
          let outcome = await run(failed!.check.command, probeTree, log);
          for (let retry = 0; retry < 2 && !outcome.passed && infraFailure(outcome.output, outcome.timedOut); retry++)
            outcome = await run(failed!.check.command, probeTree, log);
          if (!outcome.passed && infraFailure(outcome.output, outcome.timedOut)) return null;
          cache.set(index, outcome.passed);
          return outcome.passed;
        } finally {
          git(checkout, 'worktree', 'remove', '--force', probeTree);
        }
      };
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const passed = await probe(mid);
        if (passed === null) return;
        if (passed) low = mid + 1;
        else high = mid;
      }
      const culprit = boundaries[high]!.task;
      const culpritLog = readFileSync(failed.log, 'utf8');
      const culpritChanges = taskCommits(culprit, checkout);
      const revert = spawnSync('git', ['revert', '--no-commit', ...[...culpritChanges].reverse()], {
        cwd: tree,
        encoding: 'utf8',
      });
      if (revert.status !== 0) throw new Error(`Could not revert verifier culprit ${culprit.id}: ${revert.stderr}`);
      const message = `revert: ${culprit.id} after ${failed.check.command.join(' ')}`;
      const committed = spawnSync('git', ['commit', '-m', message], { cwd: tree, encoding: 'utf8' });
      if (committed.status !== 0)
        throw new Error(`Could not commit verifier revert for ${culprit.id}: ${committed.stderr}`);
      const revertHead = git(tree, 'rev-parse', 'HEAD');
      git(checkout, 'update-ref', ref(settings.integrationBranch), revertHead, dev);
      const current = store.task(culprit.id);
      store.updateTask({ taskId: culprit.id, attempt: current.currentAttempt }, (task) => {
        task.state = 'stopped';
        delete task.integratedCommit;
        delete task.integratedCommits;
        delete task.integratedBase;
      });
      options.inbox.deliver({
        managerId: culprit.brief.manager,
        taskId: culprit.id,
        kind: 'instruction',
        evidencePath: failed.log,
        summary: `Landing ${culprit.id} was reverted from dev after ${failed.check.command.join(' ')} failed. Log: ${failed.log}\n${culpritLog.slice(-6000)}`,
      });
      const postRevert = head(checkout, settings.integrationBranch);
      try {
        git(checkout, 'update-ref', ref(verifiedBranch), postRevert, verified);
      } catch {
        /* retry from new base next sweep */
      }
    } finally {
      git(checkout, 'worktree', 'remove', '--force', tree);
    }
  } catch (error) {
    if (error instanceof LeaseHeldError) return;
    throw error;
  } finally {
    lock.release();
  }
}

export function devVerificationState(
  cwd: string,
  stateDirectory?: string,
  integrationBranch = 'dev',
  tasks?: readonly Task[],
): { head: string | null; behind: number | null; state: string } {
  try {
    const verified = head(cwd, verifiedBranch),
      dev = head(cwd, integrationBranch);
    const landed = new Set(commits(cwd, verified, dev));
    const behind = tasks
      ? tasks.filter(
          (task) =>
            (task.integratedCommit ?? task.mergedCommit) && landed.has(task.integratedCommit ?? task.mergedCommit!),
        ).length
      : landed.size;
    const running = stateDirectory !== undefined && existsSync(join(stateDirectory, 'dev-verifier.lease'));
    return { head: verified, behind, state: running ? 'running' : behind ? 'pending' : 'current' };
  } catch {
    return { head: null, behind: null, state: 'uninitialized' };
  }
}
