#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadSettings, mainCheckout } from '../src/config.ts';
import {
  parseJsonLines,
  parseWorkerResult,
  recordCodexArgv,
  recordSystemdRun,
  requireWorkerCheck,
  runBoundedProcess,
  writeEvidenceAtomically,
} from '../src/lifecycle-fixture.ts';
import type { ExecutedRegression, ScenarioEvidence } from '../src/lifecycle-scenarios.ts';

const CHECK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WAIT_MS = 100;
const INNER_BUDGET_MS = 270_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;

export type SmokeOptions = {
  root?: string;
  report?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  reportPath?: string;
};

type SmokeReport = {
  version: 1;
  status: 'running' | 'passed' | 'failed' | 'unverified';
  startedAt: string;
  finishedAt?: string;
  candidate?: string;
  scenarios: ScenarioEvidence[];
  incidents: ExecutedRegression[];
  suiteRegressions: ExecutedRegression[];
  failure?: { step: string; detail: string; classification: 'failure' | 'infrastructure/unverified' };
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

function checked(command: string, args: string[], cwd: string, timeout = 30_000, env = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: OUTPUT_LIMIT });
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

export function resolveSmokeReportPath(root: string, requested?: string): string {
  const canonicalRoot = realpathSync(root);
  const path = resolve(canonicalRoot, requested ?? join('.temp/goal/lifecycle-smoke', `report-${randomUUID()}.json`));
  const fromRoot = relative(canonicalRoot, path);
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`))
    throw new Error('lifecycle report path must stay inside the worktree');
  let component = canonicalRoot;
  for (const part of fromRoot.split(sep).filter(Boolean)) {
    component = join(component, part);
    try {
      if (lstatSync(component).isSymbolicLink())
        throw new Error('lifecycle report path cannot traverse a symbolic link');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return path;
}

function persistReport(root: string, path: string, report: SmokeReport): void {
  writeEvidenceAtomically(path, report, join(root, '.temp/goal/lifecycle-smoke'));
}

function readReport(path: string): SmokeReport {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('lifecycle report is not an object');
  const report = value as SmokeReport;
  if (!Array.isArray(report.scenarios) || !Array.isArray(report.incidents) || !Array.isArray(report.suiteRegressions))
    throw new Error('lifecycle report is missing its evidence arrays');
  return report;
}

function upsertScenario(report: SmokeReport, scenario: ScenarioEvidence): void {
  report.scenarios = report.scenarios.filter(({ id }) => id !== scenario.id);
  report.scenarios.push(scenario);
}

function timeoutFailure(error: unknown): boolean {
  return /ETIMEDOUT|capacity timeout|infrastructure\/unverified|exceeded .*budget|deadline|timed? ?out|timeout/i.test(
    message(error),
  );
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

export function parseProviderObject(text: string, label: string): Record<string, unknown> {
  const candidates = [text.trim(), ...text.trim().split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (isWorkerResultObject(record)) return record;
      const events = [record, record.item, record.payload, record.message];
      for (const event of events) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
        const item = event as Record<string, unknown>;
        if (item.type !== 'agent_message' || typeof item.text !== 'string') continue;
        try {
          const response: unknown = JSON.parse(item.text);
          if (response && typeof response === 'object' && !Array.isArray(response)) {
            const result = response as Record<string, unknown>;
            if (isWorkerResultObject(result)) return result;
          }
        } catch {
          // The strict provider response must be a JSON object inside the Codex agent_message event.
        }
      }
    } catch {
      // Codex may surround a strict JSON answer with JSONL event framing; try the next complete line.
    }
  }
  throw new Error(`${label} did not return a JSON result object`);
}

function isWorkerResultObject(value: Record<string, unknown>): boolean {
  const keys = ['approaches', 'blocker', 'checks', 'status', 'summary'];
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

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

async function stopWorkerCheck(resultPath: string): Promise<void> {
  if (!existsSync(resultPath)) return;
  try {
    const record = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    const pid = Number(record.runnerPid);
    if (
      record.status !== 'running' ||
      record.runnerHost !== hostname() ||
      !Number.isSafeInteger(pid) ||
      pid <= 0
    )
      return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      process.kill(pid, 'SIGTERM');
    }
    await delay(500);
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
      timeoutMs: Math.min(30_000, Math.max(1, deadline - Date.now())),
    },
  );
  const id = /check: id ([0-9a-f-]{36})/i.exec(start.stdout)?.[1];
  if (start.timedOut) {
    if (id && CHECK_ID.test(id)) await stopWorkerCheck(join(tree, '.temp/goal/checks/results', `${id}.json`));
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
      timeoutMs: Math.min(30_000, Math.max(1, deadline - Date.now())),
    });
    if (wait.timedOut) throw new Error('capacity timeout: dev worker-check wait is infrastructure/unverified');
    if (wait.error || wait.status !== 0)
      throw new Error(`dev worker-check wait failed: ${wait.stderr.trim() || wait.error || wait.status}`);
    const terminal = await waitForCheck(resultPath, deadline);
    if (terminal.infrastructureFailureFinal === true || terminal.infrastructureFailure)
      throw new Error(`capacity timeout: dev worker-check infrastructure failure: ${String(terminal.infrastructureFailure ?? 'final infrastructure failure')}`);
    if (terminal.id !== id || terminal.status !== 'finished' || terminal.exitCode !== 0)
      throw new Error('dev worker-check did not persist a passing terminal result record');
    if (terminal.log !== first.log) throw new Error('dev worker-check changed its recorded log between start and finish');
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
    await stopWorkerCheck(resultPath);
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
    !has(start, '--json', '-m', options.model, '-c', `model_reasoning_effort=${options.effort}`, '-C', options.worktree) ||
    !has(start, '-c', tier) ||
    schemaIndex < 0 ||
    start[schemaIndex + 1] !== options.schema ||
    start.includes('resume')
  )
    throw new Error('actual Codex start argv did not preserve the selected model, effort, service tier, schema, and worktree');
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
    throw new Error('actual Codex resume argv did not preserve exec option order, session, selected settings, and schema');
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
  return runRealSmoke(root, report, options.reportPath);
}

async function runFakeSmoke(
  agent: string,
  root: string,
  report: Reporter,
  suppliedEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const directory = uuidPath(root, 'launch-smoke-test-');
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
      const sourceSettings = loadSettings({ cwd: root });
      git(directory, 'init', '--quiet');
      clone = join(directory, 'repository');
      const cloned = spawnSync('git', ['clone', '--shared', '--no-checkout', sourceRoot, clone], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: OUTPUT_LIMIT,
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
        30_000,
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
      const start = fakeStep(agent, 'start', baseEnv);
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
        if (!Array.isArray(waiting.checks) || waiting.checks.length !== 1 || typeof waiting.checks[0] !== 'string')
          throw new Error('expected one worker-check id');
        checkId = waiting.checks[0];
        baseEnv.REZICS_SMOKE_CHECK_ID = checkId;
        if (!CHECK_ID.test(checkId) || checkId !== startedCheckId)
          throw new Error('fake agent did not return the real worker-check id');
      } else if (!/^worker-check-[\w-]+$/.test(checkId)) {
        throw new Error('fake worker-check id has an invalid shape');
      }
      passed.push('start: passed');
    } catch (error) {
      throw stepFailure('start', error, report);
    }

    try {
      const result = await waitForCheck(resultPath, Date.now() + 10_000);
      if (result.status !== 'finished' || result.exitCode !== 0) throw new Error('worker-check result did not pass');
      const wake = fakeStep(agent, 'wake', baseEnv);
      if (wake.error || wake.status !== 0) throw new Error(wake.stderr || wake.error?.message || `exit ${wake.status}`);
      if (!wake.stdout.includes('result passed')) throw new Error('wake did not receive the passing check result');
      passed.push('wake: passed');
    } catch (error) {
      throw stepFailure('wake', error, report);
    }

    try {
      const success = fakeStep(agent, 'success', baseEnv);
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
    if (resultPath) await waitForCheck(resultPath, Date.now() + 10_000).catch(() => {});
    if (clone && devTree && devWorktreeAdded) {
      try {
        checked('git', ['worktree', 'remove', '--force', devTree], clone, 2000);
      } catch {
        /* The disposable clone is removed below. */
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function runInnerProcess(tree: string, env: NodeJS.ProcessEnv, timeoutMs: number, report: Reporter): Promise<number> {
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
      return next.byteLength <= OUTPUT_LIMIT ? next.toString('utf8') : next.subarray(-OUTPUT_LIMIT).toString('utf8');
    };
    const reportBounded = (line: string) => {
      if (reportedBytes >= OUTPUT_LIMIT) {
        if (!outputTruncated) report('[inner output truncated after 2 MiB]');
        outputTruncated = true;
        return;
      }
      const remaining = OUTPUT_LIMIT - reportedBytes - 1;
      if (remaining <= 0) {
        if (!outputTruncated) report('[inner output truncated after 2 MiB]');
        outputTruncated = true;
        return;
      }
      const bytes = Buffer.from(line);
      let bounded = bytes.byteLength <= remaining ? line : bytes.subarray(0, remaining).toString('utf8');
      while (Buffer.byteLength(bounded) > remaining) bounded = bounded.slice(0, -1);
      report(bounded);
      reportedBytes += Buffer.byteLength(bounded) + 1;
      if (Buffer.byteLength(bounded) < bytes.byteLength) {
        if (!outputTruncated) report('[inner output truncated after 2 MiB]');
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
    const timer = setTimeout(() => {
      timedOut = true;
      signalChildGroup(child, 'SIGTERM');
      forceKill = setTimeout(() => signalChildGroup(child, 'SIGKILL'), 3000);
    }, Math.max(1, timeoutMs));
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
        const failedStep = output.match(/(?:candidate|setup|start|wake|success|lifecycle regressions): failed:[^\r\n]*/)?.[0];
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

async function runRealSmoke(root: string, report: Reporter, requestedReportPath?: string): Promise<void> {
  let currentStep = 'candidate';
  const startedAt = Date.now();
  const deadline = startedAt + INNER_BUDGET_MS;
  const evidencePath = resolveSmokeReportPath(root, requestedReportPath);
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
  let clone = '';
  let tree = '';
  let devTree = '';
  let branch = '';
  let worktreeAdded = false;
  let devWorktreeAdded = false;
  persistReport(root, evidencePath, evidence);
  report(`evidence: ${evidencePath}`);
  try {
    const candidate = git(root, 'rev-parse', 'HEAD');
    evidence.candidate = candidate;
    persistReport(root, evidencePath, evidence);
    git(root, 'diff', '--quiet', 'HEAD', '--');
    const sourceRoot = mainCheckout(root);
    const sourceSettings = loadSettings({ cwd: root });
    temporary = uuidPath(root, 'launch-smoke-');
    workerRoot = uuidPath(root, 'launch-smoke-workers-');
    clone = join(temporary, 'repository');
    tree = join(temporary, 'candidate');
    const cloneResult = spawnSync('git', ['clone', '--shared', '--no-checkout', sourceRoot, clone], {
      cwd: root,
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: OUTPUT_LIMIT,
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
        REZICS_LAUNCH_SMOKE_WORKTREES: workerRoot,
        REZICS_LAUNCH_SMOKE_DEADLINE: String(deadline),
        REZICS_LAUNCH_SMOKE_REPORT_PATH: evidencePath,
      },
      Math.max(1, remaining + 5_000),
      report,
    );
    const completed = readReport(evidencePath);
    if (completed.status !== 'passed') throw new Error('inner lifecycle suite exited without complete passing evidence');
    report(`evidence: ${evidencePath}`);
  } catch (error) {
    const detail = message(error);
    const reportedStep = /^(candidate|setup|start|wake|success|lifecycle regressions): failed:/.exec(detail)?.[1];
    if (reportedStep) currentStep = reportedStep;
    try {
      const current = existsSync(evidencePath) ? readReport(evidencePath) : evidence;
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
      persistReport(root, evidencePath, current);
    } catch {
      // Keep the original smoke failure as the actionable error.
    }
    if (reportedStep) throw new Error(detail);
    throw stepFailure(currentStep, error, report);
  } finally {
    if (temporary) cleanupSmokeScopes(join(temporary, 'state/systemd-bin/systemd-run-argv.jsonl'));
    if (clone && tree && worktreeAdded) {
      try {
        checked('git', ['worktree', 'remove', '--force', tree], clone, 2000);
      } catch {
        /* The disposable repository is removed below. */
      }
    }
    if (clone && branch) {
      try {
        checked('git', ['branch', '-D', branch], clone, 2000);
      } catch {
        /* The disposable repository is removed below. */
      }
    }
    if (clone && devTree && devWorktreeAdded) {
      try {
        checked('git', ['worktree', 'remove', '--force', devTree], clone, 2000);
      } catch {
        /* The disposable repository is removed below. */
      }
    }
    if (workerRoot) {
      try {
        rmSync(workerRoot, { recursive: true, force: true });
      } catch (error) {
        report(`cleanup: retained worker data at ${workerRoot}: ${message(error)}`);
      }
    }
    if (temporary) {
      try {
        rmSync(temporary, { recursive: true, force: true });
      } catch (error) {
        report(`cleanup: retained disposable data at ${temporary}: ${message(error)}`);
      }
    }
  }
}

function cleanupSmokeScopes(path: string): void {
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
    spawnSync('systemctl', ['--user', 'stop', unit], { encoding: 'utf8', timeout: 5000, maxBuffer: OUTPUT_LIMIT });
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

async function runInnerSmoke(report: Reporter): Promise<void> {
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
  const deadline = Number(process.env.REZICS_LAUNCH_SMOKE_DEADLINE ?? Date.now() + INNER_BUDGET_MS);
  const reportPath = resolve(
    process.env.REZICS_LAUNCH_SMOKE_REPORT_PATH ?? join(tree, '.temp/goal/lifecycle-smoke/report.json'),
  );
  const evidence: SmokeReport = existsSync(reportPath)
    ? readReport(reportPath)
    : { version: 1, status: 'running', startedAt: new Date().toISOString(), scenarios: [], incidents: [], suiteRegressions: [] };
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
  const routing = readRouting(settings.routingFile);
  const selected = routing.classes.specification.first;
  if (selected.cli !== 'codex') throw new Error('the configured specification route must select Codex for real provider smoke');
  const codexPools = settings.pools.filter(
    (pool) => pool.cli === 'codex' && pool.classes.includes(selected.poolClass),
  );
  if (!codexPools.length) throw new Error(`no configured Codex pool admits route class ${selected.poolClass}`);
  const model = selected.model;
  const effort = selected.effort;
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const originalPath = process.env.PATH;
  const systemdRecorder = recordSystemdRun(join(stateDirectory, 'systemd-bin'));
  const codexLogDirectory = join(stateDirectory, 'codex-argv');
  mkdirSync(codexLogDirectory, { recursive: true });
  const codexLogs = new Map<string, string>();
  const codexInvocationBudget = join(codexLogDirectory, 'invocation-budget.jsonl');
  for (const [index, pool] of codexPools.entries()) {
    const executable = Bun.which(pool.command);
    if (!executable) throw new Error(`configured Codex executable is unavailable for pool ${pool.name}: ${pool.command}`);
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
  const systemdProbe = new WorkerSlice().launch(
    'lifecycle-smoke-preflight',
    0,
    process.execPath,
    ['-e', 'process.stdout.write("lifecycle systemd scope passed\\n")'],
    { cwd: tree, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    () => false,
    (line: string) => systemdErrors.push(line),
  );
  if (systemdErrors.length) throw new Error(systemdErrors[0]!);
  if (systemdProbe.error || systemdProbe.status !== 0)
    throw new Error(`real systemd worker scope failed: ${systemdProbe.stderr?.toString().trim() || systemdProbe.error?.message || systemdProbe.status}`);
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

  const workerCheckEvidence = await exerciseWorkerCheck(tree, workerCheckScript, deadline);
  upsertScenario(evidence, {
    id: 'dev-worker-check-start-and-result-records',
    status: 'passed',
    evidence: workerCheckEvidence,
  });
  persistEvidence();
  report('worker-check-boundary: passed');

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
kind: specification
paths: [tools/goal/scripts/launch-smoke.ts]
riskAreas: []
model: ${model}
effort: ${effort}
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
Use at most 2000 generated tokens for this task. Run exactly this command once: \`bun ${JSON.stringify(workerCheckScript)} --local -- bun -e 'setTimeout(() => console.log("launch smoke check passed"), 7000)'\`.
Do not poll or start another check. Return exactly the required result fields. For the wait, use \`{"status":"waiting","summary":"check started","blocker":null,"checks":["<id>"],"approaches":[]}\`, replacing <id> with the id printed by worker-check. When resumed with exit status 0, return \`{"status":"success","summary":"check passed","blocker":null,"checks":[],"approaches":[]}\`. Do not edit files.
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
      if (waitingAttempt.state !== 'waiting')
        throw new Error(
          `worker exited as ${waitingAttempt.state}, expected waiting (exitCode=${String(waitingAttempt.exitCode)}, failureKind=${waitingAttempt.failureKind ?? 'none'}, reportsSuccess=${reportsSuccess(waitingAttempt.result)})`,
        );
      if (waitingAttempt.exitCode !== 0)
        throw new Error(`waiting worker exited with code ${String(waitingAttempt.exitCode)}`);
      if (!waitingAttempt.session) throw new Error('waiting attempt did not save its session id');
      if (!waitingAttempt.checks || waitingAttempt.checks.length !== 1 || !CHECK_ID.test(waitingAttempt.checks[0]!))
        throw new Error('waiting attempt did not save one real worker-check UUID');
      if (
        waitingAttempt.profile.cli !== 'codex' ||
        waitingAttempt.profile.model !== model ||
        waitingAttempt.profile.effort !== effort
      )
        throw new Error('worker did not use the configured specification Codex profile');
      const waitingResult = parseWorkerResult(
        parseProviderObject(readLogTail(waitingAttempt.logPath), 'waiting'),
        'waiting',
        waitingAttempt.checks[0],
      );
      if (launchErrors.some((line) => /Worker systemd scope unavailable; starting without a scope:/.test(line)))
        throw new Error(
          launchErrors.find((line) => /Worker systemd scope unavailable; starting without a scope:/.test(line))!,
        );
      report('start: passed');

      currentStep = 'wake';
      const checkId = waitingAttempt.checks[0]!;
      const resultPath = join(waitingTask.worktree, '.temp/goal/checks/results', `${checkId}.json`);
      const checkResult = await withDeadline(waitForCheck(resultPath, deadline), deadline, 'wake');
      if (checkResult.infrastructureFailureFinal === true || checkResult.infrastructureFailure)
        throw new Error(
          `capacity timeout: worker-check ${checkId} infrastructure failure: ${String(checkResult.infrastructureFailure ?? 'final infrastructure failure')}`,
        );
      if (checkResult.exitCode !== 0)
        throw new Error(`worker-check ${checkId} finished with exit ${String(checkResult.exitCode ?? 'unknown')}`);
      const originalSession = waitingAttempt.session;
      await withDeadline(job.recoverOrphans(), deadline, 'wake');
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
          `resumed worker did not exit successfully: ${resumed.failureKind ?? resumed.result.slice(-400)}`,
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
        model,
        effort,
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
          profile: { model, effort, serviceTier: settings.codex.serviceTier },
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
      let failure: unknown = error;
      try {
        if (taskId) {
          const task = store.task(taskId);
          const attempt = store.attempt({ taskId, attempt: task.currentAttempt });
          const details = [
            readLogTail(attempt.logPath),
            readLogTail(`${attempt.logPath}.err`),
          ]
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
          new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
        ]);
    }
    try {
      await job.drain();
    } catch {
      /* The task's failure is already reported with its step. */
    }
    db.close();
  }

  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  const lifecycle = await import('../src/lifecycle-scenarios.ts');
  try {
    const { incidents, suite } = await lifecycle.runNamedLifecycleRegressions({
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
      throw new Error(`lifecycle suite regressions are incomplete: ${missingSuiteTests.map(({ id }) => id).join(', ')}`);
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

function persistFailureLog(reportPath: string, step: string, contents: string): string {
  const filename = `lifecycle-${step.replace(/[^a-z0-9.-]+/gi, '-')}-${randomUUID()}.log`;
  const path = join(dirname(reportPath), filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${contents}\n`, { mode: 0o600 });
  return path;
}

export function parseSmokeArguments(args: string[]): SmokeOptions {
  const options: SmokeOptions = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value !== '--report') throw new Error(`unknown launch-smoke argument: ${value}`);
    const path = args[++index];
    if (!path) throw new Error('--report requires a path');
    if (options.reportPath) throw new Error('--report can be supplied only once');
    options.reportPath = path;
  }
  return options;
}

export async function main(runSmoke?: () => Promise<void>): Promise<number> {
  try {
    if (process.argv.includes('--inner')) await runInnerSmoke(reportLine);
    else if (runSmoke) await runSmoke();
    else await runLaunchSmoke(undefined, parseSmokeArguments(process.argv.slice(2)));
    return 0;
  } catch (error) {
    const detail = message(error);
    if (/^(?:candidate|setup|start|wake|success|lifecycle regressions): failed:/.test(detail)) return 1;
    if (process.argv.includes('--inner')) reportLine(`setup: failed: ${detail}`);
    else process.stderr.write(`launch-smoke: ${detail}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
