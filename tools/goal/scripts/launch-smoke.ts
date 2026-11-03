#!/usr/bin/env bun
import { defaultPolicy, readControlPolicy, type ControlPolicy } from '../src/policy.ts';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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
  readSync,
  renameSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadSettings, mainCheckout } from '../src/config.ts';
import { agentAdapter, withAgentAdapter, type AgentAdapter, type AgentLaunchOptions } from '../src/agents.ts';
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
type SmokePolicy = ControlPolicy['launchSmoke'];

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

type SmokeReport = {
  version: 1;
  status: 'running' | 'passed' | 'failed' | 'unverified';
  startedAt: string;
  finishedAt?: string;
  candidate?: string;
  devScriptTree?: string;
  scenarios: ScenarioEvidence[];
  incidents: ExecutedRegression[];
  suiteRegressions: ExecutedRegression[];
  failure?: { step: string; detail: string; classification: 'failure' | 'infrastructure/unverified' };
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

export function requireSmokeWaitingCheckId(checks: unknown): string {
  if (!Array.isArray(checks) || checks.length !== 1 || typeof checks[0] !== 'string' || !CHECK_ID.test(checks[0]))
    throw new Error('waiting result must contain one bare worker-check UUID');
  return checks[0];
}

type Reporter = (line: string) => void;

/** Store bounded diagnostics, never prompts, account configuration, or unrestricted tool arguments. */
export function saveSmokeEvidence(
  path: string,
  evidence: unknown,
  policy: SmokePolicy = defaultPolicy.launchSmoke,
): void {
  let remaining = policy.evidenceBudgetBytes;
  const clean = (value: unknown, depth = 0): unknown => {
    if (remaining <= 0 || depth > policy.evidenceDepth) return '<truncated>';
    remaining -= 16;
    if (typeof value === 'string') {
      const redacted = value
        .replace(/\bsk-[\w-]+/g, '<redacted>')
        .replace(
          /((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret)["']?\s*[:=]\s*)(?:Bearer\s+)?["']?[^\s,"'}]+/gi,
          '$1<redacted>',
        );
      let text = Buffer.from(redacted)
        .subarray(0, Math.max(0, Math.min(policy.evidenceStringBytes, remaining)))
        .toString('utf8');
      while (Buffer.byteLength(JSON.stringify(text)) > Math.max(2, Math.min(policy.evidenceStringBytes, remaining)))
        text = text.slice(0, Math.floor(text.length * 0.75));
      remaining -= Buffer.byteLength(JSON.stringify(text));
      return text;
    }
    if (Array.isArray(value)) return value.slice(0, policy.evidenceArrayItems).map((item) => clean(item, depth + 1));
    if (value && typeof value === 'object') {
      const entries: [string, unknown][] = [];
      for (const [key, item] of Object.entries(value).slice(0, policy.evidenceObjectEntries)) {
        if (remaining <= 0) break;
        remaining -= key.length + 8;
        entries.push([
          key.slice(0, policy.evidenceKeyCharacters),
          /(?:password|secret|api[_-]?key|(?:access|refresh|id)[_-]?token)/i.test(key)
            ? '<redacted>'
            : clean(item, depth + 1),
        ]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  };
  const json = JSON.stringify(clean(evidence), null, 2);
  if (Buffer.byteLength(json) > policy.evidenceBytes) throw new Error('Smoke evidence exceeded its size bound');
  writeFileSync(`${path}.tmp`, json + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function safeSmokeArgv(args: string[]): string[] {
  const safe: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      safe.push('--', '<prompt omitted>');
      break;
    }
    if (arg === '-c') {
      const config = args[++i] ?? '';
      const allowed =
        /^(?:features\.[a-z_]+|model_reasoning_effort|model_auto_compact_token_limit|tool_output_token_limit|background_terminal_max_timeout|service_tier|model_context_window|approval_policy|web_search|project_doc_max_bytes)=([a-z_0-9.-]+|"[a-z_0-9.-]+")$/i;
      safe.push('-c', allowed.test(config) ? config : '<configuration omitted>');
    } else if (['-C', '-m', '-s', '--output-schema', 'resume'].includes(arg)) {
      safe.push(arg, args[++i] ?? '');
    } else safe.push(arg === 'exec' || /^--[a-z-]+$/.test(arg) ? arg : '<argument omitted>');
  }
  return safe;
}

export type SmokeLaunchEvidence = {
  mode: 'start' | 'resume';
  program: string;
  argv: string[];
  profile: AgentLaunchOptions['profile'];
  pool: string;
  worktree: string;
  session: string | null;
  configuredFeatures: Record<string, boolean>;
};
/** Observe the actual adapter return value without changing argv, routing, or session semantics. */
export function observeSmokeAdapter(adapter: AgentAdapter, record: (value: SmokeLaunchEvidence) => void): AgentAdapter {
  const observe = (mode: 'start' | 'resume', options: AgentLaunchOptions, command: [string, string[]]) => {
    const configuredFeatures: Record<string, boolean> = {};
    if (adapter.cli === 'codex') {
      const config = join(options.pool.configDirectory, 'config.toml');
      if (existsSync(config)) {
        const parsed = Bun.TOML.parse(readFileSync(config, 'utf8')) as { features?: Record<string, unknown> };
        for (const [name, value] of Object.entries(parsed.features ?? {}))
          if (typeof value === 'boolean') configuredFeatures[name] = value;
      }
    }
    record({
      mode,
      program: command[0],
      argv: safeSmokeArgv(command[1]),
      profile: options.profile,
      pool: options.pool.name,
      worktree: options.worktree,
      session: options.resumeSession ?? null,
      configuredFeatures,
    });
    return command;
  };
  return {
    ...adapter,
    start(options) {
      return observe('start', options, adapter.start(options));
    },
    resume(options) {
      return observe('resume', { ...options, resumeSession: options.session }, adapter.resume(options));
    },
  };
}

/** Only the current run's bounded suffix; omit raw tool arguments, environment and tool output. */
export function smokeRunSuffix(
  path: string,
  offset: number,
  policy: SmokePolicy = defaultPolicy.launchSmoke,
): unknown[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const start = Math.max(offset, size - policy.logTailBytes);
    const buffer = Buffer.alloc(Math.max(0, size - start));
    const count = readSync(fd, buffer, 0, buffer.length, start);
    let lines = buffer.subarray(0, count).toString('utf8').split(/\r?\n/);
    if (start > offset) lines = lines.slice(1);
    return lines
      .flatMap((line): unknown[] => {
        try {
          const event = JSON.parse(line);
          const item = event.item ?? event.payload ?? {};
          return [
            {
              type: event.type,
              itemType: item.type,
              status: item.status,
              toolName: item.name ?? item.tool_name,
              exitCode: item.exit_code,
              error: event.error?.message ?? item.error?.message,
              text: item.type === 'agent_message' ? item.text : undefined,
              usage: event.usage,
            },
          ];
        } catch {
          return [];
        }
      })
      .slice(-policy.logEvents);
  } finally {
    closeSync(fd);
  }
}

function smokeStderrSuffix(path: string, policy: SmokePolicy): string {
  if (!existsSync(path)) return '';
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, policy.stderrBytes));
    return buffer
      .subarray(0, readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length)))
      .toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function reportLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function message(error: unknown, policy: SmokePolicy = defaultPolicy.launchSmoke): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, policy.diagnosticCharacters);
}

