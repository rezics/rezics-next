import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import scanPartitions from './scan-partitions.sql';
import upsertConsumerLag from './upsert-consumer-lag.sql';
import type { BatchResult } from './log.ts';

export type Relay = { consumer: string; run(partition: number): Promise<BatchResult> };

export function startRelays(pool: Pool, relays: Relay[], options: { intervalMs?: number; concurrency?: number } = {}) {
  const intervalMs = options.intervalMs ?? 100;
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new RangeError('intervalMs must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency >= pool.options.max!) {
    throw new RangeError('concurrency must be a positive integer below the pool size');
  }
  let paused = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = 0;
  let ticking = false;
  const inFlight = new Set<string>();
  const running = new Set<Promise<void>>();
  const stopPositions = new Map<string, string>();
  const waiters: (() => void)[] = [];
  const key = (relay: Relay, partition: number) => `${relays.indexOf(relay)}:${partition}`;
  const notifyIdle = () => {
    if (active === 0 && !ticking) for (const resolve of waiters.splice(0)) resolve();
  };
  const idle = () =>
    active === 0 && !ticking ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));

  const run = async (relay: Relay, partition: number) => {
    const identity = key(relay, partition);
    inFlight.add(identity);
    active++;
    try {
      for (;;) {
        if (stopped || paused) return;
        const result = await relay.run(partition);
        if (result.status === 'stopped') {
          if (stopPositions.get(identity) !== String(result.position)) {
            stopPositions.set(identity, String(result.position));
            console.warn(
              `Relay ${relay.consumer} stopped at partition ${partition} position ${result.position}: ${result.reason}`,
            );
          }
          return;
        }
        if (result.status === 'busy' || result.envelopes === 0) return;
      }
    } catch (error) {
      console.error(`Relay ${relay.consumer} failed on partition ${partition}`, error);
    } finally {
      inFlight.delete(identity);
      active--;
      notifyIdle();
    }
  };

  const tick = async () => {
    if (stopped || paused || ticking) return;
    ticking = true;
    try {
      for (const relay of relays) {
        const partitions = await withConnection(pool, async (client) => {
          const rows = await scanPartitions.run(client, { consumer: relay.consumer });
          const oldestPendingAt = rows[0]?.oldest_pending_at;
          await upsertConsumerLag.run(client, {
            consumer: relay.consumer,
            oldest_pending_at: oldestPendingAt ? new Date(oldestPendingAt).toISOString() : '',
          });
          return rows;
        });
        for (const row of partitions) {
          // Refill a released slot from this scan instead of discarding its remaining partitions.
          // The poll interval applies between scans, not between every four native homes.
          while (!stopped && !paused && active >= concurrency) await Promise.race(running);
          if (stopped || paused) break;
          const partition = row.partition_no;
          if (inFlight.has(key(relay, partition))) continue;
          const task = run(relay, partition);
          running.add(task);
          void task.then(
            () => running.delete(task),
            () => running.delete(task),
          );
        }
      }
    } catch (error) {
      console.error('Relay partition scan failed', error);
    } finally {
      ticking = false;
      notifyIdle();
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    }
  };
  void tick();

  return {
    async pause(): Promise<void> {
      paused = true;
      if (timer) clearTimeout(timer);
      await idle();
    },
    resume(): void {
      if (stopped || !paused) return;
      paused = false;
      void tick();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await idle();
    },
  };
}
