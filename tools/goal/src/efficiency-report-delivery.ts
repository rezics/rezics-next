import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Database } from 'bun:sqlite';
import { migrate } from './db.ts';
import { parseUtcHour } from './efficiency-report-time.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';

type ReportPolicy = ControlPolicy['hourlyReport'];

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
