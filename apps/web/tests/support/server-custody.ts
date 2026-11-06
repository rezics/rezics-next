import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { dlopen, FFIType, ptr } from 'bun:ffi';

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

function bunOutputStream(stream: Bun.Subprocess['stdout']): ReadableStream<Uint8Array> | null {
  return stream instanceof ReadableStream ? (stream as ReadableStream<Uint8Array>) : null;
}

/** Bun may reject a drained pipe with one of these codes after this owner starts stopping the group. */
function isExpectedStoppedStreamClose(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  const code = 'code' in error ? String((error as Error & { code: unknown }).code) : '';
  return ['ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE', 'EPIPE', 'ECONNRESET'].includes(code);
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

/** Linux /proc stat: state, parent, group, then start time in clock ticks since boot, which names one process. */
export type ProcessIdentity = { state: string; ppid: number; pgrp: number; startTicks: string };

export function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) return undefined;
    const rest = stat.slice(closeParen + 2).split(' ');
    const state = rest[0];
    const ppid = Number(rest[1]);
    const pgrp = Number(rest[2]);
    const startTicks = rest[19];
    if (
      !state ||
      !Number.isInteger(ppid) ||
      ppid < 0 ||
      !Number.isInteger(pgrp) ||
      pgrp <= 0 ||
      !startTicks ||
      !/^[0-9]+$/.test(startTicks)
    )
      return undefined;
    return { state, ppid, pgrp, startTicks };
  } catch {
    return undefined;
  }
}

/** Start time that names one process for as long as it lives; a reused PID reports a different value. */
export function processStartTicks(pid: number): string | undefined {
  return processIdentity(pid)?.startTicks;
}

function readProcessTable(): Map<number, ProcessIdentity> {
  const table = new Map<number, ProcessIdentity>();
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(entry)) continue;
      const pid = Number(entry);
      const identity = processIdentity(pid);
      if (identity) table.set(pid, identity);
    }
  } catch {
    return table;
  }
  return table;
}

/** Group members plus descendants of the spawned leader, including children that left the group. */
export function relatedProcessIds(rootPid: number, table = readProcessTable()): number[] {
  const related = new Set<number>([rootPid]);
  for (const [pid, identity] of table) if (identity.pgrp === rootPid) related.add(pid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, identity] of table) {
      if (related.has(pid) || !related.has(identity.ppid)) continue;
      related.add(pid);
      grew = true;
    }
  }
  return [...related];
}

const WNOHANG = 1;
let waitpidSymbol:
  | { waitpid(pid: number, status: number, options: number): number }
  | undefined
  | false;

function waitpidNoHang(pid: number): number | undefined {
  if (waitpidSymbol === false) return undefined;
  try {
    if (waitpidSymbol === undefined) {
      waitpidSymbol = dlopen('libc.so.6', {
        waitpid: {
          args: [FFIType.i32, FFIType.pointer, FFIType.i32],
          returns: FFIType.i32,
        },
      }).symbols;
    }
    const status = new Int32Array(1);
    const result = waitpidSymbol.waitpid(pid, ptr(status), WNOHANG);
    if (result <= 0) return undefined;
    const raw = status[0] ?? 0;
    if ((raw & 0x7f) === 0) return (raw >> 8) & 0xff;
    return undefined;
  } catch {
    waitpidSymbol = false;
    return undefined;
  }
}

/** Reap a direct child and return its exit code when this process is the parent. */
export function directChildExitCode(pid: number): number | undefined {
  const identity = processIdentity(pid);
  if (!identity || identity.ppid !== process.pid) return undefined;
  return waitpidNoHang(pid);
}

/** Live members of a process group, excluding unreaped zombies that still answer kill(-pgid, 0). */
export function liveProcessGroupMemberIds(pgid: number): number[] {
  const table = readProcessTable();
  if (table.size === 0) return processGroupExists(pgid) ? [pgid] : [];
  return relatedProcessIds(pgid, table).filter((pid) => {
    const identity = table.get(pid);
    return identity !== undefined && identity.state !== 'Z';
  });
}

