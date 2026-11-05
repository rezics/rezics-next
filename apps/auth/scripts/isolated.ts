import { relative, resolve } from 'node:path';
import { stackRun, testKeepsFiles } from '../../../scripts/stack-run.ts';

export type CaptureClock = {
  set: (callback: () => void, milliseconds: number) => unknown;
  clear: (timer: unknown) => void;
};
const clock: CaptureClock = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class CaptureCancelled extends Error {
  constructor(readonly signal: 'SIGINT' | 'SIGTERM') {
    super(`Auth capture cancelled by ${signal}.`);
  }
}

export function captureExitCode(error: unknown): number {
  const reason = error instanceof AggregateError ? error.cause : error;
  return reason instanceof CaptureCancelled ? 128 + (reason.signal === 'SIGINT' ? 2 : 15) : 1;
}

export class CaptureTimeout extends Error {
  constructor(label: string) {
    super(`${label} timed out; settlement is unknown.`);
  }
}

/** A deadline bounds observation, never certifies physical resource closure. */
export function bounded<T>(
  label: string,
  start: () => T | PromiseLike<T>,
  milliseconds: number | null,
  timers: CaptureClock = clock,
  signal?: AbortSignal,
  lateError?: (error: unknown) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: unknown;
    const finish = (error: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) timers.clear(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(value);
      else resolve(value as T);
    };
    const cancel = () => finish(true, signal?.reason);
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', cancel, { once: true });
    if (milliseconds !== null) timer = timers.set(() => finish(true, new CaptureTimeout(label)), milliseconds);
    try {
      Promise.resolve(start()).then(
        (value) => finish(false, value),
        (error) => {
          if (settled) lateError?.(error);
          else finish(true, error);
        },
      );
    } catch (error) {
      finish(true, error);
    }
  });
}

type Entry = { close: () => Promise<void> };
export type Owned<T> = { value: T; close: () => Promise<void> };

/** Register before starting acquisition; a retired owner also owns every late success. */
export class CaptureLifetime {
  readonly controller = new AbortController();
  readonly cleanupErrors: unknown[] = [];
  private readonly entries = new Set<Entry>();
  private retired = false;
  private retirement: Promise<void> | undefined;
  private failure: AggregateError | undefined;

  constructor(
    readonly timers: CaptureClock = clock,
    readonly closeTimeout = 5000,
    private readonly diagnostic: (error: unknown) => void = () => {},
  ) {}

  recordCleanup = (error: unknown): void => {
    this.cleanupErrors.push(error);
    this.failure?.errors.push(error);
    try {
      this.diagnostic(error);
    } catch {
      /* Diagnostics cannot interrupt retirement. */
    }
  };

  cancel(reason: unknown = new Error('Auth capture cancelled.')): void {
    if (this.retired) return;
    this.retired = true;
    this.controller.abort(reason);
    // Cancellation starts every known cleanup immediately, independently of nested finally blocks.
    this.retirement = Promise.all([...this.entries].map((entry) => entry.close())).then(() => {});
  }

  step<T>(label: string, start: () => T | PromiseLike<T>, timeout: number | null = 150_000): Promise<T> {
    return bounded(label, start, timeout, this.timers, this.controller.signal);
  }

  async own<T>(
    label: string,
    start: () => T | PromiseLike<T>,
    dispose: (value: T) => unknown | PromiseLike<unknown>,
    timeout: number | null = 150_000,
  ): Promise<Owned<T>> {
    let acquired = false;
    let started = false;
    let value: T;
    let closing: Promise<void> | undefined;
    let pendingReported = false;
    const entry: Entry = {
      close: () => {
        if (!acquired) {
          if (started && !pendingReported) {
            pendingReported = true;
            this.recordCleanup(
              new Error(`${label} acquisition is still pending at retirement; settlement is unknown.`),
            );
          }
          return Promise.resolve();
        }
        closing ??= bounded(
          label + ' close',
          () => dispose(value),
          this.closeTimeout,
          this.timers,
          undefined,
          this.recordCleanup,
        )
          .then(() => {}, this.recordCleanup)
          .finally(() => this.entries.delete(entry));
        return closing;
      },
    };
    this.entries.add(entry);
    try {
      const result = await this.step(
        label,
        () => {
          started = true;
          let acquisition: T | PromiseLike<T>;
          try {
            acquisition = start();
          } catch (error) {
            this.entries.delete(entry);
            throw error;
          }
          return Promise.resolve(acquisition).then(
            (resource) => {
              value = resource;
              acquired = true;
              if (this.retired || this.controller.signal.aborted) void entry.close();
              return resource;
            },
            (error) => {
              this.entries.delete(entry);
              throw error;
            },
          );
        },
        timeout,
      );
      return { value: result, close: entry.close };
    } catch (error) {
      // An unresolved acquisition retains its entry until its late continuation disposes it.
      if (!started) this.entries.delete(entry);
      if (acquired) await entry.close();
      throw error;
    }
  }

  async retire(): Promise<void> {
    this.cancel();
    await this.retirement;
  }

  finish(primary: { error: unknown } | undefined): void {
    if (primary || this.cleanupErrors.length) {
      // Keep the operation error first, including non-Error rejection values.
      this.failure = new AggregateError(
        [...(primary ? [primary.error] : []), ...this.cleanupErrors],
        'Auth capture failed; cleanup errors and unknown settlements are retained.',
        primary ? { cause: primary.error } : undefined,
      );
      throw this.failure;
    }
  }
}

export type CaptureChild = {
  exitCode: number | null;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => void;
};

