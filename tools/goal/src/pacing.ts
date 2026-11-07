import { agentAdapter } from './agents.ts';
import { defaultPolicy } from './policy.ts';
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
const READINGS_FILE = 'pool-readings.json';
const HOUR_MS = 3_600_000; // Unit conversion for provider reset timestamps.
const MINUTE_MS = 60_000;

function asRetainedReading(value: unknown): PoolReading | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const reading = value as PoolReading;
  if (typeof reading.pool !== 'string' || typeof reading.allowanceKey !== 'string') return undefined;
  if (typeof reading.observedAt !== 'string' || !Number.isFinite(Date.parse(reading.observedAt))) return undefined;
  if (!Array.isArray(reading.windows)) return undefined;
  return reading;
}

/** Bounded window readings already taken for selection or alerts; a non-JSON file is ignored so dispatch continues. */
export function readRetainedPoolReadings(stateDirectory: string): PoolReading[] {
  try {
    const value = JSON.parse(readFileSync(join(stateDirectory, READINGS_FILE), 'utf8')) as {
      version?: unknown;
      readings?: unknown;
    };
    if (value.version !== 1 || !Array.isArray(value.readings)) return [];
    return value.readings.flatMap((item) => {
      const reading = asRetainedReading(item);
      return reading ? [reading] : [];
    });
  } catch {
    return [];
  }
}

/** Keep at most one reading per pool per minute and drop samples older than the burn span. */
export function retainPoolReadings(
  stateDirectory: string,
  incoming: readonly PoolReading[],
  now = Date.now(),
  spanMs = defaultPolicy.pacing.burnSpanMs,
): PoolReading[] {
  const start = now - spanMs;
  const merged = readRetainedPoolReadings(stateDirectory).filter(
    (reading) => reading.observedAt && Date.parse(reading.observedAt) >= start,
  );
  for (const reading of incoming) {
    if (!reading.observedAt) continue;
    const observedAt = Date.parse(reading.observedAt);
    if (!Number.isFinite(observedAt) || observedAt < start) continue;
    const minute = Math.floor(observedAt / MINUTE_MS);
    const index = merged.findIndex(
      (item) =>
        item.pool === reading.pool && item.observedAt && Math.floor(Date.parse(item.observedAt) / MINUTE_MS) === minute,
    );
    if (index >= 0) merged[index] = reading;
    else merged.push(reading);
  }
  const path = join(stateDirectory, READINGS_FILE);
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, readings: merged }));
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* The next retain rewrites a complete file. */
    }
    throw error;
  }
  return merged;
}

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

function isFresh(schedule: CodexSchedule, now: number, refreshMs: number): boolean {
  const fetchedAt = Date.parse(schedule.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  const age = now - fetchedAt;
  return age >= 0 && age < refreshMs;
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

function fetchCodexStatus(timeoutSeconds: number): string | undefined {
  const response = spawnSync('curl', ['-sf', '-m', String(timeoutSeconds), 'https://codex-resets.com/api/v1/status'], {
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

/** Refresh the announced Codex schedule on the configured cadence; returns the schedule now known. */
export function refreshCodexSchedule(
  stateDirectory: string,
  now = Date.now(),
  fetchStatus?: () => string | undefined,
  policy = defaultPolicy.pacing,
): CodexSchedule | undefined {
  const current = readCodexSchedule(stateDirectory);
  if (current && isFresh(current, now, policy.scheduleRefreshMs)) return current;
  const body = fetchStatus ? fetchStatus() : fetchCodexStatus(policy.scheduleRequestTimeoutSeconds);
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
export function pace(
  reading: PoolReading,
  pool: Pool,
  now: number,
  schedule?: CodexSchedule,
  policy = defaultPolicy.pacing,
): Pace | undefined {
  const window = longestWindow(reading);
  if (!window || window.resetsAt === null || !reading.observedAt) return undefined;
  let resetAt = window.resetsAt;
  const announced =
    agentAdapter(pool.cli).announcedReset && schedule?.scheduledAt ? Date.parse(schedule.scheduledAt) : NaN;
  if (Number.isFinite(announced) && announced > now && announced < resetAt) resetAt = announced;
  const hoursToReset = Math.max(resetAt - now, policy.minimumResetMs) / HOUR_MS;
  const unusedPercent = Math.max(0, 100 - effectiveReserve(pool, window, now) - window.usedPercent);
  return { allowanceKey: pool.allowanceKey, unusedPercent, hoursToReset, urgency: unusedPercent / hoursToReset };
}

/** Tell the supermanager which allowances will expire unused, on the configured alert cadence. */
export function alertUnspentAllowances(
  pools: readonly Pool[],
  read: (pool: Pool) => PoolReading,
  stateDirectory: string,
  deliver: (summary: string) => void,
  now = Date.now(),
  policy = defaultPolicy.pacing,
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
  const observed = new Map<Pool, PoolReading>();
  const readingFor = (pool: Pool) => {
    const cached = observed.get(pool);
    if (cached) return cached;
    const reading = read(pool);
    observed.set(pool, reading);
    return reading;
  };
  // Pools sharing an allowance can keep different reserves; the one that keeps the most is the one work is limited by.
  for (const pool of [...pools].sort(
    (a, b) =>
      effectiveReserve(b, longestOrEmpty(readingFor(b)), now) - effectiveReserve(a, longestOrEmpty(readingFor(a)), now),
  )) {
    if (seen.has(pool.allowanceKey)) continue;
    seen.add(pool.allowanceKey);
    const current = pace(readingFor(pool), pool, now, schedule, policy);
    if (!current) continue;
    const atRisk =
      current.urgency > policy.alertPercentPerHour ||
      (current.hoursToReset <= policy.alertResetHours && current.unusedPercent >= policy.alertUnusedPercent);
    const last = sent[pool.allowanceKey] ? Date.parse(sent[pool.allowanceKey]!) : 0;
    if (!atRisk || now - last < policy.alertEveryMs) continue;
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
  retainPoolReadings(stateDirectory, [...observed.values()], now, policy.burnSpanMs);
  return count;
}

/**
 * Remaining new starts this sweep on a pool whose measured burn is within `nearCeilingPercent` of its ceiling.
 * `undefined` means the rate is not in that band, so the sweep does not add a start limit.
 */
export function nearCeilingSweepAdmissions(
  burnPerHour: number,
  maxBurnPerHour: number,
  started = 0,
  policy: { nearCeilingPercent: number; nearCeilingStarts: number } = defaultPolicy.pacing,
): number | undefined {
  if (burnPerHour > maxBurnPerHour) return 0;
  const floor = maxBurnPerHour * (1 - policy.nearCeilingPercent / 100);
  if (burnPerHour < floor) return undefined;
  return Math.max(0, policy.nearCeilingStarts - started);
}
