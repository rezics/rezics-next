import type { Database } from 'bun:sqlite';
import { migrate } from './db.ts';
import { ensureFlow } from './flow.ts';

const HOUR_MS = 60 * 60_000;

export const lifecycleMetricMigrations = [
  {
    module: 'lifecycle-metrics',
    version: 1,
    sql: `CREATE TABLE lifecycle_metric_emissions (
      hour_bucket TEXT PRIMARY KEY,
      emitted_at TEXT NOT NULL,
      body TEXT NOT NULL
    );`,
  },
] as const;

/**
 * Reader contract for the lifecycle state module when it is installed.
 *
 * `lifecycle_transition_events` records transitions with columns
 * (sequence, entity, entity_id, attempt, phase, entered_at), with an index
 * on (entity, entity_id, attempt, sequence). `entity` is `task`, `attempt`,
 * or `promotion`; `entered_at` may be NULL for imported history whose entry
 * time is unknown. `lifecycle_quarantines` records (task_id, attempt, cause,
 * quarantined_at, released_at), where NULL `released_at` means the quarantine
 * is current. It should index current rows by (released_at, quarantined_at)
 * and recent rows by (quarantined_at).
 *
 * Metrics only read these tables. Their schema and writers remain owned by
 * the lifecycle state module. Missing tables or columns are reported as
 * unavailable, never as zero.
 */
export const LIFECYCLE_RECORD_READER_CONTRACT = {
  transitions: {
    table: 'lifecycle_transition_events',
    columns: ['sequence', 'entity', 'entity_id', 'attempt', 'phase', 'entered_at'],
    index: ['entity', 'entity_id', 'attempt', 'sequence'],
  },
  quarantines: {
    table: 'lifecycle_quarantines',
    columns: ['task_id', 'attempt', 'cause', 'quarantined_at', 'released_at'],
    currentIndex: ['released_at', 'quarantined_at'],
    recentIndex: ['quarantined_at'],
  },
} as const;

export type LifecycleMetricEntry = {
  taskId: string;
  attempt: number;
  kind: 'task' | 'attempt' | 'queue';
  stage?: string;
  enteredAt: string | null;
  ageMs: number | null;
};

export type LifecycleMetrics = {
  /** Time at which the snapshot was read. */
  asOf: string;
  /** Inclusive start and end timestamps for the actual launch window. */
  trailingHour: {
    startsAt: string;
    endsAt: string;
    durationMs: number;
  };
  /** Worker-start flow events are launches; repeated starts of one attempt are reported as resumes. */
  attemptsPerTaskPerTrailingHour: {
    total: number;
    taskCount: number;
    meanPerTask: number | null;
    perTask: {
      taskId: string;
      launches: number;
      attempts: number[];
      sameAttemptResumes: number;
      launchesPerHour: number;
    }[];
  };
  /** Current queue and waiting-state entries; an unknown entry age makes the true oldest age unknown. */
  waiting: {
    count: number;
    oldestAgeMs: number | null;
    oldestKnownAgeMs: number | null;
    unknownAgeCount: number;
    entries: LifecycleMetricEntry[];
    queues: LifecycleMetricEntry[];
  };
  /** Current landing tasks with a landing request and no undelivered request for that exact attempt. */
  orphanedLandings: {
    available: boolean;
    count: number | null;
    taskIds: string[];
  };
  /** Current promotion phase is read from the persisted run; age requires a matching phase-entry event. */
  promotion: {
    available: boolean;
    phase: string | null;
    phaseAgeMs: number | null;
  };
  /** NULL values mean the lifecycle quarantine schema is unavailable, not that no quarantine exists. */
  quarantines: {
    available: boolean;
    currentCount: number | null;
    currentByCause: Record<string, number> | null;
    current: { taskId: string; attempt: number; cause: string; quarantinedAt: string }[] | null;
    recentNewCount: number | null;
    recentNewByCause: Record<string, number> | null;
    recentNew: { taskId: string; attempt: number; cause: string; quarantinedAt: string }[] | null;
  };
};

type SqlRow = Record<string, unknown>;

function dateValue(value: Date | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('lifecycle metrics require a valid time');
  return date;
}

