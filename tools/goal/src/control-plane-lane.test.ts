import { expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptFence, GateOutcome } from './contracts.ts';
import { openDb } from './db.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { repository } from './test-support.ts';

function setup() {
  const repo = repository();
  git(repo.main, 'branch', 'dev');
  const stateDirectory = join(repo.path, 'state');
  mkdirSync(stateDirectory, { recursive: true });
  const db = openDb(join(stateDirectory, 'goal.sqlite'));
  db.run('CREATE TABLE worker_tasks (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, current_attempt INTEGER NOT NULL, body TEXT NOT NULL)');
  let current = 1;
  const fence: AttemptFence = {
    assertCurrent(ref) { if (current !== ref.attempt) throw new Error(`stale attempt ${ref.taskId}`); },
    commitMerge(ref, merge) { fence.assertCurrent(ref); return merge(); },
  };
  const queue = new SqliteLandingQueue(db, fence);
  const outcomes: GateOutcome[] = [];
  const options = {
    mainCheckout: repo.main,
    stateDirectory,
    worktreeRoot: join(repo.path, 'trees'),
    integrationBranch: 'dev',
    queue,
    fence,
    sink: { onGateOutcome(outcome: GateOutcome) { outcomes.push(outcome); } },
  };
  function enqueue(name: string, file: string, goal: string, target?: string) {
    const request = repo.branch(name, file);
    const { n } = db.query('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM worker_tasks').get() as { n: number };
    db.run('INSERT INTO worker_tasks VALUES (?, ?, 1, ?)', [name, n, JSON.stringify({ brief: { goal, ...(target ? { target } : {}) } })]);
    queue.enqueue(request);
  }
  return { ...repo, db, queue, outcomes, options, enqueue, close() { db.close(); repo.close(); } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a control-plane landing for main runs under its own lease while a queued dev landing completes', async () => {
  const s = setup();
  const mainEntered = deferred();
  const releaseMain = deferred();
  const devLanded = deferred();
  let running: Promise<void> | undefined;
  try {
    s.enqueue('main-control', 'main-result', 'control-plane', 'main');
    s.enqueue('dev-work', 'dev-result', 'web');
    expect(s.queue.nextBatch(10, [], 'main').map(({ request }) => request.taskId)).toEqual(['main-control']);
    expect(s.queue.nextBatch(10, [], 'dev').map(({ request }) => request.taskId)).toEqual(['dev-work']);
    running = new MergeTrain({
      ...s.options,
      formatCommand: ['true'],
      sink: { onGateOutcome(outcome) { s.outcomes.push(outcome); if (outcome.taskId === 'dev-work') devLanded.resolve(); } },
      runGate: async (_command, cwd) => {
        if (existsSync(join(cwd, 'main-result'))) {
          mainEntered.resolve();
          await releaseMain.promise;
        }
        return { passed: true, output: '', timedOut: false };
      },
    }).run();

    await Promise.race([
      mainEntered.promise,
      running.then(() => { throw new Error('train completed before the main landing entered its gate'); }),
    ]);
    await Promise.race([
      devLanded.promise,
      running.then(() => { throw new Error('train completed before the dev landing entered its gate'); }),
      Bun.sleep(30000).then(() => { throw new Error('dev landing waited for the main control-plane lease'); }),
    ]);
    expect(git(s.main, 'rev-parse', 'refs/heads/dev')).not.toBe(git(s.main, 'rev-parse', 'main'));
    releaseMain.resolve();
    await running;
    expect(s.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([
      ['dev-work', true],
      ['main-control', true],
    ]);
  } finally {
    releaseMain.resolve();
    await running?.catch(() => {});
    s.close();
  }
}, 60000);

test('two control-plane landings targeting main are serialized within the main lane', async () => {
  const s = setup();
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  try {
    s.enqueue('main-one', 'main-one-result', 'control-plane', 'main');
    s.enqueue('main-two', 'main-two-result', 'control-plane', 'main');
    await new MergeTrain({
      ...s.options,
      runGate: async (_command, cwd) => {
        active++;
        peak = Math.max(peak, active);
        order.push(existsSync(join(cwd, 'main-two-result')) ? 'main-two' : 'main-one');
        await Bun.sleep(20);
        active--;
        return { passed: true, output: '', timedOut: false };
      },
    }).run();
    expect(peak).toBe(1);
    expect(order).toEqual(['main-one', 'main-two']);
    expect(s.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([
      ['main-one', true],
      ['main-two', true],
    ]);
  } finally {
    s.close();
  }
}, 60000);
