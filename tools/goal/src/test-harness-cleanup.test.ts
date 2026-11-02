import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fixtureOwnedProcesses } from './fixture-process-ownership.ts';
import { processIdentity, sameProcess, terminateProcessGroup, type ProcessIdentity } from './process.ts';
import { harness } from './test-support.ts';

const workerScript = `#!/usr/bin/env bun
import { writeFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const selfTermination = setTimeout(() => process.exit(124), 40000);
const descendant = spawn(process.execPath, ['-e', "const fs=require('node:fs'); fs.writeFileSync('.worker-descendant-pid', String(process.pid)); setTimeout(() => process.exit(0), 45000); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
writeFileSync('.worker-pid', String(process.pid));
writeFileSync('.worker-started', 'ready');
while (!existsSync('.worker-release')) await Bun.sleep(10);
descendant.kill('SIGTERM');
await new Promise(resolve => descendant.once('exit', resolve));
clearTimeout(selfTermination);
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-qm', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(path)) throw new Error(`timed out waiting for fixture file: ${path}`);
}

async function startFixtureWorker(h: ReturnType<typeof harness>) {
  const task = h.tasks.dispatch(h.briefFile);
  const worker = await h.tasks.retry(task.id);
  const worktree = h.store.task(task.id).worktree;
  await Promise.all([
    waitForFile(join(worktree, '.worker-started')),
    waitForFile(join(worktree, '.worker-descendant-pid')),
  ]);
  const identity = (name: string): ProcessIdentity => {
    const pid = Number(readFileSync(join(worktree, name), 'utf8'));
    const found = processIdentity(pid);
    if (!found) throw new Error(`fixture process did not have a live identity: ${pid}`);
    return found;
  };
  return {
    worker,
    task,
    wrapper: worker.attempt.process!,
    fakeWorker: identity('.worker-pid'),
    descendant: identity('.worker-descendant-pid'),
  };
}

function expectGoneBeforeRootRemoval(h: ReturnType<typeof harness>, identities: ProcessIdentity[]): () => void {
  return () => {
    expect(existsSync(h.root)).toBe(true);
    for (const identity of identities) expect(sameProcess(identity)).toBe(false);
  };
}

test('Disposable control-plane fake workers are reaped on normal and failed test teardown before their fixture directories disappear while unrelated processes survive', async () => {
  const h = harness(workerScript);
  let disposalStarted = false;
  try {
    const fixture = await startFixtureWorker(h);
    const recorded = fixtureOwnedProcesses(h.settings.stateDirectory, h.ownerToken);
    expect(recorded.some((item) => item.role === 'worker' && item.identity.pid === fixture.wrapper.pid)).toBe(true);
    h.store.updateAttempt(fixture.worker.attempt, (attempt) => {
      attempt.process = null;
      attempt.state = 'exited';
    });
    h.store.updateTask(fixture.worker.attempt, (task) => {
      task.state = 'stopped';
    });
    expect(sameProcess(fixture.wrapper)).toBe(true);
    disposalStarted = true;
    await h.disposeAsync({
      beforeRemove: expectGoneBeforeRootRemoval(h, [fixture.wrapper, fixture.fakeWorker, fixture.descendant]),
    });
    expect(existsSync(h.root)).toBe(false);
  } finally {
    if (!disposalStarted) await h.disposeAsync();
  }
});

test('an injected early failure still awaits fixture process cleanup before root removal', async () => {
  const h = harness(workerScript);
  let disposalStarted = false;
  let identities: ProcessIdentity[] = [];
  let failure: unknown;
  try {
    try {
      const fixture = await startFixtureWorker(h);
      identities = [fixture.wrapper, fixture.fakeWorker, fixture.descendant];
      throw new Error('injected assertion before worker release');
    } finally {
      disposalStarted = true;
      await h.disposeAsync({ beforeRemove: expectGoneBeforeRootRemoval(h, identities) });
    }
  } catch (error) {
    failure = error;
  }
  expect(disposalStarted).toBe(true);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('injected assertion before worker release');
  expect(existsSync(h.root)).toBe(false);
});

test('released fake worker exits with its actual status before normal fixture teardown', async () => {
  const h = harness(workerScript);
  let disposalStarted = false;
  try {
    const fixture = await startFixtureWorker(h);
    writeFileSync(join(fixture.task.worktree, '.worker-release'), 'release');
    expect(await fixture.worker.exited).toEqual({ code: 0, signal: null });
    disposalStarted = true;
    await h.disposeAsync({
      beforeRemove: expectGoneBeforeRootRemoval(h, [fixture.wrapper, fixture.fakeWorker, fixture.descendant]),
    });
    expect(existsSync(h.root)).toBe(false);
  } finally {
    if (!disposalStarted) await h.disposeAsync();
  }
});

test('fixture teardown preserves an unrelated live detached sentinel', async () => {
  const h = harness(workerScript);
  const sentinel = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"], {
    cwd: h.root,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let sentinelIdentity: ProcessIdentity | undefined;
  let disposalStarted = false;
  try {
    await new Promise<void>((resolve, reject) => {
      sentinel.once('error', reject);
      sentinel.stdout!.once('data', () => resolve());
    });
    const identifiedSentinel = processIdentity(sentinel.pid!);
    if (!identifiedSentinel) throw new Error('could not identify unrelated sentinel');
    sentinelIdentity = identifiedSentinel;
    const fixture = await startFixtureWorker(h);
    disposalStarted = true;
    await h.disposeAsync({
      beforeRemove: expectGoneBeforeRootRemoval(h, [fixture.wrapper, fixture.fakeWorker, fixture.descendant]),
    });
    expect(sameProcess(identifiedSentinel)).toBe(true);
    expect(existsSync(h.root)).toBe(false);
  } finally {
    if (!disposalStarted) await h.disposeAsync();
    if (sentinelIdentity) await terminateProcessGroup(sentinelIdentity, 100);
  }
});

import { spyOn } from 'bun:test';
import { WorkerJob } from './job.ts';

test('cancellation reaps original descendants before publishing its terminal record', async () => {
  const h = harness(workerScript);
  try {
    const fixture = await startFixtureWorker(h);
    await h.tasks.cancel(fixture.task.id);
    expect(h.store.task(fixture.task.id).state).toBe('cancelled');
    expect(h.store.attempt(fixture.worker.attempt).state).toBe('cancelled');
    for (const identity of [fixture.wrapper, fixture.fakeWorker, fixture.descendant])
      expect(sameProcess(identity)).toBe(false);
  } finally {
    await h.disposeAsync();
  }
});

async function unrelatedLeader() {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', () => done());
  });
  const identity = processIdentity(child.pid!)!;
  return { child, identity, stale: { ...identity, start: '0', group: identity.pid } };
}

test('orphan recovery settles a reused leader with an absent original group and releases its worker slot', async () => {
  const h = harness();
  const unrelated = await unrelatedLeader();
  const queued: unknown[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.store.updateAttempt(worker.attempt, (attempt) => {
      attempt.process = unrelated.stale;
      attempt.driver = null;
    });
    const job = new WorkerJob(
      h.tasks,
      {
        enqueue: (request) => {
          queued.push(request);
        },
      },
      { deliver() {} },
    );
    await job.recoverOrphans();
    await job.drain();
    expect(h.store.attempt(worker.attempt).state).toBe('exited');
    expect(h.store.runningAttemptsCount()).toBe(0);
    expect(queued).toHaveLength(1);
    expect(sameProcess(unrelated.identity)).toBe(true);
  } finally {
    unrelated.child.kill('SIGKILL');
    await new Promise<void>((done) => {
      if (unrelated.child.exitCode !== null || unrelated.child.signalCode !== null) done();
      else unrelated.child.once('exit', () => done());
    });
    await h.disposeAsync();
  }
});

test('unknown original group visibility refuses cancellation and orphan terminal settlement', async () => {
  const h = harness();
  const unrelated = await unrelatedLeader();
  let restore: (() => void) | undefined;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.store.updateAttempt(worker.attempt, (attempt) => {
      attempt.process = unrelated.stale;
      attempt.driver = null;
    });
    const kill = process.kill.bind(process);
    const inspection = spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -unrelated.stale.group && signal === 0)
        throw Object.assign(new Error('group inspection denied'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    restore = () => inspection.mockRestore();
    await expect(h.tasks.cancel(task.id)).rejects.toThrow('visibility unknown');
    expect(h.store.task(task.id).state).toBe('running');
    const notices: unknown[] = [];
    const job = new WorkerJob(
      h.tasks,
      {
        enqueue() {
          throw new Error('unknown custody cannot land');
        },
      },
      {
        deliver: (event) => {
          notices.push(event);
        },
      },
    );
    await job.recoverOrphans();
    await job.drain();
    expect(h.store.attempt(worker.attempt).state).toBe('running');
    expect(h.store.task(task.id).state).toBe('running');
    expect(h.store.runningAttemptsCount()).toBe(1);
    expect(h.store.events(task.id).some((event) => event.kind === 'process-cleanup-unconfirmed')).toBe(true);
    expect(notices).toHaveLength(1);
    expect(sameProcess(unrelated.identity)).toBe(true);
    restore();
    restore = undefined;
    await job.recoverOrphans();
    await job.drain();
    expect(h.store.runningAttemptsCount()).toBe(0);
  } finally {
    restore?.();
    unrelated.child.kill('SIGKILL');
    await new Promise<void>((done) => {
      if (unrelated.child.exitCode !== null || unrelated.child.signalCode !== null) done();
      else unrelated.child.once('exit', () => done());
    });
    await h.disposeAsync();
  }
});

test('cancellation excludes a concurrent normal settler until original groups are gone', async () => {
  const h = harness(workerScript);
  let following: Promise<void> | undefined;
  const queued: unknown[] = [];
  try {
    const fixture = await startFixtureWorker(h);
    const job = new WorkerJob(
      h.tasks,
      {
        enqueue: (request) => {
          queued.push(request);
        },
      },
      { deliver() {} },
    );
    following = job.follow(fixture.worker);
    await h.tasks.cancel(fixture.task.id);
    await following;
    expect(queued).toHaveLength(0);
    expect(h.store.task(fixture.task.id).state).toBe('cancelled');
    expect(sameProcess(fixture.descendant)).toBe(false);
  } finally {
    await h.disposeAsync({
      beforeRemove: async () => {
        await following;
      },
    });
  }
});

test('concurrent fixture disposal shares cleanup and retains state until its final continuation finishes', async () => {
  const h = harness();
  let release!: () => void;
  let entered!: () => void;
  const hookStarted = new Promise<void>((done) => {
    entered = done;
  });
  const hookRelease = new Promise<void>((done) => {
    release = done;
  });
  const first = h.disposeAsync({
    beforeRemove: async () => {
      entered();
      await hookRelease;
    },
  });
  const second = h.disposeAsync();
  try {
    expect(second).toBe(first);
    await hookStarted;
    expect(existsSync(h.root)).toBe(true);
    expect(() => h.dispose()).toThrow('disposal is in progress');
  } finally {
    release();
    await Promise.all([first, second]);
  }
  expect(existsSync(h.root)).toBe(false);
});

import { trackFixtureWait } from './fixture-process-ownership.ts';

test('a continuation registered at the removal boundary preserves fixture state for awaited cleanup', async () => {
  const h = harness();
  let release!: () => void;
  const late = new Promise<void>((done) => {
    release = done;
  });
  try {
    await expect(
      h.disposeAsync({
        beforeRemove: () => {
          trackFixtureWait(join(h.settings.stateDirectory, 'runs', 'fixture', '1.jsonl'), late);
        },
      }),
    ).rejects.toThrow('continuation appeared');
    expect(existsSync(h.root)).toBe(true);
    expect(h.store.runningAttemptsCount()).toBe(0);
  } finally {
    release();
    await h.disposeAsync();
  }
  expect(existsSync(h.root)).toBe(false);
});
