#!/usr/bin/env bun
import { scriptPolicy, withScriptPolicy } from '../src/script-policy.ts';
import { defaultPolicy, type ControlPolicy } from '../src/policy.ts';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  assertCandidateIntegrity,
  controlPlaneChecks,
  failingTestFiles,
  runIntegrationChecks,
} from '../src/merge-train.ts';
import { gateRunner, type GateResult, type GateRunner } from '../src/merge.ts';
import { loadSettings, mainCheckout } from '../src/config.ts';

type GitResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type CandidateSnapshot = {
  head: string;
  status: string[];
  tracked: string[];
  staged: string[];
  unstaged: string[];
  untracked: string[];
};

function git(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: scriptPolicy().candidateProbe.gitBufferBytes,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function gitText(cwd: string, ...args: string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0 || result.signal || result.error)
    throw new Error(`git ${args.join(' ')} failed: ${gitDetails(result)}`);
  return result.stdout.trim();
}

function gitDetails(result: GitResult): string {
  const bounded = (value: string) =>
    JSON.stringify(value.replace(/[\r\n\t]+/g, ' ').slice(0, scriptPolicy().candidateProbe.gitDetailCharacters));
  return [
    `exit=${result.status === null ? 'null' : result.status}`,
    `signal=${result.signal ?? 'none'}`,
    ...(result.error ? [`error=${bounded(result.error)}`] : []),
    ...(result.stderr ? [`stderr=${bounded(result.stderr)}`] : []),
  ].join(' ');
}

function paths(result: GitResult): string[] {
  if (result.status !== 0 || result.signal || result.error)
    throw new Error(`candidate Git query failed: ${gitDetails(result)}`);
  return result.stdout.split('\0').filter(Boolean);
}

function statusPaths(result: GitResult): string[] {
  if (result.status !== 0 || result.signal || result.error)
    throw new Error(`candidate Git status failed: ${gitDetails(result)}`);
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => (entry.length >= 4 ? entry.slice(3) : entry));
}

function boundedPaths(values: readonly string[]): string[] {
  return [
    ...values.slice(0, scriptPolicy().candidateProbe.paths),
    ...(values.length > scriptPolicy().candidateProbe.paths
      ? [`… ${values.length - scriptPolicy().candidateProbe.paths} omitted`]
      : []),
  ];
}

function sanitizedDetail(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/(token|password|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, scriptPolicy().candidateProbe.diagnosticCharacters);
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('GOAL_') && name !== 'CODEX_THREAD_ID' && name !== 'KERNEL_CHECK_REMOTE',
    ),
  );
}

function takeSnapshot(cwd: string, phase: string, evidencePath: string): CandidateSnapshot {
  const queryResults = {
    head: git(cwd, ['rev-parse', 'HEAD']),
    status: git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    tracked: git(cwd, ['diff', '--name-only', '-z', 'HEAD', '--']),
    staged: git(cwd, ['diff', '--cached', '--name-only', '-z', 'HEAD', '--']),
    unstaged: git(cwd, ['diff', '--name-only', '-z', '--']),
    untracked: git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  };
  const failures = Object.entries(queryResults)
    .filter(([, result]) => result.status !== 0 || result.signal || result.error)
    .map(([name, result]) => `${name}: ${gitDetails(result)}`);
  const snapshot: CandidateSnapshot = {
    head: queryResults.head.status === 0 ? queryResults.head.stdout.trim() : '(unavailable)',
    status: queryResults.status.status === 0 ? boundedPaths(statusPaths(queryResults.status)) : ['(unavailable)'],
    tracked: queryResults.tracked.status === 0 ? paths(queryResults.tracked) : ['(unavailable)'],
    staged: queryResults.staged.status === 0 ? paths(queryResults.staged) : ['(unavailable)'],
    unstaged: queryResults.unstaged.status === 0 ? paths(queryResults.unstaged) : ['(unavailable)'],
    untracked: queryResults.untracked.status === 0 ? paths(queryResults.untracked) : ['(unavailable)'],
  };
  appendFileSync(
    evidencePath,
    `${JSON.stringify({
      type: 'candidate-snapshot',
      phase,
      snapshot: {
        ...snapshot,
        status: boundedPaths(snapshot.status),
        tracked: boundedPaths(snapshot.tracked),
        staged: boundedPaths(snapshot.staged),
        unstaged: boundedPaths(snapshot.unstaged),
        untracked: boundedPaths(snapshot.untracked),
      },
      git: Object.fromEntries(Object.entries(queryResults).map(([name, result]) => [name, gitDetails(result)])),
      ...(failures.length ? { failures } : {}),
    })}\n`,
  );
  if (failures.length) throw new Error(`Candidate Git infrastructure failure during ${phase}: ${failures.join('; ')}`);
  return snapshot;
}

