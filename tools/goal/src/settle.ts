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

/** Await the worker's exit notification. No model, interval, or sleep loop participates in settlement. */
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
    if (!pendingChecks?.length) removeAttemptContainers(ref.taskId, ref.attempt);
    store.assertCurrent(ref);
    await terminateProcessGroup(store.attempt(ref).process, tasks.settings.terminationGraceMs);
    if (!pendingChecks?.length) {
      if (!store.task(ref.taskId).workspace)
        await stopProcessesUnder(store.task(ref.taskId).worktree, tasks.settings.terminationGraceMs);
    }
    let queued = false;
    let finished = false;
    store.write(ref, () => {
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
      if (pendingChecks?.length) {
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
      const attempt = store.updateAttempt(ref, (a) => {
        a.state = 'exited';
        a.endedAt = endedAt;
        a.exitCode = code;
        a.after = pool ? tasks.reader(pool) : null;
      });
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
      if (
        !finalMeasurement.session &&
        code !== null &&
        code !== 0 &&
        !finalMeasurement.failureKind &&
        !git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`])
          .trim()
          .match(/^[1-9]\d*$/)
      ) {
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
      evidenceBundle(task, store.attempt(ref));
      if (finalMeasurement.failureKind) return;
      tasks.commitFinishedWork(task, ref.attempt);
      finished = true;
    });
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
      store.write(ref, () => {
        evidenceBundle(task, store.attempt(ref));
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
