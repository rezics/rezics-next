import { readProofObservation, proofSourceUnchanged, nativeCheckId } from './verification.ts';
import { createHash } from 'node:crypto';
import { parseAgentExit } from './agents.ts';
import type { LandingQueue } from './contracts.ts';
import { readFileSync } from 'node:fs';
import { makeRecord, readLogTail, readMeasurement, reportedApproaches, reportsSuccess } from './records.ts';
import { agentAdapter } from './agents.ts';
import { evidenceBundle } from './evidence.ts';
import { stopProcessesUnder, terminateProcessGroup } from './process.ts';
import { type RunningWorker } from './launch.ts';
import { removeAttemptContainers } from './worker-containers.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import type { WorkerTasks } from './tasks.ts';
import { git } from './tasks.ts';
import { completeWorkerSourceBaseline } from './conflict-progress.ts';
import { harvestContinuations } from './continuation.ts';
import type { Task } from './types.ts';

function unchangedSource(task: Task, head: string): boolean {
  const frozen = new Set((task as Task & { frozenFiles?: { path: string }[] }).frozenFiles?.map((file) => file.path));
  return !git(task.worktree, ['diff', '--name-only', '-z', task.base, head])
    .split('\0')
    .some((path) => path && !frozen.has(path));
}

const SQLITE_CONTENTION = /SQLITE_(?:BUSY|LOCKED)|database (?:table )?is locked/i;
/** Another process held the store's write lock longer than the busy timeout. */
export function isSqliteContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    (typeof code === 'string' && SQLITE_CONTENTION.test(code)) ||
    (error instanceof Error && SQLITE_CONTENTION.test(error.message))
  );
}
/** The one same-session request for the exit object of a worker that exited 0 without it. */
export const FINAL_REPORT_REQUESTED = 'final-report-requested';
export const FINAL_REPORT_PROMPT =
  'Your last run ended without the required JSON exit object. Do not edit, commit, run commands or checks, or repeat any work. Reply with only the exit object (status, summary, blocker, checks, approaches) for the work this session has already done: success with an empty checks array when your outcome is complete, otherwise blocked with the real blocker.';
/** Whether the attempt waits for its report-only continuation: requested, and no run started since. */
export function finalReportPending(store: WorkerTasks['store'], ref: { taskId: string; attempt: number }): boolean {
  return (
    store
      .events(ref.taskId, ref.attempt)
      .findLast((event) => event.kind === FINAL_REPORT_REQUESTED || event.kind === 'worker-run-started')?.kind ===
    FINAL_REPORT_REQUESTED
  );
}
/** Pauses between settlement write tries; each try already waits the store's busy timeout. */
export const SETTLEMENT_CONTENTION_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * Await the worker's exit notification. No model, interval, or sleep loop participates in settlement. Git and other
 * child processes run outside the store's write transactions, so settlement never holds the lock while they run, and
 * a write that meets another process's lock is retried: contention is not a worker failure.
 */
