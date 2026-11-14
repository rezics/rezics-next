import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { migrate, openDb } from './db.ts';
import { efficiencyReportMigrations, readFrozenHourlyEfficiencyReport } from './efficiency-report.ts';
import { temporaryDirectory } from './test-support.ts';

test('Web attribution migration leaves historical report bytes frozen and unknown', () => {
  const directory = temporaryDirectory();
  const db = openDb(join(directory.path, 'goal.sqlite'));
  const bucket = '2026-10-31T01:00:00.000Z';
  const report = 'historical frozen report';
  try {
    migrate(db, efficiencyReportMigrations.slice(0, 4));
    db.query(
      `INSERT INTO efficiency_report_deliveries(
        hour_bucket, report_ref, report, status, created_at, product_lines, attribution, source_revision,
        source_window_start, source_window_end, filter_version, captured_at, rolling_product_lines,
        rolling_attribution, alerts_json
      ) VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bucket,
      'a'.repeat(64),
      report,
      '2026-10-31T02:05:00.000Z',
      123,
      'measured',
      'b'.repeat(40),
      bucket,
      '2026-10-31T02:00:00.000Z',
      'rezics-product-code-v2',
      '2026-10-31T02:05:00.000Z',
      null,
      'unknown',
      '[]',
    );

    const snapshot = readFrozenHourlyEfficiencyReport(db, bucket)!;
    expect(snapshot.report).toBe(report);
    expect(snapshot.reportRef).toBe('a'.repeat(64));
    expect(snapshot.observation).toMatchObject({
      productLines: 123,
      attribution: 'measured',
      webProductLines: null,
      webAttribution: 'unknown',
    });
  } finally {
    db.close();
    directory.close();
  }
});
