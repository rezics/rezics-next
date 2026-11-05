import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { emitHourlyLifecycleMetrics, lifecycleMetrics, readHourlyLifecycleMetrics } from './lifecycle-metrics.ts';
import { openDb } from './db.ts';
import { flowReport, readFlow, readFlowTasks, recordFlow } from './flow.ts';
import { SqliteLandingQueue } from './land.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { WorkerStore } from './store.ts';
import { harness } from './test-support.ts';

const root = join(process.cwd(), '.temp', `lifecycle-metrics-${crypto.randomUUID()}`);
mkdirSync(root, { recursive: true });
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});

function database(name: string): { db: Database; path: string; store: WorkerStore } {
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  const db = openDb(path);
  databases.push(db);
  const store = new WorkerStore(db);
  new SqliteLandingQueue(db, store);
  return { db, path, store };
}

function stamp(now: number, offsetMs = 0): string {
  return new Date(now + offsetMs).toISOString();
}

function insertTask(
  db: Database,
  id: string,
  sequence: number,
  state: string,
  currentAttempt = 1,
  createdAt = '2026-10-01T00:00:00.000Z',
): void {
  db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
    id,
    sequence,
    currentAttempt,
    JSON.stringify({
      id,
      sequence,
      currentAttempt,
      state,
      createdAt,
      brief: { goal: 'fixture', manager: 'fixture', after: [] },
    }),
  );
}

function insertAttempt(db: Database, taskId: string, attempt: number, state: string): void {
  db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)').run(
    taskId,
    attempt,
    JSON.stringify({ taskId, attempt, state, startedAt: '2026-10-01T00:00:00.000Z' }),
  );
}

function insertLandingRequest(db: Database, taskId: string, attempt: number, delivered?: number): void {
  db.query('INSERT INTO worker_events(task_id, attempt, kind, at, body) VALUES (?, ?, ?, ?, ?)').run(
    taskId,
    attempt,
    'landing-requested',
    '2026-10-30T11:00:00.000Z',
    JSON.stringify({ taskId, attempt }),
  );
  if (delivered !== undefined)
    db.query('INSERT INTO landing_queue(task, attempt, request, delivered) VALUES (?, ?, ?, ?)').run(
      taskId,
      attempt,
      JSON.stringify({ taskId, attempt }),
      delivered,
    );
}

