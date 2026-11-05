import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { defaultPolicy, readControlPolicy } from '../src/policy.ts';
import { agentAdapter, withAgentAdapter } from '../src/agents.ts';
import {
  parseJsonLines,
  parseWorkerResult,
  recordCodexArgv,
  recordSystemdRun,
  requireWorkerCheck,
  runBoundedProcess,
} from '../test-support/lifecycle-fixture.ts';
import type { ExecutedRegression, ScenarioEvidence } from '../test-support/lifecycle-scenarios.ts';
import {
  CHECK_ID,
  message,
  observeSmokeAdapter,
  parseProviderObject,
  persistFailureLog,
  persistReport,
  readReport,
  requireSmokeWaitingCheckId,
  saveSmokeEvidence,
  smokeRunSuffix,
  smokeStderrSuffix,
  smokeTools,
  stepFailure,
  timeoutFailure,
  upsertScenario,
  waitForCheck,
  type Reporter,
  type SmokePolicy,
  type SmokeReport,
} from './launch-smoke-evidence.ts';
import type { SmokeLaunchEvidence } from './launch-smoke-evidence.ts';

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function stopWorkerCheck(resultPath: string, policy: SmokePolicy): Promise<void> {
  if (!existsSync(resultPath)) return;
  try {
    const record = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    const pid = Number(record.runnerPid);
    if (record.status !== 'running' || record.runnerHost !== hostname() || !Number.isSafeInteger(pid) || pid <= 0)
      return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      process.kill(pid, 'SIGTERM');
    }
    await delay(policy.stopGraceMs);
    if (processIsAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // The runner finished or exited between the read and the signal.
  }
}

async function exerciseWorkerCheck(
  tree: string,
  workerCheckScript: string,
  deadline: number,
  policy: SmokePolicy,
): Promise<Record<string, unknown>> {
  const runner = requireWorkerCheck(workerCheckScript);
  const start = await runBoundedProcess(
    process.execPath,
    [
      runner,
      '--local',
      '--',
      process.execPath,
      '-e',
      'setTimeout(() => console.log("lifecycle worker-check passed"), 7000)',
    ],
    {
      cwd: tree,
      env: { ...process.env, REZICS_CHECK_MEMORY: 'off' },
      timeoutMs: Math.min(policy.commandTimeoutMs, Math.max(1, deadline - Date.now())),
      outputLimit: policy.outputBytes,
      policy,
    },
  );
  const id = /check: id ([0-9a-f-]{36})/i.exec(start.stdout)?.[1];
  if (start.timedOut) {
    if (id && CHECK_ID.test(id)) await stopWorkerCheck(join(tree, '.temp/goal/checks/results', `${id}.json`), policy);
    throw new Error('capacity timeout: dev worker-check start is infrastructure/unverified');
  }
  if (start.error || start.status !== 0)
    throw new Error(`dev worker-check start failed: ${start.stderr.trim() || start.error || start.status}`);
  if (!id || !CHECK_ID.test(id)) throw new Error('dev worker-check start did not return a real check id');
  const resultPath = join(tree, '.temp/goal/checks/results', `${id}.json`);
  try {
    const initial: unknown = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (!initial || typeof initial !== 'object' || Array.isArray(initial))
      throw new Error('dev worker-check start record is not an object');
    const first = initial as Record<string, unknown>;
    if (
      first.id !== id ||
      first.status !== 'running' ||
      first.runnerHost !== hostname() ||
      typeof first.runnerPid !== 'number' ||
      !Number.isSafeInteger(first.runnerPid) ||
      !processIsAlive(Number(first.runnerPid)) ||
      typeof first.log !== 'string' ||
      !first.log ||
      !Array.isArray(first.argv) ||
      !first.argv.includes('--local') ||
      !first.argv.includes(process.execPath)
    )
      throw new Error('dev worker-check did not persist its live start record with argv and runner details');

    const wait = await runBoundedProcess(process.execPath, [runner, '--wait', id], {
      cwd: tree,
      env: { ...process.env, REZICS_CHECK_MEMORY: 'off' },
      timeoutMs: Math.min(policy.commandTimeoutMs, Math.max(1, deadline - Date.now())),
      outputLimit: policy.outputBytes,
      policy,
    });
    if (wait.timedOut) throw new Error('capacity timeout: dev worker-check wait is infrastructure/unverified');
    if (wait.error || wait.status !== 0)
      throw new Error(`dev worker-check wait failed: ${wait.stderr.trim() || wait.error || wait.status}`);
    const terminal = await waitForCheck(resultPath, deadline, policy);
    if (terminal.infrastructureFailureFinal === true || terminal.infrastructureFailure)
      throw new Error(
        `capacity timeout: dev worker-check infrastructure failure: ${String(terminal.infrastructureFailure ?? 'final infrastructure failure')}`,
      );
    if (terminal.id !== id || terminal.status !== 'finished' || terminal.exitCode !== 0)
      throw new Error('dev worker-check did not persist a passing terminal result record');
    if (terminal.log !== first.log)
      throw new Error('dev worker-check changed its recorded log between start and finish');
    if (!existsSync(join(tree, String(terminal.log)))) throw new Error('dev worker-check result log is missing');
    return {
      id,
      startRecord: {
        status: first.status,
        runnerHost: first.runnerHost,
        runnerPid: first.runnerPid,
        argv: first.argv,
        log: first.log,
      },
      terminalRecord: { status: terminal.status, exitCode: terminal.exitCode, log: terminal.log },
      foregroundWait: wait.stdout.trim(),
    };
  } finally {
    await stopWorkerCheck(resultPath, policy);
  }
}

