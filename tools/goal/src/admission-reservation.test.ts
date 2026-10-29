import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitHostCapacity, capacityAvailable } from './launch.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';

test('admitted starts retain capacity throughout delayed preparation until running attempts take over', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-reservation-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 2, minAvailableMiB: 0 }));
    const ids = ['one', 'two', 'three', 'four'];
    for (const [sequence, id] of ids.entries()) {
      db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
        id,
        sequence + 1,
        1,
        '{}',
      );
      db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
        id,
        1,
        JSON.stringify({ state: 'pending' }),
      );
    }
    const preparing: string[] = [];
    const starts = ids.map(async (id) => {
      await awaitHostCapacity(store, directory, false, id);
      preparing.push(id);
      // Model the time spent rebasing and installing before launch records the attempt as running.
      await new Promise((resolve) => setTimeout(resolve, 400));
      db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
        JSON.stringify({ state: 'running' }),
        id,
        1,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const queue = join(directory, 'capacity-queue');
    const reservations = () => readdirSync(queue).filter((name) => name.endsWith('.admitted')).length;
    expect(preparing).toHaveLength(2);
    expect(store.runningAttemptsCount() + reservations()).toBe(2);
    expect(capacityAvailable(store, directory)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.runningAttemptsCount()).toBe(2);
    expect(reservations()).toBe(0);
    expect(store.runningAttemptsCount() + reservations()).toBe(2);
    expect(capacityAvailable(store, directory)).toBe(false);
    // The remaining starts stay queued; their unresolved waits are cleared by dropping opt-in capacity.
    writeFileSync(join(directory, 'capacity.json'), '{}');
    await Promise.all(starts.slice(0, 2));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check-wake attempts do not count as running or admitted starts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-check-wake-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
      'wake',
      1,
      1,
      '{}',
    );
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'wake',
      1,
      JSON.stringify({ state: 'waiting' }),
    );
    expect(capacityAvailable(store, directory)).toBe(true);
    await awaitHostCapacity(store, directory, false, 'next');
    expect(capacityAvailable(store, directory)).toBe(false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an admitted ticket owned by a dead process does not hold capacity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-dead-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    const queue = join(directory, 'capacity-queue');
    Bun.spawnSync(['mkdir', '-p', queue]);
    writeFileSync(join(queue, `000000000000000-99999999-dead.admitted`), '');
    expect(capacityAvailable(store, directory)).toBe(true);
    expect(readdirSync(queue)).toHaveLength(0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed launch releases its admitted place for a later waiter', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-launch-failed-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
      'failed',
      1,
      1,
      '{}',
    );
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'failed',
      1,
      JSON.stringify({ state: 'pending' }),
    );
    await awaitHostCapacity(store, directory, false, 'failed');
    expect(capacityAvailable(store, directory)).toBe(false);

    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'exited' }),
      'failed',
      1,
    );
    const released = await Promise.race([
      (async () => {
        while (!capacityAvailable(store, directory)) await new Promise((resolve) => setTimeout(resolve, 25));
        return true;
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    expect(released).toBe(true);
    await awaitHostCapacity(store, directory, false, 'later');
    expect(capacityAvailable(store, directory)).toBe(false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
