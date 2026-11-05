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

/**
 * Answers each `current()` call from a read that began after the call. At most one read runs; calls made while it runs
 * share the next read, which begins when the running one settles.
 */
export function createFreshness(pool: Pool, consumer: string): { current(): Promise<Freshness> } {
  let running = false;
  let queued: { promise: Promise<Freshness>; start(): void } | undefined;

  function start(): Promise<Freshness> {
    running = true;
    const read = readFreshness(pool, consumer);
    const settled = () => {
      const next = queued;
      queued = undefined;
      if (next) next.start();
      else running = false;
    };
    read.then(settled, settled);
    return read;
  }

  return {
    current(): Promise<Freshness> {
      if (!running) return start();
      if (!queued) {
        let begin!: () => void;
        const promise = new Promise<Freshness>((resolve) => (begin = () => resolve(start())));
        queued = { promise, start: begin };
      }
      return queued.promise;
    },
  };
}
