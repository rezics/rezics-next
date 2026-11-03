import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Database } from 'bun:sqlite';
import { migrate } from './db.ts';
import { ensureFlow, type FlowEvent } from './flow.ts';
import { lifecycleMetrics } from './lifecycle-metrics.ts';
import { formatLifecycleMetrics } from './report.ts';
import { listOpenToolIncidents } from './tool-incidents.ts';
import { WorkerStore } from './store.ts';

const HOUR_MS = 60 * 60_000;
const MAX_NOTIFIER_OUTPUT_BYTES = 4096;
const MAX_REPORT_BYTES = 32_000;
const INTERRUPTED_SEND_GRACE_MS = 5000;

export const efficiencyReportMigrations = [
  {
    module: 'efficiency-report',
    version: 1,
    sql: `CREATE TABLE efficiency_report_deliveries (
      hour_bucket TEXT PRIMARY KEY,
      report_ref TEXT NOT NULL,
      report TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','claimed','sent','failed','unknown')),
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      finished_at TEXT,
      detail TEXT
    );`,
  },
] as const;

export type UtcHour = { start: string; end: string };

export function completedUtcHour(now: Date | number = Date.now()): UtcHour {
  const time = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(time)) throw new Error('hourly report requires a valid time');
  const endMs = Math.floor(time / HOUR_MS) * HOUR_MS;
  return { start: new Date(endMs - HOUR_MS).toISOString(), end: new Date(endMs).toISOString() };
}

export function parseUtcHour(value: string): UtcHour {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time % HOUR_MS !== 0 || new Date(time).toISOString() !== value)
    throw new Error('bucket must be a canonical UTC hour start');
  return { start: value, end: new Date(time + HOUR_MS).toISOString() };
}

type ReportOptions = {
  bucket?: string;
  now?: Date | number;
};

type LandingRow = {
  task_id: string;
  attempt: number;
  at: string;
  goal: string | null;
  target: string | null;
  paths: string | null;
  declared_paths: string | null;
  detail: string | null;
};

