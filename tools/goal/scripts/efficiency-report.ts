#!/usr/bin/env bun
import { resolve, join } from 'node:path';
import { openDb } from '../src/db.ts';
import { completedUtcHour, parseUtcHour, previousUtcHours } from '../src/efficiency-report-time.ts';
import { sendHourlyEfficiencyReport } from '../src/efficiency-report-delivery.ts';
import {
  captureHourlyEfficiencyObservation,
  measureProductLineObservation,
  readFrozenHourlyEfficiencyReport,
  type HourlyPrivateDutyContext,
} from '../src/efficiency-report.ts';
import { loadSettings } from '../src/config.ts';

type Arguments = { send: boolean; scheduled: boolean; privateDuty: boolean; json: boolean; bucket?: string };

function parseArguments(args: string[]): Arguments {
  const result: Arguments = { send: false, scheduled: false, privateDuty: false, json: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--send') result.send = true;
    else if (flag === '--scheduled') result.scheduled = true;
    else if (flag === '--private-duty') result.privateDuty = true;
    else if (flag === '--json') result.json = true;
    else if (flag === '--bucket') {
      const value = args[++index];
      if (!value) throw new Error('usage: efficiency-report.ts [--send] [--bucket <UTC-hour-start>]');
      parseUtcHour(value);
      result.bucket = value;
    } else if (flag === '--help') {
      console.log(
        'Usage: bun tools/goal/scripts/efficiency-report.ts [--send] [--bucket <UTC-hour-start>] [--private-duty --json]',
      );
      process.exit(0);
    } else throw new Error('usage: efficiency-report.ts [--send] [--bucket <UTC-hour-start>]');
  }
  if (result.scheduled && !result.send) throw new Error('--scheduled requires --send');
  if (result.privateDuty && (!result.send || !result.scheduled || !result.json))
    throw new Error('--private-duty requires --send, --scheduled and --json');
  if (result.json && !result.privateDuty) throw new Error('--json requires --private-duty');
  return result;
}

function parsePrivateDutyContext(value: unknown): HourlyPrivateDutyContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid hourly private-duty context');
  const context = value as Partial<HourlyPrivateDutyContext>;
  if (
    typeof context.label !== 'string' ||
    typeof context.readyBriefs !== 'string' ||
    typeof context.allowance !== 'string' ||
    !Number.isSafeInteger(context.runningTasks) ||
    context.runningTasks! < 0 ||
    !Number.isSafeInteger(context.stoppedTasks) ||
    context.stoppedTasks! < 0 ||
    !Array.isArray(context.alarms) ||
    !context.alarms.every((alarm) => typeof alarm === 'string')
  )
    throw new Error('invalid hourly private-duty context');
  return {
    label: context.label,
    runningTasks: context.runningTasks!,
    stoppedTasks: context.stoppedTasks!,
    readyBriefs: context.readyBriefs,
    allowance: context.allowance,
    alarms: context.alarms,
  };
}

async function main(args: string[]): Promise<void> {
  const parsed = parseArguments(args);
  const settings = loadSettings();
  const db = openDb(join(settings.stateDirectory, 'goal.sqlite'), settings.policy?.storage);
  try {
    const now = new Date();
    const bucket = parsed.bucket ? parseUtcHour(parsed.bucket) : completedUtcHour(now);
    const existing = readFrozenHourlyEfficiencyReport(db, bucket.start);
    let capture: ReturnType<typeof captureHourlyEfficiencyObservation>;
    let report: string;
    if (existing) {
      capture = captureHourlyEfficiencyObservation(db, { bucket: bucket.start, policy: settings.policy, now });
      report = existing.report;
    } else if (parsed.privateDuty) {
      let input: unknown;
      try {
        input = JSON.parse(await Bun.stdin.text());
      } catch {
        throw new Error('private-duty context must be JSON on standard input');
      }
      const privateDuty = parsePrivateDutyContext(input);
      const previous = readFrozenHourlyEfficiencyReport(db, previousUtcHours(bucket.start, 1)[0]!.start);
      const productLineMeasurement = measureProductLineObservation(
        process.cwd(),
        bucket.start,
        now,
        previous?.observation.sourceRevision,
      );
      capture = captureHourlyEfficiencyObservation(db, {
        bucket: bucket.start,
        policy: settings.policy,
        now,
        productLineMeasurement,
        privateDuty,
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
      capture = captureHourlyEfficiencyObservation(db, {
        bucket: bucket.start,
        policy: settings.policy,
        now,
        productLineMeasurement,
      });
      report = capture.snapshot.report;
    }

    if (!parsed.send) {
      console.log(report);
      console.log('Delivery: dry report; not sent.');
      return;
    }
    const notifier = parsed.privateDuty
      ? [process.execPath, resolve(process.cwd(), '.temp/goal/telegram.ts'), 'text']
      : settings.integration.hourlyReportNotifier;
    const delivery = await sendHourlyEfficiencyReport(
      db,
      bucket.start,
      report,
      notifier,
      settings.integration.hourlyReportTimeoutMs,
      new Date(),
      settings.policy,
    );
    if (parsed.privateDuty) {
      console.log(
        JSON.stringify({
          bucket: bucket.start,
          capture: capture.disposition,
          attribution: capture.attribution,
          report,
          reportRef: capture.snapshot.reportRef,
          observation: capture.snapshot.observation,
          rolling: capture.snapshot.rolling,
          alerts: capture.snapshot.alerts,
          delivery,
        }),
      );
      return;
    }
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
