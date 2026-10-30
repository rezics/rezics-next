import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupMembers, processIdentity, sameProcess, type ProcessIdentity } from './process.ts';

export type ProcessLimits = Readonly<{
  startupMs: number;
  runMs: number;
  budgetMs: number;
  terminationMs: number;
}>;

export const INSTALL_PROCESS_LIMITS: ProcessLimits = {
  startupMs: 15_000,
  runMs: 180_000,
  budgetMs: 180_000,
  terminationMs: 15_000,
};

export const GOAL_GATE_CHECK_LIMITS: ProcessLimits = {
  startupMs: 60_000,
  runMs: 90 * 60_000,
  budgetMs: 90 * 60_000,
  terminationMs: 15_000,
};

type ProcessPhase = 'startup' | 'run' | 'exit' | 'supervisor';
type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  phase: ProcessPhase;
  timedOut: boolean;
  error?: string;
  cleanupError?: string;
  outputTruncated?: boolean;
};

type ProcessRequest = {
  command: string;
  args: string[];
  cwd: string;
  step: string;
  workspace: string;
  limits: ProcessLimits;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
};

export type BoundedProcessOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  step: string;
  workspace?: string;
  limits?: Partial<ProcessLimits>;
  env?: NodeJS.ProcessEnv;
};

export type BoundedProcessOutput = {
  code: number;
  stdout: string;
  stderr: string;
};

export class BoundedProcessError extends Error {
  readonly infrastructure: boolean;
  readonly timedOut: boolean;
  readonly phase: ProcessPhase;
  readonly step: string;
  readonly workspace: string;
  readonly packageName: string | undefined;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly summary: string;

  constructor(options: {
    step: string;
    workspace: string;
    result: ProcessResult;
    stdout: string;
    stderr: string;
    fallbackError?: string;
  }) {
    const { step, workspace, result, stdout, stderr, fallbackError } = options;
    const packageName = packageFromOutput(`${stdout}\n${stderr}`);
    const infra = result.timedOut || result.phase === 'supervisor' || Boolean(result.error || result.cleanupError);
    const labels = [`phase=${result.phase}`, `step=${JSON.stringify(step)}`, `workspace=${JSON.stringify(workspace)}`];
    labels.push(`package=${JSON.stringify(packageName ?? 'unknown')}`);
    const summary = result.timedOut
      ? `ETIMEDOUT: Infrastructure failure: process timed out (${labels.join(', ')})`
      : result.cleanupError
        ? `ETIMEDOUT: Infrastructure failure: process group cleanup failed (${labels.join(', ')}): ${result.cleanupError}`
        : result.phase === 'supervisor' || result.error || fallbackError
          ? `Infrastructure failure: could not start or supervise process (${labels.join(', ')}): ${result.error ?? fallbackError}`
          : `Process failed (${labels.join(', ')}, exit=${result.code ?? result.signal ?? 'unknown'})`;
    const diagnostics = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n');
    super(diagnostics ? `${summary}\n${diagnostics}` : summary);
    this.name = 'BoundedProcessError';
    this.infrastructure = infra;
    this.timedOut = result.timedOut;
    this.phase = result.phase;
    this.step = step;
    this.workspace = workspace;
    this.packageName = packageName;
    this.exitCode = result.code && result.code > 0 ? result.code : infra ? 124 : 1;
    this.stdout = stdout;
    this.stderr = stderr;
    this.summary = summary;
  }
}

const captureLimit = 32 * 1024 * 1024;
function readCapture(path: string): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  if (size <= captureLimit) return readFileSync(path, 'utf8');
  const headLength = Math.floor(captureLimit / 2);
  const tailLength = captureLimit - headLength;
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(headLength);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, head, 0, headLength, 0);
    readSync(fd, tail, 0, tailLength, size - tailLength);
    return `${head.toString('utf8')}\n[process output truncated]\n${tail.toString('utf8')}`;
  } finally {
    closeSync(fd);
  }
}

