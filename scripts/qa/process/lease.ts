import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive, processIdentity } from './identity.ts';

/** How long a directory may exist before its owner record is durable. */
export const leaseInitializingMs = 10_000;

export interface DirectoryLeaseRecord {
  pid: number;
  start?: string;
  boot?: string;
  token?: string;
  /** The owner file was present but did not name a process. */
  invalid?: boolean;
}

export interface AcquiredDirectoryLease {
  directory: string;
  token: string;
  record: DirectoryLeaseRecord;
  /** Removes the directory only when it still carries this token. */
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
  publish?: (directory: string, record: DirectoryLeaseRecord) => void;
}

export type DirectoryLeaseState = 'free' | 'held' | 'initializing' | 'stale';

function clock(options: DirectoryLeaseOptions | undefined): number {
  return (options?.now ?? Date.now)();
}

function parseRecord(value: unknown): DirectoryLeaseRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { pid?: unknown; start?: unknown; boot?: unknown; token?: unknown };
  if (!Object.hasOwn(raw, 'pid')) return undefined;
  if (typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid <= 0)
    return { pid: 0, invalid: true };
  return {
    pid: raw.pid,
    ...(typeof raw.start === 'string' && raw.start ? { start: raw.start } : {}),
    ...(typeof raw.boot === 'string' && raw.boot ? { boot: raw.boot } : {}),
    ...(typeof raw.token === 'string' && raw.token ? { token: raw.token } : {}),
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** identity.json, then owner.json, then a bare pid file. */
export function readDirectoryLease(directory: string): DirectoryLeaseRecord | undefined {
  for (const name of ['identity.json', 'owner.json']) {
    try {
      const record = parseRecord(readJson(join(directory, name)));
      if (record) return record;
    } catch { /* this layout is absent or unreadable */ }
  }
  try {
    const pid = Number(readFileSync(join(directory, 'pid'), 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) return { pid };
    if (readFileSync(join(directory, 'pid'), 'utf8').trim()) return { pid: 0, invalid: true };
  } catch { /* no pid file */ }
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
  if (!existsSync(directory)) return 'free';
  const record = readDirectoryLease(directory);
  if (record?.invalid) return 'stale';
  if (record) return ownerAlive(record, options) ? 'held' : 'stale';
  const age = clock(options) - statSync(directory).mtimeMs;
  return age < (options.initializingMs ?? leaseInitializingMs) ? 'initializing' : 'stale';
}

export function directoryLeaseHeld(directory: string, options: DirectoryLeaseOptions = {}): boolean {
  const state = directoryLeaseState(directory, options);
  return state === 'held' || state === 'initializing';
}

function confirmToken(directory: string, token: string): boolean {
  try {
    if (readFileSync(join(directory, 'lease'), 'utf8') === token) return true;
  } catch { /* the lease file may live only inside identity.json */ }
  const record = readDirectoryLease(directory);
  return record?.token === token;
}

/** Deletes the directory only when `token` is still the owner record. */
export function releaseDirectoryLease(directory: string, token: string): void {
  if (!token || !confirmToken(directory, token)) return;
  if (!confirmToken(directory, token)) return;
  rmSync(directory, { recursive: true, force: true });
}

function reclaimStale(directory: string, options: DirectoryLeaseOptions): boolean {
  if (!existsSync(directory)) return true;
  if (directoryLeaseHeld(directory, options)) return false;
  if (directoryLeaseHeld(directory, options)) return false;
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
    if (existsSync(directory)) {
      if (directoryLeaseHeld(directory, options)) return 'held';
      if (!reclaimStale(directory, options)) return 'held';
    }
    try { mkdirSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const pid = options.pid ?? process.pid;
    const identity = processIdentity(pid, options.procRoot);
    const token = options.token ?? randomBytes(16).toString('hex');
    const record: DirectoryLeaseRecord = {
      pid, token, ...(identity ? { start: identity.start, boot: identity.boot } : {}),
    };
    try {
      writeFileSync(join(directory, 'identity.json'), JSON.stringify(record));
      writeFileSync(join(directory, 'lease'), token);
      writeFileSync(join(directory, 'pid'), String(pid));
      options.publish?.(directory, record);
    } catch (error) {
      releaseDirectoryLease(directory, token);
      throw error;
    }
    return { directory, token, record, release: () => releaseDirectoryLease(directory, token) };
  }
  return 'held';
}

/**
 * A live process takes over the lease token already on disk.
 * A pid that is not a live process is refused so a placeholder cannot erase the current owner.
 */
export function adoptLeaseOwner(directory: string, pid: number, procRoot = '/proc'): boolean {
  const identity = processIdentity(pid, procRoot);
  const current = readDirectoryLease(directory);
  if (!identity || !current?.token) return false;
  const record: DirectoryLeaseRecord = { pid: identity.pid, start: identity.start, boot: identity.boot, token: current.token };
  writeFileSync(join(directory, 'identity.json'), JSON.stringify(record));
  writeFileSync(join(directory, 'pid'), String(identity.pid));
  return true;
}
