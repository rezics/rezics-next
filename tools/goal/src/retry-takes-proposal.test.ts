import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { GateOutcome } from './contracts.ts';
import { consumeApplicableBriefProposal, recordReplacementBrief } from './durable-follow-up.ts';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';

function hash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n').trimEnd()).digest('hex');
}

function replacement(text: string): string {
  return `${markdown.trimEnd()}\n\n${text}\n`;
}

function gateFailure(ref: { taskId: string; attempt: number }): GateOutcome {
  return {
    ...ref,
    passed: false,
    stage: 'gate',
    logPath: 'fixture',
    hostMs: 1,
    changedFiles: [],
    diffLines: 1,
    firstFailure: { fingerprint: 'new', assertion: 'acceptance failed', excerpt: 'expected result' },
  };
}

async function pendingAutomaticRetry(h: ReturnType<typeof harness>) {
  const task = h.tasks.dispatch(h.briefFile);
  const first = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
  await first.start(task.id);
  await first.drain();
  const ref = { taskId: task.id, attempt: 1 };
  h.store.updateAttempt(ref, (attempt) => {
    attempt.result = 'Blocked';
    attempt.blocker = 'The implementation is incomplete.';
  });
  Object.assign(first, { runRetryIntent: async () => {} });
  first.onGateOutcome(gateFailure(ref));
  rmSync(join(h.settings.stateDirectory, 'leases', task.id), { recursive: true, force: true });
  return { task, ref };
}

async function hostRetry(h: ReturnType<typeof harness>) {
  const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
  await host.recoverOrphans();
  await host.drain();
}

test('When a manager has proposed a replacement brief for a task and the controller retries that task automatically, the retry consumes the newest pending proposal (the same validation as retry --brief) instead of relaunching on the old brief.', async () => {
  const h = harness();
  try {
    const { task } = await pendingAutomaticRetry(h);
    recordReplacementBrief(h.store, h.store.task(task.id), replacement('Use the first replacement.'), 1);
    const newest = replacement('Use the newest replacement.');
    recordReplacementBrief(h.store, h.store.task(task.id), newest, 1);
    expect(h.store.task(task.id).brief.markdown).toBe(markdown);
    expect(h.store.pendingBriefProposals(task.id)).toHaveLength(2);

    await hostRetry(h);

    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.task(task.id).brief.markdown).toBe(newest);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 })).toMatchObject({
      previousBriefHash: hash(markdown),
      newBriefHash: hash(newest),
    });
    expect(h.store.pendingBriefProposals(task.id)).toEqual([]);
  } finally {
    const tasks = h.store.tasks();
    if (tasks[0]?.state === 'running') await h.tasks.stop(tasks[0].id);
    h.dispose();
  }
}, 30_000);

test('A proposal written for an earlier attempt of the same task still applies to the current attempt, unless the current attempt already started on a newer brief.', async () => {
  const h = harness();
  try {
    const { task } = await pendingAutomaticRetry(h);
    const later = replacement('Apply this to the later attempt.');
    recordReplacementBrief(h.store, h.store.task(task.id), later, 0);
    await hostRetry(h);
    expect(h.store.task(task.id).brief.markdown).toBe(later);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 }).newBriefHash).toBe(hash(later));

    const newer = replacement('Current attempt already started on this brief.');
    const newerPath = join(h.root, '.temp/goal/already-started.md');
    writeFileSync(newerPath, newer);
    await h.tasks.stop(task.id);
    await runWorkerCommand('retry', [task.id, '--brief', newerPath], { tasks: h.tasks, print() {} });
    expect(h.store.task(task.id).brief.markdown).toBe(newer);
    const stale = replacement('Stale earlier proposal.');
    h.store.saveBriefProposal({
      taskId: task.id,
      writtenForAttempt: 1,
      previousBriefHash: hash(markdown),
      newBriefHash: hash(stale),
      markdown: stale,
      createdAt: new Date().toISOString(),
    });
    expect(consumeApplicableBriefProposal(h.store, h.store.task(task.id))).toBeUndefined();
    expect(h.store.pendingBriefProposals(task.id)).toEqual([]);
    expect(h.store.task(task.id).brief.markdown).toBe(newer);
  } finally {
    const tasks = h.store.tasks();
    if (tasks[0]?.state === 'running') await h.tasks.stop(tasks[0].id);
    h.dispose();
  }
}, 30_000);

test('The consumed proposal is recorded on the attempt and removed from the pending set.', async () => {
  const h = harness();
  try {
    const { task, ref } = await pendingAutomaticRetry(h);
    await hostRetry(h);
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    const changed = replacement('Take this after the automatic retry started.');
    const path = join(h.root, '.temp/goal/stale-generation.md');
    writeFileSync(path, changed);
    await runWorkerCommand('retry', [task.id, '--expected-attempt', String(ref.attempt), '--brief', path], {
      tasks: h.tasks,
      print() {},
    });
    await hostRetry(h);
    const current = h.store.task(task.id);
    expect(current.brief.markdown).toBe(changed);
    expect(h.store.attempt({ taskId: task.id, attempt: current.currentAttempt })).toMatchObject({
      previousBriefHash: hash(markdown),
      newBriefHash: hash(changed),
    });
    expect(h.store.pendingBriefProposals(task.id)).toEqual([]);
  } finally {
    const tasks = h.store.tasks();
    if (tasks[0]?.state === 'running') await h.tasks.stop(tasks[0].id);
    h.dispose();
  }
}, 30_000);
