import { discardConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient, QueryConfig, QueryResult } from 'pg';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './collection-source.ts';

const axes = [
  'candidateKeys',
  'identityMetadataRows',
  'nativeRows',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
  'emptySeeks',
] as const satisfies readonly (keyof WorkDimensions)[];

function zero(): Record<keyof WorkDimensions, number> {
  return Object.fromEntries(axes.map((axis) => [axis, 0])) as Record<keyof WorkDimensions, number>;
}

/** Private accounting only. SQL/API owners supply the proved footprint before dispatch. */
export class NativeCollectionWork {
  private readonly used = zero();
  private readonly held = zero();
  private readonly remaining: WorkDimensions;
  failure: Error | undefined;

  constructor(
    private readonly allowance: WorkAllowance,
    private readonly deadline: number,
  ) {
    if (!allowance.reservationId || !Number.isFinite(deadline)) throw new TypeError('Invalid source reservation');
    for (const axis of axes)
      if (!Number.isSafeInteger(allowance.remaining[axis]) || allowance.remaining[axis] < 0)
        throw new TypeError('Invalid source work dimension');
    this.remaining = Object.freeze({ ...allowance.remaining });
  }

  receipt(): WorkReceipt {
    return Object.freeze({ reservationId: this.allowance.reservationId, used: Object.freeze({ ...this.used }) });
  }

  available(axis: keyof WorkDimensions): number {
    return this.remaining[axis] - this.used[axis] - this.held[axis];
  }

  assertReady(): void {
    if (this.failure) throw this.failure;
  }

  /** Undefined means unproved, including for an operation expected to return no rows. */
  reserve(
    footprint: WorkDimensions | undefined,
    cleanup = false,
  ): {
    dispatch(): void;
    settle(actual?: Partial<WorkDimensions>): void;
    cancel(): void;
  } {
    if (Date.now() >= this.deadline || footprint === undefined) throw this.unavailable();
    const bound = Object.freeze({ ...footprint });
    for (const axis of axes) {
      if (!Number.isSafeInteger(bound[axis]) || bound[axis] < 0) throw new TypeError('Invalid native footprint');
      if (bound[axis] > this.remaining[axis] - this.used[axis] - this.held[axis]) throw this.unavailable();
    }
    for (const axis of axes) this.held[axis] += bound[axis];
    let state: 'reserved' | 'dispatched' | 'settled' = 'reserved';
    const release = (charged: WorkDimensions) => {
      for (const axis of axes) {
        this.held[axis] -= bound[axis];
        this.used[axis] += charged[axis];
      }
      state = 'settled';
    };
    return {
      dispatch: () => {
        if (state !== 'reserved') throw new TypeError('Source work already dispatched');
        if (!cleanup && Date.now() >= this.deadline) {
          release(zero());
          throw this.unavailable();
        }
        state = 'dispatched';
      },
      settle: (actual = {}) => {
        if (state !== 'dispatched') throw new TypeError('Source work was not dispatched');
        const charged = { ...bound, ...actual };
        for (const axis of axes)
          if (!Number.isSafeInteger(charged[axis]) || charged[axis] < 0 || charged[axis] > bound[axis])
            throw new TypeError('Native work exceeded its reservation');
        // nativeRows is the admitted operation bound, never result.rowCount or observed physical tuples.
        if (charged.nativeRows !== bound.nativeRows) throw new TypeError('Cannot refund dispatched native row work');
        release(charged);
      },
      cancel: () => {
        if (state !== 'reserved') throw new TypeError('Cannot cancel dispatched source work');
        release(zero());
      },
    };
  }

  private unavailable(): ProblemError {
    const error = new ProblemError('dependency_unavailable');
    Object.defineProperty(error, 'work', { get: () => this.receipt(), configurable: true });
    return error;
  }
}

type Footprint = (sql: string, values: readonly unknown[]) => WorkDimensions | undefined;
const observing = new AsyncLocalStorage<{ work: NativeCollectionWork; footprint: Footprint }>();
const pools = new WeakSet<Pool>();
const clients = new WeakSet<PoolClient>();

