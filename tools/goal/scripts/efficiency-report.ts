#!/usr/bin/env bun
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { completedUtcHour, parseUtcHour, renderHourlyEfficiencyReport, sendHourlyEfficiencyReport } from '../src/efficiency-report.ts';
import { loadSettings } from '../src/config.ts';

type Arguments = { send: boolean; scheduled: boolean; bucket?: string };

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
      console.log('Usage: bun tools/goal/scripts/efficiency-report.ts [--send] [--bucket <UTC-hour-start>]');
      process.exit(0);
    } else throw new Error('usage: efficiency-report.ts [--send] [--bucket <UTC-hour-start>]');
  }
  if (result.scheduled && !result.send) throw new Error('--scheduled requires --send');
  return result;
}

async function main(args: string[]): Promise<void> {
  const parsed = parseArguments(args);
  const settings = loadSettings();
  const db = openDb(join(settings.stateDirectory, 'goal.sqlite'));
  try {
    const bucket = parsed.bucket ? parseUtcHour(parsed.bucket) : completedUtcHour();
    const report = await renderHourlyEfficiencyReport(db, {
      bucket: bucket.start,
    });
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
