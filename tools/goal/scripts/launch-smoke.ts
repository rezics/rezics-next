#!/usr/bin/env bun
import { defaultPolicy, readControlPolicy, type ControlPolicy } from '../src/policy.ts';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadSettings, mainCheckout } from '../src/config.ts';
import { parseJsonLines, parseWorkerResult, requireWorkerCheck } from '../test-support/lifecycle-fixture.ts';
import {
  CHECK_ID,
  message,
  requireSmokeWaitingCheckId,
  parseJsonLine,
  parseProviderObject,
  persistReport,
  readReport,
  reportLine,
  resolveSmokeReportPath,
  saveSmokeEvidence,
  smokeTools,
  stepFailure,
  timeoutFailure,
  upsertScenario,
  waitForCheck,
  type Reporter,
  type SmokePolicy,
  type SmokeReport,
} from './launch-smoke-evidence.ts';

export { observeSmokeAdapter, requireSmokeWaitingCheckId, smokeRunSuffix, type SmokeLaunchEvidence } from './launch-smoke-evidence.ts';
export { parseProviderObject, resolveSmokeReportPath, saveSmokeEvidence };

export type SmokeOptions = {
  root?: string;
  report?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  reportPath?: string;
  expectedDevScriptTree?: string;
  parity?: 'deferred' | 'execute';
  scriptsRoot?: string;
  policy?: ControlPolicy;
};



export const SMOKE_ACCEPTANCE_COMMAND = [
  process.execPath,
  '-e',
  'if (process.env.REZICS_LAUNCH_SMOKE_CHECK_MARKER) require("node:fs").appendFileSync(process.env.REZICS_LAUNCH_SMOKE_CHECK_MARKER, "started\\n"); setTimeout(() => console.log("launch smoke check passed"), 100)',
] as const;

/** Produce the unpinned smoke task that production dispatch routes from its configured table. */
export function launchSmokeBrief(workerCheckScript: string, paths = ['tools/goal/scripts/launch-smoke.ts']): string {
  return `---
goal: launch-smoke
kind: specification
paths: ${JSON.stringify(paths)}
riskAreas: []
acceptance:
  command: ${JSON.stringify(SMOKE_ACCEPTANCE_COMMAND)}
  tests: [smoke]
  failing: true
estimate:
  lines: 1
  files: 1
criticalPath: false
waiting: []
---
Run the acceptance command once with the worker-check wrapper's \`--local\` option for this disposable smoke. The wrapper is \`bun ${JSON.stringify(workerCheckScript)}\` if this worktree has no local runner. If that invocation returns a check id before it finishes, use the exact UUID it returned; do not wait before the wrapper has started the check. Do not edit files.
`;
}

