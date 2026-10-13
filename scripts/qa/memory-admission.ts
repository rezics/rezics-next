import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Database } from 'bun:sqlite';
import { preserveReapEnvironment } from './container-reaper.ts';
import { processStartTime } from './process/identity.ts';
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
    execute('docker', ['info', '--format', '{{.MemTotal}}'], { timeout, env: preserveReapEnvironment(env) }),
    execute('docker', ['stats', '--no-stream', '--format', '{{json .}}'],
      { timeout, env: preserveReapEnvironment(env), maxBuffer: 4 * 1024 ** 2 }),
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
      command: env.GOAL_QA_COMMAND ?? process.argv.slice(1).join(' '),
      waitingFor: message.startsWith('Waiting for a QA lifetime lease;')
        ? env.GOAL_QA_HEAVY_RUN === '1' ? 'heavy' : 'slot' : 'memory', message, since }));
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
  /** Process identity reader for deterministic queue/death tests. */
  startTime?: (pid: number) => string | undefined;
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
/** Request the lifetime lease under admission, but poll it between transactions. */
function waitForStartupSlot(options: StartupMemoryOptions): { ready: () => boolean; cancel: () => void } {
  const path = (options.env ?? process.env).REZICS_QA_STARTUP_SLOT_GATE;
  if (!path) return { ready: () => true, cancel: () => {} };
  const now = options.now ?? Date.now;
  const announce = options.announce ?? console.log;
  let sequence = ++startupSlotSequence;
  let announced = false;
  const cancel = () => {
    if (!announced) return;
    announce(`QA_STARTUP_SLOT_CANCEL ${JSON.parse(readFileSync(path, 'utf8')).token} ${startupSlotRequester} ${sequence}`);
    sequence = ++startupSlotSequence;
    announced = false;
  };
  return { cancel, ready: () => {
    if (now() >= options.deadline) throw new Error('QA startup slot deadline reached; no work started');
    let gate = JSON.parse(readFileSync(path, 'utf8')) as StartupSlotGate;
    // Sibling startups can share the mailbox. A completed foreign reply may have
    // overwritten ours; a new sequence asks the runner to acknowledge us again.
    if (announced && gate.requester && gate.status !== 'pending'
      && (gate.requester !== startupSlotRequester || gate.sequence !== sequence)) {
      sequence = ++startupSlotSequence;
      announced = false;
    }
    if (!announced) {
      announce(`QA_STARTUP_SLOT_READY ${gate.token} ${startupSlotRequester} ${sequence}`);
      announced = true;
      gate = JSON.parse(readFileSync(path, 'utf8')) as StartupSlotGate;
    }
    if (gate.requester === startupSlotRequester && gate.sequence === sequence) {
      if (gate.status === 'granted') return true;
      if (gate.status === 'retry') {
        sequence = ++startupSlotSequence;
        announced = false;
        return false;
      }
      if (gate.status === 'failed') throw new Error(gate.error ?? 'QA startup slot acquisition failed');
    }
    return false;
  } };
}

async function startupConcurrency(options: StartupMemoryOptions): Promise<number> {
  const directory = (options.env ?? process.env).GOAL_QA_SLOT_DIRECTORY
    ?? (await import('./core.ts')).goalSlotDirectory(options.root ?? resolve(import.meta.dir, '../..'));
  if (!directory) return 1;
  try {
    const value = readFileSync(join(dirname(directory), 'qa-startup-concurrency'), 'utf8').trim();
    const count = Number(value);
    return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(count) ? count : 1;
  } catch { return 1; }
}

interface StartupWaiter extends StartupPromise { seq: number; vm_reserve: number; host_reserve: number }
interface StartupPromise { id: string; pid: number; start_time: string; vm: number; host: number; admitted_at: number }
function sqliteBusy(error: unknown): boolean {
  return ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code ?? '');
}

