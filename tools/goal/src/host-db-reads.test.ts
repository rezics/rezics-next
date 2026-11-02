import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerStore } from './store.ts';
import { observeSqliteWork, type SqliteWork } from './sqlite-work.test-support.ts';

const root = join(process.cwd(), '.temp', `host-db-reads-${crypto.randomUUID()}`);
mkdirSync(root, { recursive: true });
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});

function fixture(
  taskCount = 3_000,
  attemptCount = 5_000,
  eventCount = 9_000,
  activeCount = 5,
): { db: Database; store: WorkerStore; path: string } {
  mkdirSync(root, { recursive: true });
  const path = join(root, `${crypto.randomUUID()}.sqlite`);
  const db = openDb(path);
  databases.push(db);
  const store = new WorkerStore(db);
  const insertTask = db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
  const insertAttempt = db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)');
  const taskPadding = 't'.repeat(7_500);
  const attemptPadding = 'a'.repeat(8_000);
  const task = (id: string, sequence: number, state: string, currentAttempt = 0) =>
    JSON.stringify({
      id,
      sequence,
      currentAttempt,
      state,
      brief: { goal: 'fixture', target: 'main', after: [], manager: 'manager' },
      payload: taskPadding,
    });
  db.transaction(() => {
    for (let i = 0; i < taskCount; i++) {
      const id = `settled-${i}`;
      insertTask.run(id, i, 2, task(id, i, 'integrated', 2));
      for (let attempt = 1; attempt <= 1; attempt++)
        insertAttempt.run(
          id,
          attempt,
          JSON.stringify({ taskId: id, attempt, state: 'superseded', payload: attemptPadding }),
        );
    }
    for (let i = 0; i < activeCount; i++) {
      const id = `active-${i}`;
      const state = ['held', 'ready', 'running', 'landing', 'stopped'][i]!;
      insertTask.run(id, taskCount + i, 1, task(id, taskCount + i, state, 1));
      insertAttempt.run(id, 1, JSON.stringify({ taskId: id, attempt: 1, state: 'running', payload: attemptPadding }));
    }
    for (let i = 0; i < attemptCount - taskCount; i++) {
      const id = `settled-${i % taskCount}`;
      const attempt = i + 3;
      insertAttempt.run(
        id,
        attempt,
        JSON.stringify({ taskId: id, attempt, state: 'cancelled', payload: attemptPadding }),
      );
    }
    const event = db.query(
      "INSERT INTO worker_events(task_id, attempt, kind, at, body) VALUES (?, ?, 'fixture', '2000-01-01', '{}')",
    );
    for (let i = 0; i < eventCount; i++) event.run(`settled-${i % taskCount}`, i + 1);
    if (activeCount) {
      event.run('active-2', 1);
      event.run('active-2', 1);
    }
  })();
  return { db, store, path };
}

const scales = [
  [100, 200, 300],
  [1_000, 2_000, 3_000],
  [3_000, 5_000, 9_000],
] as const;
function bounded(work: SqliteWork[]) {
  expect(work.length).toBeGreaterThan(0);
  for (const row of work) {
    expect(row.runs).toBe(1);
    expect(row.vmSteps).toBeGreaterThan(0);
    expect(row.vmSteps).toBeLessThanOrEqual(1_000);
    expect(row.fullscanSteps).toBe(0);
  }
}

test('host sweep decodes only active tasks and attempts from a large settled history', () => {
  const measurements: SqliteWork[][] = [];
  for (const [tasks, attempts, events] of scales) {
    const { db, store } = fixture(tasks, attempts, events);
    const native = observeSqliteWork(db, join(root, `native-${tasks}`));
    store.resetDecodedRows();
    expect(store.activeTasks()).toHaveLength(5);
    expect(store.activeAttempts()).toHaveLength(5);
    expect(store.decodedRows()).toEqual({ tasks: 5, attempts: 5 });
    expect(store.decodedBytes().tasks).toBeLessThan(50_000);
    expect(store.decodedBytes().attempts).toBeLessThan(50_000);
    expect(store.events('active-2', 1)).toHaveLength(2);
    // The exact latest-activity SQL used by backlog.ts, including full task/attempt anchoring.
    expect(
      db
        .query('SELECT at FROM worker_events WHERE task_id=? AND attempt=? ORDER BY sequence DESC LIMIT 1')
        .get('active-2', 1),
    ).toEqual({ at: '2000-01-01' });
    const work = native.drain(`host-active:${tasks}/${attempts}/${events}`);
    bounded(work);
    measurements.push(work);
    native.restore();
  }
  expect(measurements[1]).toEqual(measurements[0]);
  expect(measurements[2]).toEqual(measurements[0]);
}, 30_000);

test('repeated store reads reuse the decoded snapshot and external writes invalidate it', () => {
  for (const [tasks, attempts, events] of scales) {
    const { db, store, path } = fixture(tasks, attempts, events);
    const native = observeSqliteWork(db, join(root, `snapshot-${tasks}`));
    store.resetDecodedRows();
    const first = store.activeTasks();
    const firstAttempt = store.attempt({ taskId: 'active-2', attempt: 1 });
    expect(store.activeTasks()).toHaveLength(first.length);
    expect(store.attempt({ taskId: 'active-2', attempt: 1 })).toEqual(firstAttempt);
    expect(store.decodedRows()).toEqual({ tasks: 5, attempts: 1 });
    bounded(native.drain(`snapshot-reuse:${tasks}`));

    const external = new Database(path);
    try {
      external.query("UPDATE worker_tasks SET body=json_set(body, '$.state', 'integrated') WHERE id='active-0'").run();
      external
        .query("UPDATE worker_attempts SET body=json_set(body, '$.state', 'cancelled') WHERE task_id='active-2'")
        .run();
    } finally {
      external.close();
    }
    store.resetDecodedRows();
    expect(store.activeTasks()).toHaveLength(4);
    expect(store.attempt({ taskId: 'active-2', attempt: 1 }).state).toBe('cancelled');
    expect(store.decodedRows()).toEqual({ tasks: 4, attempts: 1 });
    bounded(native.drain(`snapshot-invalidation:${tasks}`));
    native.restore();
  }
}, 30_000);

test('empty active sets stay bounded across settled histories and repeated sweeps', () => {
  for (const [tasks, attempts, events] of scales) {
    const { db, store } = fixture(tasks, attempts, events, 0);
    const native = observeSqliteWork(db, join(root, `empty-${tasks}`));
    for (let sweep = 0; sweep < 2; sweep++) {
      expect(store.activeTasks()).toEqual([]);
      expect(store.activeAttempts()).toEqual([]);
      expect(store.events('missing', 1)).toEqual([]);
      expect(store.decodedRows()).toEqual({ tasks: 0, attempts: 0 });
      bounded(native.drain(`empty:${tasks}:${sweep}`));
    }
    native.restore();
  }
}, 30_000);

test('manager request reads and inbox sends avoid decoding settled task bodies', () => {
  const { db, store } = fixture();
  store.resetDecodedRows();
  expect(store.taskIds()).toHaveLength(3_005);
  expect(store.dependency('settled-0')?.state).toBe('integrated');
  const inbox = new SqliteManagerInbox(db, join(root, 'state'));
  inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'Please review the task.' });
  expect(store.decodedRows()).toEqual({ tasks: 0, attempts: 0 });
}, 30_000);
