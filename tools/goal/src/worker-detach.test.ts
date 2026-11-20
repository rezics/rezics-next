import { expect, test } from 'bun:test';
import { existsSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { WorkerJob } from './job.ts';
import { processIdentity, sameProcess, waitForProcessGroup } from './process.ts';
import { harness } from './test-support.ts';
import type { Attempt } from './types.ts';

// The worker holds until a release file appears, commits, reports success and exits with a distinctive code.
const heldWorker = (exitCode: number) => `#!/usr/bin/env bun
import { existsSync, watch, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync('.worker-started', 'ready');
if (!existsSync('.worker-release')) await new Promise<void>(resolve => {
  const watcher = watch('.', () => { if (existsSync('.worker-release')) { watcher.close(); resolve(); } });
  if (existsSync('.worker-release')) { watcher.close(); resolve(); }
});
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:1}}));
process.exit(${exitCode});
`;

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (existsSync(path)) {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`missing fixture signal: ${path}`));
    }, 15000);
    if (existsSync(path)) {
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
  });
}
/** Run the manager's retry tool call, then start its persisted intent from the host recovery path. */
async function launchAfterRetryCliExits(h: ReturnType<typeof harness>, taskId: string): Promise<Attempt> {
  // `retry` records a retry, so first create and stop an attempt as a manager would.
  const first = await h.tasks.retry(taskId);
  const worktree = h.store.task(taskId).worktree;
  await waitForFile(join(worktree, '.worker-started'));
  writeFileSync(join(worktree, '.worker-release'), 'finish initial attempt');
  await first.exited;
  h.store.updateTask(first.attempt, (task) => {
    task.state = 'stopped';
  });
  unlinkSync(join(worktree, '.worker-started'));
  unlinkSync(join(worktree, '.worker-release'));
  unlinkSync(join(worktree, 'result.txt'));
  const launcher = spawn(process.execPath, [join(import.meta.dir, 'cli.ts'), 'retry', taskId], {
    cwd: h.root,
    stdio: 'ignore',
    env: { ...process.env, GOAL_MAIN_CHECKOUT: h.root, GOAL_TASK_ID: '', GOAL_ATTEMPT: '' },
  });
  await new Promise<void>((resolve, reject) => {
    launcher.once('error', reject);
    launcher.once('exit', () => resolve());
  });
  // Retry only records durable intent. The host, which outlives the CLI, owns starting it.
  const ref = { taskId, attempt: h.store.task(taskId).currentAttempt };
  expect(h.store.retryIntent(ref)?.status).toBe('pending');
  const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
  const recovery = host.recoverOrphans();
  await waitForFile(join(h.store.task(taskId).worktree, '.worker-started'));
  const attempt = h.store.attempt({ taskId, attempt: h.store.task(taskId).currentAttempt });
  expect(attempt.process).not.toBeNull();
  await recovery;
  return attempt;
}

test('the host starts a detached worker from retry intent after the retry CLI exits', async () => {
  const h = harness(heldWorker(0));
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = await launchAfterRetryCliExits(h, task.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sameProcess(attempt.process!)).toBe(true);
    const worktree = h.store.task(task.id).worktree;
    expect(existsSync(join(worktree, 'result.txt'))).toBe(false);
    writeFileSync(join(worktree, '.worker-release'), 'go');
    await waitForProcessGroup(attempt.process!);
    expect(existsSync(join(worktree, 'result.txt'))).toBe(true);
    expect(existsSync(`${attempt.logPath}.exit`)).toBe(true);
  } finally {
    await h.disposeAsync();
  }
}, 30000);

test('the follower still settles that worker with its real exit code read after it ends', async () => {
  const h = harness(heldWorker(7));
  try {
    const task = h.tasks.dispatch(h.briefFile),
      requests: { attempt: number }[] = [];
    const worker = await h.tasks.retry(task.id);
    const release = join(h.store.task(task.id).worktree, '.worker-release');
    const settled = new WorkerJob(h.tasks, { enqueue: (r) => requests.push(r) }, { deliver() {} }).follow(worker);
    await waitForFile(join(h.store.task(task.id).worktree, '.worker-started'));
    expect(h.store.attempt(worker.attempt).state).toBe('running');
    writeFileSync(release, 'go');
    await settled;
    expect(h.store.attempt(worker.attempt).exitCode).toBe(7);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.attempt).toBe(worker.attempt.attempt);
  } finally {
    await h.disposeAsync();
  }
}, 30000);

test('a restarted controller adopts a detached worker and settles it only after it has really exited', async () => {
  const h = harness(heldWorker(7));
  try {
    const task = h.tasks.dispatch(h.briefFile),
      requests: { attempt: number }[] = [];
    // Launch without an old follower competing with the replacement controller for settlement.
    const { attempt: ref } = await h.tasks.retry(task.id);
    const worktree = h.store.task(task.id).worktree;
    await waitForFile(join(worktree, '.worker-started'));
    h.store.updateAttempt(ref, (current) => {
      current.driver = { pid: -1, start: 'missing', boot: 'missing', group: -1 };
    });
    let done = false;
    const recovery = new WorkerJob(h.tasks, { enqueue: (r) => requests.push(r) }, { deliver() {} })
      .recoverOrphans()
      .then(() => {
        done = true;
      });
    const driver = processIdentity()!;
    for (let n = 0; !done && h.store.attempt(ref).driver?.pid !== driver.pid && n < 300; n++) await Bun.sleep(10);
    expect(h.store.attempt(ref).driver).toEqual(driver);
    await Bun.sleep(1500);
    expect(done).toBe(false);
    expect(sameProcess(ref.process!)).toBe(true);
    expect(h.store.attempt(ref).state).toBe('running');
    expect(requests).toEqual([]);
    writeFileSync(join(worktree, '.worker-release'), 'go');
    await recovery;
    expect(sameProcess(ref.process!)).toBe(false);
    expect(h.store.attempt(ref).state).toBe('exited');
    expect(h.store.attempt(ref).exitCode).toBe(7);
  } finally {
    await h.disposeAsync();
  }
}, 30000);
