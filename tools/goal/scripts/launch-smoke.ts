#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadSettings, mainCheckout } from '../src/config.ts';

const CHECK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WAIT_MS = 100;
const INNER_BUDGET_MS = 270_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;

export type SmokeOptions = {
  root?: string;
  report?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
};

type Reporter = (line: string) => void;

function reportLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 1200);
}

function stepFailure(step: string, error: unknown, report: Reporter): Error {
  const detail = message(error);
  report(`${step}: failed: ${detail}`);
  return new Error(`${step}: ${detail}`);
}

function checked(command: string, args: string[], cwd: string, timeout = 30_000): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: OUTPUT_LIMIT });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`${command} ${args[0] ?? ''}: ${detail}`);
  }
  return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
  return checked('git', args, cwd);
}

function uuidPath(root: string, prefix: string): string {
  const temp = join(root, '.temp');
  mkdirSync(temp, { recursive: true });
  return mkdtempSync(join(temp, prefix));
}

function parseJsonLine(text: string, label: string): Record<string, unknown> {
  const line = text.trim().split(/\r?\n/).at(-1) ?? '';
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} did not return a JSON object: ${message(error)}`);
  }
}

function fakeStep(
  agent: string,
  step: string,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(agent, [step], { encoding: 'utf8', env, timeout: 10_000, maxBuffer: OUTPUT_LIMIT });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Fake-agent seam for the fast protocol tests. The train invokes the no-argument real path. */
export async function runLaunchSmoke(agent?: string, options: SmokeOptions = {}): Promise<void> {
  const root = resolve(options.root ?? resolve(import.meta.dir, '../../..'));
  const report = options.report ?? reportLine;
  if (agent) return runFakeSmoke(agent, root, report, options.env ?? {});
  return runRealSmoke(root, report);
}

async function runFakeSmoke(agent: string, root: string, report: Reporter, suppliedEnv: NodeJS.ProcessEnv): Promise<void> {
  const directory = uuidPath(root, 'launch-smoke-test-');
  let checkId = '01234567-89ab-4cde-8f01-23456789abcd';
  const session = 'launch-smoke-fake-session';
  const resultPath = join(directory, 'result.json');
  const baseEnv = {
    ...process.env,
    ...suppliedEnv,
    REZICS_SMOKE_CHECK_ID: checkId,
    REZICS_SMOKE_SESSION: session,
    REZICS_SMOKE_RESULT: resultPath,
  };
  try {
    try {
      const start = fakeStep(agent, 'start', baseEnv);
      if (start.error || start.status !== 0) throw new Error(start.stderr || start.error?.message || `exit ${start.status}`);
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
        if (!Array.isArray(waiting.checks) || waiting.checks.length !== 1 || typeof waiting.checks[0] !== 'string')
          throw new Error('expected one worker-check id');
        checkId = waiting.checks[0];
        baseEnv.REZICS_SMOKE_CHECK_ID = checkId;
        if (!CHECK_ID.test(checkId)) throw new Error('fake worker-check id is not a UUID');
      } else if (!/^worker-check-[\w-]+$/.test(checkId)) {
        throw new Error('fake worker-check id has an invalid shape');
      }
      report('start: passed');
    } catch (error) {
      throw stepFailure('start', error, report);
    }

    try {
      writeFileSync(resultPath, `${JSON.stringify({ status: 'finished', exitCode: 0, failureSummary: 'passed' })}\n`);
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { status?: string; exitCode?: number };
      if (result.status !== 'finished' || result.exitCode !== 0) throw new Error('worker-check result did not pass');
      const wake = fakeStep(agent, 'wake', baseEnv);
      if (wake.error || wake.status !== 0) throw new Error(wake.stderr || wake.error?.message || `exit ${wake.status}`);
      if (!wake.stdout.includes('result passed')) throw new Error('wake did not receive the passing check result');
      report('wake: passed');
    } catch (error) {
      throw stepFailure('wake', error, report);
    }

    try {
      const success = fakeStep(agent, 'success', baseEnv);
      if (success.error || success.status !== 0) throw new Error(success.stderr || success.error?.message || `exit ${success.status}`);
      let status = '';
      try {
        status = String(parseJsonLine(success.stdout, 'success').status ?? '');
      } catch {
        status = success.stdout.trim();
      }
      if (status !== 'success') throw new Error('expected a success exit');
      report('success: passed');
    } catch (error) {
      throw stepFailure('success', error, report);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runInnerProcess(tree: string, env: NodeJS.ProcessEnv, timeoutMs: number, report: Reporter): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const script = join(tree, 'tools/goal/scripts/launch-smoke.ts');
    const child = spawn(process.execPath, [script, '--inner'], { cwd: tree, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutPending = '';
    let stderrPending = '';
    const forward = (chunk: Buffer, which: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8');
      if (which === 'stdout') stdout += text;
      else stderr += text;
      const pending = which === 'stdout' ? stdoutPending : stderrPending;
      const lines = `${pending}${text}`.split(/\r?\n/);
      const remainder = lines.pop() ?? '';
      for (const line of lines) if (line) report(line);
      if (which === 'stdout') stdoutPending = remainder;
      else stderrPending = remainder;
    };
    child.stdout.on('data', (chunk: Buffer) => forward(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => forward(chunk, 'stderr'));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, Math.max(1, timeoutMs));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (stdoutPending) report(stdoutPending);
      if (stderrPending) report(stderrPending);
      if (code !== 0) {
        const output = `${stdout}\n${stderr}`;
        const failedStep = output.match(/(?:setup|start|wake|success): failed:[^\r\n]*/)?.[0];
        reject(new Error(failedStep ?? `inner smoke exited ${code ?? signal ?? 'unknown'}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