test('Hourly report exposes attempts per task per trailing hour, waiting age, orphaned landings, promotion phase age and quarantines with honest unknowns', () => {
  const { db } = database('measures.sqlite');
  const now = Date.UTC(2026, 9, 30, 12, 0);
  const at = (offsetMs: number) => stamp(now, offsetMs);

  insertTask(db, 'repeat', 1, 'running');
  insertAttempt(db, 'repeat', 1, 'running');
  insertTask(db, 'single', 2, 'running');
  insertAttempt(db, 'single', 1, 'running');
  insertTask(db, 'pending-intent', 3, 'ready');
  insertAttempt(db, 'pending-intent', 1, 'pending');
  insertTask(db, 'wait', 4, 'running');
  insertAttempt(db, 'wait', 1, 'waiting');
  insertTask(db, 'unknown-wait-start', 5, 'running');
  insertAttempt(db, 'unknown-wait-start', 1, 'waiting');
  insertTask(db, 'superseded-wait', 6, 'ready', 2);
  insertAttempt(db, 'superseded-wait', 1, 'waiting');
  insertAttempt(db, 'superseded-wait', 2, 'pending');
  insertTask(db, 'orphan', 7, 'landing', 2);
  insertAttempt(db, 'orphan', 2, 'exited');
  insertTask(db, 'queued', 8, 'landing');
  insertAttempt(db, 'queued', 1, 'exited');
  insertTask(db, 'delivered', 9, 'landing');
  insertAttempt(db, 'delivered', 1, 'exited');
  insertTask(db, 'old-request', 10, 'ready', 2);
  insertAttempt(db, 'old-request', 1, 'superseded');
  insertAttempt(db, 'old-request', 2, 'pending');

  recordFlow(db, { taskId: 'repeat', attempt: 1, stage: 'worker', action: 'started', at: at(-60 * 60_000) });
  recordFlow(db, { taskId: 'repeat', attempt: 1, stage: 'worker', action: 'started', at: at(-20 * 60_000) });
  recordFlow(db, { taskId: 'single', attempt: 1, stage: 'worker', action: 'started', at: at(-10 * 60_000) });
  recordFlow(db, { taskId: 'wait', attempt: 1, stage: 'check', action: 'requested', at: at(-25 * 60_000) });
  recordFlow(db, { taskId: 'completed-check', attempt: 1, stage: 'check', action: 'requested', at: at(-20 * 60_000) });
  recordFlow(db, { taskId: 'completed-check', attempt: 1, stage: 'check', action: 'acquired', at: at(-19 * 60_000) });
  recordFlow(db, { taskId: 'completed-check', attempt: 1, stage: 'check', action: 'released', at: at(-18 * 60_000) });
  recordFlow(db, { taskId: 'old-request', attempt: 1, stage: 'check', action: 'requested', at: at(-15 * 60_000) });
  recordFlow(db, { taskId: 'queued', attempt: 1, stage: 'landing', action: 'enqueued', at: at(-22 * 60_000) });
  recordFlow(db, { taskId: 'delivered', attempt: 1, stage: 'landing', action: 'enqueued', at: at(-12 * 60_000) });
  insertLandingRequest(db, 'orphan', 2);
  insertLandingRequest(db, 'queued', 1, 0);
  insertLandingRequest(db, 'delivered', 1, 1);
  insertLandingRequest(db, 'old-request', 1);
  db.query('INSERT INTO worker_promotions(id, body) VALUES (1, ?)').run(
    JSON.stringify({ id: 'prom-1', phase: 'gate-head' }),
  );

  const withoutLifecycleSchema = lifecycleMetrics(db, now);
  expect(withoutLifecycleSchema.attemptsPerTaskPerTrailingHour).toMatchObject({
    total: 3,
    taskCount: 2,
    meanPerTask: 1.5,
    perTask: [
      { taskId: 'repeat', launches: 2, attempts: [1], sameAttemptResumes: 1 },
      { taskId: 'single', launches: 1, attempts: [1], sameAttemptResumes: 0 },
    ],
  });
  expect(withoutLifecycleSchema.waiting.queues).toEqual([
    {
      taskId: 'wait',
      attempt: 1,
      kind: 'queue',
      stage: 'check',
      enteredAt: at(-25 * 60_000),
      ageMs: 25 * 60_000,
    },
    {
      taskId: 'queued',
      attempt: 1,
      kind: 'queue',
      stage: 'landing',
      enteredAt: at(-22 * 60_000),
      ageMs: 22 * 60_000,
    },
  ]);
  expect(withoutLifecycleSchema.waiting.entries.find((entry) => entry.taskId === 'unknown-wait-start')).toMatchObject({
    enteredAt: null,
    ageMs: null,
  });
  expect(withoutLifecycleSchema.waiting.entries.some((entry) => entry.taskId === 'superseded-wait')).toBe(false);
  expect(withoutLifecycleSchema.orphanedLandings).toEqual({
    available: true,
    count: 2,
    taskIds: ['orphan', 'delivered'],
  });
  expect(withoutLifecycleSchema.promotion).toEqual({ available: true, phase: 'gate-head', phaseAgeMs: null });
  expect(withoutLifecycleSchema.quarantines).toMatchObject({
    available: false,
    currentCount: null,
    currentByCause: null,
    recentNewCount: null,
  });

  const noQueuePath = join(root, 'without-landing-queue.sqlite');
  const noQueueDb = openDb(noQueuePath);
  databases.push(noQueueDb);
  new WorkerStore(noQueueDb);
  insertTask(noQueueDb, 'landing-without-queue-schema', 1, 'landing');
  insertLandingRequest(noQueueDb, 'landing-without-queue-schema', 1);
  expect(lifecycleMetrics(noQueueDb, now).orphanedLandings).toEqual({ available: false, count: null, taskIds: [] });

  db.exec(`
    CREATE TABLE lifecycle_transition_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      phase TEXT NOT NULL,
      entered_at TEXT
    );
    CREATE INDEX lifecycle_transition_current ON lifecycle_transition_events(entity, entity_id, attempt, sequence);
    CREATE TABLE lifecycle_quarantines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      cause TEXT NOT NULL,
      quarantined_at TEXT NOT NULL,
      released_at TEXT
    );
  `);
  db.query(
    'INSERT INTO lifecycle_transition_events(entity, entity_id, attempt, phase, entered_at) VALUES (?, ?, ?, ?, ?)',
  ).run('attempt', 'wait', 1, 'waiting', at(-30 * 60_000));
  db.query(
    'INSERT INTO lifecycle_transition_events(entity, entity_id, attempt, phase, entered_at) VALUES (?, ?, ?, ?, ?)',
  ).run('promotion', 'prom-1', 0, 'gate-head', at(-90 * 60_000));
  db.query(
    'INSERT INTO lifecycle_transition_events(entity, entity_id, attempt, phase, entered_at) VALUES (?, ?, ?, ?, ?)',
  ).run('promotion', 'prom-1', 0, 'classify-main', at(-40 * 60_000));
  db.query(
    'INSERT INTO lifecycle_transition_events(entity, entity_id, attempt, phase, entered_at) VALUES (?, ?, ?, ?, ?)',
  ).run('promotion', 'prom-1', 0, 'gate-head', at(-15 * 60_000));
  db.query(
    'INSERT INTO lifecycle_quarantines(task_id, attempt, cause, quarantined_at, released_at) VALUES (?, ?, ?, ?, ?)',
  ).run('old-quarantine', 1, 'old-cause', at(-2 * 60 * 60_000), at(-90 * 60_000));
  db.query(
    'INSERT INTO lifecycle_quarantines(task_id, attempt, cause, quarantined_at, released_at) VALUES (?, ?, ?, ?, ?)',
  ).run('current-quarantine', 2, 'invariant-a', at(-20 * 60_000), null);
  db.query(
    'INSERT INTO lifecycle_quarantines(task_id, attempt, cause, quarantined_at, released_at) VALUES (?, ?, ?, ?, ?)',
  ).run('recent-released', 1, 'recovered', at(-10 * 60_000), at(-5 * 60_000));

  const metrics = lifecycleMetrics(db, now);
  expect(metrics.waiting.entries.find((entry) => entry.taskId === 'wait')).toMatchObject({
    enteredAt: at(-30 * 60_000),
    ageMs: 30 * 60_000,
  });
  expect(metrics.waiting.entries.find((entry) => entry.taskId === 'unknown-wait-start')?.ageMs).toBeNull();
  expect(metrics.promotion).toEqual({ available: true, phase: 'gate-head', phaseAgeMs: 15 * 60_000 });
  expect(metrics.quarantines).toMatchObject({
    available: true,
    currentCount: 1,
    currentByCause: { 'invariant-a': 1 },
    recentNewCount: 2,
    recentNewByCause: { 'invariant-a': 1, recovered: 1 },
  });
});

