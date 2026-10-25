import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { acquireDirectoryLease } from './lease.ts';
import { classifyTask, readRouting, routeTask } from './routing.ts';
import { choosePool } from './allowance.ts';
import { readPool, type PoolReader } from './usage.ts';
import { launch, workerPrompt, type RunningWorker } from './launch.ts';
import { terminateProcessGroup } from './process.ts';
import { readMeasurement, makeRecord } from './records.ts';
import type { WorkerStore } from './store.ts';
import type { Attempt, Profile, Settings, Task } from './types.ts';

export function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
  return result.stdout.trimEnd();
}
export type RetryOptions = { profile?: Profile; fixRound?: number; consulted?: boolean; escalation?: string; evidence?: string; consultation?: string; excludePools?: string[] };
export class WorkerTasks {
  constructor(readonly settings: Settings, readonly store: WorkerStore, readonly reader: PoolReader = readPool,
    readonly launcher: typeof launch = launch) {}
  dispatch(briefFile: string): Task {
    const markdown = readFileSync(briefFile, 'utf8');
    const brief = parseBrief(markdown, readRiskOwnership(this.settings.riskAreasFile));
    const taskClass = classifyTask(brief);
    if (taskClass === 'mechanical') throw new Error('run mechanical commands directly without a worker');
    const existingTasks = this.store.tasks();
    const known = new Set(existingTasks.map(task => task.id));
    for (const dependency of brief.after) if (!known.has(dependency)) throw new Error(`unknown dependency task: ${dependency}`);
    const id = crypto.randomUUID();
    const branch = `${this.settings.branchPrefix}${id}`;
    const worktree = join(this.settings.worktreeRoot, id);
    const briefPath = join(this.settings.stateDirectory, 'briefs', `${id}.md`);
    const lease = acquireDirectoryLease(join(this.settings.stateDirectory, 'leases', 'dispatch'));
    try {
      const base = git(this.settings.mainCheckout, ['rev-parse', '--verify', this.settings.mainBranch]);
      mkdirSync(dirname(worktree), { recursive: true });
      mkdirSync(dirname(briefPath), { recursive: true });
      writeFileSync(briefPath, markdown, { flag: 'wx' });
      git(this.settings.mainCheckout, ['worktree', 'add', '-b', branch, worktree, this.settings.mainBranch]);
      return this.store.createTask(brief, { branch, worktree, briefPath, base }, taskClass, id);
    } finally { lease.release(); }
  }
  async retry(taskId: string, options: RetryOptions = {}): Promise<RunningWorker> {
    const lease = acquireDirectoryLease(join(this.settings.stateDirectory, 'leases', taskId));
    try {
      const task = this.store.task(taskId);
      if (!task.branch || !task.base || !task.brief.acceptance.command.length) throw new Error('Imported attempts need a dispatchable contract before retry');
      if (!['ready', 'running', 'landing', 'stopped'].includes(task.state)) throw new Error(`cannot retry ${task.state} task`);
      const old = task.currentAttempt ? this.store.attempt({ taskId, attempt: task.currentAttempt }) : null;
      const oldConfigDirectory = old ? this.settings.pools.find(candidate => candidate.name === old.pool)?.configDirectory : undefined;
      const route = old ? { profile: old.profile, tableVersion: old.tableVersion, experiment: old.experiment }
        : routeTask(task.brief, task.sequence, readRouting(this.settings.routingFile));
      const profile = options.profile ?? route.profile;
      const readings = this.settings.pools.map(pool => this.reader(pool));
      const history = this.store.attempts().flatMap(a => [a.before, a.after]).filter(r => r !== null);
      const pool = choosePool(profile, this.settings.pools, readings, { history, ...(old ? { preferred: old.pool } : {}),
        ...(options.excludePools ? { exclude: options.excludePools } : {}) });
      const make = (n: number): Attempt => ({
        taskId, attempt: n, state: 'pending', profile, pool: pool.name, tableVersion: route.tableVersion, experiment: route.experiment,
        startedAt: new Date().toISOString(), endedAt: null, process: null,
        logPath: join(this.settings.stateDirectory, 'runs', taskId, `${n}.jsonl`),
        evidencePath: join(this.settings.stateDirectory, 'evidence', taskId, String(n)),
        auxiliaryProcesses: [], session: null, fixRound: options.fixRound ?? old?.fixRound ?? 0, consulted: options.consulted ?? old?.consulted ?? false,
        previousFailure: ['environment', 'pool-exhausted'].includes(options.escalation ?? '') ? old?.previousFailure ?? null
          : old?.failure?.fingerprint ?? old?.previousFailure ?? null, failure: null,
        escalation: options.escalation ?? null, before: readings.find(r => r.pool === pool.name) ?? null, after: null,
        exitCode: null, result: '', blocker: null, approaches: old?.approaches ?? [],
      });
      const next = task.state === 'stopped' && task.currentAttempt > 0 ? this.store.retryStopped(taskId, make, oldConfigDirectory)
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
      try { return await this.launcher(this.store, this.store.task(taskId), next, pool, workerPrompt(task, options.evidence, options.consultation), this.settings.codex); }
      catch (error) {
        const failed = this.store.updateAttempt(next, a => {
          a.state = 'exited'; a.endedAt = new Date().toISOString(); a.result = String(error); a.exitCode = -1; a.failureKind = 'tool'; a.after = this.reader(pool);
        });
        this.store.putRecord(makeRecord(this.store.task(taskId), failed, readMeasurement(failed, { configDirectory: pool.configDirectory }), 'stopped'));
        this.store.event(next, 'launch-failed', { error: String(error) });
        this.store.updateTask(next, t => { t.state = 'stopped'; });
        throw error;
      }
    } finally { lease.release(); }
  }
  async stop(taskId: string, cancelled = false): Promise<void> {
    const lease = acquireDirectoryLease(join(this.settings.stateDirectory, 'leases', taskId));
    try {
      const task = this.store.task(taskId);
      const ref = { taskId, attempt: task.currentAttempt };
      if (task.state === 'merged' || task.state === 'cancelled') throw new Error(`cannot stop ${task.state} task`);
      if (!task.currentAttempt) { this.store.updateTask(ref, t => { t.state = cancelled ? 'cancelled' : 'stopped'; }); return; }
      const attempt = this.store.attempt(ref);
      this.store.write(ref, () => {
        if (this.store.task(taskId).state === 'merged') throw new Error('cannot stop merged task');
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
}