function hasTable(db: Database, name: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function hasColumns(db: Database, table: string, required: readonly string[]): boolean {
  if (!hasTable(db, table)) return false;
  const columns = new Set(
    (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name),
  );
  return required.every((column) => columns.has(column));
}

function age(at: string | null, nowMs: number): number | null {
  if (at === null) return null;
  const entered = Date.parse(at);
  return Number.isFinite(entered) ? Math.max(0, nowMs - entered) : null;
}

function launchCounts(db: Database, start: string, end: string) {
  const rows = db
    .query(`
      SELECT e.task_id, e.attempt, e.at, e.sequence,
             EXISTS (
               SELECT 1 FROM flow_events AS previous
               WHERE previous.task_id = e.task_id
                 AND previous.attempt = e.attempt
                 AND previous.stage = 'worker'
                 AND previous.action = 'started'
                 AND (previous.at < e.at OR (previous.at = e.at AND previous.sequence < e.sequence))
             ) AS resumed
      FROM flow_events AS e INDEXED BY flow_events_launch_window
      WHERE e.stage = 'worker' AND e.action = 'started' AND e.at >= ? AND e.at <= ?
      ORDER BY e.at, e.sequence
    `)
    .all(start, end) as (SqlRow & {
    task_id: string;
    attempt: number;
    at: string;
    sequence: number;
    resumed: number;
  })[];
  const byTask = new Map<string, { attempts: Set<number>; launches: number; resumes: number }>();
  for (const row of rows) {
    const counts = byTask.get(row.task_id) ?? { attempts: new Set<number>(), launches: 0, resumes: 0 };
    counts.attempts.add(row.attempt);
    counts.launches++;
    if (row.resumed) counts.resumes++;
    byTask.set(row.task_id, counts);
  }
  const perTask = [...byTask]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([taskId, counts]) => ({
      taskId,
      launches: counts.launches,
      attempts: [...counts.attempts].sort((a, b) => a - b),
      sameAttemptResumes: counts.resumes,
      launchesPerHour: counts.launches,
    }));
  return {
    total: rows.length,
    taskCount: perTask.length,
    meanPerTask: perTask.length ? rows.length / perTask.length : null,
    perTask,
  };
}

const queueActions: Record<string, { start: string[]; end: string[] }> = {
  start: { start: ['requested'], end: ['started'] },
  check: { start: ['requested'], end: ['acquired', 'released'] },
  landing: { start: ['enqueued'], end: ['started'] },
  verification: { start: ['requested'], end: ['verified'] },
  promotion: { start: ['requested'], end: ['promoted'] },
};

function pendingQueueWaits(db: Database, nowMs: number): LifecycleMetricEntry[] {
  const rows = db
    .query('SELECT task_id, attempt, stage, action, at, sequence FROM flow_events ORDER BY at, sequence')
    .all() as {
    task_id: string;
    attempt: number;
    stage: string;
    action: string;
    at: string;
    sequence: number;
  }[];
  const open = new Map<string, { taskId: string; attempt: number; stage: string; at: string }>();
  for (const row of rows) {
    const actions = queueActions[row.stage];
    if (!actions) continue;
    const key = `${row.task_id}\0${row.attempt}\0${row.stage}`;
    if (actions.start.includes(row.action)) {
      // A repeated request starts the current wait again; it does not leave two pending entries.
      open.set(key, { taskId: row.task_id, attempt: row.attempt, stage: row.stage, at: row.at });
    } else if (actions.end.includes(row.action)) {
      const wait = open.get(key);
      if (wait && row.at >= wait.at) open.delete(key);
    }
  }
  const pending = [...open.values()].filter((wait) => {
    if (!hasTable(db, 'worker_tasks')) return false;
    const current = db
      .query("SELECT current_attempt, json_extract(body, '$.state') AS state FROM worker_tasks WHERE id=?")
      .get(wait.taskId) as { current_attempt: number; state: string } | null;
    if (
      !current ||
      current.current_attempt !== wait.attempt ||
      ['integrated', 'merged', 'stopped', 'cancelled'].includes(current.state)
    )
      return false;
    if (wait.stage === 'landing' && hasTable(db, 'landing_queue')) {
      const queue = db
        .query('SELECT delivered FROM landing_queue WHERE task=? AND attempt=?')
        .get(wait.taskId, wait.attempt) as { delivered: number } | null;
      if (queue?.delivered === 1) return false;
    }
    return true;
  });
  return pending
    .map((wait) => ({
      taskId: wait.taskId,
      attempt: wait.attempt,
      kind: 'queue' as const,
      stage: wait.stage,
      enteredAt: wait.at,
      ageMs: age(wait.at, nowMs),
    }))
    .sort((a, b) => (a.enteredAt ?? '').localeCompare(b.enteredAt ?? '') || a.taskId.localeCompare(b.taskId));
}

