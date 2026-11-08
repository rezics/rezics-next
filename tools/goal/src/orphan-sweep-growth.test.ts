import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { WorkerTasks } from './tasks.ts';
import { WorkerJob } from './job.ts';
import type { DirectoryLease } from './lease.ts';
import { migrate, openDb } from './db.ts';
import { WorkerStore, workerMigrations } from './store.ts';
import type { Attempt, Settings } from './types.ts';
import { harness, repository } from './test-support.ts';
import type { ProcessIdentity } from './process.ts';
import { observeSqliteWork, type SqliteWork } from '../test-support/sqlite-work.ts';
import { runMaintenance } from './maintenance.ts';
import type { Runtime } from './config.ts';
import { removeFinishedWorktree } from './worktree-lifetime.ts';
import type { LifetimeRuntime, LifetimeWorkUnit } from './worktree-lifetime.ts';

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

function maintenanceFixture(taskCount: number, attemptCount = taskCount * 2, eventCount = taskCount * 3) {
  const repositoryFixture = repository();
  const stateDirectory = join(repositoryFixture.path, 'state');
  const worktreeRoot = join(repositoryFixture.path, 'worktrees');
  const procRoot = join(repositoryFixture.path, 'proc');
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(join(procRoot, '1'), { recursive: true });
  mkdirSync(join(procRoot, 'sys'), { recursive: true });
  mkdirSync(join(worktreeRoot, 'settled-00000'), { recursive: true });
  writeFileSync(join(worktreeRoot, 'settled-00000', 'leftover'), 'owned fixture remnant');
  const db = openDb(':memory:');
  migrate(db, workerMigrations.filter((migration) => !(migration.module === 'worker' && migration.version === 14)));
  const insertTask = db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, 2, ?)');
  const insertAttempt = db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)');
  const insertEvent = db.query(
    "INSERT INTO worker_events(task_id, attempt, kind, at, body) VALUES (?, ?, 'fixture', '2000-01-01', '{}')",
  );
  db.transaction(() => {
    for (let index = 0; index < taskCount; index++) {
      const id = `settled-${String(index).padStart(5, '0')}`;
      insertTask.run(
        id,
        index + 1,
        JSON.stringify({
          id,
          sequence: index + 1,
          state: 'integrated',
          currentAttempt: 2,
          worktree: join(worktreeRoot, id),
          brief: { after: [], markdown: '' },
          createdAt: '2000-01-01T00:00:00.000Z',
        }),
      );
    }
    for (let ordinal = 1; ordinal <= attemptCount; ordinal++) {
      const taskIndex = (ordinal - 1) % taskCount;
      const attempt = Math.floor((ordinal - 1) / taskCount) + 1;
      const id = `settled-${String(taskIndex).padStart(5, '0')}`;
      insertAttempt.run(
        id,
        attempt,
        JSON.stringify({
          taskId: id,
          attempt,
          state: 'superseded',
          process:
            ordinal === 1
              ? { pid: 2_147_483_647, start: 'dead', boot: 'dead', group: 2_147_483_647 }
              : null,
        }),
      );
    }
    for (let ordinal = 1; ordinal <= eventCount; ordinal++) {
      const taskIndex = (ordinal - 1) % taskCount;
      insertEvent.run(`settled-${String(taskIndex).padStart(5, '0')}`, ordinal);
    }
  }).immediate();
  const store = new WorkerStore(db);
  const settings = { stateDirectory, mainCheckout: repositoryFixture.main, worktreeRoot } as Settings;
  return { db, store, settings, procRoot, repositoryFixture };
}

