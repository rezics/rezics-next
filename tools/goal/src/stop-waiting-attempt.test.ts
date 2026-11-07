import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { processIdentity, sameProcess, terminateProcessGroup, type ProcessIdentity } from './process.ts';
import type { Attempt } from './types.ts';
import { harness } from './test-support.ts';

async function waitUntil(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(message);
}

function parkWaiting(h: ReturnType<typeof harness>, checks: string[]) {
  const task = h.tasks.dispatch(h.briefFile);
  const startedAt = new Date().toISOString();
  const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (n): Attempt => ({
    taskId: task.id,
    attempt: n,
    state: 'pending',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt,
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${n}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(n)),
    auxiliaryProcesses: [],
    session: null,
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: null,
    result: '',
    blocker: null,
    approaches: [],
  }));
  h.store.updateAttempt(attempt, (current) => {
    current.state = 'waiting';
    current.process = null;
    current.checks = checks;
  });
  h.store.updateTask(attempt, (current) => {
    current.state = 'running';
  });
  return { task, ref: { taskId: task.id, attempt: 1 } };
}

async function startDetachedRunner(cwd: string): Promise<ProcessIdentity> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  const identity = processIdentity(child.pid!);
  if (!identity) throw new Error('check runner identity unavailable');
  return identity;
}

function writeCheck(worktree: string, id: string, fields: Record<string, unknown>): void {
  const directory = join(worktree, '.temp/goal/checks/results');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({ id, cwd: worktree, ...fields }));
}

