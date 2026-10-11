import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { processAlive, processIdentity, type ProcessIdentity } from './process/identity.ts';
import { directoryLeaseHeld, tryAcquireDirectoryLease } from './process/lease.ts';
import { terminateProcessGroup, terminateProcessGroupSync } from './process/terminate.ts';

export const qaStackPoolMaxParkedMs = 15 * 60_000;
export function qaStackFingerprint(input: {
  files: readonly (readonly [path: string, content: string])[];
  images: readonly string[];
  assembler: string;
  environment: Record<string, string>;
}): string {
  const value = {
    files: [...input.files].sort(([left], [right]) => left.localeCompare(right)),
    images: [...input.images].sort(),
    assembler: input.assembler,
    environment: Object.entries(input.environment).sort(([left], [right]) => left.localeCompare(right)),
  };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export interface QaStackPoolEntry {
  projectRunId: string;
  fingerprint: string;
  apps: Record<string, string>;
  compose: Record<string, string>;
  token: string;
  holder?: ProcessIdentity;
  startupChild?: ProcessIdentity;
  parkedAt?: number;
}
export interface QaStackPoolLease {
  entry: QaStackPoolEntry;
  parkedMs: number;
  /** The caller has reset and verified every store before releasing ownership. */
  park(apps: Record<string, string>, compose: Record<string, string>): Promise<boolean>;
  destroy(): Promise<void>;
}
export interface QaStackPoolOptions {
  root: string;
  slotDirectory?: string;
  slots: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  holder?: ProcessIdentity;
  alive?: (holder: ProcessIdentity) => boolean;
  destroy?: (entry: QaStackPoolEntry) => Promise<void>;
  destroySync?: (entry: QaStackPoolEntry) => void;
  /** Tests inject teardown and a clock; the real pool always starts its idle reaper. */
  janitor?: boolean;
}
export interface QaStackPool {
  acquire(fingerprint: string): Promise<QaStackPoolLease | undefined>;
  register(projectRunId: string, fingerprint: string): Promise<QaStackPoolLease | undefined>;
  sweep(): Promise<void>;
}

const heldStacks = new Map<string, { entry: QaStackPoolEntry; state: string; cleanup: () => void }>();

function forgetHeld(key: string, token: string): void {
  if (heldStacks.get(key)?.entry.token === token) heldStacks.delete(key);
}

/** Persist the detached startup child before commandAsync returns control. */
export function trackHeldQaStackStartup(projectRunId: string, pid: number): (() => void) | undefined {
  const held = [...heldStacks.values()].find(item => item.entry.projectRunId === projectRunId);
  if (!held) return undefined;
  const identity = processIdentity(pid);
  if (!identity) return undefined;
  const saved = ownedEntry(held.state, held.entry);
  if (!saved) throw new Error('QA pool startup lost its ownership record');
  saveEntry(held.state, { ...saved, startupChild: identity });
  return () => {
    const current = ownedEntry(held.state, held.entry);
    if (current?.startupChild?.pid !== identity.pid || current.startupChild.start !== identity.start) return;
    delete current.startupChild;
    saveEntry(held.state, current);
  };
}

/** Called from the slot lease's synchronous exit path, including process.exit(124). */
export function destroyHeldQaStacks(): void {
  for (const held of [...heldStacks.values()]) {
    try { held.cleanup(); }
    catch (error) { console.error(`QA pooled stack cleanup failed: ${String(error)}`); }
  }
}

function poolPaths(slotDirectory: string) {
  const parent = dirname(slotDirectory);
  return { switchFile: join(parent, 'qa-stack-pool'), state: join(parent, 'qa-stack-pool-state') };
}

function poolOn(switchFile: string): boolean {
  try { return readFileSync(switchFile, 'utf8').trim() === 'on'; }
  catch { return false; }
}

export function qaStackPoolEnabled(slotDirectory: string | undefined): boolean {
  return slotDirectory !== undefined && poolOn(poolPaths(slotDirectory).switchFile);
}

function entryPath(state: string, projectRunId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(projectRunId)) throw new Error('Invalid QA pool project id');
  return join(state, `${projectRunId}.json`);
}

