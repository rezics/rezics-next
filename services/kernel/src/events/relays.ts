import type { Pool } from 'pg';
import { NestedPoolCheckoutError, withConnection } from '../database/pool.ts';
import scanPartitions from './scan-partitions.sql';
import upsertConsumerLag from './upsert-consumer-lag.sql';
import type { BatchResult } from './log.ts';

export type Relay = { consumer: string; run(partition: number): Promise<BatchResult> };

/** Default in-flight relay homes. A max-one pool shares its only connection; larger pools keep one slot free. */
export function relayConcurrencyForPool(pool: Pool): number {
  const max = pool.options.max ?? 10;
  if (!Number.isInteger(max) || max < 1) return 1;
  return max <= 1 ? 1 : Math.min(4, max - 1);
}

/** A command already holds the only connection; do not queue behind it until the next interval. */
function maxOnePoolBusy(pool: Pool): boolean {
  const max = pool.options.max ?? 10;
  return max <= 1 && (pool.waitingCount > 0 || (pool.totalCount > 0 && pool.idleCount === 0));
}

function isPoolAcquireTimeout(error: unknown): boolean {
  return (
    error instanceof NestedPoolCheckoutError ||
    (error instanceof Error && /timeout exceeded when trying to connect/i.test(error.message))
  );
}

export function startRelays(
  pool: Pool,
  relays: Relay[],
  options: { intervalMs?: number; concurrency?: number; paused?: boolean } = {},
) {
  const intervalMs = options.intervalMs ?? 100;
  const max = pool.options.max ?? 10;
  const concurrency = options.concurrency ?? relayConcurrencyForPool(pool);
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new RangeError('intervalMs must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer below the pool size');
  }
  if (max <= 1 ? concurrency !== 1 : concurrency >= max) {
    throw new RangeError('concurrency must be a positive integer below the pool size');
  }
  let paused = options.paused ?? false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = 0;
  let ticking = false;
  const observeLinks = process.env.REZICS_WALK_IMPORT_CATALOGUE === '1' && !!process.env.REZICS_WALK_STACK_SLOT;
  let linkScans = 0;
  const inFlight = new Set<string>();
  // Each consumer retains its oldest-first scan. A slow consumer can drain that scan
  // while another discovers positions committed since its own last scan.
  type ScannedPartition = Awaited<ReturnType<typeof scanPartitions.run>>[number];
  const pending = new Map<Relay, Iterator<ScannedPartition>>();
  const stopPositions = new Map<string, string>();
  const waiters: (() => void)[] = [];
  const key = (relay: Relay, partition: number) => `${relays.indexOf(relay)}:${partition}`;
  const notifyIdle = () => {
    if (active === 0 && !ticking) for (const resolve of waiters.splice(0)) resolve();
  };
  const idle = () =>
    active === 0 && !ticking ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));

  const run = async (relay: Relay, partition: number, through: bigint) => {
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
        // A busy writer can move the head during every apply. Release the slot once
        // this scan's work is covered so other partitions and consumers get their turn.
        if (result.status === 'busy' || result.envelopes === 0 || result.position >= through) return;
      }
    } catch (error) {
      if (!(max <= 1 && isPoolAcquireTimeout(error)))
        console.error(`Relay ${relay.consumer} failed on partition ${partition}`, error);
    } finally {
      inFlight.delete(identity);
      active--;
      notifyIdle();
    }
  };

  const dispatch = () => {
    while (!stopped && !paused && active < concurrency && pending.size) {
      const [relay, partitions] = pending.entries().next().value!;
      pending.delete(relay);
      const next = partitions.next();
      if (next.done) continue;
      // Give the next free slot to the next consumer with discovered work.
      pending.set(relay, partitions);
      const row = next.value;
      if (!inFlight.has(key(relay, row.partition_no)))
        void run(relay, row.partition_no, BigInt(row.position)).then(dispatch);
    }
  };

  const tick = async () => {
    if (stopped || paused || ticking) return;
    ticking = true;
    try {
      if (maxOnePoolBusy(pool)) return;
      for (const relay of relays) {
        if (stopped || paused) break;
        if (pending.has(relay)) continue;
        const partitions = await withConnection(pool, async (client) => {
          const rows = await scanPartitions.run(client, { consumer: relay.consumer });
          if (observeLinks && relay.consumer === 'semantic_links' && rows.length && ++linkScans <= 300)
            console.error('Reviewed link scan ' + JSON.stringify([Date.now(), rows.length, rows.slice(0, 5).map(row => row.partition_no)]));
          const oldestPendingAt = rows[0]?.oldest_pending_at;
          await upsertConsumerLag.run(client, {
            consumer: relay.consumer,
            oldest_pending_at: oldestPendingAt ? new Date(oldestPendingAt).toISOString() : '',
          });
          return rows;
        });
        if (!paused && !stopped && partitions.length) {
          pending.set(relay, partitions.values());
          dispatch();
        }
      }
    } catch (error) {
      if (!(max <= 1 && isPoolAcquireTimeout(error))) console.error('Relay partition scan failed', error);
    } finally {
      ticking = false;
      notifyIdle();
      if (!stopped && !paused) timer = setTimeout(() => void tick(), intervalMs);
    }
  };
  void tick();

  return {
    async pause(): Promise<void> {
      paused = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
      await idle();
    },
    resume(): void {
      if (stopped || !paused) return;
      paused = false;
      void tick();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending.clear();
      await idle();
    },
  };
}
