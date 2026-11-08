import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorkerStore } from './store.ts';
import type { Settings, Task, WorktreeCleanupDisposition } from './types.ts';
import { acquireDirectoryLease, LeaseHeldError, type DirectoryLease } from './lease.ts';
import { hasLiveProcessUnderAsync } from './process.ts';
import { makeOwnedTreeWritableAsync, removeOwnedTreeAsync } from './task-workspace.ts';
import { MAINTENANCE_BOOTSTRAP_PAGE_SIZE, MAINTENANCE_CANDIDATE_BATCH_SIZE } from './store.ts';

export const IO_PRESSURE_LIMIT = 20;
export const IO_PRESSURE_WAIT_ATTEMPTS = 30;
export const WORKTREE_SCAN_ENTRY_PAGE_SIZE = 64;
export type LifetimeWorkUnit =
  | 'candidate-path-stat'
  | 'permission-path-component'
  | 'process-cwd-enumeration'
  | 'process-directory-entry'
  | 'worktree-root-stat'
  | 'worktree-root-entry'
  | 'worktree-permission-expansion'
  | 'worktree-tree-expansion'
  | 'worktree-tree-entry'
  | 'git-worktree-remove'
  | 'git-registration-prune'
  | 'maintenance-backfill-task-row';
export type LifetimeRuntime = {
  pressure: () => number | null;
  sleep: (ms: number) => Promise<void>;
  command: (command: string, args: string[], cwd: string) => void | Promise<void>;
  /** Override leftover-directory removal after Git unregister; tests inject foreign-owner EACCES here. */
  removeTree?: (path: string) => number | Promise<number>;
  /** Named native/filesystem units used by the growth fixture; production callers leave it unset. */
  observe?: (unit: LifetimeWorkUnit) => void;
  /** Optional process tree for deterministic measurement fixtures. Production uses the host's /proc. */
  procRoot?: string;
};

export type WorktreeCleanupHooks = {
  blocked?: (task: Task, disposition: WorktreeCleanupDisposition) => void;
  failed?: (task: Task | undefined, error: unknown, path: string) => void;
  strayKept?: (path: string, task: Task | undefined) => void;
};

export type StrayWorktreeStatus = {
  strayDirectories: number;
  strayBytesReclaimedLastHour: number;
};

