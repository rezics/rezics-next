import type { LandingQueue } from './contracts.ts';
import { readFileSync } from 'node:fs';
import { makeRecord, readMeasurement, reportedApproaches } from './records.ts';
import { evidenceBundle } from './evidence.ts';
import { terminateProcessGroup } from './process.ts';
import type { RunningWorker } from './launch.ts';
import type { WorkerTasks } from './tasks.ts';
import { git } from './tasks.ts';

/** Await the OS child notification. No model, interval, or sleep loop participates in settlement. */
export async function settle(tasks: WorkerTasks, worker: Pick<RunningWorker, 'attempt' | 'exited'>, landing: LandingQueue, startTrain: () => Promise<void> = async () => {}): Promise<void> {
  const ref = worker.attempt;
  let code: number | null;
  try { code = (await worker.exited).code; }
  catch { code = -1; }
  const store = tasks.store;
  store.assertCurrent(ref);
  await terminateProcessGroup(store.attempt(ref).process, tasks.settings.terminationGraceMs);
  let queued = false;
  store.write(ref, () => {
    if (store.events(ref.taskId).some(event => event.attempt === ref.attempt && event.kind === 'landing-requested')) { queued = true; return; }
    const task = store.task(ref.taskId);
    const pool = tasks.settings.pools.find(p => p.name === ref.pool);
    const attempt = store.updateAttempt(ref, a => {
      a.state = 'exited'; a.endedAt = new Date().toISOString(); a.exitCode = code; a.after = pool ? tasks.reader(pool) : null;
    });
    const measurement = readMeasurement(attempt);
    // A CLI can fail before opening a session, so there is no structured event in its JSONL log.
    // Preserve that launch failure on the attempt and keep it out of the landing queue.
    if (!measurement.session && code !== null && code !== 0 && !measurement.failureKind
      && !git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`]).trim().match(/^[1-9]\d*$/)) {
      let stderr = '';
      try { stderr = readFileSync(`${attempt.logPath}.err`, 'utf8').trim(); } catch { /* No stderr stream was created. */ }
      measurement.failureKind = 'tool';
      measurement.result = stderr || `Worker CLI exited with code ${code} before starting a session`;
    }
    store.updateAttempt(ref, a => { a.session = measurement.session; a.result = measurement.result; a.blocker = measurement.blocker; a.failureKind = measurement.failureKind; a.approaches.push(...reportedApproaches(measurement.result)); });
    store.putRecord(makeRecord(task, attempt, measurement));
    evidenceBundle(task, store.attempt(ref));
    if (measurement.failureKind) return;
    store.write(ref, () => {
      store.updateTask(ref, t => { t.state = 'landing'; });
      store.landing({ taskId: task.id, attempt: ref.attempt, branch: task.branch, worktree: task.worktree,
        declaredPaths: task.brief.paths, gate: task.brief.acceptance.command }, request => landing.enqueue(request));
    });
    queued = true;
  });
  // Start only after the enqueue transaction commits; a busy train is awaited through its lease.
  if (queued) await startTrain();
}
