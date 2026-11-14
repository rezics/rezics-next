import type { Pool } from 'pg';
import { BoundedReadDeadlineError, withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineFor } from '../request/deadline.ts';
import read from './freshness.sql';

export type Freshness = { asOf: Date; behind: number; catchingUp: boolean };
/** Absolute caller deadline; omission inherits request time or admits ten seconds at the call. */
export type FreshnessReadContext = Readonly<{ deadline: number }>;

function observationDeadline(context?: FreshnessReadContext): number {
  const deadline = context?.deadline ?? deadlineFor(10_000);
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new BoundedReadDeadlineError();
  return deadline;
}

/** A caller can expire without retiring the read shared by longer-lived callers. */
function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  return new Promise<T>((resolve, reject) => {
    const expire = () => {
      if (finished) return;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        timer = setTimeout(expire, Math.max(1, Math.ceil(remaining)));
        return;
      }
      finished = true;
      reject(new BoundedReadDeadlineError());
    };
    timer = setTimeout(expire, Math.max(1, Math.ceil(deadline - Date.now())));
    operation.then(
      (value) => {
        if (finished) return;
        finished = true;
        if (Date.now() >= deadline) reject(new BoundedReadDeadlineError());
        else resolve(value);
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        reject(Date.now() >= deadline ? new BoundedReadDeadlineError() : error);
      },
    );
  }).finally(() => clearTimeout(timer));
}

/** Settle only after acquired-client cleanup; an expired pending checkout cannot dispatch SQL later. */
async function physicalFreshness(pool: Pool, consumer: string, deadline: number): Promise<Freshness> {
  let acquired = false;
  let released: Promise<void> | undefined;
  try {
    return await withBoundedReadLifetime(
      (work) => {
        const checkout = withConnection(pool, (client) => {
          acquired = true;
          return work(client);
        });
        released = checkout.then(
          () => undefined,
          () => undefined,
        );
        return checkout;
      },
      discardConnection,
      deadline,
      async (client) => {
        const row = await read.run(client, { consumer });
        if (!row) throw new Error('Freshness query returned no row');

        const now = new Date(row.now);
        const behind = row.behind;
        if (behind > 0 && row.oldest === null)
          throw new Error('Freshness query found partitions behind without an envelope');
        const asOf = behind > 0 ? new Date(row.oldest!) : now;

        return { asOf, behind, catchingUp: behind > 0 && now.getTime() - asOf.getTime() > 60_000 };
      },
      {
        // A driver timeout can reject its promise before the server has stopped the statement.
        isUncertainSettledQueryError: () => true,
      },
    );
  } finally {
    if (acquired) await released;
  }
}

export async function readFreshness(
  pool: Pool,
  consumer: string,
  context?: FreshnessReadContext,
): Promise<Freshness> {
  const deadline = observationDeadline(context);
  return beforeDeadline(physicalFreshness(pool, consumer, deadline), deadline);
}

/**
 * Answers each `current()` call from a read that began after the call. At most one read runs; calls made while it runs
 * share the next read, which begins after the running one retires. Every caller keeps its admission deadline;
 * the physical read uses the latest deadline in its batch, fixed before checkout.
 */
export function createFreshness(
  pool: Pool,
  consumer: string,
): { current(context?: FreshnessReadContext): Promise<Freshness> } {
  type Batch = {
    deadline: number;
    promise: Promise<Freshness>;
    resolve(value: Freshness): void;
    reject(error: unknown): void;
  };
  let running = false;
  let queued: Batch | undefined;

  function batch(deadline: number): Batch {
    let resolve!: Batch['resolve'];
    let reject!: Batch['reject'];
    const promise = new Promise<Freshness>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    return { deadline, promise, resolve, reject };
  }

  function start(pending: Batch): void {
    running = true;
    const read = physicalFreshness(pool, consumer, pending.deadline);
    read.then(pending.resolve, pending.reject);
    const settled = () => {
      const next = queued;
      queued = undefined;
      if (next) start(next);
      else running = false;
    };
    read.then(settled, settled);
  }

  return {
    async current(context?: FreshnessReadContext): Promise<Freshness> {
      const deadline = observationDeadline(context);
      let pending: Batch;
      if (running) {
        pending = (queued ??= batch(deadline));
        pending.deadline = Math.max(pending.deadline, deadline);
      } else {
        pending = batch(deadline);
        start(pending);
      }
      return beforeDeadline(pending.promise, deadline);
    },
  };
}
