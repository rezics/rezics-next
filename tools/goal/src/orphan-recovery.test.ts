import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProcessIdentity } from './process.ts';
import { WorkerJob } from './job.ts';
import { acquireDirectoryLease } from './lease.ts';
import { harness, temporaryDirectory } from './test-support.ts';

function deadIdentity(): ProcessIdentity {
  return { pid: 2_147_483_647, start: 'dead-incarnation', boot: 'dead-boot', group: 2_147_483_647 };
}

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      clearTimeout(timer); watcher.close(); resolve();
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`missing fixture signal: ${path}`)); }, 10000);
    if (existsSync(path)) { clearTimeout(timer); watcher.close(); resolve(); }
  });
}

const waitingWorker = `#!/usr/bin/env bun
import { existsSync, watch, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync('.worker-started', 'ready');
if (!existsSync('.worker-release')) await new Promise<void>(resolve => {
  const watcher = watch('.', () => {
    if (existsSync('.worker-release')) { watcher.close(); resolve(); }
  });
  if (existsSync('.worker-release')) { watcher.close(); resolve(); }
});
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:20}}));
`;

test('a lease released between a failed publish and the owner read is acquired instead of reported unrecognised', () => {
  const temporary = temporaryDirectory();
  const path = join(temporary.path, 'dispatch.lease');
  try {
    // A released lease leaves no owner file during this observable race window.
    mkdirSync(path);
    const acquired = acquireDirectoryLease(path);
    acquired.release();
  } finally { temporary.close(); }
});

test('an attempt whose driver died after the worker finished is settled and lands', async () => {
  const h = harness(), landings: { attempt: number }[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.store.updateAttempt(worker.attempt, attempt => {
      (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadIdentity();
    });

    const job = new WorkerJob(h.tasks, { enqueue: request => landings.push(request) }, { deliver() {} });
    await job.recoverOrphans();

    expect(h.store.task(task.id).state).toBe('landing');
    expect(h.store.attempt(worker.attempt).state).toBe('exited');
    expect(h.store.record(worker.attempt)?.tokens).toEqual({ input: 120, cached: 80, output: 20 });
    expect(landings.map(request => request.attempt)).toEqual([1]);
  } finally { h.dispose(); }
});

test('an attempt whose driver died while the worker runs is adopted and settled when the worker exits', async () => {
  const h = harness(waitingWorker);
  let release = '';
  let worker: Awaited<ReturnType<typeof h.tasks.retry>> | undefined;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    worker = await h.tasks.retry(task.id);
    const started = join(task.worktree, '.worker-started');
    release = join(task.worktree, '.worker-release');
    await waitForFile(started);
    h.store.updateAttempt(worker.attempt, attempt => {
      (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadIdentity();
    });
    const landings: { attempt: number }[] = [];
    const job = new WorkerJob(h.tasks, { enqueue: request => landings.push(request) }, { deliver() {} });
    let recovered = false;
    const adoption = job.recoverOrphans().then(() => { recovered = true; });

    expect(recovered).toBe(false);
    expect(h.store.task(task.id).state).toBe('running');
    writeFileSync(release, 'release');
    await adoption;

    expect(h.store.task(task.id).state).toBe('landing');
    expect(h.store.record(worker.attempt)?.tokens.input).toBe(120);
    expect(landings.map(request => request.attempt)).toEqual([1]);
  } finally {
    if (release) writeFileSync(release, 'release');
    if (worker) await worker.exited;
    h.dispose();
  }
});

test('a finished orphan settles while an adopted orphan before it is still running', async () => {
  const h = harness(waitingWorker);
  const releases: string[] = [];
  const workers: Awaited<ReturnType<typeof h.tasks.retry>>[] = [];
  try {
    // Recovery visits attempts in task id order; the running one comes first, so following in turn would block.
    const tasks = [h.tasks.dispatch(h.briefFile), h.tasks.dispatch(h.briefFile)].toSorted((a, b) => a.id.localeCompare(b.id));
    const running = tasks[0]!, finished = tasks[1]!;
    for (const task of [running, finished]) {
      workers.push(await h.tasks.retry(task.id));
      releases.push(join(task.worktree, '.worker-release'));
      await waitForFile(join(task.worktree, '.worker-started'));
    }
    writeFileSync(releases[1]!, 'release'); await workers[1]!.exited;
    for (const worker of workers) h.store.updateAttempt(worker.attempt, attempt => {
      (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadIdentity();
    });
    const landed: string[] = [];
    const job = new WorkerJob(h.tasks, { enqueue: request => landed.push(request.taskId) }, { deliver() {} });
    const adoption = job.recoverOrphans();
    for (let wait = 0; wait < 100 && !landed.length; wait++) await Bun.sleep(50);

    expect(landed).toEqual([finished.id]);
    expect(h.store.task(running.id).state).toBe('running');
    writeFileSync(releases[0]!, 'release');
    await adoption;
    expect(landed.toSorted()).toEqual([running.id, finished.id].toSorted());
  } finally {
    for (const release of releases) writeFileSync(release, 'release');
    for (const worker of workers) await worker.exited;
    h.dispose();
  }
});

test('an exception in the driver ends the attempt as an environment failure delivered to the manager', async () => {
  const h = harness(), inbox: { kind: string; summary: string }[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, {
      enqueue() { throw new Error('driver landing adapter failed'); },
    }, { deliver: event => inbox.push(event) });

    await expect(job.start(task.id)).resolves.toBeUndefined();

    const attempt = h.store.attempt({ taskId: task.id, attempt: 1 });
    expect(attempt.state).toBe('exited');
    expect(attempt.escalation).toBe('environment');
    expect(h.store.record({ taskId: task.id, attempt: 1 })?.escalation).toBe('environment');
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.summary).toContain('driver landing adapter failed');
  } finally { h.dispose(); }
});

