import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { acquireDirectoryLeaseWaiting } from './lease.ts';
import { classifyTask, readRouting, routeTask } from './routing.ts';
import { choosePool } from './allowance.ts';
import { readPool, type PoolReader } from './usage.ts';
import { launch, workerPrompt, type RunningWorker } from './launch.ts';
import { rebaseOnto } from './merge-train.ts';
import { terminateProcessGroup } from './process.ts';
import { readMeasurement, makeRecord } from './records.ts';
import { SqliteManagerInbox } from './inbox.ts';
import type { WorkerStore } from './store.ts';
import type { Attempt, Profile, Settings, Task } from './types.ts';

export function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
  return result.stdout.trimEnd();
}
function installWorktreeDependencies(worktree: string): void {
  if (!existsSync(join(worktree, 'package.json'))) return;
  const result = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: worktree, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Dependency install failed in ${worktree}: ${result.stderr || result.error?.message || `bun exited ${result.status}`}`);
  const manifest = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as { workspaces?: string[] | { packages?: string[] } };
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
  for (const pattern of patterns) {
    const wildcard = pattern.indexOf('*');
    const parent = wildcard < 0 ? pattern : pattern.slice(0, wildcard).replace(/\/$/, '');
    const candidates = wildcard < 0 ? [parent] : readdirSync(join(worktree, parent)).map(name => join(parent, name));
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
export type RetryOptions = { brief?: string; profile?: Profile; fixRound?: number; consulted?: boolean; escalation?: string; evidence?: string; consultation?: string; excludePools?: string[]; conflictFiles?: string[] };
export class HeldTaskConflictError extends Error {
  constructor(readonly detail: string) { super(detail); this.name = 'HeldTaskConflictError'; }
}
export class TaskHeldForDependenciesError extends Error {
  constructor() { super('task held until its dependencies merge'); this.name = 'TaskHeldForDependenciesError'; }
}
export class WorkerTasks {
  constructor(readonly settings: Settings, readonly store: WorkerStore, readonly reader: PoolReader = readPool,
    readonly launcher: typeof launch = launch) {}
  private integrationHead(): string {
    const reference = `refs/heads/${this.settings.integrationBranch}`;
    try { return git(this.settings.mainCheckout, ['rev-parse', '--verify', reference]); }
    catch {
      const main = git(this.settings.mainCheckout, ['rev-parse', '--verify', `refs/heads/${this.settings.mainBranch}`]);
      try { git(this.settings.mainCheckout, ['branch', '--', this.settings.integrationBranch, main]); }
      catch (error) {
        try { return git(this.settings.mainCheckout, ['rev-parse', '--verify', reference]); }
        catch { throw error; }
      }
      return main;
    }
  }
  private commitRetryLeftovers(task: Task, attempt: number): void {
    const branch = git(task.worktree, ['branch', '--show-current']);
    if (branch !== task.branch) throw new Error(`retry setup branch check failed: found ${branch || 'detached HEAD'}, expected ${task.branch}`);
    if (!git(task.worktree, ['status', '--porcelain', '--untracked-files=all'])) return;
    git(task.worktree, ['add', '-A']);
    git(task.worktree, ['commit', '-m', `wip: leftovers from attempt ${attempt}`]);
  }
  private validateBrief(briefFile: string, excludingTask?: string): { brief: ReturnType<typeof parseBrief>; taskClass: Task['taskClass'] } {
    const markdown = readFileSync(briefFile, 'utf8');
    const brief = parseBrief(markdown, readRiskOwnership(this.settings.riskAreasFile));
    const taskClass = classifyTask(brief);
    if (taskClass === 'mechanical') throw new Error('run mechanical commands directly without a worker');
    const existingTasks = this.store.tasks().filter(task => task.id !== excludingTask);
    const known = new Set(existingTasks.map(task => task.id));
    for (const dependency of brief.after) if (!known.has(dependency)) throw new Error(`unknown dependency task: ${dependency}`);
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
      const base = this.integrationHead();
      mkdirSync(dirname(worktree), { recursive: true });
      mkdirSync(dirname(briefPath), { recursive: true });
      writeFileSync(briefPath, brief.markdown, { flag: 'wx' });
      git(this.settings.mainCheckout, ['worktree', 'add', '-b', branch, worktree, base]);
      installWorktreeDependencies(worktree);
      return this.store.createTask(brief, { branch, worktree, briefPath, base }, taskClass, id);
    } finally { lease.release(); }
  }
  async retry(taskId: string, options: RetryOptions = {}): Promise<RunningWorker> {
    const worker = await this.retryTask(taskId, options);
    if (!worker) throw new TaskHeldForDependenciesError();
    return worker;
  }
  async retryHeld(taskId: string): Promise<RunningWorker> {
    let task = this.store.task(taskId);
    if (task.state !== 'ready' || !task.brief.after.length) throw new Error('only a released held task can be started');
    this.commitRetryLeftovers(task, task.currentAttempt);
    const integration = this.integrationHead();
    const commits = Number(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`]));
    const branch = git(task.worktree, ['branch', '--show-current']);
    if (branch !== task.branch) throw new Error(`held task worktree is on ${branch || 'detached HEAD'}, expected ${task.branch}`);
    if (commits > 0) {
      const common = git(task.worktree, ['merge-base', task.base, integration]);
      if (common !== task.base) throw new HeldTaskConflictError('held task base is not an ancestor of the current integration branch');
      const currentAttempt = task.currentAttempt ? this.store.attempt({ taskId, attempt: task.currentAttempt }) : null;
      const logPath = currentAttempt?.logPath ?? join(this.settings.stateDirectory, 'runs', taskId, 'release-rebase.log');
      mkdirSync(dirname(logPath), { recursive: true });
      try { rebaseOnto(task.worktree, integration, task.base, `${logPath}.rebase`); }
      catch (error) {
        const conflicts = git(task.worktree, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
        if (!conflicts.length) throw error;
        git(task.worktree, ['rebase', '--abort']);
        const worker = await this.retryTask(taskId, { escalation: 'rebase-conflict', conflictFiles: conflicts });
        if (!worker) throw new Error('released task was unexpectedly held again');
        return worker;
      }
    } else git(task.worktree, ['reset', '--hard', integration]);
    if (task.currentAttempt) {
      task = this.store.updateHeldRetryTask({ taskId, attempt: task.currentAttempt }, current => { current.base = integration; });
    } else {
      task = this.store.updateTask({ taskId, attempt: 0 }, current => { current.base = integration; });
    }
    installWorktreeDependencies(task.worktree);
    const worker = await this.retryTask(taskId, {});
    if (!worker) throw new Error('released task was unexpectedly held again');
    return worker;

  }
  private async retryTask(taskId: string, options: RetryOptions): Promise<RunningWorker | null> {
    const lease = acquireDirectoryLeaseWaiting(join(this.settings.stateDirectory, 'leases', taskId));
    try {
      let task = this.store.task(taskId);
      if (!task.branch || !task.base) throw new Error('Imported attempts need a dispatchable contract before retry');
      if (!['ready', 'running', 'landing', 'stopped', 'held'].includes(task.state)) throw new Error(`cannot retry ${task.state} task`);
      const reshaped = options.brief === undefined ? undefined : this.validateBrief(options.brief, taskId);
      if (reshaped && (reshaped.brief.goal !== task.brief.goal || reshaped.brief.manager !== task.brief.manager))
        throw new Error('a reshaped brief must keep the same goal and manager');
      const nextBrief = reshaped?.brief ?? task.brief;
      const nextTaskClass = reshaped?.taskClass ?? task.taskClass;
      if (!nextBrief.acceptance.command.length) throw new Error('Imported attempts need a dispatchable contract before retry');
      const byId = new Map(this.store.tasks().map(candidate => [candidate.id, candidate]));
      if (reshaped && nextBrief.after.some(id => !['integrated', 'merged'].includes(byId.get(id)?.state ?? ''))) {
        const briefPath = join(this.settings.stateDirectory, 'briefs', `${taskId}-held-${crypto.randomUUID()}.md`);
        mkdirSync(dirname(briefPath), { recursive: true });
        writeFileSync(briefPath, nextBrief.markdown, { flag: 'wx' });
        this.store.updateHeldRetryTask({ taskId, attempt: task.currentAttempt }, current => {
          current.brief = nextBrief; current.briefPath = briefPath; current.taskClass = nextTaskClass; current.state = 'held';
        });
        return null;
      }
      const old = task.currentAttempt ? this.store.attempt({ taskId, attempt: task.currentAttempt }) : null;
      const oldConfigDirectory = old ? this.settings.pools.find(candidate => candidate.name === old.pool)?.configDirectory : undefined;
      const route = old ? { profile: old.profile, tableVersion: old.tableVersion, experiment: old.experiment }
        : routeTask(nextBrief, task.sequence, readRouting(this.settings.routingFile));
      const profile = options.profile ?? route.profile;
      const readings = this.settings.pools.map(pool => this.reader(pool));
      const history = this.store.attempts().flatMap(a => [a.before, a.after]).filter(r => r !== null);
      const pool = choosePool(profile, this.settings.pools, readings, { history, ...(old ? { preferred: old.pool } : {}),
        ...(options.excludePools ? { exclude: options.excludePools } : {}) });
      const make = (n: number): Attempt => ({
        taskId, attempt: n, state: 'pending', profile, pool: pool.name, tableVersion: route.tableVersion, experiment: route.experiment,
        startedAt: new Date().toISOString(), endedAt: null, process: null, driver: null,
        logPath: join(this.settings.stateDirectory, 'runs', taskId, `${n}.jsonl`),
        evidencePath: join(this.settings.stateDirectory, 'evidence', taskId, String(n)),
        auxiliaryProcesses: [], session: null, fixRound: options.fixRound ?? old?.fixRound ?? 0, consulted: options.consulted ?? old?.consulted ?? false,
        previousFailure: ['environment', 'pool-exhausted'].includes(options.escalation ?? '') ? old?.previousFailure ?? null
          : old?.failure?.fingerprint ?? old?.previousFailure ?? null, failure: null,
        escalation: options.escalation ?? null, before: readings.find(r => r.pool === pool.name) ?? null, after: null,
        exitCode: null, result: '', blocker: null, approaches: old?.approaches ?? [],
      });
      const next = task.currentAttempt > 0 && this.store.attempt({ taskId, attempt: task.currentAttempt }).state === 'stopped'
        ? this.store.retryStopped(taskId, make, oldConfigDirectory)
        : this.store.nextAttempt({ taskId, attempt: task.currentAttempt }, make, oldConfigDirectory);
      // Include older groups after a controller crash between superseding and termination.
      for (const previous of this.store.attempts(taskId).filter(a => a.attempt < next.attempt && !a.supersededFinalized)) {
        await terminateProcessGroup(previous.process, this.settings.terminationGraceMs);
        for (const process of previous.auxiliaryProcesses) await terminateProcessGroup(process, this.settings.terminationGraceMs);
      }
      this.store.assertCurrent(next);
      this.store.finalizeSuperseded(next, previous => {
        const previousPool = this.settings.pools.find(p => p.name === previous.pool);
        return previousPool ? this.reader(previousPool) : null;
      }, previous => this.settings.pools.find(p => p.name === previous.pool)?.configDirectory);
      if (reshaped) {
        const briefPath = join(this.settings.stateDirectory, 'briefs', `${taskId}-${next.attempt}.md`);
        mkdirSync(dirname(briefPath), { recursive: true });
        writeFileSync(briefPath, reshaped.brief.markdown, { flag: 'wx' });
        task = this.store.updateTask({ taskId, attempt: next.attempt }, current => {
          current.brief = reshaped.brief; current.briefPath = briefPath; current.taskClass = nextTaskClass;
        });
      } else task = this.store.task(taskId);
      let setupStep = 'checking worktree leftovers';
      let retryPrepared = false;
      try {
        this.commitRetryLeftovers(task, old?.attempt ?? 0);
        setupStep = 'rebasing onto current dev';
        const integration = this.integrationHead();
        const tip = git(task.worktree, ['rev-parse', 'HEAD']);
        const rebaseLog = `${next.logPath}.rebase`;
        mkdirSync(dirname(rebaseLog), { recursive: true });
        let files: string[] = [];
        let changedBase = false;
        if (task.base !== integration) {
          changedBase = true;
          const commits = Number(git(task.worktree, ['rev-list', '--count', `${task.base}..${tip}`]));
          if (commits > 0) {
            try { rebaseOnto(task.worktree, integration, task.base, rebaseLog); }
            catch (error) {
              files = git(task.worktree, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
              if (!files.length) throw error;
            }
          } else git(task.worktree, ['reset', '--hard', integration]);
        }
        task = this.store.updateTask(next, current => { current.base = integration; });
        if (!files.length && (changedBase || options.escalation === 'rebase-conflict')) {
          setupStep = 'installing worktree dependencies';
          installWorktreeDependencies(task.worktree);
        }
        if (!files.length && options.escalation === 'rebase-conflict') files = options.conflictFiles ?? [];
        const prompt = workerPrompt(task, options.evidence, options.consultation, files, this.settings.mainCheckout);
        retryPrepared = true;
        return await this.launcher(this.store, task, next, pool, prompt, this.settings.codex);
      }
      catch (error) {
        const failed = this.store.updateAttempt(next, a => {
          a.state = 'exited'; a.endedAt = new Date().toISOString(); a.result = String(error); a.exitCode = -1; a.failureKind = 'tool'; a.after = this.reader(pool);
        });
        this.store.putRecord(makeRecord(this.store.task(taskId), failed, readMeasurement(failed, { configDirectory: pool.configDirectory }), 'stopped'));
        this.store.event(next, 'launch-failed', { error: String(error) });
        this.store.updateTask(next, t => { t.state = 'stopped'; });
        if (!retryPrepared) {
          const detail = String(error).replace(/[\r\n]+/g, ' ').slice(0, 800);
          const event = { managerId: this.store.task(taskId).brief.manager, taskId, kind: 'environment' as const,
            summary: `environment: retry setup failed during ${setupStep}: ${detail}`.slice(0, 1000) };
          new SqliteManagerInbox(this.store.db, this.settings.integration.inboxDirectory).deliver(event);
        }
        throw error;
      }
    } finally { lease.release(); }
  }
  async stop(taskId: string, cancelled = false): Promise<void> {
    const lease = acquireDirectoryLeaseWaiting(join(this.settings.stateDirectory, 'leases', taskId));
    try {
      const task = this.store.task(taskId);
      const ref = { taskId, attempt: task.currentAttempt };
      if (task.state === 'integrated' || task.state === 'merged' || task.state === 'cancelled') throw new Error(`cannot stop ${task.state} task`);
      if (!task.currentAttempt) { this.store.updateTask(ref, t => { t.state = cancelled ? 'cancelled' : 'stopped'; }); return; }
      const attempt = this.store.attempt(ref);
      if (attempt.state === 'stopped') {
        if (cancelled) this.store.cancelStopped(ref);
        return;
      }
      this.store.write(ref, () => {
        if (['integrated', 'merged'].includes(this.store.task(taskId).state)) throw new Error('cannot stop integrated task');
        if (attempt.state !== 'stopped' && attempt.state !== 'cancelled') {
          const pool = this.settings.pools.find(p => p.name === attempt.pool);
          const ended = this.store.updateAttempt(ref, a => { a.endedAt = new Date().toISOString(); a.after = pool ? this.reader(pool) : null; });
          this.store.putRecord(makeRecord(task, ended, readMeasurement(ended, { configDirectory: pool?.configDirectory }), cancelled ? 'cancelled' : 'stopped'));
          this.store.event(ref, cancelled ? 'cancelled' : 'stopped', {});
          this.store.close(ref, cancelled ? 'cancelled' : 'stopped');
        }
      });
      await terminateProcessGroup(attempt.process, this.settings.terminationGraceMs);
      for (const process of attempt.auxiliaryProcesses) await terminateProcessGroup(process, this.settings.terminationGraceMs);
    } finally { lease.release(); }
  }
  async cancel(taskId: string): Promise<void> { return this.stop(taskId, true); }
  completionScope(goal: string): string[] {
    return this.store.tasks().filter(task => task.brief.goal === goal && task.state !== 'cancelled').map(task => task.id);
  }
}
