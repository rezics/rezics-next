import type { LandingQueue } from './contracts.ts';
import { makeRecord, readMeasurement, reportedApproaches } from './records.ts';
import { evidenceBundle } from './evidence.ts';
import { terminateProcessGroup } from './process.ts';
import type { RunningWorker } from './launch.ts';
import type { WorkerTasks } from './tasks.ts';

/** Await the OS child notification. No model, interval, or sleep loop participates in settlement. */
export async function settle(tasks: WorkerTasks, worker: Pick<RunningWorker, 'attempt' | 'exited'>, landing: LandingQueue): Promise<void> {
  const ref = worker.attempt;
  let code: number | null;
  try { code = (await worker.exited).code; }
  catch { code = -1; }
  const store = tasks.store;
  store.assertCurrent(ref);
  await terminateProcessGroup(store.attempt(ref).process, tasks.settings.terminationGraceMs);
  store.write(ref, () => {
    if (store.events(ref.taskId).some(event => event.attempt === ref.attempt && event.kind === 'landing-requested')) return;
    const pool = tasks.settings.pools.find(p => p.name === ref.pool);
    const attempt = store.updateAttempt(ref, a => {
      a.state = 'exited'; a.endedAt = new Date().toISOString(); a.exitCode = code; a.after = pool ? tasks.reader(pool) : null;
    });
    const measurement = readMeasurement(attempt);
    store.updateAttempt(ref, a => { a.session = measurement.session; a.result = measurement.result; a.blocker = measurement.blocker; a.approaches.push(...reportedApproaches(measurement.result)); });
    const task = store.task(ref.taskId);
    store.putRecord(makeRecord(task, attempt, measurement));
    evidenceBundle(task, store.attempt(ref));
    store.write(ref, () => {
      store.updateTask(ref, t => { t.state = 'landing'; });
      store.landing({ taskId: task.id, attempt: ref.attempt, branch: task.branch, worktree: task.worktree,
        declaredPaths: task.brief.paths, gate: task.brief.acceptance.command }, request => landing.enqueue(request));
    });
  });
}