test('pending queue waits stay identical as settled event history grows', () => {
  const { db } = database('pending-history.sqlite');
  const now = Date.UTC(2026, 9, 30, 12, 0);
  const at = (offsetMs: number) => stamp(now, offsetMs);
  insertTask(db, 'pending', 1, 'running');

  const insertEvent = db.query(
    'INSERT INTO flow_events(task_id, attempt, stage, action, at) VALUES (?, ?, ?, ?, ?)',
  );
  // Insertion order differs from event time; the latest transition is the five-minute-old request.
  insertEvent.run('pending', 1, 'check', 'requested', at(-5 * 60_000));
  insertEvent.run('pending', 1, 'check', 'acquired', at(-15 * 60_000));
  insertEvent.run('pending', 1, 'check', 'requested', at(-25 * 60_000));

  const expected = [
    {
      taskId: 'pending',
      attempt: 1,
      kind: 'queue' as const,
      stage: 'check',
      enteredAt: at(-5 * 60_000),
      ageMs: 5 * 60_000,
    },
  ];
  const before = lifecycleMetrics(db, now).waiting.queues;
  expect(before).toEqual(expected);

  const insertTaskRow = db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
  const insertSettledEvent = db.query(
    'INSERT INTO flow_events(task_id, attempt, stage, action, at) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (let i = 0; i < 3_000; i++) {
      const id = `settled-${i}`;
      insertTaskRow.run(
        id,
        i + 2,
        1,
        JSON.stringify({
          id,
          sequence: i + 2,
          currentAttempt: 1,
          state: 'integrated',
          createdAt: '2026-10-01T00:00:00.000Z',
          brief: { goal: 'fixture', manager: 'fixture', after: [] },
        }),
      );
      insertSettledEvent.run(id, 1, 'check', 'requested', at(-40 * 60_000));
      insertSettledEvent.run(id, 1, 'check', 'acquired', at(-39 * 60_000));
    }
  }).immediate();

  expect(lifecycleMetrics(db, now).waiting.queues).toEqual(before);
});