function hasTable(db: Database, name: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function clean(value: unknown): string {
  return (
    String(value ?? 'unknown')
      .replace(/[\r\n\t]/g, ' ')
      .trim()
      .slice(0, 160) || 'unknown'
  );
}

function targetFor(row: LandingRow): 'dev' | 'stabilize' | 'main' | 'unknown' {
  if (row.detail) {
    try {
      const detail: unknown = JSON.parse(row.detail);
      if (typeof detail === 'object' && detail !== null && 'integrationTarget' in detail) {
        const target = (detail as { integrationTarget?: unknown }).integrationTarget;
        if (target === 'integration') return 'dev';
        if (target === 'stabilize' || target === 'main') return target;
        return 'unknown';
      }
    } catch {
      // Older flow detail strings have no recorded integration target; use the durable landing request below.
    }
  }
  if (row.target === 'stabilize' && row.goal !== 'control-plane') return 'stabilize';
  if (row.target === 'main') return 'main';
  if (row.target === 'integration') return 'dev';
  if (row.target !== null && row.target !== undefined && row.target !== 'stabilize') return 'unknown';
  if (row.goal !== 'control-plane') return 'dev';
  try {
    const paths: unknown = row.declared_paths
      ? JSON.parse(row.declared_paths)
      : row.paths
        ? JSON.parse(row.paths)
        : null;
    if (
      Array.isArray(paths) &&
      paths.length > 0 &&
      paths.every((path) => typeof path === 'string' && path.startsWith('tools/goal/'))
    )
      return 'main';
    return 'dev';
  } catch {
    return 'unknown';
  }
}

function hourEvents(db: Database, bucket: UtcHour, available: boolean): FlowEvent[] {
  if (!available) return [];
  const rows = db
    .query(
      `SELECT task_id, attempt, stage, action, at, detail FROM flow_events INDEXED BY flow_events_at_window
       WHERE at >= ? AND at < ? ORDER BY at, sequence`,
    )
    .all(bucket.start, bucket.end) as {
    task_id: string;
    attempt: number;
    stage: string;
    action: string;
    at: string;
    detail: string | null;
  }[];
  return rows.map((row) => ({
    taskId: row.task_id,
    attempt: row.attempt,
    stage: row.stage as FlowEvent['stage'],
    action: row.action,
    at: row.at,
    ...(row.detail === null ? {} : { detail: row.detail }),
  }));
}

function landedSummary(db: Database, bucket: UtcHour, available: boolean): string[] {
  if (!available || !hasTable(db, 'worker_tasks'))
    return [
      'Landings: unknown (timestamped integration history unavailable).',
      'Landing identities: unknown (timestamped integration history unavailable).',
    ];
  const landingJoin = hasTable(db, 'landing_queue')
    ? 'LEFT JOIN landing_queue AS l ON l.task=e.task_id AND l.attempt=e.attempt'
    : 'LEFT JOIN (SELECT NULL AS task, NULL AS attempt, NULL AS request) AS l ON l.task=e.task_id AND l.attempt=e.attempt';
  const rows = db
    .query(
      `SELECT e.task_id, e.attempt, e.at,
              json_extract(t.body, '$.brief.goal') AS goal,
              json_extract(t.body, '$.brief.target') AS target,
              json_extract(t.body, '$.brief.paths') AS paths,
              json_extract(l.request, '$.declaredPaths') AS declared_paths,
              e.detail
       FROM flow_events AS e INDEXED BY flow_events_launch_window
       LEFT JOIN worker_tasks AS t ON t.id = e.task_id
       ${landingJoin}
       WHERE e.stage='integration' AND e.action='integrated' AND e.at >= ? AND e.at < ?
       ORDER BY e.at, e.sequence`,
    )
    .all(bucket.start, bucket.end) as LandingRow[];
  const byTask = new Map<string, LandingRow>();
  for (const row of rows) {
    const previous = byTask.get(row.task_id);
    if (!previous) byTask.set(row.task_id, row);
    else if (targetFor(previous) !== targetFor(row) || previous.goal !== row.goal)
      byTask.set(row.task_id, { ...previous, goal: null, target: 'ambiguous', paths: null });
  }
  const totals: Record<'dev' | 'stabilize' | 'main' | 'unknown', number> = {
    dev: 0,
    stabilize: 0,
    main: 0,
    unknown: 0,
  };
  const goals = new Map<string, number>();
  for (const row of byTask.values()) {
    totals[targetFor(row)]++;
    const goal = clean(row.goal);
    goals.set(goal, (goals.get(goal) ?? 0) + 1);
  }
  const perGoal = [...goals]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 8)
    .map(([goal, count]) => `${goal} ${count}`)
    .join(', ');
  const omittedGoals = Math.max(0, goals.size - 8);
  const landings = [...byTask.values()].sort((a, b) => a.at.localeCompare(b.at) || a.task_id.localeCompare(b.task_id));
  const landingIdentities = landings
    .slice(0, 8)
    .map((row) => `${clean(row.task_id)}#${row.attempt} at ${row.at} (${targetFor(row)})`)
    .join('; ');
  const omittedLandings = Math.max(0, landings.length - 8);
  return [
    `Landings in UTC hour: dev ${totals.dev}; stabilize ${totals.stabilize}; main ${totals.main}; unknown ${totals.unknown} (each task counted once).`,
    `Landings by Goal: ${perGoal || (rows.length ? 'unknown' : 'none recorded')}${omittedGoals ? `; ${omittedGoals} more Goals omitted` : ''}.`,
    `Landing identities: ${landingIdentities || 'none recorded'}${omittedLandings ? `; ${omittedLandings} more omitted` : ''}.`,
  ];
}

function latestUsefulLanding(db: Database, end: string, available: boolean): string {
  if (!available) return 'Last useful landing: unknown (timestamped integration history unavailable).';
  const row = db
    .query(
      `SELECT task_id, attempt, at FROM flow_events INDEXED BY flow_events_launch_window
       WHERE stage='integration' AND action='integrated' AND at < ?
       ORDER BY at DESC, sequence DESC LIMIT 1`,
    )
    .get(end) as { task_id: string; attempt: number; at: string } | null;
  return row
    ? `Last useful landing: ${clean(row.task_id)}#${row.attempt} at ${row.at}.`
    : 'Last useful landing: none recorded by the report cutoff.';
}