export const STRAY_RECLAIM_LOG = 'stray-worktrees.jsonl';
const HOUR_MS = 3_600_000;
class CommandStartError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const runtime: LifetimeRuntime = {
  pressure: () => {
    try {
      const line = readFileSync('/proc/pressure/io', 'utf8')
        .split('\n')
        .find((row) => row.startsWith('some '));
      const value = /(?:^| )avg10=([\d.]+)/.exec(line ?? '')?.[1];
      return value === undefined ? null : Number(value);
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  // Removal can take minutes for a worktree with a large dependency tree: run it off the host loop.
  command: async (command, args, cwd) => {
    try {
      await execFileAsync(command, args, { cwd, encoding: 'utf8' });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string; signal?: string | null };
      // A string code is a failure to start the program; a numeric code is the program's own exit status.
      if (typeof failure.code === 'string') throw new CommandStartError(failure.message, failure.code);
      throw new Error(failure.stderr || `${command} exited ${failure.code ?? failure.signal}`);
    }
  },
};

const finished = new Set(['integrated', 'merged', 'cancelled']);
const protectedStates = new Set(['running', 'landing', 'ready', 'held', 'stopped']);

type CleanupReporter = (task: Task, disposition: WorktreeCleanupDisposition) => void;
type Owner = { uid: number; gid: number } | null;
type WorktreeStat = NonNullable<ReturnType<typeof lstatSync>>;
type StrayReclaimRecord = { at: number; path: string; bytes: number; taskId?: string };
type DirectoryHandle = Awaited<ReturnType<typeof opendir>>;
type WorktreeScanHandle = {
  store: WorkerStore;
  dir: DirectoryHandle;
  generation: string;
  consumed: number;
  restoreTo: number;
};
const worktreeScanHandles = new Map<string, WorktreeScanHandle>();

function statIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

function isPermissionFailure(error: unknown): boolean {
  if (error instanceof CommandStartError) return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = String(error);
  return (
    code === 'EACCES' ||
    code === 'EPERM' ||
    /\b(?:EACCES|EPERM)\b|permission denied|operation not permitted/i.test(detail)
  );
}

function isNotWorkingTree(error: unknown): boolean {
  return /not a working tree/i.test(String(error));
}

function inside(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function reportedPath(error: unknown, root: string, mainCheckout: string): string {
  const detail = String(error);
  const patterns = [
    /(?:could not remove(?: directory)?|unable to unlink(?: old)?|cannot (?:remove|unlink)|failed to remove)\s+['"]([^'"]+)['"]/i,
    /(?:EACCES|EPERM):[^'"\n]*['"]([^'"]+)['"]/i,
    /(?:unlink|rmdir)\s+['"]([^'"]+)['"]/i,
  ];
  let value: string | undefined;
  for (const pattern of patterns) {
    value = pattern.exec(detail)?.[1];
    if (value) break;
  }
  if (!value) return root;
  const candidates = isAbsolute(value) ? [resolve(value)] : [resolve(mainCheckout, value), resolve(root, value)];
  return candidates.find((path) => inside(root, path)) ?? root;
}

function pathGeneration(root: string, path: string, observe?: () => void): { generation: string; owner: Owner } {
  const target = inside(root, path) ? resolve(path) : resolve(root);
  const rootPath = resolve(root);
  const parts = relative(rootPath, target).split(sep).filter(Boolean);
  const paths = [rootPath];
  let current = rootPath;
  for (const part of parts) {
    current = join(current, part);
    paths.push(current);
  }

  const chain: unknown[] = [];
  let owner: Owner = null;
  for (const component of paths) {
    observe?.();
    try {
      const stat = lstatSync(component, { bigint: true });
      chain.push({
        path: component,
        dev: String(stat.dev),
        ino: String(stat.ino),
        mode: String(stat.mode),
        uid: String(stat.uid),
        gid: String(stat.gid),
        ctimeNs: String(stat.ctimeNs),
        mtimeNs: String(stat.mtimeNs),
        size: String(stat.size),
        symlink: stat.isSymbolicLink(),
      });
      if (component === target) owner = { uid: Number(stat.uid), gid: Number(stat.gid) };
      // Never inspect through a symlink. It is enough to fingerprint the link itself.
      if (stat.isSymbolicLink() && component !== target) break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      chain.push({ path: component, unavailable: code });
      break;
    }
  }
  const generation = createHash('sha256').update(JSON.stringify({ target, chain })).digest('hex');
  return { generation, owner };
}

/** Refuse roots that traverse a symlink or whose ownership boundary cannot be inspected. */
function ownedDirectory(path: string, observe?: () => void): boolean {
  const absolute = resolve(path);
  const components = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    observe?.();
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(current);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return false;
    if (index < components.length - 1 && !stat.isDirectory()) return false;
    if (index === components.length - 1 && !stat.isDirectory()) return false;
  }
  return components.length > 0;
}

function expectedWorktreePath(task: Task, roots: readonly string[]): boolean {
  const worktree = resolve(task.worktree);
  return roots.some((root) => worktree === resolve(root, task.id));
}

function eligibleDirectory(task: Task, roots: readonly string[], observe?: () => void): boolean {
  const worktree = resolve(task.worktree);
  if (!expectedWorktreePath(task, roots)) return false;
  return ownedDirectory(worktree, observe);
}
function observedPathStat(io: LifetimeRuntime, path: string): ReturnType<typeof statIfPresent> {
  io.observe?.('candidate-path-stat');
  return statIfPresent(path);
}
function observedProcessCwd(io: LifetimeRuntime, path: string): Promise<boolean | null> {
  io.observe?.('process-cwd-enumeration');
  return hasLiveProcessUnderAsync(path, io.procRoot ?? '/proc', () => io.observe?.('process-directory-entry'));
}

function notify(reporter: CleanupReporter | undefined, task: Task, disposition: WorktreeCleanupDisposition): void {
  if (reporter) reporter(task, disposition);
}

function resolveHooks(reporter?: CleanupReporter | WorktreeCleanupHooks): WorktreeCleanupHooks {
  if (!reporter) return {};
  return typeof reporter === 'function' ? { blocked: reporter } : reporter;
}

function worktreeRoots(settings: Settings): string[] {
  const roots: string[] = [];
  if (settings.worktreeRoot) roots.push(resolve(settings.worktreeRoot));
  if (settings.mainCheckout && settings.worktreeRoot)
    roots.push(resolve(join(settings.mainCheckout, '.temp/worktrees')));
  return [...new Set(roots)];
}

function hasGitEntry(directory: string): boolean {
  return statIfPresent(join(directory, '.git')) !== undefined;
}

function childDirectories(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'modules') {
      dirs.push(...childDirectories(join(root, entry.name)));
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    dirs.push(join(root, entry.name));
  }
  return dirs;
}

