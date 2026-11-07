import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { lstat as lstatAsync, readdir as readdirAsync } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorkerStore } from './store.ts';
import type { Settings, Task, TaskState, WorktreeCleanupDisposition } from './types.ts';
import { acquireDirectoryLease, LeaseHeldError, type DirectoryLease } from './lease.ts';
import { hasLiveProcessUnderAsync } from './process.ts';
import { makeOwnedTreeWritableAsync, removeOwnedTreeAsync } from './task-workspace.ts';

export const IO_PRESSURE_LIMIT = 20;
export const IO_PRESSURE_WAIT_ATTEMPTS = 30;
export type LifetimeRuntime = {
  pressure: () => number | null;
  sleep: (ms: number) => Promise<void>;
  command: (command: string, args: string[], cwd: string) => void | Promise<void>;
  /** Override leftover-directory removal after Git unregister; tests inject foreign-owner EACCES here. */
  removeTree?: (path: string) => number | Promise<number>;
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
const KEEP_STATES = new Set<TaskState>(['running', 'landing', 'ready', 'held']);
const SWEEP_STATES = new Set<TaskState>(['integrated', 'merged', 'cancelled', 'stopped']);
const INDEX_STATES = [...KEEP_STATES, ...SWEEP_STATES, 'verified'] as const;

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
const WORKTREE_SCAN_YIELD_ENTRIES = 128;

type CleanupReporter = (task: Task, disposition: WorktreeCleanupDisposition) => void;
type Owner = { uid: number; gid: number } | null;
type WorktreeStat = NonNullable<ReturnType<typeof lstatSync>>;
type StrayReclaimRecord = { at: number; path: string; bytes: number; taskId?: string };

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

function pathGeneration(root: string, path: string): { generation: string; owner: Owner } {
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
function ownedDirectory(path: string): boolean {
  const absolute = resolve(path);
  const components = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
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

function eligibleDirectory(task: Task, roots: readonly string[]): boolean {
  const worktree = resolve(task.worktree);
  if (!roots.some((root) => worktree === resolve(root, task.id))) return false;
  return ownedDirectory(worktree);
}

function hasUnresolvedCleanup(candidates: readonly Task[], roots: readonly string[], store: WorkerStore): boolean {
  let unresolved = false;
  for (const task of candidates) {
    if (!store.worktreeCleanup(task.id)) continue;
    const expected = roots.some((root) => resolve(task.worktree) === resolve(root, task.id));
    if (!expected) {
      unresolved = true;
      continue;
    }
    try {
      if (statIfPresent(task.worktree)) unresolved = true;
      else store.clearWorktreeCleanup(task.id);
    } catch {
      // An unreadable or replaced path is not evidence that its Git registration is stale.
      unresolved = true;
    }
  }
  return unresolved;
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

async function childDirectoriesAsync(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdirAsync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const dirs: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    if (index > 0 && index % WORKTREE_SCAN_YIELD_ENTRIES === 0)
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    const entry = entries[index]!;
    if (entry.name === 'modules') {
      dirs.push(...(await childDirectoriesAsync(join(root, entry.name))));
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    dirs.push(join(root, entry.name));
  }
  return dirs;
}

async function listWorktreeDirectoriesAsync(settings: Settings): Promise<string[]> {
  const dirs: string[] = [];
  for (const root of worktreeRoots(settings)) dirs.push(...(await childDirectoriesAsync(root)));
  return dirs;
}

async function hasGitEntryAsync(directory: string): Promise<boolean> {
  try {
    await lstatAsync(join(directory, '.git'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
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

function taskByWorktree(store: WorkerStore): Map<string, Task> {
  const index = new Map<string, Task>();
  for (const task of store.tasksInStates([...INDEX_STATES])) index.set(resolve(task.worktree), task);
  return index;
}

async function deleteTree(path: string, io: LifetimeRuntime): Promise<number> {
  return io.removeTree ? await io.removeTree(path) : await removeOwnedTreeAsync(path);
}

function recordPermissionFailure(
  task: Task,
  worktreeStat: WorktreeStat,
  error: unknown,
  store: WorkerStore,
  reporter: CleanupReporter | undefined,
  mainCheckout: string,
): void {
  const path = reportedPath(error, task.worktree, mainCheckout);
  const identity = pathGeneration(task.worktree, path);
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
    // Finished states are read through the state index; the full task list held the host loop every sweep.
    const candidates = store
      .tasksInStates([...finished] as Task['state'][])
      .filter((task) => finished.has(task.state) && !protectedStates.has(task.state))
      .sort((a, b) => a.sequence - b.sequence);
    const roots = worktreeRoots(settings);
    // Git may partially remove a worktree before reporting EACCES. Pruning while its directory still exists can
    // discard the registration needed to retry after remediation, so preserve all such registrations this sweep.
    let unresolvedCleanup = hasUnresolvedCleanup(candidates, roots, store);
    // Share the wait budget across candidates whose state or directory changes while waiting.
    const pressureWaits = { value: 0 };
    let removedId: string | null = null;
    for (const task of candidates) {
      if (!eligibleDirectory(task, roots)) continue;
      let taskLease: DirectoryLease;
      try {
        taskLease = acquireDirectoryLease(join(settings.stateDirectory, 'leases', task.id), settings.policy?.leases);
      } catch (error) {
        if (error instanceof LeaseHeldError) continue;
        throw error;
      }
      try {
        const current = store.task(task.id);
        if (!finished.has(current.state) || protectedStates.has(current.state) || !eligibleDirectory(current, roots))
          continue;
        const worktreeStat = statIfPresent(current.worktree);
        if (!worktreeStat || !worktreeStat.isDirectory() || worktreeStat.isSymbolicLink()) continue;
        if (!hasGitEntry(current.worktree)) continue;

        const oldDisposition = store.worktreeCleanup(current.id);
        if (
          oldDisposition &&
          pathGeneration(current.worktree, oldDisposition.path).generation === oldDisposition.generation
        )
          continue;

        if (!(await waitForIdleIo(io, pressureWaits))) return removedId;

        // Recheck task state and directory identity after waiting; the task may have changed while pressure persisted.
        const afterPressure = store.task(current.id);
        if (
          !finished.has(afterPressure.state) ||
          protectedStates.has(afterPressure.state) ||
          resolve(afterPressure.worktree) !== resolve(current.worktree) ||
          !eligibleDirectory(afterPressure, roots)
        )
          continue;
        const beforeRemoval = statIfPresent(afterPressure.worktree);
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
          reclaimed = await makeOwnedTreeWritableAsync(afterPressure.worktree);
          await io.command(
            'ionice',
            ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'remove', '--force', afterPressure.worktree],
            settings.mainCheckout,
          );
          removed = statIfPresent(afterPressure.worktree) === undefined;
          if (!removed) {
            reclaimed = await deleteTree(afterPressure.worktree, io);
            removed = statIfPresent(afterPressure.worktree) === undefined;
            if (!removed) throw new Error(`git worktree remove left the task path in place: ${afterPressure.worktree}`);
          }
        } catch (error) {
          if (statIfPresent(afterPressure.worktree) === undefined) {
            removed = true;
          } else if (isPermissionFailure(error) || isNotWorkingTree(error)) {
            const remaining = statIfPresent(afterPressure.worktree);
            const expectedDev = oldDisposition?.worktreeIdentity.dev ?? String(worktreeStat.dev);
            const expectedIno = oldDisposition?.worktreeIdentity.ino ?? String(worktreeStat.ino);
            if (!leftoverStillOwned(remaining, expectedDev, expectedIno)) {
              hooks.failed?.(afterPressure, error, afterPressure.worktree);
              continue;
            }
            try {
              reclaimed = await deleteTree(afterPressure.worktree, io);
              removed = statIfPresent(afterPressure.worktree) === undefined;
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
                );
                unresolvedCleanup = true;
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
        if (!unresolvedCleanup)
          await io.command(
            'ionice',
            ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'prune'],
            settings.mainCheckout,
          );
        removedId = afterPressure.id;
        break;
      } catch (error) {
        hooks.failed?.(task, error, task.worktree);
      } finally {
        taskLease.release();
      }
    }

    const swept = await sweepStrayWorktrees(settings, store, io, hooks, pressureWaits);
    if (!removedId) removedId = swept;

    // Pruning stale registrations is safe after candidate work has been attempted; it does not traverse task paths.
    if (!unresolvedCleanup)
      await io.command('ionice', ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'prune'], settings.mainCheckout);
    return removedId;
  } finally {
    lease.release();
  }
}

async function sweepStrayWorktrees(
  settings: Settings,
  store: WorkerStore,
  io: LifetimeRuntime,
  hooks: WorktreeCleanupHooks,
  pressureWaits: { value: number },
): Promise<string | null> {
  const index = taskByWorktree(store);
  let removedId: string | null = null;
  for (const directory of await listWorktreeDirectoriesAsync(settings)) {
    if (await hasGitEntryAsync(directory)) continue;
    const task = index.get(resolve(directory));
    if (task && KEEP_STATES.has(task.state)) continue;
    if (task && !SWEEP_STATES.has(task.state)) continue;
    const live = await hasLiveProcessUnderAsync(directory);
    if (live !== false) {
      if (live === true) hooks.strayKept?.(directory, task);
      continue;
    }
    if (!(await waitForIdleIo(io, pressureWaits))) return removedId;
    // Pressure waits yield the host loop; recheck process custody immediately before removal.
    const currentTask = task ? store.task(task.id) : undefined;
    if (
      task &&
      (!currentTask ||
        !SWEEP_STATES.has(currentTask.state) ||
        resolve(currentTask.worktree) !== resolve(directory))
    )
      continue;
    const stillLive = await hasLiveProcessUnderAsync(directory);
    if (stillLive !== false) {
      if (stillLive === true) hooks.strayKept?.(directory, task);
      continue;
    }
    try {
      const bytes = await deleteTree(directory, io);
      recordStrayReclaim(settings.stateDirectory, {
        at: Date.now(),
        path: directory,
        bytes,
        ...(task ? { taskId: task.id } : {}),
      });
      if (task) store.clearWorktreeCleanup(task.id);
      removedId = task?.id ?? directory;
    } catch (error) {
      if (isPermissionFailure(error) && task) {
        const remaining = statIfPresent(directory);
        if (remaining) recordPermissionFailure(task, remaining, error, store, hooks.blocked, settings.mainCheckout);
        continue;
      }
      hooks.failed?.(task, error, directory);
    }
  }
  return removedId;
}