/** Observe the original pool/clients: no shadow pool, client proxy or identity/time registration changes. */
export async function instrumentNativeCollectionWork<T>(
  pool: Pool,
  work: NativeCollectionWork,
  footprint: Footprint,
  operation: () => Promise<T>,
): Promise<T> {
  if (!pools.has(pool)) {
    pools.add(pool);
    const connect = pool.connect.bind(pool);
    pool.connect = ((...args: unknown[]) => {
      const active = observing.getStore();
      if (active) {
        const checkout = active.work.reserve({ ...zero(), nativePoints: 1 });
        checkout.dispatch();
        checkout.settle();
      }
      return (connect as unknown as (...args: unknown[]) => unknown)(...args);
    }) as Pool['connect'];
    pool.on('acquire', (client) => {
      if (clients.has(client)) return;
      clients.add(client);
      const original = client.query;
      let terminal:
        | {
            work: NativeCollectionWork;
            reservation: ReturnType<NativeCollectionWork['reserve']>;
            bound: WorkDimensions;
          }
        | undefined;
      client.query = function (...args: unknown[]) {
        const active = observing.getStore();
        const invoke = original as unknown as (...args: unknown[]) => unknown;
        if (!active) return invoke.apply(this, args);
        const config = args[0] as string | QueryConfig;
        const sql = typeof config === 'string' ? config : config.text;
        const values = (typeof config === 'string' ? args[1] : config.values) as unknown[] | undefined;
        const finishing = /^(?:COMMIT|ROLLBACK)\b/i.test(sql) && terminal?.work === active.work;
        let reservation: ReturnType<NativeCollectionWork['reserve']>;
        let bound: WorkDimensions | undefined;
        try {
          if (finishing && terminal) {
            ({ reservation, bound } = terminal);
            terminal = undefined;
          } else {
            active.work.assertReady();
            if (/^BEGIN\b/i.test(sql)) {
              const cleanupBound = active.footprint('ROLLBACK', []);
              const cleanup = active.work.reserve(cleanupBound, true);
              terminal = { work: active.work, reservation: cleanup, bound: cleanupBound! };
            }
            bound = active.footprint(sql, Array.isArray(values) ? values : []);
            reservation = active.work.reserve(bound);
          }
          reservation.dispatch();
        } catch (error) {
          active.work.failure = error instanceof Error ? error : new Error('Native work admission failed');
          throw error;
        }
        const settle = (result?: QueryResult, error?: unknown) => {
          if ((finishing || /^BEGIN\b/i.test(sql)) && error)
            discardConnection(client, error instanceof Error ? error : new Error('Native transaction cleanup failed'));
          reservation.settle({
            emptySeeks: bound!.emptySeeks && result?.rows.length === 0 ? 1 : 0,
            candidateKeys: result ? Math.min(bound!.candidateKeys, result.rows.length) : bound!.candidateKeys,
            witnessKeys: result ? Math.min(bound!.witnessKeys, result.rows.length) : bound!.witnessKeys,
          });
        };
        const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
        if (callbackIndex >= 0) {
          const callback = args[callbackIndex] as (error: unknown, result: QueryResult) => void;
          args[callbackIndex] = (error: unknown, result: QueryResult) => {
            settle(result, error);
            callback(error, result);
          };
          try {
            return invoke.apply(this, args);
          } catch (error) {
            settle(undefined, error);
            throw error;
          }
        }
        try {
          return Promise.resolve(invoke.apply(this, args)).then(
            (result) => {
              settle(result as QueryResult);
              return result;
            },
            (error) => {
              settle(undefined, error);
              throw error;
            },
          );
        } catch (error) {
          settle(undefined, error);
          throw error;
        }
      } as PoolClient['query'];
    });
  }
  return observing.run({ work, footprint }, async () => {
    try {
      const result = await operation();
      work.assertReady();
      return result;
    } catch (error) {
      if (error instanceof Error)
        Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
      throw error;
    }
  });
}