function currentStateWaits(db: Database, nowMs: number, hasTransitions: boolean): LifecycleMetricEntry[] {
  if (!hasTable(db, 'worker_tasks') || !hasTable(db, 'worker_attempts')) return [];
  const rows = db
    .query(`
      SELECT a.task_id, a.attempt, 'attempt' AS kind
      FROM worker_attempts AS a
      JOIN worker_tasks AS t ON t.id = a.task_id AND t.current_attempt = a.attempt
      WHERE json_extract(a.body, '$.state') = 'waiting'
        AND json_extract(t.body, '$.state') NOT IN ('integrated', 'merged', 'stopped', 'cancelled')
      UNION ALL
      SELECT t.id AS task_id, t.current_attempt AS attempt, 'task' AS kind
      FROM worker_tasks AS t
      WHERE json_extract(t.body, '$.state') = 'waiting'
    `)
    .all() as { task_id: string; attempt: number; kind: 'task' | 'attempt' }[];
  return rows.map((row) => {
    let enteredAt: string | null = null;
    if (hasTransitions) {
      const transition = db
        .query(`
          SELECT phase, entered_at FROM lifecycle_transition_events
          WHERE entity=? AND entity_id=? AND attempt=? ORDER BY sequence DESC LIMIT 1
        `)
        .get(row.kind, row.task_id, row.attempt) as { phase: string; entered_at: string | null } | null;
      if (transition?.phase === 'waiting') enteredAt = transition.entered_at;
    }
    return {
      taskId: row.task_id,
      attempt: row.attempt,
      kind: row.kind,
      enteredAt,
      ageMs: age(enteredAt, nowMs),
    };
  });
}

function orphanedLandings(db: Database): LifecycleMetrics['orphanedLandings'] {
  if (
    !hasTable(db, 'worker_tasks') ||
    !hasTable(db, 'worker_events') ||
    !hasTable(db, 'landing_queue')
  )
    return { available: false, count: null, taskIds: [] };
  const taskIds = (
    db
      .query(`
        SELECT t.id
        FROM worker_tasks AS t
        WHERE json_extract(t.body, '$.state') = 'landing'
          AND t.current_attempt > 0
          AND EXISTS (
            SELECT 1 FROM worker_events AS e
            WHERE e.task_id=t.id AND e.attempt=t.current_attempt AND e.kind='landing-requested'
          )
          AND NOT EXISTS (
            SELECT 1 FROM landing_queue AS l
            WHERE l.task=t.id AND l.attempt=t.current_attempt AND l.delivered=0
          )
        ORDER BY t.sequence
      `)
      .all() as { id: string }[]
  ).map((row) => row.id);
  return { available: true, count: taskIds.length, taskIds };
}

function promotionPhase(db: Database, nowMs: number, hasTransitions: boolean): LifecycleMetrics['promotion'] {
  if (!hasTable(db, 'worker_promotions')) return { available: false, phase: null, phaseAgeMs: null };
  const row = db
    .query("SELECT json_extract(body, '$.id') AS promotion_id, json_extract(body, '$.phase') AS phase FROM worker_promotions WHERE id=1")
    .get() as { promotion_id: string | null; phase: string | null } | null;
  if (!row) return { available: true, phase: null, phaseAgeMs: null };
  if (!row.phase || !row.promotion_id || !hasTransitions)
    return { available: true, phase: row.phase, phaseAgeMs: null };
  const transition = db
    .query(`
      SELECT phase, entered_at FROM lifecycle_transition_events
      WHERE entity='promotion' AND entity_id=? AND attempt=0 ORDER BY sequence DESC LIMIT 1
    `)
    .get(row.promotion_id) as { phase: string; entered_at: string | null } | null;
  if (!transition || transition.phase !== row.phase)
    return { available: true, phase: row.phase, phaseAgeMs: null };
  return { available: true, phase: row.phase, phaseAgeMs: age(transition.entered_at, nowMs) };
}

function byCause(rows: { cause: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.cause] = (counts[row.cause] ?? 0) + 1;
  return counts;
}

