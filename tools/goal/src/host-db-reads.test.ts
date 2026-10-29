import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerStore } from './store.ts';

const root = join(process.cwd(), '.temp', `host-db-reads-${crypto.randomUUID()}`);
mkdirSync(root, { recursive: true });
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});

function fixture(): { db: Database; store: WorkerStore; path: string } {
  mkdirSync(root, { recursive: true });
  const path = join(root, 'goal.sqlite');
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
  for (let i = 0; i < 3_000; i++) {
    const id = `settled-${i}`;
    insertTask.run(id, i, 2, task(id, i, 'integrated', 2));
    for (let attempt = 1; attempt <= 1; attempt++)
      insertAttempt.run(
        id,
        attempt,
        JSON.stringify({ taskId: id, attempt, state: 'superseded', payload: attemptPadding }),
      );
  }
  for (let i = 0; i < 5; i++) {
    const id = `active-${i}`;
    const state = ['held', 'ready', 'running', 'landing', 'stopped'][i]!;
    insertTask.run(id, 3_000 + i, 1, task(id, 3_000 + i, state, 1));
    insertAttempt.run(id, 1, JSON.stringify({ taskId: id, attempt: 1, state: 'running', payload: attemptPadding }));
  }
  for (let i = 0; i < 2_000; i++) {
    const id = `settled-${i}`;
    const attempt = i + 3;
    insertAttempt.run(
      id,
      attempt,
      JSON.stringify({ taskId: id, attempt, state: 'cancelled', payload: attemptPadding }),
    );
  }
  return { db, store, path };
}

test('host sweep decodes only active tasks and attempts from a large settled history', () => {
  const { store } = fixture();
  store.resetDecodedRows();
  expect(store.activeTasks()).toHaveLength(5);
  expect(store.activeAttempts()).toHaveLength(5);
  expect(store.decodedRows()).toEqual({ tasks: 5, attempts: 5 });
  expect(store.decodedBytes().tasks).toBeLessThan(50_000);
  expect(store.decodedBytes().attempts).toBeLessThan(50_000);
}, 30_000);

test('repeated store reads reuse the decoded snapshot and external writes invalidate it', () => {
  const { store, path } = fixture();
  store.resetDecodedRows();
  const first = store.activeTasks();
  const firstAttempt = store.attempt({ taskId: 'active-2', attempt: 1 });
  expect(store.activeTasks()).toHaveLength(first.length);
  expect(store.attempt({ taskId: 'active-2', attempt: 1 })).toEqual(firstAttempt);
  expect(store.decodedRows()).toEqual({ tasks: 5, attempts: 1 });

  const external = new Database(path);
  external.query("UPDATE worker_tasks SET body=json_set(body, '$.state', 'integrated') WHERE id='active-0'").run();
  external.close();
  store.resetDecodedRows();
  expect(store.activeTasks()).toHaveLength(4);
  expect(store.decodedRows().tasks).toBe(4);
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
