import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll as bunAfterAll, beforeAll as bunBeforeAll, test as bunTest } from 'bun:test';

type NativeResource = {
  label: string;
  close?: () => void | Promise<void>;
  force?: () => void | Promise<void>;
};

export type NativeProcessIdentity = {
  pid: number;
  pgid: number;
  sid: number;
  startTime: string;
};

export type ProcessGroupObservation =
  | { status: 'observed'; identities: NativeProcessIdentity[] }
  | { status: 'unavailable'; detail: string };

export function processGroupObservationIsGone(observation: ProcessGroupObservation): boolean {
  return observation.status === 'observed' && observation.identities.length === 0;
}

export type NativeProcessOwnership = {
  readonly identity: NativeProcessIdentity;
  capture(): readonly NativeProcessIdentity[];
  close(): Promise<void>;
  force(): Promise<void>;
  release(): void;
};

export type NativeLifecycleOptions = {
  cleanupGraceMs?: number;
  forceGraceMs?: number;
};

const activeLifecycle = new AsyncLocalStorage<NativeTestLifecycle>();
const defaultCleanupGraceMs = 8_000;
const defaultForceGraceMs = 4_000;

export class NativeLifecycleTimeoutError extends Error {
  readonly cleanupFailures: string[] = [];

  constructor(
    readonly phase: string,
    readonly timeoutMs: number,
  ) {
    super(`Native lifecycle deadline exceeded in ${phase} after ${timeoutMs}ms`);
    this.name = 'NativeLifecycleTimeoutError';
  }
}

export class NativeTestLifecycle {
  readonly controller = new AbortController();
  readonly parent?: NativeTestLifecycle;
  readonly label: string;
  readonly cleanupGraceMs: number;
  readonly forceGraceMs: number;

  #state: 'open' | 'closing' | 'closed' = 'open';
  #resources: NativeResource[] = [];
  #closing?: Promise<void>;
  #releaseParent?: () => void;

  constructor(label: string, parent?: NativeTestLifecycle, options: NativeLifecycleOptions = {}) {
    this.label = label;
    this.parent = parent;
    this.cleanupGraceMs = options.cleanupGraceMs ?? defaultCleanupGraceMs;
    this.forceGraceMs = options.forceGraceMs ?? defaultForceGraceMs;
    if (!Number.isFinite(this.cleanupGraceMs) || this.cleanupGraceMs < 0)
      throw new Error(`Native lifecycle ${label} requires a finite cleanup grace period`);
    if (!Number.isFinite(this.forceGraceMs) || this.forceGraceMs < 0)
      throw new Error(`Native lifecycle ${label} requires a finite force grace period`);
    parent?.assertOpen(`create child lifecycle ${label}`);
    if (parent) {
      this.#releaseParent = parent.register({
        label: `child lifecycle ${label}`,
        close: () => this.close(),
        force: () => this.close(),
      });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isOpen(): boolean {
    return this.#state === 'open' && !this.signal.aborted && (!this.parent || this.parent.isOpen);
  }

  assertOpen(operation = 'continue native work'): void {
    if (!this.isOpen) throw new Error(`Native lifecycle ${this.label} is ${this.#state}; cannot ${operation}`);
  }

  register(resource: NativeResource): () => void {
    if (!this.isOpen) {
      void Promise.resolve(resource.force?.()).catch(() => {});
      throw new Error(`Native lifecycle ${this.label} is closed; cannot own ${resource.label}`);
    }
    const owned: NativeResource = {
      label: resource.label,
      close: resource.close,
      force: resource.force,
    };
    this.#resources.push(owned);
    return () => {
      this.#resources = this.#resources.filter((candidate) => candidate !== owned);
    };
  }

  ownProcessGroup(label: string, child: ChildProcess): NativeProcessOwnership {
    if (!child.pid) throw new Error(`Could not identify owned ${label} process group`);
    return this.ownProcessId(label, child.pid);
  }

