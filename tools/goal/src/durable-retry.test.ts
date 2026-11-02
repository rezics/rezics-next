import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { harness, markdown } from './test-support.ts';

test('retry and retry --brief persist the changed brief and pending start intent without waiting for capacity', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    const amended = h.tasks.dispatch(h.briefFile);
    const amendedWorker = await h.tasks.retry(amended.id);
    await amendedWorker.exited;
    writeFileSync(join(h.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 0 }));
    const changed = join(h.root, '.temp/goal/changed.md');
    writeFileSync(
      changed,
      markdown.replace('Write the requested result and commit it.', 'Write the revised result and commit it.'),
    );
    const start = Date.now();
    await runWorkerCommand('retry', [task.id], { tasks: h.tasks, print() {} });
    await runWorkerCommand('retry', [amended.id, '--brief', changed], { tasks: h.tasks, print() {} });
    expect(Date.now() - start).toBeLessThan(1000);
    const stored = h.store.task(amended.id);
    expect(stored.brief.markdown).toContain('Write the revised result');
    expect(h.store.retryIntent({ taskId: task.id, attempt: h.store.task(task.id).currentAttempt })).toMatchObject({
      status: 'pending',
    });
    expect(h.store.retryIntent({ taskId: amended.id, attempt: stored.currentAttempt })).toMatchObject({
      status: 'pending',
    });
    expect(
      h.store
        .retryIntents()
        .filter((intent) => intent.status === 'pending')
        .map((intent) => intent.taskId),
    ).toEqual([task.id, amended.id]);
    expect(existsSync(join(h.settings.stateDirectory, 'capacity-queue'))).toBe(false);
  } finally {
    h.dispose();
  }
});

test("the host's recovery tick starts pending intents once after capacity becomes available", async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.tasks.queueRetry(task.id);
    const ref = { taskId: task.id, attempt: h.store.task(task.id).currentAttempt };
    writeFileSync(join(h.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 1 }));
    const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await host.recoverOrphans();
    await host.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(ref.attempt + 1);
    expect(h.store.retryIntent(ref)?.status).toBe('started');
    await host.recoverOrphans();
    await host.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(ref.attempt + 1);
  } finally {
    h.dispose();
  }
});

test('a product retry still waiting to start takes an amended brief and keeps its place and options', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await (
      await h.tasks.retry(task.id)
    ).exited;
    const other = h.tasks.dispatch(h.briefFile);
    await (
      await h.tasks.retry(other.id)
    ).exited;
    writeFileSync(join(h.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 0 }));
    const ref = { taskId: task.id, attempt: 1 };
    h.store.saveRetryIntent(ref, { evidence: 'controller-evidence', escalation: 'new-failure', fixRound: 3 });
    h.tasks.queueRetry(other.id);
    const changed = join(h.root, '.temp/goal/amended-pending.md');
    writeFileSync(
      changed,
      markdown.replace('Write the requested result and commit it.', 'Write the amended result and commit it.'),
    );

    await runWorkerCommand('retry', [task.id, '--brief', changed], { tasks: h.tasks, print() {} });

    expect(h.store.task(task.id).brief.markdown).toContain('Write the amended result');
    expect(h.store.retryIntent(ref)).toMatchObject({
      status: 'pending',
      options: { evidence: 'controller-evidence', escalation: 'new-failure', fixRound: 3 },
    });
    expect(
      h.store
        .retryIntents()
        .filter((intent) => intent.status === 'pending')
        .map((intent) => intent.taskId),
    ).toEqual([task.id, other.id]);
    writeFileSync(join(h.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 2 }));
    const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await host.recoverOrphans();
    await host.drain();
    const next = h.store.attempt({ taskId: task.id, attempt: 2 });
    expect(next).toMatchObject({ fixRound: 3, escalation: 'new-failure' });
    expect(next.newBriefHash).toBeString();
  } finally {
    h.dispose();
  }
});

test('control-plane retries still refuse a second retry while one waits to start', async () => {
  const h = harness();
  try {
    writeFileSync(
      h.briefFile,
      markdown
        .replace('goal: fixture', 'goal: control-plane\ntarget: main')
        .replace('paths: [result.txt]', 'paths: [tools/goal/a.ts]'),
    );
    const task = h.tasks.dispatch(h.briefFile);
    await (
      await h.tasks.retry(task.id)
    ).exited;
    h.store.saveRetryIntent({ taskId: task.id, attempt: 1 }, {});
    const changed = join(h.root, '.temp/goal/control-plane-amended.md');
    writeFileSync(changed, `${readFileSync(h.briefFile, 'utf8')}\nAmended.\n`);
    expect(() => h.tasks.queueRetry(task.id, { brief: changed })).toThrow('a retry is already pending');
  } finally {
    h.dispose();
  }
});

test('a never-started product task retries at generation zero, also through --expected-attempt 0', async () => {
  const h = harness();
  try {
    const plain = h.tasks.dispatch(h.briefFile);
    const amended = h.tasks.dispatch(h.briefFile);
    for (const task of [plain, amended])
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.state = 'stopped';
      });
    const changed = join(h.root, '.temp/goal/generation-zero.md');
    writeFileSync(
      changed,
      markdown.replace('Write the requested result and commit it.', 'Write the first amended result and commit it.'),
    );

    await runWorkerCommand('retry', [plain.id], { tasks: h.tasks, print() {} });
    await runWorkerCommand('retry', [amended.id, '--expected-attempt', '0', '--brief', changed], {
      tasks: h.tasks,
      print() {},
    });

    for (const task of [plain, amended]) {
      expect(h.store.task(task.id)).toMatchObject({ state: 'ready', currentAttempt: 0 });
      expect(h.store.retryIntent({ taskId: task.id, attempt: 0 })?.status).toBe('pending');
    }
    expect(h.store.task(amended.id).brief.markdown).toContain('Write the first amended result');
    const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await host.recoverOrphans();
    await host.drain();
    for (const task of [plain, amended]) expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.attempt({ taskId: amended.id, attempt: 1 }).newBriefHash).toBeString();
  } finally {
    h.dispose();
  }
});
