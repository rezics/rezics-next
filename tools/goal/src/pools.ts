import { choosePool, choosePoolWithFallback as chooseByAllowance } from './allowance.ts';
import type { Pool, PoolReading, Profile } from './types.ts';

/** Select a routed profile and pool using one clock reading and one pacing urgency per pool. */
export function choosePoolWithFallback(
  profile: Profile,
  fallbacks: readonly Profile[],
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: Parameters<typeof choosePool>[3] = {},
  urgency?: (pool: Pool, now: number) => number | undefined,
): { profile: Profile; pool: Pool } {
  const now = options.now ?? Date.now();
  const selection = { ...options, now };
  if (!urgency) return chooseByAllowance(profile, fallbacks, pools, readings, selection);

  const urgencyByPool = new Map<string, number | undefined>();
  return chooseByAllowance(profile, fallbacks, pools, readings, selection, (pool) => {
    if (!urgencyByPool.has(pool.name)) urgencyByPool.set(pool.name, urgency(pool, now));
    return urgencyByPool.get(pool.name);
  });
}
