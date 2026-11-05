import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuationOverlap } from './continuation.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerJob } from './job.ts';
import { StaleAttemptError } from './contracts.ts';
import { harness, markdown } from './test-support.ts';
import { retryWait } from './watchdog.ts';
import { runWorkerCommand } from './worker-commands.ts';

async function setupFailedAttempt(h: ReturnType<typeof harness>) {
  const task = h.tasks.dispatch(h.briefFile);
  const first = await h.tasks.retry(task.id);
  await first.exited;
  await h.tasks.stop(task.id);
  const prior = { taskId: task.id, attempt: 1 };
  h.store.updateAttempt(prior, (attempt) => {
    attempt.checks = ['check-a'];
  });
  h.settings.integrationBranch = 'invalid branch name';
  await expect(h.tasks.retry(task.id)).rejects.toThrow();
  const ref = { taskId: task.id, attempt: 2 };
  expect(h.store.events(task.id, 2).some((event) => event.kind === 'launch-failed')).toBe(true);
  expect(existsSync(`${h.store.attempt(ref).logPath}.pid`)).toBe(false);
  return { task, ref, prior, priorPid: `${h.store.attempt(prior).logPath}.pid` };
}

async function recover(h: ReturnType<typeof harness>) {
  const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
  await job.recoverOrphans({ adoptRunning: false });
  await job.recoverOrphans({ adoptRunning: false });
  return job;
}

for (const [operation, terminal] of [
  ['stop', 'stopped'],
  ['cancel', 'cancelled'],
] as const) {
  test(`the host settles an unknown ${operation} after run PIDs and the worktree are clear`, async () => {
    const h = harness('#!/usr/bin/env bun\n');
    try {
      const task = h.tasks.dispatch(h.briefFile),
        worker = await h.tasks.retry(task.id),
        ref = worker.attempt;
      await worker.exited;
      h.store.updateAttempt(ref, (attempt) => {
        attempt.process = null;
      });
      await expect(operation === 'cancel' ? h.tasks.cancel(task.id) : h.tasks.stop(task.id)).rejects.toThrow(
        'unknown process identity',
      );

      await new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} }).recoverOrphans({ adoptRunning: false });

      expect(h.store.task(task.id).state).toBe(terminal);
      expect(h.store.attempt(ref)).toMatchObject({
        state: terminal,
        terminationIntent: { operation, state: 'complete', processIdentity: 'unknown', process: null },
      });
    } finally {
      await h.disposeAsync();
    }
  });
}

for (const terminal of ['stopped', 'cancelled'] as const) {
  test(`a held task is released and its owner is told when its ${terminal} predecessor is dropped`, async () => {
    const h = harness('#!/usr/bin/env bun\n');
    try {
      const predecessor = h.tasks.dispatch(h.briefFile),
        heldPath = join(h.settings.stateDirectory, 'held.md');
      writeFileSync(
        heldPath,
        markdown.replace('paths: [result.txt]', `paths: [dependent.txt]\nafter: [${predecessor.id}]`),
      );
      const held = h.tasks.dispatch(heldPath);
      expect(held.state).toBe('held');
      h.store.updateTask({ taskId: predecessor.id, attempt: 0 }, (task) => {
        task.state = terminal;
      });
      const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);

      await new WorkerJob(h.tasks, { enqueue() {} }, inbox).recoverOrphans();

      expect(h.store.task(held.id).state).not.toBe('held');
      expect(
        inbox
          .read(held.brief.manager)
          .map((entry) => entry.event.summary)
          .join('\n'),
      ).toContain(predecessor.id);
    } finally {
      await h.disposeAsync();
    }
  });
}

for (const predecessorState of ['stopped', 'cancelled'] as const) {
  test(`a pending retry does not wait for a ${predecessorState} predecessor`, () => {
    const intent = { taskId: 'dependent', attempt: 1, status: 'pending', options: {} } as Parameters<
      typeof retryWait
    >[0];
    const task = { brief: { after: ['predecessor'] } } as Parameters<typeof retryWait>[1];
    expect(retryWait(intent, task, () => predecessorState, Date.now())).toBeNull();
  });
}

test('a setup-failed never-launched stop settles without a current PID and keeps earlier processes, checks and retry', async () => {
  const h = harness('#!/usr/bin/env bun\n');
  const earlier = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: h.root, stdio: 'ignore' });
  try {
    await new Promise<void>((resolve, reject) => {
      earlier.once('spawn', resolve);
      earlier.once('error', reject);
    });
    const { task, ref, prior, priorPid } = await setupFailedAttempt(h);
    writeFileSync(priorPid, `${earlier.pid}\n`);
    await h.tasks.stop(task.id);
    await recover(h);
    expect(existsSync(`${h.store.attempt(ref).logPath}.pid`)).toBe(false);
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(h.store.attempt(ref)).toMatchObject({
      state: 'stopped',
      terminationIntent: { operation: 'stop', state: 'complete', processIdentity: 'not-started', process: null },
    });
    expect(h.store.events(task.id, 2).filter((event) => event.kind === 'stopped')).toHaveLength(1);
    expect(h.store.attempt(prior).checks).toEqual(['check-a']);
    expect(existsSync(priorPid)).toBe(true);
    expect(earlier.exitCode).toBeNull();
    writeFileSync(join(h.settings.stateDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 0 }));
    await runWorkerCommand('retry', [task.id], { tasks: h.tasks, print() {} });
    expect(h.store.retryIntent(ref)?.status).toBe('pending');
  } finally {
    if (earlier.exitCode === null && earlier.signalCode === null) {
      const exited = new Promise<void>((resolve) => earlier.once('exit', () => resolve()));
      earlier.kill('SIGTERM');
      await exited;
    }
    await h.disposeAsync();
  }
});

