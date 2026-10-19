import { spawn } from 'node:child_process';
import { mkdirSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GiB, isLocalQaRun, qaMemoryDeadline, qaMemoryNeed, waitForMemory,
  type MemoryReading } from './memory-admission.ts';
import { defaultStopGraceMs, terminateProcessGroup } from './process/terminate.ts';
import { withCpuAdmission, type CpuAdmissionOptions } from './cpu-admission.ts';

export const hostAdmissionUsage = 'Usage: bun scripts/qa/host-admission.ts [--cpu] --gib <need> -- <command...>';

const gibPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function parseHostAdmissionArgs(input: readonly string[]): { gib: number; cpu: boolean; command: string[] } {
  const cpu = input[0] === '--cpu';
  const args = cpu ? input.slice(1) : input;
  const split = args.indexOf('--');
  if (args[0] !== '--gib' || split !== 2 || split >= args.length - 1) throw new Error(hostAdmissionUsage);
  if (!gibPattern.test(args[1] ?? '') || Number(args[1]) <= 0)
    throw new Error('--gib must be a positive number of gibibytes');
  return { gib: Number(args[1]), cpu, command: args.slice(split + 1) };
}

/** Needs this large take turns. Two type checks that each fit when measured can exhaust the host together,
 * because a process grows to its need only after it was admitted. The turn lasts the whole command, so only
 * short checks may be this large. */
export const SERIAL_ADMISSION_GIB = 5;
/** Installs, generation and image builds run for minutes. They stay below the serial size: at it, one stack
 * refresh held the turn for eleven minutes and every merge gate's web type check ran out of time behind it. */
export const BUILD_ADMISSION_GIB = 4;
const SERIAL_ADMISSION_MARK = 'REZICS_QA_SERIAL_ADMISSION';
/** Consumed by this wrapper so nested admissions cannot restart the proof's clock. */
export const admittedCommandBudgetEnv = 'REZICS_QA_ADMITTED_COMMAND_BUDGET_MS';
/** A caller-owned token makes the final admission boundary distinguishable from command output. */
export const admittedCommandTokenEnv = 'REZICS_QA_ADMITTED_COMMAND_TOKEN';

export interface HostAdmissionOptions {
  cpu?: boolean;
  cpuOptions?: Partial<CpuAdmissionOptions>;
  root?: string;
  /** The host-wide lock large needs take turns on. The command line derives it from the Goal state. */
  serialLock?: string;
  env?: NodeJS.ProcessEnv;
  deadline?: number;
  read?: (remainingMs: number) => Promise<MemoryReading>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  announce?: (message: string) => void;
  pollMs?: number;
  run?: (command: readonly string[]) => Promise<number>;
}

async function spawnInherited(command: readonly string[], env: NodeJS.ProcessEnv, admitted = true): Promise<number> {
  const rawBudget = admitted ? env[admittedCommandBudgetEnv] : undefined;
  const budgetMs = rawBudget === undefined ? undefined : Number(rawBudget);
  if (budgetMs !== undefined && (!Number.isSafeInteger(budgetMs) || budgetMs < 1))
    throw new Error(`${admittedCommandBudgetEnv} must be a positive integer`);
  const token = admitted ? env[admittedCommandTokenEnv] : undefined;
  if (token !== undefined && !/^[a-zA-Z0-9-]{1,128}$/.test(token))
    throw new Error(`Invalid ${admittedCommandTokenEnv}`);
  const report = (event: string) => {
    if (token) writeSync(Number(env.REZICS_QA_ADMISSION_LOG_FD ?? 2), `QA_ADMITTED_COMMAND ${token} ${event}\n`);
  };
  const childEnv = { ...env };
  // A flock relay has not admitted the command yet: retain its budget and reporting channel.
  if (admitted) {
    delete childEnv.REZICS_QA_ADMISSION_LOG_FD;
    delete childEnv[admittedCommandBudgetEnv];
    delete childEnv[admittedCommandTokenEnv];
  }
  report(`BEGIN ${Date.now()}`);
  const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: 'inherit', env: childEnv });
  let signalled = false;
  let endedAt = 0;
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      signalled = signal !== null;
      endedAt = Date.now();
      if (signal) console.error(`Command failed: exit status ${code}; signal ${signal}`);
      resolve(code ?? 1);
    });
  });
  let stopping: Promise<void> | undefined;
  const forward = () => {
    if (!child.pid) return;
    stopping ??= terminateProcessGroup(child.pid, { graceMs: defaultStopGraceMs });
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  let timedOut = false;
  const timer = budgetMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    forward();
  }, budgetMs);
  try {
    const code = await exited;
    if (stopping) await stopping;
    if (timedOut) console.error('Command deadline exceeded');
    report(`END ${endedAt} ${signalled ? 'signal' : code} ${timedOut ? 'timeout' : 'exit'}`);
    return timedOut ? 124 : code;
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}