function withDeadline<T>(promise: Promise<T>, deadline: number, step: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(`${step} exceeded the smoke time budget`));
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${step} exceeded the smoke time budget`)), remaining);
      promise.finally(() => clearTimeout(timer)).catch(() => {});
    }),
  ]);
}

export function runInnerProcess(
  tree: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  report: Reporter,
  policy: SmokePolicy,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const script = join(tree, 'tools/goal/scripts/launch-smoke.ts');
    const child = spawn(process.execPath, [script, '--inner'], {
      cwd: tree,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutPending = '';
    let stderrPending = '';
    let reportedBytes = 0;
    let outputTruncated = false;
    const appendTail = (current: string, text: string): string => {
      const next = Buffer.concat([Buffer.from(current), Buffer.from(text)]);
      return next.byteLength <= policy.outputBytes
        ? next.toString('utf8')
        : next.subarray(-policy.outputBytes).toString('utf8');
    };
    const reportBounded = (line: string) => {
      if (reportedBytes >= policy.outputBytes) {
        if (!outputTruncated)
          report(
            `[inner output truncated after ${policy.outputBytes === defaultPolicy.launchSmoke.outputBytes ? '2 MiB' : `${policy.outputBytes} bytes`}]`,
          );
        outputTruncated = true;
        return;
      }
      const remaining = policy.outputBytes - reportedBytes - 1;
      if (remaining <= 0) {
        if (!outputTruncated)
          report(
            `[inner output truncated after ${policy.outputBytes === defaultPolicy.launchSmoke.outputBytes ? '2 MiB' : `${policy.outputBytes} bytes`}]`,
          );
        outputTruncated = true;
        return;
      }
      const bytes = Buffer.from(line);
      let bounded = bytes.byteLength <= remaining ? line : bytes.subarray(0, remaining).toString('utf8');
      while (Buffer.byteLength(bounded) > remaining) bounded = bounded.slice(0, -1);
      report(bounded);
      reportedBytes += Buffer.byteLength(bounded) + 1;
      if (Buffer.byteLength(bounded) < bytes.byteLength) {
        if (!outputTruncated)
          report(
            `[inner output truncated after ${policy.outputBytes === defaultPolicy.launchSmoke.outputBytes ? '2 MiB' : `${policy.outputBytes} bytes`}]`,
          );
        outputTruncated = true;
      }
    };
    const forward = (chunk: Buffer, which: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8');
      if (which === 'stdout') stdout = appendTail(stdout, text);
      else stderr = appendTail(stderr, text);
      const pending = which === 'stdout' ? stdoutPending : stderrPending;
      const lines = appendTail(pending, text).split(/\r?\n/);
      const remainder = lines.pop() ?? '';
      for (const line of lines) if (line) reportBounded(line);
      if (which === 'stdout') stdoutPending = remainder;
      else stderrPending = remainder;
    };
    child.stdout.on('data', (chunk: Buffer) => forward(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => forward(chunk, 'stderr'));
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(
      () => {
        timedOut = true;
        signalChildGroup(child, 'SIGTERM');
        forceKill = setTimeout(() => signalChildGroup(child, 'SIGKILL'), policy.innerTerminationGraceMs);
      },
      Math.max(1, timeoutMs),
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      if (stdoutPending) reportBounded(stdoutPending);
      if (stderrPending) reportBounded(stderrPending);
      if (timedOut) {
        reject(new Error('inner lifecycle process exceeded the smoke budget; infrastructure/unverified'));
        return;
      }
      if (code !== 0) {
        const output = `${stdout}\n${stderr}`;
        const failedStep = output.match(
          /(?:candidate|setup|start|wake|success|lifecycle regressions): failed:[^\r\n]*/,
        )?.[0];
        reject(new Error(failedStep ?? `inner smoke exited ${code ?? signal ?? 'unknown'}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

function signalChildGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The owned inner process has already exited.
    }
  }
}

export async function runInnerSmoke(
  report: Reporter,
  launchSmokeBrief: (workerCheckScript: string, paths?: string[]) => string,
): Promise<void> {
  const startupPolicy = process.env.REZICS_LAUNCH_SMOKE_POLICY
    ? readControlPolicy(JSON.parse(process.env.REZICS_LAUNCH_SMOKE_POLICY))
    : undefined;
  const tree = resolve(process.env.REZICS_LAUNCH_SMOKE_TREE ?? resolve(import.meta.dir, '../../..'));
  const clone = resolve(process.env.REZICS_LAUNCH_SMOKE_CLONE ?? tree);
  const sourceRoot = resolve(process.env.REZICS_LAUNCH_SMOKE_SOURCE_ROOT ?? tree);
  const localFile = resolve(process.env.REZICS_LAUNCH_SMOKE_LOCAL_FILE ?? join(sourceRoot, '.temp/goal/local.json'));
  const stateDirectory = resolve(process.env.REZICS_LAUNCH_SMOKE_STATE ?? join(tree, '.temp/goal-launch-smoke-state'));
  const worktreeRoot = resolve(
    process.env.REZICS_LAUNCH_SMOKE_WORKTREES ?? join(tree, '.temp/goal-launch-smoke-workers'),
  );
  const branch = process.env.REZICS_LAUNCH_SMOKE_BRANCH ?? 'launch-smoke';
  const workerCheckScript = resolve(
    process.env.REZICS_LAUNCH_SMOKE_WORKER_CHECK ?? join(tree, 'scripts/worker-check.ts'),
  );
  const deadline = Number(
    process.env.REZICS_LAUNCH_SMOKE_DEADLINE ?? Date.now() + (startupPolicy ?? defaultPolicy).launchSmoke.budgetMs,
  );
  const reportPath = resolve(
    process.env.REZICS_LAUNCH_SMOKE_REPORT_PATH ?? join(tree, '.temp/goal/lifecycle-smoke/report.json'),
  );
  const evidence: SmokeReport = existsSync(reportPath)
    ? readReport(reportPath)
    : {
        version: 1,
        status: 'running',
        startedAt: new Date().toISOString(),
        scenarios: [],
        incidents: [],
        suiteRegressions: [],
      };
  const persistEvidence = () => persistReport(tree, reportPath, evidence);
  const importModule = async <T>(path: string): Promise<T> => (await import(pathToFileURL(path).href)) as T;
  const [
    { loadSettings },
    { readRouting },
    { readRiskOwnership, parseBrief },
    { openDb },
    { WorkerStore },
    { WorkerTasks },
    { WorkerJob },
    { readLogTail, reportsSuccess },
    { WorkerSlice },
  ] = await Promise.all([
    importModule<typeof import('../src/config.ts')>(join(tree, 'tools/goal/src/config.ts')),
    importModule<typeof import('../src/routing.ts')>(join(tree, 'tools/goal/src/routing.ts')),
    importModule<typeof import('../src/briefs.ts')>(join(tree, 'tools/goal/src/briefs.ts')),
    importModule<typeof import('../src/db.ts')>(join(tree, 'tools/goal/src/db.ts')),
    importModule<typeof import('../src/store.ts')>(join(tree, 'tools/goal/src/store.ts')),
    importModule<typeof import('../src/tasks.ts')>(join(tree, 'tools/goal/src/tasks.ts')),
    importModule<typeof import('../src/job.ts')>(join(tree, 'tools/goal/src/job.ts')),
    importModule<typeof import('../src/records.ts')>(join(tree, 'tools/goal/src/records.ts')),
    importModule<typeof import('../src/worker-slice.ts')>(join(tree, 'tools/goal/src/worker-slice.ts')),
  ]);
  const env = {
    ...process.env,
    GOAL_MAIN_CHECKOUT: clone,
    GOAL_LOCAL_CONFIG: localFile,
    GOAL_STATE_DIRECTORY: stateDirectory,
    GOAL_WORKTREE_ROOT: worktreeRoot,
  };
  const settings = loadSettings({ cwd: tree, env, localFile });
  if (startupPolicy) settings.policy = startupPolicy;
  const policy = (settings.policy ?? defaultPolicy).launchSmoke;
  const { git, checked, message, stepFailure } = smokeTools(policy);
  // Tracked configuration comes from the candidate; local, untracked files (routing.local.json) exist only in the
  // source checkout, and remapping them failed every smoke at setup with ENOENT.
  const remap = (path: string): string => {
    const relativePath = relative(sourceRoot, resolve(path));
    if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return path;
    const candidate = resolve(tree, relativePath);
    return existsSync(candidate) ? candidate : path;
  };
  settings.mainCheckout = clone;
  settings.mainBranch = branch;
  settings.integrationBranch = branch;
  settings.stateDirectory = stateDirectory;
  settings.worktreeRoot = worktreeRoot;
  settings.routingFile = remap(settings.routingFile);
  settings.riskAreasFile = remap(settings.riskAreasFile);
  settings.integration = {
    ...settings.integration,
    managerDirectory: join(stateDirectory, 'managers'),
    inboxDirectory: join(stateDirectory, 'inboxes'),
    managerSocket: join(stateDirectory, 'manager.sock'),
    tmuxSocket: join(stateDirectory, 'tmux.sock'),
  };
  const routing = readRouting(settings.routingFile, settings.policy?.routing);
  const selected = routing.classes.specification.first;
  if (selected.cli !== 'codex')
    throw new Error('the configured specification route must select Codex for real provider smoke');
  const codexPools = settings.pools.filter((pool) => pool.cli === 'codex' && pool.classes.includes(selected.poolClass));
  if (!codexPools.length) throw new Error(`no configured Codex pool admits route class ${selected.poolClass}`);
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const originalPath = process.env.PATH;
  const systemdRecorder = recordSystemdRun(join(stateDirectory, 'systemd-bin'), policy);
  const codexLogDirectory = join(stateDirectory, 'codex-argv');
  mkdirSync(codexLogDirectory, { recursive: true });
  const codexLogs = new Map<string, string>();
  const codexInvocationBudget = join(codexLogDirectory, 'invocation-budget.jsonl');
  for (const [index, pool] of codexPools.entries()) {
    const executable = Bun.which(pool.command);
    if (!executable)
      throw new Error(`configured Codex executable is unavailable for pool ${pool.name}: ${pool.command}`);
    const logPath = join(codexLogDirectory, `pool-${index}.jsonl`);
    pool.command = recordCodexArgv(
      join(codexLogDirectory, `wrapper-${index}`),
      executable,
      logPath,
      2,
      codexInvocationBudget,
    );
    codexLogs.set(pool.name, logPath);
  }

  const systemdErrors: string[] = [];
  const systemdProbe = new WorkerSlice(undefined, undefined, undefined, settings.policy?.workerResources).launch(
    'lifecycle-smoke-preflight',
    0,
    process.execPath,
    ['-e', 'process.stdout.write("lifecycle systemd scope passed\\n")'],
    { cwd: tree, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: policy.commandTimeoutMs },
    () => false,
    (line: string) => systemdErrors.push(line),
  );
  if (systemdErrors.length) throw new Error(systemdErrors[0]!);
  if (systemdProbe.error || systemdProbe.status !== 0)
    throw new Error(
      `real systemd worker scope failed: ${systemdProbe.stderr?.toString().trim() || systemdProbe.error?.message || systemdProbe.status}`,
    );
  const systemdCalls = parseJsonLines<string[]>(systemdRecorder.logPath);
  if (
    systemdCalls.length !== 1 ||
    !systemdCalls[0]!.includes('--user') ||
    !systemdCalls[0]!.includes('--scope') ||
    !systemdCalls[0]!.includes('--slice=rezics-workers.slice') ||
    !systemdCalls[0]!.some((argument) => argument.startsWith('--unit=rezics-worker-lifecycle-smoke-preflight-0-'))
  )
    throw new Error(
      `production WorkerSlice did not launch the preflight under a real rezics-workers.slice scope; observed ${JSON.stringify(systemdCalls)}`,
    );
  upsertScenario(evidence, {
    id: 'real-systemd-scope-preflight',
    status: 'passed',
    evidence: { unit: systemdCalls[0]!.find((argument) => argument.startsWith('--unit=')), args: systemdCalls[0] },
  });
  persistEvidence();
  report('systemd-preflight: passed');

  const workerCheckEvidence = await exerciseWorkerCheck(tree, workerCheckScript, deadline, policy);
  upsertScenario(evidence, {
    id: 'dev-worker-check-start-and-result-records',
    status: 'passed',
    evidence: workerCheckEvidence,
  });
  persistEvidence();
  report('worker-check-boundary: passed');

  const db = openDb(join(stateDirectory, 'goal.sqlite'), settings.policy?.storage);
  const store = new WorkerStore(db, settings.policy);
  const tasks = new WorkerTasks(settings, store);
  const landing = { enqueue: () => {} };
  const inbox = { deliver: () => {} };
  const job = new WorkerJob(tasks, landing, inbox, undefined, async () => {});
  let taskId: string | undefined;
  let startPromise: Promise<void> | undefined;
  const launchErrors: string[] = [];
  const evidencePath = process.env.REZICS_LAUNCH_SMOKE_EVIDENCE;
  const launches: SmokeLaunchEvidence[] = [];
  let currentStep: 'setup' | 'start' | 'wake' | 'success' = 'setup';
  let currentFailure: string | null = null;
  let activeRun = false;
  let launchAfterSequence = 0;
  const snapshot = () => {
    if (!evidencePath) return;
    const task = taskId ? store.task(taskId) : undefined;
    const attempt =
      task && task.currentAttempt > 0 ? store.attempt({ taskId: task.id, attempt: task.currentAttempt }) : undefined;
    const events = attempt ? store.events(attempt.taskId, attempt.attempt) : [];
    const run = events
      .filter((event) => event.kind === 'worker-run-started' && event.sequence > launchAfterSequence)
      .at(-1);
    const runBody = run ? (JSON.parse(run.body) as { logStartOffset: number; resuming: boolean }) : undefined;
    // A resumed attempt still holds its previous waiting result while it runs. Never present that as this turn's exit.
    let result: unknown = null;
    if (attempt && !activeRun) {
      try {
        result = JSON.parse(attempt.result);
      } catch {
        result = attempt.result;
      }
    }
    saveSmokeEvidence(
      evidencePath,
      {
        runId: process.env.REZICS_LAUNCH_SMOKE_RUN_ID,
        candidate: process.env.REZICS_LAUNCH_SMOKE_CANDIDATE,
        mergedCandidate: git(tree, 'rev-parse', 'HEAD'),
        stage: currentStep,
        failure: currentFailure,
        current: attempt
          ? {
              taskId: attempt.taskId,
              attempt: attempt.attempt,
              state: attempt.state,
              activeRun,
              result,
              blocker: activeRun ? null : attempt.blocker,
              failureKind: activeRun ? null : attempt.failureKind,
              session: attempt.session,
              profile: attempt.profile,
              pool: attempt.pool,
              process: attempt.process,
              driver: attempt.driver,
              exitCode: activeRun ? null : attempt.exitCode,
              worktree: task!.worktree,
              branch: task!.branch,
            }
          : null,
        launches,
        selection: { configuredProfile: selected, currentAttemptProfile: attempt?.profile, pool: attempt?.pool },
        currentRun: run ? { sequence: run.sequence, at: run.at, ...runBody } : null,
        events: events
          .slice(-policy.snapshotEvents)
          .map((event) => ({ sequence: event.sequence, kind: event.kind, at: event.at })),
        logSuffix: attempt && runBody ? smokeRunSuffix(attempt.logPath, runBody.logStartOffset, policy) : [],
        stderrSuffix: attempt && runBody ? smokeStderrSuffix(`${attempt.logPath}.err`, policy) : '',
        checks: (attempt?.checks ?? []).map((id) => {
          const path = join(task!.worktree, '.temp/goal/checks/results', `${id}.json`);
          let record: unknown = null;
          try {
            record = JSON.parse(readFileSync(path, 'utf8'));
          } catch {
            /* No terminal record yet. */
          }
          return { id, record };
        }),
        launchErrors: launchErrors.slice(-policy.launchErrors),
      },
      policy,
    );
  };
  const observed = observeSmokeAdapter(agentAdapter('codex'), (launch) => {
    launches.push(launch);
    activeRun = true;
    if (taskId) {
      const task = store.task(taskId);
      launchAfterSequence =
        store
          .events(taskId, task.currentAttempt)
          .filter((event) => event.kind === 'worker-run-started')
          .at(-1)?.sequence ?? 0;
    }
    snapshot();
  });
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    const line = values.map(String).join(' ');
    launchErrors.push(line);
    if (!/Worker systemd scope unavailable; starting without a scope:/.test(line)) originalError(...values);
  };
  try {
    const frontMatter = launchSmokeBrief(workerCheckScript);
    parseBrief(frontMatter, readRiskOwnership(settings.riskAreasFile, settings.policy?.brief), settings.policy?.brief);
    const briefPath = join(stateDirectory, 'briefs', `${randomUUID()}.md`);
    mkdirSync(dirname(briefPath), { recursive: true });
    writeFileSync(briefPath, frontMatter, { flag: 'wx' });
    const task = tasks.dispatch(briefPath);
    taskId = task.id;
    if (task.currentAttempt !== 0) throw new Error('smoke task did not start at attempt zero');
    report('setup: passed');

    currentStep = 'start';
    try {
      startPromise = withAgentAdapter(observed, () => job.start(task.id, { expectedAttempt: 0 }));
      await withDeadline(startPromise, deadline, 'start');
      activeRun = false;
      const waitingTask = store.task(task.id);
      const waitingAttempt = store.attempt({ taskId: task.id, attempt: waitingTask.currentAttempt });
      if (waitingAttempt.state !== 'waiting')
        throw new Error(
          `worker exited as ${waitingAttempt.state}, expected waiting (exitCode=${String(waitingAttempt.exitCode)}, failureKind=${waitingAttempt.failureKind ?? 'none'}, reportsSuccess=${reportsSuccess(waitingAttempt.result)})`,
        );
      if (waitingAttempt.exitCode !== 0)
        throw new Error(`waiting worker exited with code ${String(waitingAttempt.exitCode)}`);
      if (!waitingAttempt.session) throw new Error('waiting attempt did not save its session id');
      const checkId = requireSmokeWaitingCheckId(waitingAttempt.checks);
      if (
        waitingAttempt.profile.cli !== 'codex' ||
        waitingAttempt.profile.model !== selected.model ||
        waitingAttempt.profile.effort !== selected.effort ||
        waitingAttempt.profile.poolClass !== selected.poolClass
      )
        throw new Error('worker did not use the configured specification Codex profile');
      const waitingResult = parseWorkerResult(
        parseProviderObject(readLogTail(waitingAttempt.logPath), 'waiting'),
        'waiting',
        checkId,
      );
      if (launchErrors.some((line) => /Worker systemd scope unavailable; starting without a scope:/.test(line)))
        throw new Error(
          launchErrors.find((line) => /Worker systemd scope unavailable; starting without a scope:/.test(line))!,
        );
      report('start: passed');

      currentStep = 'wake';
      const resultPath = join(waitingTask.worktree, '.temp/goal/checks/results', `${checkId}.json`);
      const checkResult = await withDeadline(waitForCheck(resultPath, deadline, policy), deadline, 'wake');
      if (checkResult.infrastructureFailureFinal === true || checkResult.infrastructureFailure)
        throw new Error(
          `capacity timeout: worker-check ${checkId} infrastructure failure: ${String(checkResult.infrastructureFailure ?? 'final infrastructure failure')}`,
        );
      if (checkResult.exitCode !== 0)
        throw new Error(`worker-check ${checkId} finished with exit ${String(checkResult.exitCode ?? 'unknown')}`);
      const originalSession = waitingAttempt.session;
      await withDeadline(
        withAgentAdapter(observed, () => job.recoverOrphans()),
        deadline,
        'wake',
      );
      activeRun = false;
      const resumedTask = store.task(task.id);
      const resumed = store.attempt({ taskId: task.id, attempt: resumedTask.currentAttempt });
      if (resumedTask.currentAttempt !== waitingTask.currentAttempt)
        throw new Error('worker-check wake created a new attempt instead of resuming the waiting attempt');
      if (resumed.session !== originalSession) throw new Error('wake did not resume the same worker session');
      if (launchErrors.some((line) => /Worker systemd scope unavailable; starting without a scope:/.test(line)))
        throw new Error(
          launchErrors.find((line) => /Worker systemd scope unavailable; starting without a scope:/.test(line))!,
        );
      report('wake: passed');

      currentStep = 'success';
      if (resumed.exitCode !== 0) throw new Error(`resumed worker exited with code ${String(resumed.exitCode)}`);
      if (resumed.state !== 'exited' || resumed.failureKind || !reportsSuccess(resumed.result))
        throw new Error(
          `resumed worker did not exit successfully: ${resumed.failureKind ?? resumed.result.slice(-policy.resultCharacters)}`,
        );
      const successResult = parseWorkerResult(
        parseProviderObject(readLogTail(resumed.logPath), 'resumed success'),
        'success',
      );
      if (
        waitingResult.status === successResult.status ||
        JSON.stringify(waitingResult) === JSON.stringify(successResult)
      )
        throw new Error('resumed output reused the prior waiting exit object');
      const pool = settings.pools.find(({ name }) => name === waitingAttempt.pool);
      const argvLog = codexLogs.get(waitingAttempt.pool);
      if (!pool || pool.cli !== 'codex' || !argvLog) throw new Error('actual Codex pool argv was not recorded');
      const actualArgv = parseJsonLines<string[]>(argvLog);
      const schema = join(tree, 'tools/goal/worker-result.schema.json');
      assertCodexArgv(actualArgv, {
        model: waitingAttempt.profile.model,
        effort: waitingAttempt.profile.effort,
        serviceTier: settings.codex.serviceTier,
        session: originalSession,
        worktree: waitingTask.worktree,
        schema,
      });
      const finalSystemdCalls = parseJsonLines<string[]>(systemdRecorder.logPath);
      const taskUnits = finalSystemdCalls.flatMap((args) =>
        args.some((argument) => argument.startsWith(`--unit=rezics-worker-${task.id}-`))
          ? [args.find((argument) => argument.startsWith('--unit='))!.slice('--unit='.length)]
          : [],
      );
      if (
        taskUnits.length !== 2 ||
        new Set(taskUnits).size !== 2 ||
        finalSystemdCalls.some(
          (args) =>
            args.some((argument) => argument.startsWith(`--unit=rezics-worker-${task.id}-`)) &&
            !args.includes('--slice=rezics-workers.slice'),
        )
      )
        throw new Error('provider start and resume did not each use a fresh real systemd worker scope');
      if (waitingAttempt.session !== originalSession || resumed.session !== originalSession)
        throw new Error('Codex thread.started session did not persist across the waiting resume');
      upsertScenario(evidence, {
        id: 'provider-real-cli-launch-wait-wake',
        status: 'passed',
        evidence: {
          pool: waitingAttempt.pool,
          profile: { ...waitingAttempt.profile, serviceTier: settings.codex.serviceTier },
          session: originalSession,
          checkId,
          states: [waitingAttempt.state, resumed.state],
          exitStatuses: [waitingResult.status, successResult.status],
          codexInvocations: actualArgv.map((args) => args.slice(0, args.indexOf('--') + 1)),
          systemdUnits: taskUnits,
          resumedAttempt: resumedTask.currentAttempt,
        },
      });
      persistEvidence();
      report('success: passed');
    } catch (error) {
      currentFailure = message(error);
      let failure: unknown = error;
      try {
        if (taskId) {
          const task = store.task(taskId);
          const attempt = store.attempt({ taskId, attempt: task.currentAttempt });
          const details = [readLogTail(attempt.logPath), readLogTail(`${attempt.logPath}.err`)]
            .filter(Boolean)
            .join('\n');
          if (details) {
            const logPath = persistFailureLog(reportPath, currentStep, details);
            failure = new Error(`${message(error)}; bounded worker log: ${logPath}`);
          }
        }
      } catch {
        // Preserve the launch or wake failure if its attempt log is unavailable.
      }
      throw stepFailure(currentStep, failure, report);
    }
  } catch (error) {
    currentFailure ??= message(error);
    throw error;
  } finally {
    // Persist before stopping the task, closing the database, or removing any disposable files.
    let evidenceFailure: unknown;
    try {
      snapshot();
    } catch (error) {
      evidenceFailure = error;
      report(`evidence: failed: ${message(error)}`);
    }
    console.error = originalError;
    if (taskId) {
      try {
        await tasks.stop(taskId);
      } catch {
        /* Cleanup continues; this task belongs only to the smoke. */
      }
      const task = store.task(taskId);
      if (task.currentAttempt > 0) {
        for (const checkId of store.attempt({ taskId, attempt: task.currentAttempt }).checks ?? []) {
          const resultPath = join(task.worktree, '.temp/goal/checks/results', `${checkId}.json`);
          try {
            const record = JSON.parse(readFileSync(resultPath, 'utf8')) as {
              status?: string;
              runnerPid?: number;
              runnerHost?: string;
            };
            if (
              record.status === 'running' &&
              record.runnerHost === hostname() &&
              Number.isSafeInteger(record.runnerPid)
            ) {
              try {
                process.kill(-record.runnerPid!, 'SIGTERM');
              } catch {
                process.kill(record.runnerPid!, 'SIGTERM');
              }
            }
          } catch {
            /* The check is already finished or its local runner has exited. */
          }
        }
      }
      try {
        checked('git', ['worktree', 'remove', '--force', task.worktree], clone);
      } catch {
        /* The outer disposable clone is removed after this process exits. */
      }
      try {
        checked('git', ['branch', '-D', task.branch], clone);
      } catch {
        /* The outer disposable clone is removed after this process exits. */
      }
      if (startPromise)
        await Promise.race([
          startPromise.catch(() => {}),
          new Promise((resolvePromise) => setTimeout(resolvePromise, policy.drainWaitMs)),
        ]);
    }
    try {
      await job.drain();
    } catch {
      /* The task's failure is already reported with its step. */
    }
    db.close();
    if (evidenceFailure && !currentFailure) throw evidenceFailure;
  }

  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  const lifecycle = await import('../test-support/lifecycle-scenarios.ts');
  try {
    const { incidents, suite } = await lifecycle.runNamedLifecycleRegressions({
      policy: settings.policy,
      root: tree,
      artifactDirectory: dirname(reportPath),
      deadline,
      report,
      onRegression(record) {
        evidence.incidents = evidence.incidents.filter(({ id }) => id !== record.id);
        evidence.incidents.push(record);
        persistEvidence();
      },
      onSuiteRegression(record) {
        evidence.suiteRegressions = evidence.suiteRegressions.filter(({ id }) => id !== record.id);
        evidence.suiteRegressions.push(record);
        persistEvidence();
      },
      onScenario(scenario) {
        if (scenario.id === 'resumed-output-isolation') {
          const providerEvidence = evidence.scenarios.find(
            ({ id }) => id === 'provider-real-cli-launch-wait-wake',
          )?.evidence;
          upsertScenario(evidence, {
            ...scenario,
            evidence: {
              productionRegression: scenario.evidence,
              realProviderResume: providerEvidence,
            },
          });
        } else upsertScenario(evidence, scenario);
        persistEvidence();
      },
    });
    evidence.incidents = incidents;
    evidence.suiteRegressions = suite;
    const missingSuiteTests = lifecycle.LIFECYCLE_SUITE_TESTS.filter(
      ({ id }) => !suite.some((record) => record.id === id && record.status === 'passed'),
    );
    if (missingSuiteTests.length)
      throw new Error(
        `lifecycle suite regressions are incomplete: ${missingSuiteTests.map(({ id }) => id).join(', ')}`,
      );
    lifecycle.assertLifecycleComplete({ scenarios: evidence.scenarios, incidents: evidence.incidents });
    evidence.status = 'passed';
    evidence.finishedAt = new Date().toISOString();
    persistEvidence();
    report('lifecycle regressions: passed');
  } catch (error) {
    evidence.status = timeoutFailure(error) ? 'unverified' : 'failed';
    evidence.finishedAt = new Date().toISOString();
    evidence.failure = {
      step: 'lifecycle regressions',
      detail: message(error),
      classification: timeoutFailure(error) ? 'infrastructure/unverified' : 'failure',
    };
    persistEvidence();
    throw stepFailure('lifecycle regressions', error, report);
  }
}