test('a short command leaves an orphan whose worker runs to the host and skips a held lease without waiting', async () => {
  const h = harness(waitingWorker);
  let release = '';
  let worker: Awaited<ReturnType<typeof h.tasks.retry>> | undefined;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    worker = await h.tasks.retry(task.id);
    release = join(task.worktree, '.worker-release');
    await waitForFile(join(task.worktree, '.worker-started'));
    h.store.updateAttempt(worker.attempt, attempt => {
      (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadIdentity();
    });
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const started = Date.now();
    await job.recoverOrphans({ adoptRunning: false });
    const held = acquireDirectoryLease(join(h.tasks.settings.stateDirectory, 'leases', task.id));
    try { await job.recoverOrphans(); } finally { held.release(); }
    expect(Date.now() - started).toBeLessThan(5000);
    expect(h.store.task(task.id).state).toBe('running');
  } finally {
    if (release) writeFileSync(release, 'release');
    if (worker) await worker.exited;
    h.dispose();
  }
});

// The first attempt ends without a report, the way a killed worker does; the next one succeeds.
const reportsOnRetry = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
if (process.env.GOAL_ATTEMPT !== '1') {
  writeFileSync('result.txt', 'accepted');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-m', 'Complete fixture']);
  console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'RESULT: success'}}));
}
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:20}}));
`;

test('the host sweep retries an orphan that ended without a report, after it releases the task lease', async () => {
  const h = harness(reportsOnRetry), landings: { attempt: number }[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.store.updateAttempt(worker.attempt, attempt => {
      (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadIdentity();
    });
    const job = new WorkerJob(h.tasks, { enqueue: request => landings.push(request) }, { deliver() {} });
    const started = Date.now();
    await job.recoverOrphans();
    await job.drain();

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(h.store.attempt(worker.attempt).escalation).toBe('environment');
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.task(task.id).state).toBe('landing');
    expect(landings.map(request => request.attempt)).toEqual([2]);
  } finally { h.dispose(); }
});

test('a classified exit whose retry was lost with its process is retried by the next host sweep', async () => {
  const h = harness(reportsOnRetry), landings: { attempt: number }[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    // What a host left behind when it ended between classifying the exit and starting the retry.
    h.store.updateAttempt(worker.attempt, attempt => {
      (attempt as typeof attempt & { driver?: ProcessIdentity }).driver = deadIdentity();
      attempt.state = 'exited'; attempt.failureKind = 'tool'; attempt.escalation = 'environment';
    });
    h.store.event(worker.attempt, 'attempt-exit-classified', { kind: 'environment', detail: 'killed' });
    expect(h.store.task(task.id).state).toBe('running');

    const job = new WorkerJob(h.tasks, { enqueue: request => landings.push(request) }, { deliver() {} });
    await job.recoverOrphans();
    await job.drain();

    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(landings.map(request => request.attempt)).toEqual([2]);
    expect(h.store.retryIntent(worker.attempt)?.status).toBe('started');
  } finally { h.dispose(); }
});
