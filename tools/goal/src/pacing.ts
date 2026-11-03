import { agentAdapter } from './agents.ts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveReserve } from './allowance.ts';
import type { Pool, PoolReading } from './types.ts';

// Allowances run out on calendars: Claude's week resets on a fixed time and its five-hour window caps how fast it can
// be spent, and Codex is reset early and often without notice. Unused allowance at a reset is lost, so work goes first
// to the allowance that would otherwise expire unused, the way a person spends what expires first.

/** A reset that the Codex team has announced ahead, from codex-resets.com, if any. */
export type CodexSchedule = { scheduledAt: string | null; latestResetAt: string | null; fetchedAt: string };

const SCHEDULE_FILE = 'codex-schedule.json';
const SCHEDULE_REFRESH_MS = 30 * 60_000;

function optionalTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function asCodexSchedule(value: unknown): CodexSchedule | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { scheduledAt?: unknown; latestResetAt?: unknown; fetchedAt?: unknown };
  const fetchedAt = optionalTimestamp(record.fetchedAt);
  const scheduledAt = optionalTimestamp(record.scheduledAt);
  const latestResetAt = optionalTimestamp(record.latestResetAt);
  if (typeof fetchedAt !== 'string' || scheduledAt === undefined || latestResetAt === undefined) return undefined;
  return { scheduledAt, latestResetAt, fetchedAt };
}

function isFresh(schedule: CodexSchedule, now: number): boolean {
  const fetchedAt = Date.parse(schedule.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  const age = now - fetchedAt;
  return age >= 0 && age < SCHEDULE_REFRESH_MS;
}

export function readCodexSchedule(stateDirectory: string): CodexSchedule | undefined {
  try {
    const path = join(stateDirectory, SCHEDULE_FILE);
    return existsSync(path) ? asCodexSchedule(JSON.parse(readFileSync(path, 'utf8'))) : undefined;
  } catch {
    return undefined;
  }
}

/** Publish a complete schedule through a unique temporary file so concurrent refreshes cannot share a write identity. */
export function publishCodexSchedule(stateDirectory: string, schedule: CodexSchedule): void {
  const path = join(stateDirectory, SCHEDULE_FILE);
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(schedule, null, 2));
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* Keep the last complete published schedule. */
    }
    throw error;
  }
}

function fetchCodexStatus(): string | undefined {
  const response = spawnSync('curl', ['-sf', '-m', '15', 'https://codex-resets.com/api/v1/status'], {
    encoding: 'utf8',
  });
  return response.status === 0 ? response.stdout : undefined;
}

export function parseCodexStatus(body: string, now: number): CodexSchedule {
  // The API names the announced time scheduled_for; reading only scheduled_at missed the reset announced at 02:42 UTC
  // on 2026-10-28 for 07:00, so pacing never hurried the expiring allowance.
  const data =
    (
      JSON.parse(body) as {
        data?: {
          scheduled_reset?:
            | { scheduled_for?: string; scheduled_at?: string; at?: string; status?: string }
            | string
            | null;
          latest_reset?: { announced_at?: string } | null;
        };
      }
    ).data ?? {};
  const scheduled = data.scheduled_reset;
  const scheduledAt =
    typeof scheduled === 'string'
      ? scheduled
      : scheduled && (scheduled.status === undefined || scheduled.status === 'scheduled')
        ? (scheduled.scheduled_for ?? scheduled.scheduled_at ?? scheduled.at ?? null)
        : null;
  const announcedAt = data.latest_reset?.announced_at;
  return {
    scheduledAt: scheduledAt && Number.isFinite(Date.parse(scheduledAt)) ? scheduledAt : null,
    latestResetAt: typeof announcedAt === 'string' && Number.isFinite(Date.parse(announcedAt)) ? announcedAt : null,
    fetchedAt: new Date(now).toISOString(),
  };
}

/** Refresh the announced Codex schedule at most every half hour; returns the schedule now known. */
export function refreshCodexSchedule(
  stateDirectory: string,
  now = Date.now(),
  fetchStatus: () => string | undefined = fetchCodexStatus,
): CodexSchedule | undefined {
  const current = readCodexSchedule(stateDirectory);
  if (current && isFresh(current, now)) return current;
  const body = fetchStatus();
  if (body === undefined) return current;
  try {
    const schedule = parseCodexStatus(body, now);
    publishCodexSchedule(stateDirectory, schedule);
    return schedule;
  } catch {
    return current;
  }
}