function assertNoOutsideTempUntracked(snapshot: CandidateSnapshot, phase: string): void {
  const outside = snapshot.untracked.filter((path) => path !== '.temp' && !path.startsWith('.temp/'));
  if (outside.length)
    throw new Error(
      `Candidate produced untracked paths outside .temp during ${phase}: ${JSON.stringify(boundedPaths(outside))}`,
    );
}

function boundary(cwd: string, expected: string, phase: string, evidencePath: string): CandidateSnapshot {
  const snapshot = takeSnapshot(cwd, phase, evidencePath);
  assertCandidateIntegrity(cwd, expected, phase, evidencePath, undefined, scriptPolicy().integration);
  assertNoOutsideTempUntracked(snapshot, phase);
  return snapshot;
}

function logEvent(evidencePath: string, value: Record<string, unknown>): void {
  appendFileSync(evidencePath, `${JSON.stringify(value)}\n`);
}

function installIsolatedLocalConfig(sourceRoot: string, candidateRoot: string, isolatedState: string): void {
  const env = safeEnvironment();
  const sourceSettings = loadSettings({ cwd: sourceRoot, env });
  const originalLocal = existsSync(sourceSettings.localFile)
    ? (JSON.parse(readFileSync(sourceSettings.localFile, 'utf8')) as Record<string, unknown>)
    : {};
  const integration =
    originalLocal.integration &&
    typeof originalLocal.integration === 'object' &&
    !Array.isArray(originalLocal.integration)
      ? (originalLocal.integration as Record<string, unknown>)
      : {};
  const root = resolve(candidateRoot);
  const state = resolve(isolatedState);
  const isolated = {
    ...originalLocal,
    mainCheckout: root,
    stateDirectory: state,
    worktreeRoot: join(root, '.temp/worktrees'),
    integration: {
      ...integration,
      managerDirectory: join(state, 'managers'),
      inboxDirectory: join(state, 'inboxes'),
      managerSocket: join(state, 'manager.sock'),
      tmuxSocket: join(state, 'tmux.sock'),
    },
  };
  const localPath = join(root, '.temp/goal/local.json');
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, JSON.stringify(isolated));
  mkdirSync(state, { recursive: true });
  const remoteHosts = join(sourceSettings.stateDirectory, 'remote-check-hosts.json');
  const copiedHosts = join(state, 'remote-check-hosts.json');
  if (existsSync(remoteHosts) && resolve(remoteHosts) !== resolve(copiedHosts)) copyFileSync(remoteHosts, copiedHosts);
}

function outputInfo(result: GateResult): { passed: boolean; timedOut: boolean; bytes: number; sha256: string } {
  return {
    passed: result.passed,
    timedOut: result.timedOut,
    bytes: Buffer.byteLength(result.output),
    sha256: createHash('sha256').update(result.output).digest('hex'),
  };
}

function instrumentedGate(
  execute: GateRunner,
  expected: string,
  evidencePath: string,
  phase: string,
  options: { deferIntegrity?: boolean } = {},
): { run: GateRunner; infraErrors: string[] } {
  const infraErrors: string[] = [];
  const run: GateRunner = async (command, cwd, logPath) => {
    const name = command.join(' ');
    takeSnapshot(cwd, `${phase}: before ${name}`, evidencePath);
    logEvent(evidencePath, { type: 'command-start', phase, command: [...command] });
    let result: GateResult;
    try {
      result = await execute(command, cwd, logPath);
    } catch (error) {
      const detail = sanitizedDetail(error);
      infraErrors.push(`${name}: ${detail}`);
      logEvent(evidencePath, { type: 'command-infrastructure-failure', phase, command: [...command], detail });
      takeSnapshot(cwd, `${phase}: after infrastructure failure ${name}`, evidencePath);
      if (!options.deferIntegrity) boundary(cwd, expected, `${phase}: ${name}`, evidencePath);
      return { passed: false, output: detail, timedOut: false };
    }
    const info = outputInfo(result);
    logEvent(evidencePath, { type: 'command-result', phase, command: [...command], ...info });
    takeSnapshot(cwd, `${phase}: after ${name}`, evidencePath);
    if (!options.deferIntegrity) boundary(cwd, expected, `${phase}: ${name}`, evidencePath);
    return result;
  };
  return { run, infraErrors };
}

