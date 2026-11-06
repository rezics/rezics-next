import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { DevVerifierEvidence, DevVerifierFinding, Settings, Task } from './types.ts';
import { defaultPolicy } from './policy.ts';
import type { WorkerStore } from './store.ts';
import type { SqliteManagerInbox } from './inbox.ts';
import { firstFailure, gateRunner, git, type GateRunner } from './merge.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import {
  checkInput,
  checkSignature,
  containsAssertion,
  dependencySetupKey,
  locateNewFailure,
  makeFinding,
  probeAt,
  proveExistingOrReintroduced,
  revisionSource,
  runCacheKey,
  selectionIdentity,
  suspectsFor,
  verifierExecution,
  reconcileComparison,
  type FindingGroup,
  type IndexedCheck,
  type Suspect,
} from './dev-verifier-comparison.ts';
import { recordFlow } from './flow.ts';
import type { Database } from 'bun:sqlite';
import { classifyRun, stableAssertions } from './dev-verifier-classification.ts';
import { executeCheck, installDependenciesCached } from './dev-verifier-execution.ts';
import { verifierFailureRevertsLanding } from './worker-check-budget.ts';
import {
  checkSourceFiles,
  placeInWorkspace,
  projectVerifierLandings,
  taskCommits,
  trackedFilesAt,
  type DevVerifierCheck,
  type VerifierLandings,
} from './dev-verifier-plan.ts';

export {
  placeInWorkspace,
  projectChecksSource,
  projectRevisionSource,
  projectSourceInterval,
  projectVerifierLandings,
  sourcePresentAt,
} from './dev-verifier-plan.ts';
export type { DevVerifierCheck, RevisionSource, SourceInterval, VerifierLandings } from './dev-verifier-plan.ts';
export { classifyRun };
export { withTreeBun } from './dev-verifier-execution.ts';
export { checkInput, VERIFY_CONCURRENCY } from './dev-verifier-comparison.ts';
type Check = DevVerifierCheck;

import {
  readFindingCounts,
  saveFinding,
  type DevVerifierStorage,
  type VerificationFindingCounts,
} from './dev-verifier-storage.ts';

const ref = (branch: string) => `refs/heads/${branch}`;
const verifiedBranch = 'dev-verified';
function head(cwd: string, branch: string): string {
  return git(cwd, 'rev-parse', '--verify', ref(branch));
}
function recordVerified(
  store: Pick<WorkerStore, 'tasks'> & { db?: Database },
  history: VerifierLandings,
  passedTaskIds: ReadonlySet<string>,
): void {
  if (!store.db) return;
  const at = new Date().toISOString();
  for (const task of history.tasks) {
    // A verification receipt means this task's own acceptance passed on the exact head. A baseline failure on that
    // command is never converted into a receipt for the task.
    if (!passedTaskIds.has(task.id)) continue;
    recordFlow(store.db, {
      taskId: task.id,
      attempt: task.currentAttempt,
      stage: 'verification',
      action: 'verified',
      at,
    });
  }
}
export type BootSmokeRepair = {
  test: string;
  commit: string;
  error: string;
  owner: Task;
  existingTaskId?: string;
};
export type TestFailureRepair = BootSmokeRepair;

export type DevVerifierOptions = {
  settings: Settings;
  store: Pick<WorkerStore, 'tasks' | 'task' | 'updateTask'> & DevVerifierStorage;
  inbox: Pick<SqliteManagerInbox, 'deliver'>;
  runGate?: GateRunner;
  /** Local boot-smoke runner; defaults to `runGate` so tests can spy on one path. */
  runBootSmoke?: GateRunner;
  dispatchRepair?: (repair: BootSmokeRepair) => void;
  dispatchTestRepair?: (repair: TestFailureRepair) => void;
  /** Runs the separately scheduled seeded page-data stack when the policy interval is due. */
  runPageData?: () => Promise<unknown>;
};

const OPEN_REPAIR_STATES = new Set(['ready', 'held', 'running', 'landing', 'stopped']);

function bootSmokeTestPath(check: Check): string {
  return checkSourceFiles(check)[0] ?? check.command.filter((argument) => !argument.startsWith('-')).at(-1) ?? '';
}

function bootSmokePathPattern(test: string): string {
  const [area, name] = test.split('/');
  return area && name && ['apps', 'services', 'packages'].includes(area) ? `${area}/${name}/**` : test;
}

