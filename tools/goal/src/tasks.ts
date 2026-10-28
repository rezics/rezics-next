import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { parseBrief, readRiskOwnership, withStabilizeTarget } from './briefs.ts';
import { StaleAttemptError } from './contracts.ts';
import { acquireDirectoryLease, acquireDirectoryLeaseWaiting, LeaseHeldError } from './lease.ts';
import { classifyTask, readRouting, retryFallbacks, routeTask } from './routing.ts';
import { choosePoolWithFallback } from './allowance.ts';
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

type FrozenTask = Task & { frozenFiles?: Pick<FrozenFile, 'path' | 'hash'>[] };

function frozenFiles(task: Task): Pick<FrozenFile, 'path' | 'hash'>[] {
  return (task as FrozenTask).frozenFiles ?? [];
}
type FrozenCommit = { files: FrozenFile[]; formatterError?: string };

function commitFrozenFiles(
  worktree: string,
  files: readonly FrozenFile[],
  formatCommand: readonly string[],
  previous: readonly Pick<FrozenFile, 'path' | 'hash'>[] = [],
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
  const status = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: worktree });
  if (status.status !== 0) git(worktree, ['commit', '-m', 'test: frozen acceptance files']);
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
  if (!existsSync(join(worktree, 'package.json'))) return;
  const result = spawnSync('bun', ['install', '--frozen-lockfile'], {
    cwd: worktree,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `Dependency install failed in ${worktree}: ${result.stderr || result.error?.message || `bun exited ${result.status}`}`,
    );
  const manifest = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? []);
  for (const pattern of patterns) {
    const wildcard = pattern.indexOf('*');
    const parent = wildcard < 0 ? pattern : pattern.slice(0, wildcard).replace(/\/$/, '');
    const candidates = wildcard < 0 ? [parent] : readdirSync(join(worktree, parent)).map((name) => join(parent, name));
    for (const relative of candidates) {
      const packageFile = join(worktree, relative, 'package.json');
      if (!existsSync(packageFile)) continue;
      const workspace = JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: string };
      if (!workspace.name) continue;
      const link = join(worktree, 'node_modules', workspace.name);
      if (existsSync(link)) continue;
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(worktree, relative), link, 'dir');
    }
  }
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
  constructor(
    readonly settings: Settings,
    readonly store: WorkerStore,
    readonly reader: PoolReader = readPool,
    readonly launcher: typeof launch = launch,
  ) {}
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
  private integrationHead(): string {
    return this.branchHead(this.settings.integrationBranch, true);
  }
  /**
   * A task's dependencies are met once each integrated and its commit is on the branch the task bases on. A
   * stabilize dependency of a dev task counts only after stabilize has been merged into dev: released earlier, the
   * dependent started without the fix it waited for.
   */
  dependenciesMet(task: Pick<Task, 'brief'>, tasks: readonly Task[] = this.store.tasks()): boolean {
    const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    const branch = task.brief.target === 'stabilize' ? this.settings.stabilizeBranch : this.settings.integrationBranch;
    return task.brief.after.every((id) => {
      const dependency = byId.get(id);
      if (!dependency || !['integrated', 'merged'].includes(dependency.state)) return false;
      if (dependency.brief.target === task.brief.target) return true;
      const commit = dependency.integratedCommit ?? dependency.mergedCommit;
      if (!commit) return true;
      return (
        spawnSync('git', ['merge-base', '--is-ancestor', commit, `refs/heads/${branch}`], {
          cwd: this.settings.mainCheckout,
        }).status === 0
      );
    });
  }
  /** A stabilize brief bases on that branch; every other brief bases on the integration branch. */
  private taskBaseHead(brief: { target?: 'stabilize' }): string {
    return brief.target === 'stabilize'
      ? this.branchHead(this.settings.stabilizeBranch, false)
      : this.integrationHead();
  }
  private commitRetryLeftovers(task: Task, attempt: number): void {
    // An attempt that stopped inside a conflicted rebase or merge leaves HEAD detached or half merged. The retry
    // rebases from the branch tip again and hands the worker the conflicted files, so the old operation is dropped.
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
    const taskClass = classifyTask(brief);
    if (taskClass === 'mechanical') throw new Error('run mechanical commands directly without a worker');
    const existingTasks = this.store.tasks().filter((task) => task.id !== excludingTask);
    const known = new Set(existingTasks.map((task) => task.id));
    for (const dependency of brief.after)
      if (!known.has(dependency)) throw new Error(`unknown dependency task: ${dependency}`);
    return { brief, taskClass };
  }
  dispatch(briefFile: string): Task {
    const { brief, taskClass } = this.validateBrief(briefFile);
    const id = crypto.randomUUID();
    const branch = `${this.settings.branchPrefix}${id}`;
    const worktree = join(this.settings.worktreeRoot, id);
    const briefPath = join(this.settings.stateDirectory, 'briefs', `${id}.md`);
    const lease = acquireDirectoryLeaseWaiting(join(this.settings.stateDirectory, 'leases', 'dispatch'));
    try {
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
  async retryHeld(taskId: string): Promise<RunningWorker> {
    await awaitHostCapacity(this.store, this.settings.stateDirectory, startsFirst(this.store.task(taskId)), taskId);
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
  }
  private async startReleasedTask(taskId: string): Promise<RunningWorker> {
    let task = this.store.task(taskId);
    if (task.state !== 'ready' || !task.brief.after.length) throw new Error('only a released held task can be started');
    this.commitRetryLeftovers(task, task.currentAttempt);
    const integration = this.taskBaseHead(task.brief);
    const commits = Number(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`]));
    const branch = git(task.worktree, ['branch', '--show-current']);
    if (branch !== task.branch)
      throw new Error(`held task worktree is on ${branch || 'detached HEAD'}, expected ${task.branch}`);
    if (commits > 0) {
      const common = git(task.worktree, ['merge-base', task.base, integration]);
      const branchName = task.brief.target === 'stabilize' ? 'stabilize branch' : 'integration branch';
      if (common !== task.base)
        throw new HeldTaskConflictError(`held task base is not an ancestor of the current ${branchName}`);
      const currentAttempt = task.currentAttempt ? this.store.attempt({ taskId, attempt: task.currentAttempt }) : null;
      const logPath =
        currentAttempt?.logPath ?? join(this.settings.stateDirectory, 'runs', taskId, 'release-rebase.log');
      mkdirSync(dirname(logPath), { recursive: true });
      try {
        rebaseOnto(task.worktree, integration, task.base, `${logPath}.rebase`, undefined, task.brief.paths);
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
    installWorktreeDependencies(task.worktree);
    const worker = await this.retryTask(taskId, {}, true);
    if (!worker) throw new Error('released task was unexpectedly held again');
    return worker;
  }
  /** Whether a retry only records a held contract: it needs no worker, so it never waits for host capacity. */
  /** Whether a retry can skip the capacity wait (it only holds, or replaces a running worker) and whether it goes first. */
  private retryPlan(taskId: string, options: RetryOptions): { hold: boolean; first: boolean } {
    try {
      const task = this.store.task(taskId);
      const reshaped = options.brief === undefined ? undefined : this.validateBrief(options.brief, taskId);
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
    if (plan && !plan.hold) await awaitHostCapacity(this.store, this.settings.stateDirectory, plan.first, taskId);
    const lease = leased
      ? undefined
      : acquireDirectoryLeaseWaiting(join(this.settings.stateDirectory, 'leases', taskId));
    try {
      let task = this.store.task(taskId);
      if (options.expectedAttempt !== undefined && task.currentAttempt !== options.expectedAttempt)
        throw new StaleAttemptError({ taskId, attempt: options.expectedAttempt }, task.currentAttempt);
      if (!task.branch || !task.base) throw new Error('Imported attempts need a dispatchable contract before retry');
      if (!['ready', 'running', 'landing', 'stopped', 'held'].includes(task.state))
        throw new Error(`cannot retry ${task.state} task`);
      const reshaped = options.brief === undefined ? undefined : this.validateBrief(options.brief, taskId);
      if (reshaped && (reshaped.brief.goal !== task.brief.goal || reshaped.brief.manager !== task.brief.manager))
        throw new Error('a reshaped brief must keep the same goal and manager');
      const nextBrief = reshaped?.brief ?? task.brief;
      const nextTaskClass = reshaped?.taskClass ?? task.taskClass;
      if (!nextBrief.acceptance.command.length)
        throw new Error('Imported attempts need a dispatchable contract before retry');
      const byId = new Map(this.store.tasks().map((candidate) => [candidate.id, candidate]));
      // A held task stays held while its dependencies are unmet, reshaped or not; once they are met it starts.
      if ((reshaped || task.state === 'held') && !this.dependenciesMet({ brief: nextBrief }, [...byId.values()])) {
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
          },
          { abandonPending: true },
        );
        return null;
      }
      const old = task.currentAttempt ? this.store.attempt({ taskId, attempt: task.currentAttempt }) : null;
      const oldConfigDirectory = old
        ? this.settings.pools.find((candidate) => candidate.name === old.pool)?.configDirectory
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
      const readings = this.settings.pools.map((pool) =>
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
      const { profile, pool } = choosePoolWithFallback(
        pinned ? route.profile : (options.profile ?? switched ?? route.profile),
        fallbacks,
        this.settings.pools,
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
          : (candidate) => {
              const reading = readings.find((value) => value.pool === candidate.name);
              const schedule = readCodexSchedule(this.settings.stateDirectory);
              return reading ? pace(reading, candidate, Date.now(), schedule)?.urgency : undefined;
            },
      );
      const make = (n: number): Attempt => ({
        taskId,
        attempt: n,
        state: 'pending',
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
        });
      } else task = this.store.task(taskId);
      let setupStep = 'checking worktree leftovers';
      let retryPrepared = false;
      try {
        this.commitRetryLeftovers(task, old?.attempt ?? 0);
        setupStep = 'committing frozen acceptance files';
        const frozenBlocks = parseFrozenFiles(task.brief.markdown, task.brief.paths);
        const priorFiles = frozenFiles(task);
        const frozen = commitFrozenFiles(task.worktree, frozenBlocks, this.settings.formatCommand, priorFiles);
        task = this.store.updateTask(next, (current) => {
          (current as FrozenTask).frozenFiles = frozen.files.map(({ path, hash }) => ({ path, hash }));
        });
        reportFrozenFormatError(frozen.formatterError);
        setupStep = `rebasing onto current ${task.brief.target === 'stabilize' ? this.settings.stabilizeBranch : this.settings.integrationBranch}`;
        const integration = this.taskBaseHead(task.brief);
        const tip = git(task.worktree, ['rev-parse', 'HEAD']);
        const rebaseLog = `${next.logPath}.rebase`;
        mkdirSync(dirname(rebaseLog), { recursive: true });
        let files: string[] = [];
        let changedBase = false;
        if (task.base !== integration) {
          changedBase = true;
          const commits = Number(git(task.worktree, ['rev-list', '--count', `${task.base}..${tip}`]));
          if (commits > 0) {
            try {
              rebaseOnto(task.worktree, integration, task.base, rebaseLog, undefined, task.brief.paths);
            } catch (error) {
              files = git(task.worktree, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
              if (!files.length) throw error;
            }
          } else git(task.worktree, ['reset', '--hard', integration]);
        }
        task = this.store.updateTask(next, (current) => {
          current.base = integration;
        });
        if (!files.length && (changedBase || options.escalation === 'rebase-conflict')) {
          setupStep = 'installing worktree dependencies';
          installWorktreeDependencies(task.worktree);
        }
        if (!files.length && options.escalation === 'rebase-conflict') files = options.conflictFiles ?? [];
        const prompt = workerPrompt(task, options.evidence, options.consultation, files, this.settings.mainCheckout);
        retryPrepared = true;
        return await this.launcher(this.store, task, next, pool, prompt, this.settings.codex);
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
    return this.stop(taskId, true);
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
    return this.store
      .tasks()
      .filter((task) => task.brief.goal === goal && task.state !== 'cancelled')
      .map((task) => task.id);
  }
}
