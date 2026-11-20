import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { readControlPolicy } from './policy.ts';
import { harness } from './test-support.ts';

test('one task whose recovery fails does not stop the sweep: its peer starts and the failure is reported once', async () => {
  const h = harness();
  const inbox: ManagerEvent[] = [];
  try {
    h.settings.policy = readControlPolicy({ capacity: { pollIntervalMs: 20 } });
    const broken = h.tasks.dispatch(h.writeBrief('Ready task with an unreadable lease owner.'));
    const healthy = h.tasks.dispatch(h.writeBrief('Independent ready task with a valid worktree.'));
    // Exercise orphan eligibility without shortening the launched worker's startup grace.
    for (const task of [broken, healthy])
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (row) => {
        row.createdAt = new Date(0).toISOString();
      });
    // An unreadable lease owner makes this task's own recovery throw before its peer is reached.
    const lease = join(h.settings.stateDirectory, 'leases', broken.id);
    const malformedOwner = '{"pid":"not a process"}';
    mkdirSync(lease, { recursive: true });
    writeFileSync(join(lease, 'owner.json'), malformedOwner);
    const sentinel = join(broken.worktree, 'sentinel');
    writeFileSync(sentinel, 'preserved');
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.recoverOrphans();
    await job.drain();
    await job.recoverOrphans();
    await job.drain();
    expect(h.store.task(healthy.id).currentAttempt).toBe(1);
    expect(h.store.task(broken.id).currentAttempt).toBe(0);
    const reports = inbox.filter((event) => event.taskId === broken.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.summary).toContain('recovery step first start');
    expect(reports[0]!.summary).toContain('Unrecognised lease owner');
    expect(readFileSync(join(lease, 'owner.json'), 'utf8')).toBe(malformedOwner);
    expect(readFileSync(sentinel, 'utf8')).toBe('preserved');
  } finally {
    await h.disposeAsync();
  }
});
