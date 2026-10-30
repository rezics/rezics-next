import { expect, test } from 'bun:test';
import type { GateOutcome, ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';

const conflict = (taskId: string, attempt: number): GateOutcome => ({
  taskId,
  attempt,
  passed: false,
  stage: 'rebase',
  firstFailure: {
    fingerprint: 'rebase',
    assertion: 'could not apply 1234567... CONFLICT (content): Merge conflict in result.txt',
    excerpt: 'CONFLICT (content): Merge conflict in result.txt',
  },
  logPath: 'fixture',
  hostMs: 1,
  changedFiles: ['result.txt'],
  diffLines: 1,
});

test('a rebase conflict starts a same-profile resolution attempt and legacy outcomes without Git context keep retrying', async () => {
  const h = harness(),
    inbox: ManagerEvent[] = [],
    consultations: string[] = [];
  try {
    const job = new WorkerJob(
      h.tasks,
      { enqueue() {} },
      { deliver: (event) => inbox.push(event) },
      async (_tasks, _ref, directory) => {
        consultations.push(directory);
        return 'advice';
      },
    );
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id);
    await job.drain();
    job.onGateOutcome(conflict(task.id, 1));
    await job.drain();
    const second = h.store.attempt({ taskId: task.id, attempt: 2 });
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(second.escalation).toBe('rebase-conflict');
    expect(second.fixRound).toBe(0);
    expect(second.profile).toEqual(h.store.attempt({ taskId: task.id, attempt: 1 }).profile);
    expect(consultations).toEqual([]);
    expect(inbox).toEqual([]);
    job.onGateOutcome(conflict(task.id, 2));
    await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(3);
    expect(h.store.attempt({ taskId: task.id, attempt: 3 }).profile).toEqual(second.profile);
    expect(consultations).toEqual([]);
    expect(inbox).toEqual([]);
  } finally {
    h.dispose();
  }
});