function listWorktreeDirectories(settings: Settings): string[] {
  return worktreeRoots(settings).flatMap(childDirectories);
}

function scanHandleKey(root: string, path: string): string {
  return `${root}\0${path}`;
}

function directoryGeneration(path: string, io: LifetimeRuntime): string | null {
  io.observe?.('worktree-root-stat');
  const stat = statIfPresent(path);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return null;
  return JSON.stringify({
    dev: String(stat.dev),
    ino: String(stat.ino),
    ctimeMs: stat.ctimeMs,
    mtimeMs: stat.mtimeMs,
  });
}

async function closeWorktreeScanHandle(root: string, path: string): Promise<void> {
  const key = scanHandleKey(root, path);
  const handle = worktreeScanHandles.get(key);
  if (!handle) return;
  worktreeScanHandles.delete(key);
  try {
    await handle.dir.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error;
  }
}

/** Enumerate a bounded page and persist its cursor before the next maintenance pass. */
async function scanWorktreeDirectoryPage(
  roots: readonly string[],
  store: WorkerStore,
  io: LifetimeRuntime,
): Promise<number> {
  store.beginWorktreeCleanupScan(roots);
  if (!store.hasPendingStrayWorktrees()) {
    for (const directory of store.worktreeScanMonitors()) {
      if (!directory.complete) continue;
      const current = directoryGeneration(directory.path, io);
      if (current === directory.generation) continue;
      await closeWorktreeScanHandle(directory.root, directory.path);
      if (directory.root === directory.path) {
        store.resetWorktreeScanRoot(directory.root, current);
      } else if (current === null) {
        store.removeWorktreeScanDirectory(directory.root, directory.path);
      } else {
        store.resetWorktreeScanDirectory(directory.root, directory.path, current);
      }
      return 0;
    }
  }

  let examined = 0;
  let transitions = 0;
  while (examined < WORKTREE_SCAN_ENTRY_PAGE_SIZE && transitions < WORKTREE_SCAN_ENTRY_PAGE_SIZE) {
    transitions++;
    const directory = store.nextWorktreeScanDirectory();
    if (!directory) break;
    const generation = directoryGeneration(directory.path, io);
    if (generation === null) {
      await closeWorktreeScanHandle(directory.root, directory.path);
      if (directory.root === directory.path)
        store.updateWorktreeScanDirectory(directory.root, directory.path, null, 0, true);
      else store.removeWorktreeScanDirectory(directory.root, directory.path);
      continue;
    }
    if (directory.generation !== null && directory.generation !== generation) {
      await closeWorktreeScanHandle(directory.root, directory.path);
      store.resetWorktreeScanDirectory(directory.root, directory.path, generation);
      continue;
    }
    if (directory.generation === null)
      store.updateWorktreeScanDirectory(directory.root, directory.path, generation, directory.offset, false);

    const key = scanHandleKey(directory.root, directory.path);
    let handle = worktreeScanHandles.get(key);
    if (handle && handle.store !== store) {
      await closeWorktreeScanHandle(directory.root, directory.path);
      handle = undefined;
    }
    if (!handle) {
      let dir: DirectoryHandle;
      try {
        dir = await opendir(directory.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (directory.root === directory.path)
          store.updateWorktreeScanDirectory(directory.root, directory.path, null, 0, true);
        else store.removeWorktreeScanDirectory(directory.root, directory.path);
        continue;
      }
      handle = {
        store,
        dir,
        generation,
        consumed: 0,
        restoreTo: directory.offset,
      };
      worktreeScanHandles.set(key, handle);
    }
    let complete = false;
    while (examined < WORKTREE_SCAN_ENTRY_PAGE_SIZE) {
      const entry = await handle.dir.read();
      if (!entry) {
        complete = true;
        await closeWorktreeScanHandle(directory.root, directory.path);
        break;
      }
      examined++;
      io.observe?.('worktree-root-entry');
      handle.consumed++;
      if (handle.consumed <= handle.restoreTo) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === 'modules') {
        store.enqueueWorktreeScanDirectory(directory.root, join(directory.path, entry.name));
        continue;
      }
      const candidatePath = join(directory.path, entry.name);
      io.observe?.('candidate-path-stat');
      if (!hasGitEntry(candidatePath) && !store.hasTaskAtWorktree(candidatePath)) store.enqueueStrayWorktree(candidatePath);
    }
    store.updateWorktreeScanDirectory(
      directory.root,
      directory.path,
      generation,
      Math.max(directory.offset, handle.consumed),
      complete,
    );
  }
  return examined;
}

