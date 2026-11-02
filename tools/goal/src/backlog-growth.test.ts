import { expect, mock, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { join, sep } from 'node:path';
import type { BacklogSweep } from './backlog.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory } from './test-support.ts';

const NOW = Date.UTC(2026, 10, 2, 12, 0);
const GROWTH_SCENARIO =
  'backlog growth tracks indexed history, input-proportional directory entries, and dispatch/cancellation caps';
let activeDirectoryProbe: { root: string; metrics: Metrics } | undefined;
const nativeFs = createRequire(import.meta.url)('node:fs') as {
  readdirSync: (...args: unknown[]) => unknown[];
};
const nativeReaddir = nativeFs.readdirSync.bind(nativeFs);
mock.module('node:fs', () => ({
  ...nativeFs,
  readdirSync: (...args: unknown[]) => {
    const probe = activeDirectoryProbe;
    const path = String(args[0]);
    const inBacklog = probe && (path === probe.root || path.startsWith(`${probe.root}${sep}`));
    if (inBacklog) probe.metrics.directoryEnumerations += 1;
    const entries = nativeReaddir(...args);
    if (inBacklog) probe.metrics.directoryEntriesReturned += entries.length;
    return entries;
  },
}));

test('the approved backlog Cost derivation names the exact native growth scenario', () => {
  const citation = `\`tools/goal/src/backlog-growth.test.ts\`: \`${GROWTH_SCENARIO}\``;
  const delivery = readFileSync(join(import.meta.dir, '../README.md'), 'utf8');
  const performance = readFileSync(join(import.meta.dir, '../../../docs/goals/performance.capabilities.md'), 'utf8');
  expect(delivery).toContain(citation);
  expect(performance).toContain(citation);
});

type Metrics = {
  sqliteExecutions: number;
  sqliteRowsReturned: number;
  sqliteRowsChanged: number;
  stoppedRowsReturned: number;
  decodedJsonBytes: number;
  directoryEnumerations: number;
  directoryEntriesReturned: number;
};

type ProbeStatement = {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): { changes: number };
  values(...args: unknown[]): unknown[][];
};

type ProbeDatabase = {
  query(sql: string): ProbeStatement;
  exec(sql: string): unknown;
};

type Input = { settled: number; stopped: number; ready: number; manager?: boolean; sweeps?: number };

function task(db: Database, id: string, state: string, sequence: number, brief: Record<string, unknown>): void {
  db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, 1, ?)').run(
    id,
    sequence,
    JSON.stringify({
      id,
      state,
      branch: `worker/${id}`,
      createdAt: new Date(NOW - 5 * 3_600_000).toISOString(),
      brief,
    }),
  );
}

function event(db: Database, id: string, kind: string, at: number): void {
  db.query('INSERT INTO worker_events(task_id, attempt, kind, at, body) VALUES (?, 1, ?, ?, ?)').run(
    id,
    kind,
    new Date(at).toISOString(),
    '{}',
  );
}

function observeDatabase(db: Database, metrics: Metrics): () => void {
  const handle = db as unknown as ProbeDatabase;
  const queryBefore = handle.query;
  const execBefore = handle.exec;
  const query = handle.query.bind(db);
  handle.query = (sql) => {
    const statement = query(sql);
    const stoppedQuery = /FROM worker_tasks WHERE json_extract\(body, '\$\.state'\)='stopped'/i.test(sql);
    const countRows = (count: number) => {
      metrics.sqliteExecutions += 1;
      metrics.sqliteRowsReturned += count;
      if (stoppedQuery) metrics.stoppedRowsReturned += count;
    };
    return {
      all(...args) {
        const rows = statement.all(...args);
        countRows(rows.length);
        return rows;
      },
      get(...args) {
        const row = statement.get(...args);
        countRows(row == null ? 0 : 1);
        return row;
      },
      run(...args) {
        const result = statement.run(...args);
        metrics.sqliteExecutions += 1;
        metrics.sqliteRowsChanged += result.changes;
        return result;
      },
      values(...args) {
        const rows = statement.values(...args);
        countRows(rows.length);
        return rows;
      },
    };
  };
  handle.exec = (sql) => {
    const result = execBefore.call(db, sql);
    metrics.sqliteExecutions += 1;
    return result;
  };
  return () => {
    handle.query = queryBefore;
    handle.exec = execBefore;
  };
}