function stringMap(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string');
}

function readEntry(path: string): QaStackPoolEntry {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as QaStackPoolEntry;
  if (!raw || typeof raw.projectRunId !== 'string' || typeof raw.fingerprint !== 'string'
    || typeof raw.token !== 'string' || !raw.token || !stringMap(raw.apps) || !stringMap(raw.compose)
    || (raw.holder !== undefined && (!Number.isSafeInteger(raw.holder.pid) || raw.holder.pid < 1
      || typeof raw.holder.start !== 'string' || typeof raw.holder.boot !== 'string'))
    || (raw.holder === undefined && (!Number.isFinite(raw.parkedAt) || raw.parkedAt === undefined)))
    throw new Error(`Invalid QA pool ownership record: ${path}`);
  if (entryPath(dirname(path), raw.projectRunId) !== path)
    throw new Error(`QA pool project does not match ownership record: ${path}`);
  return raw;
}

function entries(state: string): QaStackPoolEntry[] {
  if (!existsSync(state)) return [];
  return readdirSync(state).filter(name => name.endsWith('.json')).sort()
    .map(name => readEntry(join(state, name)));
}

function saveEntry(state: string, entry: QaStackPoolEntry): void {
  const path = entryPath(state, entry.projectRunId);
  const staged = `${path}.${randomUUID()}.next`;
  writeFileSync(staged, JSON.stringify(entry), { mode: 0o600 });
  renameSync(staged, path);
}

function ownedEntry(state: string, entry: QaStackPoolEntry): QaStackPoolEntry | undefined {
  const path = entryPath(state, entry.projectRunId);
  if (!existsSync(path)) return undefined;
  const saved = readEntry(path);
  return saved.token === entry.token && saved.holder?.pid === entry.holder?.pid ? saved : undefined;
}

