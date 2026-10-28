import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { capacityAvailable } from './launch.ts';
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