function workSummary(db: Database, available: boolean): string {
  if (!available || !hasTable(db, 'worker_tasks')) return 'Open work: unknown (current task state unavailable).';
  const rows = db
    .query(
      `SELECT json_extract(body, '$.brief.goal') AS goal, json_extract(body, '$.state') AS state, count(*) AS count
       FROM worker_tasks INDEXED BY worker_tasks_state
       WHERE json_extract(body, '$.state') IN ('ready','held','running','landing')
       GROUP BY goal, state ORDER BY goal, state`,
    )
    .all() as { goal: string | null; state: string; count: number }[];
  return `Open work: ${rows.length ? rows.map((row) => `${clean(row.goal)} ${row.state} ${row.count}`).join('; ') : 'none recorded'}.`;
}

function landingQueueAge(metrics: ReturnType<typeof lifecycleMetrics> | null, available: boolean): string {
  if (!available) return 'Current landing queue age: unknown (queue or timestamped history unavailable).';
  if (!metrics) return 'Current landing queue age: unknown (current task state unavailable).';
  const entries = metrics.waiting.queues.filter((entry) => entry.stage === 'landing');
  if (!entries.length) return 'Current landing queue age: 0 queued attempts.';
  const oldest = entries[0]!.ageMs;
  const unknown = entries.filter((entry) => entry.ageMs === null).length;
  return unknown || oldest === null
    ? `Current landing queue age: ${entries.length} queued attempts; oldest age unknown (${unknown} missing enqueue timestamps).`
    : `Current landing queue age: ${entries.length} queued attempts; oldest ${oldest.toFixed(0)} ms.`;
}

function waitIdentities(metrics: ReturnType<typeof lifecycleMetrics> | null, available: boolean): string {
  if (!available) return 'Current wait identities: unknown (current task state unavailable).';
  if (!metrics) return 'Current wait identities: unknown (current task state unavailable).';
  if (!metrics.waiting.entries.length) return 'Current wait identities: none recorded.';
  const entries = metrics.waiting.entries.slice(0, 5).map((entry) => {
    const stage = entry.stage ?? entry.kind;
    const age = entry.ageMs === null ? 'age unknown' : `age ${Math.round(entry.ageMs / 60_000)}m`;
    return `${clean(entry.taskId)}#${entry.attempt} ${clean(stage)} (${age})`;
  });
  const omitted = metrics.waiting.entries.length - entries.length;
  return `Current wait identities: ${entries.join('; ')}${omitted ? `; ${omitted} more omitted` : ''}.`;
}

type TokenUsage = {
  ended: number;
  measured: number;
  input: number;
  output: number;
  diffLines: number;
  diffKnown: number;
};

function usageSummary(db: Database, bucket: UtcHour): string {
  if (!hasTable(db, 'worker_attempts') || !hasTable(db, 'worker_records'))
    return 'Recorded usage: unknown (attempt history unavailable); spend: unknown (no durable cost records); worker diff churn: unknown.';
  const rows = db
    .query(
      `SELECT r.body FROM worker_attempts AS a INDEXED BY worker_attempts_ended_at
       JOIN worker_records AS r ON r.task_id=a.task_id AND r.attempt=a.attempt
       WHERE json_extract(a.body, '$.endedAt') >= ? AND json_extract(a.body, '$.endedAt') < ?
       ORDER BY a.task_id, a.attempt`,
    )
    .all(bucket.start, bucket.end) as { body: string }[];
  if (!rows.length)
    return 'Recorded usage: unknown (no completed attempt records in this hour); spend: unknown; worker diff churn: unknown.';
  const usage: TokenUsage = { ended: rows.length, measured: 0, input: 0, output: 0, diffLines: 0, diffKnown: 0 };
  for (const row of rows) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(row.body) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tokens = record.usage && typeof record.usage === 'object' ? (record.usage as Record<string, unknown>) : null;
    if (tokens?.source === 'codex-session' && typeof tokens.input === 'number' && typeof tokens.output === 'number') {
      usage.input += tokens.input;
      usage.output += tokens.output;
      usage.measured++;
    }
    if (typeof record.diffLines === 'number' && Number.isFinite(record.diffLines)) {
      usage.diffLines += record.diffLines;
      usage.diffKnown++;
    }
  }
  const sessionUsage = usage.measured
    ? `${usage.input + usage.output} raw session-ledger tokens across ${usage.measured}/${usage.ended} completed attempts${
        usage.measured < usage.ended ? '; remaining usage unknown' : ''
      }`
    : `unknown (no session-ledger usage among ${usage.ended} completed attempts)`;
  const churn = usage.diffKnown
    ? `${usage.diffLines} recorded changed lines across ${usage.diffKnown}/${usage.ended} completed attempts${
        usage.diffKnown < usage.ended ? '; remaining churn unknown' : ''
      }`
    : `unknown (no attempt diff measurements among ${usage.ended} completed attempts)`;
  return `Recorded usage: ${sessionUsage}. Spend: unknown (no durable cost records). Worker diff churn: ${churn}; churn includes non-landed work and is not a delivered-journey count.`;
}

