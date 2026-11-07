import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Database } from 'bun:sqlite';
import { migrate } from './db.ts';
import { parseUtcHour } from './efficiency-report-time.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';

type ReportPolicy = ControlPolicy['hourlyReport'];
export type ObservationAttribution = 'measured' | 'unknown';
export type CaptureDisposition = 'captured' | 'replayed' | 'conflicting';

export type HourlyObservationData = {
  productLines: number | null;
  attribution: ObservationAttribution;
  sourceRevision: string | null;
  backfillProductLines: number | null;
  backfillAttribution: ObservationAttribution;
  backfillFromRevision: string | null;
  windowStart: string;
  windowEnd: string;
  filterVersion: string;
  rollingProductLines: number | null;
  rollingAttribution: ObservationAttribution;
  alerts: string[];
  capturedAt: string;
};

export type FrozenHourlyEfficiencyReport = {
  bucket: string;
  report: string;
  reportRef: string;
  status: 'pending' | 'claimed' | 'sent' | 'failed' | 'unknown';
  observation: {
    productLines: number | null;
    attribution: ObservationAttribution;
    sourceRevision: string | null;
    backfillProductLines: number | null;
    backfillAttribution: ObservationAttribution;
    backfillFromRevision: string | null;
    windowStart: string;
    windowEnd: string;
    filterVersion: string;
    capturedAt: string;
  };
  rolling: { productLines: number | null; attribution: ObservationAttribution };
  alerts: string[];
  conflict: ConflictingAttribution | null;
};

export type ConflictingAttribution = {
  reportRef: string;
  observedAt: string;
  productLines: number | null;
  attribution: ObservationAttribution;
  sourceRevision: string | null;
  backfillProductLines: number | null;
  backfillAttribution: ObservationAttribution;
  backfillFromRevision: string | null;
  windowStart: string;
  windowEnd: string;
  filterVersion: string;
};