/** Direct child exit is not evidence that descendants or inherited output have settled. */
export async function terminateChild(
  child: CaptureChild,
  timers: CaptureClock,
  timeout: number,
  signal: NodeJS.Signals = 'SIGTERM',
  lateError: (error: unknown) => void = () => {},
): Promise<void> {
  const errors: unknown[] = [];
  let lateExitReported = false;
  const lateExit = (error: unknown) => {
    if (!lateExitReported) {
      lateExitReported = true;
      lateError(error);
    }
  };
  if (child.exitCode === null) {
    try {
      child.kill(signal);
    } catch (error) {
      errors.push(error);
    }
    try {
      await bounded('child termination', () => child.exited, timeout, timers, undefined, lateExit);
    } catch (error) {
      errors.push(error);
      try {
        child.kill('SIGKILL');
      } catch (error) {
        errors.push(error);
      }
      try {
        await bounded('child exit after SIGKILL', () => child.exited, timeout, timers, undefined, lateExit);
      } catch (error) {
        errors.push(error);
      }
    }
  } else {
    try {
      await bounded('child exit', () => child.exited, timeout, timers, undefined, lateExit);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Child retirement was not fully observed.');
}

export function captureSignals(owner: CaptureLifetime, source = process): () => void {
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = () => owner.cancel(new CaptureCancelled(signal));
    source.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) source.off(signal, handler);
  };
}

export async function runIsolatedChild(
  spawn: () => CaptureChild | Promise<CaptureChild>,
  owner = new CaptureLifetime(),
  source = process,
): Promise<number> {
  const detach = captureSignals(owner, source);
  let primary: { error: unknown } | undefined;
  let code = 1;
  try {
    const child = await owner.own('isolated child', spawn, (child) =>
      terminateChild(
        child,
        owner.timers,
        owner.closeTimeout / 3,
        owner.controller.signal.reason instanceof CaptureCancelled ? owner.controller.signal.reason.signal : 'SIGTERM',
        owner.recordCleanup,
      ),
    );
    // Ordinary execution has no artificial overall test deadline. Cancellation has bounded retirement.
    code = await owner.step('isolated execution', () => child.value.exited, null);
  } catch (error) {
    primary = { error };
  } finally {
    await owner.retire();
    detach();
  }
  owner.finish(primary);
  return code;
}

export type IsolationDependencies = {
  linux: boolean;
  probe: () => CaptureChild | Promise<CaptureChild>;
  spawn: (invocation: string[]) => CaptureChild | Promise<CaptureChild>;
  warn: () => void;
};

export function runIsolatedCommand(
  command: string[],
  deps: IsolationDependencies,
  owner = new CaptureLifetime(undefined, undefined, (error) => console.error('Auth cleanup:', error)),
  source = process,
): Promise<number> {
  return runIsolatedChild(
    async () => {
      let isolated = false;
      if (deps.linux) {
        let probe: Owned<CaptureChild> | undefined;
        try {
          probe = await owner.own('namespace probe', deps.probe, (child) =>
            terminateChild(child, owner.timers, owner.closeTimeout / 3, 'SIGTERM', owner.recordCleanup),
          );
          isolated = (await owner.step('namespace probe exit', () => probe!.value.exited, 5000)) === 0;
        } catch (error) {
          if (owner.controller.signal.aborted) throw owner.controller.signal.reason;
          if (error instanceof CaptureTimeout) throw error;
          // A known unavailable namespace retains the existing host-network fallback.
        } finally {
          await probe?.close();
        }
        if (owner.cleanupErrors.length) throw owner.cleanupErrors[0];
      }
      const invocation = isolated
        ? [
            'unshare',
            '--user',
            '--map-root-user',
            '--net',
            'sh',
            '-c',
            'ip link set lo up && exec "$@"',
            'sh',
            ...command,
          ]
        : command;
      if (owner.controller.signal.aborted) throw owner.controller.signal.reason;
      if (deps.linux && !isolated) deps.warn();
      if (owner.controller.signal.aborted) throw owner.controller.signal.reason;
      // The enclosing acquisition owns this promise, including success after cancellation.
      return deps.spawn(invocation);
    },
    owner,
    source,
  );
}

async function run(): Promise<void> {
  const command = process.argv.slice(2);
  if (command.length === 0) {
    process.stderr.write('Usage: bun scripts/isolated.ts <command> [arguments...]\n');
    process.exitCode = 2;
    return;
  }
  const app = resolve(import.meta.dir, '..');
  const cwd = process.cwd();
  process.exitCode = await stackRun(
    {
      label: 'auth isolated',
      root: resolve(app, '../..'),
      cwd,
      command: ['bun', relative(cwd, import.meta.filename), ...command],
      // The screenshot script writes the images the caller commits; a report option names a file the caller reads.
      keepsFiles: testKeepsFiles(command) || command.some((argument) => argument.endsWith('scripts/screenshots.ts')),
    },
    async (env) =>
      runIsolatedCommand(command, {
        linux: process.platform === 'linux',
        probe: () =>
          Bun.spawn(['unshare', '--user', '--map-root-user', '--net', 'ip', 'link', 'set', 'lo', 'up'], {
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
          }),
        spawn: (invocation) =>
          Bun.spawn(invocation, {
            env: { ...process.env, ...env, REZICS_TEST_RUNTIME: '1' },
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
          }),
        warn: () => {
          process.stderr.write(
            'the tests are running on the host network, so host network changes can break browser tests.\n',
          );
        },
      }),
  );
}

if (import.meta.main)
  void run().catch((error: unknown) => {
    console.error(error);
    process.exitCode = captureExitCode(error);
  });
