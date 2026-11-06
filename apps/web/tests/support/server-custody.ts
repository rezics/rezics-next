import { readdirSync, readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

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

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function processStat(pid: number): { state: string; pgrp: number } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) return undefined;
    const rest = stat.slice(closeParen + 2).split(' ');
    const state = rest[0];
    const pgrp = Number(rest[2]);
    if (!state || !Number.isInteger(pgrp) || pgrp <= 0) return undefined;
    return { state, pgrp };
  } catch {
    return undefined;
  }
}

/** Live members of a process group, excluding unreaped zombies that still answer kill(-pgid, 0). */
function liveProcessGroupMembers(pgid: number): number[] {
  try {
    const members: number[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(entry)) continue;
      const pid = Number(entry);
      const stat = processStat(pid);
      if (stat && stat.pgrp === pgid && stat.state !== 'Z') members.push(pid);
    }
    return members;
  } catch {
    return processGroupExists(pgid) ? [pgid] : [];
  }
}

function liveProcessGroup(pgid: number): boolean {
  return liveProcessGroupMembers(pgid).length > 0;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return predicate();
    await wait(Math.min(pollIntervalMs, remaining));
  }
}

async function completedWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  try {
    await bounded(promise, timeoutMs, 'completion');
    return true;
  } catch {
    return false;
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
    const signalGroup = (signal: NodeJS.Signals) => {
      if (pid === undefined) return;
      const members = liveProcessGroupMembers(pid);
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupErrors.push(error);
      }
      for (const member of members) {
        try {
          process.kill(member, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupErrors.push(error);
        }
      }
    };

    if (pid !== undefined) {
      const graceDeadline = Date.now() + termGraceMs;
      signalGroup('SIGTERM');
      // Reap the direct child before judging the group: an unreaped zombie leader still
      // answers kill(-pid, 0) even when every live descendant is gone.
      childSettled = await completedWithin(childCompletion, termGraceMs);
      const remainingGrace = graceDeadline - Date.now();
      if (remainingGrace > 0 && liveProcessGroup(pid)) {
        await waitUntil(() => !liveProcessGroup(pid), remainingGrace, pollIntervalMs);
      }
      groupSettled = !liveProcessGroup(pid) && !processGroupExists(pid);
      if (liveProcessGroup(pid) || processGroupExists(pid)) {
        signalGroup('SIGKILL');
        if (!childSettled) childSettled = await completedWithin(childCompletion, settleTimeoutMs);
        try {
          const gone = await waitUntil(
            () => !liveProcessGroup(pid) && !processGroupExists(pid),
            settleTimeoutMs,
            pollIntervalMs,
          );
          groupSettled = gone;
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
  const streams = options.streams ?? { stdout: child.stdout, stderr: child.stderr };
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
