import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from './config.ts';
import type { AttemptFence, GateOutcome } from './contracts.ts';
import { StaleAttemptError } from './contracts.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { acquireDirectoryLease } from './lease.ts';
import { harness, repository } from './test-support.ts';
import { openDb } from './db.ts';

function setup() {
  const repo = repository();
  const db = openDb(join(repo.path, 'state.sqlite'));
  let current = 1;
  const fence: AttemptFence = {
    assertCurrent(ref) {
      if (current !== ref.attempt) throw new StaleAttemptError(ref, current);
    },
    commitMerge(ref, merge) {
      return db
        .transaction(() => {
          fence.assertCurrent(ref);
          return merge();
        })
        .immediate();
    },
  };
  const queue = new SqliteLandingQueue(db, fence);
  const outcomes: GateOutcome[] = [];
  return {
    ...repo,
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

test('a pump that finds the train held returns at once without an error', async () => {
  const h = harness();
  const runtime = createRuntime({ tasks: h.tasks });
  const lease = acquireDirectoryLease(join(h.settings.stateDirectory, 'train.lease'));
  const originalNow = Date.now;
  let clockReads = 0;
  try {
    Date.now = () => (++clockReads === 1 ? 0 : 30_001);
    await expect(runtime.pump()).resolves.toBeUndefined();
    expect(clockReads).toBe(0);
  } finally {
    Date.now = originalNow;
    lease.release();
    h.dispose();
  }
});

test('a request queued while the holder drains is landed by the holder after it releases', async () => {
  const s = setup();
  try {
    const first = s.branch('first', 'first-result');
    const second = s.branch('second', 'second-result');
    s.queue.enqueue(first);

    const leasePath = join(s.options.stateDirectory, 'train.lease');
    const nextBatch = s.queue.nextBatch.bind(s.queue);
    let observeRelease = true;
    let holderCheckedAfterRelease = false;
    s.queue.nextBatch = (...args) => {
      if (observeRelease && !existsSync(leasePath)) holderCheckedAfterRelease = true;
      return nextBatch(...args);
    };

    let queuedDuringRelease = false;
    await new MergeTrain({
      ...s.options,
      runGate: async () => ({ passed: true, output: '', timedOut: false }),
      async beforeRelease() {
        if (queuedDuringRelease) return;
        queuedDuringRelease = true;
        s.queue.enqueue(second);
      },
    }).run();

    observeRelease = false;
    expect(holderCheckedAfterRelease).toBe(true);
    expect(s.queue.next()).toBeUndefined();
    expect(s.outcomes.map((outcome) => [outcome.taskId, outcome.passed])).toEqual([
      ['first', true],
      ['second', true],
    ]);
    expect(existsSync(join(s.main, 'first-result'))).toBe(true);
    expect(existsSync(join(s.main, 'second-result'))).toBe(true);
  } finally {
    s.close();
  }
});