async function runRealSmoke(root: string, report: Reporter): Promise<void> {
  let currentStep = 'candidate';
  const startedAt = Date.now();
  const deadline = startedAt + INNER_BUDGET_MS;
  let temporary = '';
  let clone = '';
  let tree = '';
  let devTree = '';
  let branch = '';
  let worktreeAdded = false;
  let devWorktreeAdded = false;
  try {
    const candidate = git(root, 'rev-parse', 'HEAD');
    git(root, 'diff', '--quiet', 'HEAD', '--');
    const sourceRoot = mainCheckout(root);
    const sourceSettings = loadSettings({ cwd: root });
    if (sourceSettings.codex.serviceTier.trim().toLowerCase() === 'fast')
      throw new Error('Codex service tier is Fast; launch smoke only permits the configured non-Fast tier');
    temporary = uuidPath(root, 'launch-smoke-');
    clone = join(temporary, 'repository');
    tree = join(temporary, 'candidate');
    const cloneResult = spawnSync('git', ['clone', '--shared', '--no-checkout', sourceRoot, clone], {
      cwd: root,
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: OUTPUT_LIMIT,
    });
    if (cloneResult.status !== 0)
      throw new Error(cloneResult.stderr?.trim() || cloneResult.error?.message || `git clone exited ${cloneResult.status}`);
    const devRef = `refs/heads/${sourceSettings.integrationBranch}`;
    const remoteDev = `refs/remotes/origin/${sourceSettings.integrationBranch}`;
    try {
      git(clone, 'rev-parse', '--verify', `${remoteDev}^{commit}`);
    } catch {
      git(clone, 'fetch', '--quiet', sourceRoot, `${devRef}:${remoteDev}`);
    }
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
        REZICS_LAUNCH_SMOKE_WORKTREES: join(temporary, 'workers'),
        REZICS_LAUNCH_SMOKE_DEADLINE: String(deadline),
      },
      Math.max(1, remaining + 5_000),
      report,
    );
  } catch (error) {
    const detail = message(error);
    if (/^(?:candidate|setup|start|wake|success): failed:/.test(detail)) throw new Error(detail);
    throw stepFailure(currentStep, error, report);
  } finally {
    if (clone && tree && worktreeAdded) {
      try {
        git(clone, 'worktree', 'remove', '--force', tree);
      } catch {
        /* The disposable repository is removed below. */
      }
    }
    if (clone && branch) {
      try {
        git(clone, 'branch', '-D', branch);
      } catch {
        /* The disposable repository is removed below. */
      }
    }
    if (clone && devTree && devWorktreeAdded) {
      try {
        git(clone, 'worktree', 'remove', '--force', devTree);
      } catch {
        /* The disposable repository is removed below. */
      }
    }
    if (temporary) rmSync(temporary, { recursive: true, force: true });
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

async function waitForCheck(resultPath: string, deadline: number): Promise<Record<string, unknown>> {
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      try {
        const result: unknown = JSON.parse(readFileSync(resultPath, 'utf8'));
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('result is not an object');
        const record = result as Record<string, unknown>;
        if (record.status === 'finished') return record;
      } catch (error) {
        if (error instanceof SyntaxError) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, WAIT_MS));
          continue;
        }
        throw error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, WAIT_MS));
  }
  throw new Error('worker-check result did not arrive before the smoke deadline');
}