function assertMaintenanceWork(work: SqliteWork[]): void {
  expect(work.length).toBeGreaterThan(0);
  for (const row of work) {
    expect(row.runs).toBe(1);
    expect(row.vmSteps).toBeGreaterThan(0);
    expect(row.vmSteps).toBeLessThanOrEqual(2_000);
    expect(row.fullscanSteps).toBe(0);
    expect(row.sorts).toBe(0);
  }
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
              worktree: join(fixture.path, 'worktrees', id),
              brief: { after: [], markdown: '' },
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
            worktree: join(fixture.path, 'worktrees', id),
            brief: { after: [], markdown: '' },
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

test('host maintenance reaches a fixed cleanup and process neighbourhood across three settled-history scales', async () => {
  const traces: SqliteWork[][] = [];
  const unitScales: Record<string, number>[] = [];
  const scales = [
    [100, 200, 300],
    [1_000, 200, 300],
    [5_000, 200, 300],
    [100, 100, 300],
    [100, 1_000, 300],
    [100, 5_000, 300],
    [100, 200, 100],
    [100, 200, 1_000],
    [100, 200, 5_000],
  ] as const;
  for (const [taskCount, attemptCount, eventCount] of scales) {
    const { db, store, settings, procRoot, repositoryFixture } = maintenanceFixture(taskCount, attemptCount, eventCount);
    const label = `${taskCount}/${attemptCount}/${eventCount}`;
    const native = observeSqliteWork(db, join(repositoryFixture.path, `native-maintenance-${label}`));
    const units: Record<string, number> = {};
    const observe = (unit: string) => {
      units[unit] = (units[unit] ?? 0) + 1;
    };
    const lifetime: LifetimeRuntime = {
      pressure: () => null,
      sleep: async () => {},
      command: () => {},
      procRoot,
      observe: (unit: LifetimeWorkUnit) => observe(unit),
    };
    try {
      expect(
        await runMaintenance(
          'reap',
          { stateDirectory: settings.stateDirectory, settings, store } as Runtime,
          (unit) => observe(unit),
          lifetime,
        ),
      ).toBe(0);
      const work = native.drain(`maintenance-full-trace:${label}`);
      assertMaintenanceWork(work);
      expect(work.some((row) => /worker_maintenance_candidates/.test(row.sql))).toBe(true);
      expect(work.some((row) => /worker_maintenance_progress/.test(row.sql))).toBe(true);
      expect(work.some((row) => /json_type\(body, '\$\.process'\)/.test(row.sql))).toBe(true);
      expect(work.some((row) => /worker_events/.test(row.sql))).toBe(false);
      expect(work.filter((row) => /worker_worktree_cleanup/.test(row.sql))).toHaveLength(2);
      expect(work.some((row) => /SELECT id, body FROM worker_tasks ORDER BY sequence/i.test(row.sql))).toBe(false);
      expect(units).toMatchObject({
        'maintenance-backfill-task-row': 32,
        'maintenance-backfill-attempt-row': 32,
        'reap-worktree-existence': 1,
        'process-directory-entry': 4,
        'process-cwd-enumeration': 2,
        'candidate-path-stat': 4,
        'permission-path-component': 2 * join(settings.worktreeRoot!, 'settled-00000').split(sep).filter(Boolean).length,
        'worktree-tree-expansion': 1,
        'worktree-tree-entry': 1,
      });
      expect(units['process-group-termination'] ?? 0).toBe(0);
      traces.push(work);
      unitScales.push(units);
    } finally {
      native.restore();
      db.close();
      repositoryFixture.close();
    }
  }
  for (const trace of traces.slice(1)) expect(trace).toEqual(traces[0]!);
  for (const units of unitScales.slice(1)) expect(units).toEqual(unitScales[0]!);
}, 60_000);

test('deep cleanup backlog drains in fixed pages and empty passes stop scanning history', () => {
  const taskCount = 5_000;
  const { db, store, repositoryFixture } = maintenanceFixture(taskCount, taskCount * 2, taskCount * 3);
  const native = observeSqliteWork(db, join(repositoryFixture.path, 'native-maintenance-drain'));
  let reached = 0;
  let passes = 0;
  try {
    while (!store.maintenanceTasksBootstrapped() || store.hasPendingWorktreeCandidates()) {
      store.bootstrapMaintenanceTasks(32);
      const candidates = store.worktreeMaintenanceCandidates(16);
      expect(candidates.length).toBeLessThanOrEqual(16);
      reached += candidates.length;
      store.completeMaintenanceCandidates(candidates);
      expect(++passes).toBeLessThan(1_000);
    }
    expect(reached).toBe(taskCount);
    expect(store.bootstrapMaintenanceTasks(32)).toEqual({ examined: 0, complete: true });
    // The first empty selection wraps the durable round-robin ticket; later empty passes are identical.
    expect(store.worktreeMaintenanceCandidates(16)).toEqual([]);
    const firstEmpty = store.worktreeMaintenanceCandidates(16);
    const secondEmpty = store.worktreeMaintenanceCandidates(16);
    expect(firstEmpty).toEqual([]);
    expect(secondEmpty).toEqual([]);
    const work = native.drain(`maintenance-drain:${taskCount}/${taskCount * 2}/${taskCount * 3}`);
    assertMaintenanceWork(work);
    expect(work.some((row) => /worker_maintenance_candidates/.test(row.sql))).toBe(true);
    expect(work.some((row) => /SELECT id, body FROM worker_tasks ORDER BY sequence/i.test(row.sql))).toBe(false);
  } finally {
    native.restore();
    db.close();
    repositoryFixture.close();
  }
}, 60_000);

test('unregistered directory recovery keeps its complete native trace fixed across task history', async () => {
  const traces: SqliteWork[][] = [];
  const unitScales: Record<string, number>[] = [];
  for (const taskCount of [100, 1_000, 5_000]) {
    const { db, store, settings, procRoot, repositoryFixture } = maintenanceFixture(taskCount, 200, 300);
    const unknown = join(settings.worktreeRoot!, 'unknown-leftover');
    mkdirSync(unknown, { recursive: true });
    writeFileSync(join(unknown, 'payload'), 'owned unregistered remnant');
    const lastSequence = (db.query('SELECT max(sequence) AS value FROM worker_tasks').get() as { value: number }).value;
    db.query(`INSERT INTO worker_maintenance_task_paths(path, task_id, sequence)
      SELECT json_extract(body, '$.worktree'), id, sequence FROM worker_tasks
      WHERE json_type(body, '$.worktree')='text'`)
      .run();
    db.query('DELETE FROM worker_maintenance_candidates').run();
    db.query(`UPDATE worker_maintenance_progress SET task_sequence=?, tasks_complete=1 WHERE id=1`).run(lastSequence);
    const native = observeSqliteWork(db, join(repositoryFixture.path, `native-stray-${taskCount}`));
    const units: Record<string, number> = {};
    const io: LifetimeRuntime = {
      pressure: () => null,
      sleep: async () => {},
      command: () => {},
      procRoot,
      observe: (unit: LifetimeWorkUnit) => {
        units[unit] = (units[unit] ?? 0) + 1;
      },
    };
    try {
      expect(await removeFinishedWorktree(settings, store, io)).toBe(unknown);
      expect(existsSync(unknown)).toBe(false);
      const work = native.drain(`maintenance-stray-full-trace:${taskCount}/200/300`);
      assertMaintenanceWork(work);
      expect(work.some((row) => /worker_maintenance_scan_directories/.test(row.sql))).toBe(true);
      expect(work.some((row) => /worker_maintenance_task_paths/.test(row.sql))).toBe(true);
      expect(work.some((row) => /worker_maintenance_strays/.test(row.sql))).toBe(true);
      expect(work.some((row) => /worker_events/.test(row.sql))).toBe(false);
      expect(work.some((row) => /SELECT id, body FROM worker_tasks ORDER BY sequence/i.test(row.sql))).toBe(false);
      expect(units).toMatchObject({
        'worktree-root-entry': 2,
        'worktree-root-stat': 2,
        'candidate-path-stat': 5,
        'worktree-tree-expansion': 1,
        'worktree-tree-entry': 1,
        'process-cwd-enumeration': 2,
        'process-directory-entry': 4,
        'git-registration-prune': 1,
      });
      traces.push(work);
      unitScales.push(units);
    } finally {
      native.restore();
      db.close();
      repositoryFixture.close();
    }
  }
  for (const trace of traces.slice(1)) expect(trace).toEqual(traces[0]!);
  for (const units of unitScales.slice(1)) expect(units).toEqual(unitScales[0]!);
}, 60_000);

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
              JSON.stringify({
                id,
                state: 'integrated',
                currentAttempt: 2,
                worktree: join(h.tasks.settings.worktreeRoot, id),
                brief: { after: [], markdown: '' },
              }),
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
