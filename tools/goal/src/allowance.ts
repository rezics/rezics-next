import type { Pool, PoolReading, Profile } from './types.ts';

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
export function choosePool(
  profile: Profile,
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: {
    preferred?: string;
    exclude?: string[];
    history?: readonly PoolReading[];
    now?: number;
  } = {},
): Pool {
  const now = options.now ?? Date.now();
  const candidates = pools.filter(
    (p) => p.cli === profile.cli && p.classes.includes(profile.poolClass) && !options.exclude?.includes(p.name),
  );
  const ranked = candidates
    .map((pool) => {
      // A shared allowance cannot be made available by choosing a different CLI or account alias.
      const shared = readings.filter((r) => r.allowanceKey === pool.allowanceKey);
      const fresh = shared.filter(
        (r) =>
          r.observedAt &&
          now - Date.parse(r.observedAt) <= pool.policy.maxAgeMs &&
          Date.parse(r.observedAt) <= now + 60000,
      );
      if (
        fresh.some((r) => r.exhausted || r.windows.some((w) => w.usedPercent >= 100 - effectiveReserve(pool, w, now)))
      )
        return null;
      if (!fresh.length && !pool.policy.allowUnknown) return null;
      const rates = fresh.map((r) =>
        burnPerHour(
          r,
          [...(options.history ?? [])]
            .reverse()
            .find((old) => old.allowanceKey === r.allowanceKey && old.observedAt !== r.observedAt),
        ),
      );
      if (pool.policy.maxBurnPerHour !== undefined && rates.some((rate) => rate > pool.policy.maxBurnPerHour!))
        return null;
      const used = Math.max(0, ...fresh.flatMap((r) => r.windows.map((w) => w.usedPercent)));
      return { pool, score: (100 - used) * pool.policy.weight, preferred: pool.name === options.preferred };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort(
      (a, b) =>
        Number(b.preferred) - Number(a.preferred) || b.score - a.score || a.pool.name.localeCompare(b.pool.name),
    );
  if (!ranked[0]) throw new Error(`no allowed pool available for ${profile.cli}/${profile.poolClass}`);
  return ranked[0].pool;
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
  if (urgency && !options.preferred) {
    const choices = [profile, ...fallbacks].flatMap((candidate, order) => {
      try {
        const pool = choosePool(candidate, pools, readings, options);
        return [{ profile: candidate, pool, order, urgency: urgency(pool) ?? -1 }];
      } catch {
        return [];
      }
    });
    choices.sort((a, b) => b.urgency - a.urgency || a.order - b.order);
    if (choices[0]) return { profile: choices[0].profile, pool: choices[0].pool };
  }
  try {
    return { profile, pool: choosePool(profile, pools, readings, options) };
  } catch (error) {
    for (const candidate of fallbacks) {
      const { preferred: _preferred, ...rest } = options;
      try {
        return { profile: candidate, pool: choosePool(candidate, pools, readings, rest) };
      } catch {
        /* try the next fallback */
      }
    }
    throw error;
  }
}
