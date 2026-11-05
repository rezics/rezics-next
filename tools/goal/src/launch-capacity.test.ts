import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import {
  awaitHostCapacity,
  capacityAvailable,
  capacityWaiters,
  hasCapacity,
  startsFirst,
  waitersAhead,
} from './launch.ts';
import * as launchCapacity from './launch-capacity.ts';
import { defaultPolicy } from './policy.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory } from './test-support.ts';

test('launch.ts re-exports the host-capacity implementation', () => {
  expect(awaitHostCapacity).toBe(launchCapacity.awaitHostCapacity);
  expect(capacityAvailable).toBe(launchCapacity.capacityAvailable);
  expect(capacityWaiters).toBe(launchCapacity.capacityWaiters);
  expect(hasCapacity).toBe(launchCapacity.hasCapacity);
  expect(startsFirst).toBe(launchCapacity.startsFirst);
  expect(waitersAhead).toBe(launchCapacity.waitersAhead);
});

test('concurrent starts respect the cap and a queued start proceeds after release', async () => {
  const directory = temporaryDirectory();
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  const releases: Array<() => void> = [];
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    const policy = { ...defaultPolicy.capacity, maxWorkers: 1, minAvailableMiB: 0, pollIntervalMs: 5 };
    releases.push(await awaitHostCapacity(store, directory.path, false, 'first', 1, { policy, pollIntervalMs: 5 }));
    expect(capacityAvailable(store, directory.path)).toBe(false);
    let secondStarted = false;
    const second = awaitHostCapacity(store, directory.path, false, 'second', 1, { policy, pollIntervalMs: 5 }).then(
      (release) => {
        secondStarted = true;
        return release;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondStarted).toBe(false);
    expect(capacityWaiters(directory.path).has('second')).toBe(true);
    releases[0]!();
    releases.push(await second);
    expect(secondStarted).toBe(true);
    expect(capacityAvailable(store, directory.path)).toBe(false);
  } finally {
    releases.forEach((release) => release());
    db.close();
    directory.close();
  }
});

test('an admitted ticket holds the slot until the attempt leaves pending, without a worker PID', async () => {
  const directory = temporaryDirectory();
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  let release: (() => void) | undefined;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
      'held',
      1,
      1,
      '{}',
    );
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'held',
      1,
      JSON.stringify({ state: 'pending' }),
    );
    const policy = { ...defaultPolicy.capacity, maxWorkers: 1, minAvailableMiB: 0, reservationPollMs: 5 };
    release = await awaitHostCapacity(store, directory.path, false, 'held', 1, { policy, pollIntervalMs: 5 });
    expect(capacityAvailable(store, directory.path)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(capacityAvailable(store, directory.path)).toBe(false);
    store.updateAttempt({ taskId: 'held', attempt: 1 }, (attempt) => {
      attempt.state = 'running';
    });
    for (let step = 0; step < 40 && !capacityAvailable(store, directory.path); step += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(capacityAvailable(store, directory.path)).toBe(true);
  } finally {
    release?.();
    db.close();
    directory.close();
  }
});

test('a cancelled wait and an opt-out leave no owned tickets', async () => {
  const directory = temporaryDirectory();
  const queue = join(directory.path, 'capacity-queue');
  const tickets = () => (existsSync(queue) ? readdirSync(queue) : []);
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    const failing = {
      capacityAttemptsCount() {
        throw new Error('capacity counter failed');
      },
      attempts() {
        return [];
      },
    };
    await expect(awaitHostCapacity(failing, directory.path, false, 'cancel')).rejects.toThrow('capacity counter failed');
    expect(tickets()).toEqual([]);

    mkdirSync(queue, { recursive: true });
    const db = openDb(':memory:');
    const store = new WorkerStore(db);
    try {
      writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 0, minAvailableMiB: 0 }));
      const waiting = awaitHostCapacity(store, directory.path, false, 'queued', 1, { pollIntervalMs: 5 });
      for (let step = 0; step < 40 && tickets().length === 0; step += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(tickets().some((name) => name.includes('-queued'))).toBe(true);
      rmSync(join(directory.path, 'capacity.json'));
      (await waiting)();
      expect(tickets()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    directory.close();
  }
});
