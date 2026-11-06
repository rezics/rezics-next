import type { ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export type ProcessOutputStream = 'stdout' | 'stderr';
export type BunProcessStreams = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
};

export type ProcessCustodyOptions = {
  label?: string;
  termGraceMs?: number;
  settleTimeoutMs?: number;
  pollIntervalMs?: number;
  outputLimit?: number;
  streams?: BunProcessStreams;
  onOutput?: (chunk: Uint8Array, stream: ProcessOutputStream) => void;
};

export type ProcessCustody = {
  readonly pid: number | undefined;
  readonly outputSettled: Promise<void>;
  readonly settled: boolean;
  diagnostics(): string;
  close(): Promise<void>;
};

export type CleanupAction = {
  label: string;
  run: () => unknown | PromiseLike<unknown>;
  timeoutMs?: number;
};

export type CleanupOptions = { timeoutMs?: number };

export class ProcessCustodyError extends AggregateError {
  readonly groupSettled: boolean;
  readonly childSettled: boolean;
  readonly outputSettled: boolean;

  constructor(
    label: string,
    errors: readonly unknown[],
    state: { groupSettled: boolean; childSettled: boolean; outputSettled: boolean },
  ) {
    super(errors, `${label} cleanup did not settle cleanly`);
    this.name = 'ProcessCustodyError';
    this.groupSettled = state.groupSettled;
    this.childSettled = state.childSettled;
    this.outputSettled = state.outputSettled;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function asCleanupError(label: string, error: unknown): Error {
  return new Error(`${label} cleanup failed: ${errorText(error)}`, { cause: error });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bounded<T>(promise: PromiseLike<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = Promise.resolve(promise);
  // A timeout must not leave a late rejection unhandled.
  void observed.catch(() => {});
  return Promise.race([
    observed,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} did not settle within ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function processState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim()[0];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
  return processState(pid) !== 'Z';
}

function childPids(pid: number): number[] {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    return children
      ? children
          .split(/\s+/)
          .map(Number)
          .filter((value) => Number.isSafeInteger(value) && value > 0)
      : [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return [];
    throw error;
  }
}

function collectTree(root: number, into: Set<number>): void {
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (into.has(pid)) continue;
    into.add(pid);
    queue.push(...childPids(pid));
  }
}

function signalPid(pid: number, signal: NodeJS.Signals, errors: unknown[]): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error);
  }
}

function signalPids(pids: Iterable<number>, signal: NodeJS.Signals, errors: unknown[]): void {
  for (const pid of pids) signalPid(pid, signal, errors);
}

function treeIsLive(pids: Iterable<number>): boolean {
  for (const pid of pids) if (pidIsLive(pid)) return true;
  return false;
}