function modelRank(model: string): number {
  const value = model.toLowerCase();
  if (value.includes('luna') || value.includes('nano')) return 0;
  if (value.includes('mini')) return 1;
  if (value.includes('sol')) return 2;
  return 3;
}

async function runInnerSmoke(report: Reporter): Promise<void> {
  const tree = resolve(process.env.REZICS_LAUNCH_SMOKE_TREE ?? resolve(import.meta.dir, '../../..'));
  const clone = resolve(process.env.REZICS_LAUNCH_SMOKE_CLONE ?? tree);
  const sourceRoot = resolve(process.env.REZICS_LAUNCH_SMOKE_SOURCE_ROOT ?? tree);
  const localFile = resolve(process.env.REZICS_LAUNCH_SMOKE_LOCAL_FILE ?? join(sourceRoot, '.temp/goal/local.json'));
  const stateDirectory = resolve(process.env.REZICS_LAUNCH_SMOKE_STATE ?? join(tree, '.temp/goal-launch-smoke-state'));
  const worktreeRoot = resolve(process.env.REZICS_LAUNCH_SMOKE_WORKTREES ?? join(tree, '.temp/goal-launch-smoke-workers'));
  const branch = process.env.REZICS_LAUNCH_SMOKE_BRANCH ?? 'launch-smoke';
  const workerCheckScript = resolve(
    process.env.REZICS_LAUNCH_SMOKE_WORKER_CHECK ?? join(tree, 'scripts/worker-check.ts'),
  );
  const deadline = Number(process.env.REZICS_LAUNCH_SMOKE_DEADLINE ?? Date.now() + INNER_BUDGET_MS);
  const importModule = async <T>(path: string): Promise<T> => (await import(pathToFileURL(path).href)) as T;
  const [{ loadSettings }, { readRouting }, { readRiskOwnership, parseBrief }, { openDb }, { WorkerStore }, { WorkerTasks }, { WorkerJob }, { reportsSuccess }] =
    await Promise.all([
      importModule<typeof import('../src/config.ts')>(join(tree, 'tools/goal/src/config.ts')),
      importModule<typeof import('../src/routing.ts')>(join(tree, 'tools/goal/src/routing.ts')),
      importModule<typeof import('../src/briefs.ts')>(join(tree, 'tools/goal/src/briefs.ts')),
      importModule<typeof import('../src/db.ts')>(join(tree, 'tools/goal/src/db.ts')),
      importModule<typeof import('../src/store.ts')>(join(tree, 'tools/goal/src/store.ts')),
      importModule<typeof import('../src/tasks.ts')>(join(tree, 'tools/goal/src/tasks.ts')),
      importModule<typeof import('../src/job.ts')>(join(tree, 'tools/goal/src/job.ts')),
      importModule<typeof import('../src/records.ts')>(join(tree, 'tools/goal/src/records.ts')),
    ]);
  const env = {
    ...process.env,
    GOAL_MAIN_CHECKOUT: clone,
    GOAL_LOCAL_CONFIG: localFile,
    GOAL_STATE_DIRECTORY: stateDirectory,
    GOAL_WORKTREE_ROOT: worktreeRoot,
  };
  const settings = loadSettings({ cwd: tree, env, localFile });
  const remap = (path: string): string => {
    const relativePath = relative(sourceRoot, resolve(path));
    return relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      ? path
      : resolve(tree, relativePath);
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
  if (settings.codex.serviceTier.trim().toLowerCase() === 'fast') throw new Error('Fast service tier is disallowed');
  const routing = readRouting(settings.routingFile);
  const profiles = [
    ...Object.values(routing.classes).flatMap((route) => [route.first, ...(route.fallbacks ?? [])]),
    ...routing.experiments.flatMap((experiment) => experiment.profiles),
    routing.consultation,
  ].filter((profile) => profile.cli === 'codex');
  const codexPools = settings.pools.filter((pool) => pool.cli === 'codex');
  const pinnedPoolClass = routing.classes.implementation.first.cli === 'codex'
    ? routing.classes.implementation.first.poolClass
    : 'codex';
  const selected = profiles
    .filter(
      (profile) =>
        profile.poolClass === pinnedPoolClass && codexPools.some((pool) => pool.classes.includes(pinnedPoolClass)),
    )
    .sort((left, right) => modelRank(left.model) - modelRank(right.model) || left.model.localeCompare(right.model))[0];
  if (!selected) throw new Error('no configured Codex profile has an available Codex pool');
  const model = selected.model;
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const db = openDb(join(stateDirectory, 'goal.sqlite'));
  const store = new WorkerStore(db);
  const tasks = new WorkerTasks(settings, store);
  const landing = { enqueue: () => {} };
  const inbox = { deliver: () => {} };
  const job = new WorkerJob(tasks, landing, inbox, undefined, async () => {});
  let taskId: string | undefined;
  let startPromise: Promise<void> | undefined;
  const launchErrors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    const line = values.map(String).join(' ');
    launchErrors.push(line);
    if (!/Worker systemd scope unavailable; starting without a scope:/.test(line)) originalError(...values);
  };
  try {
    const frontMatter = `---
goal: launch-smoke
kind: implementation
paths: [tools/goal/scripts/launch-smoke.ts]
riskAreas: []
model: ${model}
effort: low
acceptance:
  command: ["true"]
  tests: [smoke]
  failing: true
estimate:
  lines: 1
  files: 1
criticalPath: false
waiting: []
---
Run exactly this command once: \`bun ${JSON.stringify(workerCheckScript)} -- bun -e 'process.stdout.write("launch smoke check passed\\n")'\`.
Do not pass \`--wait\`, poll, or start another check. Return exactly the required result fields. For the wait, use \`{"status":"waiting","summary":"check started","blocker":null,"checks":["<id>"],"approaches":[]}\`, replacing <id> with the id printed by worker-check. When resumed with exit status 0, return \`{"status":"success","summary":"check passed","blocker":null,"checks":[],"approaches":[]}\`. Do not edit files.
`;
    const brief = parseBrief(frontMatter, readRiskOwnership(settings.riskAreasFile));
    const briefPath = join(stateDirectory, 'briefs', `${randomUUID()}.md`);
    mkdirSync(dirname(briefPath), { recursive: true });
    writeFileSync(briefPath, frontMatter, { flag: 'wx' });
    const task = tasks.dispatch(briefPath);
    taskId = task.id;
    if (task.currentAttempt !== 0) throw new Error('smoke task did not start at attempt zero');
    report('setup: passed');

    let currentStep: 'start' | 'wake' | 'success' = 'start';
    try {
      startPromise = job.start(task.id, { expectedAttempt: 0 });
      await withDeadline(startPromise, deadline, 'start');
      const waitingTask = store.task(task.id);
      const waitingAttempt = store.attempt({ taskId: task.id, attempt: waitingTask.currentAttempt });
      if (waitingAttempt.state !== 'waiting') throw new Error(`worker exited as ${waitingAttempt.state}, expected waiting`);
      if (waitingAttempt.exitCode !== 0) throw new Error(`waiting worker exited with code ${String(waitingAttempt.exitCode)}`);
      if (!waitingAttempt.session) throw new Error('waiting attempt did not save its session id');
      if (!waitingAttempt.checks || waitingAttempt.checks.length !== 1 || !CHECK_ID.test(waitingAttempt.checks[0]!))
        throw new Error('waiting attempt did not save one real worker-check UUID');
      if (waitingAttempt.profile.cli !== 'codex' || waitingAttempt.profile.model !== model || waitingAttempt.profile.effort !== 'low')
        throw new Error('worker did not use the selected low-effort Codex profile');
      if (launchErrors.some((line) => /Worker systemd scope unavailable; starting without a scope:/.test(line)))
        throw new Error(launchErrors.find((line) => /Worker systemd scope unavailable; starting without a scope:/.test(line))!);
      report('start: passed');

      currentStep = 'wake';
      const checkId = waitingAttempt.checks[0]!;
      const resultPath = join(waitingTask.worktree, '.temp/goal/checks/results', `${checkId}.json`);
      const checkResult = await withDeadline(waitForCheck(resultPath, deadline), deadline, 'wake');
      if (checkResult.exitCode !== 0 || checkResult.infrastructureFailureFinal === true)
        throw new Error(`worker-check ${checkId} finished with exit ${String(checkResult.exitCode ?? 'unknown')}`);
      const originalSession = waitingAttempt.session;
      await withDeadline(job.recoverOrphans(), deadline, 'wake');
      const resumedTask = store.task(task.id);
      const resumed = store.attempt({ taskId: task.id, attempt: resumedTask.currentAttempt });
      if (resumed.session !== originalSession) throw new Error('wake did not resume the same worker session');
      if (launchErrors.some((line) => /Worker systemd scope unavailable; starting without a scope:/.test(line)))
        throw new Error(launchErrors.find((line) => /Worker systemd scope unavailable; starting without a scope:/.test(line))!);
      report('wake: passed');

      currentStep = 'success';
      if (resumed.exitCode !== 0) throw new Error(`resumed worker exited with code ${String(resumed.exitCode)}`);
      if (resumed.state !== 'exited' || resumed.failureKind || !reportsSuccess(resumed.result))
        throw new Error(`resumed worker did not exit successfully: ${resumed.failureKind ?? resumed.result.slice(-400)}`);
      let exit: Record<string, unknown>;
      try {
        exit = JSON.parse(resumed.result) as Record<string, unknown>;
      } catch {
        throw new Error('resumed worker result was not valid JSON');
      }
      if (exit.status !== 'success') throw new Error('resumed worker did not return status success');
      report('success: passed');
    } catch (error) {
      throw stepFailure(currentStep, error, report);
    }
  } finally {
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
            if (record.status === 'running' && record.runnerHost === hostname() && Number.isSafeInteger(record.runnerPid)) {
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
      if (startPromise) await Promise.race([startPromise.catch(() => {}), new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))]);
    }
    try {
      await job.drain();
    } catch {
      /* The task's failure is already reported with its step. */
    }
    db.close();
  }
}

async function main(): Promise<void> {
  try {
    if (process.argv.includes('--inner')) await runInnerSmoke(reportLine);
    else await runLaunchSmoke();
  } catch (error) {
    const detail = message(error);
    if (/^(?:candidate|setup|start|wake|success): failed:/.test(detail)) return;
    if (process.argv.includes('--inner')) reportLine(`setup: failed: ${detail}`);
    else process.stderr.write(`launch-smoke: ${detail}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
