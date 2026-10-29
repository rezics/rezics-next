#!/usr/bin/env bun
/**
 * Host-wide FIFO admission for local stack-heavy commands; workers always queue rather than being refused.
 *
 *   bun scripts/stack-lease.ts <label> -- <command...>
 *
 * REZICS_STACK_SLOTS overrides max(1, min(floor(cores / 8), floor(MemTotal GiB / 7.5))) with a positive integer.
 * Total memory, never available memory, keeps capacity stable as stacks start. Every worktree shares the literal
 * /tmp/rezics-stack-lease, unless REZICS_STACK_LEASE_DIR overrides it (TMPDIR does not).
 * REZICS_STACK_LEASE=off disables admission. Children receive REZICS_STACK_SLOT=<index>/<capacity>; an inherited
 * token skips acquisition so nested commands hold only their parent's slot.
 *
 * Slots and arrival-ordered queue tickets are flock locks held by children reading a pipe from their owner. Owner
 * death, including SIGKILL, closes the pipe and frees the lock without cleanup. Directory changes wake waiters,
 * with a recheck at least every two seconds for deaths that emit no event. There is no timeout. Stderr records
 * waiting (held/capacity and tickets ahead), repeats it every 60 seconds, and records every take with elapsed ms.
 * The CLI holds its slot for the command's life, forwards signals, and returns the command's exit code.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { basename, join } from 'node:path';

export interface StackSlot {
  readonly index: number | null;
  readonly capacity: number;
  readonly weight: number;
  readonly waitedMs: number;
  readonly env: Record<string, string>;
  release(): Promise<void>;
}

export function stackCapacity(env: Record<string, string | undefined> = process.env): number {
  const value = env.REZICS_STACK_SLOTS;
  if (value !== undefined) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw new Error(`REZICS_STACK_SLOTS must be a positive integer, received ${JSON.stringify(value)}`);
    }
    return Number(value);
  }
  return Math.max(1, Math.min(Math.floor(cpus().length / 8), Math.floor(totalmem() / 2 ** 30 / 7.5)));
}

type Lock = { release(): Promise<void> };
const BUSY = 75;
const MAX_WAIT_RECORD_MS = 60_000;

/** Records elapsed wait time in full-line appends, without allowing a reporting error to fail the check. */
function waitRecorder(file?: string): { begin(): void; record(): void; stop(): void } {
  if (!file) return { begin() {}, record() {}, stop() {} };
  let started: number | undefined;
  let recordedThrough = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (started === undefined) return;
    const elapsed = Math.max(0, Math.floor(performance.now() - started) - recordedThrough);
    let remaining = elapsed;
    while (remaining > 0) {
      const increment = Math.min(remaining, MAX_WAIT_RECORD_MS);
      try {
        appendFileSync(file, `${increment}\n`);
      } catch {
        // The control-plane hint is best-effort and must never fail a check.
      }
      recordedThrough += increment;
      remaining -= increment;
    }
  };
  const schedule = (delay = MAX_WAIT_RECORD_MS) => {
    timer = setTimeout(() => {
      flush();
      schedule();
    }, delay);
    timer.unref?.();
  };
  return {
    begin() {
      if (started !== undefined) return;
      started = performance.now();
      schedule(100);
    },
    record: flush,
    stop() {
      if (started === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      flush();
    },
  };
}

