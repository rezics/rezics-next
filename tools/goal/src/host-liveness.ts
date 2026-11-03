import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import { cleanManagedProviderEnvironment } from './agents.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';

export type HostLivenessConfig = {
  stateDirectory: string;
  managerSocket: string;
  mainCheckout: string;
  command: string[];
  /** Preserve the invoking CLI's working directory, including relative local configuration paths. */
  launchDirectory?: string;
  policy?: ControlPolicy['host'];
  pollMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
};
type HostState = { identity: ProcessIdentity; desired: boolean };
type RetryState = { failures: number; nextAt: number };
const statePath = (directory: string) => join(directory, 'manager-host-liveness.json');
const retryPath = (directory: string) => join(directory, 'manager-host-liveness-retry.json');
export const supervisorLeasePath = (directory: string) => join(directory, 'manager-host-supervisor.lease');
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type StartupLogEvidence =
  | { kind: 'available'; content: string; totalBytes: number; shownBytes: number; truncated: boolean }
  | { kind: 'unavailable'; reason: string };

function readStartupLog(fd: number, launchOffset: number, limit: number): StartupLogEvidence {
  try {
    const size = fstatSync(fd).size;
    if (size < launchOffset) return { kind: 'unavailable', reason: 'the log shrank before diagnostics were read' };
    const totalBytes = size - launchOffset;
    const buffer = Buffer.allocUnsafe(Math.min(totalBytes, limit));
    if (buffer.length === 0) return { kind: 'available', content: '', totalBytes, shownBytes: 0, truncated: false };
    const shownBytes = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return {
      kind: 'available',
      content: buffer.subarray(0, shownBytes).toString('utf8'),
      totalBytes,
      shownBytes,
      truncated: shownBytes < totalBytes,
    };
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

function startupExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  logPath: string,
  logFd: number,
  launchOffset: number,
  policy: ControlPolicy['host'],
): Error {
  const outcome = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
  const evidence = readStartupLog(logFd, launchOffset, policy.startupLogBytes);
  const output =
    evidence.kind === 'unavailable'
      ? `Current launch output unavailable: ${evidence.reason}`
      : evidence.totalBytes === 0
        ? 'Current launch output complete (0 bytes; no output recorded).'
        : `Current launch output ${
            evidence.truncated
              ? `truncated; showing ${evidence.shownBytes} of ${evidence.totalBytes} bytes`
              : `complete; showing ${evidence.shownBytes} of ${evidence.totalBytes} bytes`
          }:\n${evidence.content.trimEnd() || '(no readable text)'}`;
  return new Error(`Manager host exited with ${outcome} during startup; log path: ${logPath}\n${output}`);
}

function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isRetryState(value: unknown, maximumFailures: number): value is RetryState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const retry = value as Record<string, unknown>;
  return (
    typeof retry.failures === 'number' &&
    Number.isSafeInteger(retry.failures) &&
    retry.failures >= 0 &&
    retry.failures <= maximumFailures &&
    typeof retry.nextAt === 'number' &&
    Number.isSafeInteger(retry.nextAt) &&
    retry.nextAt >= 0
  );
}