/** A short host-wide transaction promises memory until Compose readiness makes
 * the startup's containers visible to the next measured reading. */
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
  const slotReady = waitForStartupSlot(options);
  const read = options.read ?? (need.vm + need.vmReserve > 0 ? readMemory : async () => readHostMemory());
  const promiseId = randomUUID();
  const arrivedAt = now();
  const arrivalSequence = process.hrtime.bigint().toString().padStart(24, '0');
  const startTime = options.startTime ?? processStartTime;
  const identity = startTime(process.pid);
  if (!identity) { mutex.close(); throw new Error('Cannot read QA startup process start time'); }
  let held = false, promised = false, registered = false;
  let message = `Waiting for another QA startup; ${admissionMessage(need)}`;
  try {
    mutex.exec('PRAGMA busy_timeout=0');
    for (;;) {
      let readingFits = false;
      const concurrency = await startupConcurrency(options);
      if (now() >= options.deadline)
        throw new Error(`Memory admission deadline reached${message.startsWith('Waiting for another')
          ? ' waiting for another QA startup' : ''}; ${message}; no work started`);
      try {
        mutex.exec('BEGIN IMMEDIATE');
        held = true;
        mutex.exec(`CREATE TABLE IF NOT EXISTS startup_promises (
          id TEXT PRIMARY KEY, pid INTEGER NOT NULL, start_time TEXT NOT NULL,
          vm REAL NOT NULL, host REAL NOT NULL, admitted_at REAL NOT NULL
        )`);
        mutex.exec(`CREATE TABLE IF NOT EXISTS startup_waiters (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, arrival_seq TEXT NOT NULL,
          pid INTEGER NOT NULL, start_time TEXT NOT NULL, vm REAL NOT NULL, host REAL NOT NULL,
          vm_reserve REAL NOT NULL, host_reserve REAL NOT NULL, admitted_at REAL NOT NULL
        )`);
        if (!registered) {
          mutex.query(`INSERT INTO startup_waiters
            (id, pid, start_time, vm, host, vm_reserve, host_reserve, admitted_at, arrival_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(promiseId, process.pid, identity, need.vm, need.host, need.vmReserve, need.hostReserve, arrivedAt, arrivalSequence);
        }
        // Registration and admission are short transactions. Docker reads never own the writer lock.
        mutex.exec('COMMIT');
        held = false;
        registered = true;
        const beforeReading = mutex.query<StartupPromise, []>('SELECT * FROM startup_promises').all();
        let reading: MemoryReading | undefined;
        let measured = admissionMessage(need);
        try {
          reading = await read(options.deadline - now());
          measured = measuredAdmissionMessage(need, reading);
        } catch (error) {
          measured += `; measurement failed: ${error instanceof Error ? error.message : String(error)}`;
          reading = undefined;
        }
        mutex.exec('BEGIN IMMEDIATE');
        held = true;
        const live: StartupPromise[] = [];
        for (const promise of mutex.query<StartupPromise, []>('SELECT * FROM startup_promises').all()) {
          if (now() - promise.admitted_at > 15 * 60_000 || startTime(promise.pid) !== promise.start_time)
            mutex.query('DELETE FROM startup_promises WHERE id = ?').run(promise.id);
          else live.push(promise);
        }
        const activeStartups = live.length;
        for (const promise of beforeReading) {
          if (!live.some(current => current.id === promise.id) && startTime(promise.pid) === promise.start_time
            && now() - promise.admitted_at <= 15 * 60_000) live.push(promise);
        }
        const waiters: StartupWaiter[] = [];
        for (const waiter of mutex.query<StartupWaiter, []>('SELECT * FROM startup_waiters ORDER BY admitted_at, arrival_seq, seq').all()) {
          if (startTime(waiter.pid) !== waiter.start_time)
            mutex.query('DELETE FROM startup_waiters WHERE id = ?').run(waiter.id);
          else waiters.push(waiter);
        }
        const vmFree = reading ? reading.vmTotal - reading.vmUsed - live.reduce((sum, p) => sum + p.vm, 0) : -1;
        const hostFree = reading ? reading.hostAvailable - live.reduce((sum, p) => sum + p.host, 0) : -1;
        const first = waiters.find(waiter => vmFree >= waiter.vm + waiter.vm_reserve
          && hostFree >= waiter.host + waiter.host_reserve);
        readingFits = activeStartups < concurrency && first?.id === promiseId;
        message = `Waiting; ${measured}`;
        if (activeStartups >= concurrency) {
          message = `Waiting for another QA startup; ${measured}`;
        } else if (first?.id !== promiseId) {
          message += first ? `; older fitting startup pid ${first.pid} arrived ${new Date(first.admitted_at).toISOString()}` : '';
        } else if (now() < options.deadline && slotReady.ready() && now() < options.deadline) {
          mutex.query('INSERT INTO startup_promises (id, pid, start_time, vm, host, admitted_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(promiseId, process.pid, identity, need.vm, need.host, now());
          mutex.query('DELETE FROM startup_waiters WHERE id = ?').run(promiseId);
          mutex.exec('COMMIT');
          held = false;
          promised = true;
          publishWait();
          announce(`Admitted; ${measured}`);
          reportWait();
          break;
        } else {
          message = `Waiting for a QA lifetime lease; ${measured}`;
        }
        mutex.exec('COMMIT');
        held = false;
      } catch (error) {
        if (!sqliteBusy(error)) throw error;
        readingFits = false;
        message = `Waiting for another QA startup; ${admissionMessage(need)}`;
      } finally {
        if (held) { mutex.exec('ROLLBACK'); held = false; }
      }
      // A previously granted lifetime lease must be returned if a fresh reading
      // or an older fitting request prevents startup. No promise is held yet.
      if (!readingFits) slotReady.cancel();
      publishWait(message);
      announce(message);
      await sleep(Math.min(pollMs, Math.max(0, options.deadline - now())));
    }
    return await start();
  } finally {
    try { if (!promised) slotReady.cancel(); publishWait(); reportWait(); }
    finally {
      try {
        if (registered) for (;;) {
          try {
            mutex.query('DELETE FROM startup_waiters WHERE id = ?').run(promiseId);
            if (promised) mutex.query('DELETE FROM startup_promises WHERE id = ?').run(promiseId);
            break;
          }
          catch (error) { if (!sqliteBusy(error)) throw error; }
          await sleep(pollMs);
        }
      }
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

/** The wait line may say "unknown" before a reading exists. Admission cannot. */
export function measuredAdmissionMessage(need: MemoryNeed, reading: MemoryReading): string {
  if (Object.values(reading).some(value => !Number.isFinite(value) || value < 0)
    || (need.vm + need.vmReserve > 0 && reading.vmTotal === 0)) {
    throw new Error('Invalid memory reading');
  }
  const message = admissionMessage(need, reading);
  if (message.includes('unknown')) throw new Error('Memory admission requires a reading');
  return message;
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
      message = measuredAdmissionMessage(need, reading);
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
