import defaults from '../defaults.json';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
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
type LifecycleStage = (typeof FLOW_STAGES)[number];
export type FlowStage = LifecycleStage | 'manager';
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
  {
    module: 'flow',
    version: 5,
    sql: `CREATE INDEX flow_events_wait_action ON flow_events(task_id, attempt, stage, action, at DESC, sequence DESC);`,
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
const startActions: Record<LifecycleStage, string[]> = {
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
const endActions: Record<LifecycleStage, string[]> = {
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
  stage: LifecycleStage,
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

const queueStages = ['start', 'check', 'landing', 'verification', 'promotion'] as const;
type QueueStage = (typeof queueStages)[number];
const waitEnds: Record<QueueStage, string[]> = {
  start: ['started'],
  check: ['acquired'],
  landing: ['started'],
  verification: ['verified'],
  promotion: ['promoted'],
};
const requestActions = ['requested', 'enqueued'];
const isQueueStage = (stage: FlowStage): stage is QueueStage =>
  queueStages.includes(stage as QueueStage);

function projectFlow(ordered: FlowEvent[]) {
  const n = ordered.length;
  const byTask = new Map<string, FlowEvent[]>();
  const groups = new Map<string, number[]>();
  const nextQueueAt = new Int32Array(n).fill(-1);
  const nextWaitAt = new Int32Array(n).fill(-1);
  const integrationCloses = new Uint8Array(n);
  const integrationsByTask = new Map<string, { attempt: number; at: string }[]>();
  const requestsByTask = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const event = ordered[i]!;
    const taskEvents = byTask.get(event.taskId);
    if (taskEvents) taskEvents.push(event);
    else byTask.set(event.taskId, [event]);
    const key = `${event.taskId}\t${event.attempt}\t${event.stage}`;
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
    if (event.stage === 'integration' && event.action === 'integrated') {
      const integrations = integrationsByTask.get(event.taskId);
      if (integrations) integrations.push({ attempt: event.attempt, at: event.at });
      else integrationsByTask.set(event.taskId, [{ attempt: event.attempt, at: event.at }]);
    }
    if (isQueueStage(event.stage) && event.stage !== 'promotion' && requestActions.includes(event.action)) {
      const requests = requestsByTask.get(event.taskId);
      if (requests) requests.push(i);
      else requestsByTask.set(event.taskId, [i]);
    }
  }
  for (const indexes of groups.values()) {
    let queue = -1;
    let wait = -1;
    for (let k = indexes.length - 1; k >= 0; k--) {
      const i = indexes[k]!;
      nextQueueAt[i] = queue;
      nextWaitAt[i] = wait;
      const event = ordered[i]!;
      if (event.stage === 'manager') continue;
      const starts = startActions[event.stage];
      const ends = endActions[event.stage];
      if (starts.includes(event.action) || ends.includes(event.action) || event.action === 'closed') queue = i;
      if (
        isQueueStage(event.stage) &&
        (starts.includes(event.action) || waitEnds[event.stage].includes(event.action) || event.action === 'closed')
      )
        wait = i;
    }
  }
  for (const [taskId, requests] of requestsByTask) {
    const integrations = integrationsByTask.get(taskId) ?? [];
    let maxAttempt = Number.NEGATIVE_INFINITY;
    let j = integrations.length - 1;
    for (let r = requests.length - 1; r >= 0; r--) {
      const i = requests[r]!;
      const event = ordered[i]!;
      while (j >= 0 && integrations[j]!.at >= event.at) {
        maxAttempt = Math.max(maxAttempt, integrations[j]!.attempt);
        j--;
      }
      if (maxAttempt >= event.attempt) integrationCloses[i] = 1;
    }
  }
  return { byTask, nextQueueAt, nextWaitAt, integrationCloses };
}

function stageDurations(events: FlowEvent[], stage: LifecycleStage): number[] {
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
  brief: Pick<Task['brief'], 'goal' | 'urgent'>;
  /** Authoritative store snapshot, also covering terminal tasks predating closure events. */
  terminalState?: Task['state'];
};

function terminalCloses(state: Task['state'] | undefined, stage: LifecycleStage): boolean {
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
        "SELECT id, json_extract(body, '$.brief.goal') AS goal, json_extract(body, '$.brief.urgent') AS urgent, json_extract(body, '$.state') AS state FROM worker_tasks ORDER BY sequence",
      )
      .all() as {
      id: string;
      goal: string | null;
      urgent: number | null;
      state: Task['state'];
    }[]
  )
    .filter((row) => typeof row.goal === 'string')
    .map((row) => ({
      id: row.id,
      brief: { goal: row.goal!, ...(row.urgent === 1 ? { urgent: true } : {}) },
      terminalState: row.state,
    }));
}

