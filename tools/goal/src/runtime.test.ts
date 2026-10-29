import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createRuntime } from './config.ts';
import { StaleAttemptError } from './contracts.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { harness, markdown, reading } from './test-support.ts';
import { git, WorkerTasks } from './tasks.ts';
import { settle } from './settle.ts';

function simpleBrief(path: string): void {
  writeFileSync(path, markdown.replace('command: [bun, test]', 'command: ["true"]'));
}

test('shared runtime dispatches a fake CLI commit through settle, dev integration and main promotion', async () => {
  const h = harness();
  h.settings.gate = ['true'];
  simpleBrief(h.briefFile);
  try {
    const runtime = createRuntime({ tasks: h.tasks });
    const output: string[] = [];
    expect(
      await runWorkerCommand('dispatch', [h.briefFile], { runtime, env: {}, print: (value) => output.push(value) }),
    ).toBe(0);
    const task = h.store.task(output[0]!);
    expect(task.state).toBe('merged');
    expect(readFileSync(join(h.root, 'result.txt'), 'utf8')).toBe('accepted');
    expect(h.store.records()[0]!.outcome).toBe('passed');
    expect(runtime.queue.next()).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('merged-result failure retries the original profile and refuses its retired landing request', async () => {
  const h = harness(`#!/usr/bin/env bun
import {writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
writeFileSync('result.txt',process.env.GOAL_ATTEMPT==='1'?'incompatible':'accepted');
spawnSync('git',['add','result.txt']); spawnSync('git',['commit','-m','Implement result']);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`);
  h.settings.gate = ['true'];
  const command = [
    process.execPath,
    '-e',
    "const fs=require('fs'); if(fs.existsSync('dependency.txt') && fs.existsSync('result.txt') && fs.readFileSync('result.txt','utf8')==='incompatible'){console.error('AssertionError: expected compatible result');process.exit(1)}",
  ];
  writeFileSync(h.briefFile, markdown.replace('command: [bun, test]', `command: ${JSON.stringify(command)}`));
  try {
    const runtime = createRuntime({ tasks: h.tasks });
    const task = h.tasks.dispatch(h.briefFile);
    const devBeforeDependency = git(h.root, ['rev-parse', 'dev']);
    writeFileSync(join(h.root, 'dependency.txt'), 'landed predecessor');
    git(h.root, ['add', 'dependency.txt']);
    git(h.root, ['commit', '-m', 'Add predecessor']);
    const dependency = git(h.root, ['rev-parse', 'main']);
    git(h.root, ['update-ref', 'refs/heads/dev', dependency, devBeforeDependency]);
    await runtime.job.start(task.id);
    await runtime.job.drain();
    const records = h.store.records();
    expect(records.map((record) => record.outcome)).toEqual(['gate-failed', 'passed']);
    expect(records[1]!.profile).toEqual(records[0]!.profile);
    expect(records[1]!.fixRound).toBe(1);
    expect(h.store.task(task.id).state).toBe('merged');
    expect(readFileSync(join(h.root, 'result.txt'), 'utf8')).toBe('accepted');
    expect(() =>
      runtime.queue.enqueue({
        taskId: task.id,
        attempt: 1,
        branch: task.branch,
        worktree: task.worktree,
        declaredPaths: task.brief.paths,
        gate: command,
      }),
    ).toThrow(StaleAttemptError);
  } finally {
    h.dispose();
  }
});

test('an enqueue while the train is finishing waits for the lease and lands without a lost wakeup', async () => {
  const h = harness();
  h.settings.gate = ['true'];
  simpleBrief(h.briefFile);
  let release!: () => void, finishing!: () => void, enqueued!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    finishing = resolve;
  });
  const published = new Promise<void>((resolve) => {
    enqueued = resolve;
  });
  let once = false;
  try {
    const runtime = createRuntime({
      tasks: h.tasks,
      train: {
        async beforeRelease() {
          if (!once) {
            once = true;
            finishing();
            await blocked;
          }
        },
      },
    });
    const first = h.tasks.dispatch(h.briefFile),
      second = h.tasks.dispatch(h.briefFile);
    const started = runtime.job.start(first.id);
    await ready;
    // The second task changes a separate file to keep this test focused on the train handoff.
    const script = h.settings.pools[0]!.command;
    writeFileSync(script, readFileSync(script, 'utf8').replaceAll('result.txt', 'second.txt'));
    h.store.updateTask({ taskId: second.id, attempt: 0 }, (task) => {
      task.brief.paths = ['second.txt'];
    });
    const enqueue = runtime.queue.enqueue.bind(runtime.queue);
    runtime.queue.enqueue = (request) => {
      enqueue(request);
      if (request.taskId === second.id) enqueued();
    };
    const other = runtime.job.start(second.id);
    await published;
    expect(runtime.queue.next()?.request.taskId).toBe(second.id);
    release();
    await Promise.all([started, other]);
    await runtime.job.drain();
    await runtime.pump();
    expect(h.store.tasks().map((task) => task.state)).toEqual(['merged', 'merged']);
    expect(runtime.queue.next()).toBeUndefined();
  } finally {
    release();
    h.dispose();
  }
}, 15000);

for (const when of ['dev', 'promotion'] as const)
  test(`cross-process supersession at the ${when} advance is serialized with the actual Git advance`, async () => {
    const h = harness();
    simpleBrief(h.briefFile);
    let train: ReturnType<typeof spawn> | undefined, retry: ReturnType<typeof spawn> | undefined;
    try {
      const runtime = createRuntime({ tasks: h.tasks });
      const task = h.tasks.dispatch(h.briefFile),
        worker = await h.tasks.retry(task.id);
      await settle(h.tasks, worker, runtime.queue);
      const env = { ...process.env, GOAL_MAIN_CHECKOUT: h.root, GOAL_STATE_DIRECTORY: h.settings.stateDirectory };
      const wait = "console.log('held'); const b=Buffer.alloc(1); readSync(0,b,0,1,null);";
      const source = `import {readSync} from 'node:fs';
import {createRuntime} from ${JSON.stringify(join(import.meta.dir, 'config.ts'))};
const runtime=createRuntime({runGate:async()=>({passed:true,output:'',timedOut:false}),
train:{${when === 'dev' ? `promote:async()=>{},beforeIntegrationAdvance(){${wait}}` : ''}${when === 'promotion' ? `beforePromotionAdvance(){${wait}}` : ''}}});
await runtime.pump(); runtime.close();`;
      const contender = `import {openDb} from ${JSON.stringify(join(import.meta.dir, 'db.ts'))};
import {WorkerStore} from ${JSON.stringify(join(import.meta.dir, 'store.ts'))};
const store=new WorkerStore(openDb(${JSON.stringify(join(h.settings.stateDirectory, 'goal.sqlite'))}));
const ref=${JSON.stringify({ taskId: task.id, attempt: 1 })}; const old=store.attempt(ref);
console.log('ready'); await new Promise(resolve=>process.stdin.once('data',resolve));
store.db.exec('PRAGMA busy_timeout=0');
try {store.nextAttempt(ref,n=>({...old,attempt:n,state:'pending'}));console.log('superseded')}
catch(error){
 if(error.code!=='SQLITE_BUSY') throw error;
 console.log('blocked'); store.db.exec('PRAGMA busy_timeout=5000');
 try {store.nextAttempt(ref,n=>({...old,attempt:n,state:'pending'}));console.log('superseded')}catch(error){console.log(error.message)}
}
store.db.close();`;
      retry = spawn(process.execPath, ['-e', contender], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const retryExit = new Promise<number | null>((resolve) => retry!.once('exit', resolve));
      const lines = createInterface({ input: retry.stdout! });
      const messages: string[] = [];
      let ready!: () => void, attempted!: () => void;
      const prepared = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const contended = new Promise<void>((resolve) => {
        attempted = resolve;
      });
      lines.on('line', (line) => {
        messages.push(line);
        if (line === 'ready') ready();
        if (line === 'blocked' || line === 'superseded') attempted();
      });
      await prepared;
      train = spawn(process.execPath, ['-e', source], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const trainExit = new Promise<number | null>((resolve) => train!.once('exit', resolve));
      let errors = '';
      train.stderr!.on('data', (data) => {
        errors += data;
      });
      await new Promise<void>((resolve) => createInterface({ input: train!.stdout! }).once('line', () => resolve()));
      retry.stdin!.write('x');
      retry.stdin!.end();
      await contended;
      expect(messages).toContain('blocked');
      train.stdin!.write('x');
      train.stdin!.end();
      expect(await trainExit).toBe(0);
      expect(errors).toBe('');
      expect(await retryExit).toBe(0);
      const current = h.store.task(task.id);
      if (when === 'dev') {
        expect(messages).toContain('cannot retry integrated task');
        expect(current.currentAttempt).toBe(1);
        expect(current.state).toBe('integrated');
        expect(existsSync(join(h.root, 'result.txt'))).toBe(false);
      } else {
        expect(messages).toContain('cannot retry merged task');
        expect(current.currentAttempt).toBe(1);
        expect(current.state).toBe('merged');
        expect(readFileSync(join(h.root, 'result.txt'), 'utf8')).toBe('accepted');
      }
    } finally {
      train?.kill('SIGKILL');
      retry?.kill('SIGKILL');
      h.dispose();
    }
  }, 15000);

test('structured worker exit records a spec conflict on the attempt and delivers the real manager inbox without inventing a gate', async () => {
  const h = harness(`#!/usr/bin/env bun
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'blocked',summary:'Contract disagreement',blocker:{kind:'spec-conflict',detail:'The required behaviors conflict'},approaches:[]})}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10}}));
`);
  h.settings.gate = ['true'];
  simpleBrief(h.briefFile);
  try {
    const runtime = createRuntime({ tasks: h.tasks });
    const task = h.tasks.dispatch(h.briefFile);
    await runtime.job.start(task.id);
    await runtime.job.drain();
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).failureKind).toBe('spec-conflict');
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(runtime.queue.next()).toBeUndefined();
    expect(h.store.events(task.id).some((event) => event.kind === 'gate-outcome')).toBe(false);
    expect(runtime.inbox.read(task.brief.manager).map((entry) => entry.event.kind)).toEqual(['spec-conflict']);
  } finally {
    h.dispose();
  }
});

test('native quota failure switches allowed pools on the same profile before asking for any gate', async () => {
  const h = harness(`#!/usr/bin/env bun
import {writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
if(process.env.GOAL_ATTEMPT==='1'){console.log(JSON.stringify({type:'turn.failed',error:{code:'usage_limit_exceeded',message:'Allowance unavailable'}})); process.exit(1)}
writeFileSync('result.txt','accepted');spawnSync('git',['add','result.txt']);spawnSync('git',['commit','-m','Complete result']);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5}}));
`);
  h.settings.gate = ['true'];
  simpleBrief(h.briefFile);
  h.settings.pools.push({ ...h.settings.pools[0]!, name: 'alternate', allowanceKey: 'alternate' });
  try {
    let fixtureReads = 0;
    const tasks = new WorkerTasks(h.settings, h.store, (pool) =>
      reading(pool, pool.name === 'fixture' ? (++fixtureReads > 1 ? 100 : 0) : 20),
    );
    const runtime = createRuntime({ tasks });
    const task = tasks.dispatch(h.briefFile);
    await runtime.job.start(task.id);
    await runtime.job.drain();
    await runtime.pump();
    const attempts = h.store.attempts(task.id);
    expect(attempts[0]!.failureKind).toBe('pool-exhausted');
    expect(attempts[0]!.pool).not.toBe(attempts[1]!.pool);
    expect(attempts[1]!.profile).toEqual(attempts[0]!.profile);
    expect(attempts[1]!.fixRound).toBe(0);
    expect(h.store.task(task.id).state).toBe('merged');
    expect(
      h.store
        .events(task.id)
        .filter((event) => event.kind === 'gate-outcome')
        .map((event) => event.attempt),
    ).toEqual([2]);
  } finally {
    h.dispose();
  }
});

test('the production CLI dispatch, train and inbox commands compose the real runtime without a runtime environment module', async () => {
  const h = harness();
  simpleBrief(h.briefFile);
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.gate = ['true'];
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GOAL_MAIN_CHECKOUT: h.root,
      GOAL_LOCAL_CONFIG: h.settings.localFile,
    };
    for (const key of ['GOAL_MANAGER', 'GOAL_TASK_ID', 'GOAL_ATTEMPT', 'GOAL_STATE_DIRECTORY', 'GOAL_WORKTREE_ROOT'])
      delete env[key];
    const command = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), ...args], {
        cwd: h.root,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe('');
      expect(code).toBe(0);
      return stdout;
    };
    const id = (await command('dispatch', h.briefFile)).trim();
    expect(await command('train')).toBe('');
    expect(h.store.task(id).state).toBe('merged');
    expect(h.store.records()[0]!.outcome).toBe('passed');
    expect(JSON.parse(await command('inbox', 'read', 'fixture'))).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('three failed attempts on one model send the next attempt to the route’s next model', async () => {
  const h = harness(`#!/usr/bin/env bun
import {writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
const model = process.argv[process.argv.indexOf('-m') + 1];
if (model === 'model-a') {
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'blocked',summary:'stuck',blocker:{kind:'spec-conflict',detail:'cannot satisfy'},approaches:[]})}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5}})); process.exit(0);
}
writeFileSync('result.txt','accepted');spawnSync('git',['add','result.txt']);spawnSync('git',['commit','-m','Complete result']);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5}}));
`);
  h.settings.gate = ['true'];
  simpleBrief(h.briefFile);
  try {
    const routing = JSON.parse(readFileSync(h.settings.routingFile, 'utf8'));
    const profile = (model: string) => ({
      cli: 'codex',
      model,
      effort: 'high',
      poolClass: h.settings.pools[0]!.classes[0],
    });
    for (const route of Object.values(routing.classes) as { first: unknown; fallbacks?: unknown[] }[]) {
      route.first = profile('model-a');
      route.fallbacks = [profile('model-b')];
    }
    routing.experiments = [];
    const routingFile = join(h.settings.stateDirectory, 'routing-switch.json');
    writeFileSync(routingFile, JSON.stringify(routing));
    h.settings.routingFile = routingFile;
    const runtime = createRuntime({ tasks: h.tasks });
    const task = h.tasks.dispatch(h.briefFile);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await runtime.job.start(task.id);
      await runtime.job.drain();
    }
    const models = h.store.attempts(task.id).map((attempt) => attempt.profile.model);
    expect(models).toEqual(['model-a', 'model-a', 'model-a', 'model-b']);
  } finally {
    h.dispose();
  }
});

