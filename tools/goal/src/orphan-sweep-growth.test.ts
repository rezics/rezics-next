import { expect, test } from 'bun:test';
import { existsSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkerTasks } from './tasks.ts';
import { WorkerJob } from './job.ts';
import type { DirectoryLease } from './lease.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import type { Attempt } from './types.ts';
import { harness, repository } from './test-support.ts';
import type { ProcessIdentity } from './process.ts';
import { observeSqliteWork, type SqliteWork } from './sqlite-work.test-support.ts';

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

function recoveryWork(work: SqliteWork[]): SqliteWork[] {
  // The entire sweep is logged; these are the adopted candidate and per-attempt event operations.
  const selected = work.filter((row) =>
    /SELECT a.body AS attempt_body|FROM worker_events WHERE task_id=\?/i.test(row.sql),
  );
  expect(selected.length).toBeGreaterThan(0);
  for (const row of selected) {
    expect(row.runs).toBe(1);
    expect(row.vmSteps).toBeGreaterThan(0);
    expect(row.vmSteps).toBeLessThanOrEqual(1_000);
    expect(row.fullscanSteps).toBe(0);
  }
  return selected;
}

test('command and host sweeps read and lease a constant live candidate set as settled history grows', async () => {
  const nativeMeasurements: SqliteWork[][] = [];
  const measurements: {
    statements: number;
    attemptRows: number;
    taskRows: number;
    eventRows: number;
    leases: number;
  }[] = [];
  for (const settledCount of [100, 1_000, 5_000]) {
    for (const adoptRunning of [false, true]) {
      const db = openDb(':memory:');
      const fixture = repository();
      const stateDirectory = join(fixture.path, 'state');
      try {
        const store = new WorkerStore(db);
        const insertTask = db.query(
          'INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)',
        );
        const insertAttempt = db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)');
        const settledStates = ['integrated', 'merged'];
        const insertEvent = db.query(
          "INSERT INTO worker_events(task_id, attempt, kind, at, body) VALUES (?, ?, 'fixture', '2000-01-01', '{}')",
        );
        for (let index = 0; index < settledCount; index += 1) {
          const id = `settled-${index}`;
          const state = settledStates[index % settledStates.length]!;
          insertTask.run(
            id,
            index + 1,
            2,
            JSON.stringify({
              id,
              state,
              currentAttempt: 2,
              brief: { after: [] },
              createdAt: '2000-01-01T00:00:00.000Z',
            }),
          );
          insertAttempt.run(
            id,
            1,
            JSON.stringify({ taskId: id, attempt: 1, state: 'superseded', logPath: `${stateDirectory}/${id}.log` }),
          );
          insertAttempt.run(
            id,
            2,
            JSON.stringify({ taskId: id, attempt: 2, state: 'exited', logPath: `${stateDirectory}/${id}.log` }),
          );
        }
        for (let index = 0; index < settledCount * 3; index++)
          insertEvent.run(`settled-${index % settledCount}`, index + 1);
        const id = 'candidate';
        insertTask.run(
          id,
          settledCount + 1,
          1,
          JSON.stringify({
            id,
            state: 'running',
            currentAttempt: 1,
            brief: { after: [] },
            createdAt: '2000-01-01T00:00:00.000Z',
          }),
        );
        insertAttempt.run(
          id,
          1,
          JSON.stringify({
            taskId: id,
            attempt: 1,
            state: 'running',
            logPath: `${stateDirectory}/candidate.log`,
            driver: deadDriver,
            process: null,
          }),
        );
        store.event({ taskId: id, attempt: 1 }, 'landing-requested', {});

        const plan = db
          .query(`EXPLAIN QUERY PLAN
          SELECT a.body FROM worker_tasks AS t JOIN worker_attempts AS a
            ON a.task_id=t.id AND a.attempt=t.current_attempt
          WHERE json_extract(t.body, '$.state')='running'
            AND json_extract(a.body, '$.state') IN ('running', 'exited')`)
          .all() as { detail: string }[];
        const planText = plan.map((step) => step.detail).join(' ');
        expect(planText).toContain('worker_tasks_state');
        expect(planText).toContain('sqlite_autoindex_worker_attempts_1 (task_id=? AND attempt=?)');
        expect(planText).not.toContain('worker_attempts_state');

        const native = observeSqliteWork(db, join(fixture.path, 'native'));
        const counts = { statements: 0, attemptRows: 0, taskRows: 0, eventRows: 0, leases: 0 };
        const handle = db as unknown as {
          query: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown };
        };
        const originalQuery = handle.query.bind(db);
        handle.query = (sql: string) => {
          const statement = originalQuery(sql);
          if (!/^\s*(?:\/\*.*?\*\/\s*)?SELECT\b/i.test(sql) || !/worker_tasks AS t|worker_events/i.test(sql))
            return statement;
          const observe = <T>(rows: T): T => {
            const count = Array.isArray(rows) ? rows.length : rows == null ? 0 : 1;
            counts.statements += 1;
            if (/worker_tasks AS t/i.test(sql)) {
              counts.taskRows += count;
              counts.attemptRows += count;
            } else if (/worker_events/i.test(sql)) counts.eventRows += count;
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
        const tasks = {
          store,
          settings: {
            stateDirectory,
            mainCheckout: fixture.main,
            worktreeRoot: join(fixture.path, 'worktrees'),
            startGraceMs: 10_000_000,
          },
          dependenciesMet: () => true,
        } as unknown as WorkerTasks;
        const job = new WorkerJob(tasks, { enqueue() {} }, { deliver() {} }, undefined, undefined, acquire);
        await job.recoverOrphans({ adoptRunning });
        const measured = recoveryWork(native.drain(`orphan:${settledCount}:${adoptRunning}`));
        nativeMeasurements.push(measured);
        measurements.push({ ...counts });
        // This candidate already has a landing request, so both modes leave it intact on repeated observation.
        await job.recoverOrphans({ adoptRunning });
        expect(store.task(id).currentAttempt).toBe(1);
        expect(counts.leases).toBe(2);
        recoveryWork(native.drain(`orphan-repeat:${settledCount}:${adoptRunning}`));
        store.updateTask({ taskId: id, attempt: 1 }, (task) => {
          task.state = 'integrated';
        });
        store.updateAttempt({ taskId: id, attempt: 1 }, (attempt) => {
          attempt.state = 'superseded';
        });
        for (let sweep = 0; sweep < 2; sweep++) {
          await job.recoverOrphans({ adoptRunning });
          expect(counts.leases).toBe(2);
          expect(store.orphanSweepCandidates()).toEqual([]);
          recoveryWork(native.drain(`orphan-empty:${settledCount}:${adoptRunning}:${sweep}`));
        }
        native.restore();
      } finally {
        db.close();
        fixture.close();
      }
    }
  }
  expect(nativeMeasurements[2]).toEqual(nativeMeasurements[0]);
  expect(nativeMeasurements[4]).toEqual(nativeMeasurements[0]);
  expect(nativeMeasurements[3]).toEqual(nativeMeasurements[1]);
  expect(nativeMeasurements[5]).toEqual(nativeMeasurements[1]);
  expect(measurements[2]).toEqual(measurements[0]);
  expect(measurements[4]).toEqual(measurements[0]);
  expect(measurements[3]).toEqual(measurements[1]);
  expect(measurements[5]).toEqual(measurements[1]);
  expect(measurements[0]).toMatchObject({ eventRows: 1, leases: 1 });
  expect(measurements[0]?.attemptRows).toBeGreaterThan(0);
  expect(measurements[0]?.taskRows).toBeGreaterThan(0);
});