function promotionSummary(db: Database, metrics: ReturnType<typeof lifecycleMetrics> | null): string {
  if (!hasTable(db, 'worker_promotions')) return 'Promotion: unknown (promotion state unavailable).';
  const row = db.query('SELECT body FROM worker_promotions WHERE id=1').get() as { body: string } | null;
  if (!row) return 'Promotion: none recorded.';
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(row.body) as Record<string, unknown>;
  } catch {
    return 'Promotion: unknown (record is malformed).';
  }
  const phase = typeof body.phase === 'string' ? body.phase : 'unknown';
  const mainResult =
    body.mainResult && typeof body.mainResult === 'object' ? (body.mainResult as { passed?: unknown }) : null;
  const result =
    mainResult?.passed === true
      ? 'main gate passed'
      : mainResult?.passed === false
        ? 'main gate failed'
        : 'main gate result unknown';
  const disposition =
    phase === 'blocked' || phase === 'stabilize-blocked' ? 'blocked' : 'recorded phase; process status unknown';
  const age = metrics?.promotion.phaseAgeMs ?? null;
  return `Promotion: ${disposition}; phase ${phase}; ${result}; phase age ${age === null ? 'unknown' : `${Math.round(age / 60_000)}m`}.`;
}

function operatorAttention(metrics: ReturnType<typeof lifecycleMetrics> | null): string {
  if (!metrics)
    return 'Current incidents: unknown (current task state unavailable); unavailable evidence: orphaned landings, promotion timing, quarantine history.';
  const incidents: string[] = [];
  const unavailable: string[] = [];
  const summarize = (values: string[]) =>
    values.length > 5 ? `${values.slice(0, 5).join(', ')} (+${values.length - 5} more)` : values.join(', ');

  const orphaned = metrics.orphanedLandings;
  if (!orphaned.available || orphaned.count === null) unavailable.push('orphaned landing history');
  else if (orphaned.count > 0) {
    const taskIds = [...new Set(orphaned.taskIds.map(clean))];
    incidents.push(`orphaned landings ${orphaned.count}${taskIds.length ? ` [${summarize(taskIds)}]` : ''}`);
  }

  const promotion = metrics.promotion;
  if (!promotion.available) unavailable.push('promotion state');
  else if (promotion.phase === 'blocked' || promotion.phase === 'stabilize-blocked')
    incidents.push(`promotion ${promotion.phase}`);

  const quarantines = metrics.quarantines;
  if (!quarantines.available || quarantines.currentCount === null || quarantines.current === null) {
    unavailable.push('quarantine history');
  } else if (quarantines.currentCount > 0) {
    const byTask = new Map<string, Set<string>>();
    for (const row of quarantines.current) {
      const key = `${clean(row.taskId)}/${row.attempt}`;
      const causes = byTask.get(key) ?? new Set<string>();
      causes.add(clean(row.cause));
      byTask.set(key, causes);
    }
    const entries = [...byTask]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([task, causes]) => `${task} (${[...causes].sort().join(', ')})`);
    incidents.push(`quarantines ${quarantines.currentCount}${entries.length ? ` [${summarize(entries)}]` : ''}`);
  }

  return `Current incidents: ${incidents.length ? incidents.join('; ') : 'none recorded'}; unavailable evidence: ${unavailable.length ? unavailable.join(', ') : 'none'}.`;
}

function sharedIncidentLine(db: Database): { available: boolean; incidents: ReturnType<typeof listOpenToolIncidents> } {
  if (!hasTable(db, 'worker_events')) return { available: false, incidents: [] };
  return { available: true, incidents: listOpenToolIncidents(new WorkerStore(db)) };
}