export type CaptureResult = {
  disposition: CaptureDisposition;
  attribution: ObservationAttribution | 'conflicting';
  snapshot: FrozenHourlyEfficiencyReport;
};

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
  {
    module: 'efficiency-report',
    version: 2,
    sql: `ALTER TABLE efficiency_report_deliveries ADD COLUMN product_lines INTEGER;
ALTER TABLE efficiency_report_deliveries ADD COLUMN attribution TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE efficiency_report_deliveries ADD COLUMN source_revision TEXT;
ALTER TABLE efficiency_report_deliveries ADD COLUMN source_window_start TEXT;
ALTER TABLE efficiency_report_deliveries ADD COLUMN source_window_end TEXT;
ALTER TABLE efficiency_report_deliveries ADD COLUMN filter_version TEXT NOT NULL DEFAULT 'unavailable';
ALTER TABLE efficiency_report_deliveries ADD COLUMN captured_at TEXT;
ALTER TABLE efficiency_report_deliveries ADD COLUMN rolling_product_lines INTEGER;
ALTER TABLE efficiency_report_deliveries ADD COLUMN rolling_attribution TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE efficiency_report_deliveries ADD COLUMN alerts_json TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    module: 'efficiency-report',
    version: 3,
    sql: `ALTER TABLE efficiency_report_deliveries ADD COLUMN backfill_product_lines INTEGER;
ALTER TABLE efficiency_report_deliveries ADD COLUMN backfill_attribution TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE efficiency_report_deliveries ADD COLUMN backfill_from_revision TEXT;`,
  },
  {
    module: 'efficiency-report',
    version: 4,
    sql: `CREATE TABLE efficiency_report_observation_conflicts (
      hour_bucket TEXT PRIMARY KEY,
      report_ref TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      product_lines INTEGER,
      attribution TEXT NOT NULL,
      source_revision TEXT,
      backfill_product_lines INTEGER,
      backfill_attribution TEXT NOT NULL,
      backfill_from_revision TEXT,
      source_window_start TEXT NOT NULL,
      source_window_end TEXT NOT NULL,
      filter_version TEXT NOT NULL
    );`,
  },
] as const;

type DeliveryRow = {
  hour_bucket: string;
  report_ref: string;
  report: string;
  status: FrozenHourlyEfficiencyReport['status'];
  claimed_at: string | null;
  finished_at: string | null;
  detail: string | null;
  product_lines: number | null;
  attribution: ObservationAttribution;
  source_revision: string | null;
  source_window_start: string | null;
  source_window_end: string | null;
  filter_version: string;
  backfill_product_lines: number | null;
  backfill_attribution: ObservationAttribution;
  backfill_from_revision: string | null;
  captured_at: string | null;
  rolling_product_lines: number | null;
  rolling_attribution: ObservationAttribution;
  alerts_json: string;
};

function deliveryRow(db: Database, bucket: string): DeliveryRow | null {
  return (db
    .query(
      `SELECT hour_bucket, report_ref, report, status, claimed_at, finished_at, detail,
              product_lines, attribution, source_revision, backfill_product_lines,
              backfill_attribution, backfill_from_revision,
              source_window_start, source_window_end, filter_version, captured_at,
              rolling_product_lines, rolling_attribution, alerts_json
       FROM efficiency_report_deliveries WHERE hour_bucket=?`,
    )
    .get(bucket) as DeliveryRow | null);
}

function snapshot(db: Database, row: DeliveryRow): FrozenHourlyEfficiencyReport {
  const conflict = db
    .query(
      `SELECT report_ref, observed_at, product_lines, attribution, source_revision,
              backfill_product_lines, backfill_attribution, backfill_from_revision,
              source_window_start, source_window_end, filter_version
       FROM efficiency_report_observation_conflicts WHERE hour_bucket=?`,
    )
    .get(row.hour_bucket) as {
    report_ref: string;
    observed_at: string;
    product_lines: number | null;
    attribution: ObservationAttribution;
    source_revision: string | null;
    backfill_product_lines: number | null;
    backfill_attribution: ObservationAttribution;
    backfill_from_revision: string | null;
    source_window_start: string;
    source_window_end: string;
    filter_version: string;
  } | null;
  return {
    bucket: row.hour_bucket,
    report: row.report,
    reportRef: row.report_ref,
    status: row.status,
    observation: {
      productLines: row.product_lines,
      attribution: row.attribution === 'measured' ? 'measured' : 'unknown',
      sourceRevision: row.source_revision,
      backfillProductLines: row.backfill_product_lines,
      backfillAttribution: row.backfill_attribution === 'measured' ? 'measured' : 'unknown',
      backfillFromRevision: row.backfill_from_revision,
      windowStart: row.source_window_start ?? row.hour_bucket,
      windowEnd: row.source_window_end ?? parseUtcHour(row.hour_bucket).end,
      filterVersion: row.filter_version,
      capturedAt: row.captured_at ?? row.hour_bucket,
    },
    rolling: {
      productLines: row.rolling_product_lines,
      attribution: row.rolling_attribution === 'measured' ? 'measured' : 'unknown',
    },
    alerts: JSON.parse(row.alerts_json) as string[],
    conflict: conflict
      ? {
          reportRef: conflict.report_ref,
          observedAt: conflict.observed_at,
          productLines: conflict.product_lines,
          attribution: conflict.attribution,
          sourceRevision: conflict.source_revision,
          backfillProductLines: conflict.backfill_product_lines,
          backfillAttribution: conflict.backfill_attribution,
          backfillFromRevision: conflict.backfill_from_revision,
          windowStart: conflict.source_window_start,
          windowEnd: conflict.source_window_end,
          filterVersion: conflict.filter_version,
        }
      : null,
  };
}

export function readFrozenHourlyEfficiencyReport(
  db: Database,
  bucketValue: string,
): FrozenHourlyEfficiencyReport | null {
  const bucket = parseUtcHour(bucketValue);
  migrate(db, efficiencyReportMigrations);
  const row = deliveryRow(db, bucket.start);
  return row ? snapshot(db, row) : null;
}

type ObservationCandidate = Pick<
  HourlyObservationData,
  | 'productLines'
  | 'attribution'
  | 'sourceRevision'
  | 'backfillProductLines'
  | 'backfillAttribution'
  | 'backfillFromRevision'
  | 'windowStart'
  | 'windowEnd'
  | 'filterVersion'
>;

function sameObservation(left: DeliveryRow, right: ObservationCandidate): boolean {
  return (
    left.product_lines === right.productLines &&
    left.attribution === right.attribution &&
    left.source_revision === right.sourceRevision &&
    left.backfill_product_lines === right.backfillProductLines &&
    left.backfill_attribution === right.backfillAttribution &&
    left.backfill_from_revision === right.backfillFromRevision &&
    left.source_window_start === right.windowStart &&
    left.source_window_end === right.windowEnd &&
    left.filter_version === right.filterVersion
  );
}

/** The observation and rendered report claim one UTC bucket in the same first-write transaction. */
export function captureFrozenHourlyEfficiencyReport(
  db: Database,
  bucketValue: string,
  candidate: ObservationCandidate | undefined,
  createObservation: () => HourlyObservationData,
  render: (observation: HourlyObservationData) => string,
): CaptureResult {
  const bucket = parseUtcHour(bucketValue);
  migrate(db, efficiencyReportMigrations);

  return db
    .transaction(() => {
      const existing = deliveryRow(db, bucket.start);
      if (existing) {
        if (!candidate || sameObservation(existing, candidate))
          return {
            disposition: 'replayed' as const,
            attribution: existing.attribution === 'measured' ? ('measured' as const) : ('unknown' as const),
            snapshot: snapshot(db, existing),
          };
        db.query(
          `INSERT OR IGNORE INTO efficiency_report_observation_conflicts(
            hour_bucket, report_ref, observed_at, product_lines, attribution, source_revision,
            backfill_product_lines, backfill_attribution, backfill_from_revision,
            source_window_start, source_window_end, filter_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          bucket.start,
          existing.report_ref,
          new Date().toISOString(),
          candidate.productLines,
          candidate.attribution,
          candidate.sourceRevision,
          candidate.backfillProductLines,
          candidate.backfillAttribution,
          candidate.backfillFromRevision,
          candidate.windowStart,
          candidate.windowEnd,
          candidate.filterVersion,
        );
        return {
          disposition: 'conflicting' as const,
          attribution: 'conflicting' as const,
          snapshot: snapshot(db, existing),
        };
      }

      const observation = createObservation();
      if (observation.windowStart !== bucket.start || observation.windowEnd !== bucket.end)
        throw new Error('hourly observation window must match its UTC bucket');
      if (
        observation.attribution === 'measured' &&
        (!Number.isSafeInteger(observation.productLines) || observation.productLines! < 0 || !observation.sourceRevision)
      )
        throw new Error('measured hourly observation requires product lines and a source revision');
      if (
        observation.backfillAttribution === 'measured' &&
        (!Number.isSafeInteger(observation.backfillProductLines) ||
          observation.backfillProductLines! < 0 ||
          !observation.backfillFromRevision)
      )
        throw new Error('measured integration backfill requires product lines and a prior source revision');
      const report = render(observation);
      const reportRef = createHash('sha256').update(report).digest('hex');
      db.query(
        `INSERT INTO efficiency_report_deliveries(
          hour_bucket, report_ref, report, status, created_at,
          product_lines, attribution, source_revision, backfill_product_lines, backfill_attribution,
          backfill_from_revision, source_window_start, source_window_end,
          filter_version, captured_at, rolling_product_lines, rolling_attribution, alerts_json
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        bucket.start,
        reportRef,
        report,
        observation.capturedAt,
        observation.productLines,
        observation.attribution,
        observation.sourceRevision,
        observation.backfillProductLines,
        observation.backfillAttribution,
        observation.backfillFromRevision,
        observation.windowStart,
        observation.windowEnd,
        observation.filterVersion,
        observation.capturedAt,
        observation.rollingProductLines,
        observation.rollingAttribution,
        JSON.stringify(observation.alerts),
      );
      const inserted = deliveryRow(db, bucket.start)!;
      return {
        disposition: 'captured' as const,
        attribution: observation.attribution,
        snapshot: snapshot(db, inserted),
      };
    })
    .immediate();
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
  policy: ReportPolicy,
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
      if (outputBytes <= policy.notifierOutputBytes) return true;
      outputLimitHit = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), policy.notifierTerminationGraceMs);
      killTimer.unref();
      return false;
    };
    drainBounded(child.stdout, watchOutput);
    drainBounded(child.stderr, watchOutput);
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), policy.notifierTerminationGraceMs);
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
  policy: ControlPolicy = defaultPolicy,
): Promise<DeliveryResult> {
  const bucket = parseUtcHour(bucketValue);
  if (!notifier?.length)
    return { disposition: 'disabled', bucket: bucket.start, reportRef: null, detail: 'notifier unconfigured' };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > policy.validation.hourlyReportMaxTimeoutMs)
    throw new Error('invalid hourly report notifier timeout');
  migrate(db, efficiencyReportMigrations);
  const proposedRef = createHash('sha256').update(report).digest('hex');
  db.transaction(() => {
    if (deliveryRow(db, bucket.start)) return;
    if (Buffer.byteLength(report) > policy.hourlyReport.reportBytes)
      throw new Error(`hourly report exceeds ${policy.hourlyReport.reportBytes} byte storage limit`);
    db.query(
      `INSERT INTO efficiency_report_deliveries(hour_bucket, report_ref, report, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
    ).run(bucket.start, proposedRef, report, now.toISOString());
  }).immediate();
  const claim = db
    .transaction(() => {
      let row = db
        .query('SELECT report_ref, report, status, claimed_at, detail FROM efficiency_report_deliveries WHERE hour_bucket=?')
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
        (!Number.isFinite(claimTime) ||
          now.getTime() - claimTime > timeoutMs + policy.hourlyReport.interruptedSendGraceMs)
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
  const outcome = await invokeNotifier(notifier, claimed.report, timeoutMs, policy.hourlyReport);
  saveOutcome(db, bucket.start, outcome.status, outcome.detail, new Date());
  return {
    disposition: outcome.status,
    bucket: bucket.start,
    reportRef: claimed.report_ref,
    detail: outcome.detail,
  };
}
