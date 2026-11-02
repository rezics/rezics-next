import { expect, test } from 'bun:test';
import { existsSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { StaleAttemptError } from './contracts.ts';
import type { LandingRequest, ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { settle } from './settle.ts';
import { sameProcess } from './process.ts';
import { git } from './tasks.ts';
import { harness } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(join(path, '..'), () => {
      if (existsSync(path)) {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`missing fixture signal: ${path}`));
    }, 10000);
    if (existsSync(path)) {
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
  });
}
test('brief -> worktree -> fake official CLI -> record -> fenced enqueue, then integration outcome', async () => {
  const h = harness(),
    landings: LandingRequest[] = [],
    inbox: ManagerEvent[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(
      h.tasks,
      { enqueue: (request) => landings.push(request) },
      { deliver: (event) => inbox.push(event) },
    );
    await job.start(task.id);
    expect(readFileSync(join(task.worktree, 'result.txt'), 'utf8')).toBe('accepted');
    expect(git(task.worktree, ['branch', '--show-current'])).toBe(task.branch);
    expect(git(task.worktree, ['status', '--porcelain'])).toBe('');
    expect(task.briefPath.startsWith(h.settings.stateDirectory)).toBe(true);
    const workerCommit = git(task.worktree, ['rev-parse', `${task.branch}^{commit}`]);
    expect(landings).toEqual([
      {
        taskId: task.id,
        attempt: 1,
        worktree: task.worktree,
        branch: task.branch,
        declaredPaths: ['result.txt'],
        workerCommit,
        protectedPaths: h.tasks.protectedPaths(task.brief),
        gate: ['bun', 'test'],
      },
    ]);
    const landingEvent = h.store.events(task.id, 1).find((event) => event.kind === 'landing-requested');
    expect(JSON.parse(landingEvent!.body)).toEqual(landings[0]);
    expect(landings[0]!.protectedPaths).toContain('**/auth/**');
    const ref = { taskId: task.id, attempt: 1 },
      record = h.store.record(ref)!;
    expect(record.tokens).toEqual({ input: 120, cached: 80, output: 20 });
    expect(record.stepClasses.commit).toBe(1);
    expect(record.before?.pool).toBe('fixture');
    expect(record.after?.pool).toBe('fixture');
    const evidence = h.store.attempt(ref).evidencePath;
    expect(readFileSync(join(evidence, 'diff.patch'), 'utf8')).toContain('+accepted');
    job.onGateOutcome({
      ...ref,
      passed: true,
      stage: 'merge',
      logPath: 'fixture',
      changedFiles: ['result.txt'],
      diffLines: 1,
      hostMs: 31,
      mergedCommit: git(task.worktree, ['rev-parse', 'HEAD']),
    });
    expect(h.store.task(task.id).state).toBe('integrated');
    expect(h.store.record(ref)?.hostMs).toBe(31);
    expect(h.store.record(ref)?.outcome).toBe('passed');
    expect(inbox).toEqual([]);
    await job.recover(task.id);
    expect(h.store.task(task.id).state).toBe('integrated');
    expect(h.store.record(ref)?.outcome).toBe('passed');
    expect(landings).toHaveLength(1);
  } finally {
    h.dispose();
  }
});
test('retry atomically fences a live process and its CLI writes; replacement launches only after the entire old group exits', async () => {
  const storeModule = join(import.meta.dir, 'store.ts'),
    dbModule = join(import.meta.dir, 'db.ts'),
    processModule = join(import.meta.dir, 'process.ts');
  const cli = join(import.meta.dir, 'cli.ts');
  const script = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { WorkerStore } from ${JSON.stringify(storeModule)};
import { openDb } from ${JSON.stringify(dbModule)};
import { sameProcess } from ${JSON.stringify(processModule)};
const store = new WorkerStore(openDb(__GOAL_TEST_DATABASE_PATH__));
const ref = {taskId:process.env.GOAL_TASK_ID, attempt:Number(process.env.GOAL_ATTEMPT)};
const state = dirname(__GOAL_TEST_DATABASE_PATH__);
if(ref.attempt === 1) {
  // Keep a descendant in the same group as well as the identified leader.
  spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
  store.event(ref,'heartbeat',{});
  spawnSync(process.execPath, [${JSON.stringify(cli)}, 'event',ref.taskId,'1','cli-heartbeat']);
  writeFileSync(join(state,'ready'), 'ready');
  const interval=setInterval(()=>{ try {store.event(ref,'heartbeat',{});} catch {} },20);
  process.on('SIGTERM',()=>{
    clearInterval(interval);
    const rejected=[];
    for(const [name,write] of [
      ['event',()=>store.event(ref,'obsolete',{})],
      ['attempt',()=>store.updateAttempt(ref,a=>{a.result='obsolete'})],
      ['task',()=>store.updateTask(ref,t=>{t.state='merged'})],
      ['record',()=>store.putRecord({...store.record(ref),...ref})],
      ['landing',()=>store.landing({...ref,branch:'old',worktree:process.cwd(),declaredPaths:[],gate:[]},()=>{})],
      ['fence',()=>store.assertCurrent(ref)]
    ]) {try {write();}catch(e){if(e.name==='StaleAttemptError')rejected.push(name);}}
    const command=spawnSync(process.execPath,[${JSON.stringify(cli)},'event',ref.taskId,'1','obsolete'],{encoding:'utf8'});
    writeFileSync(join(state,'refusals'),JSON.stringify({rejected,code:command.status,error:command.stderr}));
    setTimeout(()=>process.exit(0),100);
  });
} else {
  const previous=store.attempt({taskId:ref.taskId,attempt:1});
  writeFileSync(join(state,'replacement'),String(previous.process && sameProcess(previous.process)));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
  store.db.close();
}
`;
  const h = harness(script),
    landings: LandingRequest[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const ready = waitForFile(join(h.settings.stateDirectory, 'ready'));
    const first = await h.tasks.retry(task.id);
    await ready;
    const identity = h.store.attempt(first.attempt).process!;
    expect(sameProcess(identity)).toBe(true);
    const second = await h.tasks.retry(task.id);
    await settle(h.tasks, second, { enqueue: (request) => landings.push(request) });
    await expect(settle(h.tasks, first, { enqueue: (request) => landings.push(request) })).rejects.toBeInstanceOf(
      StaleAttemptError,
    );
    const refusals = JSON.parse(readFileSync(join(h.settings.stateDirectory, 'refusals'), 'utf8'));
    expect(refusals.rejected).toEqual(['event', 'attempt', 'task', 'record', 'landing', 'fence']);
    expect(refusals.code).toBe(1);
    expect(refusals.error).toContain('StaleAttemptError');
    expect(sameProcess(identity)).toBe(false);
    expect(readFileSync(join(h.settings.stateDirectory, 'replacement'), 'utf8')).toBe('false');
    expect(h.store.attempt(first.attempt).state).toBe('superseded');
    expect(h.store.events(task.id).filter((e) => e.kind === 'obsolete')).toEqual([]);
    expect(landings.map((r) => r.attempt)).toEqual([2]);
    expect(() => h.store.assertCurrent(first.attempt)).toThrow(StaleAttemptError);
    expect(h.store.records().map((r) => r.attempt)).toEqual([1, 2]);
  } finally {
    h.dispose();
  }
}, 15000);
test('registered CLI dispatch runs against injected landing and inbox adapters', async () => {
  const h = harness(),
    requests: LandingRequest[] = [],
    output: string[] = [];
  try {
    expect(
      await runWorkerCommand('dispatch', [h.briefFile], {
        settings: h.settings,
        store: h.store,
        tasks: h.tasks,
        landing: { enqueue: (r) => requests.push(r) },
        inbox: { deliver() {} },
        print: (s) => output.push(s),
        env: {},
      }),
    ).toBe(0);
    expect(requests.length).toBe(1);
    expect(output[0]).toBe(requests[0]!.taskId);
    expect(
      await runWorkerCommand('attempts', ['--json'], {
        settings: h.settings,
        store: h.store,
        print: (s) => output.push(s),
        env: {},
      }),
    ).toBe(0);
    expect(JSON.parse(output[1]!)[0].tokens.input).toBe(120);
    // The executable has the same command registration and reads the main checkout's untracked settings.
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), 'status', requests[0]!.taskId], {
      cwd: h.root,
      env: { ...process.env, GOAL_MAIN_CHECKOUT: h.root, GOAL_TASK_ID: '', GOAL_ATTEMPT: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).state).toBe('landing');
  } finally {
    h.dispose();
  }
});

test('a restarted controller settles a persisted attempt with a kernel process notification', async () => {
  const h = harness(`#!/usr/bin/env bun
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:8,output_tokens:1}}));
`),
    requests: LandingRequest[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile),
      worker = await h.tasks.retry(task.id);
    await worker.exited;
    // A fresh job has no ChildProcess handle and discovers the running attempt from SQLite.
    const recovered = new WorkerJob(h.tasks, { enqueue: (r) => requests.push(r) }, { deliver() {} });
    await recovered.recover(task.id);
    expect(requests.map((r) => r.attempt)).toEqual([1]);
    expect(h.store.records()[0]!.tokens.input).toBe(8);
  } finally {
    h.dispose();
  }
});
test('stop fences the same sequence and an explicit retry starts a fresh attempt', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile),
      worker = await h.tasks.retry(task.id);
    await worker.exited;
    await h.tasks.stop(task.id);
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(() => h.store.event(worker.attempt, 'old-result', {})).toThrow(StaleAttemptError);
    const next = await h.tasks.retry(task.id);
    await settle(h.tasks, next, { enqueue() {} });
    expect(next.attempt.attempt).toBe(2);
    expect(h.store.record(worker.attempt)?.outcome).toBe('stopped');
  } finally {
    h.dispose();
  }
});

test('evidence captures untracked edits and explicit approach results without copying the session stream', async () => {
  const h = harness(`#!/usr/bin/env bun