function packageFromOutput(output: string): string | undefined {
  return /^[ \t]*(?:installing|fetching|downloading)[ \t]+package[ \t]+[`'"<]*(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:@[a-z0-9.+_-]+)?\b/im.exec(
    output,
  )?.[1];
}

function workspaceName(cwd: string, requested?: string): string {
  if (requested) return requested;
  try {
    const value = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name?: unknown };
    if (typeof value.name === 'string' && value.name.trim()) return value.name;
  } catch {
    // A directory without a package manifest still has an exact, useful workspace identity.
  }
  return cwd;
}

function normalizeLimits(input: Partial<ProcessLimits> | undefined): ProcessLimits {
  const limits = { ...INSTALL_PROCESS_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return limits;
}

function groupLeaderIdentity(pid: number): ProcessIdentity | null {
  const active = processIdentity(pid);
  if (active) return active;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!fields[19]) return null;
    return {
      pid,
      start: fields[19],
      boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      group: Number(fields[2]),
    };
  } catch {
    return null;
  }
}

/**
 * Run a setup command under a finite startup, run and termination budget. A supervisor owns the command's detached
 * process group so the synchronous dependency-store callers can still wait for installs without abandoning children.
 */
export function runBoundedInstallProcess(options: BoundedProcessOptions): BoundedProcessOutput {
  if (!options.command || !options.step) throw new Error('A command and exact process step are required');
  const limits = normalizeLimits(options.limits);
  const workspace = workspaceName(options.cwd, options.workspace);
  const scratchRoot = join(options.cwd, '.temp');
  const ownsScratchRoot = mkdirSync(scratchRoot, { recursive: true }) !== undefined;
  let scratch: string;
  try {
    scratch = mkdtempSync(join(scratchRoot, 'goal-install-'));
  } catch (error) {
    if (ownsScratchRoot) {
      try {
        rmdirSync(scratchRoot);
      } catch (cleanupError) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((cleanupError as NodeJS.ErrnoException).code ?? '')) throw cleanupError;
      }
    }
    throw error;
  }
  const requestPath = join(scratch, 'request.json');
  const stdoutPath = join(scratch, 'stdout.log');
  const stderrPath = join(scratch, 'stderr.log');
  const resultPath = join(scratch, 'result.json');
  const request: ProcessRequest = {
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    step: options.step,
    workspace,
    limits,
    stdoutPath,
    stderrPath,
    resultPath,
  };
  let stdout = '';
  let stderr = '';
  let result: ProcessResult | undefined;
  let fallbackError: string | undefined;
  try {
    writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
    const supervisorLimit = limits.budgetMs + limits.terminationMs * 3 + 5_000;
    const supervisor = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--goal-bounded-install-supervisor', requestPath],
      {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        encoding: 'utf8',
        stdio: 'ignore',
        timeout: supervisorLimit,
        killSignal: 'SIGTERM',
        maxBuffer: 1024 * 1024,
      },
    );
    stdout = readCapture(stdoutPath);
    stderr = readCapture(stderrPath);
    try {
      result = JSON.parse(readFileSync(resultPath, 'utf8')) as ProcessResult;
      if (result.outputTruncated) stderr += '\n[process output truncated after 32 MiB]\n';
    } catch {
      fallbackError = supervisor.error?.message ?? supervisor.stderr?.trim() ?? `supervisor exited ${supervisor.status}`;
      result = {
        code: supervisor.status,
        signal: supervisor.signal as NodeJS.Signals | null,
        phase: 'supervisor',
        timedOut: (supervisor.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
        ...(fallbackError ? { error: fallbackError } : {}),
      };
    }
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } finally {
      if (ownsScratchRoot) {
        try {
          rmdirSync(scratchRoot);
        } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
    }
  }
  if (!result || result.timedOut || result.code !== 0 || result.cleanupError || result.error)
    throw new BoundedProcessError({
      step: options.step,
      workspace,
      result: result!,
      stdout,
      stderr,
      ...(fallbackError ? { fallbackError } : {}),
    });
  return { code: result.code, stdout, stderr };
}

function identityMatchesGroup(identity: ProcessIdentity, members: readonly ProcessIdentity[]): void {
  if (members.some((member) => member.boot !== identity.boot || BigInt(member.start) < BigInt(identity.start)))
    throw new Error('process group identity changed');
}

function signalGroup(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  const members = groupMembers(identity.group);
  identityMatchesGroup(identity, members);
  for (const member of members) {
    if (!sameProcess(member)) continue;
    try {
      process.kill(member.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

async function waitForGroupEmpty(identity: ProcessIdentity, deadline: number): Promise<boolean> {
  for (;;) {
    const members = groupMembers(identity.group);
    identityMatchesGroup(identity, members);
    if (!members.length) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, remaining)));
  }
}

async function stopGroup(identity: ProcessIdentity | null, terminationMs: number): Promise<string | undefined> {
  if (!identity) return;
  if (identity.group !== identity.pid || identity.group === processIdentity(process.pid)?.group)
    return 'command did not own a detached process group';
  const deadline = Date.now() + terminationMs;
  try {
    const initial = groupMembers(identity.group);
    identityMatchesGroup(identity, initial);
    if (!initial.length) return;
    signalGroup(identity, 'SIGTERM');
    const termDeadline = deadline - Math.max(1, Math.floor(terminationMs / 2));
    if (await waitForGroupEmpty(identity, termDeadline)) return;
    signalGroup(identity, 'SIGKILL');
    if (await waitForGroupEmpty(identity, deadline)) return;
    return `process group ${identity.group} remained alive after ${terminationMs}ms`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    closed.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function supervise(request: ProcessRequest): Promise<ProcessResult> {
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let identity: ProcessIdentity | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  let externalStop: (() => void) | undefined;
  const budgetDeadline = Date.now() + request.limits.budgetMs;
  let closeResolve!: () => void;
  const closed = new Promise<void>((resolve) => (closeResolve = resolve));
  const onSignal = () => externalStop?.();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    stdoutFd = openSync(request.stdoutPath, 'w', 0o600);
    stderrFd = openSync(request.stderrPath, 'w', 0o600);
    child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) identity = groupLeaderIdentity(child.pid);
    const outputError: string[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;
    const record = (fd: number, chunk: Buffer) => {
      const remaining = captureLimit - (fd === stdoutFd ? stdoutBytes : stderrBytes);
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      const written = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (fd === stdoutFd) stdoutBytes += written.length;
      else stderrBytes += written.length;
      if (written.length < chunk.length) outputTruncated = true;
      try {
        writeSync(fd, written);
      } catch (error) {
        outputError.push(error instanceof Error ? error.message : String(error));
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => record(stdoutFd!, chunk));
    child.stderr?.on('data', (chunk: Buffer) => record(stderrFd!, chunk));
    child.once('close', closeResolve);
    const result = await new Promise<ProcessResult>((resolve) => {
      let finished = false;
      let started = false;
      const finish = (value: ProcessResult) => {
        if (finished) return;
        finished = true;
        if (startupTimer) clearTimeout(startupTimer);
        if (runTimer) clearTimeout(runTimer);
        externalStop = undefined;
        void (async () => {
          if (!identity && child?.pid) identity = groupLeaderIdentity(child.pid);
          let cleanupError: string | undefined;
          if (identity) cleanupError = await stopGroup(identity, request.limits.terminationMs);
          else if (child?.pid && value.timedOut) {
            try {
              child.kill('SIGTERM');
            } catch {}
          }
          const remaining = Math.max(1, request.limits.terminationMs - (Date.now() - cleanupStartedAt));
          if (!(await waitForClose(closed, remaining)))
            cleanupError ??= `command did not close within ${request.limits.terminationMs}ms`;
          const cleanupErrors = [value.cleanupError, outputError.join('; '), cleanupError].filter(Boolean);
          resolve({
            ...value,
            ...(cleanupErrors.length ? { cleanupError: cleanupErrors.join('; ') } : {}),
            ...(outputTruncated ? { outputTruncated: true } : {}),
          });
        })().catch((error) => resolve({ ...value, cleanupError: error instanceof Error ? error.message : String(error) }));
      };
      let cleanupStartedAt = Date.now();
      const stopForSignal = () => {
        cleanupStartedAt = Date.now();
        finish({ code: null, signal: null, phase: 'supervisor', timedOut: true, error: 'supervisor received a termination signal' });
      };
      externalStop = stopForSignal;
      child!.once('spawn', () => {
        started = true;
        if (!identity && child?.pid) identity = groupLeaderIdentity(child.pid);
        if (!identity || identity.group !== child!.pid) {
          cleanupStartedAt = Date.now();
          finish({ code: null, signal: null, phase: 'startup', timedOut: false, error: 'could not identify the detached command process group' });
          return;
        }
        if (startupTimer) clearTimeout(startupTimer);
        const runBudget = budgetDeadline - Date.now();
        if (runBudget <= 0) {
          cleanupStartedAt = Date.now();
          finish({ code: null, signal: null, phase: 'startup', timedOut: true });
          return;
        }
        runTimer = setTimeout(() => {
          cleanupStartedAt = Date.now();
          finish({ code: null, signal: null, phase: 'run', timedOut: true });
        }, Math.min(request.limits.runMs, runBudget));
      });
      child!.once('error', (error) => {
        cleanupStartedAt = Date.now();
        finish({
          code: null,
          signal: null,
          phase: started ? 'run' : 'startup',
          timedOut: false,
          error: `${(error as NodeJS.ErrnoException).code ?? 'spawn'}: ${error.message}`,
        });
      });
      child!.once('exit', (code, signal) => {
        cleanupStartedAt = Date.now();
        finish({
          code,
          signal,
          phase: 'exit',
          timedOut: false,
          ...(outputError.length ? { cleanupError: outputError.join('; ') } : {}),
        });
      });
      startupTimer = setTimeout(() => {
        cleanupStartedAt = Date.now();
        finish({ code: null, signal: null, phase: 'startup', timedOut: true });
      }, Math.min(request.limits.startupMs, request.limits.budgetMs));
    });
    return result;
  } catch (error) {
    if (child && !child.pid) {
      closeResolve();
    }
    return {
      code: null,
      signal: null,
      phase: 'startup',
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
    if (runTimer) clearTimeout(runTimer);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
}

async function runSupervisor(requestPath: string): Promise<void> {
  let result: ProcessResult;
  try {
    const request = JSON.parse(readFileSync(requestPath, 'utf8')) as ProcessRequest;
    result = await supervise(request);
  } catch (error) {
    result = {
      code: null,
      signal: null,
      phase: 'supervisor',
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const request = JSON.parse(readFileSync(requestPath, 'utf8')) as ProcessRequest;
  writeFileSync(request.resultPath, JSON.stringify(result), { mode: 0o600 });
}

if (process.argv[2] === '--goal-bounded-install-supervisor') {
  void runSupervisor(process.argv[3]!).catch((error) => {
    process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
