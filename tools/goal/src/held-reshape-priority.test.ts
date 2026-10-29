import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWorkerCommand } from './worker-commands.ts';
import { harness, markdown } from './test-support.ts';

test('retry --brief on a held task replaces its brief and keeps it held until dependencies are met, with no start intent recorded', async () => {
  const h = harness();
  try {
    const dependency = h.tasks.dispatch(h.briefFile);
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.store.updateTask({ taskId: task.id, attempt: 1 }, (current) => {
      current.state = 'held';
      current.brief.after = [dependency.id];
    });
    h.store.updateAttempt({ taskId: task.id, attempt: 1 }, (attempt) => {
      attempt.state = 'stopped';
    });
    const amended = join(h.root, '.temp/goal/amended.md');
    const amendedText = markdown
      .replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`)
      .concat('\nAmended while held.\n');
    writeFileSync(amended, amendedText);

    h.tasks.queueRetry(task.id, { brief: amended });

    const updated = h.store.task(task.id);
    expect(updated.state).toBe('held');
    expect(updated.currentAttempt).toBe(1);
    expect(updated.brief.markdown).toBe(amendedText);
    expect(updated.briefPath).toContain('-queued-');
    expect(h.store.retryIntent({ taskId: task.id, attempt: 1 })).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('a refused retry writes no brief file', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.store.updateTask({ taskId: task.id, attempt: 1 }, (current) => {
      current.state = 'integrated';
    });
    const amended = join(h.root, '.temp/goal/amended.md');
    writeFileSync(amended, `${markdown}\nRefused amendment.\n`);
    const briefs = join(h.settings.stateDirectory, 'briefs');
    const before = readdirSync(briefs);
    expect(() => h.tasks.queueRetry(task.id, { brief: amended })).toThrow('cannot retry integrated task');
    expect(readdirSync(briefs)).toEqual(before);
  } finally {
    h.dispose();
  }
});

test('goal priority changes a running task in place and the next checks see the updated flag', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    const before = h.store.task(task.id);
    const attemptBefore = h.store.attempt({ taskId: task.id, attempt: before.currentAttempt });
    h.store.updateTask({ taskId: task.id, attempt: before.currentAttempt }, (current) => {
      current.state = 'running';
    });

    await runWorkerCommand('priority', [task.id, 'critical'], { settings: h.settings, store: h.store, tasks: h.tasks });

    const updated = h.store.task(task.id);
    expect(updated.state).toBe('running');
    expect(updated.currentAttempt).toBe(before.currentAttempt);
    expect(updated.brief.criticalPath).toBe(true);
    expect(h.store.attempt({ taskId: task.id, attempt: before.currentAttempt })).toEqual(attemptBefore);
    expect(readFileSync(join(updated.worktree, '.temp/goal/task-priority'), 'utf8')).toBe('critical\n');
    await worker.exited;
  } finally {
    h.dispose();
  }
});
