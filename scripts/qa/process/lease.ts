import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive, processIdentity } from './identity.ts';

/** How long a directory may exist before its owner record is durable. */
export const leaseInitializingMs = 10_000;

export interface DirectoryLeaseNote {
  goal?: string;
  task?: string;
  besideWorkers?: number;
  command?: string;
  startedAt?: string;
  commandStartedAt?: string | null;
  runId?: string;
}

export interface DirectoryLeaseRecord extends DirectoryLeaseNote {
  pid: number;
  start?: string;
  boot?: string;
  token?: string;
  /** Set when the lease moves to another process and the previous owner may still return. */
  delegatedFromPid?: number;
  /** The owner file was present but did not name a process. */
  invalid?: boolean;
}

export interface AcquiredDirectoryLease {
  directory: string;
  token: string;
  record: DirectoryLeaseRecord;
  /** Removes the directory only when it still carries this token and this owner. */
  release: () => void;
}

export interface DirectoryLeaseOptions {
  now?: () => number;
  initializingMs?: number;
  procRoot?: string;
  /** Pid-only records. A record with start time and boot id uses those instead. */
  alive?: (pid: number) => boolean;
  pid?: number;
  token?: string;
  mode?: number;
  note?: DirectoryLeaseNote;
}

export type DirectoryLeaseState = 'free' | 'held' | 'initializing' | 'stale';

function clock(options: DirectoryLeaseOptions | undefined): number {
  return (options?.now ?? Date.now)();
}

function noteOf(raw: DirectoryLeaseNote): DirectoryLeaseNote {
  return {
    ...(typeof raw.goal === 'string' ? { goal: raw.goal } : {}),
    ...(typeof raw.task === 'string' ? { task: raw.task } : {}),
    ...(typeof raw.besideWorkers === 'number' ? { besideWorkers: raw.besideWorkers } : {}),
    ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
    ...(typeof raw.startedAt === 'string' ? { startedAt: raw.startedAt } : {}),
    ...(raw.commandStartedAt === null || typeof raw.commandStartedAt === 'string'
      ? { commandStartedAt: raw.commandStartedAt } : {}),
    ...(typeof raw.runId === 'string' ? { runId: raw.runId } : {}),
  };
}

function parseRecord(value: unknown): DirectoryLeaseRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as DirectoryLeaseNote & { pid?: unknown; start?: unknown; boot?: unknown; token?: unknown; delegatedFromPid?: unknown };
  if (!Object.hasOwn(raw, 'pid')) return undefined;
  if (typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid <= 0)
    return { pid: 0, invalid: true };
  const delegated = raw.delegatedFromPid;
  return {
    pid: raw.pid,
    ...(typeof raw.start === 'string' && raw.start ? { start: raw.start } : {}),
    ...(typeof raw.boot === 'string' && raw.boot ? { boot: raw.boot } : {}),
    ...(typeof raw.token === 'string' && raw.token ? { token: raw.token } : {}),
    ...(typeof delegated === 'number' && Number.isSafeInteger(delegated) && delegated > 0
      ? { delegatedFromPid: delegated } : {}),
    ...noteOf(raw),
  };
}

function vanished(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function readRecord(path: string): DirectoryLeaseRecord | undefined {
  try { return parseRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown) ?? { pid: 0, invalid: true }; }
  catch (error) {
    if (vanished(error)) return undefined;
    if (error instanceof SyntaxError) return { pid: 0, invalid: true };
    throw error;
  }
}

/**
 * identity.json is the lease. A pid file or owner.json is read only when that
 * record is absent, so a lock left by pre-change code is not misread.
 */
export function readDirectoryLease(directory: string): DirectoryLeaseRecord | undefined {
  const identity = join(directory, 'identity.json');
  const record = readRecord(identity);
  if (record) return record;
  const owner = join(directory, 'owner.json');
  const legacy = readRecord(owner);
  if (legacy) return legacy;
  try {
    const text = readFileSync(join(directory, 'pid'), 'utf8');
    const pid = Number(text);
    if (Number.isSafeInteger(pid) && pid > 0) return { pid };
    if (text.trim()) return { pid: 0, invalid: true };
  } catch (error) { if (!vanished(error)) throw error; }
  return undefined;
}

function ownerAlive(record: DirectoryLeaseRecord, options: DirectoryLeaseOptions | undefined): boolean {
  if (record.invalid) return false;
  if (record.start !== undefined && record.boot !== undefined)
    return processAlive(record, options?.procRoot);
  return options?.alive ? options.alive(record.pid) : processAlive({ pid: record.pid }, options?.procRoot);
}

/**
 * `initializing` is a young directory whose owner has not finished writing.
 * A recorded pid that is already dead is stale immediately: the write finished
 * and the process is gone. A reused pid fails start-time and boot-id comparison.
 */
export function directoryLeaseState(directory: string, options: DirectoryLeaseOptions = {}): DirectoryLeaseState {
  const record = readDirectoryLease(directory);
  let modified: number;
  try { modified = statSync(directory).mtimeMs; }
  catch (error) {
    if (vanished(error)) return 'free';
    throw error;
  }
  if (record?.invalid) return 'stale';
  if (record) return ownerAlive(record, options) ? 'held' : 'stale';
  const age = clock(options) - modified;
  return age < (options.initializingMs ?? leaseInitializingMs) ? 'initializing' : 'stale';
}

export function directoryLeaseHeld(directory: string, options: DirectoryLeaseOptions = {}): boolean {
  const state = directoryLeaseState(directory, options);
  return state === 'held' || state === 'initializing';
}