function quarantines(db: Database, now: Date, start: Date): LifecycleMetrics['quarantines'] {
  if (
    !hasColumns(db, 'lifecycle_quarantines', LIFECYCLE_RECORD_READER_CONTRACT.quarantines.columns)
  )
    return {
      available: false,
      currentCount: null,
      currentByCause: null,
      current: null,
      recentNewCount: null,
      recentNewByCause: null,
      recentNew: null,
    };
  const select = `SELECT task_id, attempt, cause, quarantined_at FROM lifecycle_quarantines`;
  const current = db
    .query(`${select} WHERE released_at IS NULL AND quarantined_at <= ? ORDER BY quarantined_at, task_id, attempt`)
    .all(now.toISOString()) as {
    task_id: string;
    attempt: number;
    cause: string;
    quarantined_at: string;
  }[];
  const recentNew = db
    .query(`${select} WHERE quarantined_at >= ? AND quarantined_at <= ? ORDER BY quarantined_at, task_id, attempt`)
    .all(start.toISOString(), now.toISOString()) as typeof current;
  const records = (rows: typeof current) =>
    rows.map((row) => ({
      taskId: row.task_id,
      attempt: row.attempt,
      cause: row.cause,
      quarantinedAt: row.quarantined_at,
    }));
  return {
    available: true,
    currentCount: current.length,
    currentByCause: byCause(current),
    current: records(current),
    recentNewCount: recentNew.length,
    recentNewByCause: byCause(recentNew),
    recentNew: records(recentNew),
  };
}

/** Read hourly lifecycle measurements using durable launch, queue, task and quarantine records. */
export function lifecycleMetrics(db: Database, at: Date | number = new Date()): LifecycleMetrics {
  const now = dateValue(at);
  const nowMs = now.getTime();
  const start = new Date(nowMs - HOUR_MS);
  ensureFlow(db);
  const hasTransitions = hasColumns(
    db,
    LIFECYCLE_RECORD_READER_CONTRACT.transitions.table,
    LIFECYCLE_RECORD_READER_CONTRACT.transitions.columns,
  );
  const queues = pendingQueueWaits(db, nowMs);
  const stateWaits = currentStateWaits(db, nowMs, hasTransitions);
  const entries = [...stateWaits, ...queues].sort((a, b) => {
    const aAt = a.enteredAt ? Date.parse(a.enteredAt) : Number.NEGATIVE_INFINITY;
    const bAt = b.enteredAt ? Date.parse(b.enteredAt) : Number.NEGATIVE_INFINITY;
    return aAt - bAt || a.taskId.localeCompare(b.taskId) || a.kind.localeCompare(b.kind);
  });
  const knownAges = entries.flatMap((entry) => (entry.ageMs === null ? [] : [entry.ageMs]));
  const unknownAgeCount = entries.length - knownAges.length;
  return {
    asOf: now.toISOString(),
    trailingHour: { startsAt: start.toISOString(), endsAt: now.toISOString(), durationMs: HOUR_MS },
    attemptsPerTaskPerTrailingHour: launchCounts(db, start.toISOString(), now.toISOString()),
    waiting: {
      count: entries.length,
      oldestAgeMs: unknownAgeCount ? null : Math.max(0, ...knownAges),
      oldestKnownAgeMs: knownAges.length ? Math.max(...knownAges) : null,
      unknownAgeCount,
      entries,
      queues,
    },
    orphanedLandings: orphanedLandings(db),
    promotion: promotionPhase(db, nowMs, hasTransitions),
    quarantines: quarantines(db, now, start),
  };
}

function hourBucket(at: Date): string {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS).toISOString();
}

/** Persist one complete metric snapshot per UTC hour. This is an audit row, not a manager wake alert. */
export function emitHourlyLifecycleMetrics(db: Database, metrics: LifecycleMetrics, at: Date | number = new Date()): boolean {
  const now = dateValue(at);
  migrate(db, lifecycleMetricMigrations);
  const result = db
    .query('INSERT OR IGNORE INTO lifecycle_metric_emissions(hour_bucket, emitted_at, body) VALUES (?, ?, ?)')
    .run(hourBucket(now), now.toISOString(), JSON.stringify(metrics));
  return result.changes > 0;
}

/** Read a persisted UTC-hour snapshot, primarily for audit and regression checks. */
export function readHourlyLifecycleMetrics(
  db: Database,
  bucket: Date | number,
): { hourBucket: string; emittedAt: string; metrics: LifecycleMetrics } | null {
  migrate(db, lifecycleMetricMigrations);
  const row = db
    .query('SELECT hour_bucket, emitted_at, body FROM lifecycle_metric_emissions WHERE hour_bucket=?')
    .get(hourBucket(dateValue(bucket))) as { hour_bucket: string; emitted_at: string; body: string } | null;
  return row
    ? { hourBucket: row.hour_bucket, emittedAt: row.emitted_at, metrics: JSON.parse(row.body) as LifecycleMetrics }
    : null;
}
