import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { GateOutcome, ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { promote } from './promotion.ts';
import { harness, markdown } from './test-support.ts';
import { git } from './merge.ts';

const merged = (taskId: string, commit: string): GateOutcome => ({ taskId, attempt: 1, passed: true, stage: 'merge',
  mergedCommit: commit, logPath: 'fixture', hostMs: 1, changedFiles: ['result.txt'], diffLines: 1 });

test('a task held after another launches when that task integrates, and the Goal reports idle after promotion', async () => {
  const h = harness(), inbox: ManagerEvent[] = [];
  try {
    h.settings.gate = ['true'];
    writeFileSync(h.briefFile, markdown.replace('command: [bun, test]', 'command: ["true"]'));
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: event => inbox.push(event) });
    const first = h.tasks.dispatch(h.briefFile);
    const secondBrief = join(h.root, '.temp/goal/second.md');
    writeFileSync(secondBrief, markdown.replace('command: [bun, test]', 'command: ["true"]')
      .replace('waiting: []', `waiting: []\nafter: [${first.id}]`));
    const second = h.tasks.dispatch(secondBrief);
    expect(h.store.task(second.id).state).toBe('held');
    expect(h.store.task(second.id).currentAttempt).toBe(0);

    await job.start(first.id);
    const firstCommit = git(h.store.task(first.id).worktree, 'rev-parse', 'HEAD');
    const devBeforeFirst = git(h.root, 'rev-parse', 'dev');
    git(h.root, 'update-ref', 'refs/heads/dev', firstCommit, devBeforeFirst);
    job.onGateOutcome(merged(first.id, firstCommit)); await job.drain();
    expect(h.store.task(first.id).state).toBe('integrated');
    expect(h.store.task(second.id).currentAttempt).toBe(1);
    expect(inbox).toEqual([]);

    const secondCommit = git(h.store.task(second.id).worktree, 'rev-parse', 'HEAD');
    const devBeforeSecond = git(h.root, 'rev-parse', 'dev');
    if (secondCommit !== devBeforeSecond) git(h.root, 'update-ref', 'refs/heads/dev', secondCommit, devBeforeSecond);
    job.onGateOutcome(merged(second.id, secondCommit)); await job.drain();
    expect(h.store.task(second.id).state).toBe('integrated');
    expect(inbox).toEqual([]);
    await promote({ settings: h.settings, job }); await job.drain();
    expect(inbox.map(event => [event.kind, event.managerId])).toEqual([['goal-idle', 'fixture']]);
    // A replayed outcome does not report idle again.
    job.onGateOutcome(merged(second.id, secondCommit)); await job.drain();
    expect(inbox).toHaveLength(1);
  } finally { h.dispose(); }
});

test('a brief held after an unknown task is refused', () => {
  const h = harness();
  try {
    const brief = join(h.root, '.temp/goal/orphan.md');
    writeFileSync(brief, markdown.replace('waiting: []', 'waiting: []\nafter: [no-such-task]'));
    expect(() => h.tasks.dispatch(brief)).toThrow();
  } finally { h.dispose(); }
});

test('a brief held after a merged task is ready at once', () => {
  const h = harness();
  try {
    const first = h.tasks.dispatch(h.briefFile);
    h.store.updateTask({ taskId: first.id, attempt: 0 }, task => { task.state = 'merged'; });
    const brief = join(h.root, '.temp/goal/later.md');
    writeFileSync(brief, markdown.replace('waiting: []', `waiting: []\nafter: [${first.id}]`));
    expect(h.store.task(h.tasks.dispatch(brief).id).state).toBe('ready');
  } finally { h.dispose(); }
});
