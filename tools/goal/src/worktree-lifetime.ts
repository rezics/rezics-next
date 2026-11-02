import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorkerStore } from './store.ts';
import type { Settings, Task, WorktreeCleanupDisposition } from './types.ts';
import { acquireDirectoryLease, LeaseHeldError, type DirectoryLease } from './lease.ts';

export const IO_PRESSURE_LIMIT = 20;
export type LifetimeRuntime = {
  pressure: () => number | null;
  sleep: (ms: number) => Promise<void>;
  command: (command: string, args: string[], cwd: string) => void;
};

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
  command: (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (result.error) throw new CommandStartError(result.error.message, (result.error as NodeJS.ErrnoException).code);
    if (result.status !== 0) throw new Error(result.stderr || `${command} exited ${result.status}`);
  },
};

const finished = new Set(['integrated', 'merged', 'cancelled']);
const protectedStates = new Set(['running', 'landing', 'ready', 'held', 'stopped']);

type CleanupReporter = (task: Task, disposition: WorktreeCleanupDisposition) => void;
type Owner = { uid: number; gid: number } | null;
type WorktreeStat = NonNullable<ReturnType<typeof lstatSync>>;

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
      .slice(0, 1000),
    recordedAt: new Date().toISOString(),
  };
  if (store.recordWorktreeCleanup(disposition)) notify(reporter, task, disposition);
}

export async function removeFinishedWorktree(
  settings: Settings,
  store: WorkerStore,
  io: LifetimeRuntime = runtime,
  reporter?: CleanupReporter,
): Promise<string | null> {
  const lease = (() => {
    try {
      return acquireDirectoryLease(join(settings.stateDirectory, 'leases', 'worktree-lifetime'));
    } catch (error) {
      if (error instanceof LeaseHeldError) return null;
      throw error;
    }
  })();
  if (!lease) return null;
  try {
    const candidates = store
      .tasks()
      .filter((task) => finished.has(task.state) && !protectedStates.has(task.state))
      .sort((a, b) => a.sequence - b.sequence);
    const roots = [...new Set([settings.worktreeRoot, join(settings.mainCheckout, '.temp/worktrees')])];
    // Git may partially remove a worktree before reporting EACCES. Pruning while its directory still exists can
    // discard the registration needed to retry after remediation, so preserve all such registrations this sweep.
    let unresolvedCleanup = hasUnresolvedCleanup(candidates, roots, store);
    for (const task of candidates) {
      if (!eligibleDirectory(task, roots)) continue;
      let taskLease: DirectoryLease;
      try {
        taskLease = acquireDirectoryLease(join(settings.stateDirectory, 'leases', task.id));
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

        const oldDisposition = store.worktreeCleanup(current.id);
        if (
          oldDisposition &&
          pathGeneration(current.worktree, oldDisposition.path).generation === oldDisposition.generation
        )
          continue;

        while ((io.pressure() ?? 0) > IO_PRESSURE_LIMIT) await io.sleep(1000);
        // Recheck the directory after waiting for I/O capacity; do not remove a replaced path.
        const beforeRemoval = statIfPresent(current.worktree);
        if (
          !beforeRemoval ||
          !beforeRemoval.isDirectory() ||
          beforeRemoval.isSymbolicLink() ||
          beforeRemoval.dev !== worktreeStat.dev ||
          beforeRemoval.ino !== worktreeStat.ino
        )
          continue;

        let removed = false;
        try {
          io.command(
            'ionice',
            ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'remove', '--force', current.worktree],
            settings.mainCheckout,
          );
          removed = statIfPresent(current.worktree) === undefined;
          if (!removed) throw new Error(`git worktree remove left the task path in place: ${current.worktree}`);
        } catch (error) {
          if (statIfPresent(current.worktree) === undefined) {
            removed = true;
          } else if (isPermissionFailure(error)) {
            recordPermissionFailure(current, worktreeStat, error, store, reporter, settings.mainCheckout);
            unresolvedCleanup = true;
            continue;
          } else if (oldDisposition && isNotWorkingTree(error)) {
            // A failed Git removal can detach .git before it reaches the permission-denied entry. Once the
            // filesystem generation changes, remove only the same task directory inode that was recorded.
            const remaining = statIfPresent(current.worktree);
            if (
              !remaining ||
              !remaining.isDirectory() ||
              remaining.isSymbolicLink() ||
              String(remaining.dev) !== oldDisposition.worktreeIdentity.dev ||
              String(remaining.ino) !== oldDisposition.worktreeIdentity.ino
            )
              throw error;
            try {
              rmSync(current.worktree, { recursive: true, force: false });
              removed = statIfPresent(current.worktree) === undefined;
              if (!removed) throw new Error(`worktree path remains after bounded cleanup: ${current.worktree}`);
            } catch (cleanupError) {
              if (!isPermissionFailure(cleanupError)) throw cleanupError;
              recordPermissionFailure(current, remaining, cleanupError, store, reporter, settings.mainCheckout);
              unresolvedCleanup = true;
              continue;
            }
          } else {
            throw error;
          }
        }
        if (!removed) continue;
        store.clearWorktreeCleanup(current.id);
        if (!unresolvedCleanup)
          io.command('ionice', ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'prune'], settings.mainCheckout);
        return current.id;
      } finally {
        taskLease.release();
      }
    }

    // Pruning stale registrations is safe after candidate work has been attempted; it does not traverse task paths.
    if (!unresolvedCleanup)
      io.command('ionice', ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'prune'], settings.mainCheckout);
    return null;
  } finally {
    lease.release();
  }
}
