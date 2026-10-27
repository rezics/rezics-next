import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AttemptFence, LandingRequest } from './contracts.ts';
import { openDb } from './db.ts';
import { SqliteLandingQueue } from './land.ts';
import { temporaryDirectory } from './test-support.ts';

test('the landing queue serves control-plane tasks first, then in arrival order', () => {
  const t = temporaryDirectory(); const db = openDb(join(t.path, 'state.sqlite'));
  try {
    db.run('CREATE TABLE worker_tasks (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, current_attempt INTEGER NOT NULL, body TEXT NOT NULL)');
    const tasks = [['web-1', 'web'], ['tools-1', 'control-plane'], ['web-2', 'web']] as const;
    tasks.forEach(([id, goal], index) => db.run('INSERT INTO worker_tasks VALUES (?, ?, 1, ?)', [id, index + 1, JSON.stringify({ brief: { goal } })]));
    const queue = new SqliteLandingQueue(db, { assertCurrent() {} } as unknown as AttemptFence);
    for (const [id] of tasks) queue.enqueue({ taskId: id, attempt: 1, branch: id, worktree: id, declaredPaths: [] } as unknown as LandingRequest);
    const order: string[] = [];
    for (let entry = queue.next(); entry; entry = queue.next()) { order.push(entry.request.taskId); queue.acknowledge(entry.id); }
    expect(order).toEqual(['tools-1', 'web-1', 'web-2']);
  } finally { db.close(); t.close(); }
});

test('critical-path and stabilize landings come after control-plane ones and before the rest', () => {
  const t = temporaryDirectory(); const db = openDb(join(t.path, 'state.sqlite'));
  try {
    db.run('CREATE TABLE worker_tasks (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, current_attempt INTEGER NOT NULL, body TEXT NOT NULL)');
    const tasks = [
      ['web-1', { goal: 'web' }], ['fix-1', { goal: 'performance', criticalPath: true }], ['tools-1', { goal: 'control-plane' }],
      ['stab-1', { goal: 'accounts', target: 'stabilize' }], ['web-2', { goal: 'web' }],
    ] as const;
    tasks.forEach(([id, brief], index) => db.run('INSERT INTO worker_tasks VALUES (?, ?, 1, ?)', [id, index + 1, JSON.stringify({ brief })]));
    const queue = new SqliteLandingQueue(db, { assertCurrent() {} } as unknown as AttemptFence);
    for (const [id] of tasks) queue.enqueue({ taskId: id, attempt: 1, branch: id, worktree: id, declaredPaths: [] } as unknown as LandingRequest);
    const order: string[] = [];
    for (let entry = queue.next(); entry; entry = queue.next()) { order.push(entry.request.taskId); queue.acknowledge(entry.id); }
    expect(order).toEqual(['tools-1', 'fix-1', 'stab-1', 'web-1', 'web-2']);
  } finally { db.close(); t.close(); }
});