function strayReclaimPath(stateDirectory: string): string {
  return join(stateDirectory, STRAY_RECLAIM_LOG);
}

function recordStrayReclaim(stateDirectory: string, record: StrayReclaimRecord): void {
  appendFileSync(strayReclaimPath(stateDirectory), `${JSON.stringify(record)}\n`);
}

function readStrayReclaims(stateDirectory: string): StrayReclaimRecord[] {
  const path = strayReclaimPath(stateDirectory);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const value = JSON.parse(line) as StrayReclaimRecord;
      return value && typeof value === 'object' && typeof value.at === 'number' ? [value] : [];
    });
}

export function strayWorktreeStatus(settings: Settings, now = Date.now()): StrayWorktreeStatus {
  let strayDirectories = 0;
  if (settings.worktreeRoot)
    for (const directory of listWorktreeDirectories(settings)) if (!hasGitEntry(directory)) strayDirectories++;
  let strayBytesReclaimedLastHour = 0;
  if (settings.stateDirectory)
    for (const record of readStrayReclaims(settings.stateDirectory)) {
      if (now - record.at > HOUR_MS) continue;
      strayBytesReclaimedLastHour += record.bytes;
    }
  return { strayDirectories, strayBytesReclaimedLastHour };
}

async function deleteTree(path: string, io: LifetimeRuntime): Promise<number> {
  io.observe?.('worktree-tree-expansion');
  return io.removeTree
    ? await io.removeTree(path)
    : await removeOwnedTreeAsync(path, () => io.observe?.('worktree-tree-entry'));
}

async function sweepStrayWorktreeCandidates(
  settings: Settings,
  store: WorkerStore,
  io: LifetimeRuntime,
  hooks: WorktreeCleanupHooks,
  pressureWaits: { value: number },
): Promise<string | null> {
  const roots = worktreeRoots(settings);
  const completed: { ticket: number; path: string }[] = [];
  let removedPath: string | null = null;
  for (const candidate of store.strayWorktreeCandidates(MAINTENANCE_CANDIDATE_BATCH_SIZE)) {
    const path = resolve(candidate.path);
    if (
      store.hasTaskAtWorktree(path) ||
      !roots.some((root) => path !== root && inside(root, path))
    ) {
      completed.push(candidate);
      continue;
    }
    const before = observedPathStat(io, path);
    if (!before) {
      completed.push(candidate);
      store.markWorktreePruneNeeded();
      continue;
    }
    if (!before.isDirectory() || before.isSymbolicLink() || hasGitEntry(path)) {
      completed.push(candidate);
      continue;
    }
    const live = await observedProcessCwd(io, path);
    if (live !== false) {
      if (live === true) hooks.strayKept?.(path, undefined);
      continue;
    }
    if (!(await waitForIdleIo(io, pressureWaits))) break;
    if (store.hasTaskAtWorktree(path)) {
      completed.push(candidate);
      continue;
    }
    const beforeRemoval = observedPathStat(io, path);
    if (
      !beforeRemoval ||
      !beforeRemoval.isDirectory() ||
      beforeRemoval.isSymbolicLink() ||
      beforeRemoval.dev !== before.dev ||
      beforeRemoval.ino !== before.ino ||
      hasGitEntry(path)
    )
      continue;
    const stillLive = await observedProcessCwd(io, path);
    if (stillLive !== false) {
      if (stillLive === true) hooks.strayKept?.(path, undefined);
      continue;
    }
    try {
      const bytes = await deleteTree(path, io);
      if (observedPathStat(io, path)) throw new Error(`stray worktree path remains after cleanup: ${path}`);
      recordStrayReclaim(settings.stateDirectory, { at: Date.now(), path, bytes });
      store.markWorktreePruneNeeded();
      completed.push(candidate);
      removedPath ??= path;
    } catch (error) {
      hooks.failed?.(undefined, error, path);
    }
  }
  store.completeStrayWorktrees(completed);
  return removedPath;
}

