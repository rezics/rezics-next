import type { Database } from 'bun:sqlite';
import { migrate } from './db.ts';
import type { Task } from './types.ts';

export const FLOW_STAGES = [
  'dispatch',
  'start',
  'check',
  'worker',
  'landing',
  'dev-update',
  'verification',
  'integration',
  'promotion',
] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];
export type FlowEvent = {
  taskId: string;
  attempt: number;
  stage: FlowStage;
  action: string;
  at: string;
  detail?: string;
};
export const flowMigrations = [
  {
    module: 'flow',
    version: 1,
    sql: `CREATE TABLE flow_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, stage TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, detail TEXT); CREATE INDEX flow_events_task ON flow_events(task_id, attempt, sequence); CREATE TABLE flow_alarm_sends (threshold TEXT PRIMARY KEY, sent_at TEXT NOT NULL); CREATE TABLE flow_audit_runs (day TEXT PRIMARY KEY, task_id TEXT NOT NULL);`,
  },
  {
    module: 'flow',
    version: 2,
    sql: `CREATE INDEX flow_events_launch_window ON flow_events(stage, action, at, task_id, attempt);`,
  },
  {
    module: 'flow',
    version: 3,
    sql: `CREATE TABLE flow_audit_failures (day TEXT PRIMARY KEY, failed_at TEXT NOT NULL, cause TEXT NOT NULL, reported_at TEXT);`,
  },
  {
    module: 'flow',
    version: 4,
    sql: `CREATE INDEX flow_events_at_window ON flow_events(at, sequence);`,
  },
];
export function ensureFlow(db: Database): void {
  migrate(db, flowMigrations);
}
export function recordFlow(db: Database, event: FlowEvent): void {
  ensureFlow(db);
  db.query('INSERT INTO flow_events(task_id,attempt,stage,action,at,detail) VALUES (?,?,?,?,?,?)').run(
    event.taskId,
    event.attempt,
    event.stage,
    event.action,
    event.at,
    event.detail ?? null,
  );
}
export function readFlow(db: Database, since = '0000-01-01T00:00:00.000Z'): FlowEvent[] {
  ensureFlow(db);
  return (
    db
      .query('SELECT task_id,attempt,stage,action,at,detail FROM flow_events WHERE at >= ? ORDER BY at,sequence')
      .all(since) as any[]
  ).map((r) => ({
    taskId: r.task_id,
    attempt: r.attempt,
    stage: r.stage,
    action: r.action,
    at: r.at,
    ...(r.detail === null ? {} : { detail: r.detail }),
  }));
}

const percentile = (values: number[], p: number): number | null =>
  values.length ? values[Math.ceil(p * values.length) - 1]! : null;
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: sorted.reduce((x, y) => x + y, 0),
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
  };
};
const startActions: Record<FlowStage, string[]> = {
  dispatch: ['dispatched'],
  start: ['requested'],
  check: ['requested'],
  worker: ['started'],
  landing: ['enqueued'],
  'dev-update': ['requested'],
  verification: ['requested'],
  integration: ['requested'],
  promotion: ['requested'],
};
const endActions: Record<FlowStage, string[]> = {
  dispatch: ['started'],
  start: ['started'],
  check: ['released'],
  worker: ['finished'],
  landing: ['finished'],
  'dev-update': ['updated'],
  verification: ['verified'],
  integration: ['integrated'],
  promotion: ['promoted'],
};
function attemptIntervals(
  events: FlowEvent[],
  stage: FlowStage,
  starts: string[],
  ends: string[],
): {
  durations: number[];
  durationsByAttempt: Map<number, number>;
  observed: boolean;
  incomplete: boolean;
} {
  const open = new Map<number, number>();
  const durations: number[] = [];
  const durationsByAttempt = new Map<number, number>();
  let observed = false;
  let incomplete = false;
  for (const event of events) {
    if (event.stage !== stage) continue;
    if (starts.includes(event.action)) {
      observed = true;
      if (open.has(event.attempt)) incomplete = true;
      open.set(event.attempt, Date.parse(event.at));
      continue;
    }
    if (event.action === 'closed') {
      if (open.delete(event.attempt)) incomplete = true;
      continue;
    }
    if (!ends.includes(event.action) || !open.has(event.attempt)) continue;
    const start = open.get(event.attempt)!;
    open.delete(event.attempt);
    const end = Date.parse(event.at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      const duration = end - start;
      durations.push(duration);
      durationsByAttempt.set(event.attempt, (durationsByAttempt.get(event.attempt) ?? 0) + duration);
    } else incomplete = true;
  }
  if (open.size) incomplete = true;
  return { durations, durationsByAttempt, observed, incomplete };
}

