import {
  ProofCapacityQueuedError,
  ProofUnavailableError,
  type ProofAuthorization,
  authorizeProof,
  authenticateProofManager,
  proofFingerprint,
  preflightProof,
  productionProofProducer,
  type ProofProducer,
  nativeCheckId,
} from './verification.ts';
import { remoteCheckEnvironment } from './merge.ts';
import { defaultPolicy } from './policy.ts';
import { agentAdapter, requireOriginalProofProfile } from './agents.ts';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import {
  controlPlaneReleaseBrief,
  devProductBrief,
  parseBrief,
  readRiskOwnership,
  withStabilizeTarget,
} from './briefs.ts';
import { StaleAttemptError } from './contracts.ts';
import { acquireDirectoryLease, acquireDirectoryLeaseWaiting, LeaseHeldError } from './lease.ts';
import { classifyTask, readRouting, retryFallbacks, routeTask } from './routing.ts';
import { choosePoolWithFallback, PoolPolicyReloader } from './pools.ts';
import { pace, readCodexSchedule } from './pacing.ts';
import { readPool, withObservedExhaustion, type PoolReader } from './usage.ts';
import { awaitHostCapacity, launch, startsFirst, workerPrompt, type RunningWorker } from './launch.ts';
import { rebaseOnto } from './merge-train.ts';
import { completeRebaseConflictContext } from './conflict-progress.ts';
import { sameProcess, terminateProcessGroup } from './process.ts';
import { attemptSession, readMeasurement, makeRecord } from './records.ts';
import { SqliteManagerInbox } from './inbox.ts';
import type { WorkerStore } from './store.ts';
import type { Attempt, Brief, Profile, Settings, Task } from './types.ts';
import { frozenFile, parseFrozenFiles, type FrozenFile } from './frozen.ts';
import { webModule, WorkspaceController } from './workspace.ts';
import { captureLaunchContext } from './launch-context.ts';
import { toolIncidentRetryAllowed } from './tool-incidents.ts';
import { dependencyInstallationMatches, installShared } from './shared-dependencies.ts';
import { prepareInitialDispatch } from './dispatch-preparation.ts';
import {
  authenticatedManager,
  applyPriorityTransition,
  criticalPriority,
  grantCriticalPriority,
  requireNormalDispatch,
  revokeCriticalPriority,
  type AuthenticatedManager,
} from './priority-authority.ts';
import type { PriorityGrant } from './types.ts';

type FrozenTask = Task & { frozenFiles?: Pick<FrozenFile, 'path' | 'hash'>[] };
function normalizedBriefText(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').trimEnd();
}

function briefHash(markdown: string): string {
  return createHash('sha256').update(normalizedBriefText(markdown)).digest('hex');
}

function priorRebaseConflict(store: WorkerStore, taskId: string, attempt: number) {
  const event = store.events(taskId, attempt).findLast((candidate) => candidate.kind === 'gate-outcome');
  if (!event) return undefined;
  try {
    const body = JSON.parse(event.body) as { stage?: unknown; rebaseConflict?: unknown };
    return body.stage === 'rebase' ? completeRebaseConflictContext(body.rebaseConflict) : undefined;
  } catch {
    return undefined;
  }
}

function sameBriefText(left: string, right: string): boolean {
  return normalizedBriefText(left) === normalizedBriefText(right);
}

