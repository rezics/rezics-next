import defaults from '../defaults.json';
import { defaultPolicy } from './policy.ts';
import {
  ProofCapacityQueuedError,
  ProofUnavailableError,
  readReservationObservation,
  readProofObservation,
  refreshHistoricalProofAdmission,
} from './verification.ts';
import { taskCommits } from './workspace.ts';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { watchOrPoll, type Watching } from './watch-or-poll.ts';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { observeWorkerChecks } from './worker-check-observation.ts';
import type {
  DevLandingTranspileHandoff,
  GateOutcome,
  GateOutcomeSink,
  LandingQueue,
  ManagerInbox,
  AttemptRef,
} from './contracts.ts';
import { recordFlow } from './flow.ts';
import { recordChainOffer } from './chain.ts';
import {
  liveGroups,
  processGroupCpuTicks,
  readWorkerExit,
  sameProcess,
  stopProcessesUnder,
  terminateProcessGroup,
  waitForProcessGroup,
  waitForWorkerExit,
  processIdentity,
  getProcessOwnershipAdapter,
} from './process.ts';
import { assessUsageLimitRefusal, markExhausted } from './usage.ts';
import { StaleAttemptError } from './contracts.ts';
import { acquireDirectoryLease, acquireDirectoryLeaseWaiting, LeaseHeldError, type DirectoryLease } from './lease.ts';
import { classifyFailure, estimateOverrun } from './failures.ts';
import { ensureGateOutcomeRefusal, guardIdsForFailure, isDevLandingRepairGuard, type GuardId } from './guards.ts';
import { controlPlaneReleaseBrief, devProductBrief, matchesPath } from './briefs.ts';
import { blockerFingerprint, noProgressTwice, toolRetryDelay } from './attempt-progress.ts';
import { checkHostsInOutage } from './watchdog.ts';
import { evidenceBundle } from './evidence.ts';
import { consult } from './consult.ts';
import {
  makeRecord,
  readMeasurement,
  readLogTail,
  attemptSession,
  reportedApproaches,
  CHECK_HOST_TRANSPORT,
  reportsSuccess,
} from './records.ts';
import { readRouting } from './routing.ts';
import { FINAL_REPORT_PROMPT, finalReportPending, isSqliteContention, settle } from './settle.ts';
import { firstFailure } from './merge.ts';
import {
  canonicalConflictPaths,
  completeRebaseConflictContext,
  repeatedNoProgressConflict,
  sameRebaseConflict,
  REBASE_CONFLICT_HISTORY_LIMIT,
} from './conflict-progress.ts';
import {
  git,
  HeldTaskConflictError,
  PageDataSessionUnavailableError,
  TaskHeldForDependenciesError,
  type WorkerTasks,
  type RetryOptions,
} from './tasks.ts';
import type { ManagerEventKind } from './contracts.ts';
import type { Attempt, Task } from './types.ts';
import type { PageDataRepair } from './page-data.ts';
import type { RunningWorker } from './launch.ts';
import { applyRenderedPrompt, checkWaitMs, launch, renderWorkerPrompt, workerActivityBaseline } from './launch.ts';
import { awaitHostCapacity, capacityWaiters, startsFirst } from './launch-capacity.ts';
import { agentAdapter, agentCommands } from './agents.ts';
import { removeFinishedWorktree, type LifetimeRuntime } from './worktree-lifetime.ts';
import { captureLaunchContext } from './launch-context.ts';
import {
  holdRetryForToolIncident,
  lastTransportFailure,
  recordToolBlockerFailure,
  recordTransportFailure,
  recoverUndeliveredToolIncidentNotices,
  noteToolIncidentProbeStarted,
  resolveToolIncidentsAfterAttempt,
  resolveToolIncidentsAfterProviderProgress,
  toolIncidentForRetry,
  toolIncidentRetryAllowed,
  transportIncidentResumeAllowed,
} from './tool-incidents.ts';
import { TRANSPORT_RESUME_PROMPT } from './agents/shared.ts';

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

function loggedCommands(attempt: Attempt, policy = defaultPolicy.worker): string[] {
  return agentCommands(readLogTail(attempt.logPath, policy.logTailBytes), agentAdapter(attempt.profile.cli));
}

function reranFailingCommand(task: Task, attempt: Attempt, previous: Attempt, policy = defaultPolicy.worker): boolean {
  const commands = loggedCommands(attempt, policy).join('\n');
  const expected = previous.failureCommand?.join(' ') || task.brief.acceptance.command.join(' ');
  return Boolean(expected && commands.includes(expected));
}

/** The one event a task stopped for lack of progress sends its manager. */
function stopEvent(task: Task, summary: string, evidencePath: string, policy = defaultPolicy.worker) {
  return {
    managerId: task.brief.manager,
    taskId: task.id,
    kind: 'stalled' as const,
    summary: summary.replace(/[\r\n]+/g, ' ').slice(0, policy.summaryCharacters),
    evidencePath,
  };
}

/** How long a capacity refusal waits before the attempt continues. */
export const CAPACITY_PAUSE_MS = defaultPolicy.worker.capacityPauseMs;
/** A usage-limit refusal with recent allowance left is retried on the same pool after a brief recovery window. */
export const USAGE_LIMIT_RETRY_PAUSE_MS = defaultPolicy.worker.usageLimitRetryPauseMs;
/** Repeated ambiguous refusals temporarily route work away from one pool. */
export const USAGE_LIMIT_REFUSAL_WINDOW_MS = defaultPolicy.worker.usageLimitRefusalWindowMs;
export const REPEATED_USAGE_LIMIT_EXHAUSTION_MS = defaultPolicy.worker.usageLimitExhaustionMs;
/** A waiting attempt gets its first resume plus two retries when the CLI cannot start. */
/** A worker whose CLI writes nothing this long never started a session: it is stopped, and its exit retries it. */
export const START_GRACE_MS = defaultPolicy.worker.startGraceMs;
/** A running worker with no log, worktree or process-group CPU activity for this long is stopped and retried. */
export const SILENCE_WINDOW_MS = defaults.silenceMs;
/** Run-log activity is checked at most once a minute when the filesystem watcher is unavailable. */
const SKIP_WORKTREE_ACTIVITY = new Set(['node_modules', '.temp']);
const WORKTREE_SAMPLE_TIMEOUT_MS = 1000;
/** Directory entries a worktree walk visits before yielding to the event loop. */
const WORKTREE_WALK_CHUNK = 256;
const execFileAsync = promisify(execFile);