function repairBriefFrontMatter(repair: BootSmokeRepair): string {
  const paths = repair.owner.brief.paths.length ? repair.owner.brief.paths : [bootSmokePathPattern(repair.test)];
  return `---\n${JSON.stringify(
    {
      goal: repair.owner.brief.goal,
      manager: repair.owner.brief.manager,
      kind: 'implementation',
      paths,
      riskAreas: repair.owner.brief.riskAreas ?? [],
      urgent: true,
      acceptance: { failing: true },
      criticalPath: false,
      waiting: [],
      after: [],
    },
    null,
    2,
  )}\n---\n`;
}

export function bootSmokeRepairBrief(repair: BootSmokeRepair, policy = defaultPolicy.verifier): string {
  const error = repair.error.slice(-policy.diagnosticCharacters);
  return `${repairBriefFrontMatter(repair)}\n# Repair the boot failure\n\nBoot-smoke repair for \`${repair.test}\`.\n\nCommit \`${repair.commit}\` broke the repository boot smoke.\n\n\`\`\`\n${error}\n\`\`\`\n`;
}

export function testFailureRepairBrief(repair: TestFailureRepair, policy = defaultPolicy.verifier): string {
  const error = repair.error.slice(-policy.diagnosticCharacters);
  return `${repairBriefFrontMatter(repair)}\n# Repair the failing test\n\nTest failure repair for \`${repair.test}\`.\n\nCommit \`${repair.commit}\` broke \`${repair.test}\` after landing.\n\n\`\`\`\n${error}\n\`\`\`\n`;
}

function openRepair(store: Pick<WorkerStore, 'tasks'>, marker: string): Task | undefined {
  return store
    .tasks()
    .find(
      (task) =>
        OPEN_REPAIR_STATES.has(task.state) && task.brief.urgent === true && task.brief.markdown.includes(marker),
    );
}

function openBootRepair(store: Pick<WorkerStore, 'tasks'>, test: string): Task | undefined {
  return openRepair(store, `Boot-smoke repair for \`${test}\``);
}

function openTestRepair(store: Pick<WorkerStore, 'tasks'>, test: string): Task | undefined {
  return openRepair(store, `Test failure repair for \`${test}\``);
}

function checkRepairPath(check: Check): string {
  return bootSmokeTestPath(check);
}

function dispatchTestFailure(
  options: DevVerifierOptions,
  check: IndexedCheck,
  evidence: DevVerifierEvidence,
  owner: Task,
  target: string,
): void {
  const test = checkRepairPath(check);
  const existing = openTestRepair(options.store, test);
  options.dispatchTestRepair?.({
    test,
    commit: owner.integratedCommit ?? owner.mergedCommit ?? target,
    error: evidence.output,
    owner,
    ...(existing ? { existingTaskId: existing.id } : {}),
  });
}

function bootSmokeChecks(settings: Settings, commit: string): IndexedCheck[] {
  const tests = settings.bootSmoke?.tests ?? [];
  const tracked = trackedFilesAt(settings.mainCheckout, commit);
  return tests
    .filter((test) => tracked.has(test))
    .map((test, index) => {
      const check = placeInWorkspace({ command: ['bun', 'test', test], closure: ['**'] }, tracked);
      return { ...check, index, signature: checkSignature(check, index) };
    });
}

/**
 * Checks the verifier runs at once. It verifies after integration at ordinary priority, so it takes a share of the
 * check hosts, never all of them: on 2026-10-30 one run started 48 checks together and workers waited an hour.
 */
function advanceVerified(
  settings: Settings,
  store: DevVerifierOptions['store'],
  expectedBase: string,
  expectedDev: string,
  history: VerifierLandings,
  passedTaskIds: ReadonlySet<string>,
): boolean {
  try {
    if (head(settings.mainCheckout, settings.integrationBranch) !== expectedDev) return false;
    git(settings.mainCheckout, 'update-ref', ref(verifiedBranch), history.interval.target, expectedBase);
    recordVerified(store, history, passedTaskIds);
    return true;
  } catch {
    // Concurrent ref movement wins; the next verifier starts from the new exact pair.
    return false;
  }
}

function updateFindingOwner(
  options: DevVerifierOptions,
  findings: readonly DevVerifierFinding[],
  task: Task | undefined,
  reason: string,
): void {
  for (const finding of findings) {
    finding.reason = reason;
    if (task) finding.taskId = task.id;
    saveFinding(options.store, finding, options.settings.policy?.verifier);
  }
}