function observeJson(metrics: Metrics): () => void {
  const original = JSON.parse;
  JSON.parse = ((...args: unknown[]) => {
    if (typeof args[0] === 'string') metrics.decodedJsonBytes += Buffer.byteLength(args[0]);
    return Reflect.apply(original, JSON, args);
  }) as typeof JSON.parse;
  return () => {
    JSON.parse = original;
  };
}

function observeDirectories(root: string, metrics: Metrics): () => void {
  activeDirectoryProbe = { root, metrics };
  return () => {
    activeDirectoryProbe = undefined;
  };
}

async function run(input: Input) {
  const temporary = temporaryDirectory();
  const state = temporary.path;
  const backlog = join(state, 'backlog');
  const db = openDb(join(state, 'goal.sqlite'));
  new WorkerStore(db);
  const dispatches: string[] = [];
  const cancellations: string[] = [];
  const metrics: Metrics = {
    sqliteExecutions: 0,
    sqliteRowsReturned: 0,
    sqliteRowsChanged: 0,
    stoppedRowsReturned: 0,
    decodedJsonBytes: 0,
    directoryEnumerations: 0,
    directoryEntriesReturned: 0,
  };
  const inbox = new SqliteManagerInbox(db, state, () => NOW);
  db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  if (input.manager)
    db.query('INSERT INTO manager_sessions(id, state) VALUES (?, ?)').run(
      'web',
      JSON.stringify({ kind: 'managed', status: 'running', goal: 'web', goalState: { status: 'active' } }),
    );

  let sequence = 0;
  for (let index = 0; index < input.settled; index += 1) {
    const id = `settled-${index}`;
    task(db, id, 'integrated', ++sequence, { goal: 'past', manager: 'past', markdown: id });
    event(db, id, 'integrated', NOW - 2 * 3_600_000);
  }
  for (let index = 0; index < input.stopped; index += 1) {
    const id = `stopped-${String(index).padStart(2, '0')}`;
    task(db, id, 'stopped', ++sequence, { goal: 'web', manager: 'web', markdown: id });
    event(db, id, 'stopped', NOW - 2 * 3_600_000 - index * 1_000);
  }
  if (input.ready) mkdirSync(join(backlog, 'web'), { recursive: true });
  for (let index = 0; index < input.ready; index += 1) {
    const file = join(backlog, 'web', `brief-${String(index).padStart(2, '0')}.md`);
    writeFileSync(file, `${index}\n`);
    const time = (NOW - 60_000) / 1_000;
    utimesSync(file, time, time);
  }

  const taskPlan = db
    .query(
      "EXPLAIN QUERY PLAN SELECT id, current_attempt, body FROM worker_tasks WHERE json_extract(body, '$.state')='stopped' ORDER BY sequence",
    )
    .all()
    .map((step) => (step as { detail: string }).detail)
    .join(' ');
  const eventPlan = db
    .query(
      'EXPLAIN QUERY PLAN SELECT at FROM worker_events WHERE task_id=? AND attempt=? ORDER BY sequence DESC LIMIT 1',
    )
    .all('stopped-00', 1)
    .map((step) => (step as { detail: string }).detail)
    .join(' ');
  const runtime = {
    db,
    stateDirectory: state,
    inbox,
    now: () => NOW,
    workerCap: 32,
    async dispatch(file: string) {
      dispatches.push(file.slice(file.lastIndexOf(sep) + 1));
      return `task-${dispatches.length}`;
    },
    async continueTask() {},
    async cancel(taskId: string) {
      cancellations.push(taskId);
      const row = db.query('SELECT body FROM worker_tasks WHERE id=?').get(taskId) as { body: string };
      db.query('UPDATE worker_tasks SET body=? WHERE id=?').run(
        JSON.stringify({ ...JSON.parse(row.body), state: 'cancelled' }),
        taskId,
      );
    },
  };
  const restoreDatabase = observeDatabase(db, metrics);
  const restoreJson = observeJson(metrics);
  const restoreDirectories = observeDirectories(backlog, metrics);
  const sweeps: BacklogSweep[] = [];
  let firstMetrics: Metrics | undefined;
  try {
    const { sweepBacklog } = await import('./backlog.ts');
    for (let index = 0; index <= (input.sweeps ?? 0); index += 1) {
      sweeps.push(await sweepBacklog(runtime));
      if (index === 0) firstMetrics = { ...metrics };
    }
    return { sweeps, metrics: firstMetrics!, dispatches, cancellations, taskPlan, eventPlan };
  } finally {
    restoreDirectories();
    restoreJson();
    restoreDatabase();
    db.close();
    temporary.close();
  }
}

