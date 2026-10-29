import { agentAdapter } from './agents.ts';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { parseBrief, readRiskOwnership, withStabilizeTarget } from './briefs.ts';
import { StaleAttemptError } from './contracts.ts';
import { acquireDirectoryLease, acquireDirectoryLeaseWaiting, LeaseHeldError } from './lease.ts';
import { classifyTask, readRouting, retryFallbacks, routeTask } from './routing.ts';
import { choosePoolWithFallback, PoolPolicyReloader } from './pools.ts';
import { pace, readCodexSchedule } from './pacing.ts';
import { readPool, withObservedExhaustion, type PoolReader } from './usage.ts';
import { awaitHostCapacity, launch, startsFirst, workerPrompt, type RunningWorker } from './launch.ts';
import { rebaseOnto } from './merge-train.ts';
import { terminateProcessGroup } from './process.ts';
import { readMeasurement, makeRecord } from './records.ts';
import { SqliteManagerInbox } from './inbox.ts';
import type { WorkerStore } from './store.ts';
import type { Attempt, Profile, Settings, Task } from './types.ts';
import { frozenFile, parseFrozenFiles, type FrozenFile } from './frozen.ts';
import { webModule, WorkspaceController } from './workspace.ts';
import { installShared } from './shared-dependencies.ts';

type FrozenTask = Task & { frozenFiles?: Pick<FrozenFile, 'path' | 'hash'>[] };
function normalizedBriefText(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').trimEnd();
}

function briefHash(markdown: string): string {
  return createHash('sha256').update(normalizedBriefText(markdown)).digest('hex');
}

function sameBriefText(left: string, right: string): boolean {
  return normalizedBriefText(left) === normalizedBriefText(right);
}

export class BriefContractUnchangedError extends Error {
  constructor() {
    super('The contract is unchanged.');
    this.name = 'BriefContractUnchangedError';
  }
}

function frozenFiles(task: Task): Pick<FrozenFile, 'path' | 'hash'>[] {
  return (task as FrozenTask).frozenFiles ?? [];
}
type FrozenCommit = { files: FrozenFile[]; formatterError?: string };

