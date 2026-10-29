import { expect, test } from 'bun:test';
import { existsSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkerJob } from './job.ts';
import type { ProcessIdentity } from './process.ts';
import { startOrphanRecoveryTimer } from './integration-cli.ts';
import { harness } from './test-support.ts';

const deadDriver: ProcessIdentity = { pid: 2_147_483_647, start: 'dead', boot: 'dead', group: 2_147_483_647 };

const heldWorker = `#!/usr/bin/env bun
import { existsSync, watch, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync('.worker-started', 'ready');
if (!existsSync('.worker-release')) await new Promise<void>(resolve => {
  const watcher = watch('.', () => { if (existsSync('.worker-release')) { watcher.close(); resolve(); } });
  if (existsSync('.worker-release')) { watcher.close(); resolve(); }
});
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Finish held worker fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:20}}));
`;

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      clearTimeout(timer); watcher.close(); resolve();
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`missing fixture signal: ${path}`)); }, 10_000);
  });
}

test('a ready task orphaned after a recovery sweep started is adopted by the next 60 s tick even while workers adopted by the earlier sweep are still running', async () => {
  const h = harness(heldWorker);
  h.settings.startGraceMs = 1;
  let release = '';
  let worker: Awaited<ReturnType<typeof h.tasks.retry>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let firstSweep: Promise<void> | undefined;
  let firstStartedResolve!: () => void;
  const firstStarted = new Promise<void>(resolve => { firstStartedResolve = resolve; });
  let secondStartedResolve!: () => void;
  const secondStarted = new Promise<void>(resolve => { secondStartedResolve = resolve; });
  let sweeps = 0;
  try {
    const adopted = h.tasks.dispatch(h.briefFile);
    worker = await h.tasks.retry(adopted.id);
    release = join(adopted.worktree, '.worker-release');
    await waitForFile(join(adopted.worktree, '.worker-started'));
    h.store.updateAttempt(worker.attempt, attempt => { (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadDriver; });

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    timer = startOrphanRecoveryTimer(() => {
      sweeps++;
      if (sweeps === 1) {
        firstSweep = job.recoverOrphans();
        firstStartedResolve();
        return firstSweep;
      }
      const sweep = job.recoverOrphans();
      secondStartedResolve();
      return sweep;
    }, 20);
    await firstStarted;
    const newlyOrphaned = h.tasks.dispatch(h.briefFile);
    h.store.updateTask({ taskId: newlyOrphaned.id, attempt: 0 }, task => {
      task.createdAt = new Date(Date.now() - 10_000).toISOString();
    });

    await secondStarted;
    await waitForFile(join(newlyOrphaned.worktree, '.worker-started'));
    expect(h.store.task(newlyOrphaned.id).currentAttempt).toBe(1);
    await job.recoverOrphans();
    expect(h.store.task(newlyOrphaned.id).currentAttempt).toBe(1);
    expect(h.store.attempts(newlyOrphaned.id).map(attempt => attempt.attempt)).toEqual([1]);
    clearInterval(timer);
    timer = undefined;

    writeFileSync(release, 'release');
    await firstSweep;
  } finally {
    if (timer) clearInterval(timer);
    if (release) writeFileSync(release, 'release');
    if (worker) await worker.exited;
    h.dispose();
  }
});

test('a task with a pending retry intent and no live process is restarted by the next tick, and no task is adopted twice', async () => {
  const h = harness();
  h.settings.startGraceMs = 1;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.store.updateAttempt(worker.attempt, attempt => {
      (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadDriver;
      attempt.state = 'exited';
      attempt.startedAt = new Date(Date.now() - 10_000).toISOString();
      attempt.failureKind = 'tool';
      attempt.escalation = 'environment';
    });
    h.store.event(worker.attempt, 'attempt-exit-classified', { kind: 'environment', detail: 'lost retry launcher' });
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });

    await job.recoverOrphans();
    await job.drain();
    await job.recoverOrphans();
    await job.drain();

    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.attempts(task.id).map(attempt => attempt.attempt)).toEqual([1, 2]);
    expect(h.store.retryIntent(worker.attempt)?.status).toBe('started');
  } finally { h.dispose(); }
});