test('a retry leaves an engine the routing table no longer offers for its class', async () => {
  const h = harness(`#!/usr/bin/env bun
import {writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
const model = process.argv[process.argv.indexOf('-m') + 1];
if (model === 'model-a') {
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'blocked',summary:'stuck',blocker:{kind:'spec-conflict',detail:'cannot satisfy'},approaches:[]})}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5}})); process.exit(0);
}
writeFileSync('result.txt','accepted');spawnSync('git',['add','result.txt']);spawnSync('git',['commit','-m','Complete result']);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5}}));
`);
  h.settings.gate = ['true'];
  simpleBrief(h.briefFile);
  try {
    const routing = JSON.parse(readFileSync(h.settings.routingFile, 'utf8'));
    const profile = (model: string) => ({
      cli: 'codex',
      model,
      effort: 'high',
      poolClass: h.settings.pools[0]!.classes[0],
    });
    const route = (model: string) => {
      for (const value of Object.values(routing.classes) as { first: unknown; fallbacks?: unknown[] }[]) {
        value.first = profile(model);
        value.fallbacks = [];
      }
    };
    routing.experiments = [];
    route('model-a');
    const routingFile = join(h.settings.stateDirectory, 'routing-dropped.json');
    writeFileSync(routingFile, JSON.stringify(routing));
    h.settings.routingFile = routingFile;
    const runtime = createRuntime({ tasks: h.tasks });
    const task = h.tasks.dispatch(h.briefFile);
    await runtime.job.start(task.id);
    await runtime.job.drain();
    // The table drops model-a; the retry must not keep it.
    route('model-b');
    writeFileSync(routingFile, JSON.stringify(routing));
    await runtime.job.start(task.id);
    await runtime.job.drain();
    expect(h.store.attempts(task.id).map((attempt) => attempt.profile.model)).toEqual(['model-a', 'model-b']);
  } finally {
    h.dispose();
  }
});
