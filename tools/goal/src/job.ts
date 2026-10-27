import { watch, type FSWatcher } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { GateOutcome, GateOutcomeSink, LandingQueue, ManagerInbox, AttemptRef } from './contracts.ts';
import {
  liveGroups,
  readWorkerExit,
  sameProcess,
  stopProcessesUnder,
  terminateProcessGroup,
  waitForProcessGroup,
  waitForWorkerExit,
} from './process.ts';
import { markExhausted } from './usage.ts';
import { StaleAttemptError } from './contracts.ts';
import { acquireDirectoryLease, acquireDirectoryLeaseWaiting, LeaseHeldError, type DirectoryLease } from './lease.ts';
import { classifyFailure } from './failures.ts';
import { evidenceBundle } from './evidence.ts';
import { consult } from './consult.ts';
import { makeRecord, readMeasurement, reportedApproaches, MODEL_AT_CAPACITY } from './records.ts';
import { readRouting } from './routing.ts';
import { settle } from './settle.ts';
import {
  git,
  HeldTaskConflictError,
  TaskHeldForDependenciesError,
  type WorkerTasks,
  type RetryOptions,
} from './tasks.ts';
import type { ManagerEventKind } from './contracts.ts';
import type { Attempt } from './types.ts';
import type { RunningWorker } from './launch.ts';

function rebaseConflictFiles(outcome: GateOutcome): string[] {
  const files = new Set(outcome.conflictedFiles ?? []);
  const details = `${outcome.firstFailure?.assertion ?? ''}\n${outcome.firstFailure?.excerpt ?? ''}`;
  for (const line of details.split(/\r?\n/)) {
    const conflict = line.match(/\bCONFLICT \([^)]+\):\s*(?:Merge conflict in\s+)?(.+)$/);
    if (!conflict) continue;
    const file = conflict[1]!.replace(/\s+(?:deleted|added|modified) in\b.*$/, '').trim();
    if (file) files.add(file);
  }
  if (!files.size) for (const file of outcome.changedFiles) files.add(file);
  return [...files];
}

/** How long a capacity refusal waits before the attempt continues. */
export const CAPACITY_PAUSE_MS = 10_000;

