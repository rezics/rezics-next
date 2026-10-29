import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitHostCapacity, capacityAvailable } from './launch.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';

test('admitted starts retain capacity while preparation runs, then running attempts take over the count', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-reservation-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 2, minAvailableMiB: 0 }));
    await Promise.all([
      awaitHostCapacity(store, directory, false, 'one'),
      awaitHostCapacity(store, directory, false, 'two'),
    ]);
    expect(readdirSync(join(directory, 'capacity-queue')).filter((name) => name.endsWith('.admitted'))).toHaveLength(2);
    expect(capacityAvailable(store, directory)).toBe(false);
    const waiting = await Promise.race([
      awaitHostCapacity(store, directory, false, 'three').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(waiting).toBe(false);
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
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run('wake', 1, 1, '{}');
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'wake', 1, JSON.stringify({ state: 'waiting' }),
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
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run('failed', 1, 1, '{}');
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'failed', 1, JSON.stringify({ state: 'pending' }),
    );
    await awaitHostCapacity(store, directory, false, 'failed');
    expect(capacityAvailable(store, directory)).toBe(false);

    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'exited' }), 'failed', 1,
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