import {writeFileSync} from 'node:fs';
writeFileSync('result.txt','uncommitted new file');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'APPROACH: add the missing guard\\nOUTCOME: assertion still fails\\nBLOCKER: fixing the assertion'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:8}}));
`);
  try {
    const task = h.tasks.dispatch(h.briefFile),
      job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    const attempt = h.store.attempt({ taskId: task.id, attempt: 1 });
    expect(readFileSync(join(attempt.evidencePath, 'diff.patch'), 'utf8')).toContain('+uncommitted new file');
    expect(attempt.approaches).toEqual([{ approach: 'add the missing guard', result: 'assertion still fails' }]);
    // Reattaching twice cannot submit the same attempt twice.
    const requests: LandingRequest[] = [];
    await new WorkerJob(h.tasks, { enqueue: (r) => requests.push(r) }, { deliver() {} }).recover(task.id);
    expect(requests).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('a missing CLI is recorded as a stopped attempt with after-usage, and remains retryable', async () => {
  const h = harness();
  try {
    h.settings.pools[0]!.command = join(h.root, '.temp/missing-cli');
    const task = h.tasks.dispatch(h.briefFile);
    await expect(h.tasks.retry(task.id)).rejects.toThrow();
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(h.store.records()[0]!.outcome).toBe('stopped');
    expect(h.store.records()[0]!.after?.pool).toBe('fixture');
  } finally {
    h.dispose();
  }
});
