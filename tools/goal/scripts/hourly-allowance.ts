import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { burnEvidence, isFreshPoolReading, type BurnEvidenceKind } from '../src/allowance.ts';
import { defaultPolicy } from '../src/policy.ts';
import { loadSettings } from '../src/settings.ts';
import type { Pool, PoolReading } from '../src/types.ts';
import { readPool } from '../src/usage.ts';

const minute = 60_000;
const hour = 60 * minute;
const weekMinutes = 7 * 24 * 60;

export type HourlyAllowance = {
  used: number | null;
  /** Evidenced short-window rate that drives the alarm; null when there is no baseline or integer precision is unresolved. */
  rate: number | null;
  observedRate: number | null;
  evidence: BurnEvidenceKind;
};

export type HourlyAllowanceWindow = {
  /** Provider identity and exact quota-window boundaries. A null field means the provider did not supply it. */
  identity: { window: string | null; minutes: number | null; resetsAt: number | null };
  usedPercent: number;
  resetStatus: 'scheduled' | 'expired' | 'unavailable';
  /** Positive until reset, zero at reset, negative after reset; null when no valid reset stamp is available. */
  remainingMs: number | null;
};

export type HourlyPoolStatus = HourlyAllowance & {
  allowanceKey: string;
  sharedPools: string[];
  freshness: {
    status: 'fresh' | 'stale' | 'future' | 'invalid' | 'unavailable';
    observedAt: string | null;
    ageMs: number | null;
    maxAgeMs: number;
  };
  windowStatus: 'available' | 'unavailable';
  windows: HourlyAllowanceWindow[];
  ceiling: number | null;
};

const missing: HourlyAllowance = { used: null, rate: null, observedRate: null, evidence: 'none' };

/** Keep the existing weekly burn calculation used by the allowance alarm and its Codex integer evidence. */
export function hourlyAllowance(
  pool: Pool,
  current: PoolReading,
  history: readonly PoolReading[],
  now: number,
): HourlyAllowance {
  const observed = current.observedAt ? Date.parse(current.observedAt) : NaN;
  const window = current.windows.find((sample) => sample.minutes === weekMinutes);
  if (!window || !Number.isFinite(observed) || observed > now + minute || now - observed > 15 * minute) return missing;
  // usageFile readings are external and readPool does not validate reset types.
  if (window.resetsAt === null || !Number.isFinite(window.resetsAt))
    return { used: window.usedPercent, rate: null, observedRate: null, evidence: 'none' };
  const currentWeek = { ...current, windows: [window] };
  const previous = history
    .filter((reading) => {
      if (reading.allowanceKey !== pool.allowanceKey || !reading.observedAt) return false;
      const age = observed - Date.parse(reading.observedAt);
      return (
        age >= 45 * minute &&
        age <= 75 * minute &&
        reading.windows.some(
          (old) =>
            old.minutes === window.minutes &&
            old.resetsAt !== null &&
            Math.abs(old.resetsAt - window.resetsAt!) <= minute &&
            old.usedPercent <= window.usedPercent,
        )
      );
    })
    .sort(
      (a, b) =>
        Math.abs(observed - Date.parse(a.observedAt!) - hour) - Math.abs(observed - Date.parse(b.observedAt!) - hour),
    )[0];
  if (!previous) return { used: window.usedPercent, rate: null, observedRate: null, evidence: 'none' };
  const measured = burnEvidence(currentWeek, [previous], {
    now: observed,
    spanMs: 75 * minute,
    cli: pool.cli,
    shortOnly: true,
  });
  return {
    used: window.usedPercent,
    rate: measured.evidence === 'rate' ? measured.rate : null,
    observedRate: measured.observedRate,
    evidence: measured.evidence,
  };
}

function timestamp(reading: PoolReading): number | undefined {
  if (!reading.observedAt) return undefined;
  const observed = Date.parse(reading.observedAt);
  return Number.isFinite(observed) ? observed : undefined;
}

function latestReading(readings: readonly PoolReading[]): PoolReading | undefined {
  return readings.reduce<PoolReading | undefined>((latest, reading) => {
    if (!latest) return reading;
    const currentAt = timestamp(reading);
    const latestAt = timestamp(latest);
    if (currentAt !== undefined && (latestAt === undefined || currentAt >= latestAt)) return reading;
    if (currentAt !== undefined || latestAt !== undefined) return latest;
    return Date.parse(reading.at) >= Date.parse(latest.at) ? reading : latest;
  }, undefined);
}