export class WorkerJob implements GateOutcomeSink {
  private readonly pending = new Set<Promise<void>>();
  private readonly retryIntentsInProgress = new Set<string>();
  constructor(
    readonly tasks: WorkerTasks,
    readonly landing: LandingQueue,
    readonly inbox: ManagerInbox,
    readonly consultation: typeof consult = consult,
    readonly afterSettle: () => Promise<void> = async () => {},
  ) {}
  private track(work: Promise<void>): void {
    const handled = work.catch((error) => {
      if (!(error instanceof StaleAttemptError)) throw error;
    });
    this.pending.add(handled);
    // Observe errors immediately while retaining them for drain(). Background work has no caller, and a dropped
    // retry error once left tasks without a worker for hours: the supermanager is told.
    void handled.catch((error) => {
      try {
        this.inbox.deliver({
          managerId: this.tasks.settings.integration.supermanager,
          kind: 'environment',
          summary: `Control-plane background work failed: ${String(error)}`.replace(/[\r\n]+/g, ' ').slice(0, 1000),
        });
      } catch {
        // The error stays with drain() when the inbox is unavailable.
      }
    });
  }
  async drain(): Promise<void> {
    while (this.pending.size) {
      const batch = [...this.pending];
      await Promise.all(batch);
      for (const item of batch) this.pending.delete(item);
    }
  }
  private async runRetryIntent(ref: AttemptRef): Promise<void> {
    const key = `${ref.taskId}:${ref.attempt}`;
    if (this.retryIntentsInProgress.has(key)) return;
    this.retryIntentsInProgress.add(key);
    const store = this.tasks.store;
    try {
      let intent = store.retryIntent(ref);
      if (!intent || intent.status !== 'pending') return;
      let task = store.task(ref.taskId);
      if (task.currentAttempt > ref.attempt) {
        // Another runner already created the follow-up attempt. The intent can
        // remain pending if that process exited between retry() and this update.
        store.updateRetryIntent(ref, (value) => {
          value.status = 'started';
          value.nextAttempt = task.currentAttempt;
        });
        return;
      }
      if (task.currentAttempt !== ref.attempt) return;
      if (!['landing', 'ready'].includes(task.state)) {
        store.updateRetryIntent(ref, (value) => {
          value.status = 'started';
          value.nextAttempt = task.currentAttempt;
        });
        return;
      }
      if (intent.options.escalation === 'repeated-assertion' && !intent.options.consulted) {
        try {
          const evidencePath = intent.options.evidence ?? evidenceBundle(task, store.attempt(ref));
          const answer = await this.consultation(this.tasks, ref, evidencePath);
          intent = store.updateRetryIntent(ref, (value) => {
            value.options.consultation = answer;
            value.options.consulted = true;
          });
          const record = store.record(ref);
          if (record) {
            record.consulted = true;
            store.putRecord(record);
          }
        } catch (error) {
          store.event(ref, 'consultation-unavailable', { error: String(error) });
          intent = store.updateRetryIntent(ref, (value) => {
            value.options.escalation = 'environment';
            value.options.fixRound = store.attempt(ref).fixRound;
          });
        }
      }
      const worker = await this.tasks.retry(task.id, { ...intent.options, expectedAttempt: ref.attempt });
      task = store.task(task.id);
      store.updateRetryIntent(ref, (value) => {
        value.status = 'started';
        value.nextAttempt = task.currentAttempt;
      });
      if (worker) await this.follow(worker);
    } catch (error) {
      // Another process holds the task: the intent stays pending for the next sweep.
      if (error instanceof LeaseHeldError) return;
      if (error instanceof TaskHeldForDependenciesError || error instanceof StaleAttemptError) {
        store.updateRetryIntent(ref, (value) => {
          value.status = 'started';
          value.nextAttempt = store.task(ref.taskId).currentAttempt;
        });
        return;
      }
      throw error;
    } finally {
      this.retryIntentsInProgress.delete(key);
    }
  }
  private async resumeRetryIntents(): Promise<void> {
    for (const intent of this.tasks.store.retryIntents().filter((value) => value.status === 'pending'))
      await this.runRetryIntent({ taskId: intent.taskId, attempt: intent.attempt });
  }
  resumePendingRetries(): void {
    for (const intent of this.tasks.store.retryIntents().filter((value) => value.status === 'pending'))
      this.track(this.runRetryIntent({ taskId: intent.taskId, attempt: intent.attempt }));
  }
  async start(taskId: string, options: RetryOptions = {}): Promise<void> {
    try {
      await this.follow(await this.tasks.retry(taskId, options));
    } catch (error) {
      if (!(error instanceof TaskHeldForDependenciesError)) throw error;
    }
  }
  private async startReleased(taskId: string): Promise<void> {
    try {
      await this.follow(await this.tasks.retryHeld(taskId));
    } catch (error) {
      // Another process is starting it.
      if (error instanceof LeaseHeldError) return;
      if (!(error instanceof HeldTaskConflictError)) throw error;
      const task = this.tasks.store.task(taskId),
        ref = { taskId, attempt: task.currentAttempt };
      const event = {
        managerId: task.brief.manager,
        taskId,
        kind: 'spec-conflict' as const,
        summary: `spec-conflict: refusing to release task because ${error.detail}`,
      };
      if (task.currentAttempt)
        this.tasks.store.updateHeldRetryTask(ref, (current) => {
          current.state = 'stopped';
        });
      else
        this.tasks.store.updateTask(ref, (current) => {
          current.state = 'stopped';
        });
      this.tasks.store.event(ref, 'manager-event', event);
      this.inbox.deliver(event);
    }
  }
  private hasCommit(ref: AttemptRef): boolean {
    const task = this.tasks.store.task(ref.taskId);
    return Number(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`])) > 0;
  }
  async follow(worker: Pick<RunningWorker, 'attempt' | 'exited'>): Promise<void> {
    try {
      await this.followAttempt(worker);
    } catch (error) {
      await this.endAsEnvironment(worker.attempt, error);
    }
  }
  private async followAttempt(worker: Pick<RunningWorker, 'attempt' | 'exited'>): Promise<void> {
    const ref = worker.attempt,
      store = this.tasks.store;
    const task = store.task(ref.taskId);
    const limits = readRouting(this.tasks.settings.routingFile).classes[
      task.taskClass as Exclude<typeof task.taskClass, 'mechanical'>
    ];
    let watcher: FSWatcher | undefined;
    let stopping: Promise<void> | undefined;
    const stopIfStalled = (timeLimit: boolean) => {
      try {
        store.assertCurrent(ref);
        const attempt = store.attempt(ref);
        const pool = this.tasks.settings.pools.find((candidate) => candidate.name === attempt.pool);
        const measurement = readMeasurement(attempt, { configDirectory: pool?.configDirectory });
        const steps = Object.values(measurement.steps).reduce((a, b) => a + b, 0);
        if ((timeLimit || steps > limits.maxSteps) && !this.hasCommit(ref) && !stopping) {
          const evidencePath = evidenceBundle(task, store.attempt(ref));
          const event = {
            managerId: task.brief.manager,
            taskId: task.id,
            kind: 'stalled' as const,
            summary: 'Worker exceeded its class limit without a commit',
            evidencePath,
          };
          store.updateAttempt(ref, (a) => {
            a.escalation = 'stalled';
          });
          store.event(ref, 'manager-event', event);
          this.inbox.deliver(event);
          stopping = this.tasks.stop(task.id);
          void stopping.catch(() => {});
        }
      } catch (error) {
        if (!(error instanceof StaleAttemptError)) {
          stopping = Promise.reject(error);
          void stopping.catch(() => {});
        }
      }
    };
    const timer = setTimeout(
      () => stopIfStalled(true),
      Math.max(0, limits.maxMs - (Date.now() - Date.parse(ref.startedAt))),
    );
    try {
      watcher = watch(ref.logPath, () => stopIfStalled(false));
      try {
        await settle(this.tasks, worker, this.landing, async () => {
          clearTimeout(timer);
          watcher?.close();
          await this.afterSettle();
        });
      } catch (error) {
        if (!stopping || !(error instanceof StaleAttemptError)) throw error;
      }
      if (stopping) await stopping;
    } finally {
      clearTimeout(timer);
      watcher?.close();
    }
    if (!stopping) {
      const fact = store.attempt(ref).failureKind;
      if (fact) this.onAttemptExit(ref);
    }
  }
  private async endAsEnvironment(ref: AttemptRef, error: unknown, leaseHeld = false): Promise<void> {
    if (error instanceof StaleAttemptError) return;
    const lease = leaseHeld
      ? undefined
      : await acquireDirectoryLeaseWaiting(join(this.tasks.settings.stateDirectory, 'leases', ref.taskId));
    try {
      const store = this.tasks.store;
      const current = store.attempt(ref);
      if (!['pending', 'running'].includes(current.state)) return;
      const task = store.task(ref.taskId),
        pool = this.tasks.settings.pools.find((candidate) => candidate.name === current.pool);
      let detail = (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 4000);
      try {
        await terminateProcessGroup(current.process, this.tasks.settings.terminationGraceMs);
        for (const process of current.auxiliaryProcesses)
          await terminateProcessGroup(process, this.tasks.settings.terminationGraceMs);
        await stopProcessesUnder(task.worktree, this.tasks.settings.terminationGraceMs);
      } catch (cleanupError) {
        detail = `${detail}; process cleanup failed: ${String(cleanupError)}`.slice(0, 4000);
      }
      const endedAt = new Date().toISOString();
      const ended = { ...current, endedAt };
      let measurement: ReturnType<typeof readMeasurement>;
      try {
        measurement = readMeasurement(ended, { configDirectory: pool?.configDirectory });
      } catch (measurementError) {
        detail = `${detail}; run log measurement failed: ${String(measurementError)}`.slice(0, 4000);
        measurement = readMeasurement({ ...ended, startedAt: endedAt }, { configDirectory: pool?.configDirectory });
      }
      let after: typeof current.after = null;
      try {
        if (pool) after = this.tasks.reader(pool);
      } catch (readingError) {
        detail = `${detail}; pool reading failed: ${String(readingError)}`.slice(0, 4000);
      }
      store.write(ref, () => {
        const attempt = store.updateAttempt(ref, (value) => {
          value.state = 'exited';
          value.endedAt = endedAt;
          value.exitCode = -1;
          value.after = after;
          value.failureKind = 'tool';
          value.escalation = 'environment';
          value.blocker = detail;
          value.result = measurement.result || `Driver exception: ${detail}`;
          value.approaches.push(...reportedApproaches(value.result));
        });
        const record = makeRecord(task, attempt, measurement, 'stopped');
        record.escalation = 'environment';
        store.putRecord(record);
        store.updateTask(ref, (value) => {
          value.state = 'stopped';
        });
        let evidencePath: string | undefined;
        try {
          evidencePath = evidenceBundle(task, store.attempt(ref));
        } catch {
          /* The failure event still carries the driver error. */
        }
        const event = {
          managerId: task.brief.manager,
          taskId: task.id,
          kind: 'environment' as const,
          summary: `environment: driver exception: ${detail}`.slice(0, 1000),
          ...(evidencePath ? { evidencePath } : {}),
        };
        store.event(ref, 'driver-environment-failure', { detail });
        store.event(ref, 'manager-event', event);
        this.inbox.deliver(event);
      });
    } finally {
      lease?.release();
    }
  }
  /**
   * Settle attempts left behind by a dead driver while holding the same lease used for retries and stops. A lease
   * held elsewhere is skipped, never waited for. Short-lived commands pass `adoptRunning: false`: an orphan whose
   * worker still runs is left to the manager host, which can wait for it without blocking a command.
   */
  /** Release held tasks whose dependencies are met; returns their ids. */
  private releaseMetDependents(): string[] {
    const store = this.tasks.store;
    const tasks = store.tasks();
    const released = tasks
      .filter((candidate) => candidate.state === 'held' && this.tasks.dependenciesMet(candidate, tasks))
      .map((candidate) => candidate.id);
    for (const taskId of released) {
      const candidate = store.task(taskId),
        ref = { taskId, attempt: candidate.currentAttempt };
      if (candidate.state !== 'held') continue;
      if (candidate.currentAttempt)
        store.updateHeldRetryTask(ref, (current) => {
          current.state = 'ready';
        });
      else
        store.updateTask(ref, (current) => {
          current.state = 'ready';
        });
    }
    return released;
  }
  async recoverOrphans(options: { adoptRunning?: boolean } = {}): Promise<void> {
    const adoptRunning = options.adoptRunning ?? true;
    const store = this.tasks.store;
    // A held task released by a train that then ended, or handed off to newer code, has no driver: the host starts
    // it. Commands leave it to the host, so released tasks are not started from every command at once. The host
    // also releases tasks whose dependency reached their branch later, through a stabilize-to-dev merge.
    if (adoptRunning) this.releaseMetDependents();
    const tasks = store.tasks();
    for (const task of !adoptRunning
      ? []
      : tasks.filter(
          (t) =>
            t.state === 'ready' &&
            t.brief.after.length &&
            this.tasks.dependenciesMet(t, tasks) &&
            // A ready task with a pending retry intent is a retry, started from the intent.
            store.retryIntent({ taskId: t.id, attempt: t.currentAttempt })?.status !== 'pending',
        ))
      this.track(
        this.startReleased(task.id).catch((error) => {
          if (store.task(task.id).state === 'ready') throw error;
          // Another process started it first.
        }),
      );
    const stateDirectory = resolve(this.tasks.settings.stateDirectory);
    const ownsRunLog = (logPath: string) => {
      const path = relative(stateDirectory, resolve(logPath));
      return (
        path !== '' &&
        path !== '..' &&
        !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
        !isAbsolute(path)
      );
    };
    const candidates = store
      .attempts()
      .filter(
        (attempt) =>
          ['running', 'exited'].includes(attempt.state) &&
          (!attempt.driver || !sameProcess(attempt.driver)) &&
          ownsRunLog(attempt.logPath),
      );
    // One /proc scan for all candidates: a scan per candidate made every command cost attempts × processes.
    const live = adoptRunning || !candidates.length ? null : liveGroups();
    // Adopted attempts are followed at once: followed in turn, one long-running worker held back every later settle.
    const follows: Promise<void>[] = [];
    for (const candidate of candidates) {
      const ref = { taskId: candidate.taskId, attempt: candidate.attempt };
      if (live && candidate.process && live.has(candidate.process.group)) continue;
      let lease: DirectoryLease;
      try {
        lease = acquireDirectoryLease(join(this.tasks.settings.stateDirectory, 'leases', ref.taskId));
      } catch (error) {
        if (error instanceof LeaseHeldError) continue;
        throw error;
      }
      let followed = false;
      try {
        if (store.task(ref.taskId).currentAttempt !== ref.attempt) continue;
        const attempt = store.attempt(ref);
        if (
          !['running', 'exited'].includes(attempt.state) ||
          (attempt.driver && sameProcess(attempt.driver)) ||
          !ownsRunLog(attempt.logPath)
        )
          continue;
        const events = store
          .events(ref.taskId)
          .filter((event) => event.attempt === ref.attempt)
          .map((event) => event.kind);
        if (events.includes('landing-requested')) continue;
        if (events.includes('driver-environment-failure')) continue;
        if (attempt.state === 'exited' && attempt.failureKind) {
          this.onAttemptExit(ref);
          continue;
        }
        // A command never waits for a worker that may still run: following it would hold the command (a dispatch
        // waited 31 minutes on another Goal's live worker). The host adopts it instead.
        if (!adoptRunning && attempt.state !== 'exited') continue;
        followed = true;
        follows.push(
          (async () => {
            try {
              if (attempt.process) await waitForProcessGroup(attempt.process);
              await this.followAttempt({ attempt, exited: Promise.resolve(readWorkerExit(attempt.logPath)) });
            } catch (error) {
              await this.endAsEnvironment(ref, error, true);
            } finally {
              lease.release();
            }
          })(),
        );
      } finally {
        if (!followed) lease.release();
      }
    }
    await Promise.all(follows);
    // The host keeps sweeping while retried workers run; a command settles its retries before it returns.
    if (adoptRunning) this.resumePendingRetries();
    else await this.resumeRetryIntents();
  }
  reportPromotionEnvironment(taskId: string, failure: NonNullable<GateOutcome['firstFailure']>): void {
    const store = this.tasks.store,
      task = store.task(taskId),
      ref = { taskId, attempt: task.currentAttempt };
    store.write(ref, () => {
      const duplicate = store
        .events(taskId)
        .some(
          (event) =>
            event.kind === 'promotion-environment' && JSON.parse(event.body).fingerprint === failure.fingerprint,
        );
      if (duplicate) return;
      const event = {
        managerId: task.brief.manager,
        taskId,
        kind: 'environment' as const,
        summary: `environment: promotion gate failure also occurs on main: ${failure.assertion}`.replace(
          /[\r\n]+/g,
          ' ',
        ),
        evidencePath: store.attempt(ref).evidencePath,
      };
      store.event(ref, 'promotion-environment', failure);
      store.event(ref, 'manager-event', event);
      this.inbox.deliver(event);
    });
  }
  onPromotionComplete(taskIds: readonly string[], promotionId: string): void {
    const store = this.tasks.store;
    const goals = new Set(taskIds.map((id) => store.task(id).brief.goal));
    for (const goal of goals) {
      const goalTasks = store.tasks().filter((task) => task.brief.goal === goal);
      if (!goalTasks.some((task) => (task.brief.after ?? []).length)) continue;
      if (goalTasks.some((task) => ['ready', 'running', 'landing', 'held', 'integrated'].includes(task.state)))
        continue;
      const terminal = goalTasks.at(-1);
      if (!terminal?.currentAttempt) continue;
      const ref = { taskId: terminal.id, attempt: terminal.currentAttempt };
      store.write(ref, () => {
        const duplicate = store
          .events(terminal.id)
          .some((event) => event.kind === 'promotion-idle' && JSON.parse(event.body).promotionId === promotionId);
        if (duplicate) return;
        const event = {
          managerId: terminal.brief.manager,
          taskId: terminal.id,
          kind: 'goal-idle' as const,
          summary: `Goal ${goal} has no tasks in flight.`,
        };
        store.event(ref, 'promotion-idle', { promotionId, ...event });
        this.inbox.deliver(event);
      });
    }
  }
  /** Launch/exit facts do not fabricate a gate outcome. */
  onAttemptExit(ref: AttemptRef): void {
    const store = this.tasks.store;
    let retry = false,
      capacity = false;
    const queueRetry = (options: RetryOptions) => {
      store.updateTask(ref, (t) => {
        t.state = 'ready';
      });
      store.saveRetryIntent(ref, options);
      retry = true;
    };
    store.write(ref, () => {
      const task = store.task(ref.taskId),
        attempt = store.attempt(ref),
        kind = attempt.failureKind;
      if (!kind) return;
      if (
        store.events(task.id).some((event) => event.attempt === ref.attempt && event.kind === 'attempt-exit-classified')
      ) {
        // A retry decided before the retry intent existed, and lost with its process, is queued again.
        if (task.state === 'running' && task.currentAttempt === ref.attempt && !store.retryIntent(ref))
          queueRetry(this.exitRetryOptions(attempt, attempt.evidencePath));
        return;
      }
      const failureClass = kind === 'tool' ? 'environment' : kind;
      const record = store.record(ref)!;
      record.outcome = 'stopped';
      record.escalation = failureClass;
      store.putRecord(record);
      store.event(ref, 'attempt-exit-classified', { kind: failureClass, detail: attempt.blocker ?? attempt.result });
      store.updateAttempt(ref, (a) => {
        a.escalation = failureClass;
      });
      const evidencePath = evidenceBundle(task, store.attempt(ref));
      if (kind === 'spec-conflict' || kind === 'scope-growth') {
        store.updateTask(ref, (t) => {
          t.state = 'stopped';
        });
        const event = {
          managerId: task.brief.manager,
          taskId: task.id,
          kind,
          summary: `${kind}: ${attempt.blocker ?? attempt.result}`.replace(/[\r\n]+/g, ' '),
          evidencePath,
        };
        store.event(ref, 'manager-event', event);
        this.inbox.deliver(event);
      } else {
        const previous = ref.attempt > 1 ? store.attempt({ taskId: ref.taskId, attempt: ref.attempt - 1 }) : null;
        // A provider capacity refusal is not the task's failure: continue after a pause, however often it repeats.
        capacity = kind === 'tool' && MODEL_AT_CAPACITY.test(`${attempt.result ?? ''}\n${attempt.blocker ?? ''}`);
        if (kind === 'tool' && previous?.failureKind === 'tool' && !capacity) {
          const firstLine = (
            previous.result ||
            previous.blocker ||
            'Worker CLI failed before starting a session'
          ).split(/\r?\n/, 1)[0]!;
          store.updateTask(ref, (t) => {
            t.state = 'stopped';
          });
          store.updateAttempt(ref, (a) => {
            a.escalation = 'stalled';
          });
          record.escalation = 'stalled';
          store.putRecord(record);
          const event = {
            managerId: task.brief.manager,
            taskId: task.id,
            kind: 'stalled' as const,
            summary: `Repeated launch failure: ${firstLine}`.replace(/[\r\n]+/g, ' '),
            evidencePath,
          };
          store.event(ref, 'manager-event', event);
          this.inbox.deliver(event);
          return;
        }
        if (kind === 'pool-exhausted') {
          const key = this.tasks.settings.pools.find((pool) => pool.name === attempt.pool)?.allowanceKey;
          if (key) markExhausted(this.tasks.settings.stateDirectory, key);
        }
        queueRetry(this.exitRetryOptions(attempt, evidencePath));
      }
    });
    // The recovery sweep calls this while it holds the task's lease, which the retry takes: start after it is released.
    if (retry)
      this.track(
        new Promise<void>((done) => (capacity ? setTimeout(done, CAPACITY_PAUSE_MS) : setImmediate(done))).then(() =>
          this.runRetryIntent(ref),
        ),
      );
  }
  private exitRetryOptions(attempt: Attempt, evidencePath: string): RetryOptions {
    const kind = attempt.failureKind!;
    const options: RetryOptions = {
      evidence: evidencePath,
      escalation: kind === 'tool' ? 'environment' : kind,
      fixRound: attempt.fixRound,
    };
    if (kind === 'pool-exhausted') {
      const key = this.tasks.settings.pools.find((pool) => pool.name === attempt.pool)?.allowanceKey;
      options.excludePools = this.tasks.settings.pools
        .filter((pool) => pool.allowanceKey === key)
        .map((pool) => pool.name);
    }
    return options;
  }
  onGateOutcome(outcome: GateOutcome): void {
    const store = this.tasks.store;
    // Stale gate results must be refused to their caller, not silently discarded.
    store.assertCurrent(outcome);
    const task = store.task(outcome.taskId),
      attempt = store.attempt(outcome);
    const record = store.record(outcome);
    if (!record) throw new Error('attempt must be settled before gate outcomes');
    let action: (() => Promise<void>) | undefined;
    let released: string[] = [];
    store.write(outcome, () => {
      const duplicate = store
        .events(task.id)
        .some(
          (e) =>
            e.attempt === outcome.attempt && e.kind === 'gate-outcome' && JSON.parse(e.body).stage === outcome.stage,
        );
      if (duplicate) {
        if (!outcome.passed && outcome.stage === 'gate' && store.retryIntent(outcome)?.status === 'pending')
          action = async () => this.runRetryIntent(outcome);
        return;
      }
      store.event(outcome, 'gate-outcome', outcome);
      record.diffLines = outcome.diffLines;
      record.changedFiles = [...outcome.changedFiles];
      record.hostMs = (record.hostMs ?? 0) + outcome.hostMs;
      record.firstFailure = outcome.firstFailure?.fingerprint ?? null;
      record.outcome = outcome.passed ? 'passed' : 'gate-failed';
      if (outcome.passed) {
        if (outcome.mergedCommit) {
          const plan = store.integrationPlan(outcome);
          let alreadyOnMain = false;
          try {
            git(this.tasks.settings.mainCheckout, [
              'merge-base',
              '--is-ancestor',
              outcome.mergedCommit,
              `refs/heads/${this.tasks.settings.mainBranch}`,
            ]);
            alreadyOnMain = true;
          } catch {}
          store.updateTask(outcome, (t) => {
            t.state = alreadyOnMain ? 'merged' : 'integrated';
            t.integratedCommit = outcome.mergedCommit!;
            if (alreadyOnMain) t.mergedCommit = outcome.mergedCommit!;
            if (plan) {
              t.integratedBase = plan.base;
              t.integratedCommits = plan.commits;
            }
          });
          if (plan) store.clearIntegrationPlan(outcome);
          released = this.releaseMetDependents();
          // A manager waits for research to decide its next contract; an integration does not otherwise wake it.
          if (task.brief.kind === 'research') {
            const reports = (outcome.changedFiles ?? []).filter((path) => path.startsWith('docs/research/'));
            const event = {
              managerId: task.brief.manager,
              taskId: task.id,
              kind: 'instruction' as const,
              summary: `Research task ${task.id} integrated as ${outcome.mergedCommit}: ${reports.join(', ') || 'its report'}. Adopt its findings into the owning document and the waiting contracts.`,
            };
            store.event(outcome, 'research-integrated', event);
            this.inbox.deliver(event);
          }
          const goalTasks = store.tasks().filter((candidate) => candidate.brief.goal === task.brief.goal);
          const goalInFlight = goalTasks.some((candidate) =>
            ['ready', 'running', 'landing', 'held', 'integrated'].includes(candidate.state),
          );
          const goalHasDependencies = goalTasks.some((candidate) => (candidate.brief.after ?? []).length > 0);
          if (goalHasDependencies && !goalInFlight) {
            const event = {
              managerId: task.brief.manager,
              taskId: task.id,
              kind: 'goal-idle' as const,
              summary: `Goal ${task.brief.goal} has no tasks in flight.`,
            };
            store.event(outcome, 'goal-idle', event);
            this.inbox.deliver(event);
          }
        }
        store.putRecord(record);
        return;
      }
      if (outcome.stage === 'rebase') {
        store.updateAttempt(outcome, (a) => {
          a.failure = outcome.firstFailure ?? null;
          a.failureCommand = outcome.failedCommand ? [...outcome.failedCommand] : null;
          a.failureOnBase = outcome.failsOnMain ?? null;
          a.failureLogPath = outcome.logPath;
          a.approaches.push({
            approach: `Attempt ${a.attempt}: ${a.profile.model}/${a.profile.effort}`,
            result: outcome.firstFailure
              ? `${outcome.firstFailure.assertion}: ${outcome.firstFailure.excerpt}`
              : 'Failed at rebase',
          });
        });
        const evidencePath = evidenceBundle(task, store.attempt(outcome));
        const files = rebaseConflictFiles(outcome);
        if (attempt.escalation === 'rebase-conflict') {
          record.escalation = 'spec-conflict';
          store.updateAttempt(outcome, (a) => {
            a.escalation = 'spec-conflict';
          });
          store.updateTask(outcome, (t) => {
            t.state = 'stopped';
          });
          const detail = files.length
            ? `conflicted files: ${files.join(', ')}`
            : (outcome.firstFailure?.assertion ?? 'conflict with the current integration branch');
          const event = {
            managerId: task.brief.manager,
            taskId: task.id,
            kind: 'spec-conflict' as const,
            summary: `spec-conflict: repeated rebase conflict; ${detail}`.replace(/[\r\n]+/g, ' '),
            evidencePath,
          };
          store.event(outcome, 'manager-event', event);
          this.inbox.deliver(event);
        } else {
          record.escalation = 'rebase-conflict';
          store.updateAttempt(outcome, (a) => {
            a.escalation = 'rebase-conflict';
          });
          const options: RetryOptions = {
            evidence: evidencePath,
            escalation: 'rebase-conflict',
            fixRound: attempt.fixRound,
            conflictFiles: files,
          };
          action = async () => {
            store.assertCurrent(outcome);
            await this.start(task.id, options);
          };
        }
        store.putRecord(record);
        return;
      }
      const limits = readRouting(this.tasks.settings.routingFile).classes[
        task.taskClass as Exclude<typeof task.taskClass, 'mechanical'>
      ];
      const failureClass = classifyFailure(outcome, task, attempt, record, limits, this.hasCommit(outcome));
      record.escalation = failureClass;
      record.earlyStop = !attempt.blocker || /RESULT:\s*success/i.test(attempt.result);
      store.updateAttempt(outcome, (a) => {
        a.failure = outcome.firstFailure ?? null;
        a.failureCommand = outcome.failedCommand ? [...outcome.failedCommand] : null;
        a.failureOnBase = outcome.failsOnMain ?? null;
        a.failureLogPath = outcome.logPath;
        a.escalation = failureClass;
        a.approaches.push({
          approach: `Attempt ${a.attempt}: ${a.profile.model}/${a.profile.effort}`,
          result: outcome.firstFailure
            ? `${outcome.firstFailure.assertion}: ${outcome.firstFailure.excerpt}`
            : `Failed at ${outcome.stage}`,
        });
      });
      const evidencePath = evidenceBundle(task, store.attempt(outcome));
      const automatic = ['environment', 'pool-exhausted', 'repeated-assertion', 'new-failure', 'early-stop'].includes(
        failureClass,
      );
      if (!automatic) {
        store.updateTask(outcome, (t) => {
          t.state = 'stopped';
        });
        const event = {
          managerId: task.brief.manager,
          taskId: task.id,
          kind: failureClass as ManagerEventKind,
          summary: `${failureClass}: ${outcome.firstFailure?.assertion ?? outcome.stage}`.replace(/[\r\n]+/g, ' '),
          evidencePath,
        };
        store.event(outcome, 'manager-event', event);
        this.inbox.deliver(event);
      } else {
        const previous = outcome.attempt > 1 ? store.attempt({ taskId: task.id, attempt: outcome.attempt - 1 }) : null;
        const previousRecord = previous ? store.record({ taskId: task.id, attempt: previous.attempt }) : null;
        if (
          failureClass === 'environment' &&
          outcome.firstFailure?.fingerprint &&
          previous?.escalation === 'environment' &&
          previousRecord?.firstFailure === outcome.firstFailure.fingerprint
        ) {
          record.escalation = 'stalled';
          store.putRecord(record);
          store.updateTask(outcome, (t) => {
            t.state = 'stopped';
          });
          store.updateAttempt(outcome, (a) => {
            a.escalation = 'stalled';
          });
          const event = {
            managerId: task.brief.manager,
            taskId: task.id,
            kind: 'stalled' as const,
            summary: `Repeated environment failure: ${outcome.firstFailure.assertion}`.replace(/[\r\n]+/g, ' '),
            evidencePath,
          };
          store.event(outcome, 'manager-event', event);
          this.inbox.deliver(event);
          return;
        }
        const options: RetryOptions = {
          evidence: evidencePath,
          escalation: failureClass,
          fixRound: attempt.fixRound + (['environment', 'pool-exhausted'].includes(failureClass) ? 0 : 1),
        };
        if (failureClass === 'pool-exhausted') {
          const key = this.tasks.settings.pools.find((p) => p.name === attempt.pool)?.allowanceKey;
          options.excludePools = this.tasks.settings.pools.filter((p) => p.allowanceKey === key).map((p) => p.name);
        }
        if (outcome.stage === 'gate') {
          store.updateTask(outcome, (current) => {
            current.state = 'ready';
          });
          store.saveRetryIntent(outcome, options);
          action = async () => this.runRetryIntent(outcome);
          store.putRecord(record);
          return;
        }
        action = async () => {
          store.assertCurrent(outcome);
          if (failureClass === 'repeated-assertion') {
            try {
              options.consultation = await this.consultation(this.tasks, outcome, evidencePath);
              options.consulted = true;
              record.consulted = true;
              store.putRecord(record);
            } catch (error) {
              store.assertCurrent(outcome);
              // A failed consultation transport is a tool event, so it does not wake a manager.
              store.event(outcome, 'consultation-unavailable', { error: String(error) });
              options.escalation = 'environment';
              options.fixRound = attempt.fixRound;
              options.consulted = store.attempt(outcome).consulted;
            }
          }
          await this.start(task.id, options);
        };
      }
      store.putRecord(record);
    });
    for (const taskId of released) this.track(this.startReleased(taskId));
    if (action) this.track(action());
  }
  /** Reattach to a persisted running attempt after a controller restart using a kernel exit notification. */
  async recover(taskId: string): Promise<void> {
    const task = this.tasks.store.task(taskId);
    const ref = { taskId, attempt: task.currentAttempt };
    this.tasks.store.assertCurrent(ref);
    if (
      this.tasks.store
        .events(taskId)
        .some((event) => event.attempt === ref.attempt && event.kind === 'landing-requested')
    ) {
      await this.afterSettle();
      return;
    }
    const attempt = this.tasks.store.attempt(ref);
    if (!['running', 'exited'].includes(attempt.state))
      throw new Error('only a running or exited attempt can be recovered');
    await this.follow({ attempt, exited: waitForWorkerExit(attempt.process, attempt.logPath) });
  }
  async consultTask(taskId: string): Promise<void> {
    const task = this.tasks.store.task(taskId),
      ref = { taskId, attempt: task.currentAttempt };
    this.tasks.store.assertCurrent(ref);
    const path = evidenceBundle(task, this.tasks.store.attempt(ref));
    const answer = await this.consultation(this.tasks, ref, path);
    await this.start(taskId, { evidence: path, consultation: answer, consulted: true, escalation: 'consultation' });
  }
}