/** Wait for optional CPU admission and the host's reserve after `gib` GiB, then run the command.
 * Outside a local Goal run, only the command runs. */
export async function runHostAdmission(gib: number, command: readonly string[],
  options: HostAdmissionOptions = {}): Promise<number> {
  if (!Number.isFinite(gib) || gib <= 0) throw new Error('--gib must be a positive number of gibibytes');
  if (command.length === 0) throw new Error(hostAdmissionUsage);
  const env = options.env ?? process.env;
  const root = options.root ?? resolve(import.meta.dir, '../..');
  const run = options.run ?? (command => spawnInherited(command, env));
  if (!await isLocalQaRun(root, env)) return await run(command);
  if (gib >= SERIAL_ADMISSION_GIB && options.serialLock && !env[SERIAL_ADMISSION_MARK]) {
    mkdirSync(dirname(options.serialLock), { recursive: true });
    // The whole admission and command run again under the lock, so the memory reading is taken by its holder.
    const relaunch = options.run ?? (command => spawnInherited(command, env, false));
    return await relaunch(['flock', options.serialLock, 'env', `${SERIAL_ADMISSION_MARK}=1`, process.execPath,
      import.meta.path, ...(options.cpu ? ['--cpu'] : []), '--gib', String(gib), '--', ...command]);
  }
  const reserve = qaMemoryNeed(root, 'other', undefined, env).hostReserve;
  const deadline = options.deadline ?? qaMemoryDeadline(env);
  // Synchronous graph consumers capture stderr for diagnostics and pass a separate
  // inherited descriptor so admission waits still appear immediately in job logs.
  const announce = options.announce ?? (env.REZICS_QA_ADMISSION_LOG_FD
    ? (message: string) => { writeSync(Number(env.REZICS_QA_ADMISSION_LOG_FD), `${message}\n`); }
    : console.error);
  const admittedRun = async () => {
    await waitForMemory({ vm: 0, vmReserve: 0, host: gib * GiB, hostReserve: reserve }, {
      root, env, deadline,
      read: options.read, now: options.now, sleep: options.sleep, announce, pollMs: options.pollMs,
      emitEvents: env.REZICS_QA_ADMISSION_LOG_FD ? false : undefined,
    });
    return await run(command);
  };
  return options.cpu ? await withCpuAdmission({ root, env, deadline, announce, ...options.cpuOptions }, admittedRun)
    : await admittedRun();
}

async function serialAdmissionLock(root: string): Promise<string | undefined> {
  const { goalSlotDirectory } = await import('./core.ts');
  const slots = goalSlotDirectory(root);
  return slots ? join(dirname(slots), 'large-admission.lock') : undefined;
}

if (import.meta.main) {
  try {
    const parsed = parseHostAdmissionArgs(process.argv.slice(2));
    process.exit(await runHostAdmission(parsed.gib, parsed.command,
      { cpu: parsed.cpu, serialLock: await serialAdmissionLock(resolve(import.meta.dir, '../..')) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
