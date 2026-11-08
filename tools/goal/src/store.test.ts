import { expect, test } from 'bun:test';
import { openDb, migrate } from './db.ts';
import {
  MAINTENANCE_BOOTSTRAP_PAGE_SIZE,
  WorkerStore,
  workerMigrations,
} from './store.ts';
import { temporaryDirectory } from './test-support.ts';

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
    expect(first.items.map(({ taskId, attempt }) => ({ taskId, attempt }))).toEqual([{ taskId: 'picked', attempt: 1 }]);
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

test('maintenance backfill resumes after restart and concurrent task writes keep their ticket', () => {
  const directory = temporaryDirectory();
  const path = `${directory.path}/goal.sqlite`;
  let db = openDb(path);
  let store: WorkerStore;
  const count = MAINTENANCE_BOOTSTRAP_PAGE_SIZE * 2 + 5;
  try {
    migrate(db, workerMigrations.filter((migration) => !(migration.module === 'worker' && migration.version === 14)));
    let insertTask = db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, 1, ?)');
    let insertAttempt = db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, 1, ?)');
    for (let sequence = 1; sequence <= count; sequence++) {
      const id = `old-${String(sequence).padStart(3, '0')}`;
      insertTask.run(
        id,
        sequence,
        JSON.stringify({ id, state: 'integrated', worktree: `/missing/${id}`, currentAttempt: 1, brief: { after: [] } }),
      );
      insertAttempt.run(
        id,
        JSON.stringify({
          taskId: id,
          attempt: 1,
          state: 'superseded',
          process: sequence <= 10 ? { pid: sequence + 1000, start: `${sequence}`, boot: 'old', group: sequence + 1000 } : null,
        }),
      );
    }

    store = new WorkerStore(db);
    insertTask = db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, 1, ?)');
    insertAttempt = db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, 1, ?)');
    expect(store.bootstrapMaintenanceTasks(16)).toEqual({ examined: 16, complete: false });
    expect(store.bootstrapMaintenanceProcesses(8)).toEqual({ examined: 8, complete: false });

    // Task and process changes after migration are queued atomically by SQLite triggers.
    insertTask.run(
      'late',
      count + 1,
      JSON.stringify({ id: 'late', state: 'running', worktree: '/missing/late', currentAttempt: 1, brief: { after: [] } }),
    );
    insertAttempt.run(
      'late',
      JSON.stringify({ taskId: 'late', attempt: 1, state: 'running', process: null }),
    );
    db.query('UPDATE worker_attempts SET body=? WHERE task_id=? AND attempt=1').run(
      JSON.stringify({
        taskId: 'late',
        attempt: 1,
        state: 'exited',
        process: { pid: 4321, start: 'late-start', boot: 'late-boot', group: 4321 },
      }),
      'late',
    );

    const first = store.worktreeMaintenanceCandidates(1)[0]!;
    db.query("UPDATE worker_tasks SET body=json_set(body, '$.state', 'running') WHERE id=?").run(first.taskId);
    store.completeMaintenanceCandidates([first]);
    db.close();

    db = openDb(path);
    store = new WorkerStore(db);
    expect(store.bootstrapMaintenanceTasks(16)).toEqual({ examined: 16, complete: false });
    let processPage = store.bootstrapMaintenanceProcesses(8);
    expect(processPage).toEqual({ examined: 8, complete: false });
    while (!processPage.complete) processPage = store.bootstrapMaintenanceProcesses(8);
    expect(processPage).toEqual({ examined: 5, complete: true });
    const refreshed = store.worktreeMaintenanceCandidates(count + 1).find((candidate) => candidate.taskId === first.taskId);
    expect(refreshed?.task.state).toBe('running');
    expect(refreshed?.ticket).toBeGreaterThan(first.ticket);

    const lateProcess = store.reapMaintenanceCandidates(count + 1).find((candidate) => candidate.taskId === 'late');
    expect(lateProcess?.process).toEqual({ pid: 4321, start: 'late-start', boot: 'late-boot', group: 4321 });
    db.query('UPDATE worker_attempts SET body=? WHERE task_id=? AND attempt=1').run(
      JSON.stringify({ taskId: 'late', attempt: 1, state: 'exited', process: null }),
      'late',
    );
    expect(store.reapMaintenanceCandidates(count + 1).some((candidate) => candidate.taskId === 'late')).toBe(false);
  } finally {
    db.close();
    directory.close();
  }
});
