import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type {
  DevVerifierCause,
  DevVerifierCommand,
  DevVerifierEvidence,
  DevVerifierDiagnostic,
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
import { classifyRun, fileFailureAssertions, truncatedOutput, verifierCauses } from './dev-verifier-classification.ts';
import {
  commandMetadata,
  extractTestFileOutcomes,
  extractVerifierDiagnostics,
  isAuthDatabasePlacementFailure,
  type DiagnosticWorkspaceContext,
} from './dev-verifier-diagnostics.ts';
import { installDependenciesCached, recordSkippedCommand } from './dev-verifier-execution.ts';
import {
  countSourceIntervalCommits,
  createFullVerifierChecks,
  createVerifierChecks,
  matches,
  placeBootSmokeCheck,
  projectVerifierLandings,
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
const TEST_FILE = /^(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const tick = String.fromCharCode(96);
const ACTIVE_OWNER_STATES = new Set(['ready', 'held', 'running', 'landing', 'stopped']);
const LANDED_OWNER_STATES = new Set(['integrated', 'merged']);

function head(cwd: string, branch: string): string {
  return git(cwd, 'rev-parse', '--verify', ref(branch));
}

export type TestFailure = {
  test?: string;
  assertions: string[];
  error: string;
  owner: Task;
  cause?: DevVerifierCause;
  diagnostic?: DevVerifierDiagnostic;
  command?: DevVerifierCommand;
  sourceRevision?: string;
  evidenceLogPath?: string;
  evidence?: TestFailureEvidence[];
};
export type TestFailureEvidence = {
  command?: DevVerifierCommand;
  sourceRevision?: string;
  evidenceLogPath?: string;
  output: string;
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

function failureEvidence(failure: TestFailure): TestFailureEvidence[] {
  return (
    failure.evidence ?? [
      {
        ...(failure.command ? { command: failure.command } : {}),
        ...(failure.sourceRevision ? { sourceRevision: failure.sourceRevision } : {}),
        ...(failure.evidenceLogPath ? { evidenceLogPath: failure.evidenceLogPath } : {}),
        output: failure.error,
      },
    ]
  );
}

function mergeRepeatedNamedTestFailures(failures: readonly TestFailure[]): TestFailure[] {
  const result: TestFailure[] = [];
  const byIdentity = new Map<string, number>();
  for (const failure of failures) {
    if (!failure.test || !TEST_FILE.test(failure.test)) {
      result.push(failure);
      continue;
    }
    const key = JSON.stringify([failure.owner.id, failure.cause ?? 'product-runtime', failure.test]);
    const existingIndex = byIdentity.get(key);
    if (existingIndex === undefined) {
      byIdentity.set(key, result.length);
      result.push(failure);
      continue;
    }
    const existing = result[existingIndex]!;
    const evidence = [...failureEvidence(existing), ...failureEvidence(failure)];
    const uniqueEvidence = [...new Map(evidence.map((item) => [JSON.stringify(item), item])).values()];
    const outputs = [...new Set(uniqueEvidence.map(({ output }) => output))];
    result[existingIndex] = {
      ...existing,
      assertions: [...new Set([...existing.assertions, ...failure.assertions])],
      error: outputs.join('\n\n--- separate verifier result ---\n\n'),
      evidence: uniqueEvidence,
    };
  }
  return result;
}

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

function bootSmokePlan(settings: Settings, commit: string): { checks: Check[]; skipped: Check[] } {
  const tracked = trackedFilesAt(settings.mainCheckout, commit);
  const tests = [...new Set(settings.bootSmoke?.tests ?? [])];
  return {
    checks: tests
      .filter((test) => tracked.has(test))
      .flatMap((test) =>
        placeBootSmokeCheck({ command: ['bun', 'test', test], closure: ['**'] }, tracked, settings.mainCheckout),
      ),
    skipped: tests
      .filter((test) => !tracked.has(test))
      .map((test) => ({ command: ['bun', 'test', test], closure: ['**'] })),
  };
}

function isAncestor(cwd: string, base: string, target: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', base, target], { cwd }).status === 0;
}

const CHANGED_DEV_CHECK_INTERVAL_MS = 10 * 60_000;

function shouldRunRound(previous: DevVerifierRun | undefined, target: string, now: number, intervalMs: number): boolean {
  if (!previous?.round) return true;
  const { completedAt, headCommit, pendingChecks, unknown } = previous.round;
  const changed = headCommit !== target;
  // A settled head has no new evidence to collect. Unreached and infrastructure results keep the normal retry cadence.
  if (!changed && (pendingChecks?.length ?? 0) === 0 && unknown === 0) return false;
  const completed = Date.parse(completedAt);
  const interval = changed ? Math.min(intervalMs, CHANGED_DEV_CHECK_INTERVAL_MS) : intervalMs;
  return !Number.isFinite(completed) || now - completed >= interval;
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

function matchingPathSpecificity(file: string, paths: readonly string[], options: DevVerifierOptions): number {
  const matching = paths.filter((path) => matches(file, [path], options.settings.policy?.brief));
  const score = (path: string) =>
    path
      .replaceAll('*', '')
      .replaceAll('?', '')
      .replaceAll('{', '')
      .replaceAll('}', '')
      .replaceAll('[', '')
      .replaceAll(']', '').length;
  return matching.length ? Math.max(...matching.map(score)) : -1;
}

function ownersForFile(
  options: DevVerifierOptions,
  file: string,
  includeLanded: boolean,
): { task: Task; specificity: number }[] {
  return options.store
    .tasks()
    .filter((task) => ACTIVE_OWNER_STATES.has(task.state) || (includeLanded && LANDED_OWNER_STATES.has(task.state)))
    .map((task) => ({ task, specificity: matchingPathSpecificity(file, task.brief.paths ?? [], options) }))
    .filter(({ specificity }) => specificity >= 0);
}

function uniqueOwner(
  candidates: { task: Task; specificity: number }[],
  preferredTaskId: string | undefined,
): { owner?: Task; ambiguous: Task[] } {
  if (!candidates.length) return { ambiguous: [] };
  const active = candidates.filter(({ task }) => ACTIVE_OWNER_STATES.has(task.state));
  const eligible = active.length ? active : candidates;
  const specificity = Math.max(...eligible.map(({ specificity: score }) => score));
  const best = eligible.filter(({ specificity: score }) => score === specificity);
  if (best.length > 1 && preferredTaskId) {
    const preferred = best.find(({ task }) => task.id === preferredTaskId);
    if (preferred) return { owner: preferred.task, ambiguous: [] };
  }
  return best.length === 1 ? { owner: best[0]!.task, ambiguous: [] } : { ambiguous: best.map(({ task }) => task) };
}

export type DiagnosticOwnerReconciliation = {
  state: 'owned' | 'ambiguous' | 'stale' | 'unresolved';
  owner?: Task;
  currentRevision?: string;
  reason: string;
};

function sourceUnchangedAtCurrentRevision(
  checkout: string,
  capturedRevision: string,
  currentRevision: string,
  file: string,
): boolean | undefined {
  const source = spawnSync('git', ['cat-file', '-e', `${currentRevision}:${file}`], { cwd: checkout });
  if (source.error) throw source.error;
  if (source.status === null) return undefined;
  if (source.status !== 0) return false;
  if (capturedRevision === currentRevision) return true;
  const diff = spawnSync('git', ['diff', '--quiet', `${capturedRevision}..${currentRevision}`, '--', file], {
    cwd: checkout,
  });
  if (diff.error) throw diff.error;
  if (diff.status === null) return undefined;
  if (diff.status === 0) return true;
  return diff.status === 1 ? false : undefined;
}

export function reconcileDiagnosticOwner(
  options: DevVerifierOptions,
  check: CheckRun['check'],
  diagnostic: DevVerifierDiagnostic,
  capturedRevision: string,
  currentRevision = head(options.settings.mainCheckout, options.settings.integrationBranch ?? 'dev'),
): DiagnosticOwnerReconciliation {
  const location = diagnostic.location;
  if (!location?.file || !location.resolved)
    return { state: 'unresolved', reason: 'The compiler operand could not be resolved to a repository source path.' };

  return reconcileSourceOwner(options, check, location.file, capturedRevision, currentRevision);
}

function reconcileSourceOwner(
  options: DevVerifierOptions,
  check: CheckRun['check'],
  file: string,
  capturedRevision: string,
  currentRevision: string,
  includeLanded = false,
): DiagnosticOwnerReconciliation {
  const checkout = options.settings.mainCheckout;
  const branch = options.settings.integrationBranch ?? 'dev';
  if (!isAncestor(checkout, capturedRevision, currentRevision))
    return {
      state: 'unresolved',
      currentRevision,
      reason: `Captured revision ${capturedRevision} is not an ancestor of current ${branch} ${currentRevision}.`,
    };
  const unchanged = sourceUnchangedAtCurrentRevision(checkout, capturedRevision, currentRevision, file);
  if (unchanged === false)
    return {
      state: 'stale',
      currentRevision,
      reason: `Current source ${file} changed after captured revision ${capturedRevision}; current revision is ${currentRevision}.`,
    };
  if (unchanged === undefined)
    return {
      state: 'unresolved',
      currentRevision,
      reason: `Could not compare ${file} between captured revision ${capturedRevision} and current revision ${currentRevision}.`,
    };

  const candidates = ownersForFile(options, file, includeLanded);
  const chosen = uniqueOwner(candidates, check.taskId);
  if (chosen.owner)
    return {
      state: 'owned',
      owner: chosen.owner,
      currentRevision,
      reason: `Concrete failed source ${file} matches the owner's declared paths.`,
    };
  if (chosen.ambiguous.length)
    return {
      state: 'ambiguous',
      currentRevision,
      reason: `Concrete failed source ${file} matches multiple owners: ${chosen.ambiguous.map(({ id }) => id).join(', ')}.`,
    };
  return {
    state: 'unresolved',
    currentRevision,
    reason: `No established owner declares concrete failed source ${file}.`,
  };
}

function ownerForTest(
  options: DevVerifierOptions,
  check: CheckRun['check'],
  test: string,
  capturedRevision: string,
  currentRevision: string,
): DiagnosticOwnerReconciliation {
  return reconcileSourceOwner(options, check, test, capturedRevision, currentRevision, true);
}

export function testFailureRepairBrief(repair: TestFailureRepair, policy = defaultPolicy.verifier): string {
  const failures = repair.failures
    .map((failure) => {
      const assertions = failure.assertions.map((assertion) => '- ' + assertion).join('\n');
      const isNamedTest = !!failure.test && TEST_FILE.test(failure.test);
      const subject = isNamedTest
        ? '- Test file: ' + tick + failure.test + tick
        : failure.command || failure.test
          ? '- Command: ' + tick + (failure.command ? JSON.stringify(failure.command.argv) : failure.test) + tick
          : '- ' +
            (failure.cause ?? 'Verifier') +
            ' diagnostic: ' +
            (failure.diagnostic?.message ?? 'unresolved failure');
      const sources = failureEvidence(failure);
      const provenance = [
        ...sources.map((source, index) =>
          [
            sources.length > 1 ? '  Evidence ' + (index + 1) + ':' : '',
            source.sourceRevision ? '  Source revision: ' + tick + source.sourceRevision + tick : '',
            source.command
              ? '  Command: ' +
                tick +
                JSON.stringify(source.command.argv) +
                tick +
                ' (cwd ' +
                tick +
                (source.command.cwd ?? '.') +
                tick +
                ')'
              : '',
            source.evidenceLogPath ? '  Original result: ' + tick + source.evidenceLogPath + tick : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        failure.diagnostic?.location
          ? '  Location: ' +
            tick +
            failure.diagnostic.location.file +
            ':' +
            (failure.diagnostic.location.line ?? '?') +
            ':' +
            (failure.diagnostic.location.column ?? '?') +
            tick
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      const output = sources
        .map(
          ({ output: evidenceOutput }, index) =>
            (sources.length > 1 ? `  Evidence ${index + 1}:\n` : '') +
            evidenceOutput
              .slice(-policy.diagnosticCharacters)
              .split('\n')
              .map((line) => '  ' + line)
              .join('\n'),
        )
        .join('\n\n');
      return (
        subject +
        (provenance ? '\n' + provenance : '') +
        '\n  Assertions:\n' +
        assertions +
        '\n\n  Output:\n\n  ' +
        output
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
    const key = goal + '\0' + manager + '\0' + (failure.cause ?? 'product-runtime');
    groups.set(key, [...(groups.get(key) ?? []), failure]);
  }
  for (const [key, items] of groups) {
    const [goal, manager, cause] = key.split('\0') as [string, string, DevVerifierCause | 'product-runtime'];
    const owner = items[0]!.owner;
    const paths =
      cause === 'compiler'
        ? [
            ...new Set(
              items.flatMap(({ diagnostic }) => (diagnostic?.location?.file ? [diagnostic.location.file] : [])),
            ),
          ]
        : [...new Set(items.flatMap(({ test }) => (test && TEST_FILE.test(test) ? [test] : [])))];
    const existing = cause === 'compiler' ? undefined : openTestRepair(options.store, goal);
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

function findingProvenance(check: CheckRun['check'], revision: string): string {
  const command = commandMetadata(check);
  return `Captured revision ${revision}; argv ${JSON.stringify(command.argv)}; cwd ${command.cwd ?? '.'}. Original command output is retained in the finding evidence.`;
}

function saveDiagnosticFinding(
  options: DevVerifierOptions,
  check: CheckRun['check'],
  base: string,
  target: string,
  diagnostic: DevVerifierDiagnostic,
  status: DevVerifierFinding['status'],
  evidence: DevVerifierEvidence,
  reason: string,
  result: DevVerifierFinding['result'],
): void {
  const location = diagnostic.location;
  const assertion = [diagnostic.code, diagnostic.message].filter(Boolean).join(': ');
  saveFinding(
    options.store,
    makeFinding(
      check,
      base,
      target,
      undefined,
      assertion,
      status,
      evidence,
      `${reason} ${findingProvenance(check, target)}`,
      result,
      diagnostic.cause,
      diagnostic,
      location ? `${location.file}:${location.line ?? '?'}:${location.column ?? '?'}` : undefined,
    ),
    options.settings.policy?.verifier,
  );
}

export function recordVerifierResults(
  options: DevVerifierOptions,
  base: string,
  target: string,
  runs: readonly CheckRun[],
): { testsRun: number; passed: number; failed: number; unknown: number; skipped: number; repairs: TestFailure[] } {
  let passed = 0;
  let failed = 0;
  let unknown = 0;
  let skipped = 0;
  const repairs: TestFailure[] = [];
  const currentRevision = head(options.settings.mainCheckout, options.settings.integrationBranch ?? 'dev');
  for (const { check, evidence } of runs) {
    const outcome = classifyRun(evidence, options.settings.policy?.verifier);
    if (outcome === 'pass') {
      passed++;
      continue;
    }
    if (outcome === 'skipped') {
      skipped++;
      continue;
    }
    if (outcome === 'fail') failed++;
    else unknown++;

    const workspace: DiagnosticWorkspaceContext = {
      repositoryRoot: options.settings.mainCheckout,
      workspace: check.cwd ?? '',
    };
    const command = commandMetadata(check);
    const diagnostics = extractVerifierDiagnostics(evidence, workspace);
    const compilerDiagnostics = diagnostics.filter(({ cause }) => cause === 'compiler');
    const independentDiagnostics = diagnostics.filter(({ cause }) => cause !== 'compiler');
    const testAttribution = extractTestFileOutcomes(check, evidence, workspace);
    const causes = verifierCauses(evidence, options.settings.policy?.verifier);
    const setupFailure = independentDiagnostics.some(({ cause }) => cause === 'setup');

    for (const diagnostic of compilerDiagnostics) {
      const ownerResult = reconcileDiagnosticOwner(options, check, diagnostic, target, currentRevision);
      const owner = ownerResult.state === 'owned' ? ownerResult.owner : undefined;
      saveDiagnosticFinding(
        options,
        check,
        base,
        target,
        diagnostic,
        owner ? 'new' : 'unknown',
        evidence,
        ownerResult.reason,
        'fail',
      );
      if (owner) {
        repairs.push({
          assertions: [diagnostic.code ? `${diagnostic.code}: ${diagnostic.message}` : diagnostic.message],
          error: evidence.output,
          owner,
          cause: 'compiler',
          diagnostic,
          command,
          sourceRevision: target,
          evidenceLogPath: evidence.logPath,
        });
      }
    }

    for (const diagnostic of independentDiagnostics) {
      saveDiagnosticFinding(
        options,
        check,
        base,
        target,
        diagnostic,
        'unknown',
        evidence,
        'Independent ' + diagnostic.cause + ' evidence; it does not replace any compiler or product result.',
        'infrastructure',
      );
    }

    const attributionDiagnostics: DevVerifierDiagnostic[] = [
      ...(truncatedOutput(evidence.output)
        ? [{ cause: 'product-runtime' as const, message: 'Truncated output prevents complete file-local attribution.' }]
        : []),
      ...(testAttribution.ambiguous
        ? [
            {
              cause: 'product-runtime' as const,
              message: 'Failure output has no reporter-confirmed file-local attribution.',
            },
          ]
        : []),
      ...(testAttribution.unhandled
        ? [{ cause: 'product-runtime' as const, message: 'The test runner reported an unhandled error between tests.' }]
        : []),
    ];
    for (const diagnostic of attributionDiagnostics) {
      saveDiagnosticFinding(
        options,
        check,
        base,
        target,
        diagnostic,
        'unknown',
        evidence,
        'Reporter evidence could not be assigned to a test file. ' + findingProvenance(check, target),
        outcome,
      );
    }

    const fileFailures = testAttribution.outcomes.filter((item) => item.result === 'fail');
    let routedFileFailure = false;
    if (!truncatedOutput(evidence.output)) {
      for (const fileResult of fileFailures) {
        const failureOutputs = fileResult.failureOutputs.filter((output) => !isAuthDatabasePlacementFailure(output));
        const fileAssertions = [
          ...new Set(
            failureOutputs.flatMap((output) => fileFailureAssertions(output, options.settings.policy?.verifier)),
          ),
        ];
        if (setupFailure && fileAssertions.length === 0) continue;
        const fileOutput = failureOutputs.join('\n') || fileResult.output;
        if (!fileResult.resolved || !fileAssertions.length) {
          const diagnostic: DevVerifierDiagnostic = {
            cause: 'product-runtime',
            message:
              fileAssertions.join('\n') || 'The reporter marked this file failed without stable assertion detail.',
            location: { file: fileResult.file, resolved: fileResult.resolved },
          };
          saveDiagnosticFinding(
            options,
            check,
            base,
            target,
            diagnostic,
            'unknown',
            evidence,
            'A reporter outcome was observed but its file or assertion evidence is unresolved. ' +
              findingProvenance(check, target),
            outcome,
          );
          routedFileFailure = true;
          continue;
        }
        if (failureOutputs.length === 0) continue;
        routedFileFailure = true;
        const ownerResult = ownerForTest(options, check, fileResult.file, target, currentRevision);
        const owner = ownerResult.state === 'owned' ? ownerResult.owner : undefined;
        saveFinding(
          options.store,
          makeFinding(
            check,
            base,
            target,
            fileResult.file,
            fileAssertions.join('\n'),
            owner ? 'new' : 'unknown',
            evidence,
            ownerResult.reason + ' ' + findingProvenance(check, target),
            'fail',
            'product-runtime',
          ),
          options.settings.policy?.verifier,
        );
        if (owner)
          repairs.push({
            test: fileResult.file,
            assertions: fileAssertions,
            error: fileOutput,
            owner,
            cause: 'product-runtime',
            command,
            sourceRevision: target,
            evidenceLogPath: evidence.logPath,
          });
      }
    }
    const unattributedAssertions = fileFailureAssertions(evidence.output, options.settings.policy?.verifier);
    if (!routedFileFailure && unattributedAssertions.length && !truncatedOutput(evidence.output)) {
      const diagnostic: DevVerifierDiagnostic = {
        cause: 'product-runtime',
        message: unattributedAssertions.join('\n'),
      };
      saveDiagnosticFinding(
        options,
        check,
        base,
        target,
        diagnostic,
        'unknown',
        evidence,
        'The command contains failure text without a reporter-confirmed failed file; automatic implementation routing was withheld.',
        outcome,
      );
    }

    if (
      !compilerDiagnostics.length &&
      !independentDiagnostics.length &&
      !attributionDiagnostics.length &&
      !unattributedAssertions.length
    ) {
      const cause = causes[0];
      saveFinding(
        options.store,
        makeFinding(
          check,
          base,
          target,
          undefined,
          'The check did not produce a stable, attributable result.',
          'unknown',
          evidence,
          `No concrete diagnostic operand was found. ${findingProvenance(check, target)}`,
          'infrastructure',
          cause,
        ),
        options.settings.policy?.verifier,
      );
    }
  }
  return { testsRun: runs.length, passed, failed, unknown, skipped, repairs: mergeRepeatedNamedTestFailures(repairs) };
}

function saveRoundRecord(options: DevVerifierOptions, summary: DevVerifierRoundSummary): void {
  const result = summary.failed ? 'fail' : summary.unknown ? 'infrastructure' : 'pass';
  const record: DevVerifierRun = {
    key: 'dev-verifier-round:' + summary.startedAt + ':' + (summary.roundId ?? randomUUID()),
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
        skipped: summary.skipped ?? 0,
        durationMs: summary.durationMs,
      }),
      logPath: '',
      result,
    },
    round: summary,
  };
  saveRun(options.store, record, options.settings.policy?.verifier);
}

async function runRound(options: DevVerifierOptions, previous: DevVerifierRun | undefined, captured: string): Promise<void> {
  const { settings } = options;
  const checkout = settings.mainCheckout;
  const roundId = randomUUID();
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
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
  const bootPlan = bootSmokePlan(settings, captured);
  const bootChecks = bootPlan.checks;
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
  const execution = {
    settings,
    store: options.store,
    roundId,
  };
  const skippedCommandRunIds = bootPlan.skipped.map((check) =>
    recordSkippedCommand(
      execution,
      captured,
      roundId,
      check,
      'boot-smoke-skipped:' + captured + ':' + check.command.at(-1),
      `Boot smoke file ${check.command.at(-1)} is not tracked at the captured head.`,
    ),
  );
  let skippedCommandCount = skippedCommandRunIds.length;
  let commandRunIds = [...skippedCommandRunIds];
  let treeAdded = false;
  let counts = { testsRun: 0, passed: 0, failed: 0, unknown: 0, skipped: skippedCommandCount, repairs: [] as TestFailure[] };
  let pendingChecks: Check[] = checks;
  try {
    git(checkout, 'worktree', 'add', '--detach', tree, captured);
    treeAdded = true;
    const installed = installDependenciesCached(execution, captured, tree, dependencySetupKey(settings, captured));
    skippedCommandCount += installed.commandRunIds.filter(
      (id) => options.store.devVerifierRun?.(id)?.execution?.outcome === 'skipped',
    ).length;
    commandRunIds = [...new Set([...commandRunIds, ...installed.commandRunIds])];
    if (!installed.passed) {
      counts = {
        testsRun: checks.length,
        passed: 0,
        failed: 0,
        unknown: checks.length,
        skipped: skippedCommandCount,
        repairs: [],
      };
    } else if (checks.length) {
      const executionResult = await runChecksAtHead(
        options,
        checks,
        captured,
        tree,
        deadline,
        controller.signal,
        bootChecks.length,
        roundId,
      );
      pendingChecks = executionResult.pending;
      const results = recordVerifierResults(options, previousHead, captured, executionResult.results);
      counts = { ...results, skipped: results.skipped + skippedCommandCount };
      commandRunIds = [
        ...new Set([
          ...commandRunIds,
          ...executionResult.results.flatMap((result) => result.evidence.commandRunIds ?? []),
        ]),
      ];
    } else pendingChecks = [];
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort();
    if (treeAdded) git(checkout, 'worktree', 'remove', '--force', tree);
  }

  dispatchTestRepairs(options, counts.repairs, captured);
  const completedAt = new Date().toISOString();
  const summary: DevVerifierRoundSummary = {
    roundId,
    baseCommit: previousHead,
    headCommit: captured,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.now() - startedMs),
    testsRun: counts.testsRun,
    passed: counts.passed,
    failed: counts.failed,
    unknown: counts.unknown,
    skipped: counts.skipped,
    fullSuite,
    commandRunIds,
    pendingChecks,
  };
  saveRoundRecord(options, summary);
  advanceVerified(settings, captured);
}

async function verifyDueRound(options: DevVerifierOptions): Promise<void> {
  const { settings } = options;
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
    const captured = head(settings.mainCheckout, settings.integrationBranch);
    if (!shouldRunRound(previous, captured, Date.now(), policy.roundIntervalMs)) return;
    await runRound(options, previous, captured);
  } catch (error) {
    if (error instanceof LeaseHeldError) return;
    throw error;
  } finally {
    lock.release();
  }
}

/** Run independent owned cycles together; intermediate dev heads never queue. */
export async function verifyDev(options: DevVerifierOptions): Promise<void> {
  const pageData = (async () => {
    await options.runPageData?.();
  })();
  const outcomes = await Promise.allSettled([verifyDueRound(options), pageData]);
  const failures = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Dev verification and page-data both failed');
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
