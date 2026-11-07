import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { launch } from './launch.ts';
import { offloadHostTask } from './service.ts';
import { harness, markdown, reading } from './test-support.ts';
import { WorkerTasks } from './tasks.ts';
import type { Pool, PoolReading } from './types.ts';

function pinnedBrief(h: ReturnType<typeof harness>): string {
  const file = join(h.settings.stateDirectory, 'pinned-codex.md');
  writeFileSync(file, markdown.replace('waiting: []', 'waiting: []\nmodel: gpt-6.1-sol\neffort: xhigh'));
  return file;
}

function poolReading(pool: Pool, refused: boolean): PoolReading {
  return reading(pool, refused ? 100 : 0);
}

test('a first-start pool wait stays pending and recovery launches exactly one attempt when allowance returns', async () => {
  const h = harness();
  const pool = h.settings.pools[0]!;
  const notifications: { kind: string; summary: string }[] = [];
  const launches: string[] = [];
  let refused = true;
  const tasks = new WorkerTasks(
    h.settings,
    h.store,
    (candidate) => poolReading(candidate, refused),
    async (...args) => {
      launches.push(`${args[1].id}:${args[2].attempt}`);
      return await launch(...args);
    },
  );
  const job = new WorkerJob(
    tasks,
    { enqueue() {} },
    { deliver: (event) => notifications.push({ kind: event.kind, summary: event.summary }) },
  );
  try {
    const task = tasks.dispatch(pinnedBrief(h));
    const ref = { taskId: task.id, attempt: 0 };
    await job.start(task.id, { expectedAttempt: 0 });
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'pending' });
    expect(h.store.attempts(task.id)).toEqual([]);
    expect(notifications).toEqual([]);

    job.resumePendingRetries();
    await job.drain();
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'pending' });
    expect(h.store.attempts(task.id)).toEqual([]);
    expect(notifications).toEqual([]);

    refused = false;
    job.resumePendingRetries();
    await job.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.attempts(task.id)).toHaveLength(1);
    expect(launches).toEqual([`${task.id}:1`]);
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'started', nextAttempt: 1 });
    expect(notifications).toEqual([]);
  } finally {
    await h.disposeAsync();
  }
}, 30_000);

test('an offloaded first-start and retry treat a child pool refusal as a durable wait', async () => {
  const h = harness();
  const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8')) as {
    pools: { policy: Record<string, unknown> }[];
  };
  const fixtureTask = h.tasks.dispatch(pinnedBrief(h));
  await h.tasks.retry(fixtureTask.id);
  expect(h.store.runningAttemptsByPool()[h.settings.pools[0]!.name]).toBe(1);

  local.pools = local.pools.map((pool) => ({
    ...pool,
    policy: { ...pool.policy, maxConcurrent: 1 },
  }));
  writeFileSync(h.settings.localFile, JSON.stringify(local));
  const env: NodeJS.ProcessEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    GOAL_MAIN_CHECKOUT: h.root,
    GOAL_LOCAL_CONFIG: h.settings.localFile,
  };
  const notifications: { kind: string; summary: string }[] = [];
  const job = new WorkerJob(
    h.tasks,
    { enqueue() {} },
    { deliver: (event) => notifications.push({ kind: event.kind, summary: event.summary }) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (taskId, kind) =>
      offloadHostTask(taskId, kind, {
        cli: join(import.meta.dir, 'cli.ts'),
        cwd: h.root,
        env,
      }),
  );
  try {
    const task = h.tasks.dispatch(pinnedBrief(h));
    const ref = { taskId: task.id, attempt: 0 };
    await job.start(task.id, { expectedAttempt: 0 });
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'pending' });
    expect(h.store.attempts(task.id)).toEqual([]);

    job.resumePendingRetries();
    await job.drain();
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'pending' });
    expect(h.store.attempts(task.id)).toEqual([]);
    expect(notifications).toEqual([]);
  } finally {
    await h.disposeAsync();
  }
}, 30_000);

test('unexpected offloaded background failures still alert the manager', async () => {
  const h = harness();
  const notifications: { kind: string; summary: string }[] = [];
  const task = h.tasks.dispatch(h.briefFile);
  const ref = { taskId: task.id, attempt: 0 };
  h.store.saveRetryIntent(ref, {});
  const job = new WorkerJob(
    h.tasks,
    { enqueue() {} },
    { deliver: (event) => notifications.push({ kind: event.kind, summary: event.summary }) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error('pool configuration could not be loaded');
    },
  );
  try {
    job.resumePendingRetries();
    await expect(job.drain()).rejects.toThrow('pool configuration could not be loaded');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: 'environment',
      summary: 'Control-plane background work failed: Error: pool configuration could not be loaded',
    });
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'pending' });
  } finally {
    await h.disposeAsync();
  }
});
