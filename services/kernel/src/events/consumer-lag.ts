import type { PoolClient } from 'pg';
import readConsumerLagQuery from './read-consumer-lag.sql';

export type ConsumerLag = {
  oldestPendingAt: Date | null;
  observedAt: Date;
};

export async function readConsumerLag(client: PoolClient, consumer: string): Promise<ConsumerLag | null> {
  // The SQL mapper returns a nullable row for this primary-key lookup.
  const row = await readConsumerLagQuery.run(client, { consumer });
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
