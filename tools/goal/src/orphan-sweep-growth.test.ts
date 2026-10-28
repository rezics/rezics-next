import { expect, test } from 'bun:test';
import { existsSync, watch, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WorkerTasks } from './tasks.ts';
import { WorkerJob } from './job.ts';
import type { DirectoryLease } from './lease.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import type { Attempt } from './types.ts';
import { harness } from './test-support.ts';
import type { ProcessIdentity } from './process.ts';

const deadDriver: ProcessIdentity = { pid: 2_147_483_647, start: 'dead', boot: 'dead', group: 2_147_483_647 };

const heldWorker = `#!/usr/bin/env bun
import { existsSync, watch, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync('.worker-started', 'ready');
if (!existsSync('.worker-release')) await new Promise<void>(resolve => {
  const watcher = watch('.', () => {
    if (existsSync('.worker-release')) { watcher.close(); resolve(); }
  });
  if (existsSync('.worker-release')) { watcher.close(); resolve(); }
});
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Finish held worker fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:20}}));
`;

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`missing fixture signal: ${path}`));
    }, 10_000);
    if (existsSync(path)) {
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
  });
}

test('a command orphan sweep reads and leases a constant candidate set as settled history grows', async () => {
  const measurements: { statements: number; attemptRows: number; taskRows: number; eventRows: number; leases: number }[] = [];
  for (const settledCount of [100, 1_000, 5_000]) {
    const db = openDb(':memory:');
    const stateDirectory = `/tmp/orphan-sweep-${settledCount}`;
    try {
      const store = new WorkerStore(db);
      const insertTask = db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
      const insertAttempt = db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)');
      for (let index = 0; index < settledCount; index += 1) {
        const id = `settled-${index}`;
        insertTask.run(id, index + 1, 1, JSON.stringify({ id, state: 'landing', currentAttempt: 1 }));
        insertAttempt.run(id, 1, JSON.stringify({ taskId: id, attempt: 1, state: 'superseded', logPath: `${stateDirectory}/${id}.log` }));
      }
      const id = 'candidate';
      insertTask.run(id, settledCount + 1, 1, JSON.stringify({ id, state: 'running', currentAttempt: 1 }));
      insertAttempt.run(id, 1, JSON.stringify({ taskId: id, attempt: 1, state: 'running', logPath: `${stateDirectory}/candidate.log`, driver: deadDriver, process: null }));

      const plan = db.query(`EXPLAIN QUERY PLAN
        SELECT a.body FROM worker_attempts AS a JOIN worker_tasks AS t ON t.id=a.task_id
        WHERE json_extract(a.body, '$.state') IN ('running', 'exited')
          AND json_extract(t.body, '$.state')='running'
          AND CAST(json_extract(t.body, '$.currentAttempt') AS INTEGER)=a.attempt`).all() as { detail: string }[];
      expect(plan.map((step) => step.detail).join(' ')).toContain('worker_attempts_state');

      const counts = { statements: 0, attemptRows: 0, taskRows: 0, eventRows: 0, leases: 0 };
      const handle = db as unknown as { query: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown } };
      const originalQuery = handle.query.bind(db);
      handle.query = (sql: string) => {
        const statement = originalQuery(sql);
        if (!/^\s*SELECT\b/i.test(sql)) return statement;
        const tables = [
          ...(sql.match(/(?:FROM|JOIN)\s+worker_attempts\b/gi) ?? []),
          ...(sql.match(/(?:FROM|JOIN)\s+worker_tasks\b/gi) ?? []),
          ...(sql.match(/(?:FROM|JOIN)\s+worker_events\b/gi) ?? []),
        ];
        const observe = (rows: unknown[] | unknown) => {
          counts.statements += 1;
          const count = Array.isArray(rows) ? rows.length : rows == null ? 0 : 1;
          for (const table of tables) {
            if (/worker_attempts/i.test(table)) counts.attemptRows += count;
            if (/worker_tasks/i.test(table)) counts.taskRows += count;
            if (/worker_events/i.test(table)) counts.eventRows += count;
          }
          return rows;
        };
        return {
          all: (...args: unknown[]) => observe(statement.all(...args)),
          get: (...args: unknown[]) => observe(statement.get(...args)),
        };
      };
      const acquire = (_path: string): DirectoryLease => {
        counts.leases += 1;
        return { release() {} };
      };
      const tasks = { store, settings: { stateDirectory } } as unknown as WorkerTasks;
      await new WorkerJob(tasks, { enqueue() {} }, { deliver() {} }, undefined, undefined, acquire).recoverOrphans({ adoptRunning: false });
      measurements.push(counts);
    } finally {
      db.close();
    }
  }
  expect(measurements[1]).toEqual(measurements[0]);
  expect(measurements[2]).toEqual(measurements[0]);
  expect(measurements[0]).toMatchObject({ eventRows: 0, leases: 1 });
  expect(measurements[0]?.attemptRows).toBeGreaterThan(0);
  expect(measurements[0]?.taskRows).toBeGreaterThan(0);
});

test('the next command settles an exited attempt that remains current and unsettled', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.store.updateAttempt(worker.attempt, (attempt) => {
      (attempt as Attempt & { driver?: ProcessIdentity }).driver = deadDriver;
      attempt.state = 'exited';
      attempt.endedAt = new Date().toISOString();
    });

    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.recoverOrphans({ adoptRunning: false });
    expect(h.store.task(task.id).state).toBe('landing');
    expect(h.store.attempt(worker.attempt).state).toBe('exited');
  } finally {
    h.dispose();
  }

}, 20_000);

test('the host recovers a running attempt after its worker process has died', async () => {
  const h = harness(heldWorker);
  let release = '';
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    release = `${task.worktree}/.worker-release`;
    await waitForFile(`${task.worktree}/.worker-started`);
    writeFileSync(release, 'release');
    await worker.exited;
    h.store.updateAttempt(worker.attempt, (attempt) => {
      (attempt as Attempt & { driver?: ProcessIdentity }).driver = deadDriver;
    });
    expect(h.store.attempt(worker.attempt).state).toBe('running');

    await new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} }).recoverOrphans();
    expect(h.store.task(task.id).state).toBe('landing');
  } finally {
    if (release) writeFileSync(release, 'release');
    h.dispose();
  }
}, 20_000);

test('per-task event reads use the task and attempt index', () => {
  const db = openDb(':memory:');
  try {
    const store = new WorkerStore(db);
    const plan = db.query('EXPLAIN QUERY PLAN SELECT * FROM worker_events WHERE task_id=? AND attempt=? ORDER BY sequence').all('task', 1) as { detail: string }[];
    expect(plan.map((step) => step.detail).join(' ')).toContain('worker_events_task_attempt_sequence');
    expect(plan.map((step) => step.detail).join(' ')).not.toContain('SCAN worker_events');
    expect(store.events('task', 1)).toEqual([]);
  } finally {
    db.close();
  }
});
