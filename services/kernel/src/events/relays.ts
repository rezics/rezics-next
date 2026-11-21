import type { Pool, PoolClient } from 'pg';
import { NestedPoolCheckoutError, withConnection } from '../database/pool.ts';
import { createRelayDiscovery } from './relay-discovery.ts';
import type { BatchResult } from './log.ts';

type RelayHome = { partition_no: number; position: string | bigint };
export type Relay = {
  consumer: string;
  run(partition: number): Promise<BatchResult>;
  scanPriority?(client: PoolClient): Promise<readonly RelayHome[]>;
};

/** Default in-flight relay homes. A max-one pool shares its only connection; larger pools keep one slot free. */
export function relayConcurrencyForPool(pool: Pool, ceiling = 4): number {
  const max = pool.options.max ?? 10;
  if (!Number.isInteger(max) || max < 1) return 1;
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new RangeError('Invalid relay concurrency ceiling');
  return max <= 1 ? 1 : Math.min(ceiling, max - 1);
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
  const discover = createRelayDiscovery(pool);
  let paused = options.paused ?? false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = 0;
  let ticking = false;
  const inFlight = new Set<string>();
  // Each consumer retains its oldest-first scan. A slow consumer can drain that scan
  // while another discovers positions committed since its own last scan.
  const pending = new Map<Relay, IterableIterator<RelayHome>>();
  const priority = new Map<Relay, IterableIterator<RelayHome>>();
  let preferPriority = true;
  const stopPositions = new Map<string, string>();
  const waiters: (() => void)[] = [];
  const key = (relay: Relay, partition: number) => `${relays.indexOf(relay)}:${partition}`;
  const notifyIdle = () => {
    if (active === 0 && !ticking) for (const resolve of waiters.splice(0)) resolve();
  };
  const idle = () =>
    active === 0 && !ticking ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve));

  const run = async (relay: Relay, partition: number, through: bigint, singleBatch: boolean) => {
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
        // Release the slot at this scan's captured head or the next batch boundary
        // when a priority turn is waiting. A later scan resumes the committed checkpoint.
        if (priority.size > 0) return;
        if (singleBatch || result.status === 'busy' || result.envelopes === 0 || result.position >= through) return;
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
    while (!stopped && !paused && active < concurrency && (pending.size || priority.size)) {
      const urgent = priority.size > 0 && (preferPriority || !pending.size);
      const queue = urgent ? priority : pending;
      const [relay, partitions] = queue.entries().next().value!;
      queue.delete(relay);
      const next = partitions.next();
      if (next.done) continue;
      // Give the next free slot to the next consumer with discovered work.
      queue.set(relay, partitions);
      const row = next.value;
      if (inFlight.has(key(relay, row.partition_no))) continue;
      // Priority work can bring a home forward by one batch. Oldest-first dispatch
      // keeps moving even when every scan finds more priority work waiting.
      preferPriority = !urgent;
      void run(relay, row.partition_no, BigInt(row.position), urgent).then(dispatch);
    }
  };

  const tick = async () => {
    if (stopped || paused || ticking) return;
    ticking = true;
    try {
      if (maxOnePoolBusy(pool)) return;
      for (const relay of relays) {
        if (stopped || paused) break;
        const scanPriority = relay.scanPriority?.bind(relay);
        if (scanPriority) {
          const homes = await withConnection(pool, scanPriority).catch((error: unknown) => {
            if (!(max <= 1 && isPoolAcquireTimeout(error)))
              console.error(`Relay ${relay.consumer} priority scan failed`, error);
            return [];
          });
          if (stopped || paused) break;
          // A batch may outlast several scans. Keep live homes that still await
          // a turn ahead of homes whose previous batch has already started.
          const live = new Map(homes.map((home) => [home.partition_no, home]));
          const waiting: RelayHome[] = [];
          for (const previous of priority.get(relay) ?? []) {
            const home = live.get(previous.partition_no);
            if (home) {
              waiting.push(home);
              live.delete(home.partition_no);
            }
          }
          waiting.push(...live.values());
          if (waiting.length) priority.set(relay, waiting.values());
          else priority.delete(relay);
          dispatch();
        }
      }
      if (paused || stopped) return;
      const available = relays.filter((relay) => !pending.has(relay));
      if (!available.length) return;
      const backlogs = await discover(available.map((relay) => relay.consumer));
      for (const relay of available) {
        const partitions = backlogs.get(relay.consumer)!;
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
      priority.clear();
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
      priority.clear();
      await idle();
    },
  };
}
