import { defaultPolicy, type ControlPolicy } from './policy.ts';
import type { Pool, PoolReading, Profile } from './types.ts';

export type PoolSelectionOptions = {
  preferred?: string;
  exclude?: string[];
  history?: readonly PoolReading[];
  now?: number;
  policy?: ControlPolicy['provider'] | undefined;
  spanMs?: number;
};

export type PoolBurnStatus = {
  name: string;
  allowanceKey: string;
  burnPerHour: number;
  maxBurnPerHour?: number;
};

// Milliseconds per hour, minutes per day and percentages below are unit conversions, not admission policy.
/** Same-window consumption over the measurement span, excluding resets. All reserve and pacing thresholds are local policy. */
export function burnPerHour(
  current: PoolReading,
  history: readonly PoolReading[] = [],
  options: { now?: number; spanMs?: number } = {},
): number {
  if (!current.observedAt) return 0;
  const currentAt = Date.parse(current.observedAt);
  if (!Number.isFinite(currentAt)) return 0;
  const spanMs = options.spanMs ?? defaultPolicy.pacing.burnSpanMs;
  const now = options.now ?? currentAt;
  const start = now - spanMs;
  return Math.max(
    0,
    ...current.windows.map((window) => {
      let earliestAt: number | undefined;
      let earliestUsed: number | undefined;
      for (const past of history) {
        if (past.allowanceKey !== current.allowanceKey || !past.observedAt) continue;
        const at = Date.parse(past.observedAt);
        if (!Number.isFinite(at) || at < start || at >= currentAt) continue;
        const old = past.windows.find(
          (candidate) => candidate.resetsAt === window.resetsAt && candidate.minutes === window.minutes,
        );
        if (!old) continue;
        if (earliestAt === undefined || at < earliestAt) {
          earliestAt = at;
          earliestUsed = old.usedPercent;
        }
      }
      if (earliestAt === undefined || earliestUsed === undefined) return 0;
      const elapsed = currentAt - earliestAt;
      return elapsed > 0 ? (Math.max(0, window.usedPercent - earliestUsed) * 3_600_000) / elapsed : 0;
    }),
  );
}