test(GROWTH_SCENARIO, async () => {
  const empty = await run({ settled: 0, stopped: 0, ready: 0 });
  expect(empty.sweeps[0]).toEqual({ dispatched: [], continued: [], refused: [], expired: [], woken: [] });

  const history: Awaited<ReturnType<typeof run>>[] = [];
  for (const settled of [100, 1_000, 5_000]) history.push(await run({ settled, stopped: 1, ready: 1, manager: true }));
  expect(history.map((sample) => sample.metrics.sqliteExecutions)).toEqual([
    history[0]!.metrics.sqliteExecutions,
    history[0]!.metrics.sqliteExecutions,
    history[0]!.metrics.sqliteExecutions,
  ]);
  expect(history.map((sample) => sample.metrics.sqliteRowsReturned)).toEqual([
    history[0]!.metrics.sqliteRowsReturned,
    history[0]!.metrics.sqliteRowsReturned,
    history[0]!.metrics.sqliteRowsReturned,
  ]);
  expect(history.map((sample) => sample.metrics.decodedJsonBytes)).toEqual([
    history[0]!.metrics.decodedJsonBytes,
    history[0]!.metrics.decodedJsonBytes,
    history[0]!.metrics.decodedJsonBytes,
  ]);
  expect(history[0]!.metrics.sqliteExecutions).toBeGreaterThan(0);
  expect(history[0]!.metrics.sqliteRowsReturned).toBeGreaterThan(0);
  expect(history.map((sample) => sample.metrics.stoppedRowsReturned)).toEqual([1, 1, 1]);
  expect(history[0]!.taskPlan).toContain('worker_tasks_state');
  expect(history[0]!.eventPlan).toContain('worker_events_task_attempt_sequence');

  const stopped: Awaited<ReturnType<typeof run>>[] = [];
  for (const count of [1, 10, 30])
    stopped.push(await run({ settled: 100, stopped: count, ready: 0, manager: true, sweeps: 1 }));
  expect(stopped.map((sample) => sample.metrics.stoppedRowsReturned)).toEqual([1, 10, 30]);
  expect(stopped[0]!.metrics.sqliteExecutions).toBeLessThan(stopped[1]!.metrics.sqliteExecutions);
  expect(stopped[1]!.metrics.sqliteExecutions).toBeLessThan(stopped[2]!.metrics.sqliteExecutions);
  expect(stopped[0]!.metrics.decodedJsonBytes).toBeLessThan(stopped[1]!.metrics.decodedJsonBytes);
  expect(stopped[1]!.metrics.decodedJsonBytes).toBeLessThan(stopped[2]!.metrics.decodedJsonBytes);
  expect(stopped.map((sample) => sample.sweeps.map((sweep) => sweep.expired.length))).toEqual([
    [1, 0],
    [10, 0],
    [20, 10],
  ]);
  for (const [index, sample] of stopped.entries()) {
    expect(sample.cancellations).toHaveLength([1, 10, 30][index]!);
    expect(new Set(sample.cancellations).size).toBe(sample.cancellations.length);
  }

  const directories: Awaited<ReturnType<typeof run>>[] = [];
  for (const ready of [4, 8, 12])
    directories.push(await run({ settled: 100, stopped: 0, ready, manager: true, sweeps: 2 }));
  expect(directories.map((sample) => sample.sweeps.map((sweep) => sweep.dispatched.length))).toEqual([
    [4, 0, 0],
    [4, 4, 0],
    [4, 4, 4],
  ]);
  expect(directories.map((sample) => sample.dispatches.length)).toEqual([4, 8, 12]);
  for (const sample of directories) expect(new Set(sample.dispatches).size).toBe(sample.dispatches.length);
  expect(directories[0]!.metrics.directoryEnumerations).toBeGreaterThan(0);
  expect(directories[0]!.metrics.directoryEntriesReturned).toBeGreaterThan(0);
  expect(directories[0]!.metrics.directoryEntriesReturned).toBeLessThan(
    directories[1]!.metrics.directoryEntriesReturned,
  );
  expect(directories[1]!.metrics.directoryEntriesReturned).toBeLessThan(
    directories[2]!.metrics.directoryEntriesReturned,
  );
  expect(directories.map((sample) => sample.metrics.directoryEnumerations)).toEqual([
    directories[0]!.metrics.directoryEnumerations,
    directories[0]!.metrics.directoryEnumerations,
    directories[0]!.metrics.directoryEnumerations,
  ]);
});