test('orphaned landings require an undelivered queue record for the current task and attempt, without request events', () => {
  const { db } = database('orphan-identity.sqlite');
  const now = Date.UTC(2026, 9, 30, 12, 0);
  insertTask(db, 'missing-event-and-queue', 1, 'landing');
  insertTask(db, 'delivered-queue', 2, 'landing');
  insertTask(db, 'stale-attempt-queue', 3, 'landing', 2);
  insertTask(db, 'current-queue', 4, 'landing', 2);
  insertTask(db, 'ready-without-queue', 5, 'ready');
  insertTask(db, 'integrated-without-queue', 6, 'integrated');
  const insertQueue = db.query('INSERT INTO landing_queue(task, attempt, request, delivered) VALUES (?, ?, ?, ?)');
  for (const [taskId, attempt, delivered] of [
    ['delivered-queue', 1, 1],
    ['stale-attempt-queue', 1, 0],
    ['current-queue', 2, 0],
  ] as const)
    insertQueue.run(taskId, attempt, JSON.stringify({ taskId, attempt }), delivered);

  expect(db.query('SELECT count(*) AS count FROM worker_events').get()).toEqual({ count: 0 });
  const expected = {
    available: true,
    count: 3,
    taskIds: ['missing-event-and-queue', 'delivered-queue', 'stale-attempt-queue'],
  };
  expect(lifecycleMetrics(db, now).orphanedLandings).toEqual(expected);

  // Request-event schema availability cannot hide tasks whose handoff was never recorded.
  db.exec('DROP TABLE worker_events');
  expect(lifecycleMetrics(db, now).orphanedLandings).toEqual(expected);
});

test('Live-sized settled history does not require decoding all task/attempt JSON on each host sweep and hourly emission is durable/deduplicated', () => {
  const { db, path, store } = database('history.sqlite');
  const insertTaskRow = db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
  const insertAttemptRow = db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)');
  const taskPayload = 't'.repeat(7_500);
  const attemptPayload = 'a'.repeat(8_000);
  db.transaction(() => {
    for (let i = 0; i < 3_000; i++) {
      const id = `settled-${i}`;
      insertTaskRow.run(
        id,
        i,
        2,
        JSON.stringify({
          id,
          sequence: i,
          currentAttempt: 2,
          state: 'integrated',
          createdAt: '2026-10-01T00:00:00.000Z',
          brief: { goal: 'fixture' },
          payload: taskPayload,
        }),
      );
      for (let attempt = 1; attempt <= 1; attempt++)
        insertAttemptRow.run(
          id,
          attempt,
          JSON.stringify({ taskId: id, attempt, state: 'superseded', payload: attemptPayload }),
        );
    }
    for (let i = 0; i < 2_000; i++) {
      const id = `settled-${i}`;
      const attempt = i + 3;
      insertAttemptRow.run(
        id,
        attempt,
        JSON.stringify({ taskId: id, attempt, state: 'cancelled', payload: attemptPayload }),
      );
    }
  }).immediate();

  store.resetDecodedRows();
  const now = new Date('2026-10-30T12:05:00.000Z');
  const metrics = lifecycleMetrics(db, now);
  expect(flowReport(readFlow(db), readFlowTasks(db), now.getTime()).tasks).toHaveLength(3_000);
  expect(store.decodedRows()).toEqual({ tasks: 0, attempts: 0 });
  expect(store.decodedBytes()).toEqual({ tasks: 0, attempts: 0 });
  expect(metrics.attemptsPerTaskPerTrailingHour.total).toBe(0);
  expect(emitHourlyLifecycleMetrics(db, metrics, now)).toBe(true);
  expect(
    emitHourlyLifecycleMetrics(db, { ...metrics, asOf: 'different snapshot' }, new Date('2026-10-30T12:59:00.000Z')),
  ).toBe(false);

  db.close();
  databases.splice(databases.indexOf(db), 1);
  const reopened = openDb(path);
  databases.push(reopened);
  const persisted = readHourlyLifecycleMetrics(reopened, now);
  expect(persisted?.metrics.asOf).toBe(now.toISOString());
  expect(reopened.query('SELECT count(*) AS count FROM lifecycle_metric_emissions').get()).toEqual({ count: 1 });
  expect(emitHourlyLifecycleMetrics(reopened, metrics, new Date('2026-10-30T12:58:00.000Z'))).toBe(false);
}, 30_000);