async function runCommands(
  commands: readonly (readonly string[])[],
  cwd: string,
  commandLogPath: string,
  evidencePath: string,
  runner: GateRunner,
  label: string,
): Promise<Awaited<ReturnType<typeof runIntegrationChecks>>> {
  const result = await runIntegrationChecks(commands, cwd, commandLogPath, runner);
  logEvent(evidencePath, {
    type: 'check-group-result',
    phase: label,
    passed: result.passed,
    timedOut: result.timedOut,
    ...(result.failedCommand ? { failedCommand: [...result.failedCommand] } : {}),
    failedFiles: failingTestFiles(result.output),
  });
  return result;
}

async function compareSuiteFailures(
  result: Awaited<ReturnType<typeof runIntegrationChecks>>,
  candidateRoot: string,
  candidateHead: string,
  base: string,
  clone: string,
  isolatedState: string,
  evidencePath: string,
  checkLog: string,
): Promise<boolean> {
  const suite = controlPlaneChecks(scriptPolicy().controlPlane).at(-1)!;
  if (result.passed || result.timedOut || JSON.stringify(result.failedCommand) !== JSON.stringify(suite))
    return result.passed;

  const files = failingTestFiles(result.output);
  if (!files.length) {
    logEvent(evidencePath, { type: 'suite-failure-comparison', result: 'no failing files could be parsed' });
    return false;
  }

  const candidateRunner = instrumentedGate(
    gateRunner(scriptPolicy().controlPlane.checkTimeoutMs, isolatedState, undefined, undefined, scriptPolicy().merge),
    candidateHead,
    evidencePath,
    'candidate failing-file reruns',
  );
  const branchFailures: { file: string; output: string }[] = [];
  for (const file of files) {
    const one = await runCommands(
      [['bun', 'test', '--timeout', String(scriptPolicy().controlPlane.testTimeoutMs), file]],
      candidateRoot,
      checkLog,
      evidencePath,
      candidateRunner.run,
      `candidate failing-file rerun ${file}`,
    );
    if (candidateRunner.infraErrors.length)
      throw new Error(`Candidate rerun command infrastructure failure: ${candidateRunner.infraErrors.join('; ')}`);
    if (!one.passed) branchFailures.push({ file, output: one.output });
  }
  if (!branchFailures.length) {
    logEvent(evidencePath, { type: 'suite-failure-comparison', result: 'all failing files passed alone' });
    return true;
  }

  const baselineRoot = join(dirname(candidateRoot), 'base');
  const baselineState = join(baselineRoot, '.temp/goal/candidate-probe-state');
  const baselineLog = join(baselineState, 'checks.log');
  const added = git(clone, ['worktree', 'add', '--detach', baselineRoot, base]);
  if (added.status !== 0 || added.error || added.signal)
    throw new Error(`Could not create isolated base worktree: ${gitDetails(added)}`);
  let baselineClean = false;
  try {
    installIsolatedLocalConfig(clone, baselineRoot, baselineState);
    boundary(baselineRoot, base, 'base initial checkout', evidencePath);
    const baselineRunner = instrumentedGate(
      gateRunner(scriptPolicy().controlPlane.checkTimeoutMs, baselineState, undefined, undefined, scriptPolicy().merge),
      base,
      evidencePath,
      'base comparison installs',
    );
    const installs = await runCommands(
      controlPlaneChecks(scriptPolicy().controlPlane).slice(0, 2),
      baselineRoot,
      baselineLog,
      evidencePath,
      baselineRunner.run,
      'base comparison installs',
    );
    if (baselineRunner.infraErrors.length)
      throw new Error(`Base install command infrastructure failure: ${baselineRunner.infraErrors.join('; ')}`);
    boundary(baselineRoot, base, 'base comparison after installs', evidencePath);
    if (!installs.passed) {
      baselineClean = true;
      return false;
    }

    const baselineFailures: string[] = [];
    for (const failure of branchFailures) {
      const filePath = join(baselineRoot, failure.file);
      if (!existsSync(filePath)) {
        baselineFailures.push(failure.file);
        continue;
      }
      const runner = instrumentedGate(
        gateRunner(
          scriptPolicy().controlPlane.checkTimeoutMs,
          baselineState,
          undefined,
          undefined,
          scriptPolicy().merge,
        ),
        base,
        evidencePath,
        `base test ${failure.file}`,
      );
      const baseline = await runCommands(
        [['bun', 'test', '--timeout', String(scriptPolicy().controlPlane.testTimeoutMs), failure.file]],
        baselineRoot,
        baselineLog,
        evidencePath,
        runner.run,
        `base test ${failure.file}`,
      );
      if (runner.infraErrors.length)
        throw new Error(`Base test command infrastructure failure: ${runner.infraErrors.join('; ')}`);
      if (baseline.passed) baselineFailures.push(failure.file);
    }
    boundary(baselineRoot, base, 'base comparison complete', evidencePath);
    baselineClean = true;
    const introduced = baselineFailures;
    logEvent(evidencePath, {
      type: 'suite-failure-comparison',
      result: introduced.length ? 'candidate failures differ from base' : 'candidate failures also occur on base',
      candidateFailingFiles: branchFailures.map(({ file }) => file),
      basePassingFiles: introduced,
    });
    return introduced.length === 0;
  } finally {
    if (baselineClean) {
      const removed = git(clone, ['worktree', 'remove', '--force', baselineRoot]);
      if (removed.status !== 0 || removed.error || removed.signal)
        logEvent(evidencePath, { type: 'cleanup-warning', worktree: baselineRoot, detail: gitDetails(removed) });
    }
  }
}