function freshness(pool: Pool, reading: PoolReading, now: number): HourlyPoolStatus['freshness'] {
  const observedAt = reading.observedAt;
  if (!observedAt) return { status: 'unavailable', observedAt: null, ageMs: null, maxAgeMs: pool.policy.maxAgeMs };
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return { status: 'invalid', observedAt, ageMs: null, maxAgeMs: pool.policy.maxAgeMs };
  const ageMs = now - observed;
  if (observed > now + defaultPolicy.provider.observationClockSkewMs)
    return { status: 'future', observedAt, ageMs, maxAgeMs: pool.policy.maxAgeMs };
  return {
    status: isFreshPoolReading(pool, reading, now) ? 'fresh' : 'stale',
    observedAt,
    ageMs,
    maxAgeMs: pool.policy.maxAgeMs,
  };
}

function hourlyWindows(reading: PoolReading, now: number): HourlyAllowanceWindow[] {
  return reading.windows.map((window) => {
    // usageFile is an external quota source and its reset value is not validated by readPool.
    const resetsAt = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt : null;
    const minutes =
      typeof window.minutes === 'number' && Number.isFinite(window.minutes) && window.minutes > 0
        ? window.minutes
        : null;
    return {
      identity: { window: typeof window.window === 'string' ? window.window : null, minutes, resetsAt },
      usedPercent: window.usedPercent,
      resetStatus: resetsAt === null ? 'unavailable' : resetsAt <= now ? 'expired' : 'scheduled',
      remainingMs: resetsAt === null ? null : resetsAt - now,
    };
  });
}

/** Build a pool-keyed report, reusing fresh observations and reading one quota source per shared allowance. */
export function hourlyAllowanceReport(
  pools: readonly Pool[],
  history: readonly PoolReading[],
  now: number,
  read: (pool: Pool, now: number) => PoolReading = readPool,
): Record<string, HourlyPoolStatus> {
  const grouped = new Map<string, Pool[]>();
  for (const pool of pools) {
    const group = grouped.get(pool.allowanceKey) ?? [];
    group.push(pool);
    grouped.set(pool.allowanceKey, group);
  }

  const currentByAllowance = new Map<string, PoolReading>();
  for (const [allowanceKey, aliases] of grouped) {
    const latest = latestReading(history.filter((reading) => reading.allowanceKey === allowanceKey));
    if (latest && aliases.some((pool) => isFreshPoolReading(pool, latest, now))) {
      currentByAllowance.set(allowanceKey, latest);
      continue;
    }

    // A configured normalized source is preferred when aliases differ; otherwise keep settings order stable.
    const sourcePool = aliases.find((pool) => pool.usageFile) ?? aliases[0]!;
    const sourced = read(sourcePool, now);
    const sourceAt = timestamp(sourced);
    const latestAt = latest ? timestamp(latest) : undefined;
    currentByAllowance.set(
      allowanceKey,
      sourceAt !== undefined && (latestAt === undefined || sourceAt >= latestAt) ? sourced : (latest ?? sourced),
    );
  }

  const report: Record<string, HourlyPoolStatus> = {};
  for (const pool of pools) {
    const current = currentByAllowance.get(pool.allowanceKey)!;
    const windows = hourlyWindows(current, now);
    report[pool.name] = {
      ...hourlyAllowance(pool, current, history, now),
      allowanceKey: pool.allowanceKey,
      sharedPools: grouped.get(pool.allowanceKey)!.map((alias) => alias.name),
      freshness: freshness(pool, current, now),
      windowStatus: windows.length ? 'available' : 'unavailable',
      windows,
      ceiling: pool.policy.maxBurnPerHour ?? null,
    };
  }
  return report;
}

if (import.meta.main) {
  const settings = loadSettings();
  const now = Date.now();
  const stored = JSON.parse(readFileSync(join(settings.stateDirectory, 'pool-readings.json'), 'utf8')) as {
    readings: PoolReading[];
  };
  console.log(JSON.stringify(hourlyAllowanceReport(settings.pools, stored.readings, now)));
}