test('flow report JSON and text include lifecycle measures', async () => {
  const h = harness();
  try {
    const json: string[] = [];
    await runWorkerCommand('report', ['--flow', '--json'], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print: (value) => json.push(value),
      env: {},
    });
    expect(JSON.parse(json[0]!).lifecycle).toMatchObject({
      attemptsPerTaskPerTrailingHour: { total: 0 },
      quarantines: { available: false, currentCount: null },
    });

    const text: string[] = [];
    await runWorkerCommand('report', ['--flow'], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print: (value) => text.push(value),
      env: {},
    });
    expect(text[0]).toContain('Launches in trailing hour: 0');
    expect(text[0]).toContain('Quarantines: current unknown; recent new unknown');
  } finally {
    h.dispose();
  }
});

const conflictContext = { targetHead: 'a'.repeat(40), workerCommit: 'b'.repeat(40), paths: ['source.ts'] };
const sourceBaseline = { workerCommit: 'b'.repeat(40), controllerHead: 'c'.repeat(40) };

function metricEvent(db: Database, taskId: string, attempt: number, at: string, kind: string, body: unknown): void {
  db.query('INSERT INTO worker_events(task_id, attempt, kind, at, body) VALUES (?, ?, ?, ?, ?)').run(
    taskId,
    attempt,
    kind,
    at,
    JSON.stringify(body),
  );
}

test('Hourly report measures conflict count, conflict-to-landed time and attempts caused by conflict truthfully', () => {
  const { db } = database('conflicts.sqlite');
  const now = Date.UTC(2026, 9, 30, 12);
  const at = (minutes: number) => stamp(now, minutes * 60_000);
  const conflict = { passed: false, stage: 'rebase', rebaseConflict: conflictContext };
  for (const [index, id] of ['landed', 'open', 'legacy', 'expired', 'future'].entries())
    insertTask(db, id, index, id === 'landed' ? 'integrated' : 'landing', 3);

  metricEvent(db, 'landed', 1, at(-55), 'gate-outcome', conflict);
  metricEvent(db, 'landed', 1, at(-54), 'gate-outcome', conflict);
  metricEvent(db, 'open', 1, at(-10), 'gate-outcome', conflict);
  metricEvent(db, 'legacy', 1, at(-20), 'gate-outcome', {
    passed: false,
    stage: 'rebase',
    conflictedFiles: ['source.ts'],
  });
  metricEvent(db, 'expired', 1, at(-61), 'gate-outcome', conflict);
  metricEvent(db, 'expired', 1, at(-59), 'gate-outcome', conflict);
  metricEvent(db, 'future', 1, at(1), 'gate-outcome', conflict);
  // Integration is a separate fact, including when a later attempt lands. Neither event identifies the resolver.
  for (const minutes of [-40, -39])
    recordFlow(db, { taskId: 'landed', attempt: 2, stage: 'integration', action: 'integrated', at: at(minutes) });
  // A stale earlier attempt or a future integration cannot close an observed conflict.
  recordFlow(db, { taskId: 'open', attempt: 0, stage: 'integration', action: 'integrated', at: at(-5) });
  recordFlow(db, { taskId: 'open', attempt: 2, stage: 'integration', action: 'integrated', at: at(2) });

  for (const [attempt, minutes] of [
    [1, -60],
    [2, -50],
    [3, -30],
  ] as const) {
    db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)').run(
      'landed',
      attempt,
      JSON.stringify({
        taskId: 'landed',
        attempt,
        state: 'exited',
        startedAt: at(minutes),
        escalation: 'rebase-conflict',
      }),
    );
  }
  metricEvent(db, 'landed', 2, at(-49), 'worker-source-baseline', sourceBaseline);
  metricEvent(db, 'landed', 2, at(-48), 'worker-source-baseline', sourceBaseline);
  // Mutable escalation on the original attempt and a reconciled intent do not prove another creation cause.
  db.query('INSERT INTO worker_retry_intents VALUES (?, ?, ?)').run(
    'landed',
    2,
    JSON.stringify({ status: 'started', nextAttempt: 3, options: { escalation: 'rebase-conflict' } }),
  );
  for (const minutes of [-49, -45])
    recordFlow(db, { taskId: 'landed', attempt: 2, stage: 'worker', action: 'started', at: at(minutes) });

  const metrics = lifecycleMetrics(db, now);
  expect(metrics.conflicts).toMatchObject({
    capability: 'unavailable',
    totalCount: null,
    conflictToLandedMs: { count: null, p50Ms: null, p90Ms: null },
    open: { count: null, oldestAgeMs: null },
    resolutionMethods: { owner: null, rerere: null, replay: null },
    recordedOutcomes: {
      available: true,
      complete: true,
      observedCount: 2,
      unclassifiedCount: 1,
      unknownTimingCount: 0,
      observationToLandedMs: { count: 1, p50Ms: 15 * 60_000, p90Ms: 15 * 60_000 },
      unlandedCount: 1,
      oldestUnlandedObservationAgeMs: 10 * 60_000,
    },
    createdAttempts: { available: true, complete: true, observedCount: 1, unknownCauseCount: 1, totalCount: null },
  });
  expect(emitHourlyLifecycleMetrics(db, metrics, now)).toBe(true);
  metricEvent(db, 'landed', 1, at(-1), 'gate-outcome', conflict);
  expect(lifecycleMetrics(db, now).conflicts).toEqual(metrics.conflicts);
  expect(emitHourlyLifecycleMetrics(db, lifecycleMetrics(db, now), now)).toBe(false);
  expect(readHourlyLifecycleMetrics(db, now)?.metrics.conflicts).toEqual(metrics.conflicts);
});