/** Activity samples run for every running worker each minute; they run git and walk the worktree off the host loop. */
async function gitSample(worktree: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: worktree,
      encoding: 'utf8',
      timeout: WORKTREE_SAMPLE_TIMEOUT_MS,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Newest file or directory mtime under the worktree, skipping `node_modules` and `.temp` at every level. */
export async function newestWorktreeMtime(root: string): Promise<number> {
  let newest = 0;
  let visited = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (SKIP_WORKTREE_ACTIVITY.has(name)) continue;
      const path = join(dir, name);
      try {
        const st = await lstat(path);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (st.isDirectory()) stack.push(path);
      } catch {
        /* vanished between readdir and lstat */
      }
      if (++visited % WORKTREE_WALK_CHUNK === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return newest;
}

async function worktreeHeadSample(worktree: string): Promise<{ head?: string; committedAt?: number }> {
  const [head, committed] = await Promise.all([
    gitSample(worktree, ['rev-parse', 'HEAD']),
    gitSample(worktree, ['log', '-1', '--format=%ct']),
  ]);
  const seconds = committed && /^\d+$/.test(committed) ? Number(committed) : undefined;
  return { ...(head ? { head } : {}), ...(seconds !== undefined ? { committedAt: seconds * 1000 } : {}) };
}

/** Hold both train lanes while checking and repairing a landing with no queued request. */
function acquireIdleTrainLeases(stateDirectory: string, policy = defaultPolicy): DirectoryLease[] | undefined {
  const leases: DirectoryLease[] = [];
  try {
    for (const name of ['train-main.lease', 'train.lease'])
      leases.push(acquireDirectoryLease(join(stateDirectory, name), policy.leases));
    return leases;
  } catch (error) {
    for (const lease of leases) lease.release();
    if (error instanceof LeaseHeldError) return undefined;
    throw error;
  }
}

export class WorkerJob implements GateOutcomeSink {
  private get policy() {
    return this.tasks.settings.policy ?? defaultPolicy;
  }
  private readonly pending = new Set<Promise<void>>();
  private readonly retryIntentsInProgress = new Set<string>();
  constructor(
    readonly tasks: WorkerTasks,
    readonly landing: LandingQueue,
    readonly inbox: ManagerInbox,
    readonly consultation: typeof consult = consult,
    readonly afterSettle: () => Promise<void> = async () => {},
    private readonly acquireOrphanLease: (path: string) => DirectoryLease = (path) =>
      acquireDirectoryLease(path, tasks.settings.policy?.leases),
    private readonly worktreeLifetimeRuntime?: LifetimeRuntime,
    // False once this host retires for a newer tools/goal: the attempts it already follows continue, but none starts.
    private readonly startsAllowed: () => boolean = () => true,
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
          summary: `Control-plane background work failed: ${String(error)}`
            .replace(/[\r\n]+/g, ' ')
            .slice(0, this.policy.worker.summaryCharacters),
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
    if (!this.startsAllowed()) return;
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
      if (task.state === 'held') return;
      const incident = toolIncidentForRetry(store, ref);
      const incidentProbe = incident !== null;
      if (incident && !toolIncidentRetryAllowed(store, ref)) return;
      // A backed-off retry waits for its time, and a check-host transport failure until the watchdog's probes see
      // every check host answer again: relaunching into a broken host repeats the failure. The intent stays pending,
      // and the host's recovery sweep tries it again every minute.
      if (
        !incidentProbe &&
        intent.options.notBefore &&
        Date.parse(intent.options.notBefore) - Date.now() > this.policy.worker.retryIntentLeadMs
      )
        return;
      if (intent.options.awaitCheckHosts) {
        const hosts = checkHostsInOutage(this.tasks.settings.stateDirectory, this.policy);
        if (hosts.length) {
          if (!store.events(ref.taskId, ref.attempt).some((event) => event.kind === 'retry-awaits-check-hosts'))
            store.event(ref, 'retry-awaits-check-hosts', { hosts });
          return;
        }
      }
      // Ordinary recovery publishes its retry generation without waiting on proof-only preparation.
      if (task.brief.kind === 'verification') {
        this.tasks.assertProofStart(task);
        await this.tasks.refreshProofAdmission(task);
        if (!store.proofCapacityAvailable(task.brief.goal, task.id)) return;
      }
      if (!['landing', 'ready', 'running', 'stopped'].includes(task.state)) {
        store.updateRetryIntent(ref, (value) => {
          value.status = 'started';
          value.nextAttempt = task.currentAttempt;
        });
        return;
      }
      if (intent.options.escalation === 'repeated-assertion' && !intent.options.consulted) {
        try {
          const evidencePath =
            intent.options.evidence ?? evidenceBundle(task, store.attempt(ref), undefined, store.policy.evidence);
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
      if (
        error instanceof LeaseHeldError ||
        error instanceof ProofCapacityQueuedError ||
        error instanceof ProofUnavailableError
      )
        return;
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
  resumePendingRetries(): void {
    // Dispatch may crash after accepting READY0 but before calling start. The same durable intent owns recovery.
    for (const task of this.tasks.store.activeTasks()) {
      if (
        task.currentAttempt === 0 &&
        ['ready', 'held'].includes(task.state) &&
        task.brief.kind === 'verification' &&
        task.proofAuthorization
      )
        this.tasks.store.saveRetryIntent({ taskId: task.id, attempt: 0 }, {});
    }
    for (const intent of this.tasks.store.retryIntents().filter((value) => value.status === 'pending'))
      this.track(this.runRetryIntent({ taskId: intent.taskId, attempt: intent.attempt }));
  }
  async start(taskId: string, options: RetryOptions = {}): Promise<void> {
    if (!this.startsAllowed()) return;
    const task = this.tasks.store.task(taskId);
    if (
      task.currentAttempt > 0 &&
      holdRetryForToolIncident(this.tasks.store, { taskId, attempt: task.currentAttempt }, options)
    )
      return;
    try {
      await this.follow(await this.tasks.retry(taskId, options));
    } catch (error) {
      if (error instanceof TaskHeldForDependenciesError || error instanceof ProofCapacityQueuedError) return;
      // Another process already started the attempt this start expected to create.
      if (options.expectedAttempt !== undefined && error instanceof StaleAttemptError) return;
      throw error;
    }
  }
  /** Continue the integrated author task only when its original session and provider pool can be resumed. */
  async resumePageDataRepair(repair: PageDataRepair): Promise<boolean> {
    if (!repair.owner) return false;
    const task = this.tasks.store.task(repair.owner.id);
    if (
      !['integrated', 'merged'].includes(task.state) ||
      task.currentAttempt !== repair.owner.currentAttempt ||
      !task.currentAttempt
    )
      return false;
    const ref = { taskId: task.id, attempt: task.currentAttempt };
    const previous = this.tasks.store.attempt(ref);
    const session = attemptSession(previous, this.tasks.settings.policy?.records);
    if (
      !session ||
      !agentAdapter(previous.profile.cli).canResume ||
      ['pending', 'running', 'waiting'].includes(previous.state)
    )
      return false;
    const evidencePath = join(this.tasks.settings.stateDirectory, 'page-data-repairs', `${repair.repairKey}.md`);
    const evidence = [
      `page-data-repair-key: ${repair.repairKey}`,
      `Integrated head: ${repair.head}`,
      `Section: ${repair.section.page}/${repair.section.persona}/${repair.section.section}`,
      `Class: ${repair.section.class} (previously ${repair.previousClass})`,
      `First error line: ${repair.section.firstErrorLine ?? 'unavailable'}`,
      '',
      'Repair this section in the same task and continue the retained provider session.',
      '',
    ].join('\n');
    mkdirSync(join(this.tasks.settings.stateDirectory, 'page-data-repairs'), { recursive: true });
    if (existsSync(evidencePath)) {
      if (readFileSync(evidencePath, 'utf8') !== evidence)
        throw new Error('page-data repair evidence changed for an existing cause');
    } else writeFileSync(evidencePath, evidence, { flag: 'wx', mode: 0o600 });
    let worker: RunningWorker;
    try {
      worker = await this.tasks.retry(task.id, {
        expectedAttempt: ref.attempt,
        profile: previous.profile,
        evidence: evidencePath,
        pageDataRepairKey: repair.repairKey,
      });
    } catch (error) {
      if (
        error instanceof LeaseHeldError ||
        error instanceof StaleAttemptError ||
        error instanceof PageDataSessionUnavailableError
      )
        return false;
      throw error;
    }
    this.track(this.follow(worker));
    return true;
  }
  /** Tasks whose lost pending attempt this process is already retrying. */
  private readonly recovering = new Set<string>();
  /** Released tasks this process is already starting; a sweep never starts the same one twice while it waits. */
  private readonly starting = new Set<string>();
  private async startReleased(taskId: string): Promise<void> {
    if (!this.startsAllowed() || this.starting.has(taskId)) return;
    this.starting.add(taskId);
    try {
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
    } finally {
      this.starting.delete(taskId);
    }
  }
  private hasCommit(ref: AttemptRef): boolean {
    const task = this.tasks.store.task(ref.taskId);
    if (task.workspace) return taskCommits(task).length > 0;
    return Number(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`])) > 0;
  }
  private async checkWakeMessage(attempt: Attempt, task: Task): Promise<string | null> {
    if (task.brief.kind === 'verification') {
      const observed = await readProofObservation(task, attempt.checks);
      if (observed.status === 'running') return null;
      return `Original proof result: ${JSON.stringify(observed)}`;
    }
    if (finalReportPending(this.tasks.store, attempt)) return FINAL_REPORT_PROMPT;
    const transport = lastTransportFailure(this.tasks.store, attempt);
    if (transport) {
      if (Date.parse(transport.nextResumeAt) - Date.now() > this.policy.worker.retryIntentLeadMs) return null;
      if (!transportIncidentResumeAllowed(this.tasks.store, attempt)) return null;
    }
    if (attempt.checks?.length) {
      const observed = observeWorkerChecks(task, attempt.checks, this.policy.worker);
      return observed.status === 'pending' ? null : observed.resumeText;
    }
    if (transport) return TRANSPORT_RESUME_PROMPT;
    const observed = observeWorkerChecks(task, attempt.checks ?? [], this.policy.worker);
    return observed.status === 'pending' ? null : observed.resumeText;
  }
  private async resumeWaiting(attempt: Attempt, task: Task, message: string): Promise<void> {
    if (!this.startsAllowed()) return;
    const ref = { taskId: attempt.taskId, attempt: attempt.attempt };
    const failureCount = () =>
      this.tasks.store.events(ref.taskId, ref.attempt).filter((event) => event.kind === 'waiting-resume-launch-failed')
        .length;
    const lastFailure = () => {
      const event = this.tasks.store
        .events(ref.taskId, ref.attempt)
        .filter((value) => value.kind === 'waiting-resume-launch-failed')
        .at(-1);
      if (!event) return 'Worker CLI failed to resume the waiting session';
      try {
        const value = JSON.parse(event.body) as { detail?: string; errorLine?: string };
        return value.errorLine ?? value.detail ?? 'Worker CLI failed to resume the waiting session';
      } catch {
        return 'Worker CLI failed to resume the waiting session';
      }
    };
    for (;;) {
      const before = failureCount();
      if (task.brief.kind === 'verification' && before > 0) {
        this.onAttemptExit(attempt);
        return;
      }
      const releaseCapacity = await awaitHostCapacity(
        this.tasks.store,
        this.tasks.settings.stateDirectory,
        startsFirst(task),
        task.id,
        ref.attempt,
        {
          policy: this.tasks.settings.policy?.capacity,
          leasePolicy: this.tasks.settings.policy?.leases,
          urgent: task.brief.urgent,
          goal: task.brief.goal,
          // A parked attempt resuming is already in flight: the Goal cap limits new starts only. Applying it here
          // deadlocked every Goal at or over its cap, since none of its parked attempts could resume (2026-11-06).
          goalMaxInFlight: Number.POSITIVE_INFINITY,
          excludeTaskId: task.id,
        },
      );
      let worker: RunningWorker | undefined;
      let lease: DirectoryLease | undefined;
      try {
        // Capacity may take time. Reacquire the task lease only after it, then take the current store and Git
        // snapshot with no SQLite transaction open. A replacement attempt or reshape wins before this launch.
        lease = acquireDirectoryLeaseWaiting(
          join(this.tasks.settings.stateDirectory, 'leases', ref.taskId),
          undefined,
          this.tasks.settings.policy?.leases,
        );
        const currentTask = this.tasks.store.task(ref.taskId);
        const currentAttempt = this.tasks.store.attempt(ref);
        if (
          currentTask.currentAttempt !== ref.attempt ||
          currentTask.state !== 'running' ||
          currentAttempt.state !== 'waiting'
        )
          return;
        const pool = this.tasks.settings.pools.find((candidate) => candidate.name === currentAttempt.pool);
        if (!pool) throw new Error(`Waiting attempt refers to missing pool ${currentAttempt.pool}`);
        const canResume = agentAdapter(currentAttempt.profile.cli).canResume && !!currentAttempt.session;
        if (currentTask.brief.kind === 'verification' && !canResume) {
          await this.endAsEnvironment(
            ref,
            new Error('Original proof session unavailable; no replacement model may rerun it'),
            true,
            true,
          );
          return;
        }
        const context = captureLaunchContext(
          this.tasks.store,
          ref,
          'wake',
          currentAttempt.escalation === 'import' ? 'adopted-legacy' : 'managed',
        );
        // A report-only continuation needs the session's own context, not the contract again.
        const prompt =
          message === FINAL_REPORT_PROMPT && canResume
            ? FINAL_REPORT_PROMPT
            : [
                applyRenderedPrompt(
                  this.tasks.store,
                  currentAttempt,
                  renderWorkerPrompt({
                    task: currentTask,
                    evidence: canResume ? undefined : currentAttempt.evidencePath,
                    resolutionFiles: [],
                    mainCheckout: this.tasks.settings.mainCheckout,
                    launchContext: context,
                    stateDirectory: this.tasks.settings.stateDirectory,
                    policy: this.tasks.settings.policy,
                  }),
                ),
                `The checks you started have finished or could not be found. ${message}`,
                'Continue the same task. Do not wait or poll for these checks again. Finish with the required exit object.',
              ].join('\n\n');
        worker = await launch(
          this.tasks.store,
          currentTask,
          currentAttempt,
          pool,
          prompt,
          this.tasks.settings.codex,
          canResume ? currentAttempt.session! : undefined,
          this.tasks.settings.policy,
        );
      } catch (error) {
        if (error instanceof StaleAttemptError) return;
        const detail = (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
          .replace(/[\r\n]+/g, ' ')
          .slice(0, this.policy.worker.diagnosticCharacters);
        const errorLine = detail.split(/\r?\n/, 1)[0]!.slice(0, this.policy.worker.summaryCharacters);
        let count = 0;
        this.tasks.store.write(ref, () => {
          count = failureCount() + 1;
          this.tasks.store.updateAttempt(ref, (current) => {
            current.state = 'waiting';
            current.process = null;
            current.driver = null;
            current.result = detail;
            current.failureKind = null;
          });
          this.tasks.store.event(ref, 'waiting-resume-launch-failed', {
            count,
            detail,
            errorLine,
          });
        });
        if (task.brief.kind === 'verification' || count >= this.policy.worker.waitingResumeLaunchFailures) {
          await this.endAsEnvironment(ref, new Error(errorLine), lease !== undefined, true);
          return;
        }
        continue;
      } finally {
        lease?.release();
        releaseCapacity();
      }

      if (!worker) return;
      await this.follow(worker);
      const count = failureCount();
      if (count === before) return;
      if (task.brief.kind === 'verification' || count >= this.policy.worker.waitingResumeLaunchFailures) {
        await this.endAsEnvironment(ref, new Error(lastFailure()), false, true);
        return;
      }
    }
  }
  async follow(worker: Pick<RunningWorker, 'attempt' | 'exited'>): Promise<void> {
    const following = this.followAttempt(worker).catch((error) => this.endAsEnvironment(worker.attempt, error));
    getProcessOwnershipAdapter().trackWait(worker.attempt.logPath, following);
    await following;
  }
  private async followAttempt(worker: Pick<RunningWorker, 'attempt' | 'exited'>): Promise<void> {
    const ref = worker.attempt,
      store = this.tasks.store;
    const task = store.task(ref.taskId);
    const limits = readRouting(this.tasks.settings.routingFile, this.tasks.settings.policy?.routing).classes[
      task.taskClass as Exclude<typeof task.taskClass, 'mechanical'>
    ];
    let watcher: Watching | undefined;
    let stopping: Promise<void> | undefined;
    const silenceMs = this.tasks.settings.silenceMs ?? defaults.silenceMs;
    let silenceFailure: string | undefined;
    let silenceStopping: Promise<void> | undefined;
    const activity = workerActivityBaseline(store, ref);
    noteToolIncidentProbeStarted(store, ref);
    const releaseOnProviderProgress = () => {
      const resolved = resolveToolIncidentsAfterProviderProgress(store, ref, task, store.attempt(ref));
      if (resolved.length) this.resumePendingRetries();
    };
    releaseOnProviderProgress();
    let { lastLogSize, lastLogMtime, lastLogActivityAt, checkWaitAtLastLogActivity } = activity;
    let lastHead: string | undefined;
    let lastNewestMtime = 0;
    let lastCpu: bigint | undefined;
    let sampledWork = false;
    // Every log event wakes the checks, but the worktree walk, git and CPU samples run at most once per check interval.
    const sampleEveryMs = Math.max(1, Math.min(this.policy.worker.silenceCheckMs, silenceMs));
    let sampledAt = 0;
    let steppedAt = 0;
    // One sample per attempt is in flight at a time, so a slow git call or worktree walk never queues behind the timer.
    let sampling: Promise<void> | undefined;
    const checkSilence = () => {
      if (sampling || silenceStopping || silenceFailure) return;
      sampling = sampleSilence().finally(() => {
        sampling = undefined;
      });
    };
    const sampleSilence = async () => {
      if (silenceStopping || silenceFailure) return;
      try {
        store.assertCurrent(ref);
        const attempt = store.attempt(ref);
        if (attempt.state !== 'running') return;
        const now = Date.now();
        const noteNow = () => {
          lastLogActivityAt = Date.now();
          checkWaitAtLastLogActivity = checkWaitMs(ref.logPath);
        };
        const stat = statSync(ref.logPath, { throwIfNoEntry: false });
        const size = stat?.size ?? 0;
        const mtime = stat?.mtimeMs ?? 0;
        if (size !== lastLogSize || mtime !== lastLogMtime) {
          lastLogSize = size;
          lastLogMtime = mtime;
          noteNow();
        }
        if (now - sampledAt < sampleEveryMs) return;
        sampledAt = now;
        const headSample = await worktreeHeadSample(task.worktree);
        const newest = await newestWorktreeMtime(task.worktree);
        const cpu = await processGroupCpuTicks(attempt.process ?? null);
        store.assertCurrent(ref);
        if (store.attempt(ref).state !== 'running') return;
        const logAfterSample = statSync(ref.logPath, { throwIfNoEntry: false });
        const sizeAfter = logAfterSample?.size ?? 0;
        const mtimeAfter = logAfterSample?.mtimeMs ?? 0;
        if (sizeAfter !== lastLogSize || mtimeAfter !== lastLogMtime) {
          lastLogSize = sizeAfter;
          lastLogMtime = mtimeAfter;
          noteNow();
        }
        const hadWorkBaseline = sampledWork;
        const hadCpu = lastCpu !== undefined;
        if (sampledWork) {
          if (headSample.head !== undefined && lastHead !== undefined && headSample.head !== lastHead) noteNow();
          if (newest > lastNewestMtime) noteNow();
          if (cpu !== undefined && lastCpu !== undefined && cpu > lastCpu) noteNow();
        } else {
          sampledWork = true;
          noteNow();
        }
        if (headSample.head !== undefined) lastHead = headSample.head;
        if (newest > lastNewestMtime) lastNewestMtime = newest;
        if (cpu !== undefined) lastCpu = cpu;
        // The first worktree sample, and the first CPU reading, only record baselines. Timestamp them when the
        // sample finishes so a slow git/walk/proc scan is not counted as silence. A process group that has not
        // appeared yet is still starting: start grace owns that, not stall. One that has left /proc is exiting:
        // settlement owns that, not stall. A log that already reports success is a finished worker, not a silent one.
        if (!hadWorkBaseline) return;
        if (!hadCpu && cpu !== undefined) return;
        if (!hadCpu && cpu === undefined && attempt.process) {
          const grace = this.tasks.settings.startGraceMs ?? this.policy.worker.startGraceMs;
          if (Date.now() - activity.startedAt < grace) return;
        }
        if (hadCpu && cpu === undefined) return;
        if (
          reportsSuccess(readLogTail(ref.logPath, this.policy.worker.logTailBytes), agentAdapter(attempt.profile.cli))
        )
          return;
        // Check tools append elapsed check time beside the run log. Subtract it from idle time so a worker blocked on
        // a local or remote check does not look silent while the command is running. Idle time is the gap at sample
        // start, so a slow /proc scan after that is not silence.
        const waitedMs = Math.max(0, checkWaitMs(ref.logPath) - checkWaitAtLastLogActivity);
        if (now - lastLogActivityAt - waitedMs < silenceMs) return;
        const minutes = Math.max(1, Math.ceil(silenceMs / 60_000));
        silenceFailure = `stalled: no output for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
        store.updateAttempt(ref, (current) => {
          current.escalation = 'stalled';
        });
        silenceStopping = terminateProcessGroup(
          attempt.process ?? null,
          this.tasks.settings.terminationGraceMs,
          this.tasks.settings.policy?.process,
        );
        void silenceStopping.catch(() => {});
      } catch (error) {
        if (!(error instanceof StaleAttemptError)) {
          silenceStopping = Promise.reject(error);
          void silenceStopping.catch(() => {});
        }
      }
    };
    const stopIfStalled = (timeLimit: boolean) => {
      try {
        store.assertCurrent(ref);
        const attempt = store.attempt(ref);
        const pool = this.tasks.settings.pools.find((candidate) => candidate.name === attempt.pool);
        const measurement = readMeasurement(attempt, {
          policy: this.tasks.settings.policy ?? defaultPolicy,
          configDirectory: pool?.configDirectory,
        });
        const steps = Object.values(measurement.steps).reduce((a, b) => a + b, 0);
        if (
          (timeLimit || steps > limits.maxSteps) &&
          task.brief.kind !== 'verification' &&
          !this.hasCommit(ref) &&
          !stopping
        ) {
          const evidencePath = evidenceBundle(task, store.attempt(ref), undefined, store.policy.evidence);
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
    // Time spent waiting for or running a check does not count against the class limit: workers do no model work while
    // the check wrapper is silent.
    const remainingMs = () =>
      limits.maxMs +
      Math.max(0, checkWaitMs(ref.logPath) - activity.checkWaitBaseline) -
      (Date.now() - activity.startedAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silenceTimer = setInterval(checkSilence, Math.max(1, Math.min(this.policy.worker.silenceCheckMs, silenceMs)));
    const scheduleLimit = () => {
      timer = setTimeout(() => (remainingMs() > 0 ? scheduleLimit() : stopIfStalled(true)), Math.max(0, remainingMs()));
    };
    scheduleLimit();
    // One worker held a slot for two hours with an empty log until the class limit ended it.
    const startCheck = setTimeout(
      () => {
        try {
          store.assertCurrent(ref);
          const attempt = store.attempt(ref);
          // Only CLIs that stream their log can be judged by it; Cursor's agent writes its log once, at the end.
          if (!agentAdapter(attempt.profile.cli).streamsLog) return;
          if (
            attempt.state !== 'running' ||
            (statSync(ref.logPath, { throwIfNoEntry: false })?.size ?? 0) > activity.logStartOffset
          )
            return;
          console.error(`Worker ${ref.taskId} attempt ${ref.attempt} wrote nothing; stopping it so it is retried.`);
          void terminateProcessGroup(
            attempt.process ?? null,
            this.tasks.settings.terminationGraceMs,
            this.tasks.settings.policy?.process,
          ).catch(() => {});
        } catch {
          /* A superseded attempt needs no check. */
        }
      },
      Math.max(
        0,
        (this.tasks.settings.startGraceMs ?? this.policy.worker.startGraceMs) - (Date.now() - activity.startedAt),
      ),
    );
    try {
      watcher = watchOrPoll(
        ref.logPath,
        () => {
          releaseOnProviderProgress();
          checkSilence();
          // Reading the measurement scans the attempt log; step limits move slowly, so they are checked once per interval.
          if (Date.now() - steppedAt < sampleEveryMs) return;
          steppedAt = Date.now();
          stopIfStalled(false);
        },
        this.policy.worker.activityPollMs,
      );
      const priorTransport = lastTransportFailure(store, ref)?.sequence ?? 0;
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
      if (silenceStopping) await silenceStopping;
      if (!stopping) {
        const settled = store.attempt(ref);
        const transport = lastTransportFailure(store, ref);
        if (transport && transport.sequence > priorTransport)
          recordTransportFailure(
            store,
            store.task(ref.taskId),
            settled,
            this.tasks.settings,
            this.inbox,
            transport.line,
          );
        else if (
          settled.state === 'waiting' ||
          (settled.state === 'exited' &&
            !settled.failureKind &&
            reportsSuccess(settled.result, agentAdapter(settled.profile.cli)))
        ) {
          const resolved = resolveToolIncidentsAfterAttempt(store, ref, store.task(ref.taskId), settled);
          if (resolved.length) this.resumePendingRetries();
        }
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(startCheck);
      clearInterval(silenceTimer);
      watcher?.close();
    }
    if (!stopping) {
      if (
        silenceFailure &&
        store.attempt(ref).state === 'exited' &&
        !reportsSuccess(store.attempt(ref).result, agentAdapter(store.attempt(ref).profile.cli))
      ) {
        store.updateAttempt(ref, (attempt) => {
          attempt.failureKind = 'tool';
          attempt.result = silenceFailure!;
          attempt.escalation = 'stalled';
        });
      }
      const fact = store.attempt(ref).failureKind;
      if (fact) this.onAttemptExit(ref);
    }
  }
  private async endAsEnvironment(
    ref: AttemptRef,
    error: unknown,
    leaseHeld = false,
    reportToSupermanager = false,
  ): Promise<void> {
    if (error instanceof StaleAttemptError) return;
    if (isSqliteContention(error)) {
      // Another process held the store's lock through every settlement try. The worker's exit and work are intact, so
      // this is not its failure: release the attempt to the host's orphan sweep, which settles it again.
      console.error(
        `Settlement of ${ref.taskId} attempt ${ref.attempt} deferred by store contention: ${String(error)}`,
      );
      for (const pause of [0, ...this.policy.worker.settlementBackoffMs]) {
        await Bun.sleep(pause);
        try {
          this.tasks.store.updateAttempt(ref, (value) => {
            value.driver = null;
          });
          return;
        } catch (clearing) {
          if (!isSqliteContention(clearing)) throw clearing;
        }
      }
      return;
    }
    const lease = leaseHeld
      ? undefined
      : await acquireDirectoryLeaseWaiting(
          join(this.tasks.settings.stateDirectory, 'leases', ref.taskId),
          undefined,
          this.tasks.settings.policy?.leases,
        );
    try {
      const store = this.tasks.store;
      const current = store.attempt(ref);
      if (!['pending', 'running', 'waiting', 'exited'].includes(current.state)) return;
      // Settlement records the worker's exit before awaiting affected checks. A driver error before enqueue still
      // needs an environment outcome; errors after a classified exit or a landing request already have an owner.
      if (
        current.state === 'exited' &&
        (current.failureKind ||
          store.events(ref.taskId, ref.attempt).some((event) => event.kind === 'landing-requested'))
      )
        return;
      const task = store.task(ref.taskId),
        pool = this.tasks.settings.pools.find((candidate) => candidate.name === current.pool);
      const runEvent = store
        .events(ref.taskId, ref.attempt)
        .filter((event) => event.kind === 'worker-run-started')
        .at(-1);
      let logStartOffset: number | undefined;
      try {
        const parsed = runEvent ? (JSON.parse(runEvent.body) as { logStartOffset?: unknown }) : undefined;
        if (typeof parsed?.logStartOffset === 'number' && Number.isFinite(parsed.logStartOffset))
          logStartOffset = parsed.logStartOffset;
      } catch {
        /* Legacy attempts have no run boundary marker. */
      }
      let detail = (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
        .replace(/[\r\n]+/g, ' ')
        .slice(0, this.policy.worker.diagnosticCharacters);
      try {
        await terminateProcessGroup(
          current.process,
          this.tasks.settings.terminationGraceMs,
          this.tasks.settings.policy?.process,
        );
        for (const process of current.auxiliaryProcesses)
          await terminateProcessGroup(
            process,
            this.tasks.settings.terminationGraceMs,
            this.tasks.settings.policy?.process,
          );
        if (!task.workspace && task.brief.kind !== 'verification')
          await stopProcessesUnder(
            task.worktree,
            this.tasks.settings.terminationGraceMs,
            undefined,
            this.tasks.settings.policy?.process,
          );
      } catch (cleanupError) {
        detail = `${detail}; process cleanup failed: ${String(cleanupError)}`.slice(
          0,
          this.policy.worker.diagnosticCharacters,
        );
        // Unknown custody is an operational condition, not an exit or a free worker slot.
        store.updateAttempt(ref, (value) => {
          value.driver = null;
          value.blocker = detail;
        });
        if (!store.events(ref.taskId, ref.attempt).some((event) => event.kind === 'process-cleanup-unconfirmed')) {
          const event = {
            managerId: task.brief.manager,
            taskId: task.id,
            kind: 'environment' as const,
            summary: `environment: process cleanup unconfirmed: ${detail}`.slice(
              0,
              this.policy.worker.summaryCharacters,
            ),
          };
          store.event(ref, 'process-cleanup-unconfirmed', { detail });
          store.event(ref, 'manager-event', event);
          this.inbox.deliver(event);
        }
        return;
      }
      const endedAt = new Date().toISOString();
      const ended = { ...current, endedAt };
      let measurement: ReturnType<typeof readMeasurement>;
      try {
        measurement = readMeasurement(ended, {
          policy: this.tasks.settings.policy ?? defaultPolicy,
          configDirectory: pool?.configDirectory,
          ...(logStartOffset !== undefined ? { logStartOffset } : {}),
        });
      } catch (measurementError) {
        detail = `${detail}; run log measurement failed: ${String(measurementError)}`.slice(
          0,
          this.policy.worker.diagnosticCharacters,
        );
        measurement = readMeasurement(
          { ...ended, startedAt: endedAt },
          {
            policy: this.tasks.settings.policy ?? defaultPolicy,
            configDirectory: pool?.configDirectory,
            ...(logStartOffset !== undefined ? { logStartOffset } : {}),
          },
        );
      }
      let after: typeof current.after = null;
      try {
        if (pool) after = this.tasks.reader(pool);
      } catch (readingError) {
        detail = `${detail}; pool reading failed: ${String(readingError)}`.slice(
          0,
          this.policy.worker.diagnosticCharacters,
        );
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
          value.approaches.push(...reportedApproaches(value.result, undefined, this.tasks.settings.policy?.records));
        });
        const record = makeRecord(task, attempt, measurement, 'stopped');
        record.escalation = 'environment';
        store.putRecord(record);
        store.updateTask(ref, (value) => {
          value.state = 'stopped';
        });
        let evidencePath: string | undefined;
        try {
          evidencePath = evidenceBundle(task, store.attempt(ref), undefined, store.policy.evidence);
        } catch {
          /* The failure event still carries the driver error. */
        }
        const event = {
          managerId:
            reportToSupermanager && task.brief.kind !== 'verification'
              ? this.tasks.settings.integration.supermanager
              : task.brief.manager,
          taskId: task.id,
          kind: 'environment' as const,
          summary: `environment: driver exception: ${detail}`.slice(0, this.policy.worker.summaryCharacters),
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
  /** Recovery failures already reported by this process, by task, step and first error line. */
  private readonly recoveryFailures = new Set<string>();
  /** Stray worktrees kept because a live process cwd is inside them, reported once per path. */
  private readonly strayKeptNotices = new Set<string>();
  /**
   * One task's failure in a recovery sweep is that task's problem, not the sweep's: it is logged, reported once to the
   * supermanager, and the sweep continues with the other tasks. Store contention affects every task and is only logged.
   */
  private recoveryFailed(taskId: string, step: string, error: unknown): void {
    if (error instanceof StaleAttemptError || error instanceof LeaseHeldError) return;
    const detail = (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      .replace(/[\r\n]+/g, ' ')
      .slice(0, this.policy.worker.recoveryCharacters);
    console.error(`Recovery step ${step} failed for task ${taskId}: ${detail}`);
    const key = `${taskId}\0${step}\0${detail}`;
    if (isSqliteContention(error) || this.recoveryFailures.has(key)) return;
    this.recoveryFailures.add(key);
    try {
      this.inbox.deliver({
        managerId: this.tasks.settings.integration.supermanager,
        taskId,
        kind: 'environment',
        summary: `environment: recovery step ${step} failed for task ${taskId}; the sweep continued with other tasks: ${detail}`,
      });
    } catch (reportError) {
      console.error(`Recovery failure report for task ${taskId} was not delivered:`, reportError);
    }
  }
  /** Release held tasks whose dependencies are met; returns their ids. */
  private releaseMetDependents(): string[] {
    const store = this.tasks.store;
    const tasks = store.activeTasks();
    const candidates = tasks
      .filter((candidate) => candidate.state === 'held' && this.tasks.dependenciesMet(candidate, tasks))
      .map((candidate) => candidate.id);
    const released: string[] = [];
    for (const taskId of candidates) {
      let lease: DirectoryLease;
      try {
        lease = acquireDirectoryLease(
          join(this.tasks.settings.stateDirectory, 'leases', taskId),
          this.tasks.settings.policy?.leases,
        );
      } catch (error) {
        this.recoveryFailed(taskId, 'dependency release', error);
        continue;
      }
      try {
        const candidate = store.task(taskId);
        if (candidate.state !== 'held' || !this.tasks.dependenciesMet(candidate)) continue;
        const ref = { taskId, attempt: candidate.currentAttempt };
        // A held amendment may retain an old writer. Integration satisfies the dependency, but only settlement
        // relinquishes that writer's ownership; leave the store's terminal-attempt release fence intact.
        if (ref.attempt > 0 && store.attempt(ref).state === 'running') continue;
        store.releaseHeldRetryTask(ref, (current) => {
          current.state = 'ready';
        });
        released.push(taskId);
      } catch (error) {
        this.recoveryFailed(taskId, 'dependency release', error);
      } finally {
        lease.release();
      }
    }
    return released;
  }
  /** Tell each owner once when a held task's predecessor ended without landing. */
  private reportDroppedDependencies(): void {
    const store = this.tasks.store;
    const tasks = store.activeTasks();
    const notices = new Map<
      string,
      { dependencyId: string; state: 'cancelled' | 'stopped'; managerId: string; taskId: string }
    >();
    for (const task of tasks) {
      if (task.state !== 'held') continue;
      for (const dependencyId of task.brief.after) {
        const state = store.taskState(dependencyId);
        if (state !== 'cancelled' && state !== 'stopped') continue;
        const key = `${dependencyId}:${task.brief.manager}`;
        notices.set(key, { dependencyId, state, managerId: task.brief.manager, taskId: task.id });
      }
    }
    for (const notice of notices.values()) {
      try {
        const predecessor = store.task(notice.dependencyId);
        store.notifyDroppedDependency(
          { taskId: predecessor.id, attempt: predecessor.currentAttempt },
          {
            managerId: notice.managerId,
            taskId: predecessor.id,
            kind: 'instruction',
            summary: `Predecessor ${predecessor.id} ended ${notice.state} without landing; held task ${notice.taskId} no longer waits for it.`,
          },
          (event) => this.inbox.deliver(event),
        );
      } catch (error) {
        this.recoveryFailed(notice.dependencyId, 'dropped dependency notice', error);
      }
    }
  }
  async recoverOrphans(options: { adoptRunning?: boolean } = {}): Promise<void> {
    const adoptRunning = options.adoptRunning ?? true;
    const store = this.tasks.store;
    recoverUndeliveredToolIncidentNotices(store, this.inbox, this.tasks.settings);
    for (const task of store.activeTasks()) {
      if (!task.currentAttempt) continue;
      const ref = { taskId: task.id, attempt: task.currentAttempt };
      const intent = store.attempt(ref).terminationIntent;
      if (!intent) continue;
      if (intent.settledAt) continue;
      try {
        await this.tasks.resumeTermination(task.id);
      } catch (error) {
        if (
          error instanceof LeaseHeldError ||
          error instanceof StaleAttemptError ||
          store.attempt(ref).terminationIntent?.state === 'unknown'
        )
          continue;
        throw error;
      }
    }
    this.reportDroppedDependencies();
    // The same recovery sweep also observes detached custody after a model exit or cancellation.
    if (adoptRunning) {
      try {
        await refreshHistoricalProofAdmission(store, join(this.tasks.settings.stateDirectory, 'check-registry'), {
          root: this.tasks.settings.integration?.checkScriptReaderRoot ?? resolve(import.meta.dir, '../../..'),
          integrationRoot: this.tasks.settings.mainCheckout,
          integrationBranch: this.tasks.settings.integrationBranch,
        });
      } catch (error) {
        // Optional native history stays unavailable with one bounded diagnostic; ordinary recovery continues.
        if (!(error instanceof ProofUnavailableError)) throw error;
      }
    }
    if (adoptRunning) {
      // Settled task history is not recovery work; only active permits need logical reconciliation.
      for (const run of store.activeProofReservations()) {
        try {
          const task = store.task(run.binding.taskId);
          if (
            task.currentAttempt === run.binding.attempt &&
            !['running', 'landing'].includes(task.state) &&
            ['stopped', 'exited', 'cancelled', 'superseded'].includes(
              store.attempt({ taskId: task.id, attempt: task.currentAttempt }).state,
            )
          )
            store.releaseExitedProofReservations({ taskId: task.id, attempt: task.currentAttempt });
        } catch (error) {
          this.recoveryFailed(run.binding.taskId, 'proof reservation release', error);
        }
      }
    }
    if (adoptRunning)
      for (const run of store.activeProofReservations()) {
        try {
          const observation = await readReservationObservation(
            run,
            run.native?.registry ??
              (run.status === 'bound' ? undefined : join(this.tasks.settings.stateDirectory, 'check-registry')),
          );
          if (observation.status === 'terminal') store.observeProof(run.binding, observation);
        } catch {
          // Optional evidence cannot assert native terminal status from missing reader/records.
        }
      }
    if (adoptRunning)
      this.track(
        removeFinishedWorktree(this.tasks.settings, store, this.worktreeLifetimeRuntime, {
          blocked: (task, disposition) => {
            const owner = disposition.owner ? `${disposition.owner.uid}:${disposition.owner.gid}` : 'unknown';
            this.inbox.deliver({
              managerId: task.brief.manager,
              kind: 'environment',
              taskId: task.id,
              summary:
                `environment: finished worktree cleanup for ${task.id} is blocked at ${disposition.path} (owner ${owner}); it will retry after the path's ownership or permissions change.`
                  .replace(/[\r\n]+/g, ' ')
                  .slice(0, this.policy.worker.summaryCharacters),
            });
          },
          failed: (task, error, path) => {
            this.recoveryFailed(task?.id ?? path, 'worktree cleanup', error);
          },
          strayKept: (path, task) => {
            if (this.strayKeptNotices.has(path)) return;
            this.strayKeptNotices.add(path);
            try {
              this.inbox.deliver({
                managerId: task?.brief.manager ?? this.tasks.settings.integration.supermanager,
                kind: 'environment',
                ...(task ? { taskId: task.id } : {}),
                summary: `environment: stray worktree ${path} kept; a live process cwd is inside it.`
                  .replace(/[\r\n]+/g, ' ')
                  .slice(0, this.policy.worker.summaryCharacters),
              });
            } catch {
              this.strayKeptNotices.delete(path);
            }
          },
        }).then(() => {}),
      );
    // A held task released by a train that then ended, or handed off to newer code, has no driver: the host starts
    // it. Commands leave it to the host, so released tasks are not started from every command at once. The host
    // also releases tasks whose dependency reached their branch later, through a stabilize-to-dev merge.
    if (adoptRunning) this.releaseMetDependents();
    const tasks = adoptRunning ? store.activeTasks() : [];
    let sweepItems = 0;
    const yieldSweep = async () => {
      if (++sweepItems % this.policy.worker.sweepYieldItems === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    };
    if (adoptRunning) {
      for (const candidate of store.orphanedLandingCandidates()) {
        await yieldSweep();
        const ref = { taskId: candidate.id, attempt: candidate.currentAttempt };
        let taskLease: DirectoryLease;
        try {
          taskLease = this.acquireOrphanLease(join(this.tasks.settings.stateDirectory, 'leases', candidate.id));
        } catch (error) {
          this.recoveryFailed(candidate.id, 'orphaned landing', error);
          continue;
        }
        try {
          const task = store.task(candidate.id);
          if (task.currentAttempt !== ref.attempt || task.state !== 'landing') continue;
          if (store.retryIntent(ref)?.status === 'pending') continue;
          const trainLeases = acquireIdleTrainLeases(this.tasks.settings.stateDirectory, this.tasks.settings.policy);
          if (!trainLeases) continue;
          try {
            const attempt = store.attempt(ref);
            const failure =
              attempt.failure ??
              firstFailure(
                `Landing for task ${task.id} attempt ${ref.attempt} was lost: no pending landing entry or live train owner remains.`,
                this.policy.merge,
              );
            const evidence = evidenceBundle(task, attempt, failure, store.policy.evidence);
            const event = {
              managerId: this.tasks.settings.integration.supermanager,
              taskId: task.id,
              kind: 'environment' as const,
              summary: `environment: recovered landing for task ${task.id} attempt ${ref.attempt}; queued a retry. See ${evidence}`,
              evidencePath: evidence,
            };
            const recovered = store.recoverOrphanedLanding(
              ref,
              failure,
              { evidence, escalation: 'environment', fixRound: attempt.fixRound },
              event,
            );
            if (recovered) this.inbox.deliver(event);
          } finally {
            for (const lease of trainLeases) lease.release();
          }
        } catch (error) {
          this.recoveryFailed(candidate.id, 'orphaned landing', error);
        } finally {
          taskLease.release();
        }
      }
    }
    for (const task of !adoptRunning
      ? []
      : tasks.filter(
          (t) =>
            t.state === 'ready' &&
            t.brief.kind !== 'verification' &&
            t.brief.after.length &&
            this.tasks.dependenciesMet(t, tasks) &&
            // A ready task with a pending retry intent is a retry, started from the intent.
            store.retryIntent({ taskId: t.id, attempt: t.currentAttempt })?.status !== 'pending',
        )) {
      this.track(
        this.startReleased(task.id).catch((error) => {
          if (store.task(task.id).state === 'ready') throw error;
          // Another process started it first.
        }),
      );
      await yieldSweep();
    }
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
      .orphanSweepCandidates()
      .filter(({ attempt }) => (!attempt.driver || !sameProcess(attempt.driver)) && ownsRunLog(attempt.logPath));
    // A pending attempt exists only while a process holds its task's lease to launch it. One that is old and whose
    // lease is free lost its launcher (nine tasks sat pending for three hours): the host retries the task.
    if (adoptRunning) {
      const graceMs = this.tasks.settings.startGraceMs ?? this.policy.worker.startGraceMs;
      for (const attempt of store.attemptsInState('pending')) {
        await yieldSweep();
        try {
          if (attempt.state !== 'pending' || Date.now() - Date.parse(attempt.startedAt) < graceMs) continue;
          const task = store.task(attempt.taskId);
          if (task.currentAttempt !== attempt.attempt || task.state !== 'ready') continue;
          // A released `after` task must refresh its worktree base under the task lease before it starts.
          if (task.brief.after.length && this.tasks.dependenciesMet(task, tasks)) continue;
          try {
            acquireDirectoryLease(
              join(this.tasks.settings.stateDirectory, 'leases', attempt.taskId),
              this.tasks.settings.policy?.leases,
            ).release();
          } catch (error) {
            this.recoveryFailed(attempt.taskId, 'pending attempt recovery', error);
            continue;
          }
          if (
            task.brief.kind === 'verification' &&
            store.events(task.id, attempt.attempt).some((event) => event.kind === 'proof-command-ready')
          ) {
            // The launch may have crossed its process boundary before SQLite recorded a driver. Never replay it.
            await this.endAsEnvironment(
              attempt,
              new Error(
                'Original proof launch interrupted after command preparation; execution is unknown, no automatic replay; retain native records and request authenticated fresh retry registration',
              ),
              false,
              true,
            );
            continue;
          }
          if (this.recovering.has(attempt.taskId)) continue;
          this.recovering.add(attempt.taskId);
          this.track(
            this.start(attempt.taskId)
              .catch((error) => this.recoveryFailed(attempt.taskId, 'pending attempt recovery', error))
              .finally(() => this.recovering.delete(attempt.taskId)),
          );
        } catch (error) {
          this.recoveryFailed(attempt.taskId, 'pending attempt recovery', error);
        }
      }
    }
    // A ready task with no attempt is started by the process that dispatched or released it. When that process is
    // gone (five tasks sat ready for hours), no ticket in the capacity queue names the task and its lease is free.
    if (adoptRunning) {
      const graceMs =
        this.policy.worker.orphanStartGraceMultiplier *
        (this.tasks.settings.startGraceMs ?? this.policy.worker.startGraceMs);
      const waiting = capacityWaiters(this.tasks.settings.stateDirectory);
      for (const task of store.activeTasks()) {
        await yieldSweep();
        if (
          task.brief.kind === 'verification' ||
          task.state !== 'ready' ||
          task.currentAttempt !== 0 ||
          this.recovering.has(task.id)
        )
          continue;
        if (Date.now() - Date.parse(task.createdAt) < graceMs || waiting.has(task.id)) continue;
        try {
          acquireDirectoryLease(
            join(this.tasks.settings.stateDirectory, 'leases', task.id),
            this.tasks.settings.policy?.leases,
          ).release();
        } catch (error) {
          this.recoveryFailed(task.id, 'first start', error);
          continue;
        }
        this.recovering.add(task.id);
        this.track(
          this.start(task.id, { expectedAttempt: 0 })
            .catch((error) => this.recoveryFailed(task.id, 'first start', error))
            .finally(() => this.recovering.delete(task.id)),
        );
      }
    }
    // One /proc scan for all candidates: a scan per candidate made every command cost attempts × processes.
    const live = adoptRunning || !candidates.length ? null : liveGroups();
    // Adopted attempts are followed at once: followed in turn, one long-running worker held back every later settle.
    const follows: Promise<void>[] = [];
    for (const { attempt: candidate, taskState, currentAttempt } of [...candidates].sort(
      (a, b) => Number(b.attempt.state === 'waiting') - Number(a.attempt.state === 'waiting'),
    )) {
      await yieldSweep();
      const ref = { taskId: candidate.taskId, attempt: candidate.attempt };
      // Candidate metadata was read from the task/attempt join before touching the per-task lease.
      if (taskState !== 'running' || currentAttempt !== ref.attempt) continue;
      if (
        candidate.state !== 'waiting' &&
        live &&
        candidate.state === 'running' &&
        candidate.process &&
        live.has(candidate.process.group)
      )
        continue;
      let lease: DirectoryLease;
      try {
        lease = this.acquireOrphanLease(join(this.tasks.settings.stateDirectory, 'leases', ref.taskId));
      } catch (error) {
        this.recoveryFailed(ref.taskId, 'worker adoption', error);
        continue;
      }
      let followed = false;
      // An adopted worker's own failure must not reject the sweep that adopts its peers.
      const adopt = (work: Promise<void>) =>
        follows.push(work.catch((error) => this.recoveryFailed(ref.taskId, 'worker adoption', error)));
      try {
        if (store.task(ref.taskId).currentAttempt !== ref.attempt) continue;
        const attempt = store.attempt(ref);
        if (
          !['running', 'waiting', 'exited'].includes(attempt.state) ||
          (attempt.driver && sameProcess(attempt.driver)) ||
          !ownsRunLog(attempt.logPath)
        )
          continue;
        const events = store
          .events(ref.taskId, ref.attempt)
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
        // The adopter becomes the attempt's driver, as a launcher is, and lets the lease go: holding it for the
        // worker's lifetime made every adopted task impossible to stop or retry. A live driver keeps others away.
        const driver = processIdentity();
        if (!driver) throw new Error('Cannot identify driver process');
        if (attempt.state === 'waiting') {
          const message = await this.checkWakeMessage(attempt, store.task(ref.taskId));
          if (!message) continue;
          store.updateAttempt(ref, (current) => {
            current.driver = driver;
          });
          lease.release();
          followed = true;
          adopt(
            this.resumeWaiting(attempt, store.task(ref.taskId), message).catch((error) =>
              this.endAsEnvironment(ref, error),
            ),
          );
          continue;
        }
        store.updateAttempt(ref, (current) => {
          current.driver = driver;
        });
        lease.release();
        followed = true;
        adopt(
          (async () => {
            try {
              // Follow at once, so the stall and start checks watch an adopted worker too; only its exit waits.
              const exited = (
                attempt.process ? waitForProcessGroup(attempt.process, this.policy.process) : Promise.resolve()
              ).then(() => readWorkerExit(attempt.logPath));
              await this.follow({ attempt, exited });
            } catch (error) {
              await this.endAsEnvironment(ref, error);
            }
          })(),
        );
      } catch (error) {
        this.recoveryFailed(ref.taskId, 'worker adoption', error);
      } finally {
        if (!followed) lease.release();
      }
    }
    await Promise.all(follows);
    // The host resumes pending retries and keeps sweeping while their workers run. A command leaves them to the host, as
    // it leaves released tasks: a retry command ran other tasks' pending retries first, waited for capacity on their
    // behalf and followed their workers, and started its own task 25 minutes later.
    if (adoptRunning) this.resumePendingRetries();
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
      const summary = store.goalStatus(goal);
      if (!summary.hasDependencies || summary.inFlight || !summary.latestTaskId) continue;
      const terminal = store.task(summary.latestTaskId);
      if (!terminal.currentAttempt) continue;
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
      capacity = false,
      retryDelayMs = 0;
    let releasedIncidents = false;
    let hasSharedIncident = false;
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
      if (kind) {
        releasedIncidents = resolveToolIncidentsAfterAttempt(store, ref, task, attempt).length > 0 || releasedIncidents;
        const detail = `${attempt.result ?? ''}\n${attempt.blocker ?? ''}`;
        capacity = kind === 'tool' && Boolean(agentAdapter(attempt.profile.cli).signals?.(detail).capacity);
        if (kind === 'tool' && !capacity)
          hasSharedIncident = Boolean(
            recordToolBlockerFailure(store, task, attempt, this.tasks.settings, this.inbox).incident,
          );
      }
      if (task.brief.kind === 'verification') {
        if (store.events(task.id, ref.attempt).some((event) => event.kind === 'proof-failure-routed')) return;
        store.updateTask(ref, (current) => {
          current.state = 'stopped';
        });
        const event = {
          managerId: task.brief.manager,
          taskId: task.id,
          kind: 'instruction' as const,
          summary:
            `Original proof stopped; create a separate minimal product fix. ${attempt.result} ${attempt.blocker ?? ''}`.slice(
              0,
              1000,
            ),
          evidencePath: attempt.evidencePath,
        };
        store.event(ref, 'proof-failure-routed', event);
        this.inbox.deliver(event);
        return;
      }
      if (!kind) return;
      const existingRefusal = store.events(task.id, ref.attempt).find((event) => event.kind === 'usage-limit-refusal');
      let retrySamePool = false;
      if (existingRefusal) {
        const body = JSON.parse(existingRefusal.body) as { disposition?: string; pauseMs?: number };
        retrySamePool = body.disposition === 'retry-same-pool';
        retryDelayMs = body.pauseMs ?? 0;
      }
      if (store.events(task.id, ref.attempt).some((event) => event.kind === 'attempt-exit-classified')) {
        // A retry decided before the retry intent existed, and lost with its process, is queued again.
        if (task.state === 'running' && task.currentAttempt === ref.attempt && !store.retryIntent(ref))
          queueRetry(this.exitRetryOptions(attempt, attempt.evidencePath));
        return;
      }
      const previous = ref.attempt > 1 ? store.attempt({ taskId: ref.taskId, attempt: ref.attempt - 1 }) : null;
      let usageLimitRefusal = false;
      let usageLimitExhausted = false;
      if (kind === 'pool-exhausted') {
        const measurement = readMeasurement(attempt, {
          policy: this.tasks.settings.policy ?? defaultPolicy,
          configDirectory: this.tasks.settings.pools.find((pool) => pool.name === attempt.pool)?.configDirectory,
        });
        usageLimitRefusal =
          measurement.usageLimitRefusal ||
          agentAdapter(attempt.profile.cli).signals?.(`${attempt.result}\n${attempt.blocker ?? ''}`).usageLimit ===
            true;
        if (usageLimitRefusal && !existingRefusal) {
          const pool = this.tasks.settings.pools.find((candidate) => candidate.name === attempt.pool);
          const now = Date.now();
          const assessment = pool
            ? assessUsageLimitRefusal(attempt.after, attempt.before, pool, now, this.tasks.settings.policy?.provider)
            : { confirmedExhaustion: true, reason: 'reading-unavailable' as const, reading: attempt.after };
          const priorRefusals = store
            .events()
            .filter(
              (event) =>
                event.kind === 'usage-limit-refusal' &&
                Date.parse(event.at) >= now - this.policy.worker.usageLimitRefusalWindowMs,
            )
            .filter((event) => {
              try {
                return (JSON.parse(event.body) as { pool?: string }).pool === attempt.pool;
              } catch {
                return false;
              }
            }).length;
          const refusalCount = priorRefusals + 1;
          const repeatedRefusalThresholdReached = refusalCount >= this.policy.worker.usageLimitRefusals;
          usageLimitExhausted = assessment.confirmedExhaustion || repeatedRefusalThresholdReached;
          retrySamePool = !usageLimitExhausted;
          retryDelayMs = retrySamePool ? this.policy.worker.usageLimitRetryPauseMs : 0;
          const windowEvidence = (assessment.reading?.windows ?? []).map((window, index) => ({
            window:
              window.window ??
              (window.minutes === 300 ? 'primary' : window.minutes === 10080 ? 'secondary' : `window-${index + 1}`),
            usedPercent: window.usedPercent,
            remainingPercent: Math.max(0, 100 - window.usedPercent),
            resetsAt: window.resetsAt,
          }));
          if (usageLimitExhausted && pool) {
            markExhausted(
              this.tasks.settings.stateDirectory,
              pool.allowanceKey,
              now,
              repeatedRefusalThresholdReached ? this.policy.worker.usageLimitExhaustionMs : undefined,
            );
          }
          store.event(ref, 'usage-limit-refusal', {
            pool: attempt.pool,
            allowanceKey: pool?.allowanceKey ?? null,
            detail: `${attempt.result}\n${attempt.blocker ?? ''}`.trim().slice(0, this.policy.worker.summaryCharacters),
            assessment: assessment.reason,
            observedAt: assessment.reading?.observedAt ?? null,
            windows: windowEvidence,
            refusalCount,
            disposition: usageLimitExhausted ? 'exclude-pool' : 'retry-same-pool',
            pauseMs: retryDelayMs,
          });
        } else if (existingRefusal) {
          usageLimitExhausted = !retrySamePool;
        }
      }
      const failureClass = kind === 'tool' || (usageLimitRefusal && retrySamePool) ? 'environment' : kind;
      const record = store.record(ref)!;
      record.outcome = 'stopped';
      const stalledForSilence = attempt.result.startsWith('stalled: no output for ');
      record.escalation = stalledForSilence ? 'stalled' : failureClass;
      record.guardIds = guardIdsForFailure(record.escalation as import('./types.ts').FailureClass);
      store.putRecord(record);
      store.event(ref, 'attempt-exit-classified', { kind: failureClass, detail: attempt.blocker ?? attempt.result });
      store.updateAttempt(ref, (a) => {
        a.escalation = stalledForSilence ? 'stalled' : failureClass;
      });
      const evidencePath = evidenceBundle(task, store.attempt(ref), undefined, store.policy.evidence);
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
        // A provider capacity refusal is not the task's failure: continue after a pause, however often it repeats.
        const detail = `${attempt.result ?? ''}\n${attempt.blocker ?? ''}`;
        const retryOptions = this.exitRetryOptions(attempt, evidencePath);
        if (kind === 'tool' && !capacity) {
          // A tool blocker resumes the same session after a backoff by its fingerprint. The same blocker twice in a
          // row parks the task with one environment event, whether or not the worker reran the failing command.
          // Product work on dev also stops after two consecutive attempts without a new commit; other work keeps
          // stopping when the worker did not rerun the failing command.
          const silence = attempt.result.startsWith('stalled: no output for ');
          const fingerprint = blockerFingerprint(attempt, task.worktree, store.policy.worker);
          const repeated =
            Boolean(fingerprint) &&
            previous?.failureKind === 'tool' &&
            blockerFingerprint(previous, task.worktree, store.policy.worker) === fingerprint;
          const unrerun =
            !devProductBrief(task.brief) &&
            previous?.failureKind === 'tool' &&
            !reranFailingCommand(task, attempt, previous, this.policy.worker);
          const idle = !repeated && !unrerun && devProductBrief(task.brief) && noProgressTwice(store, task, ref);
          if ((repeated || unrerun || idle) && !hasSharedIncident) {
            const firstLine = (
              silence
                ? attempt.result
                : attempt.blocker || attempt.result || 'Worker reported a tool failure without details'
            ).split(/\r?\n/, 1)[0]!;
            store.event(ref, 'repeated-tool-failure', {
              current: { attempt: attempt.attempt, detail: attempt.blocker ?? attempt.result },
              previous: previous ? { attempt: previous.attempt, detail: previous.blocker ?? previous.result } : null,
              fingerprint,
              cause: repeated ? 'same-blocker' : idle ? 'no-new-commit' : 'not-rerun',
            });
            store.updateTask(ref, (t) => {
              t.state = 'stopped';
            });
            store.updateAttempt(ref, (a) => {
              a.escalation = 'stalled';
            });
            record.escalation = 'stalled';
            store.putRecord(record);
            const event =
              repeated && !silence
                ? {
                    ...stopEvent(
                      task,
                      `environment: the same tool blocker twice; task parked: ${firstLine}`,
                      evidencePath,
                    ),
                    kind: 'environment' as const,
                  }
                : stopEvent(
                    task,
                    silence
                      ? firstLine
                      : idle
                        ? `No new commit in two consecutive attempts: ${firstLine}`
                        : `Repeated tool failure: ${firstLine}`,
                    evidencePath,
                    this.policy.worker,
                  );
            store.event(ref, 'manager-event', event);
            this.inbox.deliver(event);
            return;
          }
          retryDelayMs = toolRetryDelay(store, this.tasks.settings, ref, fingerprint);
          if (retryDelayMs) retryOptions.notBefore = new Date(Date.now() + retryDelayMs).toISOString();
          if (hasSharedIncident) retryDelayMs = 0;
          if (CHECK_HOST_TRANSPORT.test(detail)) retryOptions.awaitCheckHosts = true;
        }
        if (kind === 'pool-exhausted' && !usageLimitRefusal) {
          const key = this.tasks.settings.pools.find((pool) => pool.name === attempt.pool)?.allowanceKey;
          if (key) markExhausted(this.tasks.settings.stateDirectory, key);
        }
        if (usageLimitRefusal) {
          store.updateAttempt(ref, (value) => {
            value.failureKind = retrySamePool ? 'tool' : 'pool-exhausted';
            value.escalation = retrySamePool ? 'environment' : 'pool-exhausted';
          });
          record.escalation = retrySamePool ? 'environment' : 'pool-exhausted';
          store.putRecord(record);
        }
        queueRetry(retryOptions);
      }
    });
    if (releasedIncidents) this.resumePendingRetries();
    // The recovery sweep calls this while it holds the task's lease, which the retry takes: start after it is released.
    if (retry)
      this.track(
        new Promise<void>((done) => {
          const delay = retryDelayMs || (capacity ? this.policy.worker.capacityPauseMs : 0);
          if (delay) setTimeout(done, delay);
          else setImmediate(done);
        }).then(() => this.runRetryIntent(ref)),
      );
  }
  private exitRetryOptions(attempt: Attempt, evidencePath: string): RetryOptions {
    const kind = attempt.failureKind!;
    const options: RetryOptions = {
      evidence: evidencePath,
      escalation: kind === 'tool' ? 'environment' : kind,
      fixRound: attempt.fixRound,
    };
    const refusal = this.tasks.store
      .events(attempt.taskId, attempt.attempt)
      .find((event) => event.kind === 'usage-limit-refusal');
    const retrySamePool = refusal
      ? (JSON.parse(refusal.body) as { disposition?: string }).disposition === 'retry-same-pool'
      : false;
    if (retrySamePool) options.escalation = 'environment';
    if (kind === 'pool-exhausted' && !retrySamePool) {
      const key = this.tasks.settings.pools.find((pool) => pool.name === attempt.pool)?.allowanceKey;
      options.excludePools = this.tasks.settings.pools
        .filter((pool) => pool.allowanceKey === key)
        .map((pool) => pool.name);
    }
    return options;
  }
  onDevLandingTranspileHandoff(handoff: DevLandingTranspileHandoff): void {
    const store = this.tasks.store;
    const ref = { taskId: handoff.taskId, attempt: handoff.attempt };
    store.assertCurrent(ref);
    const task = store.task(ref.taskId);
    const record = store.record(ref);
    if (!record) throw new Error('dev landing repair handback requires a settled worker record');
    const architectureRepair = handoff.guard === 'dev-landing-architecture';
    const schemaRepair = handoff.guard === 'dev-landing-schema';
    const kernelImportRepair = handoff.guard === 'dev-landing-kernel-import';
    const location = `${handoff.diagnostic.file ?? handoff.typescriptFiles[0]}${handoff.diagnostic.line ? `:${handoff.diagnostic.line}` : ''}${handoff.diagnostic.column ? `:${handoff.diagnostic.column}` : ''}`;
    const diagnostic = [
      architectureRepair
        ? `Architecture check rejected dev candidate ${handoff.candidate} based on ${handoff.base}.`
        : schemaRepair
          ? `Schema dump regeneration rejected dev candidate ${handoff.candidate} based on ${handoff.base}.`
          : kernelImportRepair
            ? `Kernel entry import rejected dev candidate ${handoff.candidate} based on ${handoff.base}.`
            : `Bun rejected dev candidate ${handoff.candidate} based on ${handoff.base}.`,
      `Original source commit: ${handoff.sourceCommit}. Task ${handoff.taskId} attempt ${handoff.attempt}.`,
      architectureRepair
        ? `Architecture check failures (manifest, parser or boundary ratchet; boundary violations land and are repaired separately):\n${handoff.diagnostic.message}`
        : schemaRepair
          ? `Regeneration error: ${handoff.diagnostic.message}`
          : kernelImportRepair
            ? `Import error (${handoff.entryPoint ?? 'services/kernel/src/server.ts'}): ${location}: ${handoff.diagnostic.message}`
            : `Compiler error: ${location}: ${handoff.diagnostic.message}`,
      architectureRepair
        ? `Retained architecture log: ${handoff.logPath}`
        : schemaRepair
          ? `Retained regeneration log: ${handoff.logPath}`
          : kernelImportRepair
            ? `Retained import log: ${handoff.logPath}`
            : `Retained compiler log: ${handoff.logPath}`,
      kernelImportRepair && handoff.argv?.length ? `Argv: ${JSON.stringify(handoff.argv)}` : '',
      architectureRepair
        ? `Changed paths: ${handoff.changedFiles.join(', ')}`
        : schemaRepair
          ? `Changed files: ${handoff.changedFiles.join(', ')}`
          : kernelImportRepair
            ? `Changed Kernel source files: ${handoff.typescriptFiles.join(', ')}`
            : `Changed TypeScript files: ${handoff.typescriptFiles.join(', ')}`,
      `Repair ${schemaRepair ? 'the migration' : 'this source'} in place, then return through normal landing preparation in this same task session.`,
    ]
      .filter(Boolean)
      .join('\n');
    let schedule = false;
    store.write(ref, () => {
      if (store.events(ref.taskId, ref.attempt).some((event) => event.kind === 'dev-landing-transpile-returned'))
        return;
      record.guardIds = [...new Set<GuardId>([...(record.guardIds ?? []), handoff.guard])];
      store.putRecord(record);
      store.event(ref, 'dev-landing-transpile-returned', {
        entryId: handoff.entryId,
        sourceCommit: handoff.sourceCommit,
        candidate: handoff.candidate,
        base: handoff.base,
        guard: handoff.guard,
        diagnostic,
        compilerDiagnostic: handoff.diagnostic,
        logPath: handoff.logPath,
      });
      recordFlow(store.db, {
        ...ref,
        stage: 'landing',
        action: architectureRepair ? 'dev-architecture' : kernelImportRepair ? 'dev-kernel-import' : 'dev-transpile',
        at: new Date().toISOString(),
        detail: JSON.stringify({
          outcome: 'repair-handback',
          guard: handoff.guard,
          base: handoff.base,
          candidate: handoff.candidate,
          changedFileCount: handoff.changedFiles.length,
          typescriptFileCount: handoff.typescriptFiles.length,
          kernelFileCount: kernelImportRepair ? handoff.typescriptFiles.length : undefined,
          elapsedMs: handoff.elapsedMs,
          setupMs: handoff.setupMs ?? null,
          importMs: handoff.importMs ?? null,
          cleanupMs: handoff.cleanupMs ?? null,
          logPath: handoff.logPath,
          diagnostic: handoff.diagnostic,
          sourceCommit: handoff.sourceCommit,
          entryPoint: handoff.entryPoint,
          argv: handoff.argv,
        }),
      });
      if (task.state === 'landing') store.updateTask(ref, (current) => (current.state = 'ready'));
      const existing = store.retryIntent(ref);
      if (existing) {
        if (existing.status !== 'pending')
          throw new Error('dev landing repair handback found a non-pending retry intent');
        store.updateRetryIntent(ref, (intent) => {
          intent.options.landingDiagnostic = diagnostic;
        });
      } else {
        store.saveRetryIntent(ref, { landingDiagnostic: diagnostic });
      }
      schedule = true;
    });
    if (schedule) this.track(this.runRetryIntent(ref));
  }
  onGateOutcome(outcome: GateOutcome): void {
    const store = this.tasks.store;
    ensureGateOutcomeRefusal(outcome);
    // Stale gate results must be refused to their caller, not silently discarded.
    store.assertCurrent(outcome);
    const task = store.task(outcome.taskId),
      attempt = store.attempt(outcome);
    const record = store.record(outcome);
    if (!record) throw new Error('attempt must be settled before gate outcomes');
    let action: (() => Promise<void>) | undefined;
    let released: string[] = [];
    store.write(outcome, () => {
      const events = store.events(task.id, outcome.attempt);
      const previous = events.findLast(
        (event) => event.kind === 'gate-outcome' && JSON.parse(event.body).stage === outcome.stage,
      );
      const reconciled =
        outcome.stage === 'merge' &&
        previous !== undefined &&
        events.some((event) => event.kind === 'false-integration-reconciled' && event.sequence > previous.sequence);
      const duplicate = previous !== undefined && !reconciled;
      if (duplicate) {
        if (!outcome.passed && outcome.stage === 'gate' && store.retryIntent(outcome)?.status === 'pending')
          action = async () => this.runRetryIntent(outcome);
        return;
      }
      store.event(outcome, 'gate-outcome', outcome);
      if (
        outcome.devTranspile &&
        !store.events(outcome.taskId, outcome.attempt).some((event) => event.kind === 'dev-landing-transpile-recorded')
      ) {
        store.event(outcome, 'dev-landing-transpile-recorded', outcome.devTranspile);
        recordFlow(store.db, {
          taskId: outcome.taskId,
          attempt: outcome.attempt,
          stage: 'landing',
          action: 'dev-transpile',
          at: new Date().toISOString(),
          detail: JSON.stringify(outcome.devTranspile),
        });
      }
      if (
        outcome.devKernelImport &&
        !store
          .events(outcome.taskId, outcome.attempt)
          .some((event) => event.kind === 'dev-landing-kernel-import-recorded')
      ) {
        store.event(outcome, 'dev-landing-kernel-import-recorded', outcome.devKernelImport);
        recordFlow(store.db, {
          taskId: outcome.taskId,
          attempt: outcome.attempt,
          stage: 'landing',
          action: 'dev-kernel-import',
          at: new Date().toISOString(),
          detail: JSON.stringify(outcome.devKernelImport),
        });
      }
      record.diffLines = outcome.diffLines;
      record.changedFiles = [...outcome.changedFiles];
      // Declared paths say where the work is expected, not a fence: the record keeps every file changed outside them.
      const outsidePaths = outcome.changedFiles.filter(
        (path) => !matchesPath(path, task.brief.paths, this.policy.brief),
      );
      if (outsidePaths.length) record.outsidePaths = outsidePaths;
      else delete record.outsidePaths;
      // Product work on dev may outgrow its estimate; the record keeps the overrun instead of a scope stop.
      const overrun = devProductBrief(task.brief) ? estimateOverrun(outcome, task, this.policy.brief) : undefined;
      if (overrun) record.estimateOverrun = overrun;
      else delete record.estimateOverrun;
      record.hostMs = (record.hostMs ?? 0) + outcome.hostMs;
      record.firstFailure = outcome.firstFailure?.fingerprint ?? null;
      record.outcome = outcome.passed ? 'passed' : 'gate-failed';
      if (outcome.passed) {
        if (!record.guardIds?.some(isDevLandingRepairGuard)) delete record.guardIds;
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
          recordChainOffer(store.db, task, store.attempt(outcome), new Date().toISOString(), this.policy.records);
          released = this.releaseMetDependents();
          if (outcome.frozenAcceptanceChanges?.length) {
            const paths = canonicalConflictPaths(outcome.frozenAcceptanceChanges);
            const event = {
              managerId: task.brief.manager,
              taskId: task.id,
              from: `worker:${task.id}`,
              kind: 'info' as const,
              summary: `Frozen acceptance file changed: ${paths.join(', ')}`,
            };
            store.event(outcome, 'manager-event', event);
            this.inbox.deliver(event);
          }
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
          const goalSummary = store.goalStatus(task.brief.goal);
          if (goalSummary.hasDependencies && !goalSummary.inFlight) {
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
        const files = rebaseConflictFiles(outcome);
        const failure = outcome.firstFailure
          ? {
              ...outcome.firstFailure,
              excerpt: files.length
                ? `${outcome.firstFailure.excerpt}\nConflicted files: ${files.join(', ')}`
                : outcome.firstFailure.excerpt,
            }
          : null;
        store.updateAttempt(outcome, (a) => {
          a.failure = failure;
          a.failureCommand = outcome.failedCommand ? [...outcome.failedCommand] : null;
          a.failureOnBase = outcome.failsOnMain ?? null;
          a.failureLogPath = outcome.logPath;
          a.approaches.push({
            approach: `Attempt ${a.attempt}: ${a.profile.model}/${a.profile.effort}`,
            result: failure ? `${failure.assertion}: ${failure.excerpt}` : 'Failed at rebase',
          });
        });
        const evidencePath = evidenceBundle(task, store.attempt(outcome), undefined, store.policy.evidence);
        if (outcome.controlPlaneConflictRepeated) {
          record.escalation = 'spec-conflict';
          store.updateAttempt(outcome, (a) => {
            a.escalation = 'spec-conflict';
          });
          store.updateTask(outcome, (current) => {
            current.state = 'stopped';
          });
          const event = {
            managerId: task.brief.manager,
            taskId: task.id,
            kind: 'spec-conflict' as const,
            summary:
              'spec-conflict: quarantined after the same control-plane propagation conflict repeated without progress; release refs remain unchanged.',
            evidencePath,
          };
          store.event(outcome, 'manager-event', event);
          this.inbox.deliver(event);
          store.putRecord(record);
          return;
        }
        if (outcome.refusal?.kind === 'frozen-acceptance-change') {
          const paths = canonicalConflictPaths(outcome.refusal.paths);
          const detail = `frozen acceptance files changed: ${paths.join(', ')}`;
          record.escalation = 'spec-conflict';
          store.updateAttempt(outcome, (a) => {
            a.escalation = 'spec-conflict';
          });
          store.updateTask(outcome, (current) => {
            current.state = 'stopped';
          });
          const event = {
            managerId: task.brief.manager,
            taskId: task.id,
            kind: 'spec-conflict' as const,
            summary: `spec-conflict: ${detail}`,
            evidencePath,
          };
          store.event(outcome, 'manager-event', event);
          this.inbox.deliver(event);
          store.putRecord(record);
          return;
        }
        // Only an identical complete Git conflict is evidence that the resolution attempt made no progress.
        // Historical outcomes without captured target/source/files remain unknown and cannot trigger this guard.
        const priorConflictContexts = store
          .attempts(task.id)
          .filter((prior) => prior.attempt < outcome.attempt)
          .slice(-REBASE_CONFLICT_HISTORY_LIMIT)
          .map((prior) => {
            const priorOutcome = store.events(task.id, prior.attempt).find((event) => event.kind === 'gate-outcome');
            if (!priorOutcome) return undefined;
            try {
              const body = JSON.parse(priorOutcome.body) as { stage?: unknown; rebaseConflict?: unknown };
              return body.stage === 'rebase' ? completeRebaseConflictContext(body.rebaseConflict) : undefined;
            } catch {
              return undefined;
            }
          });
        // Product work on dev resumes its session after every conflict while it makes progress: the same conflict as
        // the previous attempt, or two consecutive attempts without a new commit, stop it. Other work stops after the
        // third identical conflict.
        const devProduct = devProductBrief(task.brief);
        const repeatedConflict = devProduct
          ? sameRebaseConflict(outcome.rebaseConflict, priorConflictContexts.at(-1))
            ? completeRebaseConflictContext(outcome.rebaseConflict)
            : undefined
          : repeatedNoProgressConflict(outcome.rebaseConflict, priorConflictContexts);
        if (!repeatedConflict && devProduct && noProgressTwice(store, task, outcome)) {
          record.escalation = 'stalled';
          store.updateAttempt(outcome, (a) => {
            a.escalation = 'stalled';
          });
          store.updateTask(outcome, (t) => {
            t.state = 'stopped';
          });
          const event = stopEvent(
            task,
            `No new commit in two consecutive attempts: rebase conflict in ${files.join(', ') || 'unknown files'}`,
            evidencePath,
            this.policy.worker,
          );
          store.event(outcome, 'manager-event', event);
          this.inbox.deliver(event);
        } else if (repeatedConflict) {
          record.escalation = 'spec-conflict';
          store.updateAttempt(outcome, (a) => {
            a.escalation = 'spec-conflict';
          });
          store.updateTask(outcome, (t) => {
            t.state = 'stopped';
          });
          const detail =
            `target ${repeatedConflict.targetHead}; worker ${repeatedConflict.workerCommit}; ` +
            `files: ${repeatedConflict.paths.join(', ')}`;
          const event = {
            managerId: task.brief.manager,
            taskId: task.id,
            kind: 'spec-conflict' as const,
            summary: `spec-conflict: repeated unchanged rebase conflict; ${detail}`.replace(/[\r\n]+/g, ' '),
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
      const limits = readRouting(this.tasks.settings.routingFile, this.tasks.settings.policy?.routing).classes[
        task.taskClass as Exclude<typeof task.taskClass, 'mechanical'>
      ];
      // A control-plane landing checks the whole control-plane tree, beyond the task's estimated diff size. A failed
      // check is still the task's gate failure; retain scope-growth for an actual changed path outside the brief.
      const controlPlaneGate =
        controlPlaneReleaseBrief(task.brief) &&
        outcome.stage === 'gate' &&
        outcome.changedFiles.every((path) => matchesPath(path, task.brief.paths, this.policy.brief));
      const classificationOutcome = controlPlaneGate
        ? { ...outcome, diffLines: 0, nonGeneratedDiffLines: 0, nonGeneratedChangedFiles: [] }
        : outcome;
      const failureClass = classifyFailure(
        classificationOutcome,
        task,
        attempt,
        record,
        limits,
        this.hasCommit(outcome),
        this.policy.brief,
      );
      record.guardIds = [
        ...new Set([
          ...guardIdsForFailure(failureClass, outcome.refusal),
          ...(record.guardIds ?? []).filter(isDevLandingRepairGuard),
        ]),
      ];
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
      const evidencePath = evidenceBundle(task, store.attempt(outcome), undefined, store.policy.evidence);
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
        // A landing failure of product work on dev resumes the same session with the error while the attempts make
        // progress. The same failure twice, or two consecutive attempts without a new commit, stop it instead.
        if (devProductBrief(task.brief)) {
          const repeated = failureClass === 'repeated-assertion';
          if (repeated || noProgressTwice(store, task, outcome)) {
            record.escalation = 'stalled';
            store.putRecord(record);
            store.updateTask(outcome, (t) => {
              t.state = 'stopped';
            });
            store.updateAttempt(outcome, (a) => {
              a.escalation = 'stalled';
            });
            const failure = outcome.firstFailure?.assertion ?? `failed at ${outcome.stage}`;
            const event = stopEvent(
              task,
              repeated
                ? `Repeated landing failure: ${failure}`
                : `No new commit in two consecutive attempts: ${failure}`,
              evidencePath,
              this.policy.worker,
            );
            store.event(outcome, 'manager-event', event);
            this.inbox.deliver(event);
            return;
          }
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
    if (task.state === 'verified') return;
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
    await this.follow({ attempt, exited: waitForWorkerExit(attempt.process, attempt.logPath, this.policy.process) });
  }
  async consultTask(taskId: string): Promise<void> {
    const task = this.tasks.store.task(taskId),
      ref = { taskId, attempt: task.currentAttempt };
    this.tasks.store.assertCurrent(ref);
    const path = evidenceBundle(task, this.tasks.store.attempt(ref), undefined, this.tasks.store.policy.evidence);
    const answer = await this.consultation(this.tasks, ref, path);
    await this.start(taskId, { evidence: path, consultation: answer, consulted: true, escalation: 'consultation' });
  }
}