function assertCodexArgv(
  launches: string[][],
  options: { model: string; effort: string; serviceTier: string; session: string; worktree: string; schema: string },
): void {
  if (launches.length !== 2) throw new Error(`expected two actual Codex CLI invocations, observed ${launches.length}`);
  const [start, resume] = launches;
  if (!start || !resume) throw new Error('actual Codex CLI argv log is missing a start or resume call');
  const has = (args: string[], ...values: string[]) => values.every((value) => args.includes(value));
  const schemaIndex = start.indexOf('--output-schema');
  const resumeSchemaIndex = resume.indexOf('--output-schema');
  const tier = `service_tier=${JSON.stringify(options.serviceTier)}`;
  if (
    start[0] !== 'exec' ||
    !has(
      start,
      '--json',
      '-m',
      options.model,
      '-c',
      `model_reasoning_effort=${options.effort}`,
      '-C',
      options.worktree,
    ) ||
    !has(start, '-c', tier) ||
    schemaIndex < 0 ||
    start[schemaIndex + 1] !== options.schema ||
    start.includes('resume')
  )
    throw new Error(
      'actual Codex start argv did not preserve the selected model, effort, service tier, schema, and worktree',
    );
  const resumeIndex = resume.indexOf('resume');
  const directoryIndex = resume.indexOf('-C');
  if (
    resume[0] !== 'exec' ||
    directoryIndex < 0 ||
    resume[directoryIndex + 1] !== options.worktree ||
    resumeIndex !== directoryIndex + 2 ||
    resume[resumeIndex + 1] !== options.session ||
    resumeSchemaIndex < 0 ||
    resume[resumeSchemaIndex + 1] !== options.schema ||
    !has(resume, '--json', '-m', options.model, '-c', `model_reasoning_effort=${options.effort}`, '-c', tier) ||
    !existsSync(options.schema)
  )
    throw new Error(
      'actual Codex resume argv did not preserve exec option order, session, selected settings, and schema',
    );
}
