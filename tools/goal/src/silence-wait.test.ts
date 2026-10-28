import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessIdentity } from './process.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';

function deadIdentity(): ProcessIdentity {
  return { pid: 2_147_483_647, start: 'dead-incarnation', boot: 'dead-boot', group: 2_147_483_647 };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${description}`);
}

const workerUntilReleased = `#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
console.log(JSON.stringify({type:'thread.started',thread_id:'silence-wait-worker'}));
writeFileSync('.worker-started', 'ready');
if (process.env.GOAL_ATTEMPT === '1') {
  while (!existsSync('.worker-release')) await Bun.sleep(10);
}
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-qm', 'Complete fixture']);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

test('a running attempt adopted after a control-plane restart keeps the waits recorded since its last output', async () => {
  const h = harness(workerUntilReleased);
  let worker: Awaited<ReturnType<typeof h.tasks.retry>> | undefined;
  let release = '';
  h.settings.silenceMs = 1_000;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    worker = await h.tasks.retry(task.id);
    release = join(task.worktree, '.worker-release');
    await waitFor(() => existsSync(join(task.worktree, '.worker-started')), 'worker startup');
    await waitFor(() => (statSync(worker!.attempt.logPath, { throwIfNoEntry: false })?.size ?? 0) > 0, 'run output');

    const waitFile = worker.attempt.logPath.replace(/\.jsonl$/, '.check-wait');
    await Bun.sleep(350);
    writeFileSync(waitFile, '350\n');
    h.store.updateAttempt(worker.attempt, (attempt) => {
      (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadIdentity();
    });

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const adoption = job.recoverOrphans();
    // Record another wait after adoption. The adopted follower must retain the earlier 350 ms as well.
    await Bun.sleep(250);
    appendFileSync(waitFile, '200\n');
    await Bun.sleep(1_150);
    writeFileSync(release, 'release');
    await adoption;

    expect(h.store.attempt(worker.attempt).failureKind).toBeNull();
    expect(h.store.task(task.id).state).toBe('landing');
  } finally {
    if (release) writeFileSync(release, 'release');
    if (worker) await worker.exited;
    h.dispose();
  }
}, 15_000);

test('an adopted attempt that is silent and not waiting is still stopped after the silence window', async () => {
  const h = harness(workerUntilReleased);
  let worker: Awaited<ReturnType<typeof h.tasks.retry>> | undefined;
  let release = '';
  h.settings.silenceMs = 300;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    worker = await h.tasks.retry(task.id);
    release = join(task.worktree, '.worker-release');
    await waitFor(() => existsSync(join(task.worktree, '.worker-started')), 'worker startup');
    await waitFor(() => (statSync(worker!.attempt.logPath, { throwIfNoEntry: false })?.size ?? 0) > 0, 'run output');
    h.store.updateAttempt(worker.attempt, (attempt) => {
      (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadIdentity();
    });

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.recoverOrphans();
    await job.drain();

    const first = h.store.attempt({ taskId: task.id, attempt: 1 });
    expect(first.failureKind).toBe('tool');
    expect(first.result).toBe('stalled: no output for 1 minute');
    expect(h.store.task(task.id).currentAttempt).toBe(2);
  } finally {
    if (release) writeFileSync(release, 'release');
    if (worker) await worker.exited;
    h.dispose();
  }
}, 15_000);

test('waits credited at adoption never exceed the time since the last output', async () => {
  const h = harness(workerUntilReleased);
  let worker: Awaited<ReturnType<typeof h.tasks.retry>> | undefined;
  let release = '';
  h.settings.silenceMs = 300;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    worker = await h.tasks.retry(task.id);
    release = join(task.worktree, '.worker-release');
    await waitFor(() => existsSync(join(task.worktree, '.worker-started')), 'worker startup');
    await waitFor(() => (statSync(worker!.attempt.logPath, { throwIfNoEntry: false })?.size ?? 0) > 0, 'run output');
    // This file also contains waits from before the last output. Adoption may credit only its silent interval.
    writeFileSync(worker.attempt.logPath.replace(/\.jsonl$/, '.check-wait'), '60000\n');
    h.store.updateAttempt(worker.attempt, (attempt) => {
      (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadIdentity();
    });

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const adoption = job.recoverOrphans();
    // Keep the worker alive beyond the silence window if an overlarge historical wait is credited in full.
    await Bun.sleep(900);
    writeFileSync(release, 'release');
    await adoption;
    await job.drain();

    const first = h.store.attempt({ taskId: task.id, attempt: 1 });
    expect(first.failureKind).toBe('tool');
    expect(first.result).toBe('stalled: no output for 1 minute');
  } finally {
    if (release) writeFileSync(release, 'release');
    if (worker) await worker.exited;
    h.dispose();
  }
}, 15_000);
