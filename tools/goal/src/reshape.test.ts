import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';

test('a stopped task retries with a reshaped brief of the same goal and manager', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id); await job.drain();
    await h.tasks.stop(task.id);
    const wider = join(h.root, '.temp/goal/wider.md');
    writeFileSync(wider, markdown.replace('paths: [result.txt]', 'paths: [result.txt, extra.txt]'));
    await job.start(task.id, { brief: wider }); await job.drain();
    const reshaped = h.store.task(task.id);
    expect(reshaped.brief.paths).toEqual(['result.txt', 'extra.txt']);
    expect(reshaped.currentAttempt).toBe(2);
    const otherGoal = join(h.root, '.temp/goal/other.md');
    writeFileSync(otherGoal, markdown.replace('goal: fixture', 'goal: elsewhere'));
    await h.tasks.stop(task.id);
    await expect(Promise.resolve().then(() => job.start(task.id, { brief: otherGoal }))).rejects.toThrow();
    expect(h.store.task(task.id).brief.goal).toBe('fixture');
  } finally { h.dispose(); }
});

test('a cancelled task leaves its Goal’s completion scope', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id); await job.drain();
    await h.tasks.cancel(task.id);
    expect(h.store.task(task.id).state).toBe('cancelled');
    expect(h.tasks.completionScope('fixture')).toEqual([]);
    const kept = h.tasks.dispatch(h.briefFile);
    expect(h.tasks.completionScope('fixture')).toEqual([kept.id]);
  } finally { h.dispose(); }
});
