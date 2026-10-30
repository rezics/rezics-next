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
function stageDurations(events: FlowEvent[], stage: FlowStage): number[] {
  if (stage === 'dispatch') {
    const dispatch = events.find((e) => e.stage === 'dispatch' && e.action === 'dispatched');
    const started = events.find((e) => e.stage === 'start' && e.action === 'requested');
    if (dispatch && started) return [Math.max(0, Date.parse(started.at) - Date.parse(dispatch.at))];
  }
  const groups = new Map<number, FlowEvent[]>();
  for (const event of events)
    if (event.stage === stage) groups.set(event.attempt, [...(groups.get(event.attempt) ?? []), event]);
  const durations: number[] = [];
  for (const group of groups.values()) {
    let start: number | undefined;
    for (const event of group) {
      if (startActions[stage].includes(event.action)) start = Date.parse(event.at);
      if (start !== undefined && endActions[stage].includes(event.action)) {
        const end = Date.parse(event.at);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) durations.push(end - start);
        start = undefined;
      }
    }
  }
  return durations;
}

export type FlowTask = Pick<Task, 'id'> & { brief: Pick<Task['brief'], 'goal'> };

/** Read only the task fields used by flow reporting, without decoding full task bodies in JavaScript. */
export function readFlowTasks(db: Database): FlowTask[] {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_tasks'").get();
  if (!exists) return [];
  return (
    db
      .query("SELECT id, json_extract(body, '$.brief.goal') AS goal FROM worker_tasks ORDER BY sequence")
      .all() as { id: string; goal: string | null }[]
  )
    .filter((row): row is { id: string; goal: string } => typeof row.goal === 'string')
    .map((row) => ({ id: row.id, brief: { goal: row.goal } }));
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
    let workerMs = 0;
    let open: number | undefined;
    for (const e of es)
      if (e.stage === 'worker') {
        if (e.action === 'started') open = Date.parse(e.at);
        else if (e.action === 'finished' && open !== undefined) {
          workerMs += Math.max(0, Date.parse(e.at) - open);
          open = undefined;
        }
      }
    const checks = es.filter((e) => e.stage === 'check');
    let checkWaitMs = 0;
    let checkKnown = true;
    let requested: number | undefined;
    for (const e of checks) {
      if (e.action === 'requested') requested = Date.parse(e.at);
      if (e.action === 'acquired' && requested !== undefined) {
        checkWaitMs += Math.max(0, Date.parse(e.at) - requested);
        requested = undefined;
      }
      if (e.action === 'requested' && !checks.some((x) => x.at >= e.at && x.action === 'acquired')) checkKnown = false;
    }
    const working =
      es.some((e) => e.stage === 'worker' && e.action === 'started') && (!checks.length || checkKnown)
        ? Math.max(0, workerMs - checkWaitMs)
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
    const requests = ordered.filter((e) => e.stage === stage && ['requested', 'enqueued'].includes(e.action));
    const pending = requests.filter(
      (e) =>
        !ordered.some(
          (x) =>
            x.taskId === e.taskId &&
            x.attempt === e.attempt &&
            x.stage === stage &&
            x.at >= e.at &&
            endActions[stage].includes(x.action),
        ),
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
          const end = ordered.find(
            (x) =>
              x.taskId === e.taskId &&
              x.attempt === e.attempt &&
              x.stage === e.stage &&
              x.at >= e.at &&
              waitEnds[q.stage].includes(x.action),
          );
          return sum + (end ? Math.max(0, Date.parse(end.at) - Date.parse(e.at)) : Math.max(0, now - Date.parse(e.at)));
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
): Task | null {
  ensureFlow(db);
  const day = now.toISOString().slice(0, 10);
  if (db.query('SELECT 1 FROM flow_audit_runs WHERE day=?').get(day)) return null;
  const open = tasks.find(
    (task) =>
      task.brief.goal === 'daily-step-audit' && !['integrated', 'merged', 'stopped', 'cancelled'].includes(task.state),
  );
  if (open) {
    db.query('INSERT INTO flow_audit_runs(day,task_id) VALUES (?,?)').run(day, open.id);
    return null;
  }
  const audit = dispatch();
  db.query('INSERT INTO flow_audit_runs(day,task_id) VALUES (?,?)').run(day, audit.id);
  return audit;
}