async function revertCulprits(
  options: DevVerifierOptions,
  history: VerifierLandings,
  culprits: readonly { task: Task; findings: DevVerifierFinding[] }[],
): Promise<string | undefined> {
  if (!culprits.length) return undefined;
  const { settings, store } = options;
  const checkout = settings.mainCheckout;
  const { interval } = history;
  const target = interval.target;
  const tree = join(settings.worktreeRoot, `dev-verify-revert-${randomUUID()}`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  git(checkout, 'worktree', 'add', '--detach', tree, target);
  try {
    git(tree, 'reset', '--hard', target);
    git(tree, 'clean', '-fdx');
    const selectedCommits = [...new Set(culprits.flatMap(({ task }) => taskCommits(task, interval)))]
      .filter((commit) => interval.position.has(commit))
      .sort((a, b) => interval.position.get(b)! - interval.position.get(a)!);
    if (!selectedCommits.length) return undefined;
    const reverted = spawnSync('git', ['revert', '--no-commit', ...selectedCommits], {
      cwd: tree,
      encoding: 'utf8',
      maxBuffer: (settings.policy ?? defaultPolicy).verifier.gitBufferBytes,
    });
    if (reverted.status !== 0)
      throw new Error(`Could not revert verifier culprit changes: ${reverted.stderr || reverted.stdout}`);
    const labels = culprits.map(({ task }) => task.id).join(', ');
    const committed = spawnSync('git', ['commit', '-m', `revert: ${labels} after dev verification`], {
      cwd: tree,
      encoding: 'utf8',
      maxBuffer: (settings.policy ?? defaultPolicy).verifier.gitBufferBytes,
    });
    if (committed.status !== 0) throw new Error(`Could not commit verifier revert: ${committed.stderr}`);
    const revertHead = git(tree, 'rev-parse', 'HEAD');
    if (head(checkout, settings.integrationBranch) !== target) return undefined;
    git(checkout, 'update-ref', ref(settings.integrationBranch), revertHead, target);
    for (const { task, findings } of culprits) {
      const current = store.task(task.id);
      store.updateTask({ taskId: task.id, attempt: current.currentAttempt }, (item) => {
        item.state = 'stopped';
        delete item.integratedCommit;
        delete item.integratedCommits;
        delete item.integratedBase;
      });
      const first = findings[0]!;
      const output = first.head?.output ?? '';
      options.inbox.deliver({
        managerId: task.brief.manager,
        taskId: task.id,
        kind: 'instruction',
        evidencePath: first.head?.logPath ?? '',
        summary: `Landing ${task.id} was reverted from dev after ${first.check.command.join(' ')} failed. Log: ${first.head?.logPath ?? '(no log)'}\n${output.slice(-(settings.policy ?? defaultPolicy).verifier.diagnosticCharacters)}`,
      });
    }
    return revertHead;
  } finally {
    git(checkout, 'worktree', 'remove', '--force', tree);
  }
}

async function dispatchBootOwner(
  options: DevVerifierOptions,
  check: IndexedCheck,
  assertion: string,
  evidence: DevVerifierEvidence,
  verified: string,
  target: string,
): Promise<void> {
  const test = bootSmokeTestPath(check);
  const selection = selectionIdentity([check]);
  const baseline = await probeAt(options, check, verified, selection, true);
  if (containsAssertion(baseline, assertion, options.settings.policy?.verifier) === true) return;
  const suspects = suspectsFor(
    options.settings,
    projectVerifierLandings(options.settings.mainCheckout, options.store, verified, target),
    check,
  );
  const owner = await locateNewFailure(options, check, assertion, suspects, selection, undefined, true);
  if (!owner) return;
  const existing = openBootRepair(options.store, test);
  options.dispatchRepair?.({
    test,
    commit: owner.integratedCommit ?? owner.mergedCommit ?? target,
    error: evidence.output,
    owner,
    ...(existing ? { existingTaskId: existing.id } : {}),
  });
}

async function smokeHead(options: DevVerifierOptions, verified: string, target: string): Promise<boolean> {
  const { settings } = options;
  const execution = verifierExecution(options);
  const checks = bootSmokeChecks(settings, target);
  if (!checks.length) return false;
  const selection = selectionIdentity(checks);
  const runner =
    options.runBootSmoke ??
    options.runGate ??
    gateRunner((settings.policy ?? defaultPolicy).verifier.bootSmokeTimeoutMs);
  const tree = join(settings.worktreeRoot, `dev-verify-boot-${randomUUID()}`);
  mkdirSync(settings.worktreeRoot, { recursive: true });
  mkdirSync(settings.stateDirectory, { recursive: true });
  git(settings.mainCheckout, 'worktree', 'add', '--detach', tree, target);
  try {
    const setup = installDependenciesCached(execution, target, tree, dependencySetupKey(settings, target));
    if (!setup.passed) return false;
    const source = revisionSource(options, target, checks);
    let failed = false;
    for (const check of checks) {
      const result = await executeCheck(
        execution,
        runner,
        check,
        target,
        tree,
        runCacheKey(settings, target, check, selection),
        checkInput(settings, target, check, source),
      );
      const assertions = result.passed ? [] : stableAssertions(result.output, settings.policy?.verifier);
      const status = result.passed ? 'pass' : classifyRun(result, settings.policy?.verifier);
      if (status !== 'fail' || !assertions.length) {
        if (!result.passed) {
          saveFinding(
            options.store,
            makeFinding(
              check,
              verified,
              target,
              assertions.join('\n') || firstFailure(result.output).assertion,
              'unknown',
              null,
              result,
              'Boot smoke did not yield a stable product assertion.',
              status === 'pass' ? 'infrastructure' : status,
            ),
            settings.policy?.verifier,
          );
        }
        continue;
      }
      failed = true;
      const assertion = assertions[0]!;
      const finding = makeFinding(
        check,
        verified,
        target,
        assertion,
        'new',
        null,
        result,
        'Boot smoke failed at the newest dev head.',
        'fail',
      );
      saveFinding(options.store, finding, settings.policy?.verifier);
      await dispatchBootOwner(options, check, assertion, result, verified, target);
    }
    return failed;
  } finally {
    git(settings.mainCheckout, 'worktree', 'remove', '--force', tree);
  }
}

async function smokeNewestHeads(options: DevVerifierOptions, verified: string): Promise<boolean> {
  const checkout = options.settings.mainCheckout;
  let smoked: string | undefined;
  let failed = false;
  while (true) {
    const latest = head(checkout, options.settings.integrationBranch);
    if (latest === smoked || latest === verified) return failed;
    if (spawnSync('git', ['merge-base', '--is-ancestor', verified, latest], { cwd: checkout }).status !== 0)
      return failed;
    if (await smokeHead(options, verified, latest)) failed = true;
    smoked = latest;
  }
}

/** Verify a fixed dev head; the ref moves only after a compare-and-swap against that exact head. */
export async function verifyDev(options: DevVerifierOptions): Promise<void> {
  const { settings, store } = options,
    checkout = settings.mainCheckout;
  await options.runPageData?.();
  const lock = acquireDirectoryLease(join(settings.stateDirectory, 'dev-verifier.lease'), settings.policy?.leases);
  try {
    const captured = head(checkout, settings.integrationBranch);
    let verified: string;
    try {
      verified = head(checkout, verifiedBranch);
    } catch {
      // The train already checked every landing before this verifier was introduced.
      try {
        git(checkout, 'update-ref', ref(verifiedBranch), captured, '');
      } catch {
        /* another verifier initialized it */
      }
      return;
    }
    if (
      verified === captured ||
      spawnSync('git', ['merge-base', '--is-ancestor', verified, captured], { cwd: checkout }).status !== 0
    )
      return;

    const bootFailed = await smokeNewestHeads(options, verified);
    const dev = head(checkout, settings.integrationBranch);
    if (
      verified === dev ||
      spawnSync('git', ['merge-base', '--is-ancestor', verified, dev], { cwd: checkout }).status !== 0
    )
      return;

    const history = projectVerifierLandings(checkout, store, verified, dev);
    const initial = await reconcileComparison(options, history);
    const initialUnknown = initial.unknown;
    let finalHead = dev;
    let finalHistory = history;
    let finalPassedTasks = new Set(initial.comparison.passTaskIds);
    if (initial.groups.length) {
      const owned: { group: FindingGroup; owners: Task[]; unknownOwner: boolean }[] = [];
      for (const group of initial.groups) {
        const suspects = suspectsFor(settings, history, group.check);
        const owners: Task[] = [];
        let unknownOwner = false;
        for (const assertion of group.targets) {
          const finding = group.findings.find((item) => item.assertion === assertion)!;
          if (group.check.taskId) {
            const direct = suspects.find((item) => item.task.id === group.check.taskId)?.task;
            if (direct) owners.push(direct);
            else unknownOwner = true;
            continue;
          }
          // If the baseline failed the same assertion, a clean intermediate prefix gives the lower bound for owner
          // bisection. New assertions use the ordinary first-failing-prefix search from the verified base.
          const baseHasAssertion =
            finding.baseline !== null &&
            !finding.baseline.passed &&
            stableAssertions(finding.baseline.output, settings.policy?.verifier).includes(assertion);
          let cleanIndex: number | undefined;
          if (baseHasAssertion) {
            const proof = await proveExistingOrReintroduced(
              options,
              group.check,
              assertion,
              suspects,
              selectionIdentity(initial.comparison.checks),
            );
            if (proof.status === 'unknown') {
              unknownOwner = true;
              updateFindingOwner(
                options,
                [finding],
                undefined,
                'New failure is visible, but its owner is unknown because prefix evidence was incomplete.',
              );
              continue;
            }
            if (proof.status === 'existing') {
              updateFindingOwner(
                options,
                [finding],
                undefined,
                'Failure is pre-existing on the exact baseline; no landing was assigned.',
              );
              continue;
            }
            cleanIndex = proof.cleanIndex;
          }
          const owner = await locateNewFailure(
            options,
            group.check,
            assertion,
            suspects,
            selectionIdentity(initial.comparison.checks),
            cleanIndex,
          );
          if (owner === null) unknownOwner = true;
          else if (owner) owners.push(owner);
          else unknownOwner = true;
          updateFindingOwner(
            options,
            [finding],
            owner ?? undefined,
            owner
              ? `New failure attributed to the owning landing ${owner.id}.`
              : 'New failure has no proven owner in the captured verified range.',
          );
        }
        owned.push({ group, owners: [...new Map(owners.map((task) => [task.id, task])).values()], unknownOwner });
      }
      const byTask = new Map<string, { task: Task; findings: DevVerifierFinding[] }>();
      for (const item of owned) {
        for (const task of item.owners) {
          const entry = byTask.get(task.id) ?? { task, findings: [] };
          entry.findings.push(...item.group.findings);
          byTask.set(task.id, entry);
        }
      }
      for (const entry of byTask.values()) {
        entry.findings = [...new Map(entry.findings.map((finding) => [finding.identity, finding])).values()];
      }
      if (!byTask.size) return;
      const revertEntries = [...byTask.values()].filter((entry) =>
        entry.findings.some((finding) => verifierFailureRevertsLanding(finding.check)),
      );
      const revertedIds = new Set(revertEntries.map((entry) => entry.task.id));
      for (const item of owned) {
        if (verifierFailureRevertsLanding(item.group.check)) continue;
        const evidence = item.group.findings[0]?.head;
        if (!evidence) continue;
        for (const owner of item.owners) {
          if (revertedIds.has(owner.id)) continue;
          dispatchTestFailure(options, item.group.check, evidence, owner, history.interval.target);
        }
      }
      if (revertEntries.length) {
        const postRevert = await revertCulprits(options, history, revertEntries);
        if (!postRevert) return;
        finalHead = postRevert;
        finalHistory = projectVerifierLandings(checkout, store, verified, postRevert);
        const afterRevert = await reconcileComparison(options, finalHistory);
        if (afterRevert.unknown) return;
        const remainingRevert = afterRevert.groups.filter((group) => verifierFailureRevertsLanding(group.check));
        if (remainingRevert.length) return;
        for (const group of afterRevert.groups) {
          const ownerId = group.findings.find((finding) => finding.taskId)?.taskId;
          const owner = ownerId ? store.task(ownerId) : undefined;
          const evidence = group.findings[0]?.head;
          if (!owner || !evidence) continue;
          dispatchTestFailure(options, group.check, evidence, owner, postRevert);
        }
        if (afterRevert.groups.length) return;
        finalPassedTasks = new Set(afterRevert.comparison.passTaskIds);
      } else {
        return;
      }
    } else if (initialUnknown) {
      return;
    }
    if (bootFailed) return;
    advanceVerified(settings, store, verified, finalHead === dev ? dev : finalHead, finalHistory, finalPassedTasks);
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
): {
  head: string | null;
  behind: number | null;
  state: string;
  findings: VerificationFindingCounts;
  releaseGate: 'full-gate-required';
} {
  try {
    const verified = head(cwd, verifiedBranch),
      dev = head(cwd, integrationBranch);
    const landed = new Set(git(cwd, 'rev-list', '--reverse', `${verified}..${dev}`).split('\n').filter(Boolean));
    const behind = tasks
      ? tasks.filter(
          (task) =>
            (task.integratedCommit ?? task.mergedCommit) && landed.has(task.integratedCommit ?? task.mergedCommit!),
        ).length
      : landed.size;
    const running = stateDirectory !== undefined && existsSync(join(stateDirectory, 'dev-verifier.lease'));
    return {
      head: verified,
      behind,
      state: running ? 'running' : behind ? 'pending' : 'current',
      findings: readFindingCounts(stateDirectory),
      releaseGate: 'full-gate-required',
    };
  } catch {
    return {
      head: null,
      behind: null,
      state: 'uninitialized',
      findings: readFindingCounts(stateDirectory),
      releaseGate: 'full-gate-required',
    };
  }
}