function sharedIncidentSummary(incidents: ReturnType<typeof listOpenToolIncidents>, available: boolean): string {
  if (!available) return 'Shared tool incidents: unknown (incident history unavailable).';
  if (!incidents.length) return 'Shared tool incidents: none open.';
  const rows = incidents.slice(0, 5).map((incident) => {
    const tasks = incident.exampleTasks.map((task) => `${clean(task.taskId)}#${task.attempt}`).join(', ');
    return `${clean(incident.line)}; probe ${clean(incident.probe.taskId)}#${incident.probe.attempt}${tasks ? `; examples ${tasks}` : ''}`;
  });
  const omitted = incidents.length - rows.length;
  return `Shared tool incidents: ${rows.join(' | ')}${omitted ? ` | ${omitted} more omitted` : ''}.`;
}

function nextActions(
  metrics: ReturnType<typeof lifecycleMetrics> | null,
  incidents: ReturnType<typeof listOpenToolIncidents>,
): string[] {
  const actions: string[] = [];
  if (metrics) {
    const orphaned = metrics.orphanedLandings;
    if (orphaned.available && (orphaned.count ?? 0) > 0 && orphaned.taskIds[0])
      actions.push(`Inspect orphaned landing ${clean(orphaned.taskIds[0])} with Goal status before retrying it.`);
    if (metrics.promotion.available && ['blocked', 'stabilize-blocked'].includes(metrics.promotion.phase ?? ''))
      actions.push('Resolve the recorded promotion gate or blocker, then run Goal promote.');
    const oldestWait = metrics.waiting.entries[0];
    if (oldestWait)
      actions.push(
        `Inspect ${clean(oldestWait.taskId)}#${oldestWait.attempt} (${clean(oldestWait.stage ?? oldestWait.kind)}) with Goal status.`,
      );
    const firstQuarantine = metrics.quarantines.current?.[0];
    if (firstQuarantine)
      actions.push(
        `Review quarantined task ${clean(firstQuarantine.taskId)}#${firstQuarantine.attempt} before retrying it.`,
      );
  }
  const incident = incidents[0];
  if (incident)
    actions.push(
      `Review the shared blocker at probe ${clean(incident.probe.taskId)}#${incident.probe.attempt}; delivery operations owns follow-up.`,
    );
  return actions.length ? actions.map((action, index) => `${index + 1}. ${action}`) : ['None from recorded evidence.'];
}