function longestOrEmpty(reading: PoolReading): PoolReading['windows'][number] {
  return longestWindow(reading) ?? { usedPercent: 0, resetsAt: null, minutes: null };
}

/** The longest window a reading reports, which is the one whose reset loses allowance. */
function longestWindow(reading: PoolReading): PoolReading['windows'][number] | undefined {
  return [...reading.windows].sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0))[0];
}

export type Pace = { allowanceKey: string; unusedPercent: number; hoursToReset: number; urgency: number };

/**
 * Percent of the allowance per hour that must be spent to use it before it resets. An announced Codex reset that comes
 * before the window's own reset shortens the time. Undefined without a reading or a reset time.
 */
export function pace(reading: PoolReading, pool: Pool, now: number, schedule?: CodexSchedule): Pace | undefined {
  const window = longestWindow(reading);
  if (!window || window.resetsAt === null || !reading.observedAt) return undefined;
  let resetAt = window.resetsAt;
  const announced =
    agentAdapter(pool.cli).announcedReset && schedule?.scheduledAt ? Date.parse(schedule.scheduledAt) : NaN;
  if (Number.isFinite(announced) && announced > now && announced < resetAt) resetAt = announced;
  const hoursToReset = Math.max((resetAt - now) / 3_600_000, 0.25);
  const unusedPercent = Math.max(0, 100 - effectiveReserve(pool, window, now) - window.usedPercent);
  return { allowanceKey: pool.allowanceKey, unusedPercent, hoursToReset, urgency: unusedPercent / hoursToReset };
}

// A person would act when using up an allowance needs more than two percent of it an hour, or when a day or less is
// left with a fifth of it unused.
const ALERT_PERCENT_PER_HOUR = 2;
const ALERT_LAST_DAY_PERCENT = 20;
const ALERT_EVERY_MS = 3 * 3_600_000;

/** Tell the supermanager, at most every three hours per allowance, which allowances will expire unused. */
export function alertUnspentAllowances(
  pools: readonly Pool[],
  read: (pool: Pool) => PoolReading,
  stateDirectory: string,
  deliver: (summary: string) => void,
  now = Date.now(),
): number {
  const path = join(stateDirectory, 'pacing-alerts.json');
  let sent: Record<string, string> = {};
  try {
    if (existsSync(path)) sent = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch {
    /* Alert again rather than never. */
  }
  const schedule = readCodexSchedule(stateDirectory);
  const seen = new Set<string>();
  let count = 0;
  // Pools sharing an allowance can keep different reserves; the one that keeps the most is the one work is limited by.
  for (const pool of [...pools].sort(
    (a, b) => effectiveReserve(b, longestOrEmpty(read(b)), now) - effectiveReserve(a, longestOrEmpty(read(a)), now),
  )) {
    if (seen.has(pool.allowanceKey)) continue;
    seen.add(pool.allowanceKey);
    const current = pace(read(pool), pool, now, schedule);
    if (!current) continue;
    const atRisk =
      current.urgency > ALERT_PERCENT_PER_HOUR ||
      (current.hoursToReset <= 24 && current.unusedPercent >= ALERT_LAST_DAY_PERCENT);
    const last = sent[pool.allowanceKey] ? Date.parse(sent[pool.allowanceKey]!) : 0;
    if (!atRisk || now - last < ALERT_EVERY_MS) continue;
    deliver(
      `Allowance pacing: ${pool.allowanceKey} has ${current.unusedPercent.toFixed(0)}% unused above its reserve and resets in ` +
        `${current.hoursToReset.toFixed(1)} h, so it needs ${current.urgency.toFixed(1)}% an hour to be used. Route more work to it ` +
        `(routing already prefers the allowance that expires first) and have managers dispatch ready work now.`,
    );
    sent[pool.allowanceKey] = new Date(now).toISOString();
    count++;
  }
  if (count) {
    writeFileSync(`${path}.tmp`, JSON.stringify(sent, null, 2));
    renameSync(`${path}.tmp`, path);
  }
  return count;
}