function nextIntervalBoundary(
  events: FlowEvent[],
  start: FlowEvent,
  starts: string[],
  ends: string[],
): FlowEvent | undefined {
  const index = events.indexOf(start);
  return events
    .slice(index + 1)
    .find(
      (event) =>
        event.taskId === start.taskId &&
        event.attempt === start.attempt &&
        event.stage === start.stage &&
        (starts.includes(event.action) || ends.includes(event.action) || event.action === 'closed'),
    );
}

function stageDurations(events: FlowEvent[], stage: FlowStage): number[] {
  if (stage === 'dispatch') {
    const dispatch = events.find((e) => e.stage === 'dispatch' && e.action === 'dispatched');
    const started =
      dispatch &&
      events.find(
        (e) => e.stage === 'start' && e.action === 'requested' && e.attempt === dispatch.attempt && e.at >= dispatch.at,
      );
    if (dispatch && started) {
      const start = Date.parse(dispatch.at);
      const end = Date.parse(started.at);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return [end - start];
    }
    return [];
  }
  return attemptIntervals(events, stage, startActions[stage], endActions[stage]).durations;
}

export type FlowTask = Pick<Task, 'id'> & {
  brief: Pick<Task['brief'], 'goal'>;
  /** Authoritative store snapshot, also covering terminal tasks predating closure events. */
  terminalState?: Task['state'];
};

function terminalCloses(state: Task['state'] | undefined, stage: FlowStage): boolean {
  return (
    state === 'cancelled' ||
    state === 'stopped' ||
    state === 'merged' ||
    (state === 'integrated' && stage !== 'promotion')
  );
}

/** Explicit closure is not a successful stage completion and never supplies a duration. */
export function closePendingFlow(db: Database, task: Task, at = new Date().toISOString()): void {
  ensureFlow(db);
  const events = db
    .query('SELECT task_id AS taskId, attempt, stage, action, at FROM flow_events WHERE task_id=? ORDER BY at,sequence')
    .all(task.id) as FlowEvent[];
  for (const stage of FLOW_STAGES) {
    if (!terminalCloses(task.state, stage)) continue;
    const attempts = new Set(events.filter((event) => event.stage === stage).map((event) => event.attempt));
    for (const attempt of attempts) {
      let open = false;
      for (const event of events.filter((event) => event.stage === stage && event.attempt === attempt)) {
        if (startActions[stage].includes(event.action)) open = true;
        if (endActions[stage].includes(event.action) || event.action === 'closed') open = false;
      }
      if (open) recordFlow(db, { taskId: task.id, attempt, stage, action: 'closed', at, detail: task.state });
    }
  }
}

/** Read only the task fields used by flow reporting, without decoding full task bodies in JavaScript. */
export function readFlowTasks(db: Database): FlowTask[] {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_tasks'").get();
  if (!exists) return [];
  return (
    db
      .query(
        "SELECT id, json_extract(body, '$.brief.goal') AS goal, json_extract(body, '$.state') AS state FROM worker_tasks ORDER BY sequence",
      )
      .all() as {
      id: string;
      goal: string | null;
      state: Task['state'];
    }[]
  )
    .filter((row): row is { id: string; goal: string; state: Task['state'] } => typeof row.goal === 'string')
    .map((row) => ({ id: row.id, brief: { goal: row.goal }, terminalState: row.state }));
}