function dockerSync(env: NodeJS.ProcessEnv, args: string[]): string {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0)
    throw new Error(`docker ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout.trim();
}

async function dockerAsync(env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  return await new Promise((accept, reject) => {
    const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 120_000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) accept(output.trim());
      else reject(new Error(`docker ${args.join(' ')} failed: ${errors.trim()}`));
    });
  });
}

function cleanupCommands(project: string) {
  const label = `label=com.docker.compose.project=${project}`;
  return [
    { list: ['ps', '-aq', '--filter', label], remove: ['rm', '-f'] },
    { list: ['volume', 'ls', '-q', '--filter', label], remove: ['volume', 'rm', '-f'] },
    { list: ['network', 'ls', '-q', '--filter', label], remove: ['network', 'rm'] },
  ];
}

async function destroyStack(options: QaStackPoolOptions, entry: QaStackPoolEntry): Promise<void> {
  const env = options.env ?? process.env;
  // Labels also cover a holder killed during startup, before its snapshot is
  // saved. Teardown needs neither the originating worktree nor its Compose file.
  if (entry.startupChild && processAlive(entry.startupChild))
    await terminateProcessGroup(entry.startupChild.pid, { graceMs: 0 });
  for (let pass = 0; pass < (entry.startupChild ? 2 : 1); pass++) {
    if (pass) await new Promise(accept => setTimeout(accept, 1_000));
    for (const command of cleanupCommands(`rezics-qa-${entry.projectRunId}`)) {
      const ids = (await dockerAsync(env, command.list)).split(/\s+/).filter(Boolean);
      if (ids.length) await dockerAsync(env, [...command.remove, ...ids]);
      if (await dockerAsync(env, command.list)) throw new Error('QA pool project cleanup left resources behind');
    }
  }
}

function destroyStackSync(options: QaStackPoolOptions, entry: QaStackPoolEntry): void {
  const env = options.env ?? process.env;
  if (entry.startupChild && processAlive(entry.startupChild)) terminateProcessGroupSync(entry.startupChild.pid, 0);
  for (let pass = 0; pass < (entry.startupChild ? 2 : 1); pass++) {
    if (pass) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    for (const command of cleanupCommands(`rezics-qa-${entry.projectRunId}`)) {
      const ids = dockerSync(env, command.list).split(/\s+/).filter(Boolean);
      if (ids.length) dockerSync(env, [...command.remove, ...ids]);
      if (dockerSync(env, command.list)) throw new Error('QA pool project cleanup left resources behind');
    }
  }
}

function startJanitor(options: QaStackPoolOptions): void {
  if (options.janitor === false || (options.janitor === undefined && options.destroy)) return;
  if (options.slotDirectory === undefined) return;
  const { state } = poolPaths(options.slotDirectory);
  if (directoryLeaseHeld(join(state, 'janitor'))) return;
  const child = spawn(process.execPath, [resolve(import.meta.dir, 'stack-pool.ts'), '--janitor',
    options.root, options.slotDirectory, String(options.slots)], {
    detached: true, stdio: 'ignore', env: {
      ...(options.env ?? process.env), REZICS_REAP_OWNER: '', REZICS_REAP_SCOPES: '',
      REZICS_REAP_SCOPE: '', REZICS_REAP_STATE: '',
    },
  });
  child.on('error', error => { console.error(`QA pool janitor failed: ${String(error)}`); });
  child.unref();
}

async function withPoolLock<T>(state: string, run: () => Promise<T>): Promise<T> {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 180_000;
  while (true) {
    const lease = tryAcquireDirectoryLease(join(state, 'lock'));
    if (lease !== 'held') {
      try { return await run(); }
      finally { lease.release(); }
    }
    if (Date.now() >= deadline) throw new Error('QA pool ownership lock timed out');
    await new Promise(accept => setTimeout(accept, 20));
  }
}

export function createQaStackPool(options: QaStackPoolOptions): QaStackPool {
  if (options.slotDirectory === undefined) return {
    async acquire() { return undefined; }, async register() { return undefined; }, async sweep() {},
  };
  if (!Number.isSafeInteger(options.slots) || options.slots < 1) throw new Error('QA pool needs a positive slot count');
  const paths = poolPaths(options.slotDirectory);
  const now = options.now ?? Date.now;
  const alive = options.alive ?? processAlive;
  const destroy = options.destroy ?? (entry => destroyStack(options, entry));
  const destroySync = options.destroySync ?? (entry => destroyStackSync(options, entry));
  const holder = () => {
    const identity = options.holder ?? processIdentity(process.pid);
    if (!identity) throw new Error('QA pool holder has no live process identity');
    return identity;
  };
  const locked = <T>(run: () => Promise<T>) => withPoolLock(paths.state, run);
  async function remove(entry: QaStackPoolEntry): Promise<void> {
    await destroy(entry);
    rmSync(entryPath(paths.state, entry.projectRunId), { force: true });
  }
  async function sweepLocked(fingerprint?: string): Promise<void> {
    const enabled = poolOn(paths.switchFile);
    for (const entry of entries(paths.state)) {
      const unusable = entry.holder ? !alive(entry.holder)
        : !enabled || now() - entry.parkedAt! >= qaStackPoolMaxParkedMs
          || (fingerprint !== undefined && entry.fingerprint !== fingerprint);
      if (unusable) await remove(entry);
    }
    const remaining = entries(paths.state);
    let excess = remaining.length - options.slots;
    for (const entry of remaining.filter(item => !item.holder).sort((left, right) => left.parkedAt! - right.parkedAt!)) {
      if (excess <= 0) break;
      await remove(entry);
      excess--;
    }
  }
  function leaseFor(entry: QaStackPoolEntry, parkedMs: number): QaStackPoolLease {
    const key = entryPath(paths.state, entry.projectRunId);
    heldStacks.set(key, { entry, state: paths.state, cleanup: () => {
      const saved = ownedEntry(paths.state, entry);
      if (!saved) { forgetHeld(key, entry.token); return; }
      destroySync(saved);
      rmSync(key, { force: true });
      forgetHeld(key, entry.token);
    } });
    return {
      entry, parkedMs,
      async park(apps, compose) {
        return await locked(async () => {
          const saved = ownedEntry(paths.state, entry);
          if (!saved) return false;
          saved.apps = { ...apps };
          saved.compose = { ...compose };
          if (!poolOn(paths.switchFile) || entries(paths.state).length > options.slots) {
            await remove(saved);
            forgetHeld(key, entry.token);
            return false;
          }
          const parked = { ...saved, parkedAt: now() };
          delete parked.holder;
          saveEntry(paths.state, parked);
          forgetHeld(key, entry.token);
          startJanitor(options);
          return true;
        });
      },
      async destroy() {
        await locked(async () => {
          const saved = ownedEntry(paths.state, entry);
          if (saved) await remove(saved);
          forgetHeld(key, entry.token);
        });
      },
    };
  }
  return {
    async acquire(fingerprint) {
      if (!poolOn(paths.switchFile) && !existsSync(paths.state)) return undefined;
      return await locked(async () => {
        await sweepLocked(fingerprint);
        if (!poolOn(paths.switchFile)) return undefined;
        const parked = entries(paths.state).find(entry => !entry.holder && entry.fingerprint === fingerprint);
        if (!parked) return undefined;
        const parkedMs = Math.max(0, now() - parked.parkedAt!);
        const entry = { ...parked, holder: holder(), token: randomUUID() };
        delete entry.parkedAt;
        saveEntry(paths.state, entry);
        startJanitor(options);
        return leaseFor(entry, parkedMs);
      });
    },
    async register(projectRunId, fingerprint) {
      if (!poolOn(paths.switchFile)) return undefined;
      return await locked(async () => {
        await sweepLocked(fingerprint);
        if (!poolOn(paths.switchFile) || entries(paths.state).length >= options.slots) return undefined;
        if (existsSync(entryPath(paths.state, projectRunId))) throw new Error('QA pool project is already registered');
        const entry = { projectRunId, fingerprint, apps: {}, compose: {}, holder: holder(), token: randomUUID() };
        saveEntry(paths.state, entry);
        startJanitor(options);
        return leaseFor(entry, 0);
      });
    },
    async sweep() {
      if (existsSync(paths.state)) await locked(() => sweepLocked());
    },
  };
}

/** One host process watches active holders and enforces expiry even with no next QA run. */
async function runJanitor(root: string, slotDirectory: string, slots: number): Promise<void> {
  const { state } = poolPaths(slotDirectory);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const lease = tryAcquireDirectoryLease(join(state, 'janitor'));
  if (lease === 'held') return;
  const pool = createQaStackPool({ root, slotDirectory, slots, janitor: false });
  try {
    while (true) {
      try { await pool.sweep(); }
      catch (error) { console.error(`QA pool sweep failed: ${String(error)}`); }
      // Registration and the janitor's final release share this lock: a new
      // stack cannot observe a departing watcher and be left without one.
      const remaining = await withPoolLock(state, async () => {
        const current = entries(state);
        if (!current.length) lease.release();
        return current;
      });
      if (!remaining.length) return;
      const nextExpiry = Math.min(...remaining.filter(entry => !entry.holder)
        .map(entry => entry.parkedAt! + qaStackPoolMaxParkedMs));
      await new Promise(accept => setTimeout(accept, Math.max(1, Math.min(1_000, nextExpiry - Date.now()))));
    }
  } finally { lease.release(); }
}

if (import.meta.main && process.argv[2] === '--janitor') {
  await runJanitor(process.argv[3]!, process.argv[4]!, Number(process.argv[5]));
}
