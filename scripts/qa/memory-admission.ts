import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { cpus } from 'node:os';
import { Database } from 'bun:sqlite';
import { preserveReapEnvironment } from './container-reaper.ts';
import { processStartTime } from './process/identity.ts';
import { qaResourceClasses, type QaResourceClass } from './resource-classes.ts';

export const GiB = 1024 ** 3;
export type QaMemoryService = 'postgres' | 'fuseki' | 'rustfs' | 'toxiproxy' | 'mailpit';
export interface MemoryReading {
  vmTotal: number; vmUsed: number; hostAvailable: number;
  /** Older injected readings describe the separate Docker Desktop pool. */
  engine?: 'native' | 'desktop';
  containers?: Record<string, number>;
}
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

export function parseMemoryReading(total: string, stats: string, meminfo: string,
  operatingSystem = 'Docker Desktop'): MemoryReading {
  const vmTotal = Number(total.trim());
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  if (!Number.isSafeInteger(vmTotal) || vmTotal <= 0 || !available)
    throw new Error('Cannot read Docker memory total or host MemAvailable');
  if (!operatingSystem.trim()) throw new Error('Cannot read Docker OperatingSystem');
  const containers: Record<string, number> = {};
  const vmUsed = stats.trim() ? stats.trim().split('\n').reduce((sum, line) => {
    const row = JSON.parse(line) as { MemUsage?: string; Name?: string };
    if (!row.MemUsage) throw new Error('Docker stats did not report container memory');
    const used = memoryBytes(row.MemUsage.split('/')[0]!);
    if (row.Name) containers[row.Name] = used;
    return sum + used;
  }, 0) : 0;
  return { vmTotal, vmUsed, hostAvailable: Number(available[1]) * 1024,
    ...(!operatingSystem.includes('Docker Desktop') ? { engine: 'native' as const, containers } : {}) };
}

function readHostMemory(): MemoryReading {
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  if (!available) throw new Error('Cannot read host MemAvailable');
  return { vmTotal: 0, vmUsed: 0, hostAvailable: Number(available[1]) * 1024 };
}

const execute = promisify(execFile);
const memoryMeasurementTimeoutMs = 14_000;
export async function readMemory(remainingMs: number, env: NodeJS.ProcessEnv = process.env): Promise<MemoryReading> {
  // Twenty host readings peaked at 6.731 s; allow twice that, rounded up.
  const timeout = Math.max(1, Math.min(memoryMeasurementTimeoutMs, remainingMs));
  const [info, stats] = await Promise.all([
    execute('docker', ['info', '--format', '{{.MemTotal}}\n{{.OperatingSystem}}'], { timeout, env: preserveReapEnvironment(env) }),
    execute('docker', ['stats', '--no-stream', '--format', '{{json .}}'],
      { timeout, env: preserveReapEnvironment(env), maxBuffer: 4 * 1024 ** 2 }),
  ]);
  const [total, operatingSystem] = info.stdout.trim().split('\n');
  if (!total || !operatingSystem) throw new Error('Cannot read Docker memory total or OperatingSystem');
  return parseMemoryReading(total, stats.stdout, readFileSync('/proc/meminfo', 'utf8'), operatingSystem);
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
  /** An explicit file opts into shared state, including with injected readers or clocks. */
  lockFile?: string;
  /** Borrow caller-owned shared state; admission never closes this connection. */
  state?: Database;
  /** Override the host path without opting injected readers or clocks into sharing. */
  defaultStateFile?: string;
  /** Bound the sharing window; a completed startup always invalidates it sooner. */
  readingMaxAgeMs?: number;
  startTime?: (pid: number) => string | undefined;
  readLoad?: () => number;
  processors?: number;
  /** Compose project whose resident containers already consume MemAvailable. */
  project?: string;
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

function memoryWaitStatus(env: NodeJS.ProcessEnv, now: () => number, kind = 'memory'): (message?: string, headSince?: string) => void {
  const directory = env.GOAL_QA_WAIT_DIR;
  if (!directory) return () => {};
  let path: string | undefined;
  let since: string | undefined;
  return (message, headSince) => {
    if (!message) {
      if (path) rmSync(path, { force: true });
      path = undefined;
      since = undefined;
      return;
    }
    mkdirSync(directory, { recursive: true });
    path ??= join(directory, `${kind}-${process.pid}-${randomUUID()}.json`);
    since ??= new Date(now()).toISOString();
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, goal: env.GOAL_ID,
      command: env.GOAL_QA_COMMAND ?? process.argv.slice(1).join(' '),
      waitingFor: message.startsWith('Waiting for a QA lifetime lease;')
        ? env.GOAL_QA_HEAVY_RUN === '1' ? 'heavy' : 'slot' : kind, message, since, headSince }));
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