  ownProcessId(label: string, pid: number): NativeProcessOwnership {
    const identity = readProcessIdentity(pid);
    if (!identity) throw new Error(`Could not identify owned ${label} process ${pid}`);
    if (identity.pgid !== identity.pid)
      throw new Error(`Owned ${label} process ${pid} is not the leader of its own process group`);

    const members = new Map<number, NativeProcessIdentity>([[identity.pid, identity]]);
    let released = false;
    const same = (candidate: NativeProcessIdentity): boolean =>
      sameProcess(readProcessIdentity(candidate.pid), candidate);
    const refresh = (): NativeProcessIdentity[] => {
      const knownMemberAlive = [...members.values()].some(same);
      if (!same(identity) && !knownMemberAlive) return [];
      const observation = processGroupIdentities(identity);
      if (observation.status === 'unavailable') return [...members.values()].filter(same);
      const current = observation.identities;
      if (!current.length && same(identity)) return [...members.values()].filter(same);
      for (const member of current) members.set(member.pid, member);
      return current;
    };
    const signal = (kind: NodeJS.Signals): void => {
      if (released) return;
      const current = refresh();
      if (!current.length) return;
      if (same(identity)) {
        try {
          process.kill(-identity.pgid, kind);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        return;
      }
      // If the group leader has already exited, signal only members observed
      // while the original group identity was still live. Each PID is checked
      // against its start time and group before it is signalled.
      for (const member of current) {
        const currentIdentity = readProcessIdentity(member.pid);
        if (!sameProcess(currentIdentity, member)) continue;
        try {
          process.kill(member.pid, kind);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    };
    const waitForExit = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        if (!processGroupExists(identity.pgid)) return true;
        refresh();
        if (Date.now() >= deadline) return false;
        await Bun.sleep(25);
      }
    };
    const close = async (): Promise<void> => {
      signal('SIGTERM');
      if (!(await waitForExit(this.cleanupGraceMs))) {
        const observation = processGroupIdentities(identity);
        const details = observation.status === 'unavailable' ? `; observation unavailable: ${observation.detail}` : '';
        throw new Error(`Owned ${label} process group did not close within ${this.cleanupGraceMs}ms${details}`);
      }
    };
    const force = async (): Promise<void> => {
      const current = refresh();
      for (const member of current) {
        if (member.pid === identity.pid) continue;
        const latest = readProcessIdentity(member.pid);
        if (!sameProcess(latest, member)) continue;
        try {
          process.kill(member.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      const descendantsStopped = await settledWithin(
        (async () => {
          const deadline = Date.now() + Math.min(500, this.forceGraceMs);
          while (Date.now() < deadline) {
            const descendants = [...members.values()].filter(
              (member) => member.pid !== identity.pid && sameProcess(readProcessIdentity(member.pid), member),
            );
            if (!descendants.length) return;
            await Bun.sleep(25);
          }
        })(),
        Math.min(550, this.forceGraceMs + 50),
      );
      void descendantsStopped;
      signal('SIGKILL');
      if (!(await waitForExit(this.forceGraceMs))) {
        const observation = processGroupIdentities(identity);
        const details = observation.status === 'unavailable' ? `; observation unavailable: ${observation.detail}` : '';
        throw new Error(`Owned ${label} process group survived SIGKILL for ${this.forceGraceMs}ms${details}`);
      }
    };
    const release = this.register({ label, close, force });
    return {
      identity,
      capture() {
        return refresh();
      },
      close,
      force,
      release() {
        released = true;
        release();
      },
    };
  }

  async run<T>(
    phase: string,
    timeoutMs: number,
    operation: (signal: AbortSignal) => T | Promise<T>,
    closeOnSuccess = true,
  ): Promise<T> {
    this.assertOpen(`start ${phase}`);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error(`Native lifecycle ${phase} requires a finite positive deadline`);

    const cleanupReserveMs = this.cleanupGraceMs + this.forceGraceMs + 1_000;
    const reserved = Math.min(cleanupReserveMs, Math.floor(timeoutMs / 3));
    const operationDeadlineMs = Math.max(1, timeoutMs - reserved);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectDeadline!: (error: Error) => void;
    const expired = new Promise<never>((_, reject) => (rejectDeadline = reject));
    const task = activeLifecycle.run(this, () => Promise.resolve().then(() => operation(this.signal)));
    task.catch(() => {});
    timeout = setTimeout(() => {
      const error = new NativeLifecycleTimeoutError(phase, timeoutMs);
      void this.close(error)
        .catch(() => {})
        .finally(() => {
          if (error.cleanupFailures.length)
            error.message += `; bounded cleanup diagnostics: ${error.cleanupFailures.join(', ').slice(0, 500)}`;
          rejectDeadline(error);
        });
    }, operationDeadlineMs);

    try {
      const value = await Promise.race([task, expired]);
      if (closeOnSuccess) await this.close();
      return value;
    } catch (error) {
      await this.close(error);
      if (this.parent) await this.parent.close(error);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  close(reason?: unknown): Promise<void> {
    return (this.#closing ??= this.#close(reason));
  }

  async #close(reason?: unknown): Promise<void> {
    if (this.#state === 'closed') return;
    this.#state = 'closing';
    this.controller.abort(reason);
    const resources = this.#resources.splice(0).reverse();
    const deadline = Date.now() + this.cleanupGraceMs;
    const errors: unknown[] = [];
    let closeFailed = false;
    for (const resource of resources) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        closeFailed = true;
        errors.push(new Error(`Cleanup exceeded ${this.cleanupGraceMs}ms`));
        break;
      }
      try {
        const closed = await settledWithin(
          Promise.resolve().then(async () => {
            await resource.close?.();
            return true;
          }),
          remaining,
        );
        if (closed === undefined) {
          closeFailed = true;
          errors.push(new Error(`Native resource ${resource.label} did not close within the remaining cleanup budget`));
          break;
        }
      } catch (error) {
        closeFailed = true;
        errors.push(error);
      }
    }
    if (closeFailed) {
      const forceOperations = resources.map(async (resource) => resource.force?.());
      const forced = await settledWithin(Promise.allSettled(forceOperations), this.forceGraceMs);
      if (reason instanceof NativeLifecycleTimeoutError) {
        reason.cleanupFailures.push(
          ...errors.slice(0, 8).map((error) => (error instanceof Error ? error.name : typeof error)),
        );
        if (forced === undefined) reason.cleanupFailures.push(`force escalation exceeded ${this.forceGraceMs}ms`);
        else
          reason.cleanupFailures.push(
            ...forced
              .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
              .slice(0, 8)
              .map((result) => (result.reason instanceof Error ? result.reason.name : typeof result.reason)),
          );
      }
    }
    this.#state = 'closed';
    this.#releaseParent?.();
    this.#releaseParent = undefined;
    if (reason === undefined && closeFailed) {
      throw new AggregateError(errors, `Native lifecycle ${this.label} cleanup failed`);
    }
  }
}

export function currentNativeLifecycle(): NativeTestLifecycle | undefined {
  return activeLifecycle.getStore();
}

export function nativeTest(
  name: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => unknown | Promise<unknown>,
  parent?: NativeTestLifecycle,
  options?: NativeLifecycleOptions,
): void {
  const lifecycle = new NativeTestLifecycle(name, parent, options);
  bunTest(name, () => lifecycle.run(name, timeoutMs, operation), timeoutMs);
}

export function nativeBeforeAll(
  lifecycle: NativeTestLifecycle,
  timeoutMs: number,
  operation: (signal: AbortSignal) => unknown | Promise<unknown>,
): void {
  bunBeforeAll(() => lifecycle.run(`${lifecycle.label} setup`, timeoutMs, operation, false), timeoutMs);
}

export function nativeAfterAll(lifecycle: NativeTestLifecycle, timeoutMs: number): void {
  bunAfterAll(() => lifecycle.close(), timeoutMs);
}

export async function settledWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = promise.then(
    (value) => ({ complete: true as const, value }),
    (error) => ({ complete: true as const, error }),
  );
  try {
    const result = await Promise.race([
      settled,
      new Promise<{ complete: false }>(
        (resolve) => (timer = setTimeout(() => resolve({ complete: false }), timeoutMs)),
      ),
    ]);
    if (!result.complete) return;
    if ('error' in result) throw result.error;
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function inspectNativeProcess(pid: number): NativeProcessIdentity | undefined {
  return readProcessIdentity(pid);
}

export function nativeProcessIsSame(identity: NativeProcessIdentity): boolean {
  return sameProcess(readProcessIdentity(identity.pid), identity);
}

export function nativeProcessGroupIsGone(identity: NativeProcessIdentity): boolean {
  return (
    processGroupObservationIsGone(processGroupIdentities(identity)) &&
    !sameProcess(readProcessIdentity(identity.pid), identity) &&
    !processGroupExists(identity.pgid)
  );
}

function readProcessIdentity(pid: number | undefined): NativeProcessIdentity | undefined {
  if (!pid) return;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    const pgid = Number(fields[2]);
    const sid = Number(fields[3]);
    const startTime = fields[19];
    if (!Number.isInteger(pgid) || !Number.isInteger(sid) || !startTime) return;
    return { pid, pgid, sid, startTime };
  } catch {
    return;
  }
}

function processGroupIdentities(identity: NativeProcessIdentity): ProcessGroupObservation {
  const result = spawnSync('ps', ['-o', 'pid=,pgid=', '-g', String(identity.sid)], {
    encoding: 'utf8',
    timeout: 1_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error)
    return { status: 'unavailable', detail: `${result.error.name}${result.error.code ? `:${result.error.code}` : ''}` };
  if (result.status !== 0) return { status: 'unavailable', detail: `ps exited with status ${result.status}` };

  const identities: NativeProcessIdentity[] = [];
  for (const line of result.stdout.split('\n').filter((value) => value.trim())) {
    const [pidText, pgidText, ...extra] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const pgid = Number(pgidText);
    if (extra.length || !Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(pgid) || pgid < 1)
      return { status: 'unavailable', detail: 'ps returned an invalid PID/PGID row' };
    if (pgid !== identity.pgid) continue;
    const observed = readProcessIdentity(pid);
    if (observed?.pgid === identity.pgid && observed.sid === identity.sid) identities.push(observed);
  }
  if (
    sameProcess(readProcessIdentity(identity.pid), identity) &&
    !identities.some((member) => member.pid === identity.pid)
  )
    return { status: 'unavailable', detail: 'ps omitted the verified process group leader' };
  return { status: 'observed', identities };
}

function sameProcess(current: NativeProcessIdentity | undefined, expected: NativeProcessIdentity): boolean {
  return Boolean(
    current &&
    current.pid === expected.pid &&
    current.pgid === expected.pgid &&
    current.sid === expected.sid &&
    current.startTime === expected.startTime,
  );
}

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}
