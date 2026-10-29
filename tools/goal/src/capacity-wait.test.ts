import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { awaitHostCapacity, capacityAvailable, waitersAhead } from './launch.ts';
import { WorkerStore } from './store.ts';

test('a start waiting for host capacity counts running attempts with one indexed query, without reading every attempt body', () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-capacity-count-'));
  const db = openDb(':memory:');
  try {
    const store = new WorkerStore(db);
    const plan = db
      .query("EXPLAIN QUERY PLAN SELECT count(*) FROM worker_attempts WHERE json_extract(body, '$.state') = 'running'")
      .all() as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join(' ')).toContain('worker_attempts_state');

    const insertTask = db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
    const insertAttempt = db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)');
    let runningCount = 0;
    for (const size of [10, 100, 1_000]) {
      db.exec('DELETE FROM worker_attempts; DELETE FROM worker_tasks');
      runningCount = 0;
      for (let index = 0; index < size; index += 1) {
        const id = `task-${index}`;
        const state = index % 10 === 0 ? 'running' : 'finished';
        if (state === 'running') runningCount += 1;
        insertTask.run(id, index + 1, 1, '{}');
        insertAttempt.run(id, 1, JSON.stringify({ state, payload: 'x'.repeat(1_024) }));
      }
      expect(store.runningAttemptsCount()).toBe(runningCount);
    }

    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: runningCount, minAvailableMiB: 0 }));
    expect(capacityAvailable(store, directory)).toBe(false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a critical-path start waits at the cap like any other and only goes half an hour ahead in the queue', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-capacity-critical-'));
  const db = openDb(':memory:');
  try {
    const store = new WorkerStore(db);
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
      'busy',
      1,
      1,
      '{}',
    );
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'busy',
      1,
      JSON.stringify({ state: 'running' }),
    );
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    // At the cap a critical-path start does not return; it used to start regardless and starve ordinary waiters.
    const started = await Promise.race([
      awaitHostCapacity(store, directory, true, 'critical').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(started).toBe(false);
    const queue = join(directory, 'capacity-queue');
    const [critical] = readdirSync(queue);
    const now = Date.now();
    const older = `${String(now - 60 * 60_000).padStart(15, '0')}-${process.pid}-older`;
    const newer = `${String(now - 60_000).padStart(15, '0')}-${process.pid}-newer`;
    writeFileSync(join(queue, older), '');
    writeFileSync(join(queue, newer), '');
    expect(waitersAhead(queue, critical!)).toBe(1);
    expect(waitersAhead(queue, newer)).toBe(2);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