/** Reap zombies in the group that this process adopted after the original parent exited. */
export function reapExitedProcessGroupMembers(pgid: number): void {
  const table = readProcessTable();
  for (const pid of relatedProcessIds(pgid, table)) {
    const identity = table.get(pid);
    if (!identity || identity.state !== 'Z' || identity.ppid !== process.pid) continue;
    waitpidNoHang(pid);
  }
}

/** True when the pid is absent from /proc or is already a zombie. */
export function processHasExited(pid: number): boolean {
  const identity = processIdentity(pid);
  return identity === undefined || identity.state === 'Z';
}

function observeLeaderExit(pid: number | undefined, observed: Promise<void>, pollIntervalMs: number): Promise<void> {
  if (pid === undefined) return observed;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    void observed.then(finish, finish);
    const tick = () => {
      if (settled) return;
      if (processHasExited(pid)) {
        directChildExitCode(pid);
        finish();
        return;
      }
      setTimeout(tick, pollIntervalMs);
    };
    tick();
  });
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

/** A process the custody recorded as its own, named by PID and start time; a reused PID never matches. */
export type OwnedMember = { readonly pid: number; readonly startTicks: string };
type TrackedMember = OwnedMember & { readonly ppid: number; readonly pgrp: number };

/** Signal a recorded process only while its PID still names that exact process; zombies and reused PIDs are skipped. */
export function signalOwnedProcess(member: OwnedMember, signal: NodeJS.Signals): boolean {
  const identity = processIdentity(member.pid);
  if (!identity || identity.startTicks !== member.startTicks || identity.state === 'Z') return false;
  try {
    process.kill(member.pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Kernels with CONFIG_PROC_CHILDREN list each process's children; otherwise the custody scans the whole table. */
const childrenFeature = existsSync(`/proc/${process.pid}/task/${process.pid}/children`);
const FULL_SCAN_INTERVAL_MS = 500;

function childPids(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .split(/\s+/)
      .filter((text) => /^[0-9]+$/.test(text))
      .map(Number);
  } catch {
    return [];
  }
}

function trackedOf(pid: number, identity: ProcessIdentity): TrackedMember {
  return { pid, startTicks: identity.startTicks, ppid: identity.ppid, pgrp: identity.pgrp };
}

/** The recorded process only while it is still the same non-zombie process. */
function liveIdentity(member: OwnedMember): ProcessIdentity | undefined {
  const identity = processIdentity(member.pid);
  return identity && identity.startTicks === member.startTicks && identity.state !== 'Z' ? identity : undefined;
}

type OwnedTree = {
  sample(full: boolean): void;
  live(): TrackedMember[];
  signal(signal: NodeJS.Signals, errors: unknown[]): void;
  reapOwnZombies(): void;
  remaining(): string;
  stop(): void;
};

/**
 * Owned processes from launch to close. A descendant is recorded while its parent is live with the recorded start
 * time, so it stays owned after leaving the group and being reparented. Settlement and signals follow only recorded
 * members whose start time still matches.
 */
function createOwnedTree(rootPid: number, pollIntervalMs: number): OwnedTree {
  const members = new Map<string, TrackedMember>();
  const keyOf = (member: OwnedMember) => `${member.pid}:${member.startTicks}`;
  const rootIdentity = processIdentity(rootPid);
  const rootMember: OwnedMember | undefined = rootIdentity
    ? { pid: rootPid, startTicks: rootIdentity.startTicks }
    : undefined;
  if (rootIdentity) {
    const tracked = trackedOf(rootPid, rootIdentity);
    members.set(keyOf(tracked), tracked);
  }
  const sampleMs = Math.min(50, Math.max(5, pollIntervalMs));
  const fullEvery = Math.max(1, Math.round(FULL_SCAN_INTERVAL_MS / sampleMs));
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticks = 0;

  const live = (): TrackedMember[] => [...members.values()].filter((member) => liveIdentity(member) !== undefined);

  const sample = (full: boolean) => {
    const current = live();
    const liveByPid = new Map(current.map((member) => [member.pid, member]));
    if (childrenFeature && !full) {
      for (const parent of current) {
        for (const pid of childPids(parent.pid)) {
          const identity = processIdentity(pid);
          if (!identity || identity.ppid !== parent.pid) continue;
          const tracked = trackedOf(pid, identity);
          if (members.has(keyOf(tracked))) continue;
          members.set(keyOf(tracked), tracked);
        }
      }
      return;
    }
    // Group members of the root, and children of live owned members, found to a fixed point.
    const table = readProcessTable();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, identity] of table) {
        const tracked = trackedOf(pid, identity);
        if (members.has(keyOf(tracked))) continue;
        const groupMember = pid !== rootPid && identity.pgrp === rootPid;
        if (!groupMember && !liveByPid.has(identity.ppid)) continue;
        members.set(keyOf(tracked), tracked);
        liveByPid.set(pid, tracked);
        grew = true;
      }
    }
  };

  const signal = (signalName: NodeJS.Signals, errors: unknown[]) => {
    const current = live();
    // A group id stays reserved while any member keeps it, so a live member in the group proves the group is ours.
    const groupOwned =
      (rootMember !== undefined && liveIdentity(rootMember) !== undefined) ||
      current.some((member) => processIdentity(member.pid)?.pgrp === rootPid);
    if (groupOwned) {
      try {
        process.kill(-rootPid, signalName);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error);
      }
    }
    for (const member of current) {
      try {
        signalOwnedProcess(member, signalName);
      } catch (error) {
        errors.push(error);
      }
    }
  };

  const reapOwnZombies = () => {
    for (const member of members.values()) {
      const identity = processIdentity(member.pid);
      if (
        !identity ||
        identity.startTicks !== member.startTicks ||
        identity.state !== 'Z' ||
        identity.ppid !== process.pid
      )
        continue;
      waitpidNoHang(member.pid);
    }
  };

  const remaining = (): string => {
    const rows: string[] = [];
    for (const member of members.values()) {
      const identity = processIdentity(member.pid);
      if (!identity || identity.startTicks !== member.startTicks) continue;
      const classification = identity.state === 'Z' ? 'unreaped-zombie' : 'live';
      rows.push(`${member.pid} ${classification} state=${identity.state} ppid=${identity.ppid} pgrp=${identity.pgrp}`);
      if (rows.length === 16) break;
    }
    return rows.length > 0 ? rows.join('; ') : 'none';
  };

  const stop = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const tick = () => {
    ticks += 1;
    sample(ticks % fullEvery === 0);
    if (live().length === 0) stop();
  };

  sample(true);
  timer = setInterval(tick, sampleMs);
  timer.unref?.();

  return {
    sample,
    live,
    signal,
    reapOwnZombies,
    remaining,
    stop,
  };
}

