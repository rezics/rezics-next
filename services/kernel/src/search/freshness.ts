import { preparedStatementClient } from '../database/native-source-query.ts';
import type { Pool, PoolClient } from 'pg';
import { BoundedReadDeadlineError, withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineFor } from '../request/deadline.ts';
import { PARTITIONS } from '../route/contract.ts';
import read from './freshness.sql';
import readObservation from './freshness-observation.sql';

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

type ObservationCut = { snapshot: string; revision: string; pending: Map<number, number | null> };
type ObservationState = { dense: boolean; clients: WeakMap<PoolClient, ObservationCut> };

// At sparse cuts the one-shot aggregate avoids transporting individual points.
const DENSE_BACKLOG = 128;

function freshnessAt(at: Date, behind: number, oldest: Date | null): Freshness {
  if (!behind) return { asOf: at, behind, catchingUp: false };
  if (!oldest) throw new Error('Freshness query found partitions behind without an envelope');
  return { asOf: oldest, behind, catchingUp: at.getTime() - oldest.getTime() > 60_000 };
}

async function observeChangedHomes(client: PoolClient, consumer: string, previous?: ObservationCut) {
  const transport = preparedStatementClient(
    client,
    readObservation['~standard'].query.text,
    'search_freshness_observation_v2',
  );
  const [row] = await readObservation.run(transport, {
    consumer,
    snapshot: previous?.snapshot ?? '',
    revision: previous?.revision ?? '',
  });
  if (!row?.snapshot || !Array.isArray(row.homes) || row.homes.length > PARTITIONS || (!row.complete && !previous))
    throw new Error('Freshness observation is incomplete');
  const pending = new Map(row.complete ? undefined : previous!.pending);
  for (const point of row.homes) {
    if (!Array.isArray(point)) throw new Error('Freshness observation returned an invalid home');
    const [home, behind, recorded] = point;
    if (
      typeof home !== 'number' ||
      !Number.isInteger(home) ||
      home < 0 ||
      home >= PARTITIONS ||
      typeof behind !== 'boolean'
    )
      throw new Error('Freshness observation returned an invalid home');
    if (behind) pending.set(home, recorded === null ? null : new Date(recorded).getTime());
    else pending.delete(home);
  }
  let oldest = Infinity;
  let missing = false;
  for (const value of pending.values()) {
    if (value === null) missing = true;
    else oldest = Math.min(oldest, value);
  }
  const freshness = freshnessAt(new Date(row.now), pending.size, oldest === Infinity ? null : new Date(oldest));
  // An insert can fill a hole without moving the head or checkpoint.
  const cut = missing ? undefined : { snapshot: row.snapshot, revision: row.revision, pending };
  return { freshness, cut };
}

/** Settle only after acquired-client cleanup; an expired pending checkout cannot dispatch SQL later. */
async function physicalFreshness(
  pool: Pool,
  consumer: string,
  deadline: number,
  state?: ObservationState,
): Promise<Freshness> {
  let physical: PoolClient | undefined;
  let released: Promise<void> | undefined;
  try {
    return await withBoundedReadLifetime(
      (work) => {
        const checkout = withConnection(pool, (client) => {
          physical = client;
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
        if (state?.dense && physical) {
          // The next observation must use the same PostgreSQL instance and transaction history.
          // Replacing a physical connection starts a fresh cut.
          const observed = await observeChangedHomes(client, consumer, state.clients.get(physical));
          state.dense = observed.freshness.behind >= DENSE_BACKLOG;
          if (state.dense && observed.cut) state.clients.set(physical, observed.cut);
          else state.clients.delete(physical);
          return observed.freshness;
        }
        const row = await read.run(client, { consumer });
        if (!row) throw new Error('Freshness query returned no row');

        if (state) state.dense = row.behind >= DENSE_BACKLOG;
        return freshnessAt(new Date(row.now), row.behind, row.oldest === null ? null : new Date(row.oldest));
      },
      {
        // A driver timeout can reject its promise before the server has stopped the statement.
        isUncertainSettledQueryError: () => true,
      },
    );
  } finally {
    if (physical) await released;
  }
}

export async function readFreshness(pool: Pool, consumer: string, context?: FreshnessReadContext): Promise<Freshness> {
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
  const state: ObservationState | undefined = consumer.startsWith('search_')
    ? { dense: false, clients: new WeakMap() }
    : undefined;
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
    const read = physicalFreshness(pool, consumer, pending.deadline, state);
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
        pending = queued ??= batch(deadline);
        pending.deadline = Math.max(pending.deadline, deadline);
      } else {
        pending = batch(deadline);
        start(pending);
      }
      return beforeDeadline(pending.promise, deadline);
    },
  };
}