function stepFailure(
  step: string,
  error: unknown,
  report: Reporter,
  policy: SmokePolicy = defaultPolicy.launchSmoke,
): Error {
  const detail = message(error, policy);
  report(`${step}: failed: ${detail}`);
  return new Error(`${step}: ${detail}`);
}

function smokeTools(policy: SmokePolicy) {
  const checked = (
    command: string,
    args: string[],
    cwd: string,
    timeout = policy.commandTimeoutMs,
    env = process.env,
  ): string => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: policy.outputBytes });
    if (result.status !== 0) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `exit ${result.status}`;
      throw new Error(`${command} ${args[0] ?? ''}: ${detail}`);
    }
    return result.stdout.trim();
  };
  return {
    checked,
    git: (cwd: string, ...args: string[]) => checked('git', args, cwd),
    message: (error: unknown) => message(error, policy),
    stepFailure: (step: string, error: unknown, report: Reporter) => stepFailure(step, error, report, policy),
  };
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

function runInnerProcess(
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
    candidate = git(root, 'rev-parse', 'HEAD');
    evidence.candidate = candidate;
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
    const { gateParityScenario } = await import('../src/lifecycle-scenarios.ts');
    const parity = await gateParityScenario({
    policy: settings.policy,
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

async function waitForCheck(
  resultPath: string,
  deadline: number,
  policy: SmokePolicy,
): Promise<Record<string, unknown>> {
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      try {
        const result: unknown = JSON.parse(readFileSync(resultPath, 'utf8'));
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('result is not an object');
        const record = result as Record<string, unknown>;
        if (record.status === 'finished') return record;
      } catch (error) {
        if (error instanceof SyntaxError) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, policy.pollMs));
          continue;
        }
        throw error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, policy.pollMs));
  }
  throw new Error('worker-check result did not arrive before the smoke deadline');
}

async function runInnerSmoke(report: Reporter): Promise<void> {
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
  const lifecycle = await import('../src/lifecycle-scenarios.ts');
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
    if (process.argv.includes('--inner')) await runInnerSmoke(reportLine);
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