function commitFrozenFiles(
  worktree: string,
  files: readonly FrozenFile[],
  formatCommand: readonly string[],
  previous: readonly Pick<FrozenFile, 'path' | 'hash'>[] = [],
  shared = false,
): FrozenCommit {
  const current = new Map(files.map((file) => [file.path, file]));
  const touched = new Set([...previous.map((file) => file.path), ...current.keys()]);
  for (const path of touched) {
    const target = resolve(worktree, path);
    const fromRoot = relative(resolve(worktree), target);
    if (!fromRoot || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot))
      throw new Error(`invalid frozen file path: ${path}`);
    let component = resolve(worktree);
    for (const part of path.split('/')) {
      component = join(component, part);
      try {
        if (lstatSync(component).isSymbolicLink()) throw new Error(`frozen file path crosses a symbolic link: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        break;
      }
    }
    const file = current.get(path);
    if (file) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    } else if (existsSync(target)) rmSync(target, { force: true });
  }
  if (!touched.size) return { files: [] };
  let formatterError: string | undefined;
  const formatterAvailable = !formatCommand[0]!.endsWith('/node_modules/.bin/oxfmt') || existsSync(formatCommand[0]!);
  if (current.size && formatterAvailable) {
    const formatted = spawnSync(formatCommand[0]!, [...formatCommand.slice(1), ...current.keys()], {
      cwd: worktree,
      encoding: 'utf8',
    });
    if (formatted.status !== 0) {
      formatterError =
        `${formatted.stdout ?? ''}${formatted.stderr ?? ''}`.trim() ||
        formatted.error?.message ||
        `formatter exited with status ${formatted.status}`;
      // Some formatters write earlier files before failing on a later one. A rejected brief must remain byte-for-byte
      // intact so its hashes and the manager's repair target still describe the source the worker received.
      for (const file of files) writeFileSync(join(worktree, file.path), file.content, 'utf8');
    }
  }
  const committedFiles = formatterError
    ? [...files]
    : files.map((file) => frozenFile(file.path, readFileSync(join(worktree, file.path))));
  const existing = [...current.keys()];
  if (existing.length) git(worktree, ['add', '-A', '--', ...existing]);
  const removed = previous.map((file) => file.path).filter((path) => !current.has(path));
  if (removed.length) git(worktree, ['add', '-u', '--', ...removed]);
  const status = spawnSync('git', ['diff', '--cached', '--quiet', ...(shared ? ['--', ...touched] : [])], {
    cwd: worktree,
  });
  if (status.status !== 0)
    git(worktree, ['commit', '-m', 'test: frozen acceptance files', ...(shared ? ['--only', '--', ...touched] : [])]);
  return { files: committedFiles, ...(formatterError ? { formatterError } : {}) };
}

function reportFrozenFormatError(error: string | undefined): void {
  if (error) console.error(`Frozen acceptance formatter failed:\n${error}`);
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `git exited ${result.status}`;
    throw new Error(`git ${args[0]}: ${detail}`);
  }
  return result.stdout.trimEnd();
}
function installWorktreeDependencies(worktree: string): void {
  installShared(worktree);
}
export type RetryOptions = {
  brief?: string;
  profile?: Profile;
  fixRound?: number;
  consulted?: boolean;
  escalation?: string;
  evidence?: string;
  consultation?: string;
  excludePools?: string[];
  conflictFiles?: string[];
  /** Start only while this is still the current attempt: a retry another process already started is not repeated. */
  expectedAttempt?: number;
};
export class HeldTaskConflictError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'HeldTaskConflictError';
  }
}
export class TaskHeldForDependenciesError extends Error {
  constructor() {
    super('task held until its dependencies merge');
    this.name = 'TaskHeldForDependenciesError';
  }
}
export class WorkerTasks {
  private readonly poolPolicies: PoolPolicyReloader;
  constructor(
    readonly settings: Settings,
    readonly store: WorkerStore,
    readonly reader: PoolReader = readPool,
    readonly launcher: typeof launch = launch,
  ) {
    this.poolPolicies = new PoolPolicyReloader(settings.localFile, settings.pools, (summary) => {
      new SqliteManagerInbox(store.db, settings.integration.inboxDirectory).deliver({
        managerId: settings.integration.supermanager,
        kind: 'instruction',
        summary,
      });
    });
  }
  private branchHead(branch: string, createFromMain: boolean): string {
    const reference = `refs/heads/${branch}`;
    try {
      return git(this.settings.mainCheckout, ['rev-parse', '--verify', reference]);
    } catch {
      if (!createFromMain) throw new Error(`stabilize branch ${branch} does not exist`);
      const main = git(this.settings.mainCheckout, ['rev-parse', '--verify', `refs/heads/${this.settings.mainBranch}`]);
      try {
        git(this.settings.mainCheckout, ['branch', '--', branch, main]);
      } catch (error) {
        try {
          return git(this.settings.mainCheckout, ['rev-parse', '--verify', reference]);
        } catch {
          throw error;
        }
      }
      return main;
    }
  }
  private taskBaseBranch(brief: { goal?: string; target?: 'stabilize'; after?: readonly string[] }): string {
    // Dev tasks start from the dev head, as trunk-based work does; dev-verified gates promotion only. Starting from
    // dev-verified while the verifier lagged by hundreds of commits made landings conflict (11 an hour on 10-29).
    return brief.goal === 'control-plane'
      ? this.settings.mainBranch
      : brief.target === 'stabilize'
        ? this.settings.stabilizeBranch
        : this.settings.integrationBranch;
  }
  /**
   * A task's dependencies are met once each integrated and its commit is on the branch the task bases on. A
   * stabilize dependency of a dev task counts only after stabilize has been merged into dev: released earlier, the
   * dependent started without the fix it waited for.
   */
  dependenciesMet(task: Pick<Task, 'brief'>, tasks?: readonly Task[]): boolean {
    const byId = tasks ? new Map(tasks.map((candidate) => [candidate.id, candidate])) : undefined;
    const branch = this.taskBaseBranch(task.brief);
    return task.brief.after.every((id) => {
      const loaded = byId?.get(id);
      const dependency = loaded
        ? { state: loaded.state, target: loaded.brief.target, commit: loaded.integratedCommit ?? loaded.mergedCommit }
        : (() => {
            const value = this.store.dependency(id);
            return value && { state: value.state, target: value.target, commit: value.task_commit };
          })();
      if (!dependency || !['integrated', 'merged'].includes(dependency.state)) return false;
      if (dependency.target === task.brief.target) return true;
      const commit = dependency.commit;
      if (!commit) return true;
      return (
        spawnSync('git', ['merge-base', '--is-ancestor', commit, `refs/heads/${branch}`], {
          cwd: this.settings.mainCheckout,
        }).status === 0
      );
    });
  }
  /** Control-plane briefs integrate into main; stabilize briefs use stabilize and other briefs use dev. */
  private taskBaseHead(brief: { goal?: string; target?: 'stabilize' }): string {
    return this.branchHead(this.taskBaseBranch(brief), brief.goal === 'control-plane' || brief.target !== 'stabilize');
  }
  private commitRetryLeftovers(task: Task, attempt: number): void {
    // An attempt that stopped inside a conflicted rebase or merge leaves HEAD detached or half merged. The retry
    // rebases from the branch tip again and hands the worker the conflicted files, so the old operation is dropped.
    if (task.workspace) return;
    const gitPath = (name: string) => resolve(task.worktree, git(task.worktree, ['rev-parse', '--git-path', name]));
    // A git process killed under load leaves its index lock behind. The attempt has ended and this retry holds the
    // task's lease, so a lock a minute old belongs to nobody.
    const lock = gitPath('index.lock');
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { force: true });
    for (const [state, operation] of [
      ['rebase-merge', 'rebase'],
      ['rebase-apply', 'rebase'],
      ['MERGE_HEAD', 'merge'],
    ] as const) {
      if (!existsSync(gitPath(state))) continue;
      try {
        git(task.worktree, [operation, '--abort']);
      } catch (error) {
        if (operation !== 'rebase') throw error;
      }
      // A rebase interrupted while starting cannot always abort (no head-name yet); it never moved the branch.
      if (operation === 'rebase') rmSync(gitPath(state), { recursive: true, force: true });
    }
    // A setup that failed mid-rebase leaves HEAD detached at the commit it rebased onto. With no commit there that a
    // branch lacks, the branch checkout is the attempt's state.
    if (
      !git(task.worktree, ['branch', '--show-current']) &&
      !git(task.worktree, ['rev-list', 'HEAD', '--not', '--branches'])
    )
      git(task.worktree, ['checkout', '-f', task.branch]);
    const branch = git(task.worktree, ['branch', '--show-current']);
    if (branch !== task.branch)
      throw new Error(`retry setup branch check failed: found ${branch || 'detached HEAD'}, expected ${task.branch}`);
    if (!git(task.worktree, ['status', '--porcelain', '--untracked-files=all'])) return;
    git(task.worktree, ['add', '-A']);
    git(task.worktree, ['commit', '-m', `wip: leftovers from attempt ${attempt}`]);
  }
  /** A worker's acceptance runs on its worktree, so what lands is that worktree: commit what the worker left out. */
  commitFinishedWork(task: Task, attempt: number): boolean {
    if (task.workspace) return false;
    for (const state of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD'])
      if (existsSync(resolve(task.worktree, git(task.worktree, ['rev-parse', '--git-path', state])))) return false;
    if (!git(task.worktree, ['status', '--porcelain', '--untracked-files=all'])) return false;
    git(task.worktree, ['add', '-A']);
    git(task.worktree, ['commit', '-m', `chore: commit work left uncommitted by attempt ${attempt}`]);
    return true;
  }
  private validateBrief(
    briefFile: string,
    excludingTask?: string,
  ): { brief: ReturnType<typeof parseBrief>; taskClass: Task['taskClass'] } {
    const markdown = readFileSync(briefFile, 'utf8');
    const brief = parseBrief(markdown, readRiskOwnership(this.settings.riskAreasFile));
    if (brief.goal === 'control-plane') {
      const outside = brief.paths.filter((path) => !path.startsWith('tools/goal/'));
      if (outside.length)
        throw new Error(
          `control-plane tasks may declare only tools/goal paths; split outside paths into a dev task: ${outside.join(', ')}`,
        );
    }
    const taskClass = classifyTask(brief);
    if (taskClass === 'mechanical') throw new Error('run mechanical commands directly without a worker');
    const known = new Set(this.store.taskIds());
    if (excludingTask) known.delete(excludingTask);
    for (const dependency of brief.after)
      if (!known.has(dependency)) throw new Error(`unknown dependency task: ${dependency}`);
    return { brief, taskClass };
  }
  dispatch(briefFile: string): Task {
    const { brief: submittedBrief, taskClass } = this.validateBrief(briefFile);
    const id = crypto.randomUUID();
    const branch = `${this.settings.branchPrefix}${id}`;
    const worktree = join(this.settings.worktreeRoot, id);
    const briefPath = join(this.settings.stateDirectory, 'briefs', `${id}.md`);
    // The lease covers worktree creation, dependency install and frozen-file formatting, about a minute under load.
    // When managers dispatched together, the 30-second default failed dispatches before their tasks existed.
    const lease = acquireDirectoryLeaseWaiting(join(this.settings.stateDirectory, 'leases', 'dispatch'), 15 * 60_000);
    try {
      const module = webModule(submittedBrief, this.settings);
      if (module) {
        const controller = new WorkspaceController(this.settings, this.store);
        const firstUse = !this.store.db.query('SELECT module FROM module_workspaces WHERE module=?').get(module);
        const workspace = controller.open(module, this.taskBaseHead(submittedBrief));
        mkdirSync(dirname(briefPath), { recursive: true });
        writeFileSync(briefPath, submittedBrief.markdown, { flag: 'wx' });
        const task = this.store.createTask(
          submittedBrief,
          { branch: workspace.branch, worktree: workspace.worktree, briefPath, base: workspace.base },
          taskClass,
          id,
        );
        this.store.updateTask({ taskId: id, attempt: 0 }, (current) => {
          current.workspace = { module, taskName: basename(briefFile, '.md') };
          if (current.state === 'ready' && !this.dependenciesMet(current)) current.state = 'held';
        });
        if (firstUse) installWorktreeDependencies(workspace.worktree);
        this.prepareSharedFrozen(this.store.task(id));
        return this.store.task(id);
      }
      const brief = submittedBrief;
      const base = this.taskBaseHead(brief);
      const files = parseFrozenFiles(brief.markdown, brief.paths);
      mkdirSync(dirname(worktree), { recursive: true });
      mkdirSync(dirname(briefPath), { recursive: true });
      writeFileSync(briefPath, brief.markdown, { flag: 'wx' });
      git(this.settings.mainCheckout, ['worktree', 'add', '-b', branch, worktree, base]);
      installWorktreeDependencies(worktree);
      const frozen = commitFrozenFiles(worktree, files, this.settings.formatCommand);
      const created = this.store.createTask(brief, { branch, worktree, briefPath, base }, taskClass, id);
      const held = created.state === 'ready' && brief.after.length > 0 && !this.dependenciesMet(created);
      this.store.updateTask({ taskId: id, attempt: 0 }, (current) => {
        (current as FrozenTask).frozenFiles = frozen.files.map(({ path, hash }) => ({ path, hash }));
        if (held) current.state = 'held';
      });
      reportFrozenFormatError(frozen.formatterError);
      return this.store.task(id);
    } finally {
      lease.release();
    }
  }
  private prepareSharedFrozen(task: Task): void {
    const files = parseFrozenFiles(task.brief.markdown, task.brief.paths);
    const prior = frozenFiles(task);
    if (
      files.length === prior.length &&
      files.every((file) => prior.some((p) => p.path === file.path && p.hash === file.hash))
    )
      return;
    const frozen = commitFrozenFiles(task.worktree, files, this.settings.formatCommand, prior, true);
    this.store.updateTask({ taskId: task.id, attempt: task.currentAttempt }, (current) => {
      (current as FrozenTask).frozenFiles = frozen.files.map(({ path, hash }) => ({ path, hash }));
    });
    reportFrozenFormatError(frozen.formatterError);
  }
  /** Patterns of the risk areas a brief did not declare, which a worker may not change outside its declared paths. */
  protectedPaths(brief: { riskAreas: readonly string[] }): string[] {
    const ownership = readRiskOwnership(this.settings.riskAreasFile);
    return Object.entries(ownership.areas)
      .filter(([area]) => !brief.riskAreas.includes(area))
      .flatMap(([, patterns]) => patterns);
  }
  async retry(taskId: string, options: RetryOptions = {}): Promise<RunningWorker> {
    const worker = await this.retryTask(taskId, options);
    if (!worker) throw new TaskHeldForDependenciesError();
    return worker;
  }
  /** Persist an explicit retry for the host to start on its next recovery sweep. */
  queueRetry(taskId: string, options: RetryOptions = {}): void {
    const task = this.store.task(taskId);
    if (!task.currentAttempt) throw new Error('cannot queue a retry before the first attempt');
    if (!['ready', 'running', 'landing', 'stopped', 'held'].includes(task.state))
      throw new Error(`cannot retry ${task.state} task`);
    const ref = { taskId, attempt: task.currentAttempt };
    if (this.store.retryIntent(ref)?.status === 'pending') throw new Error('a retry is already pending');
    if (task.state === 'held') {
      const attempt = this.store.attempt(ref);
      if (!['pending', 'stopped', 'exited'].includes(attempt.state))
        throw new Error(`task cannot be held for retry: ${taskId} attempt ${task.currentAttempt} (${attempt.state})`);
      const reshaped = options.brief === undefined ? undefined : this.validateBrief(options.brief, taskId);
      if (!reshaped) throw new Error('a held task can only be retried with --brief');
      if (reshaped.brief.goal !== task.brief.goal || reshaped.brief.manager !== task.brief.manager)
        throw new Error('a reshaped brief must keep the same goal and manager');
      if (sameBriefText(reshaped.brief.markdown, task.brief.markdown)) throw new BriefContractUnchangedError();
      const briefPath = join(this.settings.stateDirectory, 'briefs', `${taskId}-queued-${crypto.randomUUID()}.md`);
      mkdirSync(dirname(briefPath), { recursive: true });
      writeFileSync(briefPath, reshaped.brief.markdown, { flag: 'wx' });
      this.store.updateHeldRetryTask(
        ref,
        (current) => {
          current.brief = reshaped.brief;
          current.briefPath = briefPath;
          current.taskClass = reshaped.taskClass;
          current.state = this.dependenciesMet({ brief: current.brief }) ? 'ready' : 'held';
          current.pendingBriefChange = {
            previousBriefHash: current.pendingBriefChange?.previousBriefHash ?? briefHash(task.brief.markdown),
            newBriefHash: briefHash(reshaped.brief.markdown),
          };
        },
        { abandonPending: true },
      );
      return;
    }
    const reshaped = options.brief === undefined ? undefined : this.validateBrief(options.brief, taskId);
    if (reshaped && (reshaped.brief.goal !== task.brief.goal || reshaped.brief.manager !== task.brief.manager))
      throw new Error('a reshaped brief must keep the same goal and manager');
    if (reshaped && sameBriefText(reshaped.brief.markdown, task.brief.markdown))
      throw new BriefContractUnchangedError();
    const briefPath = reshaped
      ? join(this.settings.stateDirectory, 'briefs', `${taskId}-queued-${crypto.randomUUID()}.md`)
      : undefined;
    if (reshaped && briefPath) {
      mkdirSync(dirname(briefPath), { recursive: true });
      writeFileSync(briefPath, reshaped.brief.markdown, { flag: 'wx' });
    }
    const retryOptions = { ...options };
    delete retryOptions.brief;
    this.store.recordExplicitRetry(
      ref,
      (current) => {
        if (!['ready', 'running', 'landing', 'stopped'].includes(current.state))
          throw new Error(`cannot retry ${current.state} task`);
        if (reshaped) {
          current.brief = reshaped.brief;
          current.briefPath = briefPath!;
          current.taskClass = reshaped.taskClass;
          current.pendingBriefChange = {
            previousBriefHash: current.pendingBriefChange?.previousBriefHash ?? briefHash(task.brief.markdown),
            newBriefHash: briefHash(reshaped.brief.markdown),
          };
          if (!this.dependenciesMet({ brief: current.brief })) current.state = 'held';
          else current.state = 'ready';
        } else if (current.state === 'stopped') current.state = 'ready';
      },
      retryOptions,
    );
  }
  setPriority(taskId: string, priority: 'critical' | 'normal'): Task {
    const task = this.store.task(taskId);
    const updated = this.store.updateTask({ taskId, attempt: task.currentAttempt }, (current) => {
      current.brief.criticalPath = priority === 'critical';
    });
    this.writeTaskPriority(updated);
    return updated;
  }
  private writeTaskPriority(task: Task): void {
    const path = join(task.worktree, '.temp', 'goal', 'task-priority');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, task.brief.criticalPath ? 'critical\n' : 'normal\n');
  }
  async retryHeld(taskId: string): Promise<RunningWorker> {
    const task = this.store.task(taskId);
    const releaseCapacity = await awaitHostCapacity(
      this.store,
      this.settings.stateDirectory,
      startsFirst(task),
      taskId,
      task.currentAttempt + 1,
    );
    try {
      // Several sweeps can find the same released task; the one holding its lease rebases, installs and launches, and
      // the others get LeaseHeldError instead of running git and bun in the same worktree at once.
      const lease = acquireDirectoryLease(join(this.settings.stateDirectory, 'leases', taskId));
      try {
        // Another process may have started it while this one waited for capacity.
        if (this.store.task(taskId).state !== 'ready') throw new LeaseHeldError(`Task already started: ${taskId}`);
        return await this.startReleasedTask(taskId);
      } finally {
        lease.release();
      }
    } finally {
      releaseCapacity();
    }
  }
  private async startReleasedTask(taskId: string): Promise<RunningWorker> {
    let task = this.store.task(taskId);
    if (task.state !== 'ready' || !task.brief.after.length) throw new Error('only a released held task can be started');
    if (task.workspace) {
      const worker = await this.retryTask(taskId, {}, true);
      if (!worker) throw new Error('released task was unexpectedly held again');
      return worker;
    }
    this.ensureWorktree(task);
    this.commitRetryLeftovers(task, task.currentAttempt);
    const integration = this.taskBaseHead(task.brief);
    const commits = Number(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`]));
    const branch = git(task.worktree, ['branch', '--show-current']);
    let regeneratedLockfile = false;
    if (branch !== task.branch)
      throw new Error(`held task worktree is on ${branch || 'detached HEAD'}, expected ${task.branch}`);
    if (commits > 0) {
      const common = git(task.worktree, ['merge-base', task.base, integration]);
      const branchName = `${this.taskBaseBranch(task.brief)} branch`;
      if (common !== task.base)
        throw new HeldTaskConflictError(`held task base is not an ancestor of the current ${branchName}`);
      const currentAttempt = task.currentAttempt ? this.store.attempt({ taskId, attempt: task.currentAttempt }) : null;
      const logPath =
        currentAttempt?.logPath ?? join(this.settings.stateDirectory, 'runs', taskId, 'release-rebase.log');
      mkdirSync(dirname(logPath), { recursive: true });
      try {
        regeneratedLockfile = rebaseOnto(
          task.worktree,
          integration,
          task.base,
          `${logPath}.rebase`,
          this.settings.derivedFiles,
          task.brief.paths,
        );
      } catch (error) {
        const conflicts = git(task.worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])
          .split('\0')
          .filter(Boolean);
        if (!conflicts.length) throw error;
        git(task.worktree, ['rebase', '--abort']);
        const worker = await this.retryTask(taskId, { escalation: 'rebase-conflict', conflictFiles: conflicts }, true);
        if (!worker) throw new Error('released task was unexpectedly held again');
        return worker;
      }
    } else git(task.worktree, ['reset', '--hard', integration]);
    if (task.currentAttempt) {
      task = this.store.updateHeldRetryTask(
        { taskId, attempt: task.currentAttempt },
        (current) => {
          current.base = integration;
        },
        { abandonPending: true },
      );
    } else {
      task = this.store.updateTask({ taskId, attempt: 0 }, (current) => {
        current.base = integration;
      });
    }
    if (!regeneratedLockfile) installWorktreeDependencies(task.worktree);
    const worker = await this.retryTask(taskId, {}, true);
    if (!worker) throw new Error('released task was unexpectedly held again');
    return worker;
  }
  /** Recreate a finished task's removed checkout while holding its task lease. */
  private ensureWorktree(task: Task): void {
    if (existsSync(task.worktree)) return;
    const lease = acquireDirectoryLeaseWaiting(join(this.settings.stateDirectory, 'leases', 'dispatch'), 15 * 60_000);
    try {
      mkdirSync(dirname(task.worktree), { recursive: true });
      try {
        git(this.settings.mainCheckout, ['worktree', 'add', task.worktree, task.branch]);
      } catch {
        git(this.settings.mainCheckout, ['worktree', 'prune']);
        git(this.settings.mainCheckout, ['worktree', 'add', task.worktree, task.branch]);
      }
      installWorktreeDependencies(task.worktree);
    } finally {
      lease.release();
    }
  }
  /** Whether a retry only records a held contract: it needs no worker, so it never waits for host capacity. */
  /** Whether a retry can skip the capacity wait (it only holds, or replaces a running worker) and whether it goes first. */
  private retryPlan(taskId: string, options: RetryOptions): { hold: boolean; first: boolean } {
    try {
      const task = this.store.task(taskId);
      const reshaped = options.brief === undefined ? undefined : this.validateBrief(options.brief, taskId);
      // Persist a held task's amendment under its lease before any capacity wait.
      if (task.state === 'held' && reshaped) return { hold: true, first: startsFirst(task) };
      if (task.currentAttempt > 0 && reshaped && sameBriefText(reshaped.brief.markdown, task.brief.markdown))
        return { hold: true, first: startsFirst(task) };
      const next = { ...task, brief: reshaped?.brief ?? task.brief, taskClass: reshaped?.taskClass ?? task.taskClass };
      const hold = (reshaped !== undefined || task.state === 'held') && !this.dependenciesMet({ brief: next.brief });
      // Replacing a running worker adds none, so it never waits behind the worker it replaces.
      const replaces =
        task.currentAttempt > 0 && this.store.attempt({ taskId, attempt: task.currentAttempt }).state === 'running';
      return { hold: hold || replaces, first: startsFirst(next) };
    } catch {
      // The retry itself reports the error under the task's lease.
      return { hold: false, first: startsFirst(this.store.task(taskId)) };
    }
  }
  /** `leased` when the caller already holds the task's lease. */
  private async retryTask(taskId: string, options: RetryOptions, leased = false): Promise<RunningWorker | null> {
    // Wait for host capacity before taking the task's lease, so a waiting task can still be reshaped or stopped.
    const plan = leased ? undefined : this.retryPlan(taskId, options);
    const targetAttempt = plan && !plan.hold ? this.store.task(taskId).currentAttempt + 1 : undefined;
    const releaseCapacity =
      plan && !plan.hold
        ? await awaitHostCapacity(this.store, this.settings.stateDirectory, plan.first, taskId, targetAttempt)
        : () => {};
    let lease: ReturnType<typeof acquireDirectoryLeaseWaiting> | undefined;
    try {
      lease = leased ? undefined : acquireDirectoryLeaseWaiting(join(this.settings.stateDirectory, 'leases', taskId));
      let task = this.store.task(taskId);
      if (options.expectedAttempt !== undefined && task.currentAttempt !== options.expectedAttempt)
        throw new StaleAttemptError({ taskId, attempt: options.expectedAttempt }, task.currentAttempt);
      if (!task.branch || !task.base) throw new Error('Imported attempts need a dispatchable contract before retry');
      if (!['ready', 'running', 'landing', 'stopped', 'held'].includes(task.state))
        throw new Error(`cannot retry ${task.state} task`);
      const reshaped = options.brief === undefined ? undefined : this.validateBrief(options.brief, taskId);
      if (reshaped && (reshaped.brief.goal !== task.brief.goal || reshaped.brief.manager !== task.brief.manager))
        throw new Error('a reshaped brief must keep the same goal and manager');
      if (task.currentAttempt > 0 && reshaped && sameBriefText(reshaped.brief.markdown, task.brief.markdown))
        throw new BriefContractUnchangedError();
      const changedBrief = reshaped !== undefined && !sameBriefText(reshaped.brief.markdown, task.brief.markdown);
      const briefChange = changedBrief
        ? {
            previousBriefHash: task.pendingBriefChange?.previousBriefHash ?? briefHash(task.brief.markdown),
            newBriefHash: briefHash(reshaped.brief.markdown),
          }
        : task.pendingBriefChange;
      const nextBrief = reshaped?.brief ?? task.brief;
      const nextTaskClass = reshaped?.taskClass ?? task.taskClass;
      if (!nextBrief.acceptance.command.length)
        throw new Error('Imported attempts need a dispatchable contract before retry');
      const heldAmendment = task.state === 'held' && reshaped !== undefined;
      if (heldAmendment) {
        const briefPath = join(this.settings.stateDirectory, 'briefs', `${taskId}-held-${crypto.randomUUID()}.md`);
        mkdirSync(dirname(briefPath), { recursive: true });
        writeFileSync(briefPath, nextBrief.markdown, { flag: 'wx' });
        task = this.store.updateHeldRetryTask(
          { taskId, attempt: task.currentAttempt },
          (current) => {
            current.brief = nextBrief;
            current.briefPath = briefPath;
            current.taskClass = nextTaskClass;
            if (changedBrief && briefChange) current.pendingBriefChange = briefChange;
          },
          { abandonPending: true },
        );
      }
      // A held task stays held while its dependencies are unmet, reshaped or not; once they are met it starts.
      if ((reshaped || task.state === 'held') && !this.dependenciesMet({ brief: nextBrief })) {
        if (!heldAmendment) {
          const briefPath = join(this.settings.stateDirectory, 'briefs', `${taskId}-held-${crypto.randomUUID()}.md`);
          mkdirSync(dirname(briefPath), { recursive: true });
          writeFileSync(briefPath, nextBrief.markdown, { flag: 'wx' });
          this.store.updateHeldRetryTask(
            { taskId, attempt: task.currentAttempt },
            (current) => {
              current.brief = nextBrief;
              current.briefPath = briefPath;
              current.taskClass = nextTaskClass;
              current.state = 'held';
              if (changedBrief && briefChange) current.pendingBriefChange = briefChange;
            },
            { abandonPending: true },
          );
        }
        return null;
      }
      if (heldAmendment) {
        this.store.updateHeldRetryTask({ taskId, attempt: task.currentAttempt }, (current) => {
          current.state = 'ready';
        });
        // Leave the amended task available to stop or reshape while it waits for capacity.
        lease?.release();
        lease = undefined;
        const startOptions = { ...options };
        delete startOptions.brief;
        return this.retryTask(taskId, startOptions);
      }
      this.ensureWorktree(task);
      const pools = this.poolPolicies.read();
      const old = task.currentAttempt ? this.store.attempt({ taskId, attempt: task.currentAttempt }) : null;
      const oldConfigDirectory = old
        ? pools.find((candidate) => candidate.name === old.pool)?.configDirectory
        : undefined;
      const table = readRouting(this.settings.routingFile);
      const pinned = nextBrief.model !== undefined;
      // A retry keeps its engine while the routing table still offers it for the class; an engine the table dropped
      // (a failing or disallowed pool) is routed afresh, so table changes reach retries at once.
      const routable = (candidate: Profile) =>
        nextTaskClass === 'mechanical' ||
        [
          ...retryFallbacks(table, nextTaskClass),
          ...table.experiments.filter((e) => e.open && e.class === nextTaskClass).flatMap((e) => e.profiles),
        ].some((offered) => offered.cli === candidate.cli && offered.model === candidate.model);
      const route =
        !pinned && old && routable(old.profile)
          ? { profile: old.profile, tableVersion: old.tableVersion, experiment: old.experiment }
          : routeTask(nextBrief, task.sequence, table);
      const readings = pools.map((pool) =>
        withObservedExhaustion(this.reader(pool), pool, this.settings.stateDirectory),
      );
      const history = this.store
        .attempts()
        .flatMap((a) => [a.before, a.after])
        .filter((r) => r !== null);
      const routing = readRouting(this.settings.routingFile);
      let fallbacks = options.profile || pinned ? [] : retryFallbacks(routing, nextTaskClass);
      const paced = nextTaskClass === 'mechanical' || routing.classes[nextTaskClass]?.paced !== false;
      // A retry keeps its engine, but three failed attempts in a row on one model say the model is the problem: the
      // next attempt goes to the route's first other model. Failures no model change can fix do not count.
      const recent = task.currentAttempt
        ? Array.from({ length: Math.min(3, task.currentAttempt) }, (_, index) =>
            this.store.attempt({ taskId, attempt: task.currentAttempt - index }),
          )
        : [];
      const sameModelFailures =
        !options.profile &&
        !pinned &&
        recent.length === 3 &&
        recent.every(
          (attempt) =>
            attempt.profile.model === old?.profile.model &&
            attempt.profile.cli === old?.profile.cli &&
            this.store.record({ taskId, attempt: attempt.attempt })?.outcome !== 'passed' &&
            !['pool-exhausted', 'rebase-conflict', 'scope-growth'].includes(attempt.escalation ?? ''),
        );
      const switched = sameModelFailures
        ? fallbacks.find((candidate) => candidate.model !== old!.profile.model || candidate.cli !== old!.profile.cli)
        : undefined;
      if (switched)
        fallbacks = fallbacks.filter((candidate) => candidate !== switched && candidate.model !== old!.profile.model);
      const paceThisSelection = !pinned && !options.profile && !switched && paced;
      const schedule = paceThisSelection ? readCodexSchedule(this.settings.stateDirectory) : undefined;
      const { profile, pool } = choosePoolWithFallback(
        pinned ? route.profile : (options.profile ?? switched ?? route.profile),
        fallbacks,
        pools,
        readings,
        {
          history,
          ...(old && !switched ? { preferred: old.pool } : {}),
          ...(options.excludePools ? { exclude: options.excludePools } : {}),
        },
        // A new task goes to the allowance that would otherwise expire unused first; an explicit profile, a switched
        // engine, or a class routed with paced: false keeps its order.
        pinned || options.profile || switched || !paced
          ? undefined
          : (candidate, now) => {
              const reading = readings.find((value) => value.pool === candidate.name);
              return reading ? pace(reading, candidate, now, schedule)?.urgency : undefined;
            },
      );
      const resumeSession = old?.session && agentAdapter(profile.cli).canResume &&
        old.pool === pool.name && old.profile.cli === profile.cli && old.profile.model === profile.model
        ? old.session : undefined;
      const make = (n: number): Attempt => ({
        taskId,
        attempt: n,
        state: 'pending',
        ...(briefChange ?? {}),
        profile,
        pool: pool.name,
        tableVersion: route.tableVersion,
        experiment: route.experiment,
        startedAt: new Date().toISOString(),
        endedAt: null,
        process: null,
        driver: null,
        logPath: join(this.settings.stateDirectory, 'runs', taskId, `${n}.jsonl`),
        evidencePath: join(this.settings.stateDirectory, 'evidence', taskId, String(n)),
        auxiliaryProcesses: [],
        session: null,
        fixRound: options.fixRound ?? old?.fixRound ?? 0,
        consulted: options.consulted ?? old?.consulted ?? false,
        previousFailure: ['environment', 'pool-exhausted'].includes(options.escalation ?? '')
          ? (old?.previousFailure ?? null)
          : (old?.failure?.fingerprint ?? old?.previousFailure ?? null),
        failure: null,
        escalation: options.escalation ?? null,
        before: readings.find((r) => r.pool === pool.name) ?? null,
        after: null,
        exitCode: null,
        result: '',
        blocker: null,
        approaches: old?.approaches ?? [],
      });
      const next =
        task.currentAttempt > 0 && this.store.attempt({ taskId, attempt: task.currentAttempt }).state === 'stopped'
          ? this.store.retryStopped(taskId, make, oldConfigDirectory)
          : this.store.nextAttempt({ taskId, attempt: task.currentAttempt }, make, oldConfigDirectory);
      this.writeTaskPriority(this.store.task(taskId));
      // Include older groups after a controller crash between superseding and termination.
      for (const previous of this.store
        .attempts(taskId)
        .filter((a) => a.attempt < next.attempt && !a.supersededFinalized)) {
        await terminateProcessGroup(previous.process, this.settings.terminationGraceMs);
        for (const process of previous.auxiliaryProcesses)
          await terminateProcessGroup(process, this.settings.terminationGraceMs);
      }
      this.store.assertCurrent(next);
      this.store.finalizeSuperseded(
        next,
        (previous) => {
          const previousPool = this.settings.pools.find((p) => p.name === previous.pool);
          return previousPool ? this.reader(previousPool) : null;
        },
        (previous) => this.settings.pools.find((p) => p.name === previous.pool)?.configDirectory,
      );
      if (reshaped) {
        const briefPath = join(this.settings.stateDirectory, 'briefs', `${taskId}-${next.attempt}.md`);
        mkdirSync(dirname(briefPath), { recursive: true });
        writeFileSync(briefPath, reshaped.brief.markdown, { flag: 'wx' });
        task = this.store.updateTask({ taskId, attempt: next.attempt }, (current) => {
          current.brief = reshaped.brief;
          current.briefPath = briefPath;
          current.taskClass = nextTaskClass;
          delete current.pendingBriefChange;
        });
      } else if (briefChange) {
        task = this.store.updateTask({ taskId, attempt: next.attempt }, (current) => {
          delete current.pendingBriefChange;
        });
      } else task = this.store.task(taskId);
      let setupStep = 'checking worktree leftovers';
      let retryPrepared = false;
      try {
        if (task.workspace) {
          if (webModule(task.brief, this.settings) !== task.workspace.module)
            throw new Error('reshape outside a shared module requires a new isolated task');
          const controller = new WorkspaceController(this.settings, this.store);
          return await controller.withLaunch(task.workspace.module, async () => {
            controller.syncIdle(task.workspace!.module, task.id);
            this.prepareSharedFrozen(task);
            const prompt = workerPrompt(
              this.store.task(taskId),
              options.evidence,
              options.consultation,
              [],
              this.settings.mainCheckout,
            );
            retryPrepared = true;
            return await this.launcher(this.store, this.store.task(taskId), next, pool, prompt, this.settings.codex, resumeSession);
          });
        }
        this.commitRetryLeftovers(task, old?.attempt ?? 0);
        setupStep = 'committing frozen acceptance files';
        const frozenBlocks = parseFrozenFiles(task.brief.markdown, task.brief.paths);
        const priorFiles = frozenFiles(task);
        const frozen = commitFrozenFiles(task.worktree, frozenBlocks, this.settings.formatCommand, priorFiles);
        task = this.store.updateTask(next, (current) => {
          (current as FrozenTask).frozenFiles = frozen.files.map(({ path, hash }) => ({ path, hash }));
        });
        reportFrozenFormatError(frozen.formatterError);
        setupStep = `rebasing onto current ${this.taskBaseBranch(task.brief)}`;
        const integration = this.taskBaseHead(task.brief);
        const tip = git(task.worktree, ['rev-parse', 'HEAD']);
        const rebaseLog = `${next.logPath}.rebase`;
        mkdirSync(dirname(rebaseLog), { recursive: true });
        let files: string[] = [];
        let changedBase = false;
        let regeneratedLockfile = false;
        if (task.base !== integration) {
          changedBase = true;
          const commits = Number(git(task.worktree, ['rev-list', '--count', `${task.base}..${tip}`]));
          if (commits > 0) {
            try {
              // Integration derived files such as bun.lock are regenerated by rebaseOnto before the retry starts.
              regeneratedLockfile = rebaseOnto(
                task.worktree,
                integration,
                task.base,
                rebaseLog,
                this.settings.derivedFiles,
                task.brief.paths,
              );
            } catch (error) {
              files = git(task.worktree, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
              if (!files.length) throw error;
            }
          } else git(task.worktree, ['reset', '--hard', integration]);
        }
        task = this.store.updateTask(next, (current) => {
          current.base = integration;
        });
        if (!files.length && (changedBase || options.escalation === 'rebase-conflict') && !regeneratedLockfile) {
          setupStep = 'installing worktree dependencies';
          installWorktreeDependencies(task.worktree);
        }
        if (!files.length && options.escalation === 'rebase-conflict') files = options.conflictFiles ?? [];
        const prompt = workerPrompt(task, options.evidence, options.consultation, files, this.settings.mainCheckout);
        retryPrepared = true;
        return await this.launcher(this.store, task, next, pool, prompt, this.settings.codex, resumeSession);
      } catch (error) {
        const failed = this.store.updateAttempt(next, (a) => {
          a.state = 'exited';
          a.endedAt = new Date().toISOString();
          a.result = String(error);
          a.exitCode = -1;
          a.failureKind = 'tool';
          a.after = this.reader(pool);
        });
        this.store.putRecord(
          makeRecord(
            this.store.task(taskId),
            failed,
            readMeasurement(failed, { configDirectory: pool.configDirectory }),
            'stopped',
          ),
        );
        this.store.event(next, 'launch-failed', { error: String(error) });
        this.store.updateTask(next, (t) => {
          t.state = 'stopped';
        });
        if (!retryPrepared) {
          const detail = String(error)
            .replace(/[\r\n]+/g, ' ')
            .slice(0, 800);
          const event = {
            managerId: this.store.task(taskId).brief.manager,
            taskId,
            kind: 'environment' as const,
            summary: `environment: retry setup failed during ${setupStep}: ${detail}`.slice(0, 1000),
          };
          new SqliteManagerInbox(this.store.db, this.settings.integration.inboxDirectory).deliver(event);
        }
        throw error;
      }
    } finally {
      lease?.release();
      releaseCapacity();
    }
  }
  async stop(taskId: string, cancelled = false): Promise<void> {
    const lease = acquireDirectoryLeaseWaiting(join(this.settings.stateDirectory, 'leases', taskId));
    try {
      const task = this.store.task(taskId);
      const ref = { taskId, attempt: task.currentAttempt };
      if (task.state === 'integrated' || task.state === 'merged' || task.state === 'cancelled')
        throw new Error(`cannot stop ${task.state} task`);
      if (!task.currentAttempt) {
        this.store.updateTask(ref, (t) => {
          t.state = cancelled ? 'cancelled' : 'stopped';
        });
        return;
      }
      const attempt = this.store.attempt(ref);
      if (attempt.state === 'stopped') {
        if (cancelled) this.store.cancelStopped(ref);
        return;
      }
      this.store.write(ref, () => {
        if (['integrated', 'merged'].includes(this.store.task(taskId).state))
          throw new Error('cannot stop integrated task');
        if (attempt.state !== 'stopped' && attempt.state !== 'cancelled') {
          const pool = this.settings.pools.find((p) => p.name === attempt.pool);
          const ended = this.store.updateAttempt(ref, (a) => {
            a.endedAt = new Date().toISOString();
            a.after = pool ? this.reader(pool) : null;
          });
          this.store.putRecord(
            makeRecord(
              task,
              ended,
              readMeasurement(ended, { configDirectory: pool?.configDirectory }),
              cancelled ? 'cancelled' : 'stopped',
            ),
          );
          this.store.event(ref, cancelled ? 'cancelled' : 'stopped', {});
          this.store.close(ref, cancelled ? 'cancelled' : 'stopped');
        }
      });
      await terminateProcessGroup(attempt.process, this.settings.terminationGraceMs);
      for (const process of attempt.auxiliaryProcesses)
        await terminateProcessGroup(process, this.settings.terminationGraceMs);
    } finally {
      lease.release();
    }
  }
  async cancel(taskId: string): Promise<void> {
    await this.stop(taskId, true);
    const dependency = this.store.task(taskId);
    const heldByManager = new Map<string, string[]>();
    for (const task of this.store.activeTasks()) {
      if (task.state !== 'held' || !task.brief.after.includes(taskId)) continue;
      const held = heldByManager.get(task.brief.manager) ?? [];
      held.push(task.id);
      heldByManager.set(task.brief.manager, held);
    }
    const inbox = new SqliteManagerInbox(this.store.db, this.settings.integration.inboxDirectory);
    for (const [managerId, heldTasks] of heldByManager) {
      const event = {
        managerId,
        taskId,
        kind: 'instruction' as const,
        summary: `Cancelled dependency ${taskId} is holding tasks ${heldTasks.join(', ')}; decide whether the dependency is still needed.`,
      };
      this.store.event({ taskId, attempt: dependency.currentAttempt }, 'cancelled-dependency-notice', event);
      inbox.deliver(event);
    }
  }
  /** Later integration follows the stabilize branch. A running attempt is left alone. */
  retarget(taskId: string, target: string): Task {
    if (target !== 'stabilize') throw new Error('retarget only accepts stabilize');
    const task = this.store.task(taskId);
    if (task.state === 'integrated' || task.state === 'merged' || task.state === 'cancelled')
      throw new Error(`cannot retarget ${task.state} task`);
    const head = this.branchHead(this.settings.stabilizeBranch, false);
    if (!task.base) throw new Error('task has no recorded base commit');
    try {
      git(this.settings.mainCheckout, ['merge-base', '--is-ancestor', task.base, head]);
    } catch {
      throw new Error('recorded base commit is not an ancestor of the stabilize head');
    }
    const markdown = withStabilizeTarget(task.brief.markdown);
    const brief = parseBrief(markdown, readRiskOwnership(this.settings.riskAreasFile));
    const ref = { taskId, attempt: task.currentAttempt };
    const apply = (current: Task) => {
      writeFileSync(current.briefPath, markdown);
      current.brief = brief;
    };
    try {
      return this.store.updateTask(ref, apply);
    } catch (error) {
      if (error instanceof StaleAttemptError) return this.store.updateHeldRetryTask(ref, apply);
      throw error;
    }
  }
  completionScope(goal: string): string[] {
    return this.store.db
      .query(
        "SELECT id FROM worker_tasks WHERE json_extract(body, '$.brief.goal')=? AND json_extract(body, '$.state') != 'cancelled' ORDER BY sequence",
      )
      .all(goal)
      .map((row) => (row as { id: string }).id);
  }
}
