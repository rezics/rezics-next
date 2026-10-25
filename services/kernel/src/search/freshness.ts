import type { Pool } from 'pg';
import read from './freshness.sql';

export type Freshness = { asOf: Date; behind: number; catchingUp: boolean };

export async function readFreshness(pool: Pool, consumer: string): Promise<Freshness> {
  const row = await read.run(pool, { consumer });
  if (!row) throw new Error('Freshness query returned no row');

  const now = new Date(row.now);
  const behind = row.behind;
  if (behind > 0 && row.oldest === null) throw new Error('Freshness query found partitions behind without an envelope');
  const asOf = behind > 0 ? new Date(row.oldest!) : now;

  return { asOf, behind, catchingUp: behind > 0 && now.getTime() - asOf.getTime() > 60_000 };
}

export function createFreshness(
  pool: Pool,
  consumer: string,
  { ttlMs = 1000 }: { ttlMs?: number } = {},
): { current(): Promise<Freshness> } {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError('ttlMs must be a non-negative finite number');

  let cached: Freshness | undefined;
  let expiresAt = 0;
  let refreshing: Promise<Freshness> | undefined;

  return {
    current(): Promise<Freshness> {
      if (refreshing) return refreshing;
      if (cached && Date.now() < expiresAt) return Promise.resolve(cached);

      const refresh = readFreshness(pool, consumer)
        .then((freshness) => {
          cached = freshness;
          expiresAt = Date.now() + ttlMs;
          return freshness;
        })
        .finally(() => {
          if (refreshing === refresh) refreshing = undefined;
        });
      refreshing = refresh;
      return refresh;
    },
  };
}