function makeProcessCustody(
  pid: number | undefined,
  tree: OwnedTree | undefined,
  childCompletion: Promise<void>,
  outputCompletion: Promise<void>,
  errors: unknown[],
  options: ProcessCustodyOptions,
  diagnostics: () => string,
  onCloseRequested?: () => void,
): ProcessCustody {
  const label = options.label ?? 'Child process group';
  const termGraceMs = options.termGraceMs ?? 1000;
  const settleTimeoutMs = options.settleTimeoutMs ?? 2000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  let isSettled = false;
  let closing: Promise<void> | undefined;

  /** Sample the owned tree while waiting, so a process spawned during teardown is still recorded. */
  const awaitOwnedExit = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!tree) return true;
      tree.sample(false);
      if (tree.live().length === 0) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await wait(Math.min(pollIntervalMs, remaining));
    }
  };

  const closeOnce = async () => {
    const cleanupErrors: unknown[] = [];
    let groupSettled = pid === undefined;
    let childSettled = false;
    let outputIsSettled = false;

    if (pid !== undefined && tree) {
      tree.sample(true);
      const graceDeadline = Date.now() + termGraceMs;
      tree.signal('SIGTERM', cleanupErrors);
      childSettled = await completedWithin(childCompletion, termGraceMs);
      if (!childSettled) directChildExitCode(pid);
      const remainingGrace = graceDeadline - Date.now();
      if (remainingGrace > 0) await awaitOwnedExit(remainingGrace);
      if (tree.live().length > 0) {
        tree.signal('SIGKILL', cleanupErrors);
        if (!childSettled) childSettled = await completedWithin(childCompletion, settleTimeoutMs);
        directChildExitCode(pid);
        await awaitOwnedExit(settleTimeoutMs);
      }
      tree.sample(true);
      tree.reapOwnZombies();
      groupSettled = tree.live().length === 0;
      tree.stop();
      if (!groupSettled)
        cleanupErrors.push(new Error(`${label} owned processes remained after SIGKILL: ${tree.remaining()}`));
    }

    const completions = await Promise.allSettled([
      bounded(childCompletion, settleTimeoutMs, `${label} direct child`),
      bounded(outputCompletion, settleTimeoutMs, `${label} output streams`),
    ]);
    childSettled = completions[0]?.status === 'fulfilled';
    outputIsSettled = completions[1]?.status === 'fulfilled';
    for (const completion of completions)
      if (completion.status === 'rejected') cleanupErrors.push(completion.reason);
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
    diagnostics() {
      const root = pid === undefined ? 'no root' : `root pid ${pid} start ${processStartTicks(pid) ?? 'exited'}`;
      return `${root}\n${diagnostics()}`;
    },
    close: () => {
      if (!closing) {
        onCloseRequested?.();
        closing = closeOnce();
      }
      return closing;
    },
  };
  return custody;
}