function recordPermissionFailure(
  task: Task,
  worktreeStat: WorktreeStat,
  error: unknown,
  store: WorkerStore,
  reporter: CleanupReporter | undefined,
  mainCheckout: string,
  io?: LifetimeRuntime,
): void {
  const path = reportedPath(error, task.worktree, mainCheckout);
  const identity = pathGeneration(task.worktree, path, () => io?.observe?.('permission-path-component'));
  const disposition: WorktreeCleanupDisposition = {
    taskId: task.id,
    generation: identity.generation,
    path,
    owner: identity.owner,
    worktreeIdentity: { dev: String(worktreeStat.dev), ino: String(worktreeStat.ino) },
    detail: String(error)
      .replace(/[\r\n]+/g, ' ')
      .slice(0, store.policy.worker.summaryCharacters),
    recordedAt: new Date().toISOString(),
  };
  if (store.recordWorktreeCleanup(disposition)) notify(reporter, task, disposition);
}

async function waitForIdleIo(io: LifetimeRuntime, pressureWaits: { value: number }): Promise<boolean> {
  let pressure = io.pressure() ?? 0;
  while (pressure > IO_PRESSURE_LIMIT && pressureWaits.value < IO_PRESSURE_WAIT_ATTEMPTS) {
    await io.sleep(1000);
    pressureWaits.value++;
    pressure = io.pressure() ?? 0;
  }
  return pressure <= IO_PRESSURE_LIMIT;
}

function leftoverStillOwned(
  remaining: ReturnType<typeof statIfPresent>,
  expectedDev: string,
  expectedIno: string,
): remaining is WorktreeStat {
  return Boolean(
    remaining &&
    remaining.isDirectory() &&
    !remaining.isSymbolicLink() &&
    String(remaining.dev) === expectedDev &&
    String(remaining.ino) === expectedIno,
  );
}

