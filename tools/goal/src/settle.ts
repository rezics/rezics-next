import type { LandingQueue } from './contracts.ts';
import { readFileSync } from 'node:fs';
import {
  makeRecord,
  POOL_EXHAUSTED,
  readLogTail,
  readMeasurement,
  reportedApproaches,
  reportsSuccess,
} from './records.ts';
import { recordClaudeRateLimit } from './usage.ts';
import { evidenceBundle } from './evidence.ts';
import { stopProcessesUnder, terminateProcessGroup } from './process.ts';
import { attemptEnvironment, workerEnvironment, type RunningWorker } from './launch.ts';
import { matchesPath } from './briefs.ts';
import { changedFiles } from './merge.ts';
import { taskChangedPaths } from './workspace.ts';
import { runAffectedTest } from './merge-train.ts';
import { removeAttemptContainers } from './worker-containers.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import type { WorkerTasks } from './tasks.ts';
import { git } from './tasks.ts';

/** Await the worker's exit notification. No model, interval, or sleep loop participates in settlement. */
export async function settle(
  tasks: WorkerTasks,
  worker: Pick<RunningWorker, 'attempt' | 'exited'>,
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
      if (pendingChecks?.length) {
        store.updateAttempt(ref, (attempt) => {
          attempt.state = 'waiting';
          attempt.checks = pendingChecks;
          attempt.process = null;
          attempt.driver = null;
          attempt.exitCode = code;
          attempt.session =
            readMeasurement(current, { configDirectory: pool?.configDirectory }).session ?? attempt.session;
        });
        return;
      }
      const attempt = store.updateAttempt(ref, (a) => {
        a.state = 'exited';
        a.endedAt = new Date().toISOString();
        a.exitCode = code;
        a.after = pool ? tasks.reader(pool) : null;
      });
      const measurement = readMeasurement(attempt, { configDirectory: pool?.configDirectory, maxLogBytes: 256 * 1024 });
      if (pool?.cli === 'claude')
        try {
          recordClaudeRateLimit(pool, readLogTail(attempt.logPath));
        } catch {
          /* No log to read. */
        }
      // A CLI can fail before opening a session, so there is no structured event in its JSONL log.
      // Preserve that launch failure on the attempt and keep it out of the landing queue.
      if (
        !measurement.session &&
        code !== null &&
        code !== 0 &&
        !measurement.failureKind &&
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
        measurement.failureKind = POOL_EXHAUSTED.test(stderr) ? 'pool-exhausted' : 'tool';
        measurement.result = stderr || `Worker CLI exited with code ${code} before starting a session`;
      }
      // Only a worker's own final answer, a success report or a stated blocker, lets its branch land. A worker killed
      // mid-work gives none, and its partial worktree must not be committed and integrated as if it had passed.
      if (!measurement.failureKind && !measurement.blocker && !reportsSuccess(measurement.result)) {
        measurement.failureKind = 'tool';
        measurement.result = `Worker ended without a success report (${code === null ? 'killed' : `exit ${code}`}): ${measurement.result.slice(-500)}`;
      }
      store.updateAttempt(ref, (a) => {
        a.session = measurement.session;
        a.result = measurement.result;
        a.blocker = measurement.blocker;
        a.failureKind = measurement.failureKind;
        a.approaches.push(...reportedApproaches(measurement.result));
      });
      store.putRecord(makeRecord(task, attempt, measurement));
      evidenceBundle(task, store.attempt(ref));
      if (measurement.failureKind) return;
      tasks.commitFinishedWork(task, ref.attempt);
      finished = true;
    });
    if (finished) {
      const task = store.task(ref.taskId);
      const pool = tasks.settings.pools.find((p) => p.name === ref.pool)!;
      const files = task.workspace ? taskChangedPaths(task) : changedFiles(task.worktree, task.base);
      const checks = (task.workspace ? [] : (tasks.settings.affectedTests ?? [])).filter((check) =>
        files.some((file) => matchesPath(file, check.paths)),
      );
      // The checks wait outside SQLite's write transaction, so other attempts can finish at the same time.
      await Promise.all(
        checks.map(async (check, index) => {
          if (
            store
              .attempt(ref)
              .affectedTests?.some((result) => JSON.stringify(result.command) === JSON.stringify(check.command))
          )
            return;
          const result = await runAffectedTest(
            check.command,
            task.worktree,
            `${store.attempt(ref).logPath}.affected-${index}.log`,
            workerEnvironment(
              pool,
              {
                ...attemptEnvironment(task, ref, tasks.settings.stateDirectory),
                KERNEL_CHECK_SKIP_STALE_CLEANUP: '1',
              },
              process.env,
              task.worktree,
            ),
          );
          store.updateAttempt(ref, (attempt) => {
            (attempt.affectedTests ??= []).push(result);
          });
        }),
      );
      store.write(ref, () => {
        evidenceBundle(task, store.attempt(ref));
        store.updateTask(ref, (t) => {
          t.state = 'landing';
        });
        const affectedTests = store.attempt(ref).affectedTests ?? [];
        store.landing(
          {
            taskId: task.id,
            attempt: ref.attempt,
            branch: task.branch,
            worktree: task.worktree,
            declaredPaths: task.brief.paths,
            protectedPaths: tasks.protectedPaths(task.brief),
            gate: task.brief.acceptance.command,
            ...(affectedTests.length ? { affectedTests } : {}),
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
