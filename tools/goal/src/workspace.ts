import { defaultPolicy } from './policy.ts';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { matchesPath, pathsOverlap, validatePath } from './briefs.ts';
import { migrate, workspaceMigrations } from './db.ts';
import { acquireDirectoryLease, LeaseHeldError, type DirectoryLease } from './lease.ts';
import type { WorkerStore } from './store.ts';
import { sameProcess } from './process.ts';
import type { Brief, Settings, Task } from './types.ts';

export type ModuleWorkspace = { module: string; branch: string; worktree: string; base: string };
const glob = (path: string): boolean => /[*?]/.test(path);
/** Conservative glob containment; never guess that a broader task glob fits a module. */
function inside(path: string, patterns: readonly string[]): boolean {
  return patterns.some(
    (pattern) =>
      path === pattern ||
      (!glob(path) && matchesPath(path, [pattern])) ||
      (pattern.endsWith('/**') && (path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2)))),
  );
}
export function readWebModules(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('sharedWebModules must be a module to path-globs object');
  const modules: Record<string, string[]> = {};
  for (const [module, paths] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/.test(module) || !Array.isArray(paths) || !paths.length)
      throw new Error('invalid shared module');
    for (const path of paths) {
      if (typeof path !== 'string') throw new Error('invalid module path');
      validatePath(path);
    }
    modules[module] = [...paths];
  }
  const entries = Object.entries(modules);
  for (const [i, [, paths]] of entries.entries())
    for (const [, other] of entries.slice(i + 1))
      if (paths.some((p) => other.some((q) => pathsOverlap(p, q)))) throw new Error('shared modules overlap');
  return modules;
}
export function webModule(brief: Brief, settings: Settings): string | undefined {
  if (brief.target || !brief.paths.length) return;
  const modules = Object.entries(settings.sharedWebModules ?? {}).filter(([, patterns]) =>
    brief.paths.every((path) => inside(path, patterns)),
  );
  return modules.length === 1 ? modules[0]![0] : undefined;
}
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || 'git failed');
  return result.stdout.trimEnd();
}
export function isAncestor(cwd: string, commit: string, head: string): boolean {
  const args = ['merge-base', '--is-ancestor', commit, head];
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const cause =
    result.error?.message ||
    result.stderr?.trim() ||
    (result.signal ? `terminated by signal ${result.signal}` : `exited with status ${result.status}`);
  throw new Error(`git ${args.join(' ')} failed: ${cause}`);
}
/** Git's trailer parser excludes matching text in the subject or ordinary message body. */
export function workspaceCommits(cwd: string, base: string, head = 'HEAD'): Map<string, string[]> {
  const byTask = new Map<string, string[]>();
  const log = git(
    cwd,
    'log',
    '--reverse',
    '--no-merges',
    '--format=%H%x09%(trailers:key=Goal-Task,valueonly,separator=%x09)',
    `${base}..${head}`,
  );
  for (const line of log.split('\n')) {
    const [commit, ...tasks] = line.split('\t');
    if (!commit) continue;
    for (const id of new Set(tasks.map((task) => task.trim()).filter(Boolean)))
      byTask.set(id, [...(byTask.get(id) ?? []), commit]);
  }
  return byTask;
}
export function taskCommits(task: Task, head = 'HEAD'): string[] {
  return workspaceCommits(task.worktree, task.base, head).get(task.id) ?? [];
}
export function taskChangedPaths(task: Task, head = 'HEAD'): string[] {
  return [
    ...new Set(
      taskCommits(task, head).flatMap((commit) =>
        git(task.worktree, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit)
          .split('\0')
          .filter(Boolean),
      ),
    ),
  ];
}

