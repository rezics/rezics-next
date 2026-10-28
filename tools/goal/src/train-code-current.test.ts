import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptFence, GateOutcome } from './contracts.ts';
import { codeVersion } from './runtime-version.ts';
import { openDb } from './db.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { acquireDirectoryLease } from './lease.ts';
import { git } from './merge.ts';
import { repository } from './test-support.ts';

function setup() {
  const repo = repository();
  const db = openDb(join(repo.path, 'state.sqlite'));
  const fence: AttemptFence = {
    assertCurrent() {},
    commitMerge(_ref, merge) {
      return db.transaction(() => merge()).immediate();
    },
  };
  const queue = new SqliteLandingQueue(db, fence);
  const outcomes: GateOutcome[] = [];
  return {
    repo,
    db,
    queue,
    outcomes,
    options: {
      mainCheckout: repo.main,
      stateDirectory: join(repo.path, 'state'),
      worktreeRoot: join(repo.path, 'trees'),
      queue,
      fence,
      sink: {
        onGateOutcome(outcome: GateOutcome) {
          outcomes.push(outcome);
        },
      },
    },
    close() {
      db.close();
      repo.close();
    },
  };
}

function addControlPlaneSource(main: string): void {
  const path = join(main, 'tools/goal/src/runtime.ts');
  mkdirSync(join(main, 'tools/goal/src'), { recursive: true });
  writeFileSync(path, 'export const revision = 1;\n');
  git(main, 'add', '--', 'tools/goal/src/runtime.ts');
  git(main, 'commit', '-m', 'Add control-plane fixture');
}

test('a train finishes its landing after its code changes and the next train takes the remaining request', async () => {
  const s = setup();
  try {
    addControlPlaneSource(s.repo.main);
    const first = s.repo.branch('first', 'tools/goal/src/runtime.ts', 'export const revision = 2;\n');
    const second = s.repo.branch('second', 'second-result');
    s.queue.enqueue(first);
    s.queue.enqueue(second);

    const originalVersion = codeVersion(s.repo.main, 'tools/goal');
    const gateVersions: string[] = [];
    let handoffs = 0;
    await new MergeTrain({
      ...s.options,
      codeIsCurrent: () => codeVersion(s.repo.main, 'tools/goal') === originalVersion,
      handOff() {
        handoffs++;
      },
      async runGate() {
        gateVersions.push(codeVersion(s.repo.main, 'tools/goal'));
        return { passed: true, output: '', timedOut: false };
      },
    }).runWaiting();

    const currentVersion = codeVersion(s.repo.main, 'tools/goal');
    expect(currentVersion).not.toBe(originalVersion);
    expect(gateVersions).toEqual([originalVersion]);
    expect(handoffs).toBe(1);
    expect(s.outcomes.map((outcome) => [outcome.taskId, outcome.passed])).toEqual([['first', true]]);
    expect(s.queue.next()?.request.taskId).toBe('second');

    await new MergeTrain({
      ...s.options,
      codeIsCurrent: () => codeVersion(s.repo.main, 'tools/goal') === currentVersion,
      handOff() {
        handoffs++;
      },
      async runGate() {
        gateVersions.push(codeVersion(s.repo.main, 'tools/goal'));
        return { passed: true, output: '', timedOut: false };
      },
    }).runWaiting();

    expect(gateVersions).toEqual([originalVersion, currentVersion]);
    expect(handoffs).toBe(1);
    expect(s.outcomes.map((outcome) => [outcome.taskId, outcome.passed])).toEqual([
      ['first', true],
      ['second', true],
    ]);
    expect(s.queue.next()).toBeUndefined();
  } finally {
    s.close();
  }
}, 15_000);

test('a train waiting for the lease exits when its code becomes stale', async () => {
  const s = setup();
  const request = s.repo.branch('waiting', 'waiting-result');
  s.queue.enqueue(request);
  const lease = acquireDirectoryLease(join(s.options.stateDirectory, 'train.lease'));
  let current = true;
  let checks = 0;
  let reachedWaitCheck!: () => void;
  const waitCheck = new Promise<void>((resolve) => {
    reachedWaitCheck = resolve;
  });
  let handoffs = 0;
  try {
    const running = new MergeTrain({
      ...s.options,
      codeIsCurrent() {
        checks++;
        if (checks === 2) reachedWaitCheck();
        return current;
      },
      handOff() {
        handoffs++;
      },
      async runGate() {
        throw new Error('A stale process must not take the lease or run a landing');
      },
    }).runWaiting();

    await waitCheck;
    current = false;
    await running;

    expect(handoffs).toBe(1);
    expect(s.outcomes).toEqual([]);
    expect(s.queue.next()?.request.taskId).toBe('waiting');
  } finally {
    lease.release();
    s.close();
  }
});

test('a current train continues landing requests while it holds the lease', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.repo.branch('first', 'first-result'));
    s.queue.enqueue(s.repo.branch('second', 'second-result'));
    let handoffs = 0;

    await new MergeTrain({
      ...s.options,
      codeIsCurrent: () => true,
      handOff() {
        handoffs++;
      },
      async runGate() {
        return { passed: true, output: '', timedOut: false };
      },
    }).runWaiting();

    expect(handoffs).toBe(0);
    expect(s.outcomes.map((outcome) => [outcome.taskId, outcome.passed])).toEqual([
      ['first', true],
      ['second', true],
    ]);
    expect(s.queue.next()).toBeUndefined();
  } finally {
    s.close();
  }
});
