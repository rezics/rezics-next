import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';

test('one task whose recovery fails does not stop the sweep: its peer starts and the failure is reported once', async () => {
  const h = harness();
  const inbox: ManagerEvent[] = [];
  try {
    h.settings.startGraceMs = 1;
    const broken = h.tasks.dispatch(h.briefFile);
    const healthy = h.tasks.dispatch(h.briefFile);
    // An unreadable lease owner makes this task's own recovery throw before its peer is reached.
    mkdirSync(join(h.settings.stateDirectory, 'leases', broken.id), { recursive: true });
    writeFileSync(join(h.settings.stateDirectory, 'leases', broken.id, 'owner.json'), '{"pid":"not a process"}');
    await Bun.sleep(5);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.recoverOrphans();
    await job.drain();
    await job.recoverOrphans();
    await job.drain();
    expect(h.store.task(healthy.id).currentAttempt).toBe(1);
    expect(h.store.task(broken.id).currentAttempt).toBe(0);
    const reports = inbox.filter((event) => event.taskId === broken.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.summary).toContain('Unrecognised lease owner');
  } finally {
    h.dispose();
  }
});