export async function runCandidateCleanlinessProbe(
  root = resolve(import.meta.dir, '../../..'),
  policy?: ControlPolicy,
): Promise<void> {
  const sourceSettings = loadSettings({ cwd: resolve(root), env: safeEnvironment() });
  return withScriptPolicy(policy ?? sourceSettings.policy ?? defaultPolicy, () => runCandidateProbe(root));
}

async function runCandidateProbe(root: string): Promise<void> {
  const worktreeRoot = resolve(root);
  const sourceRoot = mainCheckout(worktreeRoot);
  const sourceHead = gitText(worktreeRoot, 'rev-parse', 'HEAD');
  const sourceSettings = loadSettings({ cwd: worktreeRoot, env: safeEnvironment() });
  const sourceRefs = Object.fromEntries(
    ['main', 'dev', 'stabilize'].map((name) => [
      name,
      gitText(sourceRoot, 'rev-parse', '--verify', `refs/heads/${name}`),
    ]),
  );
  const metadata = {
    sourceRoot,
    sourceHead,
    sourceRefs,
    integrationBranch: sourceSettings.integrationBranch,
    sourceTreeStatus: gitText(worktreeRoot, 'status', '--porcelain=v1'),
  };
  if (metadata.sourceTreeStatus)
    throw new Error(
      `Probe source worktree must be clean before cloning candidate: ${metadata.sourceTreeStatus.slice(0, scriptPolicy().candidateProbe.statusCharacters)}`,
    );

  const evidenceDirectory = join(worktreeRoot, '.temp/goal');
  mkdirSync(evidenceDirectory, { recursive: true });
  const probeId = randomUUID();
  const evidencePath = join(evidenceDirectory, `candidate-cleanliness-probe-${probeId}.jsonl`);
  const probeDirectory = mkdtempSync(join(evidenceDirectory, `candidate-cleanliness-probe-${probeId}-`));
  const candidateRoot = join(probeDirectory, 'candidate');
  const isolatedState = join(candidateRoot, '.temp/goal/candidate-probe-state');
  const checkLog = join(isolatedState, 'checks.log');
  let preserve = false;
  writeFileSync(
    evidencePath,
    `${JSON.stringify({ type: 'probe-start', ...metadata, probeDirectory, evidencePath })}\n`,
  );
  logEvent(evidencePath, { type: 'candidate-clone-start', source: sourceRoot, commit: sourceHead });

  try {
    const cloned = git(worktreeRoot, ['clone', '--shared', '--no-checkout', sourceRoot, candidateRoot]);
    if (cloned.status !== 0 || cloned.error || cloned.signal)
      throw new Error(`Could not create isolated candidate clone: ${gitDetails(cloned)}`);
    for (const [name, commit] of Object.entries(sourceRefs)) {
      for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
        const seeded = git(candidateRoot, ['update-ref', ref, commit]);
        if (seeded.status !== 0 || seeded.error || seeded.signal)
          throw new Error(`Could not seed isolated ${ref} from ${commit}: ${gitDetails(seeded)}`);
      }
    }
    logEvent(evidencePath, { type: 'candidate-refs-seeded', refs: sourceRefs });
    const available = git(candidateRoot, ['cat-file', '-e', `${sourceHead}^{commit}`]);
    if (available.status !== 0) {
      const fetched = git(candidateRoot, ['fetch', '--quiet', sourceRoot, sourceHead]);
      if (fetched.status !== 0 || fetched.error || fetched.signal)
        throw new Error(`Could not fetch candidate commit into isolated clone: ${gitDetails(fetched)}`);
    }
    const checkedOut = git(candidateRoot, ['checkout', '--detach', sourceHead]);
    if (checkedOut.status !== 0 || checkedOut.error || checkedOut.signal)
      throw new Error(`Could not check out isolated candidate: ${gitDetails(checkedOut)}`);
    const expected = gitText(candidateRoot, 'rev-parse', 'HEAD');
    if (expected !== sourceHead)
      throw new Error(`Isolated candidate HEAD ${expected} did not match source ${sourceHead}`);

    const mainHead = gitText(candidateRoot, 'rev-parse', '--verify', `refs/heads/${sourceSettings.mainBranch}`);
    const base = gitText(candidateRoot, 'merge-base', mainHead, expected);
    if (!base)
      throw new Error(`Candidate ${expected} and ${sourceSettings.mainBranch} ${mainHead} have no common base`);
    const ancestor = git(candidateRoot, ['merge-base', '--is-ancestor', base, expected]);
    if (ancestor.status !== 0 || ancestor.signal || ancestor.error)
      throw new Error(`Candidate base ${base} is not an ancestor of ${expected}: ${gitDetails(ancestor)}`);
    installIsolatedLocalConfig(sourceRoot, candidateRoot, isolatedState);
    boundary(candidateRoot, expected, 'candidate initial checkout', evidencePath);
    logEvent(evidencePath, {
      type: 'candidate-ready',
      expectedHead: expected,
      mainHead,
      base,
      candidateRoot,
      isolatedState,
    });

    const installRunner = instrumentedGate(
      gateRunner(scriptPolicy().controlPlane.checkTimeoutMs, isolatedState, undefined, undefined, scriptPolicy().merge),
      expected,
      evidencePath,
      'control-plane dependency installs',
    );
    const installs = await runCommands(
      controlPlaneChecks(scriptPolicy().controlPlane).slice(0, 2),
      candidateRoot,
      checkLog,
      evidencePath,
      installRunner.run,
      'control-plane dependency installs',
    );
    if (installRunner.infraErrors.length)
      throw new Error(`Control-plane install infrastructure failure: ${installRunner.infraErrors.join('; ')}`);
    boundary(candidateRoot, expected, 'control-plane dependency installs complete', evidencePath);

    const validationRunner = instrumentedGate(
      gateRunner(scriptPolicy().controlPlane.checkTimeoutMs, isolatedState, undefined, undefined, scriptPolicy().merge),
      expected,
      evidencePath,
      'control-plane typecheck and full test suite',
      { deferIntegrity: true },
    );
    const validation = await runCommands(
      controlPlaneChecks(scriptPolicy().controlPlane).slice(2),
      candidateRoot,
      checkLog,
      evidencePath,
      validationRunner.run,
      'control-plane typecheck and full test suite',
    );
    boundary(candidateRoot, expected, 'control-plane typecheck and full test suite complete', evidencePath);
    if (validationRunner.infraErrors.length)
      throw new Error(`Control-plane command infrastructure failure: ${validationRunner.infraErrors.join('; ')}`);

    const failedCommand = installs.failedCommand ?? validation.failedCommand;
    const combined = {
      passed: installs.passed && validation.passed,
      output: installs.output + validation.output,
      timedOut: installs.timedOut || validation.timedOut,
      ...(failedCommand ? { failedCommand } : {}),
    };
    let controlPlanePassed = combined.passed;
    if (
      !combined.passed &&
      !combined.timedOut &&
      JSON.stringify(combined.failedCommand) === JSON.stringify(controlPlaneChecks(scriptPolicy().controlPlane).at(-1))
    ) {
      controlPlanePassed = await compareSuiteFailures(
        combined,
        candidateRoot,
        expected,
        base,
        candidateRoot,
        isolatedState,
        evidencePath,
        checkLog,
      );
    }
    boundary(candidateRoot, expected, 'control-plane sequence verified', evidencePath);
    logEvent(evidencePath, {
      type: 'control-plane-sequence-result',
      passed: controlPlanePassed,
      installsPassed: installs.passed,
      validationPassed: validation.passed,
      validationFailedCommand: validation.failedCommand ?? null,
      failingFiles: failingTestFiles(combined.output),
    });

    const smokeRunner = instrumentedGate(
      gateRunner(
        scriptPolicy().controlPlane.launchSmokeTimeoutMs,
        isolatedState,
        undefined,
        undefined,
        scriptPolicy().merge,
      ),
      expected,
      evidencePath,
      'real launch smoke on candidate',
    );
    const smoke = await runCommands(
      [['bun', 'tools/goal/scripts/launch-smoke.ts']],
      candidateRoot,
      checkLog,
      evidencePath,
      smokeRunner.run,
      'real launch smoke on candidate',
    );
    if (smokeRunner.infraErrors.length)
      throw new Error(`Candidate launch smoke infrastructure failure: ${smokeRunner.infraErrors.join('; ')}`);
    boundary(candidateRoot, expected, 'real launch smoke on candidate complete', evidencePath);
    logEvent(evidencePath, { type: 'candidate-smoke-result', ...outputInfo(smoke) });

    if (!controlPlanePassed || !smoke.passed) {
      preserve = true;
      throw new Error(
        `Candidate sequence failed: controlPlane=${controlPlanePassed ? 'passed' : 'failed'} smoke=${smoke.passed ? 'passed' : 'failed'}; evidence=${evidencePath}; candidate=${candidateRoot}; checkLog=${checkLog}`,
      );
    }

    const refsAfter = Object.fromEntries(
      Object.keys(sourceRefs).map((name) => [name, gitText(sourceRoot, 'rev-parse', '--verify', `refs/heads/${name}`)]),
    );
    const sourceRefsUnchanged = JSON.stringify(refsAfter) === JSON.stringify(sourceRefs);
    logEvent(evidencePath, {
      type: 'probe-result',
      passed: true,
      candidate: expected,
      base,
      sourceRefsUnchanged,
      ...(sourceRefsUnchanged ? {} : { sourceRefsChangedDuringProbe: { before: sourceRefs, after: refsAfter } }),
      evidencePath,
    });
    process.stdout.write(`Candidate cleanliness probe passed: ${expected}\nEvidence: ${evidencePath}\n`);
    if (!sourceRefsUnchanged)
      process.stdout.write(`Source refs moved during the isolated probe; checks used the initial snapshot.\n`);
  } catch (error) {
    preserve = true;
    const detail = sanitizedDetail(error);
    logEvent(evidencePath, { type: 'probe-result', passed: false, error: detail, candidateRoot, checkLog });
    throw new Error(`${detail}; evidence=${evidencePath}; candidate=${candidateRoot}; checkLog=${checkLog}`);
  } finally {
    try {
      const refsAfter = Object.fromEntries(
        Object.keys(sourceRefs).map((name) => [
          name,
          gitText(sourceRoot, 'rev-parse', '--verify', `refs/heads/${name}`),
        ]),
      );
      logEvent(evidencePath, {
        type: 'source-ref-final-state',
        unchanged: JSON.stringify(refsAfter) === JSON.stringify(sourceRefs),
        before: sourceRefs,
        after: refsAfter,
      });
    } catch (error) {
      logEvent(evidencePath, { type: 'source-ref-final-state', error: sanitizedDetail(error) });
    }
    if (!preserve) {
      try {
        rmSync(probeDirectory, { recursive: true, force: true });
        logEvent(evidencePath, { type: 'candidate-cleaned', candidate: candidateRoot });
      } catch (error) {
        logEvent(evidencePath, {
          type: 'cleanup-warning',
          candidate: candidateRoot,
          detail: sanitizedDetail(error),
          retained: true,
        });
      }
    }
  }
}

if (import.meta.main) {
  runCandidateCleanlinessProbe().catch((error) => {
    process.stderr.write(`${sanitizedDetail(error)}\n`);
    process.exitCode = 1;
  });
}
