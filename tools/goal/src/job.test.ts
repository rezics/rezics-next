import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LandingRequest } from './contracts.ts';
import { newestWorktreeMtime, WorkerJob } from './job.ts';
import { harness, reading, tempDirectory } from './test-support.ts';

function waitingResumeCli(checkId: string): string {
  const waiting = JSON.stringify({ status: 'waiting', summary: 'check is running', checks: [checkId] });
  return `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
if (process.argv.includes('resume')) {
  writeFileSync(join(root, '.temp/goal/resume-args.json'), JSON.stringify(process.argv));
  writeFileSync(join(root, '.temp/goal/resume-started'), 'yes');
  writeFileSync('result.txt', 'accepted');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-qm', 'Resume check session']);
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
} else {
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(waiting)}}}));
}
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let step = 0; step < 200; step += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for capacity ticket');
}

function poolReading(
  pool: ReturnType<typeof harness>['settings']['pools'][number],
  used: number,
  resetsAt: number,
) {
  const value = reading(pool, used);
  value.at = value.observedAt = new Date().toISOString();
  value.windows[0]!.minutes = 10080;
  value.windows[0]!.resetsAt = resetsAt;
  return value;
}

test('newest worktree mtime ignores node_modules and .temp', async () => {
  const root = tempDirectory();
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(root, '.temp'), { recursive: true });
  const kept = join(root, 'src/file.txt');
  writeFileSync(kept, 'kept');
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'ignored');
  writeFileSync(join(root, '.temp/scratch'), 'ignored');
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  utimesSync(root, past, past);
  utimesSync(join(root, 'src'), past, past);
  utimesSync(kept, past, past);
  utimesSync(join(root, 'node_modules/pkg/index.js'), future, future);
  utimesSync(join(root, '.temp/scratch'), future, future);
  expect(await newestWorktreeMtime(root)).toBe(lstatSync(kept).mtimeMs);
});

const fileActiveEmptyLogCli = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (let i = 0; i < 20; i++) {
  writeFileSync('progress.txt', String(i));
  await new Promise((resolve) => setTimeout(resolve, 80));
}
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt', 'progress.txt']);
spawnSync('git', ['commit', '-qm', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'file-active-worker'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

const idleEmptyLogCli = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.env.GOAL_ATTEMPT === '1') {
  await new Promise((resolve) => setTimeout(resolve, 600_000));
} else {
  writeFileSync('result.txt', 'accepted');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-qm', 'Complete fixture']);
  console.log(JSON.stringify({type:'thread.started',thread_id:'idle-replacement'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
}
`;

test('A worker whose run log stays empty but whose worktree files or branch head change is not stopped as stalled; one with no log, worktree, commit or process CPU activity for the window is.', async () => {
  const active = harness(fileActiveEmptyLogCli);
  const landings: LandingRequest[] = [];
  active.settings.silenceMs = 400;
  active.settings.startGraceMs = 30_000;
  try {
    const task = active.tasks.dispatch(active.briefFile);
    const job = new WorkerJob(active.tasks, { enqueue: (request) => landings.push(request) }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    expect(active.store.task(task.id).currentAttempt).toBe(1);
    const activeAttempt = active.store.attempt({ taskId: task.id, attempt: 1 });
    expect(activeAttempt.state).toBe('exited');
    expect(activeAttempt.failureKind ?? null).toBeNull();
    expect(landings).toHaveLength(1);
  } finally {
    await active.disposeAsync();
  }

  const idle = harness(idleEmptyLogCli);
  idle.settings.silenceMs = 400;
  idle.settings.startGraceMs = 30_000;
  try {
    const task = idle.tasks.dispatch(idle.briefFile);
    const job = new WorkerJob(idle.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    const first = idle.store.attempt({ taskId: task.id, attempt: 1 });
    expect(first.failureKind).toBe('tool');
    expect(first.result).toBe('stalled: no output for 1 minute');
  } finally {
    await idle.disposeAsync();
  }
}, 30_000);

test('a queued check wake rechecks its original pool and resumes the same session after its allowance window resets', async () => {
  const checkId = randomUUID();
  const h = harness(waitingResumeCli(checkId));
  const capacityFile = join(h.settings.stateDirectory, 'capacity.json');
  let recovery: Promise<void> | undefined;
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8')) as {
      pools: Array<{ policy: Record<string, unknown> }>;
    };
    local.pools[0]!.policy = { ...local.pools[0]!.policy, allowUnknown: false, maxBurnPerHour: 0.6, maxConcurrent: 1 };
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const policy = structuredClone(h.settings.policy!);
    policy.capacity.pollIntervalMs = 5;
    h.settings.policy = policy;

    let used = 50;
    let resetsAt = Date.now() + 8 * 60 * 60_000;
    let occupied = false;
    Object.defineProperty(h.tasks, 'reader', {
      value: (pool: (typeof h.settings.pools)[number]) => poolReading(pool, used, resetsAt),
    });
    Object.defineProperty(h.store, 'runningAttemptsByPool', {
      value: () => (occupied ? { [h.settings.pools[0]!.name]: 1 } : {}),
    });
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    const ref = { taskId: task.id, attempt: 1 };
    const original = h.store.attempt(ref);
    expect(original.state).toBe('waiting');
    occupied = true;

    const results = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, `${checkId}.json`), JSON.stringify({ status: 'finished', exitStatus: 0 }));
    writeFileSync(capacityFile, JSON.stringify({ maxWorkers: 0, minAvailableMiB: 0 }));
    recovery = job.recoverOrphans();
    const queue = join(h.settings.stateDirectory, 'capacity-queue');
    await waitFor(() => existsSync(queue) && readdirSync(queue).some((name) => name.includes(task.id)));

    local.pools.push({
      ...local.pools[0]!,
      name: 'alternate',
      allowanceKey: 'alternate',
      configDirectory: '/fixture/alternate',
    });
    writeFileSync(h.settings.localFile, JSON.stringify(local));

    const previous = poolReading(h.settings.pools[0]!, 50, resetsAt);
    previous.at = previous.observedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    writeFileSync(
      join(h.settings.stateDirectory, 'pool-readings.json'),
      JSON.stringify({ version: 1, readings: [previous] }),
    );
    writeFileSync(capacityFile, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    await recovery;
    recovery = undefined;
    expect(h.store.attempt(ref)).toMatchObject({
      state: 'waiting',
      pool: original.pool,
      session: original.session,
      driver: null,
    });
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(existsSync(join(task.worktree, '.temp/goal/resume-started'))).toBe(false);
    expect(readdirSync(queue)).toHaveLength(0);

    occupied = false;
    used = 51;
    recovery = job.recoverOrphans();
    await recovery;
    recovery = undefined;
    expect(h.store.attempt(ref)).toMatchObject({ state: 'waiting', pool: original.pool, session: original.session });
    expect(existsSync(join(task.worktree, '.temp/goal/resume-started'))).toBe(false);

    resetsAt += 7 * 24 * 60 * 60_000;
    recovery = job.recoverOrphans();
    await recovery;
    recovery = undefined;
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args).toContain(original.session!);
    expect(h.store.attempt(ref).state).toBe('exited');
    expect(h.store.task(task.id).currentAttempt).toBe(1);
  } finally {
    if (recovery) {
      writeFileSync(capacityFile, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
      await recovery;
    }
    await h.disposeAsync();
  }
}, 30_000);