function processGroupId(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const pgrp = Number(
      stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)[2],
    );
    return Number.isSafeInteger(pgrp) && pgrp > 0 ? pgrp : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function processGroupHasLiveMember(group: number): boolean {
  try {
    process.kill(-group, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
  if (pidIsLive(group) || childPids(group).some(pidIsLive)) return true;
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const member = Number(name);
      if (!pidIsLive(member)) continue;
      if (processGroupId(member) === group) return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return false;
}

function processGroupExists(pid: number): boolean {
  return processGroupHasLiveMember(pid);
}

async function waitUntilIdle(
  pid: number | undefined,
  tree: Set<number>,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pid !== undefined) collectTree(pid, tree);
    const groupGone = pid === undefined || !processGroupExists(pid);
    if (groupGone && !treeIsLive(tree)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await wait(Math.min(pollIntervalMs, remaining));
  }
}

function makeOutputRecorder(options: ProcessCustodyOptions, errors: unknown[]) {
  const label = options.label ?? 'Child process group';
  const outputLimit = options.outputLimit ?? 8000;
  let outputText = '';
  const recordOutput = (chunk: Uint8Array, stream: ProcessOutputStream) => {
    outputText = (outputText + Buffer.from(chunk).toString()).slice(-outputLimit);
    try {
      options.onOutput?.(chunk, stream);
    } catch (error) {
      errors.push(new Error(`${label} ${stream} observer failed: ${errorText(error)}`, { cause: error }));
    }
  };
  return { recordOutput, diagnostics: () => outputText };
}

function makeProcessCustody(
  pid: number | undefined,
  childCompletion: Promise<void>,
  outputCompletion: Promise<void>,
  errors: unknown[],
  options: ProcessCustodyOptions,
  diagnostics: () => string,
): ProcessCustody {
  const label = options.label ?? 'Child process group';
  const termGraceMs = options.termGraceMs ?? 1000;
  const settleTimeoutMs = options.settleTimeoutMs ?? 2000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  let isSettled = false;
  let closing: Promise<void> | undefined;

  const closeOnce = async () => {
    const cleanupErrors: unknown[] = [];
    let groupSettled = pid === undefined;
    let childSettled = false;
    let outputIsSettled = false;
    const tree = new Set<number>();
    if (pid !== undefined) collectTree(pid, tree);
    const signalGroup = (signal: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupErrors.push(error);
      }
    };
    const signalOwned = (signal: NodeJS.Signals) => {
      if (pid !== undefined) collectTree(pid, tree);
      signalGroup(signal);
      signalPids(tree, signal, cleanupErrors);
    };

    if (pid !== undefined) {
      signalOwned('SIGTERM');
      try {
        groupSettled = await waitUntilIdle(pid, tree, termGraceMs, pollIntervalMs);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (!groupSettled) {
        signalOwned('SIGKILL');
        try {
          groupSettled = await waitUntilIdle(pid, tree, settleTimeoutMs, pollIntervalMs);
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (!groupSettled) cleanupErrors.push(new Error(`${label} process group ${pid} remained after SIGKILL`));
      }
    }

    const completions = await Promise.allSettled([
      bounded(childCompletion, settleTimeoutMs, `${label} direct child`),
      bounded(outputCompletion, settleTimeoutMs, `${label} output streams`),
    ]);
    childSettled = completions[0]?.status === 'fulfilled';
    outputIsSettled = completions[1]?.status === 'fulfilled';
    for (const completion of completions) if (completion.status === 'rejected') cleanupErrors.push(completion.reason);
    cleanupErrors.push(...errors);

    isSettled = groupSettled && childSettled && outputIsSettled;
    if (cleanupErrors.length > 0) {
      throw new ProcessCustodyError(label, cleanupErrors, {
        groupSettled,
        childSettled,
        outputSettled: outputIsSettled,
      });
    }
  };

  const custody: ProcessCustody = {
    pid,
    outputSettled: outputCompletion,
    get settled() {
      return isSettled;
    },
    diagnostics,
    close: () => (closing ??= closeOnce()),
  };
  return custody;
}

/** Take ownership of a Bun.spawn child and drain both Bun ReadableStreams immediately. */
export function ownBunProcess(child: Bun.Subprocess, options: ProcessCustodyOptions = {}): ProcessCustody {
  const errors: unknown[] = [];
  const recorder = makeOutputRecorder(options, errors);
  const drain = async (stream: ReadableStream<Uint8Array> | null, name: ProcessOutputStream) => {
    if (!stream) return;
    try {
      for await (const chunk of stream) recorder.recordOutput(chunk, name);
    } catch (error) {
      errors.push(
        new Error(`${options.label ?? 'Child process group'} ${name} capture failed: ${errorText(error)}`, {
          cause: error,
        }),
      );
    }
  };
  const streams = options.streams ?? {
    stdout: child.stdout instanceof ReadableStream ? child.stdout : null,
    stderr: child.stderr instanceof ReadableStream ? child.stderr : null,
  };
  const outputCompletion = Promise.all([drain(streams.stdout, 'stdout'), drain(streams.stderr, 'stderr')]).then(
    () => undefined,
  );
  const childCompletion = Promise.resolve(child.exited).then(
    () => undefined,
    (error) => {
      errors.push(
        new Error(`${options.label ?? 'Child process group'} exit observation failed: ${errorText(error)}`, {
          cause: error,
        }),
      );
    },
  );
  void outputCompletion.catch(() => {});
  void childCompletion.catch(() => {});
  return makeProcessCustody(child.pid, childCompletion, outputCompletion, errors, options, recorder.diagnostics);
}

/** Take ownership of a Node child_process.spawn child and observe exit, close, and both output streams. */
export function ownNodeProcess(child: ChildProcess, options: ProcessCustodyOptions = {}): ProcessCustody {
  const errors: unknown[] = [];
  const recorder = makeOutputRecorder(options, errors);
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.once('error', (error) => {
      errors.push(
        new Error(`${options.label ?? 'Child process group'} child error: ${errorText(error)}`, {
          cause: error,
        }),
      );
      resolve();
    });
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  for (const [name, stream] of [
    ['stdout', child.stdout],
    ['stderr', child.stderr],
  ] as const) {
    stream?.on('data', (chunk: Uint8Array) => recorder.recordOutput(chunk, name));
    stream?.on('error', (error: unknown) => {
      errors.push(
        new Error(`${options.label ?? 'Child process group'} ${name} stream failed: ${errorText(error)}`, {
          cause: error,
        }),
      );
    });
  }
  const childCompletion = exited;
  const outputCompletion = closed;
  void childCompletion.catch(() => {});
  void outputCompletion.catch(() => {});
  return makeProcessCustody(child.pid, childCompletion, outputCompletion, errors, options, recorder.diagnostics);
}

async function collectCleanupErrors(actions: readonly CleanupAction[], options: CleanupOptions): Promise<Error[]> {
  const defaultTimeoutMs = options.timeoutMs ?? 10_000;
  const results = await Promise.all(
    actions.map(async ({ label, run, timeoutMs }) => {
      try {
        await bounded(Promise.resolve().then(run), timeoutMs ?? defaultTimeoutMs, label);
        return undefined;
      } catch (error) {
        return asCleanupError(label, error);
      }
    }),
  );
  return results.filter((error): error is Error => error !== undefined);
}

/** Start every independent cleanup action and report every rejection or timeout. */
export async function cleanupAll(actions: readonly CleanupAction[], options: CleanupOptions = {}): Promise<void> {
  const errors = await collectCleanupErrors(actions, options);
  if (errors.length > 0) throw new AggregateError(errors, 'One or more cleanup actions failed');
}

/** Retain an operation failure together with every independently attempted cleanup failure. */
export async function withCleanup<T>(
  operation: () => T | PromiseLike<T>,
  actions: readonly CleanupAction[],
  options: CleanupOptions = {},
): Promise<T> {
  let value: T | undefined;
  let primary: unknown;
  let failed = false;
  try {
    value = await operation();
  } catch (error) {
    primary = error;
    failed = true;
  }

  const cleanupErrors = await collectCleanupErrors(actions, options);
  if (failed && cleanupErrors.length > 0)
    throw new AggregateError([primary, ...cleanupErrors], 'The operation and its cleanup both failed', {
      cause: primary,
    });
  if (failed) throw primary;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'One or more cleanup actions failed');
  return value as T;
}
