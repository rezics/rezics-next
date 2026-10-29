import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';

test('retry --brief stores a held task amendment before capacity and returns while dependencies remain unmet', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const dependency = h.tasks.dispatch(h.briefFile);
    const waiting = join(h.root, '.temp/goal/waiting.md');
    writeFileSync(waiting, markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`));
    const task = h.tasks.dispatch(waiting);
    const amended = join(h.root, '.temp/goal/amended.md');
    const amendedText = markdown
      .replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`)
      .concat('\nCost: changed while waiting.\n');
    writeFileSync(amended, amendedText);
    writeFileSync(join(h.tasks.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 0 }));

    await job.start(task.id, { brief: amended });

    const updated = h.store.task(task.id);
    expect(updated.state).toBe('held');
    expect(updated.currentAttempt).toBe(0);
    expect(updated.brief.markdown).toBe(amendedText);
    expect(updated.briefPath).not.toBe(waiting);
    expect(existsSync(updated.briefPath)).toBe(true);
    expect(existsSync(join(h.tasks.settings.stateDirectory, 'capacity-queue'))).toBe(false);
  } finally {
    h.dispose();
  }
});

test('a held amendment with no unmet dependencies is stored before joining normal capacity admission and starts when admitted', async () => {
  const h = harness();
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const dependency = h.tasks.dispatch(h.briefFile);
    const waiting = join(h.root, '.temp/goal/waiting.md');
    writeFileSync(waiting, markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`));
    const task = h.tasks.dispatch(waiting);
    const amended = join(h.root, '.temp/goal/amended.md');
    const amendedText = `${markdown}\nCost: ready to start.\n`;
    writeFileSync(amended, amendedText);
    writeFileSync(join(h.tasks.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 0 }));

    const starting = job.start(task.id, { brief: amended }).then(() => job.drain());
    const queue = join(h.tasks.settings.stateDirectory, 'capacity-queue');
    const deadline = Date.now() + 5_000;
    while (!existsSync(queue) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(existsSync(queue)).toBe(true);
    expect(h.store.task(task.id).state).toBe('ready');
    expect(h.store.task(task.id).brief.markdown).toBe(amendedText);
    expect(h.store.task(task.id).currentAttempt).toBe(0);

    writeFileSync(join(h.tasks.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 1 }));
    await starting;

    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(['landing', 'integrated', 'merged']).toContain(h.store.task(task.id).state);
  } finally {
    h.dispose();
  }
}, 30_000);

test('capacity admission releases the amendment lease and respects a newer held contract', async () => {
  const h = harness();
  let starting: Promise<void> | undefined;
  const capacity = join(h.tasks.settings.stateDirectory, 'capacity.json');
  try {
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const dependency = h.tasks.dispatch(h.briefFile);
    const waiting = join(h.root, '.temp/goal/waiting.md');
    writeFileSync(waiting, markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`));
    const task = h.tasks.dispatch(waiting);
    const amended = join(h.root, '.temp/goal/amended.md');
    writeFileSync(amended, `${markdown}\nReady to start.\n`);
    writeFileSync(capacity, JSON.stringify({ maxWorkers: 0 }));

    starting = job.start(task.id, { brief: amended });
    const queue = join(h.tasks.settings.stateDirectory, 'capacity-queue');
    const deadline = Date.now() + 5_000;
    while (!existsSync(queue) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(queue)).toBe(true);
    expect(h.store.task(task.id).state).toBe('ready');

    const newerText = markdown
      .replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`)
      .concat('\nWait for the dependency again.\n');
    writeFileSync(amended, newerText);
    await job.start(task.id, { brief: amended });
    expect(h.store.task(task.id).state).toBe('held');
    expect(h.store.task(task.id).brief.markdown).toBe(newerText);

    writeFileSync(capacity, JSON.stringify({ maxWorkers: 1 }));
    await starting;
    expect(h.store.task(task.id).state).toBe('held');
    expect(h.store.task(task.id).currentAttempt).toBe(0);
    expect(h.store.task(task.id).brief.markdown).toBe(newerText);
  } finally {
    writeFileSync(capacity, JSON.stringify({ maxWorkers: 1 }));
    await starting?.catch(() => {});
    h.dispose();
  }
}, 30_000);
