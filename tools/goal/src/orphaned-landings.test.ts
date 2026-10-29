import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { git } from './merge.ts';
import { MergeTrain } from './merge-train.ts';
import { acquireDirectoryLease } from './lease.ts';
import { integrationHarness } from './test-support.ts';
import type { RetryOptions } from './tasks.ts';

test('a dev rebase conflict retries the task with conflict evidence and leaves a next landing step', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const passing = h.dispatch('passing.txt');
    const task = h.dispatch('shared.txt');
    await h.start(passing);
    await h.start(task);
    h.advanceDev('shared.txt', 'dev version');

    const retries: RetryOptions[] = [];
    const start = h.job.start.bind(h.job);
    h.job.start = async (taskId, options = {}) => {
      retries.push(options);
      await start(taskId, options);
    };
    await new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: h.job,
    }).run();
    await h.job.drain();

    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ escalation: 'rebase-conflict', conflictFiles: ['shared.txt'] });
    const failedAttempt = h.store.attempt({ taskId: task.id, attempt: 1 });
    expect(failedAttempt.failure?.assertion).toContain('could not apply');
    const failureEvidence = JSON.parse(readFileSync(join(retries[0]!.evidence!, 'failure.json'), 'utf8')) as {
      assertion: string;
      excerpt: string;
    };
    expect(`${failureEvidence.assertion}\n${failureEvidence.excerpt}`).toContain('shared.txt');

    const current = h.store.task(task.id);
    if (current.state === 'landing') {
      expect(
        h.store.db
          .query('SELECT 1 FROM landing_queue WHERE task=? AND attempt=? AND delivered=0')
          .get(task.id, current.currentAttempt),
      ).toBeDefined();
    } else {
      expect(['integrated', 'merged', 'ready', 'running', 'stopped']).toContain(current.state);
      expect(current.currentAttempt).toBeGreaterThan(1);
    }
  } finally {
    h.dispose();
  }
});

test('a batch drops an already integrated member and lands the remaining members', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const integrated = h.dispatch('already-landed.txt');
    const remaining = h.dispatch('still-to-land.txt');
    await h.start(integrated);
    await h.start(remaining);
    const integratedCommit = git(integrated.worktree, 'rev-parse', 'HEAD');
    git(h.root, 'update-ref', 'refs/heads/dev', integratedCommit, h.head('dev'));
    h.store.updateTask({ taskId: integrated.id, attempt: h.store.task(integrated.id).currentAttempt }, (task) => {
      task.state = 'integrated';
      task.integratedCommit = integratedCommit;
    });

    await h.train();

    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([[remaining.id, true]]);
    expect(h.store.task(integrated.id).state).toBe('integrated');
    expect(h.store.task(remaining.id).state).toBe('integrated');
    expect(git(h.root, 'show', 'dev:already-landed.txt')).toBe('already-landed.txt');
    expect(git(h.root, 'show', 'dev:still-to-land.txt')).toBe('still-to-land.txt');
  } finally {
    h.dispose();
  }
});

test('a setup failure caused by another integrated batch member retries the unaffected member', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const other = h.dispatch('other-member.txt');
    const member = h.dispatch('retry-member.txt');
    await h.start(other);
    await h.start(member);

    const commitBatchMerge = h.store.commitBatchMerge.bind(h.store);
    let injected = false;
    h.store.commitBatchMerge = (members, merge) => {
      if (!injected) {
        injected = true;
        h.store.updateTask({ taskId: other.id, attempt: h.store.task(other.id).currentAttempt }, (task) => {
          task.state = 'integrated';
          task.integratedCommit = members[0]!.commit;
        });
        throw new Error('attempt already integrated');
      }
      return commitBatchMerge(members, merge);
    };

    await h.train();

    expect(injected).toBe(true);
    expect(h.outcomes.map(({ taskId, passed, stage }) => [taskId, passed, stage])).toEqual([
      [member.id, true, 'merge'],
    ]);
    expect(h.store.task(member.id).state).toBe('integrated');
    expect(git(h.root, 'show', 'dev:retry-member.txt')).toBe('retry-member.txt');
  } finally {
    h.dispose();
  }
});

test('the host sweep retries an orphaned landing only after train work ends and reports it once', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('orphaned.txt');
    await h.start(task);
    h.store.db
      .query('DELETE FROM landing_queue WHERE task=? AND attempt=?')
      .run(task.id, h.store.task(task.id).currentAttempt);

    const trainLease = acquireDirectoryLease(join(h.settings.stateDirectory, 'train.lease'));
    try {
      await h.job.recoverOrphans();
      await h.job.drain();
      expect(h.store.task(task.id).currentAttempt).toBe(1);
      expect(h.inbox.filter((event) => event.taskId === task.id)).toHaveLength(0);
    } finally {
      trainLease.release();
    }

    await h.job.recoverOrphans();
    await h.job.drain();

    expect(h.store.task(task.id).currentAttempt).toBeGreaterThan(1);
    const reports = h.inbox.filter((event) => event.taskId === task.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      managerId: h.settings.integration.supermanager,
      kind: 'environment',
    });
    expect(reports[0]?.summary).toContain('queued a retry');

    await h.job.recoverOrphans();
    await h.job.drain();
    expect(h.inbox.filter((event) => event.taskId === task.id)).toHaveLength(1);
  } finally {
    h.dispose();
  }
});
