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
import { formatLifecycleMetrics } from './report.ts';

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

function createTransitionTable(db: Database): void {
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
  `);
}

function insertTransition(
  db: Database,
  entity: 'task' | 'attempt' | 'promotion',
  entityId: string,
  attempt: number,
  phase: string,
  enteredAt: string | null,
): void {
  db.query(
    'INSERT INTO lifecycle_transition_events(entity, entity_id, attempt, phase, entered_at) VALUES (?, ?, ?, ?, ?)',
  ).run(entity, entityId, attempt, phase, enteredAt);
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

function countedDatabase(db: Database) {
  const counts = {
    schemaReads: 0,
    columnReads: 0,
    landingReads: 0,
    landingSetReads: 0,
    queryCalls: 0,
    currentWaitReads: 0,
  };
  const currentWaitQueries: string[] = [];
  const counted = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'query') return typeof value === 'function' ? value.bind(target) : value;
      return (sql: string) => {
        const normalized = sql.toLowerCase();
        counts.queryCalls++;
        if (normalized.includes('with current_waits as')) {
          counts.currentWaitReads++;
          currentWaitQueries.push(sql);
        }
        if (normalized.includes('from sqlite_master')) counts.schemaReads++;
        if (normalized.startsWith('pragma table_info')) counts.columnReads++;
        if (normalized.includes('landing_queue') && normalized.includes('delivered')) counts.landingReads++;
        if (normalized.includes('json_each') && normalized.includes('landing_queue')) counts.landingSetReads++;
        return value.call(target, sql);
      };
    },
  }) as Database;
  return {
    db: counted,
    counts,
    currentWaitQueries,
    reset: () => {
      counts.schemaReads = 0;
      counts.columnReads = 0;
      counts.landingReads = 0;
      counts.landingSetReads = 0;
      counts.queryCalls = 0;
      counts.currentWaitReads = 0;
      currentWaitQueries.length = 0;
    },
  };
}

test('Hourly report exposes attempts per task per trailing hour, waiting age, orphaned landings, promotion phase age and quarantines with honest unknowns', () => {
  const { db } = database('measures.sqlite');
  const now = Date.UTC(2026, 9, 30, 12, 0);
  const at = (offsetMs: number) => stamp(now, offsetMs);
  db.query(
    `INSERT INTO landing_operations(operation_id,queue_id,task_id,attempt,enqueued_at,started_at,terminal_at,terminal_action,terminal_outcome)
     VALUES ('trailing-hour', 1, 'timed-landing', 1, ?, ?, ?, 'finished', '{}')`,
  ).run(at(-35 * 60_000), at(-30 * 60_000), at(-10 * 60_000));
  db.query(
    `INSERT INTO landing_operations(operation_id,queue_id,task_id,attempt,enqueued_at,started_at,terminal_at,terminal_action,terminal_outcome)
     VALUES ('at-cutoff', 2, 'cutoff-landing', 1, ?, ?, ?, 'finished', '{}')`,
  ).run(at(-5 * 60_000), at(-2 * 60_000), at(0));

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
  for (const [sequence, id, taskState] of [
    [11, 'dual', 'waiting'],
    [12, 'terminal-wait', 'integrated'],
    [13, 'latest-nonwaiting', 'running'],
    [14, 'null-wait', 'running'],
    [15, 'invalid-wait', 'running'],
    [16, 'future-wait', 'running'],
  ] as const) {
    insertTask(db, id, sequence, taskState);
    insertAttempt(db, id, 1, 'waiting');
  }
  insertTask(db, 'attempt-two', 17, 'running', 2);
  insertAttempt(db, 'attempt-two', 1, 'waiting');
  insertAttempt(db, 'attempt-two', 2, 'waiting');
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
  expect(withoutLifecycleSchema.landingOperations).toMatchObject({
    terminalCount: 1,
    measuredCount: 1,
    unknownDurationCount: 0,
    totalDurationMs: 1_200_000,
    p50DurationMs: 1_200_000,
  });
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
  expect(withoutLifecycleSchema.waiting).toMatchObject({
    count: 11,
    oldestAgeMs: null,
    oldestKnownAgeMs: 25 * 60_000,
    unknownAgeCount: 9,
  });
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
  recordFlow(noQueueDb, {
    taskId: 'landing-without-queue-schema',
    attempt: 1,
    stage: 'landing',
    action: 'enqueued',
    at: stamp(now, -60_000),
  });
  const beforeQueueSchema = lifecycleMetrics(noQueueDb, now);
  expect(beforeQueueSchema.orphanedLandings).toEqual({ available: false, count: null, taskIds: [] });
  expect(beforeQueueSchema.waiting.queues).toHaveLength(1);
  noQueueDb.exec(`
    CREATE TABLE landing_queue (
      task TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      request TEXT NOT NULL,
      delivered INTEGER NOT NULL,
      PRIMARY KEY (task, attempt)
    )
  `);
  noQueueDb
    .query('INSERT INTO landing_queue(task, attempt, request, delivered) VALUES (?, ?, ?, ?)')
    .run('landing-without-queue-schema', 1, '{}', 1);
  const afterQueueSchema = lifecycleMetrics(noQueueDb, now);
  expect(afterQueueSchema.orphanedLandings).toEqual({
    available: true,
    count: 1,
    taskIds: ['landing-without-queue-schema'],
  });
  expect(afterQueueSchema.waiting.queues).toEqual([]);

  createTransitionTable(db);
  db.exec(`
    CREATE TABLE lifecycle_quarantines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      cause TEXT NOT NULL,
      quarantined_at TEXT NOT NULL,
      released_at TEXT
    );
  `);
  insertTransition(db, 'attempt', 'wait', 1, 'waiting', at(-30 * 60_000));
  insertTransition(db, 'task', 'dual', 1, 'waiting', at(-5 * 60_000));
  insertTransition(db, 'task', 'dual', 1, 'waiting', at(-20 * 60_000));
  insertTransition(db, 'attempt', 'dual', 1, 'waiting', at(-12 * 60_000));
  insertTransition(db, 'attempt', 'latest-nonwaiting', 1, 'waiting', at(-50 * 60_000));
  insertTransition(db, 'attempt', 'latest-nonwaiting', 1, 'running', at(-40 * 60_000));
  insertTransition(db, 'attempt', 'null-wait', 1, 'waiting', null);
  insertTransition(db, 'attempt', 'invalid-wait', 1, 'waiting', 'not-a-date');
  insertTransition(db, 'attempt', 'future-wait', 1, 'waiting', at(5 * 60_000));
  insertTransition(db, 'attempt', 'attempt-two', 1, 'waiting', at(-45 * 60_000));
  insertTransition(db, 'attempt', 'attempt-two', 2, 'waiting', at(-6 * 60_000));
  insertTransition(db, 'promotion', 'prom-1', 0, 'gate-head', at(-90 * 60_000));
  insertTransition(db, 'promotion', 'prom-1', 0, 'classify-main', at(-40 * 60_000));
  insertTransition(db, 'promotion', 'prom-1', 0, 'gate-head', at(-15 * 60_000));
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
  expect(metrics.waiting).toMatchObject({
    count: 11,
    oldestAgeMs: null,
    oldestKnownAgeMs: 30 * 60_000,
    unknownAgeCount: 4,
  });
  expect(metrics.waiting.entries.find((entry) => entry.taskId === 'attempt-two')).toMatchObject({
    attempt: 2,
    enteredAt: at(-6 * 60_000),
    ageMs: 6 * 60_000,
  });
  expect(metrics.waiting.entries.find((entry) => entry.taskId === 'dual' && entry.kind === 'task')).toMatchObject({
    enteredAt: at(-20 * 60_000),
    ageMs: 20 * 60_000,
  });
  expect(metrics.waiting.entries.find((entry) => entry.taskId === 'dual' && entry.kind === 'attempt')).toMatchObject({
    enteredAt: at(-12 * 60_000),
    ageMs: 12 * 60_000,
  });
  expect(metrics.waiting.entries.find((entry) => entry.taskId === 'latest-nonwaiting')).toMatchObject({
    enteredAt: null,
    ageMs: null,
  });
  expect(metrics.waiting.entries.find((entry) => entry.taskId === 'null-wait')).toMatchObject({
    enteredAt: null,
    ageMs: null,
  });
  expect(metrics.waiting.entries.find((entry) => entry.taskId === 'invalid-wait')).toMatchObject({
    enteredAt: 'not-a-date',
    ageMs: null,
  });
  expect(metrics.waiting.entries.find((entry) => entry.taskId === 'future-wait')).toMatchObject({
    enteredAt: at(5 * 60_000),
    ageMs: 0,
  });
  expect(metrics.waiting.entries.some((entry) => ['superseded-wait', 'terminal-wait'].includes(entry.taskId))).toBe(
    false,
  );
  expect(formatLifecycleMetrics(metrics)).toContain('Current waits: 11; oldest age unknown; unknown ages 4.');
  expect(metrics.waiting.entries.find((entry) => entry.taskId === 'unknown-wait-start')?.ageMs).toBeNull();
  expect(metrics.promotion).toEqual({ available: true, phase: 'gate-head', phaseAgeMs: 15 * 60_000 });
  expect(metrics.quarantines).toMatchObject({
    available: true,
    currentCount: 1,
    currentByCause: { 'invariant-a': 1 },
    recentNewCount: 2,
    recentNewByCause: { 'invariant-a': 1, recovered: 1 },
  });
  insertTransition(db, 'attempt', 'unknown-wait-start', 1, 'waiting', at(-7 * 60_000));
  expect(
    lifecycleMetrics(db, now).waiting.entries.find((entry) => entry.taskId === 'unknown-wait-start'),
  ).toMatchObject({
    enteredAt: at(-7 * 60_000),
    ageMs: 7 * 60_000,
  });
});

test('pending queue waits stay identical as settled event history grows', () => {
  const { db } = database('pending-history.sqlite');
  const now = Date.UTC(2026, 9, 30, 12, 0);
  const at = (offsetMs: number) => stamp(now, offsetMs);
  insertTask(db, 'pending', 1, 'running');

  const insertEvent = db.query('INSERT INTO flow_events(task_id, attempt, stage, action, at) VALUES (?, ?, ?, ?, ?)');
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

test('current-state waits use one indexed latest-transition projection as the cohort and old history grow', () => {
  const { db } = database('state-wait-cohort.sqlite');
  const now = Date.UTC(2026, 9, 30, 12, 0);
  const at = (offsetMs: number) => stamp(now, offsetMs);
  createTransitionTable(db);
  insertTask(db, 'current-0', 1, 'running');
  insertAttempt(db, 'current-0', 1, 'waiting');
  insertTransition(db, 'attempt', 'current-0', 1, 'waiting', at(-5 * 60_000));

  const tracked = countedDatabase(db);
  tracked.reset();
  const one = lifecycleMetrics(tracked.db, now);
  const oneStatementCount = tracked.counts.queryCalls;
  expect(one.waiting.count).toBe(1);
  expect(tracked.counts.currentWaitReads).toBe(1);

  for (let index = 1; index <= 20; index++) {
    const id = `current-${index}`;
    insertTask(db, id, index + 1, 'running');
    insertAttempt(db, id, 1, 'waiting');
    insertTransition(db, 'attempt', id, 1, 'waiting', at(-index * 60_000));
  }
  tracked.reset();
  const many = lifecycleMetrics(tracked.db, now);
  const manyStatementCount = tracked.counts.queryCalls;
  expect(many.waiting.count).toBe(21);
  expect(manyStatementCount).toBe(oneStatementCount);
  expect(tracked.counts.currentWaitReads).toBe(1);

  const insertOld = db.query(
    'INSERT INTO lifecycle_transition_events(entity, entity_id, attempt, phase, entered_at) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    for (let index = 0; index < 3_000; index++)
      insertOld.run('attempt', `settled-${index}`, 1, 'exited', at(-2 * 60 * 60_000));
  }).immediate();
  tracked.reset();
  expect(lifecycleMetrics(tracked.db, now).waiting).toEqual(many.waiting);
  expect(tracked.counts.queryCalls).toBe(manyStatementCount);
  const query = tracked.currentWaitQueries[0]!;
  const plan = db.query(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[];
  expect(
    plan.some(
      ({ detail }) =>
        detail.includes('SEARCH candidate USING COVERING INDEX lifecycle_transition_current') &&
        detail.includes('entity=? AND entity_id=? AND attempt=?'),
    ),
  ).toBe(true);
});

test('pending landing delivery reads stay set-based as current queue waits grow', () => {
  const { db } = database('landing-cohort.sqlite');
  const now = Date.UTC(2026, 9, 30, 12, 0);
  const at = stamp(now, -5 * 60_000);
  const tracked = countedDatabase(db);
  lifecycleMetrics(tracked.db, now);

  const insertEvent = db.query('INSERT INTO flow_events(task_id, attempt, stage, action, at) VALUES (?, ?, ?, ?, ?)');
  const insertQueue = db.query('INSERT INTO landing_queue(task, attempt, request, delivered) VALUES (?, ?, ?, ?)');
  let sequence = 1;
  const addLanding = (id: string, delivered: number | null, queueAttempt = 1) => {
    insertTask(db, id, sequence++, 'landing');
    insertEvent.run(id, 1, 'landing', 'enqueued', at);
    if (delivered !== null) insertQueue.run(id, queueAttempt, '{}', delivered);
  };
  addLanding('landing-00', 0);

  tracked.reset();
  const one = lifecycleMetrics(tracked.db, now);
  const oneCounts = { ...tracked.counts };
  expect(one.waiting.queues.map((entry) => entry.taskId)).toEqual(['landing-00']);

  for (let index = 1; index <= 20; index++) {
    const id = `landing-${String(index).padStart(2, '0')}`;
    if (index === 5) addLanding(id, 1);
    else if (index === 6) addLanding(id, 1, 2);
    else if (index === 10) addLanding(id, null);
    else addLanding(id, 0);
  }

  tracked.reset();
  const many = lifecycleMetrics(tracked.db, now);
  const expectedIds = Array.from({ length: 20 }, (_, index) => index + 1)
    .filter((index) => index !== 5)
    .map((index) => `landing-${String(index).padStart(2, '0')}`)
    .concat('landing-00')
    .sort();
  expect(many.waiting.queues.map((entry) => entry.taskId)).toEqual(expectedIds);
  expect(many.waiting.queues.find((entry) => entry.taskId === 'landing-00')).toEqual(one.waiting.queues[0]);
  expect(tracked.counts).toEqual(oneCounts);
  expect(tracked.counts.landingSetReads).toBe(1);
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
  const insertSettledEvent = db.query(
    'INSERT INTO worker_events(task_id, attempt, kind, at, body) VALUES (?, ?, ?, ?, ?)',
  );
  const insertSettledFlow = db.query(
    'INSERT INTO flow_events(task_id, attempt, stage, action, at) VALUES (?, ?, ?, ?, ?)',
  );
  const taskPayload = 't'.repeat(7_500);
  const attemptPayload = 'a'.repeat(8_000);
  const now = new Date('2026-10-30T12:05:00.000Z');
  const conflictBaseline = lifecycleMetrics(db, now).conflicts;
  const settledAt = '2026-10-29T12:00:00.000Z';
  const settledConflict = JSON.stringify({
    passed: false,
    stage: 'rebase',
    rebaseConflict: { targetHead: 'a'.repeat(40), workerCommit: 'b'.repeat(40), paths: ['source.ts'] },
  });
  const settledBaseline = JSON.stringify({ workerCommit: 'b'.repeat(40), controllerHead: 'c'.repeat(40) });
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
      insertSettledEvent.run(id, 1, 'gate-outcome', settledAt, settledConflict);
      insertSettledEvent.run(id, 2, 'worker-source-baseline', settledAt, settledBaseline);
      insertSettledFlow.run(id, 2, 'integration', 'integrated', settledAt);
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
  const metrics = lifecycleMetrics(db, now);
  expect(metrics.conflicts).toEqual(conflictBaseline);
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

    const start = '2026-10-30T11:00:00.000Z';
    const end = '2026-10-30T12:00:00.000Z';
    recordFlow(h.store.db, { taskId: 'bounded', attempt: 1, stage: 'landing', action: 'enqueued', at: start });
    recordFlow(h.store.db, { taskId: 'future', attempt: 1, stage: 'integration', action: 'integrated', at: end });
    recordFlow(h.store.db, { taskId: 'future', attempt: 1, stage: 'chain', action: 'offered', at: end });
    const boundedJson: string[] = [];
    await runWorkerCommand('report', ['--flow', '--since', start, '--until', end, '--json'], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print: (value) => boundedJson.push(value),
      env: {},
    });
    const bounded = JSON.parse(boundedJson[0]!);
    expect(bounded.window).toMatchObject({ since: start, until: end, startInclusive: true, endExclusive: true });
    expect(bounded.chain.offered).toBe(0);
    expect(bounded.urgent.integrated).toBe(0);
    expect(bounded.queues).toEqual([]);
    expect(bounded).not.toHaveProperty('lifecycle');
    expect(bounded).not.toHaveProperty('guards');
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

test('flow metrics classify dev resolver conflicts by landed, returned with reason and in-progress outcomes', () => {
  const { db } = database('dev-resolver-outcomes.sqlite');
  const now = Date.UTC(2026, 9, 30, 12);
  const at = (minutes: number) => stamp(now, minutes * 60_000);
  const started = (taskId: string, sourceCommit: string) =>
    recordFlow(db, {
      taskId,
      attempt: 1,
      stage: 'landing',
      action: 'dev-conflict',
      at: at(-10),
      detail: JSON.stringify({ sourceCommit, targetHead: 'd'.repeat(40), paths: ['source.ts'] }),
    });
  started('landed-dev-conflict', 'a'.repeat(40));
  recordFlow(db, {
    taskId: 'landed-dev-conflict',
    attempt: 1,
    stage: 'landing',
    action: 'dev-conflict-landed',
    at: at(-1),
    detail: JSON.stringify({ sourceCommit: 'a'.repeat(40), commit: 'b'.repeat(40) }),
  });
  started('returned-dev-conflict', 'c'.repeat(40));
  recordFlow(db, {
    taskId: 'returned-dev-conflict',
    attempt: 1,
    stage: 'landing',
    action: 'dev-conflict-returned',
    at: at(-2),
    detail: JSON.stringify({
      sourceCommit: 'c'.repeat(40),
      reason: 'Train resolver attempt bound reached (2)',
    }),
  });
  started('active-dev-conflict', 'e'.repeat(40));

  const metrics = lifecycleMetrics(db, now);
  expect(metrics.conflicts.devResolverOutcomes).toEqual({
    available: true,
    complete: true,
    resolvedAndLanded: 1,
    returnedToWorker: {
      count: 1,
      reasons: [{ reason: 'Train resolver attempt bound reached (2)', count: 1 }],
    },
    inProgress: 1,
  });
  expect(formatLifecycleMetrics(metrics).join('\n')).toContain(
    'Dev resolver conflicts in trailing hour: 1 resolved and landed; 1 returned to worker (reasons: 1 × Train resolver attempt bound reached (2)); 1 still in progress; complete recorded window.',
  );
});

test('missing conflict sources and historical snapshots remain unavailable instead of acquiring zero counters', () => {
  const { db } = database('historical-conflicts.sqlite');
  const now = Date.UTC(2026, 9, 30, 12);
  const metrics = lifecycleMetrics(db, now);
  expect(metrics.conflicts.totalCount).toBeNull();
  // This is the shape stored before conflict telemetry existed, not a backfilled current snapshot.
  const historical = { ...metrics } as Partial<typeof metrics>;
  delete historical.conflicts;
  delete historical.landingOperations;
  expect(emitHourlyLifecycleMetrics(db, metrics, now)).toBe(true);
  db.query('UPDATE lifecycle_metric_emissions SET body=?').run(JSON.stringify(historical));
  const old = readHourlyLifecycleMetrics(db, now)!.metrics.conflicts;
  expect(old.reason).toContain('historical snapshot');
  expect(old.recordedOutcomes).toMatchObject({ available: false, observedCount: null, unclassifiedCount: null });
  expect(old.createdAttempts).toMatchObject({ available: false, observedCount: null, totalCount: null });
  expect(readHourlyLifecycleMetrics(db, now)!.metrics.landingOperations).toMatchObject({
    terminalCount: null,
    measuredCount: null,
    unknownDurationCount: null,
  });
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