test('host recovery settles an already-unknown setup-failed attempt that never wrote a PID', async () => {
  const h = harness('#!/usr/bin/env bun\n');
  try {
    const { task, ref } = await setupFailedAttempt(h);
    h.store.updateAttempt(ref, (attempt) => {
      attempt.terminationIntent = {
        operation: 'stop',
        requestedAt: new Date().toISOString(),
        state: 'unknown',
        processIdentity: 'unknown',
        process: null,
        auxiliaryProcesses: [],
        error: 'process identity unavailable',
      };
    });
    await recover(h);
    expect(existsSync(`${h.store.attempt(ref).logPath}.pid`)).toBe(false);
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(h.store.attempt(ref).terminationIntent).toMatchObject({
      operation: 'stop',
      state: 'complete',
      processIdentity: 'unknown',
      process: null,
    });
  } finally {
    await h.disposeAsync();
  }
});

test('a setup-failed never-launched cancel settles without a current PID and stays fenced', async () => {
  const h = harness('#!/usr/bin/env bun\n');
  try {
    const { task, ref } = await setupFailedAttempt(h);
    await h.tasks.cancel(task.id);
    await recover(h);
    expect(existsSync(`${h.store.attempt(ref).logPath}.pid`)).toBe(false);
    expect(h.store.task(task.id).state).toBe('cancelled');
    expect(h.store.attempt(ref).terminationIntent).toMatchObject({
      operation: 'cancel',
      state: 'complete',
      processIdentity: 'not-started',
    });
    expect(() => h.tasks.queueRetry(task.id)).toThrow(/cancelled/);
    await expect(runWorkerCommand('retry', [task.id], { tasks: h.tasks, print() {} })).rejects.toThrow(/cancelled/);
  } finally {
    await h.disposeAsync();
  }
});

test('never-launched recovery stays open while a live descendant is in the worktree', async () => {
  const h = harness('#!/usr/bin/env bun\n');
  let live: ReturnType<typeof spawn> | undefined;
  try {
    const { task, ref } = await setupFailedAttempt(h);
    live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: task.worktree, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      live!.once('spawn', resolve);
      live!.once('error', reject);
    });
    await expect(h.tasks.cancel(task.id)).rejects.toThrow('never-launched identity');
    await recover(h);
    expect(h.store.attempt(ref).terminationIntent).toMatchObject({
      state: 'requested',
      processIdentity: 'not-started',
    });
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(() => h.tasks.queueRetry(task.id)).toThrow(StaleAttemptError);
  } finally {
    if (live && live.exitCode === null && live.signalCode === null) {
      const exited = new Promise<void>((resolve) => live!.once('exit', () => resolve()));
      live.kill('SIGTERM');
      await exited;
    }
    await h.disposeAsync();
  }
});

test('never-launched recovery stays open when current PID evidence is unreadable', async () => {
  const h = harness('#!/usr/bin/env bun\n');
  try {
    const { task, ref } = await setupFailedAttempt(h);
    const blocked = join(h.settings.stateDirectory, 'blocked-pid-parent');
    writeFileSync(blocked, 'not a directory');
    h.store.updateAttempt(ref, (attempt) => {
      attempt.logPath = join(blocked, '2.jsonl');
    });
    await expect(h.tasks.cancel(task.id)).rejects.toThrow('unknown process identity');
    await recover(h);
    expect(h.store.attempt(ref).terminationIntent).toMatchObject({
      state: 'unknown',
      processIdentity: 'unknown',
    });
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(() => h.tasks.queueRetry(task.id)).toThrow(StaleAttemptError);
  } finally {
    await h.disposeAsync();
  }
});

for (const terminal of ['stopped', 'cancelled'] as const) {
  test(`continuation overlap admission ignores a ${terminal} task`, () => {
    const h = harness();
    try {
      const task = h.tasks.dispatch(h.briefFile);
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.state = terminal;
      });
      const candidate = markdown
        .replace('goal: fixture', 'goal: fixture\ntitle: a different continuation')
        .replace('paths: [result.txt]', 'paths: [result.txt, new-result.txt]');
      const overlap = continuationOverlap(h.store.db, h.settings.stateDirectory, task.brief.goal, candidate, undefined);

      expect(overlap.after).not.toContain(task.id);
    } finally {
      h.dispose();
    }
  });
}