/** Owns only a newly created smoke directory, including its disposable immutable dependency store. */
export function createSmokeDirectory(
  root: string,
  prefix: 'launch-smoke-' | 'launch-smoke-workers-' | 'launch-smoke-test-',
) {
  if (prefix !== 'launch-smoke-' && prefix !== 'launch-smoke-workers-' && prefix !== 'launch-smoke-test-')
    throw new Error('Invalid smoke directory prefix');
  const temp = join(realpathSync(root), '.temp');
  mkdirSync(temp, { recursive: true });
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const parent = openSync(temp, flags);
  const descriptorPath = (fd: number) => `/proc/self/fd/${fd}`;
  const sameInode = (left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>) =>
    left.dev === right.dev && left.ino === right.ino;
  let directory: number;
  let path: string;
  try {
    path = join(temp, basename(mkdtempSync(join(descriptorPath(parent), prefix))));
    directory = openSync(join(descriptorPath(parent), basename(path)), flags);
  } catch (error) {
    closeSync(parent);
    throw error;
  }
  let closed = false;
  const assertOwned = () => {
    if (
      realpathSync(temp) !== temp ||
      !sameInode(lstatSync(temp), fstatSync(parent)) ||
      !sameInode(lstatSync(path), fstatSync(directory))
    )
      throw new Error(`Refusing cleanup of replaced smoke directory: ${path}`);
  };
  // The smoke already requires Linux/systemd. Descriptor paths anchor traversal even if an ancestor is renamed;
  // O_NOFOLLOW and inode checks reject replaced directories. Only directory descriptors are ever chmodded.
  const clearDirectory = (fd: number) => {
    const stat = fstatSync(fd);
    if ((stat.mode & 0o700) !== 0o700) fchmodSync(fd, (stat.mode & 0o7777) | 0o700);
    for (const name of readdirSync(descriptorPath(fd))) {
      const child = join(descriptorPath(fd), name);
      const before = lstatSync(child);
      if (before.isDirectory()) {
        const childFd = openSync(child, flags);
        try {
          if (!sameInode(before, fstatSync(childFd))) throw new Error(`Smoke directory changed: ${child}`);
          clearDirectory(childFd);
          if (!sameInode(before, lstatSync(child))) throw new Error(`Smoke directory changed: ${child}`);
          rmdirSync(child);
        } finally {
          closeSync(childFd);
        }
      } else {
        // Unlink files and symlinks without changing their modes or following their targets, including hardlinks.
        unlinkSync(child);
      }
    }
  };
  return {
    path,
    remove() {
      if (closed) return;
      try {
        assertOwned();
        clearDirectory(directory);
        assertOwned();
        rmdirSync(join(descriptorPath(parent), basename(path)));
      } finally {
        closed = true;
        closeSync(directory);
        closeSync(parent);
      }
    },
  };
}

