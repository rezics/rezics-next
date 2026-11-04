import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { defaultPolicy, type ControlPolicy } from './policy.ts';

export type BoundedProcessResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
};

export function requireWorkerCheck(script: string): string {
  if (!existsSync(script)) throw new Error(`dev worker-check is required but missing: ${script}`);
  return script;
}

export function parseJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function recordCodexArgv(
  directory: string,
  realCli: string,
  logPath: string,
  maximumInvocations = 2,
  budgetPath = logPath,
): string {
  if (!Number.isSafeInteger(maximumInvocations) || maximumInvocations < 1)
    throw new Error('Codex invocation limit must be a positive integer');
  mkdirSync(directory, { recursive: true });
  const wrapper = join(directory, 'codex-argv-recorder.ts');
  writeFileSync(
    wrapper,
    `#!${process.execPath}\nimport { appendFileSync, existsSync, readFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst args = process.argv.slice(2);\nconst logPath = ${JSON.stringify(logPath)};\nconst budgetPath = ${JSON.stringify(budgetPath)};\nconst previous = existsSync(budgetPath) ? readFileSync(budgetPath, 'utf8').split(/\\r?\\n/).filter(Boolean).length : 0;\nconst record = JSON.stringify(args) + '\\n';\nappendFileSync(logPath, record);\nif (budgetPath !== logPath) appendFileSync(budgetPath, record);\nif (previous >= ${maximumInvocations}) { console.error('lifecycle Codex invocation limit exceeded'); process.exit(125); }\nconst result = spawnSync(${JSON.stringify(realCli)}, args, { stdio: 'inherit', env: process.env });\nif (result.error) { console.error(result.error.message); process.exit(127); }\nprocess.exit(result.status ?? 1);\n`,
    { mode: 0o700 },
  );
  chmodSync(wrapper, 0o700);
  return wrapper;
}

export function recordSystemdRun(
  directory: string,
  policy = defaultPolicy.launchSmoke,
): { path: string; executable: string; logPath: string } {
  const executable = Bun.which('systemd-run', { PATH: process.env.PATH ?? '', cwd: process.cwd() });
  if (!executable) throw new Error('systemd-run is required for lifecycle smoke');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'systemd-run');
  const logPath = join(directory, 'systemd-run-argv.jsonl');
  writeFileSync(
    path,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');\nconst result = spawnSync(${JSON.stringify(executable)}, args, { stdio: 'inherit', env: process.env, timeout: ${policy.systemdCommandTimeoutMs} });\nif (result.error) { console.error(result.error.message); process.exit(127); }\nprocess.exit(result.status ?? 1);\n`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  process.env.PATH = [directory, process.env.PATH].filter(Boolean).join(delimiter);
  return { path, executable, logPath };
}

export function parseWorkerResult(
  value: unknown,
  expectedStatus: 'waiting' | 'success',
  expectedCheckId?: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider result is not an object');
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['approaches', 'blocker', 'checks', 'status', 'summary']))
    throw new Error('provider result did not match the strict worker result schema');
  if (result.status !== expectedStatus || typeof result.summary !== 'string' || result.blocker !== null)
    throw new Error(`provider result did not report ${expectedStatus} with the required fields`);
  if (!Array.isArray(result.approaches) || result.approaches.some((item) => !validApproach(item)))
    throw new Error('provider result approaches did not match the worker result schema');
  if (!Array.isArray(result.checks) || result.checks.some((check) => typeof check !== 'string'))
    throw new Error('provider result checks did not match the worker result schema');
  if (expectedStatus === 'waiting') {
    if (result.checks.length !== 1 || result.checks[0] !== expectedCheckId)
      throw new Error('provider waiting result did not return the real worker-check id');
  } else if (result.checks.length !== 0) {
    throw new Error('provider success result returned unexpected check ids');
  }
  return result;
}

function validApproach(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'approach,result' &&
    typeof record.approach === 'string' &&
    typeof record.result === 'string'
  );
}

export async function runBoundedProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    outputLimit?: number;
    policy?: ControlPolicy['launchSmoke'];
  },
): Promise<BoundedProcessResult> {
  const startedAt = Date.now();
  const policy = options.policy ?? defaultPolicy.launchSmoke;
  const outputLimit = options.outputLimit ?? policy.outputBytes;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  let spawnError: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (current: string, chunk: Buffer): string => {
      const next = Buffer.concat([Buffer.from(current), chunk]);
      return next.byteLength <= outputLimit ? next.toString('utf8') : next.subarray(-outputLimit).toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
    timeout = setTimeout(
      () => {
        timedOut = true;
        signalOwnedProcessGroup(child, 'SIGTERM');
        forceKill = setTimeout(() => signalOwnedProcessGroup(child, 'SIGKILL'), policy.processTerminationGraceMs);
      },
      Math.max(1, options.timeoutMs),
    );
    child.once('error', (error) => {
      spawnError = error.message;
    });
    child.once('close', async (status, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      await cleanupOwnedProcessGroup(child, policy);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(spawnError ? { error: spawnError } : {}),
      });
    });
  });
}

function signalOwnedProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The owned process already exited.
    }
  }
}

async function cleanupOwnedProcessGroup(child: ChildProcess, policy: ControlPolicy['launchSmoke']): Promise<void> {
  if (process.platform === 'win32' || !child.pid || !processGroupExists(child.pid)) return;
  signalOwnedProcessGroup(child, 'SIGTERM');
  const deadline = Date.now() + policy.processCleanupGraceMs;
  while (Date.now() < deadline && processGroupExists(child.pid))
    await new Promise((resolve) => setTimeout(resolve, policy.processCleanupPollMs));
  if (processGroupExists(child.pid)) signalOwnedProcessGroup(child, 'SIGKILL');
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeEvidenceAtomically(path: string, value: unknown, temporaryRoot: string): void {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(temporaryRoot, { recursive: true });
  const temporary = join(temporaryRoot, `evidence-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}
