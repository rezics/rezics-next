import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type {
  DevVerifierEvidence,
  DevVerifierFinding,
  DevVerifierRoundSummary,
  DevVerifierRun,
  Settings,
  Task,
} from './types.ts';
import { defaultPolicy } from './policy.ts';
import type { WorkerStore } from './store.ts';
import { gateRunner, git } from './merge.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import {
  VERIFY_CONCURRENCY,
  dependencySetupKey,
  makeFinding,
  runChecksAtHead,
  type CheckRun,
} from './dev-verifier-comparison.ts';
import { classifyRun, stableAssertions } from './dev-verifier-classification.ts';
import { installDependenciesCached } from './dev-verifier-execution.ts';
import {
  countSourceIntervalCommits,
  createFullVerifierChecks,
  createVerifierChecks,
  filesInCommits,
  matches,
  placeBootSmokeCheck,
  projectVerifierLandings,
  taskCommits,
  trackedFilesAt,
  type DevVerifierCheck,
  type VerifierLandings,
} from './dev-verifier-plan.ts';
import {
  latestRound,
  readFindingCounts,
  saveFinding,
  saveRun,
  type DevVerifierStorage,
  type VerificationFindingCounts,
} from './dev-verifier-storage.ts';

export { placeInWorkspace, projectSourceInterval, projectVerifierLandings } from './dev-verifier-plan.ts';
export type { DevVerifierCheck, SourceInterval, VerifierLandings } from './dev-verifier-plan.ts';
export { classifyRun };
export { withTreeBun } from './dev-verifier-execution.ts';
export { VERIFY_CONCURRENCY } from './dev-verifier-comparison.ts';

type Check = DevVerifierCheck;
const ref = (branch: string) => 'refs/heads/' + branch;
const verifiedBranch = 'dev-verified';
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const tick = String.fromCharCode(96);

function head(cwd: string, branch: string): string {
  return git(cwd, 'rev-parse', '--verify', ref(branch));
}

export type TestFailure = {
  test: string;
  assertions: string[];
  error: string;
  owner: Task;
};
export type TestFailureRepair = {
  goal: string;
  manager: string;
  commit: string;
  owner: Task;
  failures: TestFailure[];
  paths: string[];
  existingTaskId?: string;
};

export type DevVerifierOptions = {
  settings: Settings;
  store: Pick<WorkerStore, 'tasks'> & DevVerifierStorage;
  runGate?: ReturnType<typeof gateRunner>;
  runBootSmoke?: ReturnType<typeof gateRunner>;
  dispatchTestRepair?: (repair: TestFailureRepair) => void;
  runPageData?: () => Promise<unknown>;
};

const OPEN_REPAIR_STATES = new Set(['ready', 'held', 'running', 'landing', 'stopped']);

function identity(check: Check): string {
  return JSON.stringify([check.command, check.closure, check.taskId ?? '', check.cwd ?? '']);
}

function uniqueChecks(checks: readonly Check[]): Check[] {
  const result = new Map<string, Check>();
  for (const check of checks) result.set(identity(check), check);
  return [...result.values()];
}

function bootSmokeChecks(settings: Settings, commit: string): Check[] {
  const tracked = trackedFilesAt(settings.mainCheckout, commit);
  return (settings.bootSmoke?.tests ?? [])
    .filter((test) => tracked.has(test))
    .flatMap((test) =>
      placeBootSmokeCheck({ command: ['bun', 'test', test], closure: ['**'] }, tracked, settings.mainCheckout),
    );
}

function isAncestor(cwd: string, base: string, target: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', base, target], { cwd }).status === 0;
}

function shouldRunRound(previous: DevVerifierRun | undefined, now: number, intervalMs: number): boolean {
  if (!previous?.round) return true;
  const completedAt = Date.parse(previous.round.completedAt);
  return !Number.isFinite(completedAt) || now - completedAt >= intervalMs;
}

function advanceVerified(settings: Settings, target: string): void {
  const checkout = settings.mainCheckout;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = head(checkout, verifiedBranch);
    if (current === target || isAncestor(checkout, target, current)) return;
    try {
      git(checkout, 'update-ref', ref(verifiedBranch), target, current);
      return;
    } catch {
      // A concurrent ref update is retried against its actual value; the verifier never moves the ref backward.
    }
  }
}