export async function renderHourlyEfficiencyReport(db: Database, options: ReportOptions): Promise<string> {
  const bucket = options.bucket ? parseUtcHour(options.bucket) : completedUtcHour(options.now);
  const flowAvailable = hasTable(db, 'flow_events');
  if (flowAvailable) ensureFlow(db);
  const events = hourEvents(db, bucket, flowAvailable);
  const asOf = options.now ?? Date.now();
  const openWorkAvailable = hasTable(db, 'worker_tasks');
  const metrics = openWorkAvailable ? lifecycleMetrics(db, asOf) : null;
  const starts = events.filter((event) => event.stage === 'worker' && event.action === 'started').length;
  const finishes = new Set(
    events
      .filter((event) => event.stage === 'worker' && event.action === 'finished')
      .map((event) => `${event.taskId}:${event.attempt}`),
  ).size;
  const requestedChecks = new Map<string, number>();
  const checkWaits: number[] = [];
  for (const event of events) {
    if (event.stage !== 'check') continue;
    const key = `${event.taskId}:${event.attempt}`;
    if (event.action === 'requested') requestedChecks.set(key, Date.parse(event.at));
    else if (event.action === 'acquired') {
      const requestedAt = requestedChecks.get(key);
      const acquiredAt = Date.parse(event.at);
      if (requestedAt !== undefined && Number.isFinite(requestedAt) && acquiredAt >= requestedAt)
        checkWaits.push(acquiredAt - requestedAt);
      requestedChecks.delete(key);
    } else if (event.action === 'released') requestedChecks.delete(key);
  }
  const sortedCheckWaits = [...checkWaits].sort((a, b) => a - b);
  const checkWaitP90 = sortedCheckWaits.length ? sortedCheckWaits[Math.ceil(0.9 * sortedCheckWaits.length) - 1]! : null;
  const checkWaitLine = !flowAvailable
    ? 'Check-slot wait in bucket: unknown (flow history unavailable).'
    : checkWaits.length
      ? `Check-slot wait in bucket: ${checkWaits.length} completed request/acquire pairs; p90 ${checkWaitP90 === null ? 'unknown' : `${Math.round(checkWaitP90 / 60_000)}m`}.`
      : 'Check-slot wait in bucket: unknown (no completed wait pair recorded).';
  const lifetimeLines = metrics ? formatLifecycleMetrics(metrics) : [];
  const launchTaskLines = lifetimeLines.filter((line) => line.startsWith('  '));
  const aggregateLines = lifetimeLines.filter((line) => !line.startsWith('  '));
  const lifecycleLines = metrics
    ? [
        flowAvailable
          ? (aggregateLines[0] ?? 'Launches in trailing hour: unknown.')
          : 'Launches in trailing hour: unknown (flow history unavailable).',
        ...launchTaskLines.slice(0, 8),
        ...(launchTaskLines.length > 8 ? [`  … ${launchTaskLines.length - 8} additional task rows.`] : []),
        ...aggregateLines.slice(1),
      ]
    : [
        'Launches in trailing hour: unknown (current task state unavailable).',
        'Current waits: unknown (current task state unavailable).',
        'Orphaned landings: unknown (current task state unavailable).',
        'Quarantines: unknown (current task state unavailable).',
      ];
  const landed = landedSummary(db, bucket, flowAvailable);
  const incidents = sharedIncidentLine(db);
  const waitsAvailable = openWorkAvailable;
  const landingQueueAvailable = flowAvailable && openWorkAvailable && hasTable(db, 'landing_queue');
  const lines = [
    `Hourly operations report — ${bucket.start} to ${bucket.end} UTC`,
    ...landed,
    latestUsefulLanding(db, bucket.end, flowAvailable),
    flowAvailable
      ? `Worker starts / finishes in bucket: ${starts} starts (including resumes) / ${finishes} finished attempts.`
      : 'Worker starts / finishes in bucket: unknown (flow history unavailable).',
    workSummary(db, openWorkAvailable),
    landingQueueAge(metrics, landingQueueAvailable),
    waitIdentities(metrics, waitsAvailable),
    checkWaitLine,
    ...lifecycleLines,
    promotionSummary(db, metrics),
    operatorAttention(metrics),
    sharedIncidentSummary(incidents.incidents, incidents.available),
    'Next actions:',
    ...nextActions(metrics, incidents.incidents),
    usageSummary(db, bucket),
  ];
  const report = lines.join('\n');
  if (Buffer.byteLength(report) <= MAX_REPORT_BYTES) return report;
  const prefix = Buffer.from(report)
    .subarray(0, MAX_REPORT_BYTES - 40)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return `${prefix}\n… report truncated at ${MAX_REPORT_BYTES} bytes.`;
}

export type DeliveryDisposition =
  | 'disabled'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'claimed'
  | 'already-sent'
  | 'already-failed'
  | 'already-unknown';
export type DeliveryResult = {
  disposition: DeliveryDisposition;
  bucket: string;
  reportRef: string | null;
  detail?: string;
};

function saveOutcome(
  db: Database,
  bucket: string,
  status: 'sent' | 'failed' | 'unknown',
  detail: string,
  now: Date,
): void {
  db.query(
    "UPDATE efficiency_report_deliveries SET status=?, finished_at=?, detail=? WHERE hour_bucket=? AND status='claimed'",
  ).run(status, now.toISOString(), detail, bucket);
}

function drainBounded(stream: Readable | null, onBytes: (bytes: number) => boolean): void {
  if (!stream) return;
  stream.on('data', (chunk: Buffer | string) => {
    if (!onBytes(Buffer.byteLength(chunk))) stream.pause();
    // The child output is deliberately discarded. No provider response or credentials enter an error or log.
  });
}