test('the next command settles an exited attempt that remains current and unsettled', async () => {
  for (const settledCount of [100, 1_000, 5_000]) {
    for (const adoptRunning of [false, true]) {
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

        const db = h.store.db;
        const taskRow = db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, 2, ?)');
        const attemptRow = db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)');
        const eventRow = db.query(
          "INSERT INTO worker_events(task_id, attempt, kind, at, body) VALUES (?, ?, 'fixture', '2000-01-01', '{}')",
        );
        db.transaction(() => {
          for (let i = 0; i < settledCount; i++) {
            const id = `settled-${i}`;
            taskRow.run(
              id,
              i + 10_000,
              JSON.stringify({ id, state: 'integrated', currentAttempt: 2, brief: { after: [] } }),
            );
            for (const attempt of [1, 2])
              attemptRow.run(id, attempt, JSON.stringify({ taskId: id, attempt, state: 'superseded' }));
            for (const attempt of [1, 2, 3]) eventRow.run(id, attempt);
          }
        })();
        const native = observeSqliteWork(db, join(h.tasks.settings.stateDirectory, 'native'));
        let leases = 0;
        const acquire = (): DirectoryLease => {
          leases++;
          return { release() {} };
        };
        let replacements = 0;
        const job = new WorkerJob(
          h.tasks,
          {
            enqueue() {
              replacements++;
            },
          },
          { deliver() {} },
          undefined,
          undefined,
          acquire,
        );
        await job.recoverOrphans({ adoptRunning });
        recoveryWork(native.drain(`orphan-settle:${settledCount}:${adoptRunning}`));
        expect(h.store.task(task.id).state).toBe('landing');
        expect(h.store.attempt(worker.attempt).state).toBe('exited');
        expect(leases).toBe(1);
        expect(replacements).toBe(1);
        const settled = {
          leases,
          replacements,
          attempt: h.store.task(task.id).currentAttempt,
          events: h.store.events(task.id, worker.attempt.attempt),
        };
        await job.recoverOrphans({ adoptRunning: false });
        await job.recoverOrphans();
        expect({
          leases,
          replacements,
          attempt: h.store.task(task.id).currentAttempt,
          events: h.store.events(task.id, worker.attempt.attempt),
        }).toEqual(settled);
        recoveryWork(native.drain(`orphan-reconciled-replay:${settledCount}:${adoptRunning}`));
        native.restore();
      } finally {
        h.dispose();
      }
    }
  }
}, 60_000);

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
    const plan = db
      .query('EXPLAIN QUERY PLAN SELECT * FROM worker_events WHERE task_id=? AND attempt=? ORDER BY sequence')
      .all('task', 1) as { detail: string }[];
    expect(plan.map((step) => step.detail).join(' ')).toContain('worker_events_task_attempt_sequence');
    expect(plan.map((step) => step.detail).join(' ')).not.toContain('SCAN worker_events');
    expect(store.events('task', 1)).toEqual([]);
  } finally {
    db.close();
  }
});
