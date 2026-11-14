#!/usr/bin/env bun
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { completedUtcHour, parseUtcHour, previousUtcHours, type UtcHour } from '../src/efficiency-report-time.ts';
import { sendHourlyEfficiencyReport } from '../src/efficiency-report-delivery.ts';
import {
  captureHourlyEfficiencyObservation,
  measureProductLineObservation,
  readFrozenHourlyEfficiencyReport,
  renderHourlyEfficiencyReport,
} from '../src/efficiency-report.ts';
import { loadSettings } from '../src/config.ts';

type Arguments = { send: boolean; scheduled: boolean; bucket?: string };

export function assertHourlyEfficiencyBucketEnded(bucket: UtcHour, now: Date): void {
  if (Date.parse(bucket.end) > now.getTime())
    throw new Error(`cannot send an hourly efficiency report for unfinished UTC bucket ${bucket.start}`);
}

function parseArguments(args: string[]): Arguments {
  const result: Arguments = { send: false, scheduled: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--send') result.send = true;
    else if (flag === '--scheduled') result.scheduled = true;
    else if (flag === '--bucket') {
      const value = args[++index];
      if (!value) throw new Error('usage: efficiency-report.ts [--send] [--bucket <UTC-hour-start>]');
      parseUtcHour(value);
      result.bucket = value;
    } else if (flag === '--help') {
      console.log(
        'Usage: bun tools/goal/scripts/efficiency-report.ts [--send] [--bucket <UTC-hour-start>] [--send --scheduled]',
      );
      process.exit(0);
    } else throw new Error('usage: efficiency-report.ts [--send] [--bucket <UTC-hour-start>]');
  }
  if (result.scheduled && !result.send) throw new Error('--scheduled requires --send');
  return result;
}

async function main(args: string[]): Promise<void> {
  const parsed = parseArguments(args);
  const now = new Date();
  const bucket = parsed.bucket ? parseUtcHour(parsed.bucket) : completedUtcHour(now);
  if (parsed.send) assertHourlyEfficiencyBucketEnded(bucket, now);

  const settings = loadSettings();
  const db = openDb(join(settings.stateDirectory, 'goal.sqlite'), settings.policy?.storage);
  try {
    const existing = readFrozenHourlyEfficiencyReport(db, bucket.start);
    let report: string;
    if (existing) {
      report = existing.report;
    } else if (parsed.send) {
      const previous = readFrozenHourlyEfficiencyReport(db, previousUtcHours(bucket.start, 1)[0]!.start);
      const productLineMeasurement = measureProductLineObservation(
        process.cwd(),
        bucket.start,
        now,
        previous?.observation.sourceRevision,
      );
      const capture = captureHourlyEfficiencyObservation(db, {
        bucket: bucket.start,
        policy: settings.policy,
        now,
        productLineMeasurement,
      });
      report = capture.snapshot.report;
    } else {
      const previous = readFrozenHourlyEfficiencyReport(db, previousUtcHours(bucket.start, 1)[0]!.start);
      const productLineMeasurement = measureProductLineObservation(
        process.cwd(),
        bucket.start,
        now,
        previous?.observation.sourceRevision,
      );
      report = await renderHourlyEfficiencyReport(db, {
        bucket: bucket.start,
        policy: settings.policy,
        now,
        productLineMeasurement,
      });
    }

    if (!parsed.send) {
      console.log(report);
      console.log('Delivery: dry report; not sent.');
      return;
    }
    const delivery = await sendHourlyEfficiencyReport(
      db,
      bucket.start,
      report,
      settings.integration.hourlyReportNotifier,
      settings.integration.hourlyReportTimeoutMs,
      new Date(),
      settings.policy,
      parsed.scheduled
        ? { managerId: settings.integration.supermanager, stateDirectory: settings.stateDirectory }
        : undefined,
    );
    const detail = delivery.detail ? ` (${delivery.detail})` : '';
    const disposition = `Delivery: ${delivery.disposition}${detail}.`;
    console.log(parsed.scheduled ? disposition : `${report}\n${disposition}`);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    const detail = error instanceof Error ? error.message : 'unknown failure';
    console.error(`Hourly efficiency report failed: ${detail}`);
    process.exitCode = 1;
  });
}