function applyRetryPriorityTransition(
  db: WorkerStore['db'],
  task: Task,
  previousCritical: boolean,
  nextCritical: boolean,
  actor: AuthenticatedManager | null | undefined,
): boolean {
  // A corrective retry is still a manager action. A no-op priority restatement keeps the audit and grant untouched,
  // but it must be authenticated as the task owner just like a real transition. Internal non-priority reshapes may
  // omit actor; a CLI passes null when caller authentication fails and cannot use this internal seam.
  if (actor === null || (!actor && (previousCritical || nextCritical)))
    throw new Error('priority changes require an authenticated manager session');
  applyPriorityTransition(db, task, previousCritical, nextCritical, actor);
  return previousCritical !== nextCritical;
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
function checkHasTerminalExit(worktree: string, id: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return false;
  const path = join(worktree, '.temp/goal/checks/results', `${id}.json`);
  try {
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return (
      document.status === 'finished' && typeof document.exitCode === 'number' && Number.isSafeInteger(document.exitCode)
    );
  } catch {
    return false;
  }
}
function unresolvedCheckIds(task: Task, attempt: Attempt): string[] {
  return (attempt.checks ?? []).filter((id) => !checkHasTerminalExit(task.worktree, id));
}
type FrozenCommit = { files: FrozenFile[]; formatterError?: string };

function frozenFileAtBase(worktree: string, base: string, path: string): Buffer | undefined {
  const entry = spawnSync('git', ['--literal-pathspecs', 'ls-tree', '-z', base, '--', path], {
    cwd: worktree,
    encoding: 'buffer',
  });
  if (entry.status !== 0) {
    const detail = entry.stderr?.toString('utf8').trim() || entry.error?.message || `git exited ${entry.status}`;
    throw new Error(`git ls-tree: ${detail}`);
  }
  const record = entry.stdout
    .toString('utf8')
    .split('\0')
    .find((candidate) => candidate.endsWith(`\t${path}`));
  if (!record) return undefined;
  const metadata = record.slice(0, record.indexOf('\t')).split(' ');
  const mode = metadata[0];
  const type = metadata[1];
  if (mode === '120000') throw new Error(`frozen file path crosses a symbolic link: ${path}`);
  if (type !== 'blob') throw new Error(`frozen file path is not a file on the task base: ${path}`);

  const content = spawnSync('git', ['show', `${base}:${path}`], { cwd: worktree, encoding: 'buffer' });
  if (content.status !== 0) {
    const detail = content.stderr?.toString('utf8').trim() || content.error?.message || `git exited ${content.status}`;
    throw new Error(`git show: ${detail}`);
  }
  return content.stdout;
}

function commitFrozenFiles(
  worktree: string,
  files: readonly FrozenFile[],
  formatCommand: readonly string[],
  base?: string,
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
    } else {
      if (!base) throw new Error(`cannot unfreeze file without a task base: ${path}`);
      const original = frozenFileAtBase(worktree, base, path);
      if (original) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, original);
      } else if (existsSync(target)) rmSync(target, { force: true });
    }
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
function installWorktreeDependencies(worktree: string, settings: Settings): void {
  installShared(worktree, undefined, undefined, settings.policy);
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
  /** A backed-off retry starts no earlier than this ISO time. */
  notBefore?: string;
  /** A check-host transport failure retries only while no check host is in a probed outage. */
  awaitCheckHosts?: boolean;
  /** Start only while this is still the current attempt: a retry another process already started is not repeated. */
  expectedAttempt?: number;
  /** Start the next attempt in a new provider session, keeping the branch and worktree. */
  freshSession?: boolean;
};
/** Metadata-only first/future proof registration, including stopped/exited runs with historical reservations. */
export type ProofStartOptions = {
  expectedAttempt: number;
  brief?: string;
  /** Exact obsolete dependency edges explicitly approved for removal by this authenticated submission. */
  removeAfter?: string[];
};
export type ProofStartRegistration = {
  taskId: string;
  attempt: number;
  status: 'created' | 'waiting' | 'pending';
  reason?: string;
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
    readonly reader: PoolReader = (pool) => readPool(pool, Date.now(), settings.policy?.provider),
    readonly launcher: typeof launch = launch,
    readonly proofProducer: ProofProducer = productionProofProducer(
      store,
      join(settings.stateDirectory, 'check-registry'),
      { ...process.env, ...remoteCheckEnvironment(settings.stateDirectory) },
    ),
  ) {
    this.poolPolicies = new PoolPolicyReloader(settings.localFile, settings.pools, (summary) => {
      new SqliteManagerInbox(store.db, settings.integration.inboxDirectory).deliver({
        managerId: settings.integration.supermanager,
        kind: 'instruction',
        summary,
      });
    });
  }
  /** Use the same live pool policy and observed allowance as worker launches. */
  resolverPools() {
    const pools = this.poolPolicies.read();
    return {
      pools,
      readings: pools.map((pool) => withObservedExhaustion(this.reader(pool), pool, this.settings.stateDirectory)),
    };
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
  private taskBaseBranch(brief: { goal?: string; target?: 'main' | 'stabilize'; after?: readonly string[] }): string {
    // Dev tasks start from the integration head, as trunk-based work does. The verifier tracks progress and known
    // findings; promotion freezes the integration head and applies its independent full candidate gate. Control-plane
    // work for dev starts there too, since dev's tools/goal is ahead of main's until cp-sync publishes it.
    return controlPlaneReleaseBrief(brief)
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
  private taskBaseHead(brief: { goal?: string; target?: 'main' | 'stabilize' }): string {
    return this.branchHead(this.taskBaseBranch(brief), controlPlaneReleaseBrief(brief) || brief.target !== 'stabilize');
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
    if (task.brief.kind === 'verification') return false;
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
    actor?: AuthenticatedManager | null,
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
    if (brief.kind === 'verification') {
      const prior = excludingTask ? this.store.task(excludingTask).proofAuthorization : undefined;
      if (prior?.fingerprint !== proofFingerprint(brief))
        authorizeProof(
          this.store,
          this.settings.mainCheckout,
          brief,
          actor === undefined ? authenticatedManager(this.store.db) : actor,
          this.settings.integration.operationsManager,
          this.settings.integrationBranch,
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
  private assertLocalAcceptanceCustody(task: Task, nextBrief: Brief): void {
    if (nextBrief.acceptance.placement !== 'local' || task.currentAttempt === 0) return;
    const prior = this.store.attempt({ taskId: task.id, attempt: task.currentAttempt });
    const unresolved = unresolvedCheckIds(task, prior);
    if (unresolved.length)
      throw new Error(
        `Cannot start the local acceptance retry while prior check custody is unresolved (check ${unresolved.join(', ')}): no supported worker-check teardown-intent/receipt API is available; no check was cancelled.`,
      );
  }
  dispatch(briefFile: string, actor?: AuthenticatedManager | null): Task {
    const { brief: submittedBrief, taskClass } = this.validateBrief(briefFile, undefined, actor);
    if (submittedBrief.continuation)
      throw new Error('continuation briefs must go through the backlog controller, not new-task dispatch');
    const authorization =
      submittedBrief.kind === 'verification'
        ? authorizeProof(
            this.store,
            this.settings.mainCheckout,
            submittedBrief,
            actor === undefined ? authenticatedManager(this.store.db) : actor,
            this.settings.integration.operationsManager,
            this.settings.integrationBranch,
          )
        : undefined;
    if (authorization) authorization.integrationBranch = this.settings.integrationBranch;
    requireNormalDispatch(submittedBrief, taskClass);
    const id = crypto.randomUUID();
    const branch = `${this.settings.branchPrefix}${id}`;
    const worktree = join(this.settings.worktreeRoot, id);
    const briefPath = join(this.settings.stateDirectory, 'briefs', `${id}.md`);
    // The lease covers worktree creation, dependency install and frozen-file formatting, about a minute under load.
    // When managers dispatched together, the 30-second default failed dispatches before their tasks existed.
    const lease = acquireDirectoryLeaseWaiting(
      join(this.settings.stateDirectory, 'leases', 'dispatch'),
      (this.settings.policy ?? defaultPolicy).leases.dispatchWaitMs,
      this.settings.policy?.leases,
    );
    try {
      const module = webModule(submittedBrief, this.settings);
      if (module) {
        const controller = new WorkspaceController(this.settings, this.store);
        const firstUse = !this.store.db.query('SELECT module FROM module_workspaces WHERE module=?').get(module);
        const workspace = controller.open(module, this.taskBaseHead(submittedBrief));
        mkdirSync(dirname(briefPath), { recursive: true });
        writeFileSync(briefPath, submittedBrief.markdown, { flag: 'wx' });
        this.store.createTask(
          submittedBrief,
          { branch: workspace.branch, worktree: workspace.worktree, briefPath, base: workspace.base },
          taskClass,
          id,
        );
        this.store.updateTask({ taskId: id, attempt: 0 }, (current) => {
          current.workspace = { module, taskName: basename(briefFile, '.md') };
          if (current.state === 'ready' && !this.dependenciesMet(current)) current.state = 'held';
        });
        if (firstUse) installWorktreeDependencies(workspace.worktree, this.settings);
        this.prepareSharedFrozen(this.store.task(id));
        return this.store.task(id);
      }
      const brief = submittedBrief;
      const base = brief.proof?.sourceCommit ?? this.taskBaseHead(brief);
      const files = parseFrozenFiles(brief.markdown, brief.paths);
      mkdirSync(dirname(worktree), { recursive: true });
      mkdirSync(dirname(briefPath), { recursive: true });
      const frozen = prepareInitialDispatch({
        briefPath,
        briefText: brief.markdown,
        branch,
        worktree,
        createWorktree: () => git(this.settings.mainCheckout, ['worktree', 'add', '-b', branch, worktree, base]),
        ...(brief.kind !== 'verification'
          ? { installDependencies: () => installWorktreeDependencies(worktree, this.settings) }
          : {}),
        freezeFiles: () => commitFrozenFiles(worktree, files, this.settings.formatCommand),
        removeWorktree: () => git(this.settings.mainCheckout, ['worktree', 'remove', '--force', worktree]),
        deleteBranch: () => git(this.settings.mainCheckout, ['branch', '-D', branch]),
      });
      const created = this.store.createTask(brief, { branch, worktree, briefPath, base }, taskClass, id);
      const held = created.state === 'ready' && brief.after.length > 0 && !this.dependenciesMet(created);
      this.store.updateTask({ taskId: id, attempt: 0 }, (current) => {
        if (authorization) current.proofAuthorization = authorization;
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
    const frozen = commitFrozenFiles(task.worktree, files, this.settings.formatCommand, task.base, prior, true);
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
  /** A stopped zero counter alone cannot establish that its source has never been used. */
  private assertStoppedPrelaunchEvidenceAbsent(task: Task): void {
    const refuse = (evidence: unknown): never => {
      throw new Error(
        `prelaunch amendment refuses prior or unknown execution evidence: ${JSON.stringify({
          taskId: task.id,
          attempt: task.currentAttempt,
          state: task.state,
          evidence,
        })}`,
      );
    };
    const metadata = (path: string): Record<string, unknown> => {
      try {
        if (!lstatSync(path).isFile()) return refuse(path);
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse(path);
        return value as Record<string, unknown>;
      } catch (error) {
        return refuse({ path, cause: String(error) });
      }
    };
    for (const table of ['worker_integration_plans', 'worker_worktree_cleanup'])
      if (this.store.db.query(`SELECT 1 FROM ${table} WHERE task_id=? LIMIT 1`).get(task.id)) refuse(table);
    if (
      this.store.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='landing_queue'").get() &&
      this.store.db.query('SELECT 1 FROM landing_queue WHERE task=? LIMIT 1').get(task.id)
    )
      refuse('landing_queue');
    const event = this.store
      .events(task.id)
      .find(
        (entry) =>
          entry.attempt !== 0 ||
          ![
            'start-requested',
            'held-task-released',
            'prelaunch-contract-amended',
            'stopped',
            'cancelled-dependency-reported',
            'cancelled-dependency-notice',
          ].includes(entry.kind),
      );
    if (event) refuse(event);
    if (
      this.store.db
        .query(`SELECT 1 FROM flow_events WHERE task_id=? AND
      (attempt<>0 OR stage NOT IN ('dispatch','start') OR action NOT IN ('dispatched','requested','closed')) LIMIT 1`)
        .get(task.id)
    )
      refuse('execution flow history');
    if (
      this.store.db
        .query(`SELECT 1 FROM worker_retry_intents WHERE task_id=? AND
      (attempt<>0 OR json_extract(body,'$.status') IS NOT 'pending' OR json_extract(body,'$.nextAttempt') IS NOT NULL) LIMIT 1`)
        .get(task.id)
    )
      refuse('advanced start intent');
    try {
      if (!lstatSync(task.worktree).isDirectory()) refuse(task.worktree);
    } catch (error) {
      refuse({ path: task.worktree, cause: String(error) });
    }
    for (const directory of ['runs', 'evidence']) {
      const path = join(this.settings.stateDirectory, directory, task.id);
      try {
        lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        refuse({ path, cause: String(error) });
      }
      refuse(path);
    }
    // Read retained metadata only. No producer import, process probe, cleanup or custody reclassification.
    const checks = join(task.worktree, '.temp/goal/checks');
    const registry = join(this.settings.stateDirectory, 'check-registry');
    for (const directory of [
      join(checks, 'runs'),
      join(checks, 'results'),
      join(checks, 'custody/proofs'),
      join(checks, 'custody/history'),
      join(checks, 'custody/receipts'),
      join(checks, 'custody/stopping'),
      join(checks, 'custody/cancelled'),
      join(checks, 'custody/remote'),
      join(checks, 'custody/ready'),
      registry,
      join(registry, 'proof-reservations'),
      join(registry, 'proof-claims'),
    ]) {
      let names: string[];
      try {
        if (!lstatSync(directory).isDirectory()) refuse(directory);
        names = readdirSync(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        refuse({ path: directory, cause: String(error) });
      }
      for (const name of names!) {
        if (!name.endsWith('.json')) continue;
        const path = join(directory, name);
        let value = metadata(path);
        // A check claim aliases its token claim. Resolve that one explicit relation for owner attribution only.
        if (directory === join(registry, 'proof-claims') && name.startsWith('check-')) {
          if (typeof value.token !== 'string' || !nativeCheckId.test(value.token)) refuse(path);
          const claim = metadata(join(directory, `${(value.token as string).toLowerCase()}.json`));
          if (claim.token !== value.token || claim.checkId !== name.slice(6, -5)) refuse(path);
          value = claim;
        }
        const ownership = value.ownership as Record<string, unknown> | undefined;
        const binding = value.binding as Record<string, unknown> | undefined;
        const owners = [value.taskId, ownership?.taskId, binding?.taskId].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        );
        // Even terminal custody is historical use; unowned or unreadable metadata stays unknown.
        if (!owners.length || owners.includes(task.id)) refuse(path);
      }
    }
  }
  /** Replace ordinary input before its first start, without scheduling or touching its capacity ticket. */
  amend(
    taskId: string,
    options: { expectedAttempt: number; brief: string },
    actor?: AuthenticatedManager | null,
  ): { taskId: string; attempt: 0; status: 'amended' | 'unchanged'; contractSha256: string } {
    const lease = acquireDirectoryLease(
      join(this.settings.stateDirectory, 'leases', taskId),
      this.settings.policy?.leases,
    );
    let briefPath: string | undefined;
    try {
      return this.store.write({ taskId, attempt: options.expectedAttempt }, () => {
        const task = this.store.task(taskId);
        const attempts = this.store.attempts(taskId);
        if (
          options.expectedAttempt !== 0 ||
          task.currentAttempt !== 0 ||
          !['ready', 'held', 'stopped'].includes(task.state) ||
          attempts.length ||
          task.integratedCommit ||
          task.mergedCommit ||
          task.integratedBase ||
          task.integratedCommits?.length ||
          task.proofAuthorization ||
          task.proofRun ||
          (task.state === 'held' && !task.brief.after.length) ||
          task.brief.kind === 'verification' ||
          this.store.db.query('SELECT 1 FROM worker_proof_reservations WHERE task_id=? LIMIT 1').get(taskId) ||
          this.store.db.query('SELECT 1 FROM worker_records WHERE task_id=? LIMIT 1').get(taskId)
        ) {
          const current = attempts.at(-1);
          throw new Error(
            `prelaunch amendment requires an ordinary never-started ready/held/stopped task: ${JSON.stringify({
              taskId,
              attempt: task.currentAttempt,
              state: task.state,
              attemptState: current?.state,
              process: current?.process,
              logPath: current?.logPath,
            })}`,
          );
        }
        const owner = actor === undefined ? authenticatedManager(this.store.db) : actor;
        if (!owner || ![task.brief.manager, this.settings.integration.operationsManager].includes(owner.id))
          throw new Error('prelaunch amendment requires the authenticated owning or operations manager');
        // Resolve against persisted sessions again under the write lock, including ambiguity and stale-session fences.
        const authenticated = authenticatedManager(this.store.db, {
          CODEX_THREAD_ID: owner.sessionId,
          GOAL_MANAGER: owner.id,
        });
        if (!authenticated || authenticated.id !== owner.id || authenticated.sessionId !== owner.sessionId)
          throw new Error('prelaunch amendment requires a live unambiguous authenticated manager session');
        if (task.state === 'stopped') this.assertStoppedPrelaunchEvidenceAbsent(task);
        const submitted = this.validateBrief(options.brief, taskId, owner);
        if (submitted.brief.kind === 'verification')
          throw new Error('use proof registration for verification contracts');
        if (submitted.brief.goal !== task.brief.goal || submitted.brief.manager !== task.brief.manager)
          throw new Error('an amended brief must keep the same goal and manager');
        if (task.workspace && webModule(submitted.brief, this.settings) !== task.workspace.module)
          throw new Error('amendment outside a shared module requires a new isolated task');
        if (criticalPriority(task.brief, task.taskClass) || criticalPriority(submitted.brief, submitted.taskClass))
          throw new Error('prelaunch amendment preserves ordinary priority only');
        const previousFrozen = parseFrozenFiles(task.brief.markdown, task.brief.paths);
        const nextFrozen = parseFrozenFiles(submitted.brief.markdown, submitted.brief.paths);
        if (
          previousFrozen.length !== nextFrozen.length ||
          previousFrozen.some((file) => !nextFrozen.some((next) => next.path === file.path && next.hash === file.hash))
        )
          throw new Error('prelaunch amendment must preserve frozen acceptance files');
        const contractSha256 = briefHash(submitted.brief.markdown);
        if (sameBriefText(task.brief.markdown, submitted.brief.markdown))
          return { taskId, attempt: 0, status: 'unchanged', contractSha256 };
        briefPath = join(this.settings.stateDirectory, 'briefs', `${taskId}-amended-${crypto.randomUUID()}.md`);
        mkdirSync(dirname(briefPath), { recursive: true });
        writeFileSync(briefPath, submitted.brief.markdown, { flag: 'wx' });
        const acceptedPath = briefPath;
        this.store.updateTask({ taskId, attempt: 0 }, (current) => {
          current.brief = submitted.brief;
          current.briefPath = acceptedPath;
          current.taskClass = submitted.taskClass;
          current.state = this.dependenciesMet(current) ? 'ready' : 'held';
        });
        this.store.event({ taskId, attempt: 0 }, 'prelaunch-contract-amended', {
          actor: owner,
          ...(task.state === 'stopped' ? { previousState: task.state } : {}),
          previous: { path: task.briefPath, sha256: briefHash(task.brief.markdown), markdown: task.brief.markdown },
          current: { path: acceptedPath, sha256: contractSha256, markdown: submitted.brief.markdown },
        });
        return { taskId, attempt: 0, status: 'amended', contractSha256 };
      });
    } catch (error) {
      if (briefPath) rmSync(briefPath, { force: true });
      if (error instanceof StaleAttemptError) {
        const current = this.store.task(taskId);
        const attempt = this.store.attempts(taskId).at(-1);
        throw new Error(
          `prelaunch amendment refused stale/current generation: ${JSON.stringify({
            taskId,
            expectedAttempt: options.expectedAttempt,
            attempt: current.currentAttempt,
            state: current.state,
            attemptState: attempt?.state,
            process: attempt?.process,
            logPath: attempt?.logPath,
          })}`,
        );
      }
      throw error;
    } finally {
      lease.release();
    }
  }
  /** Authenticated reconciliation; preserves every native identity and raw historical fact. */
  releaseProof(
    taskId: string,
    expectedAttempt: number,
    actor?: AuthenticatedManager | null,
  ): {
    taskId: string;
    attempt: number;
    status: 'released';
    checks: string[];
  } {
    const lease = acquireDirectoryLease(
      join(this.settings.stateDirectory, 'leases', taskId),
      this.settings.policy?.leases,
    );
    try {
      const task = this.store.task(taskId);
      if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 1 || task.currentAttempt !== expectedAttempt)
        throw new StaleAttemptError({ taskId, attempt: expectedAttempt }, task.currentAttempt);
      authenticateProofManager(
        this.store,
        task.brief.manager,
        actor === undefined ? authenticatedManager(this.store.db) : actor,
        this.settings.integration.operationsManager,
      );
      const checks = this.store.releaseExitedProofReservations({ taskId, attempt: expectedAttempt }, true);
      return { taskId, attempt: expectedAttempt, status: 'released', checks };
    } finally {
      lease.release();
    }
  }
  /** Authenticate a SAME-ID first/future proof start, retaining prior incarnations; never launches anything. */
  queueProofStart(
    taskId: string,
    options: ProofStartOptions,
    actor?: AuthenticatedManager | null,
  ): ProofStartRegistration {
    const lease = acquireDirectoryLease(
      join(this.settings.stateDirectory, 'leases', taskId),
      this.settings.policy?.leases,
    );
    let briefPath: string | undefined;
    try {
      const task = this.store.task(taskId);
      const ref = { taskId, attempt: options.expectedAttempt };
      if (
        !Number.isSafeInteger(options.expectedAttempt) ||
        options.expectedAttempt < 0 ||
        task.currentAttempt !== options.expectedAttempt
      )
        throw new StaleAttemptError(ref, task.currentAttempt);
      const submitted = options.brief === undefined ? undefined : this.validateBrief(options.brief, taskId, actor);
      const nextBrief = submitted?.brief ?? task.brief;
      if (nextBrief.kind !== 'verification')
        throw new Error('first-start receiving requires a typed verification brief');
      this.store.assertProofRegistration(ref, nextBrief);
      this.store.assertProofFirstStart(ref, nextBrief);
      const removed = task.brief.after.filter((id) => !nextBrief.after.includes(id));
      const approved = options.removeAfter ?? [];
      if (
        new Set(approved).size !== approved.length ||
        removed.length !== approved.length ||
        approved.some((id) => !removed.includes(id))
      )
        throw new Error('removed after lanes must exactly match explicit removeAfter approval');
      const authorization = authorizeProof(
        this.store,
        this.settings.mainCheckout,
        nextBrief,
        actor === undefined ? authenticatedManager(this.store.db) : actor,
        this.settings.integration.operationsManager,
        this.settings.integrationBranch,
      );
      const missing = preflightProof(this.settings.mainCheckout, nextBrief);
      if (missing.length)
        throw new ProofUnavailableError(`Proof pending/unavailable: captured inputs missing: ${missing.join(', ')}`);
      if (submitted) {
        briefPath = join(this.settings.stateDirectory, 'briefs', `${taskId}-registered-${crypto.randomUUID()}.md`);
        mkdirSync(dirname(briefPath), { recursive: true });
        writeFileSync(briefPath, nextBrief.markdown, { flag: 'wx' });
      }
      this.store.updateHeldRetryTask(ref, (current) => {
        this.store.assertProofRegistration(ref, nextBrief);
        this.store.assertProofFirstStart(ref, nextBrief);
        const previousCritical = criticalPriority(current.brief, current.taskClass);
        current.brief = nextBrief;
        if (briefPath) current.briefPath = briefPath;
        current.taskClass = classifyTask(nextBrief);
        current.proofAuthorization = authorization;
        if (proofFingerprint(task.brief) !== proofFingerprint(nextBrief))
          current.pendingBriefChange = {
            previousBriefHash: current.pendingBriefChange?.previousBriefHash ?? briefHash(task.brief.markdown),
            newBriefHash: briefHash(nextBrief.markdown),
          };
        this.applyRetryPriority(current, previousCritical, actor, authorization);
        current.state = this.dependenciesMet(current) ? 'ready' : 'held';
        this.store.saveRetryIntent(ref, {});
      });
      briefPath = undefined; // The committed registration owns this immutable file.
      if (!this.dependenciesMet({ brief: nextBrief }))
        return { taskId, attempt: ref.attempt, status: 'waiting', reason: 'Dependencies pending' };
      if (!this.store.proofCapacityAvailable(nextBrief.goal, taskId))
        return {
          taskId,
          attempt: ref.attempt,
          status: 'waiting',
          reason: this.store.proofCapacityReason(nextBrief.goal, taskId),
        };
      return { taskId, attempt: ref.attempt, status: 'created' };
    } catch (error) {
      if (briefPath) rmSync(briefPath, { force: true });
      throw error;
    } finally {
      lease.release();
    }
  }
  /** Whether retrying this task, with an optional replacement brief, is product work on the integration branch. */
  devProductRetry(taskId: string, briefFile?: string): boolean {
    const current = this.store.task(taskId).brief;
    const next =
      briefFile === undefined
        ? current
        : parseBrief(readFileSync(briefFile, 'utf8'), readRiskOwnership(this.settings.riskAreasFile));
    return devProductBrief(current) && devProductBrief(next);
  }
  /** Persist an explicit retry for the host to start on its next recovery sweep. */
  queueRetry(
    taskId: string,
    options: RetryOptions = {},
    actor: AuthenticatedManager | null | undefined = undefined,
  ): void {
    const expectedAttempt = options.expectedAttempt ?? this.store.task(taskId).currentAttempt;
    const lease = acquireDirectoryLease(
      join(this.settings.stateDirectory, 'leases', taskId),
      this.settings.policy?.leases,
    );
    try {
      this.queueRetryLeased(taskId, { ...options, expectedAttempt }, actor);
    } finally {
      lease.release();
    }
  }
  /** Queue one owner-authenticated backlog continuation under the same lease used by ordinary retries. */
  queueBacklogContinuation(
    taskId: string,
    goal: string,
    expectedAttempt: number,
    briefFile: string,
    actor: AuthenticatedManager,
  ): void {
    const lease = acquireDirectoryLease(
      join(this.settings.stateDirectory, 'leases', taskId),
      this.settings.policy?.leases,
    );
    try {
      const task = this.store.task(taskId);
      if (task.currentAttempt !== expectedAttempt)
        throw new StaleAttemptError({ taskId, attempt: expectedAttempt }, task.currentAttempt);
      if (task.brief.goal !== goal) throw new Error(`task ${taskId} belongs to Goal ${task.brief.goal}, not ${goal}`);
      if (actor.id !== task.brief.manager)
        throw new Error(`only task manager ${task.brief.manager} may continue ${taskId}`);
      if (task.state === 'cancelled') throw new Error(`task ${taskId} is cancelled; dispatch a new brief instead`);
      if (task.currentAttempt < 1) throw new Error(`task ${taskId} has no existing attempt to continue`);
      if (task.state === 'running' || task.state === 'landing')
        throw new Error(`task ${taskId} is already live; wait for attempt ${expectedAttempt} to stop`);

      const { brief: nextBrief } = this.validateBrief(briefFile, taskId, actor);
      if (nextBrief.goal !== goal || nextBrief.manager !== task.brief.manager)
        throw new Error(`continuation must keep Goal ${goal} and manager ${task.brief.manager}`);
      const ref = { taskId, attempt: expectedAttempt };
      const attempt = this.store.attempt(ref);
      if (attempt.state === 'cancelled') throw new Error(`attempt ${expectedAttempt} for ${taskId} is cancelled`);
      if (
        ['pending', 'running', 'waiting'].includes(attempt.state) ||
        [attempt.process, attempt.driver, ...(attempt.auxiliaryProcesses ?? [])].some(
          (identity) => identity && sameProcess(identity),
        )
      )
        throw new Error(`attempt ${expectedAttempt} for ${taskId} is still live; wait for it to stop`);

      const pending = this.store.retryIntent(ref);
      if (pending?.status === 'pending') {
        if (['ready', 'held', 'stopped'].includes(task.state) && task.brief.markdown === nextBrief.markdown) return;
        throw new Error(`a different retry is already pending for ${taskId}; wait for it to start or settle`);
      }
      if (task.state === 'held' && task.pendingBriefChange?.newBriefHash === briefHash(nextBrief.markdown)) return;
      if (!['stopped', 'held'].includes(task.state))
        throw new Error(`task ${taskId} is ${task.state}; continue it after its current work stops`);
      if (!['exited', 'stopped'].includes(attempt.state))
        throw new Error(`attempt ${expectedAttempt} for ${taskId} is ${attempt.state}; wait for it to stop`);
      this.queueRetryLeased(taskId, { expectedAttempt, brief: briefFile }, actor);
    } finally {
      lease.release();
    }
  }
  private queueRetryLeased(taskId: string, options: RetryOptions, actor?: AuthenticatedManager | null): void {
    const task = this.store.task(taskId);
    if (task.currentAttempt !== options.expectedAttempt)
      throw new StaleAttemptError({ taskId, attempt: options.expectedAttempt! }, task.currentAttempt);
    if (!['ready', 'running', 'landing', 'stopped', 'held'].includes(task.state))
      throw new Error(`cannot retry ${task.state} task`);
    const nextBrief = options.brief === undefined ? task.brief : this.validateBrief(options.brief, taskId, actor).brief;
    // Product work on the integration branch retries at any generation, including one that never started.
    const devProduct = devProductBrief(task.brief) && devProductBrief(nextBrief);
    if (!task.currentAttempt && !devProduct)
      throw new Error('cannot queue a retry before the first attempt; use queueProofStart');
    if (task.brief.kind === 'verification' && nextBrief.kind !== 'verification')
      throw new Error('registered proof contracts cannot become product retries');
    let authorization: ProofAuthorization | undefined;
    if (nextBrief.kind === 'verification') {
      this.store.assertProofRegistration({ taskId, attempt: task.currentAttempt }, nextBrief);
      authorization = authorizeProof(
        this.store,
        this.settings.mainCheckout,
        nextBrief,
        actor === undefined ? authenticatedManager(this.store.db) : actor,
        this.settings.integration.operationsManager,
        this.settings.integrationBranch,
      );
      const missing = preflightProof(this.settings.mainCheckout, nextBrief);
      if (missing.length)
        throw new ProofUnavailableError(`Proof pending/unavailable: captured inputs missing: ${missing.join(', ')}`);
    }
    this.assertLocalAcceptanceCustody(task, nextBrief);
    const ref = { taskId, attempt: task.currentAttempt };
    const incidentHeld = !toolIncidentRetryAllowed(this.store, ref);
    // A held task's brief can change while its retry waits for dependencies: refusing it made managers cancel held
    // tasks and lose their branches. The pending retry then starts the amended brief.
    // A product retry still waiting to start takes an amended brief; the pending retry then starts that brief.
    const amendPending = devProduct && options.brief !== undefined;
    if (task.state !== 'held' && !amendPending && !incidentHeld && this.store.retryIntent(ref)?.status === 'pending')
      throw new Error('a retry is already pending');
    if (task.state === 'held') {
      const reshaped = options.brief === undefined ? undefined : this.validateBrief(options.brief, taskId, actor);
      if (!reshaped) throw new Error('a held task can only be retried with --brief');
      if (reshaped.brief.goal !== task.brief.goal || reshaped.brief.manager !== task.brief.manager)
        throw new Error('a reshaped brief must keep the same goal and manager');
      if (sameBriefText(reshaped.brief.markdown, task.brief.markdown)) throw new BriefContractUnchangedError();
      const briefPath = join(this.settings.stateDirectory, 'briefs', `${taskId}-queued-${crypto.randomUUID()}.md`);
      mkdirSync(dirname(briefPath), { recursive: true });
      writeFileSync(briefPath, reshaped.brief.markdown, { flag: 'wx' });
      let priorityChanged = false;
      try {
        this.store.updateHeldRetryTask(
          ref,
          (current) => {
            if (authorization) {
              this.store.assertProofRegistration(ref, nextBrief);
              current.proofAuthorization = authorization;
            }
            const previousCritical = criticalPriority(current.brief, current.taskClass);
            current.brief = reshaped.brief;
            current.briefPath = briefPath;
            current.taskClass = reshaped.taskClass;
            if (options.freshSession) current.freshSession = true;
            priorityChanged = this.applyRetryPriority(current, previousCritical, actor, authorization);
            current.state = 'held';
            current.pendingBriefChange = {
              previousBriefHash: current.pendingBriefChange?.previousBriefHash ?? briefHash(task.brief.markdown),
              newBriefHash: briefHash(reshaped.brief.markdown),
            };
            // With no remaining `after` edge the host has no dependency-release start path. Retain an explicit
            // retry instead, still held until any live worker settles and the host releases this generation.
            if (!current.brief.after.length || authorization) {
              const intent = this.store.retryIntent(ref);
              if (intent) {
                this.store.updateRetryIntent(ref, (value) => {
                  value.status = 'pending';
                  delete value.nextAttempt;
                });
              } else {
                const retryOptions = { ...options };
                delete retryOptions.brief;
                delete retryOptions.expectedAttempt;
                delete retryOptions.freshSession;
                this.store.saveRetryIntent(ref, retryOptions);
              }
            }
          },
          { reshapeHeld: true },
        );
      } catch (error) {
        rmSync(briefPath, { force: true });
        throw error;
      }
      if (priorityChanged && nextBrief.kind !== 'verification') this.writeTaskPriority(this.store.task(taskId));
      return;
    }
    const reshaped = options.brief === undefined ? undefined : this.validateBrief(options.brief, taskId, actor);
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
    delete retryOptions.expectedAttempt;
    delete retryOptions.freshSession;
    let priorityChanged = false;
    try {
      this.store.recordExplicitRetry(
        ref,
        (current) => {
          if (authorization) {
            this.store.assertProofRegistration(ref, nextBrief);
            current.proofAuthorization = authorization;
          }
          if (!['ready', 'running', 'landing', 'stopped'].includes(current.state))
            throw new Error(`cannot retry ${current.state} task`);
          if (options.freshSession) current.freshSession = true;
          if (reshaped) {
            const previousCritical = criticalPriority(current.brief, current.taskClass);
            current.brief = reshaped.brief;
            current.briefPath = briefPath!;
            current.taskClass = reshaped.taskClass;
            priorityChanged = this.applyRetryPriority(current, previousCritical, actor, authorization);
            current.pendingBriefChange = {
              previousBriefHash: current.pendingBriefChange?.previousBriefHash ?? briefHash(task.brief.markdown),
              newBriefHash: briefHash(reshaped.brief.markdown),
            };
            if (!this.dependenciesMet({ brief: current.brief })) current.state = 'held';
            else current.state = 'ready';
          } else if (current.state === 'stopped') current.state = 'ready';
        },
        retryOptions,
        { amendPending: amendPending || incidentHeld },
      );
    } catch (error) {
      if (briefPath) rmSync(briefPath, { force: true });
      throw error;
    }
    if (priorityChanged && nextBrief.kind !== 'verification') this.writeTaskPriority(this.store.task(taskId));
  }
  /** A real proof permit also authorizes its required ordinary priority, including an operations conversion. */
  private applyRetryPriority(
    task: Task,
    previousCritical: boolean,
    actor: AuthenticatedManager | null | undefined,
    authorization?: ProofAuthorization,
  ): boolean {
    if (!authorization) {
      return applyRetryPriorityTransition(
        this.store.db,
        task,
        previousCritical,
        criticalPriority(task.brief, task.taskClass),
        actor,
      );
    }
    if (criticalPriority(task.brief, task.taskClass)) throw new Error('proof tasks are ordinary priority only');
    if (!previousCritical) return false;
    task.priorityHistory ??= [];
    task.priorityHistory.push({
      value: 'normal',
      setter: authorization.manager,
      grantor: null,
      at: new Date().toISOString(),
      provenance: { kind: 'manager-session', sessionId: authorization.sessionId },
    });
    return true;
  }
  setPriority(
    taskId: string,
    priority: 'critical' | 'normal',
    actor: AuthenticatedManager | null | undefined = undefined,
  ): Task {
    const task = this.store.task(taskId);
    const nextCritical = priority === 'critical';
    if (task.brief.kind === 'verification' && nextCritical) throw new Error('proof tasks are ordinary priority only');
    const updated = this.store.updatePriorityMetadata({ taskId, attempt: task.currentAttempt }, (current) => {
      applyPriorityTransition(
        this.store.db,
        current,
        criticalPriority(current.brief, current.taskClass),
        nextCritical,
        actor,
      );
    });
    this.writeTaskPriority(updated);
    return updated;
  }
  grantPriority(taskId: string, actor: AuthenticatedManager): PriorityGrant {
    const task = this.store.task(taskId);
    let grant!: PriorityGrant;
    this.store.updatePriorityMetadata({ taskId, attempt: task.currentAttempt }, (current) => {
      grant = grantCriticalPriority(this.store.db, current, actor);
    });
    return grant;
  }
  revokePriority(taskId: string, grantId: string, actor: AuthenticatedManager): PriorityGrant {
    const task = this.store.task(taskId);
    let grant!: PriorityGrant;
    this.store.updatePriorityMetadata({ taskId, attempt: task.currentAttempt }, (current) => {
      grant = revokeCriticalPriority(current, grantId, actor);
    });
    return grant;
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
      { policy: this.settings.policy?.capacity },
    );
    try {
      // Several sweeps can find the same released task; the one holding its lease rebases, installs and launches, and
      // the others get LeaseHeldError instead of running git and bun in the same worktree at once.
      const lease = acquireDirectoryLease(
        join(this.settings.stateDirectory, 'leases', taskId),
        this.settings.policy?.leases,
      );
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
    // A generation-zero owner may remove the last dependency while this first start waits for capacity.
    if (task.state === 'ready' && !task.currentAttempt && !task.brief.after.length) {
      const worker = await this.retryTask(taskId, {}, true);
      if (!worker) throw new Error('released task was unexpectedly held again');
      return worker;
    }
    if (task.state !== 'ready' || !task.brief.after.length) throw new Error('only a released held task can be started');
    if (task.workspace || task.brief.kind === 'verification') {
      const worker = await this.retryTask(taskId, {}, true);
      if (!worker) throw new Error('released task was unexpectedly held again');
      return worker;
    }
    this.ensureWorktree(task);
    this.commitRetryLeftovers(task, task.currentAttempt);
    const integration = this.taskBaseHead(task.brief);
    const commits = Number(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`]));
    const branch = git(task.worktree, ['branch', '--show-current']);
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
        rebaseOnto(
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
    const worker = await this.retryTask(taskId, {}, true);
    if (!worker) throw new Error('released task was unexpectedly held again');
    return worker;
  }
  /** Recreate a finished task's removed checkout while holding its task lease. */
  private ensureWorktree(task: Task): void {
    if (existsSync(task.worktree)) return;
    const lease = acquireDirectoryLeaseWaiting(
      join(this.settings.stateDirectory, 'leases', 'dispatch'),
      (this.settings.policy ?? defaultPolicy).leases.dispatchWaitMs,
      this.settings.policy?.leases,
    );
    try {
      mkdirSync(dirname(task.worktree), { recursive: true });
      try {
        git(this.settings.mainCheckout, ['worktree', 'add', task.worktree, task.branch]);
      } catch {
        git(this.settings.mainCheckout, ['worktree', 'prune']);
        git(this.settings.mainCheckout, ['worktree', 'add', task.worktree, task.branch]);
      }
      if (task.brief.kind !== 'verification') installWorktreeDependencies(task.worktree, this.settings);
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
      // Any retry waits for unmet dependencies: a stopped or ready task retried while its dependency was still landing
      // started against code it needs (commerce a65, 2026-10-29). A running attempt is replaced, not held.
      const running =
        task.currentAttempt > 0 && this.store.attempt({ taskId, attempt: task.currentAttempt }).state === 'running';
      const hold = !running && !this.dependenciesMet({ brief: next.brief });
      // Replacing a running worker adds none, so it never waits behind the worker it replaces.
      const replaces =
        task.currentAttempt > 0 && this.store.attempt({ taskId, attempt: task.currentAttempt }).state === 'running';
      return { hold: hold || replaces, first: startsFirst(next) };
    } catch {
      // The retry itself reports the error under the task's lease.
      return { hold: false, first: startsFirst(this.store.task(taskId)) };
    }
  }
  /** Prepare an authorized unreserved capture without rewriting retained empty-report branches. */
  private prepareProofWorktree(task: Task, ref: Attempt): Task {
    const captured = task.brief.proof!.sourceCommit;
    const tip = git(task.worktree, ['rev-parse', 'HEAD']);
    if (git(task.worktree, ['status', '--porcelain', '--untracked-files=all']))
      throw new Error('Proof source is read-only; worktree differs from captured commit');
    if (tip !== captured) {
      this.store.assertProofPreparation(ref);
      if (
        git(task.worktree, ['merge-base', task.base, tip]) !== task.base ||
        git(task.worktree, ['diff', '--name-only', task.base, tip])
      )
        throw new Error(
          'Proof source is read-only; only an unreserved clean retained empty-report branch can prepare a fresh capture',
        );
      const worktree = join(this.settings.worktreeRoot, `${task.id}-proof-${captured}`);
      if (!existsSync(worktree)) git(this.settings.mainCheckout, ['worktree', 'add', '--detach', worktree, captured]);
      if (
        git(worktree, ['rev-parse', 'HEAD']) !== captured ||
        git(worktree, ['status', '--porcelain', '--untracked-files=all'])
      )
        throw new Error('Proof captured source preparation differs from its registered commit');
      this.store.event(ref, 'proof-source-prepared', {
        retainedWorktree: task.worktree,
        retainedBranch: task.branch,
        retainedHead: tip,
        worktree,
        sourceCommit: captured,
      });
      task = this.store.updateTask(ref, (current) => {
        current.worktree = worktree;
        current.base = captured;
      });
    }
    return task;
  }
  /** Refuse stale captures and missing original inputs before creating an ordinary proof attempt. */
  assertProofStart(task: Task): void {
    if (task.brief.kind !== 'verification') return;
    if (!task.brief.proof || task.proofAuthorization?.fingerprint !== proofFingerprint(task.brief))
      throw new ProofUnavailableError('Proof pending/unavailable: authenticated registration required');
    const head = this.branchHead(this.settings.integrationBranch, false);
    if (head !== task.brief.proof.sourceCommit)
      throw new ProofUnavailableError(
        `Proof pending/unavailable: integration source advanced from ${task.brief.proof.sourceCommit} to ${head}; authenticated owner or operations must register the exact unchanged contract with sourceCommit ${head} through retry ${task.id} --proof-start --expected-attempt ${task.currentAttempt} --brief <fresh-brief> for a stopped/exited attempt before its new invocation; no separate logical release is required and every old binding/source remains evidence`,
      );
    if (
      spawnSync('git', ['cat-file', '-e', `${task.brief.proof.sourceCommit}:scripts/worker-check.ts`], {
        cwd: this.settings.mainCheckout,
        stdio: 'ignore',
      }).status !== 0
    )
      throw new ProofUnavailableError(
        'Proof pending/unavailable: captured ordinary scripts/worker-check.ts is missing',
      );
    const missing = preflightProof(this.settings.mainCheckout, task.brief);
    if (missing.length)
      throw new ProofUnavailableError(`Proof pending/unavailable: captured inputs missing: ${missing.join(', ')}`);
  }
  async refreshProofAdmission(task: Task): Promise<void> {
    if (task.brief.kind !== 'verification') return;
    if (
      task.currentAttempt &&
      ['stopped', 'exited', 'cancelled', 'superseded'].includes(
        this.store.attempt({ taskId: task.id, attempt: task.currentAttempt }).state,
      )
    )
      this.store.releaseExitedProofReservations({ taskId: task.id, attempt: task.currentAttempt });
  }
  /** `leased` when the caller already holds the task's lease. */
  private async retryTask(taskId: string, options: RetryOptions, leased = false): Promise<RunningWorker | null> {
    if (!leased) {
      const current = this.store.task(taskId);
      const nextBrief = options.brief === undefined ? current.brief : this.validateBrief(options.brief, taskId).brief;
      this.assertLocalAcceptanceCustody(current, nextBrief);
      if (current.brief.kind === 'verification' && nextBrief.kind !== 'verification')
        throw new Error('registered proof contracts cannot become product retries');
      if (nextBrief.kind === 'verification') {
        this.assertProofStart({ ...current, brief: nextBrief });
        await this.refreshProofAdmission({ ...current, brief: nextBrief });
      }
    }
    // Wait for host capacity before taking the task's lease, so a waiting task can still be reshaped or stopped.
    const plan = leased ? undefined : this.retryPlan(taskId, options);
    const targetAttempt = plan && !plan.hold ? this.store.task(taskId).currentAttempt + 1 : undefined;
    const releaseCapacity =
      plan && !plan.hold
        ? await awaitHostCapacity(this.store, this.settings.stateDirectory, plan.first, taskId, targetAttempt, {
            policy: this.settings.policy?.capacity,
          })
        : () => {};
    let lease: ReturnType<typeof acquireDirectoryLeaseWaiting> | undefined;
    try {
      lease = leased
        ? undefined
        : acquireDirectoryLeaseWaiting(
            join(this.settings.stateDirectory, 'leases', taskId),
            undefined,
            this.settings.policy?.leases,
          );
      let task = this.store.task(taskId);
      if (options.expectedAttempt !== undefined && task.currentAttempt !== options.expectedAttempt)
        throw new StaleAttemptError({ taskId, attempt: options.expectedAttempt }, task.currentAttempt);
      this.store.assertRetryAllowed({ taskId, attempt: task.currentAttempt });
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
      if (task.brief.kind === 'verification' && nextBrief.kind !== 'verification')
        throw new Error('registered proof contracts cannot become product retries');
      if (nextBrief.kind === 'verification') {
        this.assertProofStart({ ...task, brief: nextBrief });
        await this.refreshProofAdmission({ ...task, brief: nextBrief });
        if (!this.store.proofCapacityAvailable(nextBrief.goal, task.id)) {
          this.store.saveRetryIntent({ taskId, attempt: task.currentAttempt }, {});
          this.store.event({ taskId, attempt: task.currentAttempt }, 'proof-capacity-queued', {
            goal: nextBrief.goal,
            reason: this.store.proofCapacityReason(nextBrief.goal, task.id),
          });
          throw new ProofCapacityQueuedError();
        }
      }
      this.assertLocalAcceptanceCustody(task, nextBrief);
      const nextTaskClass = reshaped?.taskClass ?? task.taskClass;
      if (!nextBrief.acceptance.command.length && !nextBrief.acceptance.workerOwned)
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
          { reshapeHeld: true },
        );
      }
      // A held task stays held while its dependencies are unmet, reshaped or not; once they are met it starts.
      const currentRunning =
        task.currentAttempt > 0 && this.store.attempt({ taskId, attempt: task.currentAttempt }).state === 'running';
      if (task.state === 'held' && currentRunning) return null;
      if ((reshaped || task.state === 'held' || !currentRunning) && !this.dependenciesMet({ brief: nextBrief })) {
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
        const releaseRef = { taskId, attempt: task.currentAttempt };
        task = this.store.releaseHeldRetryTask(releaseRef, (current) => {
          current.state = 'ready';
        });
        // Leave the amended task available to stop or reshape while it waits for capacity.
        lease?.release();
        lease = undefined;
        const startOptions = { ...options };
        delete startOptions.brief;
        return task.brief.after.length ? this.retryHeld(taskId) : this.retryTask(taskId, startOptions);
      }
      this.ensureWorktree(task);
      const pools = this.poolPolicies.read();
      const old = task.currentAttempt ? this.store.attempt({ taskId, attempt: task.currentAttempt }) : null;
      const previousConflict =
        options.escalation === 'rebase-conflict' && old
          ? priorRebaseConflict(this.store, taskId, old.attempt)
          : undefined;
      const heldRelease = this.store.events(taskId, task.currentAttempt).some((event) => {
        if (event.kind !== 'held-task-released') return false;
        try {
          return (JSON.parse(event.body) as { releasedAttempt?: unknown }).releasedAttempt === task.currentAttempt + 1;
        } catch {
          return false;
        }
      });
      const boundary = heldRelease
        ? 'held-release'
        : old?.escalation === 'import'
          ? 'adopted-legacy'
          : old
            ? 'retry'
            : 'fresh';
      const origin = old?.escalation === 'import' ? 'adopted-legacy' : 'managed';
      const oldConfigDirectory = old
        ? pools.find((candidate) => candidate.name === old.pool)?.configDirectory
        : undefined;
      const table = readRouting(this.settings.routingFile, this.settings.policy?.routing);
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
        nextBrief.kind !== 'verification' && !pinned && old && routable(old.profile)
          ? { profile: old.profile, tableVersion: old.tableVersion, experiment: old.experiment }
          : routeTask(nextBrief, task.sequence, table);
      const readings = pools.map((pool) =>
        withObservedExhaustion(this.reader(pool), pool, this.settings.stateDirectory),
      );
      const history = this.store
        .attempts()
        .flatMap((a) => [a.before, a.after])
        .filter((r) => r !== null);
      const routing = readRouting(this.settings.routingFile, this.settings.policy?.routing);
      let fallbacks =
        options.profile || pinned || nextBrief.kind === 'verification' ? [] : retryFallbacks(routing, nextTaskClass);
      const paced = nextTaskClass === 'mechanical' || routing.classes[nextTaskClass]?.paced !== false;
      // A retry keeps its engine, but three failed attempts in a row on one model say the model is the problem: the
      // next attempt goes to the route's first other model. Failures no model change can fix do not count; for product
      // work on dev these include environment failures, whose retries resume the same session.
      const unswitchable = ['pool-exhausted', 'rebase-conflict', 'scope-growth'];
      if (devProductBrief(nextBrief)) unswitchable.push('environment');
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
            !unswitchable.includes(attempt.escalation ?? ''),
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
              return reading
                ? pace(reading, candidate, now, schedule, this.settings.policy?.pacing)?.urgency
                : undefined;
            },
      );
      const oldSession = old ? attemptSession(old, this.settings.policy?.records) : null;
      // Releasing a contract amended after its worker settled starts a new conversation. A held check waiter is
      // different: release stops its waiting attempt, but its saved checks still need their original session.
      // Terminal records take precedence over checks retained from an earlier waiting turn.
      const continuingCheckWait = old?.state === 'stopped' && Boolean(old.checks?.length) && !this.store.record(old);
      // The flag lives on the task, so it survives capacity waits, dependency holds and restarts until used.
      const resumeSession =
        !task.freshSession &&
        !(heldRelease && briefChange && !continuingCheckWait) &&
        oldSession &&
        agentAdapter(profile.cli).canResume &&
        old!.pool === pool.name &&
        old!.profile.cli === profile.cli &&
        old!.profile.model === profile.model
          ? oldSession
          : undefined;
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
          ? this.store.retryStopped(taskId, make, oldConfigDirectory, nextBrief.kind === 'verification')
          : this.store.nextAttempt(
              { taskId, attempt: task.currentAttempt },
              make,
              oldConfigDirectory,
              nextBrief.kind === 'verification',
            );
      this.writeTaskPriority(this.store.task(taskId));
      // Include older groups after a controller crash between superseding and termination.
      for (const previous of this.store
        .attempts(taskId)
        .filter((a) => a.attempt < next.attempt && !a.supersededFinalized)) {
        await terminateProcessGroup(previous.process, this.settings.terminationGraceMs, this.settings.policy?.process);
        for (const process of previous.auxiliaryProcesses)
          await terminateProcessGroup(process, this.settings.terminationGraceMs, this.settings.policy?.process);
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
      if (task.freshSession)
        task = this.store.updateTask({ taskId, attempt: next.attempt }, (current) => {
          delete current.freshSession;
        });
      let setupStep = 'checking worktree leftovers';
      let retryPrepared = false;
      try {
        if (task.brief.kind === 'verification') {
          setupStep = 'preflighting original proof';
          requireOriginalProofProfile(profile);
          if (task.brief.criticalPath) throw new Error('proof requires ordinary Codex routing');
          const missing = preflightProof(task.worktree, task.brief);
          if (missing.length)
            throw new Error(`Proof pending/unavailable: captured inputs missing: ${missing.join(', ')}`);
          task = this.prepareProofWorktree(task, next);
          setupStep = 'installing worktree dependencies';
          installWorktreeDependencies(task.worktree, this.settings);
          if (
            existsSync(join(task.worktree, 'package.json')) &&
            !existsSync(join(task.worktree, 'node_modules/.bin/bun'))
          )
            throw new Error(
              'Proof dependency preparation did not provide node_modules/.bin/bun; no system Bun fallback is allowed',
            );
          // Ordinary shared/pinned preparation is outside SQLite, before any worker can invoke its command.
          if (this.branchHead(this.settings.integrationBranch, false) !== task.brief.proof!.sourceCommit)
            throw new ProofUnavailableError(
              'Proof pending/unavailable: integration source advanced; authenticated fresh registration required',
            );
          this.store.event(next, 'proof-command-ready', {
            sourceCommit: task.brief.proof!.sourceCommit,
            argv: task.brief.acceptance.command,
            cwd: task.worktree,
          });
          const context = captureLaunchContext(this.store, next, boundary, origin);
          retryPrepared = true;
          return await this.launcher(
            this.store,
            task,
            next,
            pool,
            workerPrompt(
              task,
              options.evidence,
              undefined,
              [],
              this.settings.mainCheckout,
              context,
              this.settings.stateDirectory,
              this.settings.policy,
            ),
            this.settings.codex,
            resumeSession,
            this.settings.policy,
          );
        }
        if (task.workspace) {
          if (webModule(task.brief, this.settings) !== task.workspace.module)
            throw new Error('reshape outside a shared module requires a new isolated task');
          const controller = new WorkspaceController(this.settings, this.store);
          return await controller.withLaunch(task.workspace.module, async () => {
            controller.syncIdle(task.workspace!.module, task.id);
            this.prepareSharedFrozen(task);
            task = this.store.task(taskId);
            setupStep = 'installing worktree dependencies';
            if (!dependencyInstallationMatches(task.worktree)) {
              const peer = this.store
                .tasks()
                .find(
                  (candidate) =>
                    candidate.id !== task.id &&
                    candidate.worktree === task.worktree &&
                    this.store
                      .attempts(candidate.id)
                      .some(
                        (attempt) =>
                          ['pending', 'running'].includes(attempt.state) ||
                          (attempt.process !== null && sameProcess(attempt.process)) ||
                          unresolvedCheckIds(candidate, attempt).length > 0,
                      ),
                );
              if (peer)
                throw new Error(
                  `Cannot refresh dependencies in ${task.worktree}: workspace custody held by task ${peer.id}`,
                );
              if (git(task.worktree, ['diff', '--name-only', '--diff-filter=U', '-z']))
                throw new Error(`Cannot refresh dependencies in ${task.worktree}: unresolved workspace paths`);
              installWorktreeDependencies(task.worktree, this.settings);
            }
            const context = captureLaunchContext(this.store, next, boundary, origin);
            const prompt = workerPrompt(
              task,
              options.evidence,
              options.consultation,
              [],
              this.settings.mainCheckout,
              context,
              this.settings.stateDirectory,
              this.settings.policy,
            );
            retryPrepared = true;
            return await this.launcher(
              this.store,
              task,
              next,
              pool,
              prompt,
              this.settings.codex,
              resumeSession,
              this.settings.policy,
            );
          });
        }
        this.commitRetryLeftovers(task, old?.attempt ?? 0);
        setupStep = 'committing frozen acceptance files';
        const frozenBlocks = parseFrozenFiles(task.brief.markdown, task.brief.paths);
        const priorFiles = frozenFiles(task);
        const frozen = commitFrozenFiles(
          task.worktree,
          frozenBlocks,
          this.settings.formatCommand,
          task.base,
          priorFiles,
        );
        task = this.store.updateTask(next, (current) => {
          (current as FrozenTask).frozenFiles = frozen.files.map(({ path, hash }) => ({ path, hash }));
        });
        reportFrozenFormatError(frozen.formatterError);
        setupStep = `rebasing onto current ${this.taskBaseBranch(task.brief)}`;
        const integration = this.taskBaseHead(task.brief);
        const tip = git(task.worktree, ['rev-parse', 'HEAD']);
        const workerCommit = previousConflict?.workerCommit ?? tip;
        const rebaseLog = `${next.logPath}.rebase`;
        mkdirSync(dirname(rebaseLog), { recursive: true });
        let files: string[] = [];
        if (task.base !== integration) {
          const commits = Number(git(task.worktree, ['rev-list', '--count', `${task.base}..${tip}`]));
          if (commits > 0) {
            try {
              // Integration derived files such as bun.lock are regenerated by rebaseOnto before the retry starts.
              rebaseOnto(
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
        if (options.escalation === 'rebase-conflict') {
          const controllerHead = git(task.worktree, ['rev-parse', `${task.branch}^{commit}`]);
          this.store.event(next, 'worker-source-baseline', { workerCommit, controllerHead });
        }
        // Name conflicted files only while a rebase is really in progress here; otherwise the prompt sent the worker to
        // continue a rebase that did not exist (the retry's own rebase onto its base had applied cleanly).
        const rebasing = ['rebase-merge', 'rebase-apply'].some((name) =>
          existsSync(resolve(task.worktree, git(task.worktree, ['rev-parse', '--git-path', name]))),
        );
        if (!files.length)
          files = git(task.worktree, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
        if (!files.length && options.escalation === 'rebase-conflict' && rebasing) files = options.conflictFiles ?? [];
        if (!files.length && !rebasing) {
          setupStep = 'installing worktree dependencies';
          installWorktreeDependencies(task.worktree, this.settings);
        }
        const context = captureLaunchContext(this.store, next, boundary, origin);
        const prompt = workerPrompt(
          task,
          options.evidence,
          options.consultation,
          files,
          this.settings.mainCheckout,
          context,
          this.settings.stateDirectory,
          this.settings.policy,
        );
        retryPrepared = true;
        return await this.launcher(
          this.store,
          task,
          next,
          pool,
          prompt,
          this.settings.codex,
          resumeSession,
          this.settings.policy,
        );
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
            readMeasurement(failed, {
              policy: this.settings.policy ?? defaultPolicy,
              configDirectory: pool.configDirectory,
            }),
            'stopped',
          ),
        );
        this.store.event(next, 'launch-failed', { error: String(error) });
        this.store.updateTask(next, (t) => {
          t.state = 'stopped';
        });
        if (error instanceof ProofCapacityQueuedError) {
          this.store.saveRetryIntent(next, {});
          this.store.event(next, 'proof-capacity-queued', { goal: task.brief.goal });
        } else if (!retryPrepared) {
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
    const lease = acquireDirectoryLeaseWaiting(
      join(this.settings.stateDirectory, 'leases', taskId),
      undefined,
      this.settings.policy?.leases,
    );
    let settlementLease: ReturnType<typeof acquireDirectoryLease> | undefined;
    try {
      let task = this.store.task(taskId);
      const ref = { taskId, attempt: task.currentAttempt };
      if (task.state === 'integrated' || task.state === 'merged' || task.state === 'cancelled')
        throw new Error(`cannot stop ${task.state} task`);
      if (!task.currentAttempt) {
        this.store.updateTask(ref, (t) => {
          t.state = cancelled ? 'cancelled' : 'stopped';
        });
        return;
      }
      const settleLogPath = this.store.attempt(ref).logPath;
      // A worker's exit may wake its follower while cancellation is still reaping descendants.
      settlementLease = acquireDirectoryLeaseWaiting(
        `${settleLogPath}.settle`,
        undefined,
        this.settings.policy?.leases,
      );
      task = this.store.task(taskId);
      if (task.currentAttempt !== ref.attempt || ['integrated', 'merged'].includes(task.state))
        throw new StaleAttemptError(ref, task.currentAttempt);
      const attempt = this.store.attempt(ref);
      const intent = this.store.beginTermination(ref, cancelled ? 'cancel' : 'stop');
      if (intent.state !== 'complete') {
        if (intent.processIdentity === 'unknown')
          throw new Error(
            `${intent.operation} request retained with unknown process identity for task ${taskId} attempt ${ref.attempt}`,
          );
        try {
          const owned = new Map(
            [intent.process, ...intent.auxiliaryProcesses]
              .filter((identity): identity is NonNullable<typeof identity> => identity !== null)
              .map((identity) => [`${identity.pid}:${identity.start}:${identity.boot}:${identity.group}`, identity]),
          );
          for (const process of owned.values())
            await terminateProcessGroup(process, this.settings.terminationGraceMs, this.settings.policy?.process);
          this.store.finishTermination(ref);
        } catch (error) {
          this.store.finishTermination(ref, String(error));
          throw error;
        }
      }
      const pool = this.settings.pools.find((p) => p.name === attempt.pool);
      this.store.closeTerminated(ref, pool ? this.reader(pool) : null, pool?.configDirectory);
    } finally {
      settlementLease?.release();
      lease.release();
    }
  }
  /** Resume the saved stop through the same command path after a controller restart. */
  async resumeTermination(taskId: string): Promise<void> {
    const task = this.store.task(taskId);
    if (!task.currentAttempt) return;
    const ref = { taskId, attempt: task.currentAttempt };
    const intent = this.store.attempt(ref).terminationIntent;
    if (!intent || intent.processIdentity === 'unknown') return;
    if (intent.settledAt) return;
    if (intent.operation === 'cancel') await this.cancel(taskId);
    else await this.stop(taskId);
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
      this.store.notifyCancelledDependency({ taskId, attempt: dependency.currentAttempt }, event, (notice) =>
        inbox.deliver(notice),
      );
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
        "SELECT id FROM worker_tasks WHERE json_extract(body, '$.brief.goal')=? AND json_extract(body, '$.state') != 'cancelled' AND json_extract(body, '$.brief.kind') != 'verification' ORDER BY sequence",
      )
      .all(goal)
      .map((row) => (row as { id: string }).id);
  }
}
