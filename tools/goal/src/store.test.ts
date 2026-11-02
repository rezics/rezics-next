import { expect, test } from 'bun:test';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';

test('task history pages decode only selected rows and return a stable continuation', () => {
  const db = openDb(':memory:');
  try {
    const store = new WorkerStore(db);
    const insertTask = db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
    insertTask.run('picked', 1, 3, JSON.stringify({ id: 'picked', state: 'running' }));
    insertTask.run('other', 2, 1, JSON.stringify({ id: 'other', state: 'running' }));

    const insertAttempt = db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)');
    insertAttempt.run('picked', 1, JSON.stringify({ taskId: 'picked', attempt: 1, state: 'running' }));
    insertAttempt.run('picked', 3, JSON.stringify({ taskId: 'picked', attempt: 3, state: 'passed' }));
    insertAttempt.run('other', 1, JSON.stringify({ taskId: 'other', attempt: 1, state: 'running' }));
    store.resetDecodedRows();
    const first = store.attemptsPage('picked', { limit: 1 });
    expect(first.items.map(({ taskId, attempt }) => ({ taskId, attempt }))).toEqual([
      { taskId: 'picked', attempt: 1 },
    ]);
    expect(first.hasMore).toBe(true);
    expect(first.nextAfter).toBe(1);
    expect(store.decodedRows().attempts).toBe(1);
    const second = store.attemptsPage('picked', { afterAttempt: 1, limit: 1 });
    expect(second.items.map(({ taskId, attempt }) => ({ taskId, attempt }))).toEqual([
      { taskId: 'picked', attempt: 3 },
    ]);
    expect(second.hasMore).toBe(false);

    const insertRecord = db.query('INSERT INTO worker_records(task_id, attempt, body) VALUES (?, ?, ?)');
    insertRecord.run('picked', 1, JSON.stringify({ taskId: 'picked', attempt: 1, outcome: 'passed' }));
    insertRecord.run('picked', 3, JSON.stringify({ taskId: 'picked', attempt: 3, outcome: 'stopped' }));
    insertRecord.run('other', 1, 'not json');
    const records = store.recordsPage('picked', { limit: 1 });
    expect(records.items.map(({ taskId, attempt, outcome }) => ({ taskId, attempt, outcome }))).toEqual([
      { taskId: 'picked', attempt: 1, outcome: 'passed' },
    ]);
    expect(records.hasMore).toBe(true);
    expect(records.nextAfter).toBe(1);
    const last = store.recordsPage('picked', { afterAttempt: records.nextAfter!, limit: 1 });
    expect(last.items.map(({ attempt }) => attempt)).toEqual([3]);
    expect(last.hasMore).toBe(false);
    expect(last.nextAfter).toBeUndefined();
    expect(store.recordsPage('missing', { limit: 1 })).toEqual({ items: [], hasMore: false });
  } finally {
    db.close();
  }
});