export type StartupMemoryOptions = MemoryWaitOptions;

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

async function startupDirectory(options: StartupMemoryOptions): Promise<string | undefined> {
  return (options.env ?? process.env).GOAL_QA_SLOT_DIRECTORY
    ?? (await import('./core.ts')).goalSlotDirectory(options.root ?? resolve(import.meta.dir, '../..'));
}

async function startupConcurrency(options: StartupMemoryOptions): Promise<number> {
  const directory = await startupDirectory(options);
  if (!directory) return 1;
  try {
    const value = readFileSync(join(dirname(directory), 'qa-startup-concurrency'), 'utf8').trim();
    const count = Number(value);
    return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(count) ? count : 1;
  } catch { return 1; }
}

async function loadLimit(options: StartupMemoryOptions, pressure: boolean): Promise<number> {
  const fallback = pressure ? 12 : 1;
  const directory = await startupDirectory(options);
  if (!directory) return fallback;
  try {
    const stored = readFileSync(join(dirname(directory), pressure ? 'qa-cpu-pressure-limit' : 'qa-load-limit'), 'utf8').trim();
    const value = Number(stored);
    return stored && Number.isFinite(value) && value >= 0 ? value : fallback;
  } catch { return fallback; }
}

function hostCpuPressure(env: NodeJS.ProcessEnv): number | undefined {
  let source: string;
  try { source = readFileSync(env.REZICS_QA_CPU_PRESSURE_FILE ?? '/proc/pressure/cpu', 'utf8'); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
  const stored = /^some\s+.*?\bavg10=(\S+)/m.exec(source)?.[1];
  const value = stored === undefined ? NaN : Number(stored);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Cannot read host CPU pressure some avg10');
  return value;
}

/** A caller that supplies its own memory reading simulates a host, and the real
 * kernel's processor signals are no part of that host: pressure is then read
 * only from a file the caller's environment names, and load only as injected.
 * Otherwise a simulated admission waits whenever the machine running it is busy. */
export function admissionCpuPressure(options: Pick<MemoryWaitOptions, 'read' | 'env'>): number | undefined {
  const env = options.env ?? process.env;
  return options.read !== undefined && env.REZICS_QA_CPU_PRESSURE_FILE === undefined ? undefined : hostCpuPressure(env);
}

function hostLoad(env: NodeJS.ProcessEnv): number {
  const value = Number(readFileSync(env.REZICS_QA_LOADAVG_FILE ?? '/proc/loadavg', 'utf8').trim().split(/\s+/)[0]);
  if (!Number.isFinite(value) || value < 0) throw new Error('Cannot read host one-minute load');
  return value;
}

interface StartupWaiter extends StartupPromise {
  seq: number; vm_reserve: number; host_reserve: number; load_wait: number; slot_ready: number;
}
interface StartupPromise {
  id: string; pid: number; start_time: string; vm: number; host: number; admitted_at: number;
  completed: number; processor_until: number;
  project?: string;
}

/** MemAvailable already charges resident native containers. Only the remaining
 * cap of the promised project's containers belongs to admission's free pool. */
function pendingContainerMemory(promise: StartupPromise, reading: MemoryReading): number {
  const project = promise.project;
  if (!project) return promise.vm;
  const resident = Object.entries(reading.containers ?? {}).reduce((sum, [name, used]) =>
    name.startsWith(`${project}-`) && /^(postgres|fuseki|rustfs|toxiproxy|mailpit)-\d+$/.test(name.slice(project.length + 1))
      ? sum + used : sum, 0);
  return Math.max(0, promise.vm - resident);
}

function memoryPool(reading: MemoryReading, promises: readonly StartupPromise[] = []) {
  return {
    vmFree: reading.vmTotal - reading.vmUsed - promises.reduce((sum, p) => sum + p.vm, 0),
    hostFree: reading.hostAvailable - promises.reduce((sum, p) => sum + p.host
      + (reading.engine === 'native' ? pendingContainerMemory(p, reading) : 0), 0),
  };
}

function memoryFits(need: MemoryNeed, reading: MemoryReading, promises: readonly StartupPromise[] = []): boolean {
  const { vmFree, hostFree } = memoryPool(reading, promises);
  return reading.engine === 'native'
    ? hostFree >= need.vm + need.host + Math.max(need.hostReserve, need.vmReserve)
    : vmFree >= need.vm + need.vmReserve && hostFree >= need.host + need.hostReserve;
}
function sqliteBusy(error: unknown): boolean {
  return ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code ?? '');
}