export async function removeFinishedWorktree(
  settings: Settings,
  store: WorkerStore,
  io: LifetimeRuntime = runtime,
  reporter?: CleanupReporter | WorktreeCleanupHooks,
): Promise<string | null> {
  const hooks = resolveHooks(reporter);
  const lease = (() => {
    try {
      return acquireDirectoryLease(
        join(settings.stateDirectory, 'leases', 'worktree-lifetime'),
        settings.policy?.leases,
      );
    } catch (error) {
      if (error instanceof LeaseHeldError) return null;
      throw error;
    }
  })();
  if (!lease) return null;
  try {
    // Existing history is backfilled once in sequence pages. Store triggers keep later state changes current.
    const taskBackfill = store.bootstrapMaintenanceTasks(MAINTENANCE_BOOTSTRAP_PAGE_SIZE);
    for (let index = 0; index < taskBackfill.examined; index++) io.observe?.('maintenance-backfill-task-row');
    const candidates = store.worktreeMaintenanceCandidates(MAINTENANCE_CANDIDATE_BATCH_SIZE);
    const roots = worktreeRoots(settings);
    const pressureWaits = { value: 0 };
    const completed: typeof candidates = [];
    let removedId: string | null = null;
    for (const candidate of candidates) {
      const task = candidate.task;
      let taskLease: DirectoryLease;
      try {
        taskLease = acquireDirectoryLease(join(settings.stateDirectory, 'leases', task.id), settings.policy?.leases);
      } catch (error) {
        if (error instanceof LeaseHeldError) continue;
        throw error;
      }
      try {
        const current = store.task(task.id);
        const stoppedLeftover = current.state === 'stopped';
        if (!finished.has(current.state) && !stoppedLeftover) {
          completed.push(candidate);
          continue;
        }
        if (!expectedWorktreePath(current, roots)) {
          completed.push(candidate);
          continue;
        }
        const worktreeStat = observedPathStat(io, current.worktree);
        if (!worktreeStat) {
          store.clearWorktreeCleanup(current.id);
          completed.push(candidate);
          store.markWorktreePruneNeeded();
          continue;
        }
        if (!worktreeStat.isDirectory() || worktreeStat.isSymbolicLink()) {
          completed.push(candidate);
          continue;
        }
        if (!eligibleDirectory(current, roots, () => io.observe?.('permission-path-component'))) {
          completed.push(candidate);
          continue;
        }

        const oldDisposition = store.worktreeCleanup(current.id);
        if (
          oldDisposition &&
          pathGeneration(current.worktree, oldDisposition.path, () => io.observe?.('permission-path-component'))
            .generation === oldDisposition.generation
        )
          continue;

        io.observe?.('candidate-path-stat');
        if (!hasGitEntry(current.worktree)) {
          // A partial unregister is resumed through its task path; no history-sized root scan is needed.
          const live = await observedProcessCwd(io, current.worktree);
          if (live !== false) {
            if (live === true) hooks.strayKept?.(current.worktree, current);
            continue;
          }
          if (!(await waitForIdleIo(io, pressureWaits))) break;
          const afterPressure = store.task(current.id);
          const beforeRemoval = observedPathStat(io, afterPressure.worktree);
          if (
            (!finished.has(afterPressure.state) && afterPressure.state !== 'stopped') ||
            resolve(afterPressure.worktree) !== resolve(current.worktree) ||
            !eligibleDirectory(afterPressure, roots, () => io.observe?.('permission-path-component')) ||
            !beforeRemoval ||
            !beforeRemoval.isDirectory() ||
            beforeRemoval.isSymbolicLink() ||
            beforeRemoval.dev !== worktreeStat.dev ||
            beforeRemoval.ino !== worktreeStat.ino
          )
            continue;
          const stillLive = await observedProcessCwd(io, afterPressure.worktree);
          if (stillLive !== false) {
            if (stillLive === true) hooks.strayKept?.(afterPressure.worktree, afterPressure);
            continue;
          }
          try {
            const bytes = await deleteTree(afterPressure.worktree, io);
            if (observedPathStat(io, afterPressure.worktree))
              throw new Error(`worktree path remains after writable cleanup: ${afterPressure.worktree}`);
            store.clearWorktreeCleanup(afterPressure.id);
            recordStrayReclaim(settings.stateDirectory, {
              at: Date.now(),
              path: afterPressure.worktree,
              bytes,
              taskId: afterPressure.id,
            });
            completed.push(candidate);
            removedId = afterPressure.id;
            store.markWorktreePruneNeeded();
            break;
          } catch (error) {
            if (isPermissionFailure(error)) {
              const remaining = observedPathStat(io, afterPressure.worktree);
              if (remaining && leftoverStillOwned(remaining, String(worktreeStat.dev), String(worktreeStat.ino)))
                recordPermissionFailure(
                  afterPressure,
                  remaining,
                  error,
                  store,
                  hooks.blocked,
                  settings.mainCheckout,
                  io,
                );
              else hooks.failed?.(afterPressure, error, afterPressure.worktree);
              continue;
            }
            hooks.failed?.(afterPressure, error, afterPressure.worktree);
            continue;
          }
        }

        // Stopped task worktrees with a Git registration remain protected; only their unregistered leftovers are swept.
        if (!finished.has(current.state) || protectedStates.has(current.state)) {
          completed.push(candidate);
          continue;
        }

        if (!(await waitForIdleIo(io, pressureWaits))) break;
        // Recheck task state and directory identity after waiting; state may change under I/O pressure.
        const afterPressure = store.task(current.id);
        if (
          !finished.has(afterPressure.state) ||
          protectedStates.has(afterPressure.state) ||
          resolve(afterPressure.worktree) !== resolve(current.worktree) ||
          !eligibleDirectory(afterPressure, roots, () => io.observe?.('permission-path-component'))
        )
          continue;
        const beforeRemoval = observedPathStat(io, afterPressure.worktree);
        if (
          !beforeRemoval ||
          !beforeRemoval.isDirectory() ||
          beforeRemoval.isSymbolicLink() ||
          beforeRemoval.dev !== worktreeStat.dev ||
          beforeRemoval.ino !== worktreeStat.ino
        )
          continue;

        let removed = false;
        let reclaimed = 0;
        try {
          // Remote-check caches and similar owned 0555 trees must be writable before Git unregisters the worktree.
          io.observe?.('worktree-permission-expansion');
          reclaimed = await makeOwnedTreeWritableAsync(afterPressure.worktree, () => io.observe?.('worktree-tree-entry'));
          io.observe?.('git-worktree-remove');
          await io.command(
            'ionice',
            ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'remove', '--force', afterPressure.worktree],
            settings.mainCheckout,
          );
          removed = observedPathStat(io, afterPressure.worktree) === undefined;
          if (!removed) {
            reclaimed = await deleteTree(afterPressure.worktree, io);
            removed = observedPathStat(io, afterPressure.worktree) === undefined;
            if (!removed) throw new Error(`git worktree remove left the task path in place: ${afterPressure.worktree}`);
          }
        } catch (error) {
          if (observedPathStat(io, afterPressure.worktree) === undefined) {
            removed = true;
          } else if (isPermissionFailure(error) || isNotWorkingTree(error)) {
            const remaining = observedPathStat(io, afterPressure.worktree);
            const expectedDev = oldDisposition?.worktreeIdentity.dev ?? String(worktreeStat.dev);
            const expectedIno = oldDisposition?.worktreeIdentity.ino ?? String(worktreeStat.ino);
            if (!leftoverStillOwned(remaining, expectedDev, expectedIno)) {
              hooks.failed?.(afterPressure, error, afterPressure.worktree);
              continue;
            }
            try {
              reclaimed = await deleteTree(afterPressure.worktree, io);
              removed = observedPathStat(io, afterPressure.worktree) === undefined;
              if (!removed) throw new Error(`worktree path remains after writable cleanup: ${afterPressure.worktree}`);
            } catch (cleanupError) {
              if (isPermissionFailure(cleanupError) || isPermissionFailure(error)) {
                recordPermissionFailure(
                  afterPressure,
                  remaining,
                  cleanupError,
                  store,
                  hooks.blocked,
                  settings.mainCheckout,
                  io,
                );
                continue;
              }
              hooks.failed?.(afterPressure, cleanupError, afterPressure.worktree);
              continue;
            }
          } else {
            hooks.failed?.(afterPressure, error, afterPressure.worktree);
            continue;
          }
        }
        if (!removed) continue;
        store.clearWorktreeCleanup(afterPressure.id);
        if (reclaimed)
          recordStrayReclaim(settings.stateDirectory, {
            at: Date.now(),
            path: afterPressure.worktree,
            bytes: reclaimed,
            taskId: afterPressure.id,
          });
        completed.push(candidate);
        removedId = afterPressure.id;
        store.markWorktreePruneNeeded();
        break;
      } catch (error) {
        hooks.failed?.(task, error, task.worktree);
      } finally {
        taskLease.release();
      }
    }

    store.completeMaintenanceCandidates(completed);
    let strayRemoved: string | null = null;
    if (candidates.length === 0 && store.maintenanceTasksBootstrapped()) {
      await scanWorktreeDirectoryPage(roots, store, io);
      if (store.worktreeScanComplete())
        strayRemoved = await sweepStrayWorktreeCandidates(settings, store, io, hooks, pressureWaits);
    }
    const prune = store.worktreePruneProgress();
    // Coalesce stale registrations across the resumable backlog into one Git scan after its candidates drain.
    if (
      prune.generation > prune.completed &&
      store.maintenanceTasksBootstrapped() &&
      !store.hasPendingWorktreeCandidates() &&
      !store.hasWorktreeCleanupDispositions()
    ) {
      io.observe?.('git-registration-prune');
      await io.command('ionice', ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'prune'], settings.mainCheckout);
      store.completeWorktreePrune(prune.generation);
    }
    return removedId ?? strayRemoved;
  } finally {
    lease.release();
  }
}