/** Workers edit and commit directly. The module lease only guards idle dev merges against worker launch. */
export class WorkspaceController {
  constructor(
    readonly settings: Pick<
      Settings,
      'mainCheckout' | 'stateDirectory' | 'worktreeRoot' | 'integrationBranch' | 'sharedWebModules' | 'policy'
    >,
    readonly store: WorkerStore,
  ) {
    migrate(store.db, workspaceMigrations);
  }
  workspace(module: string): ModuleWorkspace {
    const row = this.store.db.query('SELECT body FROM module_workspaces WHERE module=?').get(module) as {
      body: string;
    } | null;
    if (!row) throw new Error(`unknown module workspace: ${module}`);
    return JSON.parse(row.body) as ModuleWorkspace;
  }
  /** Called under the existing dispatch lease. */
  open(module: string, base: string): ModuleWorkspace {
    if (!Object.hasOwn(this.settings.sharedWebModules ?? {}, module)) throw new Error('module is not configured');
    const existing = this.store.db.query('SELECT body FROM module_workspaces WHERE module=?').get(module) as {
      body: string;
    } | null;
    if (existing) return JSON.parse(existing.body) as ModuleWorkspace;
    const workspace = {
      module,
      branch: `ws/${module}`,
      worktree: join(this.settings.worktreeRoot, 'modules', module),
      base,
    };
    mkdirSync(dirname(workspace.worktree), { recursive: true });
    git(this.settings.mainCheckout, 'worktree', 'add', '-b', workspace.branch, workspace.worktree, base);
    this.store.db.query('INSERT INTO module_workspaces VALUES (?,?)').run(module, JSON.stringify(workspace));
    return workspace;
  }
  async withLaunch<T>(module: string, run: () => T | Promise<T>): Promise<T> {
    const path = join(this.settings.stateDirectory, 'leases', `workspace-${module}`);
    let lease: DirectoryLease;
    for (;;) {
      try {
        lease = acquireDirectoryLease(path, this.settings.policy?.leases);
        break;
      } catch (error) {
        if (!(error instanceof LeaseHeldError)) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, (this.settings.policy ?? defaultPolicy).leases.workspacePollMs),
        );
      }
    }
    try {
      return await run();
    } finally {
      lease.release();
    }
  }
  /** Caller holds the launch lease. Pending attempts also block merges across the publication/spawn gap. */
  syncIdle(module: string, startingTask?: string): boolean {
    const workspace = this.workspace(module);
    const busy = this.store
      .tasks()
      .some(
        (task) =>
          task.workspace?.module === module &&
          task.id !== startingTask &&
          task.currentAttempt > 0 &&
          this.store
            .attempts(task.id)
            .some(
              (attempt) =>
                ['pending', 'running'].includes(attempt.state) ||
                (attempt.process !== null && sameProcess(attempt.process)),
            ),
      );
    if (busy || git(workspace.worktree, 'status', '--porcelain')) return false;
    const dev = `refs/heads/${this.settings.integrationBranch}`;
    if (isAncestor(workspace.worktree, dev, 'HEAD')) return true;
    try {
      git(workspace.worktree, 'merge', '--no-edit', dev);
    } catch (error) {
      try {
        git(workspace.worktree, 'merge', '--abort');
      } catch (abortError) {
        throw new AggregateError(
          [error, abortError],
          `${String(error)}; merge --abort cleanup also failed: ${String(abortError)}`,
          { cause: error },
        );
      }
      throw error;
    }
    return true;
  }
  /** Publication preserves source commits, so attribution is ancestry, never a whole-branch diff. */
  integrated(module: string, dev: string): Task[] {
    const workspace = this.workspace(module);
    const commits = workspaceCommits(workspace.worktree, workspace.base);
    const integrated: Task[] = [];
    for (const task of this.store
      .tasks()
      .filter((task) => task.workspace?.module === module && !['cancelled', 'merged'].includes(task.state))) {
      const own = commits.get(task.id) ?? [];
      if (!own.length || !own.every((commit) => isAncestor(workspace.worktree, commit, dev))) continue;
      // A stopped worker may have been integrated by a peer's earlier landing. Do not rewrite its terminal
      // attempt or move an already recorded integration to an unrelated, later dev head.
      if (
        task.state === 'integrated' &&
        own.length === task.integratedCommits?.length &&
        own.every((commit) => task.integratedCommits!.includes(commit))
      )
        continue;
      const ref = { taskId: task.id, attempt: task.currentAttempt };
      const update = (current: Task) => {
        current.state = 'integrated';
        current.integratedBase = workspace.base;
        current.integratedCommits = own;
        current.integratedCommit = dev;
      };
      if (task.currentAttempt && this.store.attempt(ref).state === 'stopped')
        integrated.push(this.store.updateHeldRetryTask(ref, update));
      else integrated.push(this.store.updateTask(ref, update));
    }
    return integrated;
  }
}