export function flowReport(events: FlowEvent[], tasks: FlowTask[], now = Date.now()) {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const byTask = new Map<string, FlowEvent[]>();
  for (const event of ordered) byTask.set(event.taskId, [...(byTask.get(event.taskId) ?? []), event]);
  const stageSummaries = FLOW_STAGES.map((stage) => ({
    stage,
    ...summarize(
      [...new Set(ordered.filter((e) => e.stage === stage).map((e) => e.taskId))].flatMap((id) =>
        stageDurations(byTask.get(id) ?? [], stage),
      ),
    ),
  }));
  const taskRows = tasks.map((task) => {
    const es = byTask.get(task.id) ?? [];
    const dispatch = es.find((e) => e.stage === 'dispatch' && e.action === 'dispatched');
    const integrated = es.find((e) => e.stage === 'integration' && e.action === 'integrated');
    const elapsed = dispatch && integrated ? Date.parse(integrated.at) - Date.parse(dispatch.at) : null;
    const worker = attemptIntervals(es, 'worker', ['started'], ['finished']);
    const checkWait = attemptIntervals(es, 'check', ['requested'], ['acquired']);
    const working =
      worker.observed && !worker.incomplete && !checkWait.incomplete
        ? [...worker.durationsByAttempt].reduce(
            (total, [attempt, duration]) =>
              total + Math.max(0, duration - (checkWait.durationsByAttempt.get(attempt) ?? 0)),
            0,
          )
        : null;
    return {
      taskId: task.id,
      goal: task.brief.goal,
      elapsedMs: elapsed,
      workingMs: working,
      efficiency: elapsed && working !== null ? working / elapsed : null,
    };
  });
  const queues = (['start', 'check', 'landing', 'verification', 'promotion'] as const).map((stage) => {
    const terminal = new Set(tasks.filter((task) => terminalCloses(task.terminalState, stage)).map((task) => task.id));
    const requests = ordered.filter((e) => e.stage === stage && ['requested', 'enqueued'].includes(e.action));
    const pending = requests.filter(
      (e) =>
        !terminal.has(e.taskId) &&
        !(
          stage !== 'promotion' &&
          ordered.some(
            (x) =>
              x.taskId === e.taskId &&
              x.attempt >= e.attempt &&
              x.stage === 'integration' &&
              x.action === 'integrated' &&
              x.at >= e.at,
          )
        ) &&
        !nextIntervalBoundary(ordered, e, startActions[stage], endActions[stage]),
    );
    return {
      stage,
      length: pending.length,
      oldestAgeMs: pending.length ? Math.max(0, now - Date.parse(pending[0]!.at)) : 0,
      tasks: pending.map((e) => e.taskId),
    };
  });
  const integrated = new Set(
    ordered.filter((e) => e.stage === 'integration' && e.action === 'integrated').map((e) => e.taskId),
  );
  const attemptCounts = new Map<string, number>();
  for (const e of ordered)
    if (e.stage === 'worker' && e.action === 'started')
      attemptCounts.set(e.taskId, (attemptCounts.get(e.taskId) ?? 0) + 1);
  const eligible = taskRows.filter((t) => t.elapsedMs !== null && t.workingMs !== null);
  const goals = [...new Set(tasks.map((t) => t.brief.goal))].map((goal) => {
    const members = tasks.filter((t) => t.brief.goal === goal);
    const rows = taskRows.filter((t) => t.goal === goal);
    return {
      goal,
      ...summarize(rows.flatMap((t) => (t.elapsedMs === null ? [] : [t.elapsedMs]))),
      stages: FLOW_STAGES.map((stage) => ({
        stage,
        ...summarize(members.flatMap((t) => stageDurations(byTask.get(t.id) ?? [], stage))),
      })),
    };
  });
  const waitEnds: Record<(typeof queues)[number]['stage'], string[]> = {
    start: ['started'],
    check: ['acquired'],
    landing: ['started'],
    verification: ['verified'],
    promotion: ['promoted'],
  };
  const bottleneck =
    [...queues]
      .map((q) => ({
        stage: q.stage,
        ms: ordered.reduce((sum, e) => {
          if (e.stage !== q.stage || !['requested', 'enqueued'].includes(e.action)) return sum;
          const boundary = nextIntervalBoundary(ordered, e, startActions[q.stage], waitEnds[q.stage]);
          const end = boundary && waitEnds[q.stage].includes(boundary.action) ? boundary : undefined;
          // Closed or legacy terminal requests have no observed wait end. Keep their duration unknown.
          const terminal = tasks.some((task) => task.id === e.taskId && terminalCloses(task.terminalState, e.stage));
          return (
            sum +
            (end
              ? Math.max(0, Date.parse(end.at) - Date.parse(e.at))
              : boundary || terminal
                ? 0
                : Math.max(0, now - Date.parse(e.at)))
          );
        }, 0),
      }))
      .sort((a, b) => b.ms - a.ms)[0]?.stage ?? null;
  return {
    stages: stageSummaries,
    goals,
    tasks: taskRows,
    queues,
    bottleneck,
    flowEfficiency: eligible.length
      ? eligible.reduce((n, t) => n + (t.workingMs ?? 0), 0) / eligible.reduce((n, t) => n + (t.elapsedMs ?? 0), 0)
      : null,
    attemptsPerIntegrated: integrated.size
      ? [...integrated].reduce((n, id) => n + (attemptCounts.get(id) ?? 0), 0) / integrated.size
      : null,
  };
}