function fakeStep(
  agent: string,
  step: string,
  env: NodeJS.ProcessEnv,
  policy: SmokePolicy,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(agent, [step], {
    encoding: 'utf8',
    env,
    timeout: policy.fakeCommandTimeoutMs,
    maxBuffer: policy.outputBytes,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Fake-agent seam for the fast protocol tests. The train invokes the real lifecycle suite. */
export async function runLaunchSmoke(agent?: string, options: SmokeOptions = {}): Promise<void> {
  const root = resolve(options.root ?? resolve(import.meta.dir, '../../..'));
  const report = options.report ?? reportLine;
  if (agent) return runFakeSmoke(agent, root, report, options.env ?? {}, options.policy ?? defaultPolicy);
  if (options.parity === 'execute' && !options.scriptsRoot)
    throw new Error('Explicit parity execution requires --scripts-root <delivered-dev-checkout>');
  return runRealSmoke(root, report, options.reportPath, options.expectedDevScriptTree, options);
}

async function runFakeSmoke(
  agent: string,
  root: string,
  report: Reporter,
  suppliedEnv: NodeJS.ProcessEnv,
  startupPolicy: ControlPolicy,
): Promise<void> {
  const policy = startupPolicy.launchSmoke;
  const { git, checked, message, stepFailure } = smokeTools(policy);
  const { path: directory, remove } = createSmokeDirectory(root, 'launch-smoke-test-');
  let checkId = '';
  const session = 'launch-smoke-fake-session';
  let resultPath = '';
  let clone = '';
  let devTree = '';
  let devWorktreeAdded = false;
  const passed: string[] = [];
  const baseEnv = {
    ...process.env,
    ...suppliedEnv,
    REZICS_SMOKE_CHECK_ID: checkId,
    REZICS_SMOKE_SESSION: session,
    REZICS_SMOKE_RESULT: resultPath,
  };
  try {
    try {
      // Control-plane candidates do not carry the check runner. Exercise the version on dev, as the real smoke does.
      const sourceRoot = mainCheckout(root);
      // The fake-agent path uses package defaults and must not depend on operator-local account notes or pool data.
      const localFile = join(directory, 'local.json');
      writeFileSync(localFile, `${JSON.stringify({ version: 1, pools: [] })}\n`);
      const sourceSettings = loadSettings({ cwd: root, localFile });
      git(directory, 'init', '--quiet');
      clone = join(directory, 'repository');
      const cloned = spawnSync('git', ['clone', '--shared', '--no-checkout', sourceRoot, clone], {
        cwd: root,
        encoding: 'utf8',
        timeout: policy.commandTimeoutMs,
        maxBuffer: policy.outputBytes,
      });
      if (cloned.status !== 0)
        throw new Error(cloned.stderr?.trim() || cloned.error?.message || `git clone exited ${cloned.status}`);
      const devRef = `refs/heads/${sourceSettings.integrationBranch}`;
      const remoteDev = `refs/remotes/origin/${sourceSettings.integrationBranch}`;
      try {
        git(clone, 'rev-parse', '--verify', `${remoteDev}^{commit}`);
      } catch {
        git(clone, 'fetch', '--quiet', sourceRoot, `${devRef}:${remoteDev}`);
      }
      devTree = join(directory, 'dev');
      git(clone, 'worktree', 'add', '--detach', devTree, remoteDev);
      devWorktreeAdded = true;
      const workerCheckScript = requireWorkerCheck(join(devTree, 'scripts/worker-check.ts'));

      // The fake agent protocol still receives a real worker-check UUID and result record.
      const started = checked(
        process.execPath,
        [
          workerCheckScript,
          '--local',
          '--',
          process.execPath,
          '-e',
          'process.exit(Number(process.env.REZICS_SMOKE_CHECK_EXIT ?? 0))',
        ],
        directory,
        policy.commandTimeoutMs,
        {
          ...process.env,
          ...suppliedEnv,
          REZICS_CHECK_MEMORY: 'off',
        },
      );
      checkId = /check: id ([0-9a-f-]{36})/.exec(started)?.[1] ?? '';
      if (!CHECK_ID.test(checkId)) throw new Error('worker-check did not return a real check id');
      const startedCheckId = checkId;
      resultPath = join(directory, '.temp/goal/checks/results', `${checkId}.json`);
      baseEnv.REZICS_SMOKE_CHECK_ID = checkId;
      baseEnv.REZICS_SMOKE_RESULT = resultPath;
      const start = fakeStep(agent, 'start', baseEnv, policy);
      if (start.error || start.status !== 0)
        throw new Error(start.stderr || start.error?.message || `exit ${start.status}`);
      let waiting: Record<string, unknown> | undefined;
      try {
        waiting = parseJsonLine(start.stdout, 'start');
      } catch {
        const legacy = /^waiting (worker-check-[\w-]+)$/.exec(start.stdout.trim());
        if (!legacy) throw new Error('expected a waiting exit with its check id');
        checkId = legacy[1]!;
        baseEnv.REZICS_SMOKE_CHECK_ID = checkId;
      }
      if (waiting) {
        if (waiting.status !== 'waiting' || waiting.session !== session)
          throw new Error('expected a waiting exit for the same session');
        checkId = requireSmokeWaitingCheckId(waiting.checks);
        baseEnv.REZICS_SMOKE_CHECK_ID = checkId;
        if (checkId !== startedCheckId) throw new Error('fake agent did not return the real worker-check id');
      } else if (!/^worker-check-[\w-]+$/.test(checkId)) {
        throw new Error('fake worker-check id has an invalid shape');
      }
      passed.push('start: passed');
    } catch (error) {
      throw stepFailure('start', error, report);
    }

    try {
      const result = await waitForCheck(resultPath, Date.now() + policy.checkWaitMs, policy);
      if (result.status !== 'finished' || result.exitCode !== 0) throw new Error('worker-check result did not pass');
      const wake = fakeStep(agent, 'wake', baseEnv, policy);
      if (wake.error || wake.status !== 0) throw new Error(wake.stderr || wake.error?.message || `exit ${wake.status}`);
      if (!wake.stdout.includes('result passed')) throw new Error('wake did not receive the passing check result');
      passed.push('wake: passed');
    } catch (error) {
      throw stepFailure('wake', error, report);
    }

    try {
      const success = fakeStep(agent, 'success', baseEnv, policy);
      if (success.error || success.status !== 0)
        throw new Error(success.stderr || success.error?.message || `exit ${success.status}`);
      let status = '';
      try {
        status = String(parseJsonLine(success.stdout, 'success').status ?? '');
      } catch {
        status = success.stdout.trim();
      }
      if (status !== 'success') throw new Error('expected a success exit');
      passed.push('success: passed');
      for (const line of passed) report(line);
    } catch (error) {
      throw stepFailure('success', error, report);
    }
  } finally {
    if (resultPath) await waitForCheck(resultPath, Date.now() + policy.checkWaitMs, policy).catch(() => {});
    if (clone && devTree && devWorktreeAdded) {
      try {
        checked('git', ['worktree', 'remove', '--force', devTree], clone, policy.worktreeCleanupTimeoutMs);
      } catch {
        /* The disposable clone is removed below. */
      }
    }
    remove();
  }
}

async function runRealSmoke(
  root: string,
  report: Reporter,
  requestedReportPath?: string,
  expectedDevScriptTree?: string,
  options: SmokeOptions = {},
): Promise<void> {
  const sourceSettings = loadSettings({ cwd: root });
  const startupPolicy = options.policy ?? sourceSettings.policy ?? defaultPolicy;
  const policy = startupPolicy.launchSmoke;
  const { git, checked, message, stepFailure } = smokeTools(policy);
  let currentStep = 'candidate';
  const startedAt = Date.now();
  const deadline = startedAt + policy.budgetMs;
  const reportPath = resolveSmokeReportPath(root, requestedReportPath);
  const runId = randomUUID();
  const runEvidenceDirectory = join(root, '.temp/launch-smoke-evidence');
  mkdirSync(runEvidenceDirectory, { recursive: true });
  const runEvidencePath = join(runEvidenceDirectory, `${runId}.json`);
  let candidate: string | undefined;
  let failed = false;
  const evidence: SmokeReport = {
    version: 1,
    status: 'running',
    startedAt: new Date(startedAt).toISOString(),
    scenarios: [],
    incidents: [],
    suiteRegressions: [],
  };
  let temporary = '';
  let workerRoot = '';
  let removeTemporary: (() => void) | undefined;
  let removeWorkerRoot: (() => void) | undefined;
  let clone = '';
  let tree = '';
  let devTree = '';
  let branch = '';
  let worktreeAdded = false;
  let devWorktreeAdded = false;
  const saveRunEvidence = (extra: Record<string, unknown> = {}) => {
    let previous: Record<string, unknown> = {};
    try {
      if (existsSync(runEvidencePath)) {
        const value: unknown = JSON.parse(readFileSync(runEvidencePath, 'utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value)) previous = value as Record<string, unknown>;
      }
    } catch {
      // Replace an incomplete prior write with the current bounded facts.
    }
    saveSmokeEvidence(
      runEvidencePath,
      {
        ...previous,
        runId,
        candidate,
        startedAt: new Date(startedAt).toISOString(),
        stage: currentStep,
        ...extra,
      },
      policy,
    );
  };
  persistReport(root, reportPath, evidence);
  saveRunEvidence();
  report(`evidence: ${reportPath}`);
  report(`run evidence: ${runEvidencePath}`);
  try {
    const candidateHead = git(root, 'rev-parse', 'HEAD');
    candidate = candidateHead;
    evidence.candidate = candidateHead;
    persistReport(root, reportPath, evidence);
    saveRunEvidence();
    git(root, 'diff', '--quiet', 'HEAD', '--');
    const sourceRoot = mainCheckout(root);
    if (sourceSettings.codex.serviceTier.trim().toLowerCase() === 'fast')
      throw new Error('Codex service tier is Fast; launch smoke only permits the configured non-Fast tier');
    const disposable = createSmokeDirectory(root, 'launch-smoke-');
    temporary = disposable.path;
    removeTemporary = disposable.remove;
    const disposableWorkerRoot = createSmokeDirectory(root, 'launch-smoke-workers-');
    workerRoot = disposableWorkerRoot.path;
    removeWorkerRoot = disposableWorkerRoot.remove;
    clone = join(temporary, 'repository');
    tree = join(temporary, 'candidate');
    const cloneResult = spawnSync('git', ['clone', '--shared', '--no-checkout', sourceRoot, clone], {
      cwd: root,
      encoding: 'utf8',
      timeout: policy.cloneTimeoutMs,
      maxBuffer: policy.outputBytes,
    });
    if (cloneResult.status !== 0)
      throw new Error(
        cloneResult.stderr?.trim() || cloneResult.error?.message || `git clone exited ${cloneResult.status}`,
      );
    const devRef = `refs/heads/${sourceSettings.integrationBranch}`;
    const remoteDev = `refs/remotes/origin/${sourceSettings.integrationBranch}`;
    try {
      git(clone, 'rev-parse', '--verify', `${remoteDev}^{commit}`);
    } catch {
      git(clone, 'fetch', '--quiet', sourceRoot, `${devRef}:${remoteDev}`);
    }
    const devScriptTree = git(clone, 'rev-parse', `${remoteDev}^{commit}`);
    if (expectedDevScriptTree && expectedDevScriptTree !== devScriptTree)
      throw new Error(
        `dev script tree changed before lifecycle validation: expected ${expectedDevScriptTree}, found ${devScriptTree}`,
      );
    evidence.devScriptTree = devScriptTree;
    persistReport(root, reportPath, evidence);
    devTree = join(temporary, 'dev');
    git(clone, 'worktree', 'add', '--detach', devTree, remoteDev);
    devWorktreeAdded = true;
    git(clone, 'worktree', 'add', '--detach', tree, remoteDev);
    worktreeAdded = true;
    git(tree, 'merge', '--no-edit', '--no-ff', candidate);
    branch = `launch-smoke/${randomUUID()}`;
    git(tree, 'switch', '-c', branch);
    report('candidate: passed');

    currentStep = 'start';
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('smoke budget exhausted during setup');
    const { runInnerProcess } = await import('./launch-smoke-scenarios.ts');
    await runInnerProcess(
      tree,
      {
        ...process.env,
        REZICS_LAUNCH_SMOKE_TREE: tree,
        REZICS_LAUNCH_SMOKE_CLONE: clone,
        REZICS_LAUNCH_SMOKE_SOURCE_ROOT: sourceRoot,
        REZICS_LAUNCH_SMOKE_LOCAL_FILE: sourceSettings.localFile,
        REZICS_LAUNCH_SMOKE_BRANCH: branch,
        REZICS_LAUNCH_SMOKE_WORKER_CHECK: join(devTree, 'scripts/worker-check.ts'),
        REZICS_LAUNCH_SMOKE_STATE: join(temporary, 'state'),
        REZICS_LAUNCH_SMOKE_WORKTREES: workerRoot,
        REZICS_LAUNCH_SMOKE_DEADLINE: String(deadline),
        REZICS_LAUNCH_SMOKE_POLICY: JSON.stringify(startupPolicy),
        REZICS_LAUNCH_SMOKE_REPORT_PATH: reportPath,
        REZICS_LAUNCH_SMOKE_EVIDENCE: runEvidencePath,
        REZICS_LAUNCH_SMOKE_RUN_ID: runId,
        REZICS_LAUNCH_SMOKE_CANDIDATE: candidate,
      },
      Math.max(1, remaining + policy.innerOverheadMs),
      report,
      policy,
    );
    const completed = readReport(reportPath);
    if (completed.status !== 'passed')
      throw new Error('inner lifecycle suite exited without complete passing evidence');
    const { gateParityScenario } = await import('../test-support/lifecycle-scenarios.ts');
    const parity = await gateParityScenario({
      policy: startupPolicy,
      root,
      ...(options.scriptsRoot ? { scriptsRoot: options.scriptsRoot } : {}),
      execute: options.parity === 'execute',
      report,
    });
    upsertScenario(completed, parity);
    persistReport(root, reportPath, completed);
    if (options.parity === 'execute' && parity.status !== 'passed')
      throw new Error(`lifecycle regressions: failed: ${parity.detail}`);
    const scenarioEvidence = completed.scenarios.map(({ id, status }) => `${id}:${status}`).join(',');
    const regressionEvidence = completed.suiteRegressions.map(({ id, status }) => `${id}:${status}`).join(',');
    if (!scenarioEvidence || !regressionEvidence)
      throw new Error('inner lifecycle suite omitted named scenario or regression evidence');
    report(
      `release evidence: candidate=${candidate} dev-script-tree=${devScriptTree} ` +
        `scenarios=${scenarioEvidence} lifecycle-regressions=${regressionEvidence}`,
    );
    saveRunEvidence({ status: 'passed', completedAt: new Date().toISOString() });
    report(`evidence: ${reportPath}`);
  } catch (error) {
    const detail = message(error);
    failed = true;
    const reportedStep = /^(candidate|setup|start|wake|success|lifecycle regressions): failed:/.exec(detail)?.[1];
    if (reportedStep) currentStep = reportedStep;
    try {
      const current = existsSync(reportPath) ? readReport(reportPath) : evidence;
      current.status = timeoutFailure(error) ? 'unverified' : 'failed';
      current.finishedAt = new Date().toISOString();
      current.failure = {
        step: currentStep,
        detail,
        classification: timeoutFailure(error) ? 'infrastructure/unverified' : 'failure',
      };
      upsertScenario(current, {
        id: `smoke-step-${currentStep.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        status: current.status === 'unverified' ? 'unverified' : 'failed',
        detail,
      });
      persistReport(root, reportPath, current);
    } catch {
      // Keep the original smoke failure as the actionable error.
    }
    try {
      saveRunEvidence({ failure: detail, failedAt: new Date().toISOString() });
    } catch (evidenceError) {
      report(`run evidence: failed: ${message(evidenceError)}`);
    }
    if (reportedStep) throw new Error(detail);
    throw stepFailure(currentStep, error, report);
  } finally {
    if (temporary) cleanupSmokeScopes(join(temporary, 'state/systemd-bin/systemd-run-argv.jsonl'), policy);
    if (clone && tree && worktreeAdded) {
      try {
        checked('git', ['worktree', 'remove', '--force', tree], clone, policy.worktreeCleanupTimeoutMs);
      } catch {
        /* The disposable repository is removed below. */
      }
    }
    if (clone && branch) {
      try {
        checked('git', ['branch', '-D', branch], clone, policy.worktreeCleanupTimeoutMs);
      } catch {
        /* The disposable repository is removed below. */
      }
    }
    if (clone && devTree && devWorktreeAdded) {
      try {
        checked('git', ['worktree', 'remove', '--force', devTree], clone, policy.worktreeCleanupTimeoutMs);
      } catch {
        /* The disposable repository is removed below. */
      }
    }
    const cleanupErrors: string[] = [];
    for (const [label, remove, path] of [
      ['worker data', removeWorkerRoot, workerRoot],
      ['disposable data', removeTemporary, temporary],
    ] as const) {
      if (!remove) continue;
      try {
        remove();
      } catch (error) {
        const detail = `cleanup: retained ${label} at ${path}: ${message(error)}`;
        cleanupErrors.push(detail);
        report(detail);
      }
    }
    if (cleanupErrors.length) {
      try {
        saveRunEvidence({ cleanupErrors, cleanupFailedAt: new Date().toISOString() });
      } catch (evidenceError) {
        report(`run evidence: failed: ${message(evidenceError)}`);
      }
      if (!failed) {
        const detail = cleanupErrors[0]!;
        try {
          const current = existsSync(reportPath) ? readReport(reportPath) : evidence;
          current.status = 'failed';
          current.finishedAt = new Date().toISOString();
          current.failure = { step: 'cleanup', detail, classification: 'failure' };
          upsertScenario(current, { id: 'smoke-step-cleanup', status: 'failed', detail });
          persistReport(root, reportPath, current);
        } catch {
          // Report the owned cleanup failure even if the lifecycle evidence cannot be updated.
        }
        throw new Error(detail);
      }
    }
  }
}

function cleanupSmokeScopes(path: string, policy: SmokePolicy): void {
  if (!existsSync(path)) return;
  let calls: string[][];
  try {
    calls = parseJsonLines<string[]>(path);
  } catch {
    return;
  }
  const units = new Set(
    calls.flatMap((args) => {
      const unit = args.find((value) => value.startsWith('--unit='))?.slice('--unit='.length);
      return unit?.startsWith('rezics-worker-') ? [unit] : [];
    }),
  );
  for (const unit of units)
    spawnSync('systemctl', ['--user', 'stop', unit], {
      encoding: 'utf8',
      timeout: policy.scopeCleanupTimeoutMs,
      maxBuffer: policy.outputBytes,
    });
}

export function parseSmokeArguments(args: string[]): SmokeOptions {
  const options: SmokeOptions = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === '--report') {
      const path = args[++index];
      if (!path) throw new Error('--report requires a path');
      if (options.reportPath) throw new Error('--report can be supplied only once');
      options.reportPath = path;
    } else if (value === '--expected-dev-script-tree') {
      const tree = args[++index];
      if (!tree) throw new Error('--expected-dev-script-tree requires a commit');
      if (options.expectedDevScriptTree) throw new Error('--expected-dev-script-tree can be supplied only once');
      options.expectedDevScriptTree = tree;
    } else if (value === '--scripts-root') {
      const root = args[++index];
      if (!root || root.startsWith('--')) throw new Error('--scripts-root requires a checkout');
      if (options.scriptsRoot) throw new Error('--scripts-root can be supplied only once');
      options.scriptsRoot = resolve(root);
    } else if (value === '--parity') {
      const mode = args[++index];
      if (mode !== 'deferred' && mode !== 'execute') throw new Error('--parity requires deferred or execute');
      if (options.parity) throw new Error('--parity can be supplied only once');
      options.parity = mode;
    } else throw new Error(`unknown launch-smoke argument: ${value}`);
  }
  return options;
}

export async function main(runSmoke?: () => Promise<void>, policyOverride?: ControlPolicy): Promise<number> {
  let startupPolicy = policyOverride ?? defaultPolicy;
  try {
    if (!runSmoke)
      startupPolicy =
        policyOverride ??
        (process.env.REZICS_LAUNCH_SMOKE_POLICY
          ? readControlPolicy(JSON.parse(process.env.REZICS_LAUNCH_SMOKE_POLICY))
          : (loadSettings().policy ?? defaultPolicy));
    if (process.argv.includes('--inner')) {
      const { runInnerSmoke } = await import('./launch-smoke-scenarios.ts');
      await runInnerSmoke(reportLine, launchSmokeBrief);
    }
    else if (runSmoke) await runSmoke();
    else await runLaunchSmoke(undefined, { ...parseSmokeArguments(process.argv.slice(2)), policy: startupPolicy });
    return 0;
  } catch (error) {
    const detail = message(error, startupPolicy.launchSmoke);
    if (/^(?:candidate|setup|start|wake|success|lifecycle regressions): failed:/.test(detail)) return 1;
    if (process.argv.includes('--inner')) reportLine(`setup: failed: ${detail}`);
    else process.stderr.write(`launch-smoke: ${detail}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