function readCheck(worktree: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(worktree, '.temp/goal/checks/results', `${id}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

function retainUnknown(
  h: ReturnType<typeof harness>,
  ref: { taskId: string; attempt: number },
  operation: 'stop' | 'cancel',
): void {
  h.store.updateAttempt(ref, (attempt) => {
    attempt.terminationIntent = {
      operation,
      requestedAt: new Date().toISOString(),
      state: 'unknown',
      processIdentity: 'unknown',
      process: null,
      auxiliaryProcesses: [],
      error: 'process identity unavailable',
    };
  });
}

test.each(['stop', 'cancel'] as const)(
  '%s of a waiting attempt terminates recorded runners, abandons those checks, and settles',
  async (operation) => {
    const h = harness();
    const id = randomUUID();
    const physicalRunId = randomUUID();
    let runner: ProcessIdentity | null = null;
    try {
      const { task, ref } = parkWaiting(h, [id]);
      runner = await startDetachedRunner(task.worktree);
      writeCheck(task.worktree, id, {
        status: 'running',
        runnerPid: runner.pid,
        runnerHost: hostname(),
        runnerIdentity: runner,
        physicalRunId,
        argv: [process.execPath],
      });
      expect(h.store.beginTermination(ref, operation)).toMatchObject({
        operation,
        state: 'requested',
        processIdentity: 'waiting',
      });
      if (operation === 'cancel') await h.tasks.cancel(task.id);
      else await h.tasks.stop(task.id);
      expect(sameProcess(runner)).toBe(false);
      expect(readCheck(task.worktree, id)).toMatchObject({
        status: 'abandoned',
        abandonedBy: operation,
        runnerPid: runner.pid,
        physicalRunId,
      });
      const terminal = operation === 'cancel' ? 'cancelled' : 'stopped';
      expect(h.store.task(task.id).state).toBe(terminal);
      expect(h.store.attempt(ref)).toMatchObject({
        state: terminal,
        terminationIntent: { operation, state: 'complete', processIdentity: 'waiting' },
      });
    } finally {
      if (runner) await terminateProcessGroup(runner, 50).catch(() => {});
      await h.disposeAsync();
    }
  },
  30_000,
);

test('a waiting attempt whose recorded runners are already gone settles at once', async () => {
  const h = harness();
  const id = randomUUID();
  let runner: ProcessIdentity | null = null;
  try {
    const { task, ref } = parkWaiting(h, [id]);
    runner = await startDetachedRunner(task.worktree);
    writeCheck(task.worktree, id, {
      status: 'running',
      runnerPid: runner.pid,
      runnerHost: hostname(),
      runnerIdentity: runner,
      physicalRunId: randomUUID(),
    });
    await terminateProcessGroup(runner, 50);
    await waitUntil(() => !sameProcess(runner!), 'check runner did not exit');
    await h.tasks.stop(task.id);
    expect(readCheck(task.worktree, id)).toMatchObject({ status: 'abandoned', abandonedBy: 'stop' });
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(h.store.attempt(ref).terminationIntent).toMatchObject({
      operation: 'stop',
      state: 'complete',
      processIdentity: 'waiting',
    });
  } finally {
    if (runner) await terminateProcessGroup(runner, 50).catch(() => {});
    await h.disposeAsync();
  }
}, 30_000);

test.each(['stop', 'cancel'] as const)(
  'an unknown %s retained for a waiting attempt settles on the next call',
  async (operation) => {
    const h = harness();
    const id = randomUUID();
    let runner: ProcessIdentity | null = null;
    try {
      const { task, ref } = parkWaiting(h, [id]);
      runner = await startDetachedRunner(task.worktree);
      writeCheck(task.worktree, id, {
        status: 'running',
        runnerPid: runner.pid,
        runnerHost: hostname(),
        runnerIdentity: runner,
        physicalRunId: randomUUID(),
      });
      retainUnknown(h, ref, operation);
      if (operation === 'cancel') await h.tasks.cancel(task.id);
      else await h.tasks.stop(task.id);
      expect(sameProcess(runner)).toBe(false);
      expect(readCheck(task.worktree, id)).toMatchObject({ status: 'abandoned', abandonedBy: operation });
      const terminal = operation === 'cancel' ? 'cancelled' : 'stopped';
      expect(h.store.task(task.id).state).toBe(terminal);
      expect(h.store.attempt(ref).terminationIntent).toMatchObject({
        operation,
        state: 'complete',
        processIdentity: 'waiting',
      });
    } finally {
      if (runner) await terminateProcessGroup(runner, 50).catch(() => {});
      await h.disposeAsync();
    }
  },
  30_000,
);

test('an unknown waiting stop settles on the controller sweep', async () => {
  const h = harness();
  const id = randomUUID();
  let runner: ProcessIdentity | null = null;
  try {
    const { task, ref } = parkWaiting(h, [id]);
    runner = await startDetachedRunner(task.worktree);
    writeCheck(task.worktree, id, {
      status: 'running',
      runnerPid: runner.pid,
      runnerHost: hostname(),
      runnerIdentity: runner,
      physicalRunId: randomUUID(),
    });
    retainUnknown(h, ref, 'stop');
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.recoverOrphans({ adoptRunning: false });
    await job.recoverOrphans({ adoptRunning: false });
    expect(sameProcess(runner)).toBe(false);
    expect(readCheck(task.worktree, id)).toMatchObject({ status: 'abandoned', abandonedBy: 'stop' });
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(h.store.attempt(ref).terminationIntent).toMatchObject({
      operation: 'stop',
      state: 'complete',
      processIdentity: 'waiting',
    });
  } finally {
    if (runner) await terminateProcessGroup(runner, 50).catch(() => {});
    await h.disposeAsync();
  }
}, 30_000);

test('a live worker process still stops as known identity', async () => {
  const h = harness(`#!/usr/bin/env bun
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    const ref = worker.attempt;
    expect(h.store.attempt(ref).process).not.toBeNull();
    expect(h.store.beginTermination(ref, 'stop')).toMatchObject({
      state: 'requested',
      processIdentity: 'known',
    });
    await h.tasks.stop(task.id);
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(h.store.attempt(ref).terminationIntent).toMatchObject({
      operation: 'stop',
      state: 'complete',
      processIdentity: 'known',
    });
  } finally {
    await h.disposeAsync();
  }
}, 30_000);