export type FlowThresholds = {
  efficiencyBelow: number;
  oldestQueueMs: number;
  landingP90Ms: number;
  attemptsPerIntegrated: number;
};
export const DEFAULT_FLOW_THRESHOLDS: FlowThresholds = {
  efficiencyBelow: 0.4,
  oldestQueueMs: 60 * 60_000,
  landingP90Ms: 30 * 60_000,
  attemptsPerIntegrated: 1.5,
};
export function checkFlowAlarms(
  db: Database,
  report: ReturnType<typeof flowReport>,
  inbox: (summary: string) => void,
  now = new Date(),
  thresholds = DEFAULT_FLOW_THRESHOLDS,
): string[] {
  ensureFlow(db);
  const breaches: [string, string, string][] = [];
  if (report.flowEfficiency !== null && report.flowEfficiency < thresholds.efficiencyBelow)
    breaches.push(['flow-efficiency', 'worker', `flow efficiency ${(report.flowEfficiency * 100).toFixed(1)}%`]);
  for (const q of report.queues)
    if (q.oldestAgeMs > thresholds.oldestQueueMs)
      breaches.push([`queue-${q.stage}`, q.stage, `oldest queue entry ${Math.round(q.oldestAgeMs / 60000)} min`]);
  const landing = report.stages.find((s) => s.stage === 'landing');
  if (landing?.p90Ms !== null && landing?.p90Ms !== undefined && landing.p90Ms > thresholds.landingP90Ms)
    breaches.push(['landing-p90', 'landing', `p90 ${Math.round(landing.p90Ms / 60000)} min`]);
  if (report.attemptsPerIntegrated !== null && report.attemptsPerIntegrated > thresholds.attemptsPerIntegrated)
    breaches.push([
      'attempts-per-integrated',
      'worker',
      `attempts per integrated task ${report.attemptsPerIntegrated.toFixed(2)}`,
    ]);
  const sent: string[] = [];
  for (const [key, stage, measurement] of breaches) {
    const old = db.query('SELECT sent_at FROM flow_alarm_sends WHERE threshold=?').get(key) as {
      sent_at: string;
    } | null;
    if (old && now.getTime() - Date.parse(old.sent_at) < 3600000) continue;
    const top = [...report.queues]
      .sort((a, b) => b.oldestAgeMs - a.oldestAgeMs)
      .flatMap((q) => q.tasks)
      .slice(0, 3);
    inbox(`Flow alarm: stage ${stage}; measurement ${measurement}; top waiting tasks ${top.join(', ') || 'none'}`);
    db.query('INSERT OR REPLACE INTO flow_alarm_sends(threshold,sent_at) VALUES (?,?)').run(key, now.toISOString());
    sent.push(key);
  }
  return sent;
}
export function dispatchDailyStepAudit(
  db: Database,
  tasks: Task[],
  dispatch: () => Task,
  now = new Date(),
  reportFailure: (summary: string) => void = (summary) => console.error(summary),
): Task | null {
  ensureFlow(db);
  const day = now.toISOString().slice(0, 10);
  // A synchronous outbox delivery and its acknowledgement share the inbox's SQLite transaction.
  const report = () => {
    try {
      db.transaction(() => {
        const failures = db
          .query('SELECT day, cause FROM flow_audit_failures WHERE reported_at IS NULL ORDER BY day')
          .all() as { day: string; cause: string }[];
        for (const failure of failures) {
          reportFailure(`Daily step audit failed (${failure.day}): ${JSON.stringify(failure.cause)}`);
          db.query('UPDATE flow_audit_failures SET reported_at=? WHERE day=?').run(now.toISOString(), failure.day);
        }
      }).immediate();
    } catch (error) {
      console.error('daily step audit failure reporting failed:', error);
    }
  };
  report();
  if (db.query('SELECT 1 FROM flow_audit_runs WHERE day=?').get(day)) return null;
  const open = tasks.find(
    (task) =>
      task.brief.goal === 'daily-step-audit' && !['integrated', 'merged', 'stopped', 'cancelled'].includes(task.state),
  );
  if (open) {
    db.query('INSERT INTO flow_audit_runs(day,task_id) VALUES (?,?)').run(day, open.id);
    return null;
  }
  // Claim before parsing or dispatching. A failed day is never retried by each host tick or replacement host.
  const claimed = db.query('INSERT OR IGNORE INTO flow_audit_runs(day,task_id) VALUES (?,?)').run(day, '');
  if (!claimed.changes) return null;
  try {
    const audit = dispatch();
    db.query('UPDATE flow_audit_runs SET task_id=? WHERE day=?').run(audit.id, day);
    return audit;
  } catch (error) {
    const cause = error instanceof Error ? (error.stack ?? error.message) : String(error);
    db.query('INSERT INTO flow_audit_failures(day,failed_at,cause) VALUES (?,?,?)').run(day, now.toISOString(), cause);
    report();
    return null;
  }
}