const memoryStateFile = '/tmp/rezics-qa-memory-startup.sqlite';
const readingMaxAgeMs = 3_000;

function openMemoryState(options: MemoryWaitOptions): { db: Database; readingOptions: MemoryWaitOptions; release: () => void } {
  if (options.state) return { db: options.state, readingOptions: options, release: () => {} };
  // Synthetic readings and clocks must neither consume nor publish host admission state.
  const privateState = options.lockFile === undefined && (options.read !== undefined || options.now !== undefined);
  const file = options.lockFile ?? (privateState ? ':memory:' : options.defaultStateFile ?? memoryStateFile);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  return { db, readingOptions: privateState ? { ...options, readingMaxAgeMs: 0 } : options,
    release: () => { db.close(true); } };
}

interface SharedReading {
  scope: string; owner: string; pid: number; start_time: string;
  generation: number; finished_at: number | null; reading: string | null; error: string | null;
}

function memoryState(db: Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_generation (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL);
    INSERT OR IGNORE INTO memory_generation VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS memory_readings (
      scope TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, start_time TEXT NOT NULL,
      generation INTEGER NOT NULL, finished_at REAL, reading TEXT, error TEXT
    )`);
  return memoryGeneration(db);
}

function memoryGeneration(db: Database): number {
  return db.query<{ generation: number }, []>('SELECT generation FROM memory_generation WHERE id = 1').get()!.generation;
}

/** A process owns a measurement, never the SQLite writer lock while Docker runs.
 * Both successful and failed results have the same lifetime. Dead owners can be replaced. */
async function sharedMemoryReading(db: Database, needsVm: boolean, options: MemoryWaitOptions,
  read: (remainingMs: number) => Promise<MemoryReading>): Promise<{ reading?: MemoryReading; error?: string; generation: number }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const startTime = options.startTime ?? processStartTime;
  const identity = startTime(process.pid);
  if (!identity) throw new Error('Cannot read QA measurement process start time');
  const scope = needsVm ? 'docker' : 'host';
  const owner = randomUUID();
  for (;;) {
    if (now() >= options.deadline) throw new Error('Memory measurement deadline reached');
    let held = false, claimed = false, pendingClaim = false, generation = 0;
    try {
      db.exec('BEGIN IMMEDIATE'); held = true;
      generation = memoryState(db);
      const cached = db.query<SharedReading, [string]>('SELECT * FROM memory_readings WHERE scope = ?').get(scope);
      if (cached?.finished_at !== null && cached?.finished_at !== undefined
        && cached.generation === generation && now() >= cached.finished_at
        && now() - cached.finished_at < (options.readingMaxAgeMs ?? readingMaxAgeMs)) {
        db.exec('COMMIT'); held = false;
        return { reading: cached.reading ? JSON.parse(cached.reading) as MemoryReading : undefined,
          error: cached.error ?? undefined, generation };
      }
      // Even after invalidation, a live owner finishes before anyone measures again.
      if (!cached || cached.finished_at !== null || startTime(cached.pid) !== cached.start_time) {
        db.query(`INSERT OR REPLACE INTO memory_readings
          (scope, owner, pid, start_time, generation) VALUES (?, ?, ?, ?, ?)`)
          .run(scope, owner, process.pid, identity, generation);
        pendingClaim = true;
      }
      db.exec('COMMIT'); held = false;
      // A competing reader can prevent COMMIT. A rolled-back owner must not
      // measure: another process can legitimately claim that missing row.
      claimed = pendingClaim;
    } catch (error) { if (!sqliteBusy(error)) throw error; }
    finally { if (held) db.exec('ROLLBACK'); }
    if (!claimed) {
      await sleep(Math.min(50, Math.max(0, options.deadline - now())));
      continue;
    }
    let reading: MemoryReading | undefined, error: string | undefined;
    try {
      reading = await read(options.deadline - now());
      measuredAdmissionMessage({ vm: 0, host: 0, vmReserve: 0, hostReserve: 0 }, reading);
    } catch (failure) {
      reading = undefined;
      error = failure instanceof Error ? failure.message : String(failure);
    }
    // Publishing uses one statement and retains the generation from before measurement.
    for (;;) {
      try {
        db.query(`UPDATE memory_readings SET finished_at = ?, reading = ?, error = ? WHERE scope = ? AND owner = ?`)
          .run(now(), reading ? JSON.stringify(reading) : null, error ?? null, scope, owner);
        break;
      } catch (failure) { if (!sqliteBusy(failure)) throw failure; }
      await sleep(Math.min(50, Math.max(0, options.deadline - now())));
    }
    return { reading, error, generation };
  }
}

/** A short host-wide transaction promises memory until Compose readiness makes
 * the startup's containers visible to the next measured reading. */
export async function withMemoryStartup<T>(need: MemoryNeed, options: StartupMemoryOptions,
  start: () => T | Promise<T>): Promise<T> {
  if (!await isLocalQaRun(options.root, options.env)) return await start();
  const { db: mutex, readingOptions, release } = openMemoryState(options);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const announce = options.announce ?? console.log;
  const pollMs = options.pollMs ?? threshold(process.env, 'REZICS_QA_MEMORY_POLL_MS', 3_000);
  if (pollMs <= 0) { release(); throw new Error('REZICS_QA_MEMORY_POLL_MS must be positive'); }
  const reportWait = admissionAccounting(options, now);
  const publishWait = memoryWaitStatus(options.env ?? process.env, now);
  const publishLoadWait = memoryWaitStatus(options.env ?? process.env, now, 'load');
  const loadEnabled = need.vm > 0;
  const processors = options.processors ?? cpus().length;
  if (!Number.isSafeInteger(processors) || processors < 1) { release(); throw new Error('Invalid QA processor count'); }
  // The same rule as for pressure: a simulated host has the load its caller injects or names in a file, never this machine's.
  const simulatedLoad = options.read !== undefined && (options.env ?? process.env).REZICS_QA_LOADAVG_FILE === undefined;
  const readLoad = options.readLoad ?? (simulatedLoad ? () => 0 : () => hostLoad(options.env ?? process.env));
  const slotReady = waitForStartupSlot(options);
  const read = options.read ?? (need.vm + need.vmReserve > 0
    ? remaining => readMemory(remaining, options.env ?? process.env) : async () => readHostMemory());
  const promiseId = randomUUID();
  const arrivedAt = now();
  const arrivalSequence = process.hrtime.bigint().toString().padStart(24, '0');
  const startTime = options.startTime ?? processStartTime;
  const identity = startTime(process.pid);
  if (!identity) { release(); throw new Error('Cannot read QA startup process start time'); }
  let held = false, promised = false, registered = false;
  let loadWaitStarted: number | undefined;
  let loadLeaseReady = false;
  let headSince: string | undefined;
  let fallbackReported = false;
  let message = `Waiting for another QA startup; ${admissionMessage(need)}`;
  try {
    mutex.exec('PRAGMA busy_timeout=0');
    for (;;) {
      let readingFits = false;
      let retryReading = false;
      const concurrency = await startupConcurrency(options);
      const loadExpired = loadWaitStarted !== undefined && now() >= options.deadline;
      if (now() >= options.deadline && !loadExpired)
        throw new Error(`Memory admission deadline reached${message.startsWith('Waiting for another')
          ? ' waiting for another QA startup' : ''}; ${message}; no work started`);
      try {
        mutex.exec('BEGIN IMMEDIATE');
        held = true;
        mutex.exec(`CREATE TABLE IF NOT EXISTS startup_promises (
          id TEXT PRIMARY KEY, pid INTEGER NOT NULL, start_time TEXT NOT NULL,
          vm REAL NOT NULL, host REAL NOT NULL, admitted_at REAL NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0, processor_until REAL NOT NULL DEFAULT 0
        )`);
        const promiseColumns = mutex.query<{ name: string }, []>('PRAGMA table_info(startup_promises)').all();
        if (!promiseColumns.some(column => column.name === 'completed'))
          mutex.exec('ALTER TABLE startup_promises ADD COLUMN completed INTEGER NOT NULL DEFAULT 0');
        if (!promiseColumns.some(column => column.name === 'processor_until'))
          mutex.exec('ALTER TABLE startup_promises ADD COLUMN processor_until REAL NOT NULL DEFAULT 0');
        if (!promiseColumns.some(column => column.name === 'project'))
          mutex.exec("ALTER TABLE startup_promises ADD COLUMN project TEXT NOT NULL DEFAULT ''");
        mutex.exec(`CREATE TABLE IF NOT EXISTS startup_waiters (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, arrival_seq TEXT NOT NULL,
          pid INTEGER NOT NULL, start_time TEXT NOT NULL, vm REAL NOT NULL, host REAL NOT NULL,
          vm_reserve REAL NOT NULL, host_reserve REAL NOT NULL, admitted_at REAL NOT NULL
        )`);
        // Extend the existing admission queue rather than introduce another scheduler.
        if (!mutex.query<{ name: string }, []>('PRAGMA table_info(startup_waiters)').all().some(column => column.name === 'load_wait'))
          mutex.exec('ALTER TABLE startup_waiters ADD COLUMN load_wait INTEGER NOT NULL DEFAULT 0');
        if (!mutex.query<{ name: string }, []>('PRAGMA table_info(startup_waiters)').all().some(column => column.name === 'slot_ready'))
          mutex.exec('ALTER TABLE startup_waiters ADD COLUMN slot_ready INTEGER NOT NULL DEFAULT 0');
        if (!registered) {
          mutex.query(`INSERT INTO startup_waiters
            (id, pid, start_time, vm, host, vm_reserve, host_reserve, admitted_at, arrival_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(promiseId, process.pid, identity, need.vm, need.host, need.vmReserve, need.hostReserve, arrivedAt, arrivalSequence);
        }
        // Registration and admission are short transactions. Docker reads never own the writer lock.
        mutex.exec('COMMIT');
        held = false;
        registered = true;
        const beforeReading = mutex.query<StartupPromise, []>('SELECT * FROM startup_promises WHERE completed = 0').all();
        let reading: MemoryReading | undefined;
        let readingGeneration = -1;
        let measured = admissionMessage(need);
        try {
          // Expiring load does not authorize memory: allow one final bounded
          // measurement with the same cache and promise accounting as every startup.
          const measurementOptions = loadExpired
            ? { ...readingOptions, deadline: now() + memoryMeasurementTimeoutMs } : readingOptions;
          const shared = await sharedMemoryReading(mutex, need.vm + need.vmReserve > 0, measurementOptions, read);
          reading = shared.reading;
          readingGeneration = shared.generation;
          if (shared.error) measured += `; measurement failed: ${shared.error}`;
          if (reading) measured = measuredAdmissionMessage(need, reading);
        } catch (error) {
          measured += `; measurement failed: ${error instanceof Error ? error.message : String(error)}`;
          reading = undefined;
        }
        // CPU some avg10 bounds time runnable tasks wait for a processor. Operators
        // change qa-cpu-pressure-limit beside the admission directory at runtime;
        // the default is 12 percent. Load average counts threads blocked on disk,
        // so use it (and the old qa-load-limit, default 1) only without kernel PSI.
        // Keep starts in the existing promises for 30 seconds, even after readiness:
        // their processor cost has not yet appeared in the signal. This prevents a
        // low reading from admitting a burst through the existing arrival queue.
        const pressure = loadEnabled ? admissionCpuPressure(options) : undefined;
        const limit = loadEnabled ? await loadLimit(options, pressure !== undefined) : 1;
        mutex.exec('BEGIN IMMEDIATE');
        held = true;
        const live: StartupPromise[] = [];
        let recentStarts = 0;
        for (const promise of mutex.query<StartupPromise, []>('SELECT * FROM startup_promises').all()) {
          if (promise.completed === 1 ? now() >= promise.processor_until
            : now() - promise.admitted_at > 15 * 60_000 || startTime(promise.pid) !== promise.start_time) {
            if (now() < promise.processor_until) {
              // An exited owner releases memory, but its containers may still start.
              mutex.query('UPDATE startup_promises SET completed = 1 WHERE id = ?').run(promise.id);
              if (promise.vm > 0) recentStarts++;
            } else mutex.query('DELETE FROM startup_promises WHERE id = ?').run(promise.id);
            if (promise.completed === 0) mutex.exec('UPDATE memory_generation SET generation = generation + 1 WHERE id = 1');
          } else {
            if (promise.completed === 0) live.push(promise);
            if (promise.vm > 0 && now() < promise.processor_until) recentStarts++;
          }
        }
        const activeStartups = live.length;
        if (readingGeneration !== memoryGeneration(mutex)) {
          reading = undefined;
          retryReading = true;
          measured = `${admissionMessage(need)}; reading predates a completed QA startup`;
        }
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
        if (reading) measured = measuredAdmissionMessage(need, reading, live);
        const fits = (waiter: StartupWaiter) => reading !== undefined && memoryFits({
          vm: waiter.vm, host: waiter.host, vmReserve: waiter.vm_reserve, hostReserve: waiter.host_reserve,
        }, reading, live);
        const ownTurn = waiters.find(waiter => waiter.id === promiseId || waiter.slot_ready === 1 && fits(waiter))?.id === promiseId;
        readingFits = activeStartups < concurrency && reading !== undefined && memoryFits(need, reading, live) && ownTurn;
        // A lifetime lease is owned by the existing runner. An ungranted request
        // must not block holders of all those leases behind it in either queue.
        // Ask only after fresh memory fits and older ready contenders have had
        // their turn, under the same admission transaction.
        const leaseReady = readingFits && (loadExpired ? loadLeaseReady
          : now() < options.deadline && slotReady.ready() && now() < options.deadline);
        mutex.query('UPDATE startup_waiters SET slot_ready = ? WHERE id = ?').run(Number(leaseReady), promiseId);
        const readyWaiters = waiters.filter(waiter => waiter.id === promiseId ? leaseReady : waiter.slot_ready === 1);
        const first = readyWaiters.find(fits);
        if (first?.id === promiseId) headSince ??= new Date(now()).toISOString();
        // A missing reading cannot prove that a different head advanced.
        else if (first) headSince = undefined;
        const load = loadEnabled && pressure === undefined ? readLoad() : 0;
        const normalizedLoad = load / processors;
        const loadQueue = readyWaiters.filter(waiter => waiter.load_wait === 1);
        const loadBlocked = loadEnabled && ((pressure === undefined ? normalizedLoad > limit : pressure >= limit)
          || (loadQueue.length > 0 && loadQueue[0]?.id !== promiseId)
          || recentStarts > 0);
        if (loadBlocked) {
          loadWaitStarted ??= now();
          mutex.query('UPDATE startup_waiters SET load_wait = 1 WHERE id = ?').run(promiseId);
        }
        const loadMessage = pressure === undefined
          ? `QA load: ${load.toFixed(2)} / ${processors} processors = ${normalizedLoad.toFixed(2)}, limit ${limit}, recent starts ${recentStarts}`
          : `QA CPU pressure some avg10 ${pressure.toFixed(2)}%, limit ${limit}%, recent starts ${recentStarts}`;
        message = `Waiting; ${measured}`;
        if (activeStartups >= concurrency) {
          message = `Waiting for another QA startup; ${measured}`;
        } else if (readingFits && !leaseReady) {
          message = `Waiting for a QA lifetime lease; ${measured}`;
        } else if (first?.id !== promiseId) {
          message += first ? `; older fitting startup pid ${first.pid} arrived ${new Date(first.admitted_at).toISOString()}` : '';
        } else if (leaseReady) {
          loadLeaseReady = true;
          if (loadBlocked && !loadExpired) {
            message = `Waiting for host load; ${loadMessage}`;
            if (pressure === undefined && !fallbackReported) {
              message += '; CPU pressure unavailable; using one-minute load average';
              fallbackReported = true;
            }
          } else {
            const processorUntil = !loadEnabled ? 0 : pressure !== undefined ? now() + 30_000
              : loadWaitStarted !== undefined ? now() + 20_000 : 0;
            mutex.query('INSERT INTO startup_promises (id, pid, start_time, vm, host, admitted_at, processor_until, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(promiseId, process.pid, identity, need.vm, need.host, now(), processorUntil, options.project ?? '');
            mutex.query('DELETE FROM startup_waiters WHERE id = ?').run(promiseId);
            mutex.exec('COMMIT');
            held = false;
            promised = true;
            publishWait();
            publishLoadWait();
            announce(`Admitted; ${measured}${loadEnabled ? `; ${loadMessage}; waited ${((now() - (loadWaitStarted ?? now())) / 1000).toFixed(1)} seconds for load${loadExpired ? '; load deadline reached, starting' : ''}` : ''}`);
            reportWait();
            break;
          }
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
      // Return a granted lifetime lease when fresh memory, startup concurrency
      // or an older ready contender prevents startup. No promise is held yet.
      if (!readingFits) { slotReady.cancel(); loadLeaseReady = false; }
      if (loadExpired) throw new Error(`Memory admission deadline reached; ${message}; no work started`);
      if (retryReading) continue;
      if (message.startsWith('Waiting for host load;')) { publishWait(); publishLoadWait(message, headSince); }
      else { publishLoadWait(); publishWait(message, headSince); }
      announce(message);
      await sleep(Math.min(pollMs, Math.max(0, options.deadline - now())));
    }
    return await start();
  } finally {
    try { if (!promised) slotReady.cancel(); publishWait(); publishLoadWait(); reportWait(); }
    finally {
      try {
        if (registered) for (;;) {
          try {
            mutex.query('DELETE FROM startup_waiters WHERE id = ?').run(promiseId);
            if (promised) {
              mutex.exec('BEGIN IMMEDIATE');
              try {
                mutex.query('UPDATE startup_promises SET completed = 1 WHERE id = ?').run(promiseId);
                mutex.query('DELETE FROM startup_promises WHERE id = ? AND processor_until <= ?').run(promiseId, now());
                mutex.exec('UPDATE memory_generation SET generation = generation + 1 WHERE id = 1');
                mutex.exec('COMMIT');
              } catch (error) { mutex.exec('ROLLBACK'); throw error; }
            }
            break;
          }
          catch (error) { if (!sqliteBusy(error)) throw error; }
          await sleep(pollMs);
        }
      }
      finally { release(); }
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
  }, start);
}

