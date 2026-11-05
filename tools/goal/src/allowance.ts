import { defaultPolicy, type ControlPolicy } from './policy.ts';
import type { Pool, PoolReading, Profile } from './types.ts';

// Milliseconds per hour, minutes per day and percentages below are unit conversions, not admission policy.
/** Recent same-window consumption, excluding resets. All reserve and pacing thresholds are local policy. */
export function burnPerHour(current: PoolReading, previous?: PoolReading): number {
  if (!previous?.observedAt || !current.observedAt) return 0;
  const elapsed = Date.parse(current.observedAt) - Date.parse(previous.observedAt);
  if (elapsed <= 0) return 0;
  return Math.max(
    0,
    ...current.windows.map((window) => {
      const old = previous.windows.find((w) => w.resetsAt === window.resetsAt && w.minutes === window.minutes);
      return old ? (Math.max(0, window.usedPercent - old.usedPercent) * 3600000) / elapsed : 0;
    }),
  );
}
/**
 * The percent a window keeps back. A reserve keeps allowance for the managers until the window resets, so in a window
 * longer than a day it need not exceed reservePerHour for each hour left: an ending week's leftover goes to work. A
 * window of a day or less keeps its whole reserve, since that window is what keeps managers running.
 */
export function effectiveReserve(pool: Pool, window: PoolReading['windows'][number], now: number): number {
  const perHour = pool.policy.reservePerHour;
  if (perHour === undefined || window.resetsAt === null || (window.minutes ?? 0) <= 24 * 60)
    return pool.policy.reservePercent;
  return Math.min(pool.policy.reservePercent, (perHour * Math.max(0, window.resetsAt - now)) / 3_600_000);
}

type IndexedReading = { reading: PoolReading; previous?: PoolReading };
type AllowanceIndex = ReadonlyMap<string, readonly IndexedReading[]>;
type HistoryTail = { observedAt: string | null; latest: PoolReading; previousDifferent?: PoolReading };
type PoolAllowance = { score: number } | null;

/** Index shared readings and resolve each predecessor in the same reverse-array order as the prior traversal. */
function indexAllowanceReadings(readings: readonly PoolReading[], history: readonly PoolReading[]): AllowanceIndex {
  const historyByAllowance = new Map<string, HistoryTail>();
  for (const previous of history) {
    const tail = historyByAllowance.get(previous.allowanceKey);
    if (!tail) {
      historyByAllowance.set(previous.allowanceKey, { observedAt: previous.observedAt, latest: previous });
    } else if (tail.observedAt === previous.observedAt) {
      tail.latest = previous;
    } else {
      tail.previousDifferent = tail.latest;
      tail.observedAt = previous.observedAt;
      tail.latest = previous;
    }
  }

  const indexed = new Map<string, IndexedReading[]>();
  for (const reading of readings) {
    const tail = historyByAllowance.get(reading.allowanceKey);
    const previous = tail?.observedAt === reading.observedAt ? tail.previousDifferent : tail?.latest;
    const allowance = indexed.get(reading.allowanceKey) ?? [];
    allowance.push({ reading, ...(previous ? { previous } : {}) });
    indexed.set(reading.allowanceKey, allowance);
  }
  return indexed;
}

function assessPool(
  pool: Pool,
  indexedReadings: AllowanceIndex,
  now: number,
  policy: ControlPolicy['provider'] | undefined,
): PoolAllowance {
  const shared = indexedReadings.get(pool.allowanceKey) ?? [];
  const fresh = shared.filter(({ reading }) =>
    reading.observedAt
      ? now - Date.parse(reading.observedAt) <= pool.policy.maxAgeMs &&
        Date.parse(reading.observedAt) <= now + (policy ?? defaultPolicy.provider).observationClockSkewMs
      : false,
  );
  if (
    fresh.some(({ reading }) =>
      reading.exhausted ||
      reading.windows.some((window) => window.usedPercent >= 100 - effectiveReserve(pool, window, now)),
    )
  )
    return null;
  if (!fresh.length && !pool.policy.allowUnknown) return null;
  const rates = fresh.map(({ reading, previous }) => burnPerHour(reading, previous));
  if (pool.policy.maxBurnPerHour !== undefined && rates.some((rate) => rate > pool.policy.maxBurnPerHour!)) return null;
  const used = Math.max(0, ...fresh.flatMap(({ reading }) => reading.windows.map((window) => window.usedPercent)));
  return { score: (100 - used) * pool.policy.weight };
}