/** Take ownership of a Bun.spawn child and drain both Bun ReadableStreams immediately. */
export function ownBunProcess(child: Bun.Subprocess, options: ProcessCustodyOptions = {}): ProcessCustody {
  const errors: unknown[] = [];
  const recorder = makeOutputRecorder(options, errors);
  let stopRequested = false;
  const drain = async (stream: ReadableStream<Uint8Array> | null, name: ProcessOutputStream) => {
    if (!stream) return;
    try {
      for await (const chunk of stream) recorder.recordOutput(chunk, name);
    } catch (error) {
      if (stopRequested && isExpectedStoppedStreamClose(error)) return;
      errors.push(
        new Error(`${options.label ?? 'Child process group'} ${name} capture failed: ${errorText(error)}`, {
          cause: error,
        }),
      );
    }
  };
  const streams = options.streams ?? {
    stdout: bunOutputStream(child.stdout),
    stderr: bunOutputStream(child.stderr),
  };
  const outputCompletion = Promise.all([drain(streams.stdout, 'stdout'), drain(streams.stderr, 'stderr')]).then(
    () => undefined,
  );
  const childCompletion = observeLeaderExit(
    child.pid,
    Promise.resolve(child.exited).then(
      () => undefined,
      (error) => {
        errors.push(
          new Error(`${options.label ?? 'Child process group'} exit observation failed: ${errorText(error)}`, {
            cause: error,
          }),
        );
      },
    ),
    options.pollIntervalMs ?? 25,
  );
  void outputCompletion.catch(() => {});
  void childCompletion.catch(() => {});
  const tree = child.pid === undefined ? undefined : createOwnedTree(child.pid, options.pollIntervalMs ?? 25);
  return makeProcessCustody(
    child.pid,
    tree,
    childCompletion,
    outputCompletion,
    errors,
    options,
    recorder.diagnostics,
    () => {
      stopRequested = true;
    },
  );
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
  const tree = child.pid === undefined ? undefined : createOwnedTree(child.pid, options.pollIntervalMs ?? 25);
  return makeProcessCustody(child.pid, tree, childCompletion, outputCompletion, errors, options, recorder.diagnostics);
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
    throw new AggregateError(
      [primary, ...cleanupErrors],
      `${errorText(primary)}; The operation and its cleanup both failed`,
      { cause: primary },
    );
  if (failed) throw primary;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'One or more cleanup actions failed');
  return value as T;
}