export function flowReport(events: FlowEvent[], tasks: FlowTask[], now = Date.now()) {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const { byTask, nextQueueAt, nextWaitAt, integrationCloses } = projectFlow(ordered);
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
      ...(task.brief.urgent ? { urgent: true } : {}),
      elapsedMs: elapsed,
      workingMs: working,
      efficiency: elapsed && working !== null ? working / elapsed : null,
    };
  });
  const terminalByStage = Object.fromEntries(
    queueStages.map((stage) => [
      stage,
      new Set(tasks.filter((task) => terminalCloses(task.terminalState, stage)).map((task) => task.id)),
    ]),
  ) as Record<QueueStage, Set<string>>;
  const queues = queueStages.map((stage) => {
    const terminal = terminalByStage[stage];
    const pending: FlowEvent[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const event = ordered[i]!;
      if (event.stage !== stage || !requestActions.includes(event.action)) continue;
      if (terminal.has(event.taskId)) continue;
      if (stage !== 'promotion' && integrationCloses[i]) continue;
      if (nextQueueAt[i] !== -1) continue;
      pending.push(event);
    }
    return {
      stage,
      length: pending.length,
      oldestAgeMs: pending.length ? Math.max(0, now - Date.parse(pending[0]!.at)) : 0,
      tasks: pending.map((e) => e.taskId),
    };
  });
  const urgent = new Set(tasks.filter((t) => t.brief.urgent).map((t) => t.id));
  const integrated = new Set(
    ordered
      .filter((e) => e.stage === 'integration' && e.action === 'integrated' && !urgent.has(e.taskId))
      .map((e) => e.taskId),
  );
  const attemptCounts = new Map<string, number>();
  for (const e of ordered)
    if (e.stage === 'worker' && e.action === 'started')
      attemptCounts.set(e.taskId, (attemptCounts.get(e.taskId) ?? 0) + 1);
  const overBudgetLaunchesByLayer: Record<string, number> = {};
  for (const event of ordered) {
    if (!['worker', 'manager'].includes(event.stage) || event.action !== 'started' || !event.detail) continue;
    try {
      const prompt = (JSON.parse(event.detail) as { prompt?: { overBudget?: unknown } }).prompt;
      if (!Array.isArray(prompt?.overBudget)) continue;
      for (const layer of new Set(prompt.overBudget.filter((name): name is string => typeof name === 'string')))
        overBudgetLaunchesByLayer[layer] = (overBudgetLaunchesByLayer[layer] ?? 0) + 1;
    } catch {
      // Older or malformed event details do not contribute prompt measurements.
    }
  }
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
  const bottleneck =
    [...queues]
      .map((q) => {
        const terminal = terminalByStage[q.stage];
        let ms = 0;
        for (let i = 0; i < ordered.length; i++) {
          const event = ordered[i]!;
          if (event.stage !== q.stage || !requestActions.includes(event.action)) continue;
          const boundaryIndex = nextWaitAt[i]!;
          const boundary = boundaryIndex === -1 ? undefined : ordered[boundaryIndex];
          const end = boundary && waitEnds[q.stage].includes(boundary.action) ? boundary : undefined;
          // Closed or legacy terminal requests have no observed wait end. Keep their duration unknown.
          ms += end
            ? Math.max(0, Date.parse(end.at) - Date.parse(event.at))
            : boundary || terminal.has(event.taskId)
              ? 0
              : Math.max(0, now - Date.parse(event.at));
        }
        return { stage: q.stage, ms };
      })
      .sort((a, b) => b.ms - a.ms)[0]?.stage ?? null;
  return {
    urgent: {
      tasks: [...urgent],
      integrated: new Set(
        ordered
          .filter((e) => urgent.has(e.taskId) && e.stage === 'integration' && e.action === 'integrated')
          .map((e) => e.taskId),
      ).size,
    },
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
    overBudgetLaunchesByLayer,
  };
}

export type FlowThresholds = {
  efficiencyBelow: number;
  oldestQueueMs: number;
  landingP90Ms: number;
  attemptsPerIntegrated: number;
};
export const DEFAULT_FLOW_THRESHOLDS: FlowThresholds = defaults.flow;
export function checkFlowAlarms(
  db: Database,
  report: ReturnType<typeof flowReport>,
  inbox: (summary: string) => void,
  now = new Date(),
  thresholds = DEFAULT_FLOW_THRESHOLDS,
  policy: ControlPolicy = defaultPolicy,
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
    if (old && now.getTime() - Date.parse(old.sent_at) < policy.flow.alertEveryMs) continue;
    const top = [...report.queues]
      .sort((a, b) => b.oldestAgeMs - a.oldestAgeMs)
      .flatMap((q) => q.tasks)
      .slice(0, policy.flow.waitingTaskExamples);
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