function admissionMessage(need: MemoryNeed, reading?: MemoryReading, promises: readonly StartupPromise[] = []): string {
  const gib = (bytes: number) => `${(bytes / GiB).toFixed(2)} GiB`;
  if (reading?.engine === 'native') {
    return `QA memory: native Docker Engine on host needs ${gib(need.vm)} containers + ${gib(need.host)} host `
      + `+ ${gib(Math.max(need.hostReserve, need.vmReserve))} reserve, available ${gib(Math.max(0, memoryPool(reading, promises).hostFree))}`;
  }
  return `QA memory: Docker VM needs ${gib(need.vm)} + ${gib(need.vmReserve)} reserve, `
    + `free ${reading ? reading.vmTotal === 0 ? 'not needed' : gib(Math.max(0, reading.vmTotal - reading.vmUsed)) : 'unknown'}; `
    + `host needs ${gib(need.host)} + ${gib(need.hostReserve)} reserve, `
    + `available ${reading ? gib(reading.hostAvailable) : 'unknown'}`;
}

/** The wait line may say "unknown" before a reading exists. Admission cannot. */
export function measuredAdmissionMessage(need: MemoryNeed, reading: MemoryReading, promises: readonly StartupPromise[] = []): string {
  if ([reading.vmTotal, reading.vmUsed, reading.hostAvailable, ...Object.values(reading.containers ?? {})]
    .some(value => !Number.isFinite(value) || value < 0)
    || (reading.engine !== undefined && reading.engine !== 'native' && reading.engine !== 'desktop')
    || (need.vm + need.vmReserve > 0 && reading.vmTotal === 0)) {
    throw new Error('Invalid memory reading');
  }
  const message = admissionMessage(need, reading, promises);
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
  const { db, readingOptions, release } = openMemoryState(options);
  db.exec('PRAGMA busy_timeout=0');
  let message = admissionMessage(need);
  try {
  for (;;) {
    if (now() >= options.deadline) throw new Error(`Memory admission deadline reached; ${message}; no work started`);
    let reading: MemoryReading;
    try {
      const shared = await sharedMemoryReading(db, needsVm, readingOptions, read);
      if (!shared.reading) throw new Error(shared.error ?? 'No memory reading');
      reading = shared.reading;
      const startTime = options.startTime ?? processStartTime;
      const promises = reading.engine === 'native'
        && db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'startup_promises'").get()
        ? db.query<StartupPromise, []>('SELECT * FROM startup_promises WHERE completed = 0').all()
          .filter(p => now() - p.admitted_at <= 15 * 60_000 && startTime(p.pid) === p.start_time) : [];
      message = measuredAdmissionMessage(need, reading, promises);
      if (shared.generation === memoryGeneration(db) && now() < options.deadline && memoryFits(need, reading, promises)) {
        publishWait();
        announce(`Admitted; ${message}`);
        return;
      }
    } catch (error) {
      // A concurrent admission can briefly hold the SQLite writer lock after
      // the reading returns. That is contention, not a failed measurement.
      if (sqliteBusy(error)) {
        await sleep(Math.min(50, Math.max(0, options.deadline - now())));
        continue;
      }
      message = `${admissionMessage(need)}; measurement failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const waiting = `Waiting; ${message}`;
    publishWait(waiting);
    announce(waiting);
    if (now() >= options.deadline) throw new Error(`Memory admission deadline reached; ${message}; no work started`);
    await sleep(Math.min(pollMs, options.deadline - now()));
  }
  } finally { release(); publishWait(); reportWait(); }
}
