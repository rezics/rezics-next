import type { AccessClient } from '../request/access.ts';

export type ConsumerLag = {
  oldestPendingAt: Date | null;
  observedAt: Date;
};

export async function readConsumerLag(client: AccessClient, consumer: string): Promise<ConsumerLag | null> {
  // Query-only deadline clients carry the same single-row native observation as a pool client.
  const row = (
    await client.query<{ oldest_pending_at: string | null; observed_at: string }>(
      `SELECT oldest_pending_at, observed_at FROM core.consumer_lag WHERE consumer=$1`,
      [consumer],
    )
  ).rows[0];
  return row
    ? {
        oldestPendingAt: row.oldest_pending_at === null ? null : new Date(row.oldest_pending_at),
        observedAt: new Date(row.observed_at),
      }
    : null;
}

export function consumerReady(lag: ConsumerLag | null, options: { maxLagMs: number; now: Date }): boolean {
  const now = options.now.getTime();
  if (!lag || !Number.isFinite(options.maxLagMs) || options.maxLagMs < 0 || !Number.isFinite(now)) return false;
  const cutoff = now - options.maxLagMs;
  const observedAt = lag.observedAt.getTime();
  if (!Number.isFinite(observedAt) || observedAt < cutoff) return false;
  if (lag.oldestPendingAt === null) return true;
  const oldestPendingAt = lag.oldestPendingAt.getTime();
  return Number.isFinite(oldestPendingAt) && oldestPendingAt >= cutoff;
}