export function poolBurnStatus(
  pools: readonly Pool[],
  history: readonly PoolReading[],
  now = Date.now(),
  spanMs = defaultPolicy.pacing.burnSpanMs,
): PoolBurnStatus[] {
  return pools.map((pool) => {
    const series = history.filter((reading) => reading.allowanceKey === pool.allowanceKey && reading.observedAt);
    const latest = series.reduce<PoolReading | undefined>((chosen, reading) => {
      if (!chosen?.observedAt) return reading;
      return Date.parse(reading.observedAt!) >= Date.parse(chosen.observedAt) ? reading : chosen;
    }, undefined);
    return {
      name: pool.name,
      allowanceKey: pool.allowanceKey,
      burnPerHour: latest ? burnPerHour(latest, series, { now, spanMs }) : 0,
      ...(pool.policy.maxBurnPerHour === undefined ? {} : { maxBurnPerHour: pool.policy.maxBurnPerHour }),
    };
  });
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

type IndexedReading = { reading: PoolReading; history: readonly PoolReading[] };
type AllowanceIndex = ReadonlyMap<string, readonly IndexedReading[]>;
type PoolAllowance = { score: number } | null;

/** Index shared readings and history once by allowance key, then reuse that projection across profile fallbacks. */
function indexAllowanceReadings(readings: readonly PoolReading[], history: readonly PoolReading[]): AllowanceIndex {
  const historyByAllowance = new Map<string, PoolReading[]>();
  for (const previous of history) {
    const list = historyByAllowance.get(previous.allowanceKey);
    if (list) list.push(previous);
    else historyByAllowance.set(previous.allowanceKey, [previous]);
  }
  const indexed = new Map<string, IndexedReading[]>();
  for (const reading of readings) {
    const past = historyByAllowance.get(reading.allowanceKey) ?? [];
    const allowance = indexed.get(reading.allowanceKey) ?? [];
    allowance.push({ reading, history: past });
    indexed.set(reading.allowanceKey, allowance);
  }
  return indexed;
}

function assessPool(
  pool: Pool,
  indexedReadings: AllowanceIndex,
  now: number,
  policy: ControlPolicy['provider'] | undefined,
  spanMs: number,
): PoolAllowance {
  const shared = indexedReadings.get(pool.allowanceKey) ?? [];
  const fresh = shared.filter(({ reading }) =>
    reading.observedAt
      ? now - Date.parse(reading.observedAt) <= pool.policy.maxAgeMs &&
        Date.parse(reading.observedAt) <= now + (policy ?? defaultPolicy.provider).observationClockSkewMs
      : false,
  );
  if (
    fresh.some(
      ({ reading }) =>
        reading.exhausted ||
        reading.windows.some((window) => window.usedPercent >= 100 - effectiveReserve(pool, window, now)),
    )
  )
    return null;
  if (!fresh.length && !pool.policy.allowUnknown) return null;
  const rates = fresh.map(({ reading, history }) => burnPerHour(reading, history, { now, spanMs }));
  if (pool.policy.maxBurnPerHour !== undefined && rates.some((rate) => rate > pool.policy.maxBurnPerHour!)) return null;
  const used = Math.max(0, ...fresh.flatMap(({ reading }) => reading.windows.map((window) => window.usedPercent)));
  return { score: (100 - used) * pool.policy.weight };
}

function selectPool(
  profile: Profile,
  pools: readonly Pool[],
  indexedReadings: AllowanceIndex,
  options: PoolSelectionOptions,
  now: number,
  spanMs: number,
  allowanceByPool: Map<Pool, PoolAllowance>,
): Pool | undefined {
  const candidates = pools.filter(
    (pool) =>
      pool.cli === profile.cli && pool.classes.includes(profile.poolClass) && !options.exclude?.includes(pool.name),
  );
  const ranked = candidates
    .map((pool) => {
      if (!allowanceByPool.has(pool))
        allowanceByPool.set(pool, assessPool(pool, indexedReadings, now, options.policy, spanMs));
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
  options: PoolSelectionOptions = {},
): Pool {
  const now = options.now ?? Date.now();
  const spanMs = options.spanMs ?? defaultPolicy.pacing.burnSpanMs;
  const indexedReadings = indexAllowanceReadings(readings, options.history ?? []);
  const selected = selectPool(profile, pools, indexedReadings, options, now, spanMs, new Map());
  if (!selected) throw noAllowedPool(profile);
  return selected;
}

/** The routed profile's pool, or the first fallback that has one; `undefined` when every candidate is refused. */
export function findAllowedPool(
  profile: Profile,
  fallbacks: readonly Profile[],
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: PoolSelectionOptions = {},
  urgency?: (pool: Pool) => number | undefined,
): { profile: Profile; pool: Pool } | undefined {
  const now = options.now ?? Date.now();
  const spanMs = options.spanMs ?? defaultPolicy.pacing.burnSpanMs;
  const selection = { ...options, now, spanMs };
  const indexedReadings = indexAllowanceReadings(readings, selection.history ?? []);
  const allowanceByPool = new Map<Pool, PoolAllowance>();
  if (urgency && !options.preferred) {
    const choices = [profile, ...fallbacks].flatMap((candidate, order) => {
      const pool = selectPool(candidate, pools, indexedReadings, selection, now, spanMs, allowanceByPool);
      return pool ? [{ profile: candidate, pool, order, urgency: urgency(pool) ?? -1 }] : [];
    });
    choices.sort((a, b) => b.urgency - a.urgency || a.order - b.order);
    if (choices[0]) return { profile: choices[0].profile, pool: choices[0].pool };
  }
  const primary = selectPool(profile, pools, indexedReadings, selection, now, spanMs, allowanceByPool);
  if (primary) return { profile, pool: primary };
  const { preferred: _preferred, ...fallbackOptions } = selection;
  for (const candidate of fallbacks) {
    const pool = selectPool(candidate, pools, indexedReadings, fallbackOptions, now, spanMs, allowanceByPool);
    if (pool) return { profile: candidate, pool };
  }
  return undefined;
}

/**
 * The routed profile's pool, or the first fallback profile that has one when the routed CLI has no quota. With a pacing
 * measure, a new task instead goes to the allowed profile whose allowance most needs spending before it resets; a
 * retry keeps its engine while that has quota. A pool over its burn ceiling is skipped; with no allowed fallback the
 * task waits. Running attempts are not stopped.
 */
export function choosePoolWithFallback(
  profile: Profile,
  fallbacks: readonly Profile[],
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: PoolSelectionOptions = {},
  urgency?: (pool: Pool) => number | undefined,
): { profile: Profile; pool: Pool } {
  const selected = findAllowedPool(profile, fallbacks, pools, readings, options, urgency);
  if (!selected) throw noAllowedPool(profile);
  return selected;
}

/** The first configured pool the routed profile would use; ready tasks wait on this pool when none are allowed. */
export function waitingPoolName(profile: Profile, pools: readonly Pool[]): string | undefined {
  return [...pools]
    .filter((pool) => pool.cli === profile.cli && pool.classes.includes(profile.poolClass))
    .sort((a, b) => a.name.localeCompare(b.name))[0]?.name;
}

/** Ready tasks whose route has no allowed pool, counted on the pool their first profile would use. */
export function countAllowanceWaiting(
  items: readonly { first: Profile; fallbacks: readonly Profile[] }[],
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: PoolSelectionOptions = {},
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (findAllowedPool(item.first, item.fallbacks, pools, readings, options)) continue;
    const name = waitingPoolName(item.first, pools);
    if (!name) continue;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}
