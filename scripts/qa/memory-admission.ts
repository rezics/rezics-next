import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Database } from 'bun:sqlite';
import { qaResourceClasses, type QaResourceClass } from './resource-classes.ts';

export const GiB = 1024 ** 3;
export type QaMemoryService = 'postgres' | 'fuseki' | 'rustfs' | 'toxiproxy' | 'mailpit';
export interface MemoryReading { vmTotal: number; vmUsed: number; hostAvailable: number }
export interface MemoryNeed { vm: number; host: number; hostReserve: number; vmReserve: number }

/** Stats uses SI or IEC units; Docker container caps interpret every suffix as binary. */
export function memoryBytes(value: string, containerCap = false): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|m|g|t|kb|mb|gb|tb|kib|mib|gib|tib)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid memory size: ${value}`);
  const unit = (match[2] ?? 'b').toLowerCase();
  const power = unit === 'b' ? 0 : 'kmgt'.indexOf(unit[0]!) + 1;
  const base = !containerCap && unit.length === 2 ? 1000 : 1024;
  const bytes = Number(match[1]) * base ** power;
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`Invalid memory size: ${value}`);
  return bytes;
}

function threshold(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value < 0 || env[name]?.trim() === '')
    throw new Error(`${name} must be a nonnegative number`);
  return value;
}

/** Read the authored caps so changes to Compose cannot silently underbudget QA. */
export function qaMemoryNeed(root: string, kind: 'other' | 'browser', resourceClass?: QaResourceClass,
  env: NodeJS.ProcessEnv = process.env,
  services: readonly QaMemoryService[] = ['postgres', 'fuseki', 'rustfs', 'toxiproxy', 'mailpit']): MemoryNeed {
  let vm = 0;
  if (resourceClass) {
    const capBytes = (value: string) => {
      const bytes = memoryBytes(value, true);
      if (bytes === 0) throw new Error('Memory admission requires finite, positive QA container caps');
      return bytes;
    };
    const compose = readFileSync(join(root, 'infra/dev/compose.qa.yaml'), 'utf8');
    for (const service of ['POSTGRES', 'RUSTFS', 'TOXIPROXY', 'MAILPIT']) {
      if (!services.includes(service.toLowerCase() as QaMemoryService)) continue;
      const key = `REZICS_${service}_MEMORY_LIMIT`;
      const cap = new RegExp(`\\$\\{${key}:-([^}]+)\\}`).exec(compose)?.[1];
      if (!cap) throw new Error(`Missing QA memory cap: ${key}`);
      vm += capBytes(env[key] ?? cap);
    }
    if (services.includes('fuseki')) vm += capBytes(env.REZICS_FUSEKI_MEMORY_LIMIT ?? env.REZICS_QA_FUSEKI_MEMORY_LIMIT
      ?? qaResourceClasses[resourceClass].memory);
  }
  return {
    vm, host: threshold(env, kind === 'browser' ? 'REZICS_QA_BROWSER_MEMORY_GIB' : 'REZICS_QA_HOST_MEMORY_GIB',
      kind === 'browser' ? 4 : 1) * GiB,
    hostReserve: threshold(env, 'REZICS_QA_HOST_RESERVE_GIB', 8) * GiB,
    vmReserve: threshold(env, 'REZICS_QA_VM_RESERVE_GIB', 0) * GiB,
  };
}

export function parseMemoryReading(total: string, stats: string, meminfo: string): MemoryReading {
  const vmTotal = Number(total.trim());
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  if (!Number.isSafeInteger(vmTotal) || vmTotal <= 0 || !available)
    throw new Error('Cannot read Docker VM total or host MemAvailable');
  const vmUsed = stats.trim() ? stats.trim().split('\n').reduce((sum, line) => {
    const row = JSON.parse(line) as { MemUsage?: string };
    if (!row.MemUsage) throw new Error('Docker stats did not report container memory');
    return sum + memoryBytes(row.MemUsage.split('/')[0]!);
  }, 0) : 0;
  return { vmTotal, vmUsed, hostAvailable: Number(available[1]) * 1024 };
}

function readHostMemory(): MemoryReading {
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  if (!available) throw new Error('Cannot read host MemAvailable');
  return { vmTotal: 0, vmUsed: 0, hostAvailable: Number(available[1]) * 1024 };
}

const execute = promisify(execFile);
export async function readMemory(remainingMs: number, env: NodeJS.ProcessEnv = process.env): Promise<MemoryReading> {
  const timeout = Math.max(1, Math.min(10_000, remainingMs));
  const [info, stats] = await Promise.all([
    execute('docker', ['info', '--format', '{{.MemTotal}}'], { timeout, env }),
    execute('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout, env, maxBuffer: 4 * 1024 ** 2 }),
  ]);
  return parseMemoryReading(info.stdout, stats.stdout, readFileSync('/proc/meminfo', 'utf8'));
}

export interface MemoryWaitOptions {
  deadline: number;
  root?: string;
  env?: NodeJS.ProcessEnv;
  read?: (remainingMs: number) => Promise<MemoryReading>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  announce?: (message: string) => void;
  pollMs?: number;
  onAdmissionWait?: (ms: number) => void;
  /** Nested admission uses its parent's event and elapsed-time accounting. */
  emitEvents?: boolean;
}

let admissionSequence = 0;
function admissionAccounting(options: MemoryWaitOptions, now: () => number): () => void {
  const started = now();
  const env = options.env ?? process.env;
  const token = options.emitEvents !== false && env.REZICS_QA_MEMORY_EVENTS === '1'
    ? `${process.pid}-${++admissionSequence}` : undefined;
  if (token) console.log(`QA_MEMORY_WAIT_BEGIN ${token}`);
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    const waited = Math.max(0, Math.round(now() - started));
    if (token) console.log(`QA_MEMORY_WAIT_END ${token} ${waited}`);
    options.onAdmissionWait?.(waited);
  };
}

function memoryWaitStatus(env: NodeJS.ProcessEnv, now: () => number): (message?: string) => void {
  const directory = env.GOAL_QA_WAIT_DIR;
  if (!directory) return () => {};
  let path: string | undefined;
  let since: string | undefined;
  return message => {
    if (!message) {
      if (path) rmSync(path, { force: true });
      path = undefined;
      since = undefined;
      return;
    }
    mkdirSync(directory, { recursive: true });
    path ??= join(directory, `memory-${process.pid}-${randomUUID()}.json`);
    since ??= new Date(now()).toISOString();
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, goal: env.GOAL_ID,
      command: env.GOAL_QA_COMMAND ?? process.argv.slice(1).join(' '), waitingFor: 'memory', message, since }));
    renameSync(temporary, path);
  };
}

/** Saved non-QA profiles retain their restore policy even in a Goal checkout.
 * Orchestration metadata opts in only when there is no saved stack profile. */
export async function isLocalQaRun(root = resolve(import.meta.dir, '../..'),
  env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.REZICS_STACK_PROFILE !== undefined) return env.REZICS_STACK_PROFILE === 'qa';
  if (env.GOAL_TASK_ID?.trim()) return true;
  // core imports admission; load its existing worktree-aware slot lookup lazily.
  const { goalSlotDirectory } = await import('./core.ts');
  return goalSlotDirectory(root) !== undefined;
}

export interface StartupMemoryOptions extends MemoryWaitOptions {
  /** Tests isolate their mutex; production processes all use the same host file. */
  lockFile?: string;
}

export interface StartupSlotGate {
  token: string;
  requester?: string;
  sequence?: number;
  status: 'pending' | 'granted' | 'retry' | 'failed';
  error?: string;
}

const startupSlotRequester = randomUUID();
let startupSlotSequence = 0;
/** The startup child retains the guard while its runner attempts the lifetime lease. */
async function waitForStartupSlot(options: StartupMemoryOptions): Promise<boolean> {
  const path = (options.env ?? process.env).REZICS_QA_STARTUP_SLOT_GATE;
  if (!path) return true;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const announce = options.announce ?? console.log;
  const sequence = ++startupSlotSequence;
  let announced = false;
  for (;;) {
    if (now() >= options.deadline) throw new Error('QA startup slot deadline reached; no work started');
    const gate = JSON.parse(readFileSync(path, 'utf8')) as StartupSlotGate;
    if (gate.requester === startupSlotRequester && gate.sequence === sequence) {
      if (gate.status === 'granted') return true;
      if (gate.status === 'retry') return false;
      if (gate.status === 'failed') throw new Error(gate.error ?? 'QA startup slot acquisition failed');
    }
    if (!announced) {
      announce(`QA_STARTUP_SLOT_READY ${gate.token} ${startupSlotRequester} ${sequence}`);
      announced = true;
    }
    await sleep(Math.min(25, options.deadline - now()));
  }
}

/** All QA processes share one SQLite writer lock, released automatically on death.
 * Keep it through Compose readiness, so the next process measures the containers
 * created by this startup instead of sharing its pre-start memory snapshot. */
export async function withMemoryStartup<T>(need: MemoryNeed, options: StartupMemoryOptions,
  start: () => T | Promise<T>): Promise<T> {
  if (!await isLocalQaRun(options.root, options.env)) return await start();
  const lockFile = options.lockFile ?? '/tmp/rezics-qa-memory-startup.sqlite';
  mkdirSync(dirname(lockFile), { recursive: true });
  const mutex = new Database(lockFile, { create: true });
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const announce = options.announce ?? console.log;
  const pollMs = options.pollMs ?? threshold(process.env, 'REZICS_QA_MEMORY_POLL_MS', 3_000);
  if (pollMs <= 0) { mutex.close(); throw new Error('REZICS_QA_MEMORY_POLL_MS must be positive'); }
  const reportWait = admissionAccounting(options, now);
  const publishWait = memoryWaitStatus(options.env ?? process.env, now);
  let held = false, announced = false;
  try {
    mutex.exec('PRAGMA busy_timeout=0');
    for (;;) {
      announced = false;
      for (;;) {
        if (now() >= options.deadline)
          throw new Error(`Memory admission deadline reached waiting for another QA startup; ${admissionMessage(need)}; no work started`);
        try {
          mutex.exec('BEGIN IMMEDIATE');
          held = true;
          break;
        } catch (error) {
          if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code ?? '')) throw error;
        }
        if (!announced) {
          const message = `Waiting for another QA startup; ${admissionMessage(need)}`;
          publishWait(message);
          announce(message);
          announced = true;
        }
        await sleep(Math.min(pollMs, Math.max(0, options.deadline - now())));
      }
      publishWait();
      await waitForMemory(need, { ...options, emitEvents: false, onAdmissionWait: undefined });
      if (await waitForStartupSlot(options)) {
        reportWait();
        return await start();
      }
      // No slot is free. Drop the guard and repeat both admissions with a fresh reading.
      mutex.exec('ROLLBACK');
      held = false;
      await sleep(Math.min(pollMs, Math.max(0, options.deadline - now())));
    }
  } finally {
    try { publishWait(); reportWait(); }
    finally {
      try { if (held) mutex.exec('ROLLBACK'); }
      finally { mutex.close(true); }
    }
  }
}

/** Child startups inherit their runner's deadline; standalone startup stays bounded. */
export function qaMemoryDeadline(env: NodeJS.ProcessEnv, deadline?: number): number {
  const inherited = env.REZICS_QA_MEMORY_DEADLINE;
  if (inherited === undefined) return deadline ?? Date.now() + 6 * 3_600_000;
  const value = Number(inherited);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid REZICS_QA_MEMORY_DEADLINE');
  return deadline === undefined ? value : Math.min(value, deadline);
}

export async function withQaStackStartup<T>(root: string, env: NodeJS.ProcessEnv, deadline: number | undefined,
  start: () => T | Promise<T>, options: Partial<StartupMemoryOptions> & { services?: readonly QaMemoryService[] } = {}): Promise<T> {
  if (!await isLocalQaRun(root, env)) return await start();
  return withMemoryStartup(qaMemoryNeed(root, env.REZICS_QA_MEMORY_KIND === 'browser' ? 'browser' : 'other',
    'catalogue-disk', env, options.services), {
    ...options, root, env, deadline: qaMemoryDeadline(env, deadline),
    read: options.read ?? (remaining => readMemory(remaining, env)),
  }, start);
}

function admissionMessage(need: MemoryNeed, reading?: MemoryReading): string {
  const gib = (bytes: number) => `${(bytes / GiB).toFixed(2)} GiB`;
  return `QA memory: Docker VM needs ${gib(need.vm)} + ${gib(need.vmReserve)} reserve, `
    + `free ${reading ? reading.vmTotal === 0 ? 'not needed' : gib(Math.max(0, reading.vmTotal - reading.vmUsed)) : 'unknown'}; `
    + `host needs ${gib(need.host)} + ${gib(need.hostReserve)} reserve, `
    + `available ${reading ? gib(reading.hostAvailable) : 'unknown'}`;
}

/** A slot authorizes concurrency; only a fresh measured reading admits the work. */
export async function waitForMemory(need: MemoryNeed, options: MemoryWaitOptions): Promise<void> {
  if (!await isLocalQaRun(options.root, options.env)) return;
  const now = options.now ?? Date.now;
  const reportWait = admissionAccounting(options, now);
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const announce = options.announce ?? console.log;
  const publishWait = memoryWaitStatus(options.env ?? process.env, now);
  const needsVm = need.vm + need.vmReserve > 0;
  const read = options.read ?? (needsVm ? readMemory : async () => readHostMemory());
  const pollMs = options.pollMs ?? threshold(process.env, 'REZICS_QA_MEMORY_POLL_MS', 3_000);
  if (pollMs <= 0) throw new Error('REZICS_QA_MEMORY_POLL_MS must be positive');
  let message = admissionMessage(need);
  try {
  for (;;) {
    if (now() >= options.deadline) throw new Error(`Memory admission deadline reached; ${message}; no work started`);
    let reading: MemoryReading;
    try {
      reading = await read(options.deadline - now());
      if (Object.values(reading).some(value => !Number.isFinite(value) || value < 0) || needsVm && reading.vmTotal === 0)
        throw new Error('Invalid memory reading');
      message = admissionMessage(need, reading);
      if (now() < options.deadline && reading.vmTotal - reading.vmUsed >= need.vm + need.vmReserve
        && reading.hostAvailable >= need.host + need.hostReserve) {
        publishWait();
        announce(`Admitted; ${message}`);
        return;
      }
    } catch (error) {
      message = `${admissionMessage(need)}; measurement failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const waiting = `Waiting; ${message}`;
    publishWait(waiting);
    announce(waiting);
    if (now() >= options.deadline) throw new Error(`Memory admission deadline reached; ${message}; no work started`);
    await sleep(Math.min(pollMs, options.deadline - now()));
  }
  } finally { publishWait(); reportWait(); }
}