test('missing conflict sources and historical snapshots remain unavailable instead of acquiring zero counters', () => {
  const { db } = database('historical-conflicts.sqlite');
  const now = Date.UTC(2026, 9, 30, 12);
  const metrics = lifecycleMetrics(db, now);
  expect(metrics.conflicts.totalCount).toBeNull();
  // This is the shape stored before conflict telemetry existed, not a backfilled current snapshot.
  const { conflicts, ...historical } = metrics;
  expect(emitHourlyLifecycleMetrics(db, metrics, now)).toBe(true);
  db.query('UPDATE lifecycle_metric_emissions SET body=?').run(JSON.stringify(historical));
  const old = readHourlyLifecycleMetrics(db, now)!.metrics.conflicts;
  expect(old.reason).toContain('historical snapshot');
  expect(old.recordedOutcomes).toMatchObject({ available: false, observedCount: null, unclassifiedCount: null });
  expect(old.createdAttempts).toMatchObject({ available: false, observedCount: null, totalCount: null });
  insertTask(db, 'unknown-clock', 1, 'landing');
  metricEvent(db, 'unknown-clock', 1, '2026-10-30T11:xx:00.000Z', 'gate-outcome', {
    passed: false,
    stage: 'rebase',
    rebaseConflict: conflictContext,
  });
  expect(lifecycleMetrics(db, now).conflicts.recordedOutcomes).toMatchObject({
    observedCount: 1,
    unknownTimingCount: 1,
    unlandedCount: 1,
    oldestUnlandedObservationAgeMs: null,
  });
  db.exec('DROP TABLE worker_events');
  expect(lifecycleMetrics(db, now).conflicts.recordedOutcomes).toMatchObject({ available: false, observedCount: null });
});

test('an overflowing hourly evidence window reports lower bounds without certifying totals or resolution methods', () => {
  const { db } = database('busy-conflicts.sqlite');
  const now = Date.UTC(2026, 9, 30, 12);
  const at = stamp(now, -30 * 60_000);
  db.transaction(() => {
    for (let i = 0; i < 1_001; i++) {
      const id = `conflict-${i}`;
      insertTask(db, id, i, 'landing', 2);
      metricEvent(db, id, 1, at, 'gate-outcome', { passed: false, stage: 'rebase', rebaseConflict: conflictContext });
      db.query('INSERT INTO worker_attempts VALUES (?, ?, ?)').run(
        id,
        2,
        JSON.stringify({ state: 'exited', startedAt: at }),
      );
      metricEvent(db, id, 2, at, 'worker-source-baseline', sourceBaseline);
    }
  }).immediate();
  const conflicts = lifecycleMetrics(db, now).conflicts;
  expect(conflicts.recordedOutcomes).toMatchObject({ available: true, complete: false, observedCount: 1_000 });
  expect(conflicts.createdAttempts).toMatchObject({
    available: true,
    complete: false,
    observedCount: 1_000,
    totalCount: null,
  });
  expect(conflicts.totalCount).toBeNull();
  expect(conflicts.resolutionMethods).toEqual({ owner: null, rerere: null, replay: null });
});