function boundedDiagnostic(value: string, limit: number): string {
  const text = value.replace(/[\r\n\t]+/g, ' ');
  // Reserve the ellipsis width when the configured budget is too small for the complete diagnostic.
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}${'...'.slice(0, limit)}`;
}

function repairRetryState(path: string, reason: string, maximum: number, policy: ControlPolicy['host']): RetryState {
  const retry = {
    failures: policy.retryFailures,
    nextAt: Math.min(Number.MAX_SAFE_INTEGER, Date.now() + maximum),
  };
  writeJson(path, retry);
  console.error(
    `Malformed manager host retry journal ${boundedDiagnostic(path, policy.retryDiagnosticCharacters)}: ${boundedDiagnostic(reason, policy.retryDiagnosticCharacters)}; replaced with a persisted maximum backoff (${maximum}ms). Inspect the journal if this repeats.`,
  );
  return retry;
}

function readRetryState(path: string, maximum: number, policy: ControlPolicy['host']): RetryState {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { failures: 0, nextAt: 0 };
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return repairRetryState(path, reason, maximum, policy);
  }
  if (isRetryState(value, policy.retryFailures)) return value;
  return repairRetryState(
    path,
    `expected failures from 0 to ${policy.retryFailures} and a non-negative safe integer nextAt`,
    maximum,
    policy,
  );
}

/** Called only under the host lease; identities include boot and start time, never just a PID. */
export function recordHostLiveness(directory: string, desired: boolean): void {
  const identity = processIdentity();
  if (!identity) throw new Error('Cannot identify manager host');
  writeJson(statePath(directory), { identity, desired });
}

async function socketReady(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** All launchers share a startup lease, and the host itself still owns its existing socket lease. */
export async function ensureHostRunning(config: HostLivenessConfig): Promise<void> {
  const policy = config.policy ?? defaultPolicy.host;
  if (await socketReady(config.managerSocket, policy.socketTimeoutMs)) return;
  const deadline = Date.now() + policy.startupTimeoutMs;
  let lease;
  for (;;) {
    try {
      lease = acquireDirectoryLease(join(config.stateDirectory, 'manager-host-start.lease'));
      break;
    } catch (error) {
      if (!(error instanceof LeaseHeldError) || Date.now() >= deadline) throw error;
      await pause(policy.leasePollMs);
      if (await socketReady(config.managerSocket, policy.socketTimeoutMs)) return;
    }
  }
  try {
    if (await socketReady(config.managerSocket, policy.socketTimeoutMs)) return;
    // A live host that has not listened yet (or is shutting down) must retain sole ownership.
    for (;;) {
      let probe;
      try {
        probe = acquireDirectoryLease(`${config.managerSocket}.lease`);
      } catch (error) {
        if (!(error instanceof LeaseHeldError) || Date.now() >= deadline) throw error;
        await pause(policy.leasePollMs);
        if (await socketReady(config.managerSocket, policy.socketTimeoutMs)) return;
        continue;
      }
      probe.release();
      break;
    }
    const logPath = join(config.stateDirectory, 'manager-host.log');
    const log = openSync(logPath, 'a+', 0o600);
    try {
      const launchOffset = fstatSync(log).size;
      const child = spawn(config.command[0]!, [...config.command.slice(1), '_manager-host'], {
        cwd: config.launchDirectory ?? process.cwd(),
        env: cleanManagedProviderEnvironment(process.env),
        detached: true,
        stdio: ['ignore', 'pipe', log],
      });
      await new Promise<void>((resolve, reject) => {
        const lines = createInterface({ input: child.stdout! });
        const timeout = setTimeout(
          () => {
            child.kill();
            finish(new Error('Manager host startup timed out'));
          },
          Math.max(1, deadline - Date.now()),
        );
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
          finish(startupExitError(code, signal, logPath, log, launchOffset, policy));
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          lines.close();
          child.off('error', onError);
          child.off('exit', onExit);
          child.stdout!.destroy();
          if (error) reject(error);
          else {
            child.unref();
            resolve();
          }
        };
        child.once('error', onError);
        child.once('exit', onExit);
        lines.once('line', (line) => {
          if (line === 'ready') finish();
          else {
            child.kill();
            finish(new Error(`Manager host startup: ${line}`));
          }
        });
      });
    } finally {
      closeSync(log);
    }
  } finally {
    lease.release();
  }
}

/** Independent process: no host timer, provider request or worker sweep is needed to detect a dead host. */
export async function superviseHost(
  config: HostLivenessConfig,
  signal?: AbortSignal,
  onReady?: () => void,
): Promise<void> {
  const policy = config.policy ?? defaultPolicy.host;
  const poll = config.pollMs ?? policy.pollMs;
  const minimum = config.minBackoffMs ?? policy.minBackoffMs;
  const maximum = config.maxBackoffMs ?? policy.maxBackoffMs;
  if (![poll, minimum, maximum].every((value) => Number.isSafeInteger(value) && value > 0) || maximum < minimum)
    throw new Error('Host liveness intervals must be positive bounded milliseconds');
  // A detached launcher may arrive after teardown. Acquiring a lease would recreate removed state.
  if (!existsSync(config.stateDirectory)) {
    onReady?.();
    return;
  }
  let lease;
  try {
    lease = acquireDirectoryLease(supervisorLeasePath(config.stateDirectory));
  } catch (error) {
    if (error instanceof LeaseHeldError) {
      onReady?.();
      return;
    }
    throw error;
  }
  let healthySince = Date.now();
  try {
    onReady?.();
    while (!signal?.aborted && existsSync(config.stateDirectory)) {
      const host = readJson<HostState>(statePath(config.stateDirectory));
      if (!host?.desired) return;
      if (sameProcess(host.identity)) {
        if (Date.now() - healthySince >= policy.healthResetMs && existsSync(retryPath(config.stateDirectory)))
          rmSync(retryPath(config.stateDirectory), { force: true });
      } else {
        healthySince = Date.now();
        const now = Date.now();
        const retry = readRetryState(retryPath(config.stateDirectory), maximum, policy);
        if (!retry.nextAt) {
          writeJson(retryPath(config.stateDirectory), { failures: retry.failures, nextAt: now + minimum });
        } else if (now >= retry.nextAt) {
          // Persist before launching, so supervisor replacement cannot reset a crash loop's backoff.
          const failures = Math.min(policy.retryFailures, retry.failures + 1);
          // Each failed launch doubles the delay, capped by the configured maximum.
          const delay = Math.min(maximum, minimum * 2 ** failures);
          writeJson(retryPath(config.stateDirectory), { failures, nextAt: now + delay });
          try {
            await ensureHostRunning(config);
          } catch (error) {
            console.error('manager host liveness restart failed:', error);
          }
        }
      }
      await pause(poll);
    }
  } finally {
    lease.release();
  }
}

export async function startHostSupervisor(config: HostLivenessConfig): Promise<void> {
  if (!existsSync(config.stateDirectory)) return;
  // A live lease owner is sufficient; never scan processes or replace a live supervisor.
  let probe;
  try {
    probe = acquireDirectoryLease(supervisorLeasePath(config.stateDirectory));
  } catch (error) {
    if (error instanceof LeaseHeldError) return;
    throw error;
  }
  probe.release();
  const log = openSync(join(config.stateDirectory, 'manager-host-supervisor.log'), 'a', 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        import.meta.filename,
        '--detach',
        JSON.stringify({
          ...config,
          stateDirectory: resolve(config.stateDirectory),
          managerSocket: resolve(config.managerSocket),
          mainCheckout: resolve(config.mainCheckout),
          launchDirectory: resolve(config.launchDirectory ?? process.cwd()),
        }),
      ],
      {
        cwd: config.launchDirectory ?? process.cwd(),
        env: cleanManagedProviderEnvironment(process.env),
        detached: true,
        stdio: ['ignore', log, log],
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`Host supervisor launcher exited (${code ?? signal})`)),
      );
    });
  } finally {
    closeSync(log);
  }
}

if (import.meta.main) {
  if (process.argv[2] === '--detach') {
    const config: HostLivenessConfig = JSON.parse(process.argv[3]!);
    const policy = config.policy ?? defaultPolicy.host;
    // Reparent the supervisor before host readiness: it must survive its host and not join provider child ownership.
    const child = spawn(process.execPath, [import.meta.filename, process.argv[3]!], {
      env: cleanManagedProviderEnvironment(process.env),
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error('Host supervisor startup timed out'));
      }, policy.supervisorStartupTimeoutMs);
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        finish(new Error(`Host supervisor exited before ready (${code ?? signal})`));
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        lines.close();
        child.off('error', onError);
        child.off('exit', onExit);
        child.stdout!.destroy();
        if (error) reject(error);
        else {
          child.unref();
          resolve();
        }
      };
      child.once('error', onError);
      child.once('exit', onExit);
      lines.once('line', (line) => {
        if (line === 'ready') finish();
        else {
          child.kill();
          finish(new Error(`Host supervisor startup: ${line}`));
        }
      });
    });
  } else {
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort());
    process.once('SIGINT', () => controller.abort());
    await superviseHost(JSON.parse(process.argv[2]!), controller.signal, () => console.log('ready'));
  }
}