function selectPool(
  profile: Profile,
  pools: readonly Pool[],
  indexedReadings: AllowanceIndex,
  options: NonNullable<Parameters<typeof choosePool>[3]>,
  now: number,
  allowanceByPool: Map<Pool, PoolAllowance>,
): Pool | undefined {
  const candidates = pools.filter(
    (pool) =>
      pool.cli === profile.cli &&
      pool.classes.includes(profile.poolClass) &&
      !options.exclude?.includes(pool.name),
  );
  const ranked = candidates
    .map((pool) => {
      if (!allowanceByPool.has(pool)) allowanceByPool.set(pool, assessPool(pool, indexedReadings, now, options.policy));
      const allowance = allowanceByPool.get(pool);
      return allowance ? { pool, score: allowance.score, preferred: pool.name === options.preferred } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort(
      (a, b) =>
        Number(b.preferred) - Number(a.preferred) || b.score - a.score || a.pool.name.localeCompare(b.pool.name),
    );
  return ranked[0]?.pool;
}

function noAllowedPool(profile: Profile): Error {
  return new Error(`no allowed pool available for ${profile.cli}/${profile.poolClass}`);
}

export function choosePool(
  profile: Profile,
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: {
    preferred?: string;
    exclude?: string[];
    history?: readonly PoolReading[];
    now?: number;
    policy?: ControlPolicy['provider'] | undefined;
  } = {},
): Pool {
  const now = options.now ?? Date.now();
  const indexedReadings = indexAllowanceReadings(readings, options.history ?? []);
  const selected = selectPool(profile, pools, indexedReadings, options, now, new Map());
  if (!selected) throw noAllowedPool(profile);
  return selected;
}

/**
 * The routed profile's pool, or the first fallback profile that has one when the routed CLI has no quota. With a pacing
 * measure, a new task instead goes to the allowed profile whose allowance most needs spending before it resets; a
 * retry keeps its engine while that has quota.
 */
export function choosePoolWithFallback(
  profile: Profile,
  fallbacks: readonly Profile[],
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: Parameters<typeof choosePool>[3] = {},
  urgency?: (pool: Pool) => number | undefined,
): { profile: Profile; pool: Pool } {
  const now = options.now ?? Date.now();
  const selection = { ...options, now };
  const indexedReadings = indexAllowanceReadings(readings, selection.history ?? []);
  const allowanceByPool = new Map<Pool, PoolAllowance>();
  if (urgency && !options.preferred) {
    const choices = [profile, ...fallbacks].flatMap((candidate, order) => {
      const pool = selectPool(candidate, pools, indexedReadings, selection, now, allowanceByPool);
      return pool ? [{ profile: candidate, pool, order, urgency: urgency(pool) ?? -1 }] : [];
    });
    choices.sort((a, b) => b.urgency - a.urgency || a.order - b.order);
    if (choices[0]) return { profile: choices[0].profile, pool: choices[0].pool };
  }
  const primary = selectPool(profile, pools, indexedReadings, selection, now, allowanceByPool);
  if (primary) return { profile, pool: primary };
  const { preferred: _preferred, ...fallbackOptions } = selection;
  for (const candidate of fallbacks) {
    const pool = selectPool(candidate, pools, indexedReadings, fallbackOptions, now, allowanceByPool);
    if (pool) return { profile: candidate, pool };
  }
  throw noAllowedPool(profile);
}