function writeRecord(directory: string, record: DirectoryLeaseRecord): boolean {
  const path = join(directory, 'identity.json');
  const temporary = `${path}.${process.pid}.tmp`;
  const body = { ...record };
  delete body.invalid;
  try {
    writeFileSync(temporary, JSON.stringify(body));
    renameSync(temporary, path);
    writeFileSync(join(directory, 'pid'), String(record.pid));
    return true;
  } catch (error) {
    if (vanished(error)) return false;
    throw error;
  }
}

/**
 * Deletes the directory when `token` is still the owner record.
 * `ownerPid`, when passed, is the process that acquired or accepted the lease.
 * Transfer keeps the token and changes the pid, so that process deletes the
 * directory only after its successor has exited.
 */
export function releaseDirectoryLease(directory: string, token: string, ownerPid?: number): void {
  const record = readDirectoryLease(directory);
  if (!token || record?.token !== token) return;
  if (ownerPid !== undefined && record.pid !== ownerPid && ownerAlive(record, undefined)) return;
  rmSync(directory, { recursive: true, force: true });
}

function reclaimStale(directory: string, options: DirectoryLeaseOptions): boolean {
  const state = directoryLeaseState(directory, options);
  // A released lease needs no removal: another acquirer may already be creating it.
  if (state === 'free') return true;
  if (state !== 'stale') return false;
  rmSync(directory, { recursive: true, force: true });
  return !existsSync(directory);
}

/**
 * One directory lease. The caller keeps its wait, queue and fail-fast policy.
 * Release checks the token, so an old cleanup cannot drop a later owner's directory.
 */
export function tryAcquireDirectoryLease(directory: string, options: DirectoryLeaseOptions = {}):
  AcquiredDirectoryLease | 'held' {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = directoryLeaseState(directory, options);
    if (state === 'held' || state === 'initializing') return 'held';
    if (state === 'stale' && !reclaimStale(directory, options)) return 'held';
    try { mkdirSync(directory, options.mode !== undefined ? { mode: options.mode } : undefined); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const pid = options.pid ?? process.pid;
    const identity = processIdentity(pid, options.procRoot);
    const token = options.token ?? randomBytes(16).toString('hex');
    const record: DirectoryLeaseRecord = {
      pid, token, ...(identity ? { start: identity.start, boot: identity.boot } : {}),
      ...noteOf(options.note ?? {}),
    };
    try { if (!writeRecord(directory, record)) continue; }
    catch (error) {
      releaseDirectoryLease(directory, token, pid);
      throw error;
    }
    return { directory, token, record, release: () => releaseDirectoryLease(directory, token, pid) };
  }
  return 'held';
}

/** Rewrite the annotation on a lease this pid still owns. */
export function updateDirectoryLeaseNote(directory: string, pid: number, note: DirectoryLeaseNote): boolean {
  const current = readDirectoryLease(directory);
  if (!current?.token || current.pid !== pid || !existsSync(join(directory, 'identity.json'))) return false;
  return writeRecord(directory, { ...current, ...noteOf({ ...current, ...note }) });
}

/**
 * A live process takes over the lease token already on disk.
 * A pid that is not a live process is refused so a placeholder cannot erase the current owner.
 */
export function adoptLeaseOwner(directory: string, pid: number, procRoot = '/proc'): boolean {
  const identity = processIdentity(pid, procRoot);
  const current = readDirectoryLease(directory);
  if (!identity || !current?.token) return false;
  return writeRecord(directory, {
    ...noteOf(current),
    pid: identity.pid, start: identity.start, boot: identity.boot, token: current.token,
    ...(current.delegatedFromPid !== undefined ? { delegatedFromPid: current.delegatedFromPid } : {}),
  });
}

export interface DirectoryLeaseTransferOptions {
  procRoot?: string;
  /** Used when the previous owner was recorded without start time and boot id. */
  alive?: (pid: number) => boolean;
}

/**
 * The successor owns the lease until the returned function runs. That function
 * gives a still-living previous owner its lease back; otherwise it releases.
 * The token stays the same so a caller that already copied it can recognize the lease.
 */
export function transferDirectoryLease(directory: string, token: string, pid: number,
  expectedOwnerPid: number, options: DirectoryLeaseTransferOptions = {}): () => void {
  const current = readDirectoryLease(directory);
  const identity = processIdentity(pid, options.procRoot);
  if (!current?.token || current.token !== token || current.pid !== expectedOwnerPid || !identity)
    throw new Error('Shared lifecycle ownership changed before transfer');
  const previous = {
    pid: current.pid, start: current.start, boot: current.boot, delegatedFromPid: current.delegatedFromPid,
  };
  if (!writeRecord(directory, {
    ...noteOf(current),
    pid: identity.pid, start: identity.start, boot: identity.boot, token,
    delegatedFromPid: expectedOwnerPid,
  })) throw new Error('Shared lifecycle ownership changed before transfer');
  return () => {
    const now = readDirectoryLease(directory);
    if (now?.token !== token || now.pid !== pid) return;
    const parentAlive = previous.start !== undefined && previous.boot !== undefined
      ? processAlive({ pid: previous.pid, start: previous.start, boot: previous.boot }, options.procRoot)
      : (options.alive ?? (candidate => processAlive({ pid: candidate }, options.procRoot)))(previous.pid);
    if (previous.pid !== pid && parentAlive) {
      const restored = processIdentity(previous.pid, options.procRoot);
      writeRecord(directory, {
        ...noteOf(now),
        pid: previous.pid, token,
        ...(restored ? { start: restored.start, boot: restored.boot } : {}),
        ...(previous.delegatedFromPid !== undefined ? { delegatedFromPid: previous.delegatedFromPid } : {}),
      });
      return;
    }
    releaseDirectoryLease(directory, token, pid);
  };
}
