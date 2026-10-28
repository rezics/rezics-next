import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { GateOutcome } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';

test("a gate failure's automatic retry survives the process that recorded it exiting before it ran", async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const first = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await first.start(task.id);
    await first.drain();
    const ref = { taskId: task.id, attempt: 1 };
    h.store.updateAttempt(ref, attempt => { attempt.result = 'Blocked'; attempt.blocker = 'The implementation is incomplete.'; });

    const outcome: GateOutcome = { ...ref, passed: false, stage: 'gate', logPath: 'fixture', hostMs: 1,
      changedFiles: [], diffLines: 1, firstFailure: { fingerprint: 'new', assertion: 'acceptance failed', excerpt: 'expected result', } };
    // The first process exits after committing the outcome and before starting tracked work.
    Object.assign(first, { runRetryIntent: async () => {} });
    first.onGateOutcome(outcome);
    rmSync(join(h.settings.stateDirectory, 'leases', task.id), { recursive: true, force: true });

    const recovered = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await recovered.recoverOrphans();

    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 }).fixRound).toBe(1);
    expect(h.store.retryIntent(ref)?.options).toMatchObject({ escalation: 'new-failure', fixRound: 1 });
    await new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} }).recoverOrphans();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
  } finally { h.dispose(); }
});

test("a command leaves another task's pending retry to the host instead of running it first", async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const first = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await first.start(task.id);
    await first.drain();
    const ref = { taskId: task.id, attempt: 1 };
    h.store.updateAttempt(ref, attempt => { attempt.result = 'Blocked'; attempt.blocker = 'The implementation is incomplete.'; });
    const outcome: GateOutcome = { ...ref, passed: false, stage: 'gate', logPath: 'fixture', hostMs: 1,
      changedFiles: [], diffLines: 1, firstFailure: { fingerprint: 'new', assertion: 'acceptance failed', excerpt: 'expected result', } };
    Object.assign(first, { runRetryIntent: async () => {} });
    first.onGateOutcome(outcome);
    rmSync(join(h.settings.stateDirectory, 'leases', task.id), { recursive: true, force: true });

    // A retry command once ran other tasks' pending retries first and followed their workers for 25 minutes.
    const command = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await command.recoverOrphans({ adoptRunning: false });
    await command.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.retryIntent(ref)?.status).toBe('pending');

    const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await host.recoverOrphans();
    await host.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
  } finally { h.dispose(); }
});