export async function settle(
  tasks: WorkerTasks,
  worker: Pick<RunningWorker, 'attempt' | 'exited' | 'logStartOffset' | 'resuming'>,
  landing: LandingQueue,
  startTrain: () => Promise<void> = async () => {},
): Promise<void> {
  const ref = worker.attempt;
  let code: number | null;
  try {
    code = (await worker.exited).code;
  } catch {
    code = -1;
  }
  const store = tasks.store;
  const write = async (action: () => void): Promise<void> => {
    for (let index = 0; ; index++) {
      try {
        return store.write(ref, action);
      } catch (error) {
        if (!isSqliteContention(error) || index >= SETTLEMENT_CONTENTION_BACKOFF_MS.length) throw error;
        await Bun.sleep(SETTLEMENT_CONTENTION_BACKOFF_MS[index]!);
      }
    }
  };
  const runEvent = store
    .events(ref.taskId, ref.attempt)
    .filter((event) => event.kind === 'worker-run-started')
    .at(-1);
  let runMetadata: { logStartOffset?: number; resuming?: boolean } = {};
  try {
    runMetadata = runEvent ? (JSON.parse(runEvent.body) as typeof runMetadata) : {};
  } catch {
    /* A malformed historical run marker does not prevent ordinary settlement. */
  }
  const logStartOffset = worker.logStartOffset ?? runMetadata.logStartOffset;
  const resuming = worker.resuming ?? runMetadata.resuming === true;
  let lease;
  try {
    lease = acquireDirectoryLease(`${store.attempt(ref).logPath}.settle`);
  } catch (error) {
    if (error instanceof LeaseHeldError) return; // A live settler will record checks and request landing.
    throw error;
  }
  try {
    // This is the common completion path for normal exits, stops, timeouts and orphan recovery.
    // Stopped or superseded attempts still need Docker cleanup even though they no longer settle records.
    const currentAttempt = store.attempt(ref);
    const poolForAttempt = tasks.settings.pools.find((p) => p.name === ref.pool);
    const pendingChecks = readMeasurement(currentAttempt, {
      configDirectory: poolForAttempt?.configDirectory,
      maxLogBytes: 256 * 1024,
      ...(logStartOffset !== undefined ? { logStartOffset } : {}),
    }).waitingChecks;
    const proofTask = store.task(ref.taskId).brief.kind === 'verification';
    const proofObservation = proofTask
      ? await readProofObservation(
          store.task(ref.taskId),
          pendingChecks?.length ? pendingChecks : currentAttempt.checks,
        )
      : undefined;
    if (!proofTask && !pendingChecks?.length) removeAttemptContainers(ref.taskId, ref.attempt);
    store.assertCurrent(ref);
    await terminateProcessGroup(store.attempt(ref).process, tasks.settings.terminationGraceMs);
    if (!proofTask && !pendingChecks?.length) {
      if (!store.task(ref.taskId).workspace)
        await stopProcessesUnder(store.task(ref.taskId).worktree, tasks.settings.terminationGraceMs);
    }
    let queued = false;
    let finished = false;
    let exited = false;
    let bundle = false;
    // Whether the branch has commits matters only for a nonzero exit without a session.
    let committed = false;
    if (code !== null && code !== 0)
      try {
        const task = store.task(ref.taskId);
        committed = /^[1-9]\d*$/.test(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`]).trim());
      } catch {
        /* An unreadable branch counts as having no commits. */
      }
    await write(() => {
      if (
        store.events(ref.taskId).some((event) => event.attempt === ref.attempt && event.kind === 'landing-requested')
      ) {
        queued = true;
        return;
      }
      const task = store.task(ref.taskId);
      const pool = tasks.settings.pools.find((p) => p.name === ref.pool);
      const current = store.attempt(ref);
      const endedAt = new Date().toISOString();
      const measurement = readMeasurement(
        { ...current, endedAt },
        {
          configDirectory: pool?.configDirectory,
          ...(logStartOffset !== undefined ? { logStartOffset } : {}),
        },
      );
      if (
        resuming &&
        !proofTask &&
        code !== 0 &&
        !measurement.session &&
        !measurement.failureKind &&
        !measurement.blocker &&
        !reportsSuccess(measurement.result, agentAdapter(current.profile.cli))
      ) {
        let stderr = '';
        try {
          stderr = readFileSync(`${current.logPath}.err`, 'utf8').trim();
        } catch {
          /* The CLI may have failed before creating its stderr stream. */
        }
        const detail = (
          stderr ||
          measurement.result ||
          `Worker CLI exited with code ${code ?? 'unknown'} before starting a session`
        )
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 4000);
        const errorLine = detail.split(/\r?\n/, 1)[0]!.slice(0, 1000);
        const failures = store
          .events(ref.taskId, ref.attempt)
          .filter((event) => event.kind === 'waiting-resume-launch-failed').length;
        store.updateAttempt(ref, (attempt) => {
          attempt.state = 'waiting';
          attempt.process = null;
          attempt.driver = null;
          attempt.exitCode = code;
          attempt.result = detail;
          attempt.failureKind = null;
        });
        store.event(ref, 'waiting-resume-launch-failed', {
          count: failures + 1,
          detail,
          errorLine,
        });
        return;
      }
      const proofExit = proofTask ? parseAgentExit(measurement.result, agentAdapter(current.profile.cli)) : null;
      const waitingId =
        proofExit &&
        typeof proofExit === 'object' &&
        'checks' in proofExit &&
        Array.isArray(proofExit.checks) &&
        proofExit.checks.length === 1 &&
        typeof proofExit.checks[0] === 'string' &&
        nativeCheckId.test(proofExit.checks[0])
          ? proofExit.checks[0]
          : undefined;
      if (
        pendingChecks?.length &&
        (!proofTask ||
          (waitingId &&
            pendingChecks.length === 1 &&
            pendingChecks[0] === waitingId &&
            (proofObservation?.status === 'running' || proofObservation?.status === 'terminal')))
      ) {
        store.updateAttempt(ref, (attempt) => {
          attempt.state = 'waiting';
          attempt.checks = pendingChecks;
          attempt.process = null;
          attempt.driver = null;
          attempt.exitCode = code;
          attempt.session = measurement.session ?? attempt.session;
        });
        return;
      }
      // A worker that exited 0 without its exit object is asked for it once, in the same session and attempt, instead
      // of spending another attempt that repeats its checks. The host resumes it like a check wake.
      const adapter = agentAdapter(current.profile.cli);
      const session = measurement.session ?? current.session;
      if (
        code === 0 &&
        !proofTask &&
        session &&
        adapter.canResume &&
        !measurement.failureKind &&
        !measurement.blocker &&
        !reportsSuccess(measurement.result, adapter) &&
        !store.events(ref.taskId, ref.attempt).some((event) => event.kind === FINAL_REPORT_REQUESTED)
      ) {
        store.updateAttempt(ref, (attempt) => {
          attempt.state = 'waiting';
          attempt.checks = [];
          attempt.process = null;
          attempt.driver = null;
          attempt.exitCode = code;
          attempt.session = session;
          attempt.result = measurement.result;
        });
        store.event(ref, FINAL_REPORT_REQUESTED, { result: measurement.result.slice(-2000) });
        return;
      }
      const attempt = store.updateAttempt(ref, (a) => {
        a.state = 'exited';
        a.endedAt = endedAt;
        a.exitCode = code;
        a.after = pool ? tasks.reader(pool) : null;
      });
      exited = true;
      const finalMeasurement = readMeasurement(attempt, {
        configDirectory: pool?.configDirectory,
        maxLogBytes: 256 * 1024,
        ...(logStartOffset !== undefined ? { logStartOffset } : {}),
      });
      if (pool)
        try {
          agentAdapter(pool.cli).afterExit(pool, readLogTail(attempt.logPath));
        } catch {
          /* No log to read. */
        }
      // A CLI can fail before opening a session, so there is no structured event in its JSONL log.
      // Preserve that launch failure on the attempt and keep it out of the landing queue.
      if (!finalMeasurement.session && code !== null && code !== 0 && !finalMeasurement.failureKind && !committed) {
        let stderr = '';
        try {
          stderr = readFileSync(`${attempt.logPath}.err`, 'utf8').trim();
        } catch {
          /* No stderr stream was created. */
        }
        // Cursor refuses a spent model this way; the pool must be excluded, not the launch retried and stalled.
        finalMeasurement.failureKind = agentAdapter(attempt.profile.cli).signals?.(stderr).allowance
          ? 'pool-exhausted'
          : 'tool';
        finalMeasurement.result = stderr || `Worker CLI exited with code ${code} before starting a session`;
      }
      // Only a worker's own final answer, a success report or a stated blocker, lets its branch land. A worker killed
      // mid-work gives none, and its partial worktree must not be committed and integrated as if it had passed.
      if (
        !finalMeasurement.failureKind &&
        !finalMeasurement.blocker &&
        !reportsSuccess(finalMeasurement.result, agentAdapter(attempt.profile.cli))
      ) {
        finalMeasurement.failureKind = 'tool';
        finalMeasurement.result = `Worker ended without a success report (${code === null ? 'killed' : `exit ${code}`}): ${finalMeasurement.result.slice(-500)}`;
      }
      store.updateAttempt(ref, (a) => {
        a.session = finalMeasurement.session ?? a.session;
        a.result = finalMeasurement.result;
        a.blocker = finalMeasurement.blocker;
        a.failureKind = finalMeasurement.failureKind;
        a.approaches.push(...reportedApproaches(finalMeasurement.result, agentAdapter(attempt.profile.cli)));
      });
      store.putRecord(makeRecord(task, attempt, finalMeasurement));
      bundle = true;
      if (finalMeasurement.failureKind && !proofTask) return;
      if (proofTask && proofObservation) {
        const run = task.proofRun;
        const exit = parseAgentExit(finalMeasurement.result, agentAdapter(attempt.profile.cli));
        const structured = Boolean(
          exit &&
          typeof exit === 'object' &&
          'status' in exit &&
          exit.status === 'success' &&
          'checks' in exit &&
          Array.isArray(exit.checks) &&
          exit.checks.length === 0,
        );
        const unchanged = proofSourceUnchanged(task, tasks.settings.integrationBranch);
        const verified =
          !finalMeasurement.failureKind &&
          !finalMeasurement.blocker &&
          code === 0 &&
          structured &&
          unchanged &&
          proofObservation.status === 'terminal' &&
          proofObservation.passed;
        const proofRecord = makeRecord(task, attempt, finalMeasurement, verified ? 'verified' : 'stopped');
        proofRecord.proof = proofObservation;
        store.putRecord(proofRecord);
        store.updateTask(ref, (current) => {
          current.state = verified ? 'verified' : 'stopped';
        });
        store.updateAttempt(ref, (current) => {
          current.failureKind = verified ? null : 'tool';
          current.result = `${finalMeasurement.result}\n${proofObservation.cause}${unchanged ? '' : '; captured source changed'}`;
        });
        store.releaseExitedProofReservations(ref);
        store.event(ref, verified ? 'proof-verified' : 'proof-failed', {
          binding: run?.binding,
          observation: proofObservation,
          unchanged,
          structured,
        });
        return;
      }
      finished = true;
    });
    if (bundle) evidenceBundle(store.task(ref.taskId), store.attempt(ref));
    if (finished) {
      store.assertCurrent(ref);
      const task = store.task(ref.taskId);
      const branchHead = git(task.worktree, ['rev-parse', `${task.branch}^{commit}`]);
      const dirtyUnchangedSource =
        unchangedSource(task, branchHead) &&
        git(task.worktree, ['status', '--porcelain', '--untracked-files=all']) !== '';
      if (!dirtyUnchangedSource) tasks.commitFinishedWork(task, ref.attempt);
    }
    // Continuation briefs move to the Goal backlog when the attempt ends, whatever its result.
    if (exited)
      try {
        harvestContinuations(store, tasks.settings, store.task(ref.taskId), ref);
      } catch (error) {
        console.error(`Continuation briefs of task ${ref.taskId} attempt ${ref.attempt} were not moved:`, error);
      }
    if (finished) {
      const task = store.task(ref.taskId);
      const branchHead = git(task.worktree, ['rev-parse', `${task.branch}^{commit}`]);
      const sourceBaselineEvent = store
        .events(ref.taskId, ref.attempt)
        .findLast((event) => event.kind === 'worker-source-baseline');
      let workerCommit = branchHead;
      if (sourceBaselineEvent) {
        try {
          const baseline = completeWorkerSourceBaseline(JSON.parse(sourceBaselineEvent.body));
          if (baseline && branchHead === baseline.controllerHead) workerCommit = baseline.workerCommit;
        } catch {
          /* A malformed or legacy source baseline cannot establish historical worker progress. */
        }
      }
      const unchangedClaim = !task.workspace && unchangedSource(task, workerCommit) && branchHead === workerCommit;
      const sourceDirtyAtSettlement =
        unchangedClaim && git(task.worktree, ['status', '--porcelain', '--untracked-files=all']) !== '';
      evidenceBundle(task, store.attempt(ref));
      await write(() => {
        store.updateTask(ref, (t) => {
          t.state = 'landing';
        });
        store.landing(
          {
            taskId: task.id,
            attempt: ref.attempt,
            branch: task.branch,
            worktree: task.worktree,
            workerCommit,
            ...(unchangedClaim
              ? {
                  unchangedClaim: true as const,
                  contractHash: createHash('sha256').update(task.brief.markdown).digest('hex'),
                  ...(sourceDirtyAtSettlement ? { sourceDirtyAtSettlement: true as const } : {}),
                }
              : {}),
            declaredPaths: task.brief.paths,
            protectedPaths: tasks.protectedPaths(task.brief),
            gate: task.brief.acceptance.command,
          },
          (request) => landing.enqueue(request),
        );
      });
      queued = true;
    }
    // Start only after the enqueue transaction commits; a busy train is awaited through its lease.
    if (queued) await startTrain();
  } finally {
    lease.release();
  }
}