/** The pipe is owned only by this process: even SIGKILL releases every lock it owns. */
async function lock(file: string, blocking = false): Promise<Lock | null> {
  const child = Bun.spawn(
    [
      'flock',
      '--no-fork',
      ...(blocking ? [] : ['-n']),
      '-E',
      String(BUSY),
      file,
      'sh',
      '-c',
      'echo LOCKED; exec cat >/dev/null',
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  if (first.done) {
    const code = await child.exited;
    if (code === BUSY) return null;
    throw new Error(`stack-lease: flock failed for ${file} (exit ${code})`);
  }
  let released: Promise<void> | undefined;
  return {
    release() {
      return (released ??= (async () => {
        await child.stdin.end();
        await child.exited;
      })());
    },
  };
}

function busy(file: string): boolean {
  const result = Bun.spawnSync(['flock', '-n', '-E', String(BUSY), file, 'true'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'inherit',
  });
  if (result.exitCode === BUSY) return true;
  if (result.exitCode !== 0) throw new Error(`stack-lease: cannot inspect ${file}`);
  return false;
}

export async function acquireStackSlot(
  label: string,
  env: Record<string, string | undefined> = process.env,
  weight = 1,
  onWaiting?: (line: string) => void,
  repeatMs = 60_000,
): Promise<StackSlot> {
  const capacity = stackCapacity(env);
  if (!Number.isSafeInteger(weight) || weight < 1 || weight > capacity)
    throw new Error(`Lease weight must be between 1 and capacity (${capacity}), received ${weight}`);
  if (env.REZICS_STACK_LEASE === 'off' || env.REZICS_STACK_SLOT !== undefined) {
    return {
      index: null,
      capacity,
      weight,
      waitedMs: 0,
      env: env.REZICS_STACK_SLOT === undefined ? {} : { REZICS_STACK_SLOT: env.REZICS_STACK_SLOT },
      async release() {},
    };
  }
  const started = performance.now();
  const directory = env.REZICS_STACK_LEASE_DIR ?? '/tmp/rezics-stack-lease';
  const wait = waitRecorder(env.GOAL_CHECK_WAIT_FILE);
  mkdirSync(directory, { recursive: true });
  let wake: (() => void) | undefined;
  let generation = 0;
  const watcher = watch(directory, () => {
    generation++;
    wake?.();
  });
  const changed = (observed: number) =>
    new Promise<void>((done) => {
      if (generation !== observed) return done();
      const timer = setTimeout(finish, Math.min(2000, repeatMs));
      function finish() {
        clearTimeout(timer);
        wake = undefined;
        done();
      }
      wake = finish;
    });
  const mutexFile = join(directory, 'queue.lock');
  let ticket: string | undefined;
  let ticketLock: Lock | undefined;
  try {
    const mutex = (await lock(mutexFile, true))!;
    try {
      const sequenceFile = join(directory, 'sequence');
      let sequence = 0n;
      try {
        sequence = BigInt(readFileSync(sequenceFile, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      sequence++;
      writeFileSync(`${sequenceFile}.next`, String(sequence));
      renameSync(`${sequenceFile}.next`, sequenceFile);
      ticket = join(directory, `ticket-${sequence}`);
      ticketLock = (await lock(ticket, true))!;
    } finally {
      await mutex.release();
    }

    let lastLog = -Infinity;
    while (true) {
      const observed = generation;
      const mutex = (await lock(mutexFile, true))!;
      try {
        // Only the queue mutex may delete dead tickets, so their lock inode cannot be replaced under an enqueuer.
        const tickets = readdirSync(directory).filter((name) => /^ticket-\d+$/.test(name));
        const live = tickets
          .filter((name) => {
            const file = join(directory, name);
            if (file === ticket || busy(file)) return true;
            unlinkSync(file);
            return false;
          })
          .sort((a, b) => (BigInt(a.slice(7)) < BigInt(b.slice(7)) ? -1 : 1));
        const ahead = live.indexOf(basename(ticket));
        const heldSlots: number[] = [];
        for (let index = 1; index <= capacity; index++) {
          if (busy(join(directory, `slot-${index}.lock`))) heldSlots.push(index);
        }
        if (ahead === 0 && capacity - heldSlots.length >= weight) {
          const acquired: { index: number; lock: Lock }[] = [];
          for (let index = 1; index <= capacity && acquired.length < weight; index++) {
            if (heldSlots.includes(index)) continue;
            const slotLock = await lock(join(directory, `slot-${index}.lock`));
            if (slotLock) acquired.push({ index, lock: slotLock });
          }
          if (acquired.length === weight) {
            await ticketLock.release();
            ticketLock = undefined;
            unlinkSync(ticket);
            const waitedMs = Math.floor(performance.now() - started);
            const indexes = acquired.map((entry) => entry.index);
            console.error(
              weight === 1
                ? `stack-lease: ${label} slot ${indexes[0]}/${capacity} after ${waitedMs} ms`
                : `stack-lease: ${label} slots ${indexes.join(',')} (${weight}/${capacity}) after ${waitedMs} ms`,
            );
            let released: Promise<void> | undefined;
            return {
              index: indexes[0]!,
              capacity,
              weight,
              waitedMs,
              env: { REZICS_STACK_SLOT: `${indexes[0]}/${capacity}` },
              release() {
                return (released ??= (async () => {
                  await Promise.all(acquired.map((entry) => entry.lock.release()));
                  writeFileSync(join(directory, 'wake'), '');
                })());
              },
            };
          }
          await Promise.all(acquired.map((entry) => entry.lock.release()));
        }
        const held = heldSlots.length;
        if (performance.now() - lastLog >= repeatMs) {
          const line = `stack-lease: ${label} waiting (${held}/${capacity} held, ${ahead} ahead)`;
          console.error(line);
          onWaiting?.(line);
          lastLog = performance.now();
        }
        wait.begin();
        wait.record();
      } finally {
        await mutex.release();
      }
      await changed(observed);
    }
  } finally {
    wait.stop();
    watcher.close();
    await ticketLock?.release();
    // Dead tickets are left for the next mutex owner, just as they are after SIGKILL.
  }
}

export async function withStackSlot<T>(label: string, run: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const slot = await acquireStackSlot(label);
  try {
    return await run(slot.env);
  } finally {
    await slot.release();
  }
}

if (import.meta.main) {
  const [label, separator, ...command] = process.argv.slice(2);
  if (!label || separator !== '--' || !command.length) {
    console.error('Usage: bun scripts/stack-lease.ts <label> -- <command...>');
    process.exitCode = 2;
  } else {
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const forwarders = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
      const forward = () => {
        if (child) child.kill(signal);
        else process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal]);
      };
      process.on(signal, forward);
      return [signal, forward] as const;
    });
    try {
      process.exitCode = await withStackSlot(label, async (env) => {
        child = Bun.spawn(command, {
          env: { ...process.env, ...env },
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        });
        return await child.exited;
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    } finally {
      for (const [signal, forward] of forwarders) process.off(signal, forward);
    }
  }
}
