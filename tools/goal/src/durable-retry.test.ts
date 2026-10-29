import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { harness, markdown } from './test-support.ts';

test('retry and retry --brief persist the changed brief and pending start intent without waiting for capacity', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    const amended = h.tasks.dispatch(h.briefFile);
    const amendedWorker = await h.tasks.retry(amended.id);
    await amendedWorker.exited;
    writeFileSync(join(h.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 0 }));
    const changed = join(h.root, '.temp/goal/changed.md');
    writeFileSync(changed, markdown.replace('Write the requested result and commit it.', 'Write the revised result and commit it.'));
    const start = Date.now();
    await runWorkerCommand('retry', [task.id], { tasks: h.tasks, print() {} });
    await runWorkerCommand('retry', [amended.id, '--brief', changed], { tasks: h.tasks, print() {} });
    expect(Date.now() - start).toBeLessThan(1000);
    const stored = h.store.task(amended.id);
    expect(stored.brief.markdown).toContain('Write the revised result');
    expect(h.store.retryIntent({ taskId: task.id, attempt: h.store.task(task.id).currentAttempt })).toMatchObject({ status: 'pending' });
    expect(h.store.retryIntent({ taskId: amended.id, attempt: stored.currentAttempt })).toMatchObject({ status: 'pending' });
    expect(h.store.retryIntents().filter((intent) => intent.status === 'pending').map((intent) => intent.taskId)).toEqual([
      task.id,
      amended.id,
    ]);
    expect(existsSync(join(h.settings.stateDirectory, 'capacity-queue'))).toBe(false);
  } finally { h.dispose(); }
});

test("the host's recovery tick starts pending intents once after capacity becomes available", async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.tasks.queueRetry(task.id);
    const ref = { taskId: task.id, attempt: h.store.task(task.id).currentAttempt };
    writeFileSync(join(h.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 1 }));
    const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await host.recoverOrphans();
    await host.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(ref.attempt + 1);
    expect(h.store.retryIntent(ref)?.status).toBe('started');
    await host.recoverOrphans();
    await host.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(ref.attempt + 1);
  } finally { h.dispose(); }
});