function testFilesFor(check: CheckRun['check'], evidence: DevVerifierEvidence): string[] {
  const normalize = (path: string) => {
    const relative = path.replace(/^\.\//, '');
    return check.cwd && !relative.startsWith(check.cwd + '/') ? check.cwd + '/' + relative : relative;
  };
  const hostSelection = check.command.indexOf('--host');
  const selectedFile = hostSelection >= 0 ? check.command[hostSelection + 1] : check.command.at(-1);
  const selectedFiles = selectedFile && TEST_FILE.test(selectedFile) ? [normalize(selectedFile)] : [];
  if (selectedFiles.length === 1) return selectedFiles;
  const found = new Set<string>();
  const output = evidence.output.replaceAll('\\', '/');
  const expression =
    /(?:^|[\s([{"'])((?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?/g;
  for (const match of output.matchAll(expression)) found.add(match[1]!);
  if (found.size) return [...found].map(normalize);
  if (selectedFiles.length) return selectedFiles;
  const source = check.closure.find((path) => !path.includes('*') && TEST_FILE.test(path));
  if (source) return [normalize(source)];
  return [check.command.join(' ')];
}

function changedPaths(history: VerifierLandings | undefined, task: Task): string[] {
  if (!history) return [];
  return filesInCommits(history.interval, taskCommits(task, history.interval));
}

function ownerForFailure(
  options: DevVerifierOptions,
  history: VerifierLandings | undefined,
  check: CheckRun['check'],
  test: string,
): Task | undefined {
  const tasks = options.store.tasks();
  if (check.taskId) {
    const direct = tasks.find((task) => task.id === check.taskId);
    if (direct) return direct;
  }
  const testIsPath = TEST_FILE.test(test);
  const eligible = tasks.filter((task) => ['integrated', 'merged'].includes(task.state));
  const relevant = eligible.filter((task) => {
    const paths = task.brief.paths ?? [];
    if (testIsPath && matches(test, paths, options.settings.policy?.brief)) return true;
    return changedPaths(history, task).some(
      (file) =>
        matches(file, paths, options.settings.policy?.brief) &&
        matches(file, check.closure, options.settings.policy?.brief),
    );
  });
  const interval = history?.interval;
  relevant.sort((left, right) => {
    const leftCommit = left.integratedCommit ?? left.mergedCommit;
    const rightCommit = right.integratedCommit ?? right.mergedCommit;
    const leftPosition = interval && leftCommit ? (interval.position.get(leftCommit) ?? -1) : -1;
    const rightPosition = interval && rightCommit ? (interval.position.get(rightCommit) ?? -1) : -1;
    return rightPosition - leftPosition || right.sequence - left.sequence;
  });
  return relevant[0];
}

export function testFailureRepairBrief(repair: TestFailureRepair, policy = defaultPolicy.verifier): string {
  const failures = repair.failures
    .map((failure) => {
      const assertions = failure.assertions.map((assertion) => '- ' + assertion).join('\n');
      return (
        '- Test file: ' +
        tick +
        failure.test +
        tick +
        '\n  Assertions:\n' +
        assertions +
        '\n\n  Output:\n\n  ' +
        failure.error
          .slice(-policy.diagnosticCharacters)
          .split('\n')
          .map((line) => '  ' + line)
          .join('\n')
      );
    })
    .join('\n\n');
  const frontMatter = {
    goal: repair.goal,
    manager: repair.manager,
    kind: 'implementation',
    paths: repair.paths,
    riskAreas: repair.owner.brief.riskAreas ?? [],
    urgent: true,
    acceptance: { failing: true },
    criticalPath: false,
    waiting: [],
    after: [],
  };
  return (
    '---\n' +
    JSON.stringify(frontMatter, null, 2) +
    '\n---\n\n' +
    '# Repair failing tests\n\nTest failure repair batch for goal ' +
    tick +
    repair.goal +
    tick +
    ' at head ' +
    tick +
    repair.commit +
    tick +
    '.\n\n' +
    failures +
    '\n'
  );
}

function openTestRepair(store: Pick<WorkerStore, 'tasks'>, goal: string): Task | undefined {
  const marker = 'Test failure repair batch for goal ' + tick + goal + tick;
  return store
    .tasks()
    .find(
      (task) =>
        OPEN_REPAIR_STATES.has(task.state) && task.brief.urgent === true && task.brief.markdown.includes(marker),
    );
}

function dispatchTestRepairs(options: DevVerifierOptions, failures: readonly TestFailure[], commit: string): void {
  if (!options.dispatchTestRepair || !failures.length) return;
  const groups = new Map<string, TestFailure[]>();
  for (const failure of failures) {
    const goal = failure.owner.brief.goal;
    const manager = failure.owner.brief.manager;
    if (!goal || !manager) continue;
    const key = goal + '\0' + manager;
    groups.set(key, [...(groups.get(key) ?? []), failure]);
  }
  for (const [key, items] of groups) {
    const [goal, manager] = key.split('\0') as [string, string];
    const owner = items[0]!.owner;
    const paths = [
      ...new Set(
        items.flatMap(({ owner: itemOwner, test }) => [
          ...(itemOwner.brief.paths ?? []),
          ...(TEST_FILE.test(test) ? [test] : []),
        ]),
      ),
    ];
    const existing = openTestRepair(options.store, goal);
    try {
      options.dispatchTestRepair({
        goal,
        manager,
        commit,
        owner,
        failures: items,
        paths,
        ...(existing ? { existingTaskId: existing.id } : {}),
      });
    } catch {
      // Repair delivery is an external side effect; a delivery failure cannot stall verifier progress.
    }
  }
}

function recordResults(
  options: DevVerifierOptions,
  history: VerifierLandings | undefined,
  base: string,
  target: string,
  runs: readonly CheckRun[],
): { testsRun: number; passed: number; failed: number; unknown: number; repairs: TestFailure[] } {
  let passed = 0;
  let failed = 0;
  let unknown = 0;
  const repairs: TestFailure[] = [];
  const failedTests = new Map<
    string,
    { check: CheckRun['check']; assertions: Set<string>; evidence: DevVerifierEvidence }
  >();
  for (const { check, evidence } of runs) {
    const outcome = classifyRun(evidence, options.settings.policy?.verifier);
    if (outcome === 'pass') {
      passed++;
      continue;
    }
    const testNames = testFilesFor(check, evidence);
    if (outcome === 'fail') {
      failed++;
      const assertions = stableAssertions(evidence.output, options.settings.policy?.verifier);
      for (const test of testNames) {
        const previous = failedTests.get(test);
        if (previous) assertions.forEach((assertion) => previous.assertions.add(assertion));
        else failedTests.set(test, { check, assertions: new Set(assertions), evidence });
      }
      continue;
    }
    unknown++;
    const test = testNames[0] ?? check.command.join(' ');
    saveFinding(
      options.store,
      makeFinding(
        check,
        base,
        target,
        test,
        'Unknown verifier result: ' + evidence.output.slice(-1200),
        'unknown',
        evidence,
        'The check did not produce a stable result.',
        'infrastructure',
      ),
      options.settings.policy?.verifier,
    );
  }
  for (const [test, failure] of failedTests) {
    const assertions = [...failure.assertions];
    saveFinding(
      options.store,
      makeFinding(
        failure.check,
        base,
        target,
        test,
        assertions.join('\n'),
        'new',
        failure.evidence,
        'Failed at the current dev head during this verifier round.',
        'fail',
      ),
      options.settings.policy?.verifier,
    );
    const owner = ownerForFailure(options, history, failure.check, test);
    if (owner) repairs.push({ test, assertions, error: failure.evidence.output, owner });
  }
  return { testsRun: runs.length, passed, failed, unknown, repairs };
}

function saveRoundRecord(options: DevVerifierOptions, summary: DevVerifierRoundSummary): void {
  const result = summary.failed ? 'fail' : summary.unknown ? 'infrastructure' : 'pass';
  const record: DevVerifierRun = {
    key: 'dev-verifier-round:' + summary.startedAt + ':' + randomUUID(),
    createdAt: summary.completedAt,
    evidence: {
      commit: summary.headCommit,
      command: ['dev-verifier-round'],
      passed: result === 'pass',
      timedOut: false,
      output: JSON.stringify({
        testsRun: summary.testsRun,
        passed: summary.passed,
        failed: summary.failed,
        unknown: summary.unknown,
        durationMs: summary.durationMs,
      }),
      logPath: '',
      result,
    },
    round: summary,
  };
  saveRun(options.store, record, options.settings.policy?.verifier);
}

async function runRound(options: DevVerifierOptions, previous: DevVerifierRun | undefined): Promise<void> {
  const { settings } = options;
  const checkout = settings.mainCheckout;
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const captured = head(checkout, settings.integrationBranch);
  let verified: string;
  try {
    verified = head(checkout, verifiedBranch);
  } catch {
    git(checkout, 'update-ref', ref(verifiedBranch), captured, '');
    verified = captured;
  }
  const previousHead = previous?.round?.headCommit ?? verified;
  let history: VerifierLandings | undefined;
  const firstRound = !previous?.round;
  let fullSuite = firstRound || !isAncestor(checkout, previousHead, captured);
  let freshChecks: Check[];
  const bootChecks = bootSmokeChecks(settings, captured);
  const bootPaths = settings.bootSmoke?.tests ?? [];
  if (!fullSuite) {
    const changedCommits = countSourceIntervalCommits(checkout, previousHead, captured);
    if (changedCommits > (settings.policy ?? defaultPolicy).verifier.maxSelectionCommits) fullSuite = true;
  }
  if (fullSuite) freshChecks = createFullVerifierChecks(settings, captured, bootPaths);
  else {
    history = projectVerifierLandings(checkout, options.store, previousHead, captured);
    freshChecks = createVerifierChecks(settings, history, captured, bootPaths);
  }
  const carriedChecks = previous?.round?.pendingChecks ?? [];
  const regularChecks = uniqueChecks([...carriedChecks, ...freshChecks]).filter(
    (check) => !bootChecks.some((boot) => identity(boot) === identity(check)),
  );
  const checks = [...uniqueChecks(bootChecks), ...regularChecks];
  const policy = (settings.policy ?? defaultPolicy).verifier;
  const deadline = startedMs + policy.roundDeadlineMs;
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  const tree = join(settings.worktreeRoot, 'dev-verify-round-' + randomUUID());
  mkdirSync(settings.worktreeRoot, { recursive: true });
  mkdirSync(settings.stateDirectory, { recursive: true });
  let treeAdded = false;
  let counts = { testsRun: 0, passed: 0, failed: 0, unknown: 0, repairs: [] as TestFailure[] };
  let pendingChecks: Check[] = checks;
  try {
    git(checkout, 'worktree', 'add', '--detach', tree, captured);
    treeAdded = true;
    const execution = {
      settings,
      readRun: (key: string) => options.store.devVerifierRun?.(key)?.evidence,
      saveRun: (run: DevVerifierRun) => saveRun(options.store, run, settings.policy?.verifier),
    };
    const installed = installDependenciesCached(execution, captured, tree, dependencySetupKey(settings, captured));
    if (!installed.passed) {
      counts = { testsRun: checks.length, passed: 0, failed: 0, unknown: checks.length, repairs: [] };
    } else if (checks.length) {
      const executionResult = await runChecksAtHead(
        options,
        checks,
        captured,
        tree,
        deadline,
        controller.signal,
        bootChecks.length,
      );
      pendingChecks = executionResult.pending;
      counts = recordResults(options, history, previousHead, captured, executionResult.results);
    } else pendingChecks = [];
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort();
    if (treeAdded) git(checkout, 'worktree', 'remove', '--force', tree);
  }

  dispatchTestRepairs(options, counts.repairs, captured);
  const completedAt = new Date().toISOString();
  const summary: DevVerifierRoundSummary = {
    baseCommit: previousHead,
    headCommit: captured,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.now() - startedMs),
    testsRun: counts.testsRun,
    passed: counts.passed,
    failed: counts.failed,
    unknown: counts.unknown,
    fullSuite,
    pendingChecks,
  };
  saveRoundRecord(options, summary);
  advanceVerified(settings, captured);
}

/** Run one due round on the newest captured dev head; intermediate heads never queue. */
export async function verifyDev(options: DevVerifierOptions): Promise<void> {
  const { settings } = options;
  await options.runPageData?.();
  let lock: ReturnType<typeof acquireDirectoryLease>;
  try {
    lock = acquireDirectoryLease(join(settings.stateDirectory, 'dev-verifier.lease'), settings.policy?.leases);
  } catch (error) {
    if (error instanceof LeaseHeldError) return;
    throw error;
  }
  try {
    const previous = latestRound(options.store);
    const policy = (settings.policy ?? defaultPolicy).verifier;
    if (!shouldRunRound(previous, Date.now(), policy.roundIntervalMs)) return;
    await runRound(options, previous);
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
    const verified = head(cwd, verifiedBranch);
    const dev = head(cwd, integrationBranch);
    const landed = new Set(
      git(cwd, 'rev-list', '--reverse', verified + '..' + dev)
        .split('\n')
        .filter(Boolean),
    );
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