function invokeNotifier(
  argv: readonly string[],
  report: string,
  timeoutMs: number,
): Promise<{ status: 'sent' | 'failed' | 'unknown'; detail: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, [...argv.slice(1), report], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve({ status: 'failed', detail: 'notifier could not start' });
      return;
    }
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let outputBytes = 0;
    let outputLimitHit = false;
    const finish = (result: { status: 'sent' | 'failed' | 'unknown'; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const watchOutput = (bytes: number): boolean => {
      if (outputLimitHit) return false;
      outputBytes += bytes;
      if (outputBytes <= MAX_NOTIFIER_OUTPUT_BYTES) return true;
      outputLimitHit = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      killTimer.unref();
      return false;
    };
    drainBounded(child.stdout, watchOutput);
    drainBounded(child.stderr, watchOutput);
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      killTimer.unref();
      if (!settled) {
        settled = true;
        resolve({ status: 'unknown', detail: 'notifier timed out; delivery outcome unknown' });
      }
    }, timeoutMs);
    child.once('error', () => finish({ status: 'failed', detail: 'notifier could not start' }));
    child.once('close', (code, signal) => {
      if (outputLimitHit)
        finish({ status: 'unknown', detail: 'notifier output limit exceeded; delivery outcome unknown' });
      else if (code === 0 && signal === null) finish({ status: 'sent', detail: 'notifier exited successfully' });
      else if (signal === null && code !== null)
        finish({ status: 'failed', detail: `notifier exited with code ${code}` });
      else finish({ status: 'unknown', detail: 'notifier ended without a conclusive result' });
    });
  });
}

export async function sendHourlyEfficiencyReport(
  db: Database,
  bucketValue: string,
  report: string,
  notifier: readonly string[] | undefined,
  timeoutMs: number,
  now = new Date(),
): Promise<DeliveryResult> {
  const bucket = parseUtcHour(bucketValue);
  if (!notifier?.length)
    return { disposition: 'disabled', bucket: bucket.start, reportRef: null, detail: 'notifier unconfigured' };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error('invalid hourly report notifier timeout');
  const reportRef = createHash('sha256').update(report).digest('hex');
  migrate(db, efficiencyReportMigrations);
  db.transaction(() => {
    db.query(
      `INSERT OR IGNORE INTO efficiency_report_deliveries(hour_bucket, report_ref, report, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
    ).run(bucket.start, reportRef, report, now.toISOString());
  }).immediate();
  const claim = db
    .transaction(() => {
      let row = db
        .query(
          'SELECT report_ref, report, status, claimed_at, detail FROM efficiency_report_deliveries WHERE hour_bucket=?',
        )
        .get(bucket.start) as {
        report_ref: string;
        report: string;
        status: 'pending' | 'claimed' | 'sent' | 'failed' | 'unknown';
        claimed_at: string | null;
        detail: string | null;
      };
      const claimTime = row.claimed_at ? Date.parse(row.claimed_at) : Number.NaN;
      if (
        row.status === 'claimed' &&
        (!Number.isFinite(claimTime) || now.getTime() - claimTime > timeoutMs + INTERRUPTED_SEND_GRACE_MS)
      ) {
        db.query(
          `UPDATE efficiency_report_deliveries SET status='unknown', finished_at=?, detail='previous notifier outcome unknown after interruption'
           WHERE hour_bucket=? AND status='claimed'`,
        ).run(now.toISOString(), bucket.start);
        row = { ...row, status: 'unknown', detail: 'previous notifier outcome unknown after interruption' };
      }
      if (row.status === 'pending') {
        db.query(
          `UPDATE efficiency_report_deliveries SET status='claimed', claimed_at=? WHERE hour_bucket=? AND status='pending'`,
        ).run(now.toISOString(), bucket.start);
        return { row: { ...row, status: 'claimed' as const, claimed_at: now.toISOString() }, owner: true };
      }
      return { row, owner: false };
    })
    .immediate();

  const claimed = claim.row;
  if (!claim.owner) {
    const disposition: DeliveryDisposition =
      claimed.status === 'sent'
        ? 'already-sent'
        : claimed.status === 'failed'
          ? 'already-failed'
          : claimed.status === 'unknown'
            ? 'already-unknown'
            : 'claimed';
    return {
      disposition,
      bucket: bucket.start,
      reportRef: claimed.report_ref,
      ...(claimed.detail ? { detail: claimed.detail } : {}),
    };
  }

  // A successful send belongs only to this exact first persisted report; later sweeps never replace its identity.
  const outcome = await invokeNotifier(notifier, claimed.report, timeoutMs);
  saveOutcome(db, bucket.start, outcome.status, outcome.detail, new Date());
  return {
    disposition: outcome.status,
    bucket: bucket.start,
    reportRef: claimed.report_ref,
    detail: outcome.detail,
  };
}
