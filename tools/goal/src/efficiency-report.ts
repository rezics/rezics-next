import type { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { migrate } from './db.ts';
import { completedUtcHour, parseUtcHour, previousUtcHours, type UtcHour } from './efficiency-report-time.ts';
import {
  captureFrozenHourlyEfficiencyReport,
  readFrozenHourlyEfficiencyReport,
  type CaptureResult,
  type HourlyObservationData,
  type ObservationAttribution,
} from './efficiency-report-delivery.ts';
import { ensureFlow } from './flow.ts';
import { lifecycleMetrics } from './lifecycle-metrics.ts';
import { formatLifecycleMetrics } from './report.ts';
import { listOpenToolIncidents } from './tool-incidents.ts';
import { WorkerStore, workerRecordEndedAtExpression, workerRecordEndedAtMigration } from './store.ts';
import { guardEndingCounts } from './guards.ts';
import type { AttemptRecord } from './types.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
type ReportPolicy = ControlPolicy['hourlyReport'];

export const PRODUCT_LINE_FILTER_VERSION = 'rezics-product-code-v1';

export type ProductLineMeasurement = {
  productLines: number | null;
  attribution: ObservationAttribution;
  sourceRevision: string | null;
  backfillProductLines: number | null;
  backfillAttribution: ObservationAttribution;
  backfillFromRevision: string | null;
  filterVersion: string;
};

export type HourlyPrivateDutyContext = {
  label: string;
  runningTasks: number;
  stoppedTasks: number;
  readyBriefs: string;
  allowance: string;
  alarms: string[];
};

export type ReportOptions = {
  policy?: ControlPolicy | undefined;
  bucket?: string;
  now?: Date | number;
  productLineMeasurement?: ProductLineMeasurement;
  privateDuty?: HourlyPrivateDutyContext;
};

type LandingRow = {
  task_id: string;
  attempt: number;
  at: string;
  stage: string;
  action: string;
  goal: string | null;
  urgent: number | null;
  target: string | null;
  paths: string | null;
  declared_paths: string | null;
  detail: string | null;
};

type LandingTarget = 'dev' | 'stabilize' | 'main' | 'unknown';

type NormalizedLanding = {
  task_id: string;
  attempt: number;
  at: string;
  goal: string | null;
  urgent: number | null;
  target: LandingTarget;
};

type BucketSummary = {
  starts: number;
  finishes: number;
  urgentStarts: number;
  urgentFinishes: number;
  checkWaitCount: number;
  checkWaitP90: number | null;
  landingLines: string[];
};

function hasTable(db: Database, name: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function clean(value: unknown, characters: number): string {
  return (
    String(value ?? 'unknown')
      .replace(/[\r\n\t]/g, ' ')
      .trim()
      .slice(0, characters) || 'unknown'
  );
}

function unknownMeasurement(
  sourceRevision: string | null = null,
  backfillFromRevision: string | null = null,
): ProductLineMeasurement {
  return {
    productLines: null,
    attribution: 'unknown',
    sourceRevision,
    backfillProductLines: null,
    backfillAttribution: 'unknown',
    backfillFromRevision,
    filterVersion: PRODUCT_LINE_FILTER_VERSION,
  };
}

function productLineCount(
  repository: string,
  revisions: string,
  since: string | undefined,
  until: string | undefined,
  inWindow: (timestampMs: number) => boolean,
): number | null {
  const history = spawnSync(
    'git',
    [
      'log',
      revisions,
      ...(since ? [`--since=${since}`] : []),
      ...(until ? [`--until=${until}`] : []),
      '--format=tformat:__COMMIT__%ct',
      '--numstat',
    ],
    { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (history.error) throw history.error;
  if (history.status !== 0) return null;

  let includeCommit = false;
  let lines = 0;
  for (const row of history.stdout.split(/\r?\n/)) {
    if (row.startsWith('__COMMIT__')) {
      const timestamp = Number(row.slice('__COMMIT__'.length));
      if (!Number.isSafeInteger(timestamp)) return null;
      includeCommit = inWindow(timestamp * 1000);
      continue;
    }
    if (!includeCommit || !row) continue;
    const [added, , path] = row.split('\t');
    if (!path || !/^(apps|services|packages)\//.test(path)) continue;
    if (/(test|tests|stories|fixtures|recordings|generated|\.d\.ts$|\.temp\/|\.json$|\.snap)/.test(path)) continue;
    if (/^\d+$/.test(added ?? '')) lines += Number(added);
  }
  return lines;
}

/** Measure commit-date additions at one pinned dev revision using the private duty's existing path filter. */
export function measureProductLineObservation(
  repository: string,
  bucketValue: string,
  now: Date | number = Date.now(),
  previousSourceRevision?: string | null,
): ProductLineMeasurement {
  const bucket = parseUtcHour(bucketValue);
  if (completedUtcHour(now).start !== bucket.start) return unknownMeasurement();

  const head = spawnSync('git', ['rev-parse', '--verify', 'dev^{commit}'], {
    cwd: repository,
    encoding: 'utf8',
  });
  if (head.error) throw head.error;
  const revision = head.status === 0 ? head.stdout.trim() : '';
  if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(revision)) return unknownMeasurement();
  const startMs = Date.parse(bucket.start);
  const endMs = Date.parse(bucket.end);
  const lines = productLineCount(repository, revision, bucket.start, undefined, (time) => time >= startMs && time < endMs);
  if (lines === null) return unknownMeasurement(revision);
  const validPreviousRevision =
    previousSourceRevision && /^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(previousSourceRevision)
      ? previousSourceRevision
      : null;
  const backfillLines = validPreviousRevision
    ? productLineCount(
        repository,
        `${validPreviousRevision}..${revision}`,
        undefined,
        undefined,
        (time) => time < startMs,
      )
    : null;
  return {
    productLines: lines,
    attribution: 'measured',
    sourceRevision: revision,
    backfillProductLines: backfillLines,
    backfillAttribution: backfillLines === null ? 'unknown' : 'measured',
    backfillFromRevision: backfillLines === null ? null : validPreviousRevision,
    filterVersion: PRODUCT_LINE_FILTER_VERSION,
  };
}

type RollingLines = { productLines: number | null; attribution: ObservationAttribution };

function storedRollingLines(db: Database, bucket: UtcHour, current: ProductLineMeasurement): RollingLines {
  const previous = previousUtcHours(bucket.start, 1)[0]!;
  const row = db
    .query('SELECT product_lines, attribution FROM efficiency_report_deliveries WHERE hour_bucket=?')
    .get(previous.start) as { product_lines: number | null; attribution: string } | null;
  if (current.attribution !== 'measured' || current.productLines === null || !row || row.attribution !== 'measured')
    return { productLines: null, attribution: 'unknown' };
  return { productLines: current.productLines + (row.product_lines ?? 0), attribution: 'measured' };
}

function observationData(
  db: Database,
  bucket: UtcHour,
  measurement: ProductLineMeasurement,
  privateDuty: HourlyPrivateDutyContext | undefined,
  capturedAt: string,
): HourlyObservationData {
  const rolling = storedRollingLines(db, bucket, measurement);
  const alerts = [...(privateDuty?.alarms ?? [])];
  if (rolling.attribution === 'measured' && (rolling.productLines ?? 0) < 20_000)
    alerts.unshift('Two-hour product code is below the 20,000-line stable target.');
  return {
    productLines: measurement.productLines,
    attribution: measurement.attribution,
    sourceRevision: measurement.sourceRevision,
    backfillProductLines: measurement.backfillProductLines,
    backfillAttribution: measurement.backfillAttribution,
    backfillFromRevision: measurement.backfillFromRevision,
    windowStart: bucket.start,
    windowEnd: bucket.end,
    filterVersion: measurement.filterVersion,
    rollingProductLines: rolling.productLines,
    rollingAttribution: rolling.attribution,
    alerts,
    capturedAt,
  };
}

function productLineLines(bucket: UtcHour, data: HourlyObservationData): string[] {
  const attribution = data.attribution === 'measured' ? 'measured' : 'unknown';
  const source = data.sourceRevision ? `dev@${data.sourceRevision}` : 'source revision unavailable';
  const count = data.productLines === null ? 'unknown' : String(data.productLines);
  const total =
    data.rollingAttribution === 'measured' && data.rollingProductLines !== null
      ? `${data.rollingProductLines} across two frozen observations`
      : 'unknown (one or both bucket observations unavailable)';
  const backfill =
    data.backfillAttribution === 'measured' && data.backfillProductLines !== null
      ? `${data.backfillProductLines} additions newly visible since ${data.backfillFromRevision}..${data.sourceRevision}`
      : 'unknown (prior source revision unavailable)';
  return [
    `Product lines added in UTC bucket: ${count} (attribution ${attribution}; ${source}; window [${bucket.start}, ${bucket.end}); filter ${data.filterVersion}).`,
    `Product lines across this and the previous completed UTC hour: ${total}.`,
    `Late integration backfill in this bucket: ${backfill}; excluded from measured throughput.`,
    'Late integrations remain visible in their integration bucket and do not revise a frozen bucket or its measured throughput.',
  ];
}

function privateDutyLines(context: HourlyPrivateDutyContext, data: HourlyObservationData): string[] {
  const productLines = data.productLines === null ? 'unknown' : String(data.productLines);
  const rolling =
    data.rollingAttribution === 'measured' && data.rollingProductLines !== null
      ? String(data.rollingProductLines)
      : 'unknown';
  return [
    `Private hourly duty — ${context.label} UTC.`,
    `New product code: ${productLines} lines (stable target 20,000; stretch 40,000).`,
    `Product code across two completed hours: ${rolling}.`,
    `Late integration backfill: ${data.backfillAttribution === 'measured' ? data.backfillProductLines : 'unknown'} lines (excluded from throughput).`,
    `Running tasks: ${context.runningTasks}; stopped or held: ${context.stoppedTasks}.`,
    `Ready briefs:${context.readyBriefs}.`,
    `Allowance: ${context.allowance}.`,
    `Alerts: ${data.alerts.length ? data.alerts.join('; ') : 'none'}.`,
  ];
}

function targetFor(row: LandingRow): LandingTarget {
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

function normalizedLanding(row: LandingRow): NormalizedLanding {
  return {
    task_id: row.task_id,
    attempt: row.attempt,
    at: row.at,
    goal: row.goal,
    urgent: row.urgent,
    target: targetFor(row),
  };
}

function landingLines(
  rows: Map<string, NormalizedLanding>,
  hasLanding: boolean,
  urgentIdentities: string[],
  policy: ReportPolicy,
): string[] {
  const totals: Record<LandingTarget, number> = { dev: 0, stabilize: 0, main: 0, unknown: 0 };
  const goals = new Map<string, number>();
  const identities: string[] = [];
  let landingCount = 0;
  const ordered = [...rows.values()].sort((a, b) => a.at.localeCompare(b.at) || a.task_id.localeCompare(b.task_id));
  for (const row of ordered) {
    if (row.urgent === 1) continue;
    landingCount++;
    totals[row.target]++;
    const goal = clean(row.goal, policy.fieldCharacters);
    goals.set(goal, (goals.get(goal) ?? 0) + 1);
    if (identities.length < policy.landingRows)
      identities.push(`${clean(row.task_id, policy.fieldCharacters)}#${row.attempt} at ${row.at} (${row.target})`);
  }
  const perGoal = [...goals]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, policy.goalRows)
    .map(([goal, count]) => `${goal} ${count}`)
    .join(', ');
  const omittedGoals = Math.max(0, goals.size - policy.goalRows);
  const omittedLandings = Math.max(0, landingCount - identities.length);
  return [
    `Landings in UTC hour: dev ${totals.dev}; stabilize ${totals.stabilize}; main ${totals.main}; unknown ${totals.unknown} (each task counted once).`,
    `Landings by Goal: ${perGoal || (hasLanding ? 'unknown' : 'none recorded')}${omittedGoals ? `; ${omittedGoals} more Goals omitted` : ''}.`,
    `Landing identities: ${identities.join('; ') || 'none recorded'}${omittedLandings ? `; ${omittedLandings} more omitted` : ''}.`,
    `Urgent landings (excluded from throughput): ${urgentIdentities.join('; ') || 'none recorded'}.`,
  ];
}

function aggregateBucket(
  db: Database,
  bucket: UtcHour,
  available: boolean,
  tasksAvailable: boolean,
  policy: ReportPolicy,
): BucketSummary {
  const summary: BucketSummary = {
    starts: 0,
    finishes: 0,
    urgentStarts: 0,
    urgentFinishes: 0,
    checkWaitCount: 0,
    checkWaitP90: null,
    landingLines: [
      'Landings: unknown (timestamped integration history unavailable).',
      'Landing identities: unknown (timestamped integration history unavailable).',
    ],
  };
  if (!available) return summary;

  const taskJoin = tasksAvailable
    ? 'LEFT JOIN worker_tasks AS t ON t.id=e.task_id'
    : 'LEFT JOIN (SELECT NULL AS id, NULL AS body) AS t ON t.id=e.task_id';
  const landingJoin =
    tasksAvailable && hasTable(db, 'landing_queue')
      ? 'LEFT JOIN landing_queue AS l ON l.task=e.task_id AND l.attempt=e.attempt'
      : 'LEFT JOIN (SELECT NULL AS task, NULL AS attempt, NULL AS request) AS l ON l.task=e.task_id AND l.attempt=e.attempt';
  const rows = db
    .query(
      `SELECT e.task_id, e.attempt, e.stage, e.action, e.at, e.detail,
              json_extract(t.body, '$.brief.goal') AS goal,
              json_extract(t.body, '$.brief.urgent') AS urgent,
              json_extract(t.body, '$.brief.target') AS target,
              json_extract(t.body, '$.brief.paths') AS paths,
              json_extract(l.request, '$.declaredPaths') AS declared_paths
       FROM flow_events AS e INDEXED BY flow_events_at_window
       ${taskJoin}
       ${landingJoin}
       WHERE e.at >= ? AND e.at < ?
       ORDER BY e.at, e.sequence`,
    )
    .all(bucket.start, bucket.end) as LandingRow[];
  const requestedChecks = new Map<string, number>();
  const finished = new Set<string>();
  const urgentFinished = new Set<string>();
  const landings = new Map<string, NormalizedLanding>();
  const urgentLandings: string[] = [];
  const checkWaits: number[] = [];
  let hasLanding = false;
  for (const row of rows) {
    const urgent = row.urgent === 1;
    if (row.stage === 'worker' && row.action === 'started') {
      if (urgent) summary.urgentStarts++;
      else summary.starts++;
    } else if (row.stage === 'worker' && row.action === 'finished') {
      (urgent ? urgentFinished : finished).add(`${row.task_id}:${row.attempt}`);
    } else if (row.stage === 'check') {
      const key = `${row.task_id}:${row.attempt}`;
      if (row.action === 'requested') requestedChecks.set(key, Date.parse(row.at));
      else if (row.action === 'acquired') {
        const requestedAt = requestedChecks.get(key);
        const acquiredAt = Date.parse(row.at);
        if (requestedAt !== undefined && Number.isFinite(requestedAt) && acquiredAt >= requestedAt)
          checkWaits.push(acquiredAt - requestedAt);
        requestedChecks.delete(key);
      } else if (row.action === 'released') requestedChecks.delete(key);
    } else if (tasksAvailable && row.stage === 'integration' && row.action === 'integrated') {
      hasLanding = true;
      const landing = normalizedLanding(row);
      const previous = landings.get(row.task_id);
      if (!previous) {
        landings.set(row.task_id, landing);
        if (landing.urgent === 1) urgentLandings.push(`${clean(row.task_id, policy.fieldCharacters)}#${row.attempt}`);
      } else if (previous.target !== landing.target || previous.goal !== landing.goal) {
        landings.set(row.task_id, { ...previous, goal: null, target: 'unknown' });
      }
    }
  }
  summary.finishes = finished.size;
  summary.urgentFinishes = urgentFinished.size;
  checkWaits.sort((a, b) => a - b);
  summary.checkWaitCount = checkWaits.length;
  summary.checkWaitP90 = checkWaits.length ? checkWaits[Math.ceil(0.9 * checkWaits.length) - 1]! : null;
  if (tasksAvailable) summary.landingLines = landingLines(landings, hasLanding, urgentLandings, policy);
  return summary;
}

function backlogReturnsLine(db: Database, bucket: UtcHour, available: boolean): string {
  if (!available) return 'Backlog returns in bucket: unknown (flow history unavailable).';
  const row = db
    .query(
      `SELECT count(*) AS count FROM flow_events INDEXED BY flow_events_launch_window
       WHERE stage='dispatch' AND action='returned' AND at >= ? AND at < ?`,
    )
    .get(bucket.start, bucket.end) as { count: number };
  return `Backlog returns in bucket: ${row.count}.`;
}

function latestUsefulLanding(db: Database, end: string, available: boolean, policy: ReportPolicy): string {
  if (!available) return 'Last useful landing: unknown (timestamped integration history unavailable).';
  const row = db
    .query(
      `SELECT task_id, attempt, at FROM flow_events INDEXED BY flow_events_launch_window
       WHERE stage='integration' AND action='integrated' AND at < ?
       ORDER BY at DESC, sequence DESC LIMIT 1`,
    )
    .get(end) as { task_id: string; attempt: number; at: string } | null;
  return row
    ? `Last useful landing: ${clean(row.task_id, policy.fieldCharacters)}#${row.attempt} at ${row.at}.`
    : 'Last useful landing: none recorded by the report cutoff.';
}

function workSummary(db: Database, available: boolean, policy: ReportPolicy): string {
  if (!available || !hasTable(db, 'worker_tasks')) return 'Open work: unknown (current task state unavailable).';
  const rows = db
    .query(
      `SELECT json_extract(body, '$.brief.goal') AS goal, json_extract(body, '$.state') AS state, json_extract(body, '$.brief.urgent') AS urgent, count(*) AS count
       FROM worker_tasks INDEXED BY worker_tasks_state
       WHERE json_extract(body, '$.state') IN ('ready','held','running','landing')
       GROUP BY goal, state, urgent ORDER BY goal, state, urgent`,
    )
    .all() as { goal: string | null; state: string; urgent: number | null; count: number }[];
  return `Open work: ${rows.length ? rows.map((row) => `${clean(row.goal, policy.fieldCharacters)} ${row.state} ${row.count}${row.urgent === 1 ? ' [urgent]' : ''}`).join('; ') : 'none recorded'}.`;
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

function waitIdentities(
  metrics: ReturnType<typeof lifecycleMetrics> | null,
  available: boolean,
  policy: ReportPolicy,
): string {
  if (!available) return 'Current wait identities: unknown (current task state unavailable).';
  if (!metrics) return 'Current wait identities: unknown (current task state unavailable).';
  if (!metrics.waiting.entries.length) return 'Current wait identities: none recorded.';
  const entries = metrics.waiting.entries.slice(0, policy.waitRows).map((entry) => {
    const stage = entry.stage ?? entry.kind;
    const age = entry.ageMs === null ? 'age unknown' : `age ${Math.round(entry.ageMs / 60_000)}m`;
    return `${clean(entry.taskId, policy.fieldCharacters)}#${entry.attempt} ${clean(stage, policy.fieldCharacters)} (${age})`;
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

function guardEndingLine(db: Database, bucket: UtcHour): string {
  if (!hasTable(db, 'worker_records')) return 'Guard firings in bucket: unknown (attempt history unavailable).';
  migrate(db, [workerRecordEndedAtMigration]);
  const records = db
    .query(
      `SELECT body FROM worker_records INDEXED BY worker_records_ended_at
       WHERE ${workerRecordEndedAtExpression} >= ? AND ${workerRecordEndedAtExpression} < ?`,
    )
    .all(bucket.start, bucket.end)
    .map((row) => JSON.parse((row as { body: string }).body) as AttemptRecord);
  const counts = guardEndingCounts(records, bucket.start, bucket.end);
  return counts.length
    ? `Guard firings in bucket: ${counts.map(({ guardId, firings }) => `${guardId} ${firings}`).join('; ')}.`
    : 'Guard firings in bucket: none recorded.';
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

function operatorAttention(metrics: ReturnType<typeof lifecycleMetrics> | null, policy: ReportPolicy): string {
  if (!metrics)
    return 'Current incidents: unknown (current task state unavailable); unavailable evidence: orphaned landings, promotion timing, quarantine history.';
  const incidents: string[] = [];
  const unavailable: string[] = [];
  const summarize = (values: string[]) =>
    values.length > policy.incidentTaskExamples
      ? `${values.slice(0, policy.incidentTaskExamples).join(', ')} (+${values.length - policy.incidentTaskExamples} more)`
      : values.join(', ');

  const orphaned = metrics.orphanedLandings;
  if (!orphaned.available || orphaned.count === null) unavailable.push('orphaned landing history');
  else if (orphaned.count > 0) {
    const taskIds = [...new Set(orphaned.taskIds.map((value) => clean(value, policy.fieldCharacters)))];
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
      const key = `${clean(row.taskId, policy.fieldCharacters)}/${row.attempt}`;
      const causes = byTask.get(key) ?? new Set<string>();
      causes.add(clean(row.cause, policy.fieldCharacters));
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

function sharedIncidentSummary(
  incidents: ReturnType<typeof listOpenToolIncidents>,
  available: boolean,
  policy: ReportPolicy,
): string {
  if (!available) return 'Shared tool incidents: unknown (incident history unavailable).';
  if (!incidents.length) return 'Shared tool incidents: none open.';
  const rows = incidents.slice(0, policy.incidentRows).map((incident) => {
    const tasks = incident.exampleTasks
      .map((task) => `${clean(task.taskId, policy.fieldCharacters)}#${task.attempt}`)
      .join(', ');
    return `${clean(incident.line, policy.fieldCharacters)}; probe ${clean(incident.probe.taskId, policy.fieldCharacters)}#${incident.probe.attempt}${tasks ? `; examples ${tasks}` : ''}`;
  });
  const omitted = incidents.length - rows.length;
  return `Shared tool incidents: ${rows.join(' | ')}${omitted ? ` | ${omitted} more omitted` : ''}.`;
}

function nextActions(
  metrics: ReturnType<typeof lifecycleMetrics> | null,
  incidents: ReturnType<typeof listOpenToolIncidents>,
  policy: ReportPolicy,
): string[] {
  const actions: string[] = [];
  if (metrics) {
    const orphaned = metrics.orphanedLandings;
    if (orphaned.available && (orphaned.count ?? 0) > 0 && orphaned.taskIds[0])
      actions.push(
        `Inspect orphaned landing ${clean(orphaned.taskIds[0], policy.fieldCharacters)} with Goal status before retrying it.`,
      );
    if (metrics.promotion.available && ['blocked', 'stabilize-blocked'].includes(metrics.promotion.phase ?? ''))
      actions.push('Resolve the recorded promotion gate or blocker, then run Goal promote.');
    const oldestWait = metrics.waiting.entries[0];
    if (oldestWait)
      actions.push(
        `Inspect ${clean(oldestWait.taskId, policy.fieldCharacters)}#${oldestWait.attempt} (${clean(oldestWait.stage ?? oldestWait.kind, policy.fieldCharacters)}) with Goal status.`,
      );
    const firstQuarantine = metrics.quarantines.current?.[0];
    if (firstQuarantine)
      actions.push(
        `Review quarantined task ${clean(firstQuarantine.taskId, policy.fieldCharacters)}#${firstQuarantine.attempt} before retrying it.`,
      );
  }
  const incident = incidents[0];
  if (incident)
    actions.push(
      `Review the shared blocker at probe ${clean(incident.probe.taskId, policy.fieldCharacters)}#${incident.probe.attempt}; delivery operations owns follow-up.`,
    );
  return actions.length ? actions.map((action, index) => `${index + 1}. ${action}`) : ['None from recorded evidence.'];
}

function buildHourlyEfficiencyReport(
  db: Database,
  options: ReportOptions,
  bucket: UtcHour,
  observation: HourlyObservationData,
): string {
  const policy = (options.policy ?? defaultPolicy).hourlyReport;
  const flowAvailable = hasTable(db, 'flow_events');
  if (flowAvailable) ensureFlow(db);
  const asOf = options.now ?? Date.now();
  const openWorkAvailable = hasTable(db, 'worker_tasks');
  const metrics = openWorkAvailable ? lifecycleMetrics(db, asOf, options.policy) : null;
  const bucketSummary = aggregateBucket(db, bucket, flowAvailable, openWorkAvailable, policy);
  const checkWaitLine = !flowAvailable
    ? 'Check-slot wait in bucket: unknown (flow history unavailable).'
    : bucketSummary.checkWaitCount
      ? `Check-slot wait in bucket: ${bucketSummary.checkWaitCount} completed request/acquire pairs; p90 ${bucketSummary.checkWaitP90 === null ? 'unknown' : `${Math.round(bucketSummary.checkWaitP90 / 60_000)}m`}.`
      : 'Check-slot wait in bucket: unknown (no completed wait pair recorded).';
  const lifetimeLines = metrics ? formatLifecycleMetrics(metrics) : [];
  const launchTaskLines = lifetimeLines.filter((line) => line.startsWith('  '));
  const aggregateLines = lifetimeLines.filter((line) => !line.startsWith('  '));
  const lifecycleLines = metrics
    ? [
        flowAvailable
          ? (aggregateLines[0] ?? 'Launches in trailing hour: unknown.')
          : 'Launches in trailing hour: unknown (flow history unavailable).',
        ...launchTaskLines.slice(0, policy.launchRows),
        ...(launchTaskLines.length > policy.launchRows
          ? [`  … ${launchTaskLines.length - policy.launchRows} additional task rows.`]
          : []),
        ...aggregateLines.slice(1),
      ]
    : [
        'Launches in trailing hour: unknown (current task state unavailable).',
        'Current waits: unknown (current task state unavailable).',
        'Orphaned landings: unknown (current task state unavailable).',
        'Quarantines: unknown (current task state unavailable).',
      ];
  const landed = bucketSummary.landingLines;
  const incidents = sharedIncidentLine(db);
  const waitsAvailable = openWorkAvailable;
  const landingQueueAvailable = flowAvailable && openWorkAvailable && hasTable(db, 'landing_queue');
  const lines = [
    `Hourly operations report — ${bucket.start} to ${bucket.end} UTC`,
    ...productLineLines(bucket, observation),
    ...(options.privateDuty ? privateDutyLines(options.privateDuty, observation) : []),
    ...landed,
    latestUsefulLanding(db, bucket.end, flowAvailable, policy),
    backlogReturnsLine(db, bucket, flowAvailable),
    flowAvailable
      ? `Worker starts / finishes in bucket: ${bucketSummary.starts} starts (including resumes) / ${bucketSummary.finishes} finished attempts.`
      : 'Worker starts / finishes in bucket: unknown (flow history unavailable).',
    flowAvailable && openWorkAvailable
      ? `Urgent worker starts / finishes in bucket (excluded from throughput): ${bucketSummary.urgentStarts} / ${bucketSummary.urgentFinishes}.`
      : 'Urgent worker starts / finishes in bucket: unknown (task or flow history unavailable).',
    workSummary(db, openWorkAvailable, policy),
    landingQueueAge(metrics, landingQueueAvailable),
    waitIdentities(metrics, waitsAvailable, policy),
    checkWaitLine,
    ...lifecycleLines,
    promotionSummary(db, metrics),
    operatorAttention(metrics, policy),
    sharedIncidentSummary(incidents.incidents, incidents.available, policy),
    guardEndingLine(db, bucket),
    'Next actions:',
    ...nextActions(metrics, incidents.incidents, policy),
    usageSummary(db, bucket),
  ];
  const report = lines.join('\n');
  if (Buffer.byteLength(report) <= policy.reportBytes) return report;
  const suffix = Buffer.from(`\n… report truncated at ${policy.reportBytes} bytes.`);
  // Reserve the encoded suffix, including when an operator requests less than one full marker.
  const prefix = Buffer.from(report).subarray(0, Math.max(0, policy.reportBytes - suffix.length));
  return (
    prefix.toString('utf8').replace(/\uFFFD$/, '') +
    suffix
      .subarray(0, policy.reportBytes)
      .toString('utf8')
      .replace(/\uFFFD$/, '')
  );
}

/** Capture one immutable report and its measured product-line provenance for a completed UTC bucket. */
export function captureHourlyEfficiencyObservation(db: Database, options: ReportOptions): CaptureResult {
  const bucket = options.bucket ? parseUtcHour(options.bucket) : completedUtcHour(options.now);
  const existing = readFrozenHourlyEfficiencyReport(db, bucket.start);
  const candidate = options.productLineMeasurement
    ? {
        ...options.productLineMeasurement,
        windowStart: bucket.start,
        windowEnd: bucket.end,
      }
    : undefined;
  if (existing && !candidate) return { disposition: 'replayed', snapshot: existing };

  const asOf = options.now ?? Date.now();
  const capturedAt = (asOf instanceof Date ? asOf : new Date(asOf)).toISOString();
  return captureFrozenHourlyEfficiencyReport(
    db,
    bucket.start,
    candidate,
    () => {
      const measurement = options.productLineMeasurement ?? unknownMeasurement();
      const observation = observationData(db, bucket, measurement, options.privateDuty, capturedAt);
      if (
        observation.attribution === 'measured' &&
        (!Number.isSafeInteger(observation.productLines) || observation.productLines! < 0 || !observation.sourceRevision)
      )
        throw new Error('measured hourly observation requires product lines and a source revision');
      return observation;
    },
    (observation) => buildHourlyEfficiencyReport(db, options, bucket, observation),
  );
}

export async function renderHourlyEfficiencyReport(db: Database, options: ReportOptions): Promise<string> {
  return captureHourlyEfficiencyObservation(db, options).snapshot.report;
}

export { efficiencyReportMigrations, sendHourlyEfficiencyReport } from './efficiency-report-delivery.ts';
export { readFrozenHourlyEfficiencyReport };
export type { DeliveryDisposition, DeliveryResult } from './efficiency-report-delivery.ts';
export { completedUtcHour, parseUtcHour, previousUtcHours };
export type { UtcHour } from './efficiency-report-time.ts';
export type {
  CaptureDisposition,
  CaptureResult,
  FrozenHourlyEfficiencyReport,
  ObservationAttribution,
} from './efficiency-report-delivery.ts';
