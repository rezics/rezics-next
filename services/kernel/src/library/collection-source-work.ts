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

type WorkPlan = { end: WorkDimensions; active: boolean; parent: WorkPlan | undefined };
function livePlan(plan: WorkPlan | undefined): boolean {
  for (; plan; plan = plan.parent) if (!plan.active) return false;
  return true;
}

// Receipts identify the existing private ledger for receiving-only constraints. They
// never supply funding or expose its target through the producer's guarded object.
const receiptLedgers = new WeakMap<object, NativeCollectionWork>();
const ledgerAliases = new WeakMap<object, NativeCollectionWork>();
const receivingLifetimes = new WeakMap<NativeCollectionWork, () => void>();
const composing = new AsyncLocalStorage<readonly NativeCollectionWork[]>();
const manuallyObserved = new AsyncLocalStorage<Observation | undefined>();

function receivedLedger(work: NativeCollectionWork): NativeCollectionWork {
  work.assertReady();
  const ledger = receiptLedgers.get(work.receipt());
  if (!ledger) throw new TypeError('Unknown native work ledger');
  ledgerAliases.set(work, ledger);
  return ledger;
}

/** Constrain dispatch on the SAME Accounts-owned object without closing its counters.
 * This adds a restriction, never original authority or a replacement allocation. */
export function bindNativeCollectionWorkLifetime(work: NativeCollectionWork, assertLive: () => void): void {
  const ledger = receivedLedger(work);
  if (receivingLifetimes.has(ledger)) throw new TypeError('Native work already received');
  assertLive();
  receivingLifetimes.set(ledger, assertLive);
}

/** The producer deliberately exposes a restricted object. Apply the native plan to
 * its private target, while every operation and callback still uses that SAME object
 * and its original producer checks. No new proxy, ledger, receipt or allowance. */
export function withNativeCollectionWorkAllowance<T>(
  work: NativeCollectionWork,
  allowance: WorkAllowance,
  operation: () => Promise<T>,
): Promise<T> {
  const ledger = receivedLedger(work);
  return ledger.withinAllowance(allowance, async () => {
    work.assertReady();
    const result = await operation();
    work.assertReady();
    return result;
  });
}

/** Private accounting only. SQL/API owners supply the proved footprint before dispatch. */
export class NativeCollectionWork {
  private readonly used = zero();
  private readonly held = zero();
  private readonly remaining: WorkDimensions;
  private closed = false;
  private pending = 0;
  private readonly planned = new AsyncLocalStorage<WorkPlan>();
  private open = true;
  failure: Error | undefined;
  private readonly resultBytes = new Map<string, number>();

  /** A same-snapshot size point admits an otherwise unbounded native projection. */
  admitResultBytes(key: string, bytes: number): void {
    this.assertReady();
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid native byte admission');
    this.resultBytes.set(key, bytes);
  }

  resultByteBound(key: string): number | undefined {
    this.assertReady();
    return this.resultBytes.get(key);
  }

  constructor(
    private readonly allowance: WorkAllowance,
    private readonly deadline: number,
  ) {
    const reservationId = allowance.reservationId;
    const initial = { ...allowance.remaining };
    if (!reservationId || !Number.isFinite(deadline)) throw new TypeError('Invalid source reservation');
    for (const axis of axes)
      if (!Number.isSafeInteger(initial[axis]) || initial[axis] < 0)
        throw new TypeError('Invalid source work dimension');
    ledgerAliases.set(this, this);
    this.remaining = Object.freeze(initial);
    this.allowance = Object.freeze({ reservationId, remaining: this.remaining });
  }

  /** The native caller binds this exact frame to its live operational transaction and deadline. */
  get deadlineAt(): number {
    return this.deadline;
  }

  receipt(): WorkReceipt {
    const receipt = Object.freeze({
      reservationId: this.allowance.reservationId,
      used: Object.freeze({ ...this.used }),
    });
    receiptLedgers.set(receipt, this);
    return receipt;
  }

  available(axis: keyof WorkDimensions): number {
    const plan = this.planned.getStore();
    if (!this.open || !livePlan(plan)) return 0;
    receivingLifetimes.get(this)?.();
    return Math.max(
      0,
      Math.min(this.remaining[axis], plan?.end[axis] ?? this.remaining[axis]) - this.used[axis] - this.held[axis],
    );
  }

  /** Apply one cumulative ceiling to this SAME ledger, including child transfers,
   * checkouts and held transaction cleanup. This creates no allocation or receipt.
   */
  async withinAllowance<T>(allowance: WorkAllowance, operation: () => Promise<T>): Promise<T> {
    this.assertReady();
    if (Date.now() >= this.deadline) throw this.unavailable();
    if (allowance.reservationId !== this.allowance.reservationId)
      throw new TypeError('Foreign source work reservation');
    const end = zero();
    for (const axis of axes) {
      const remaining = allowance.remaining[axis];
      if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > this.available(axis))
        throw new TypeError('Source work plan exceeds remaining reservation');
      end[axis] = this.used[axis] + this.held[axis] + remaining;
    }
    const plan = { end: Object.freeze(end), active: true, parent: this.planned.getStore() };
    return this.planned.run(plan, async () => {
      try {
        const result = await operation();
        this.assertReady();
        return result;
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error('Source work continuation failed');
        throw error;
      } finally {
        plan.active = false;
      }
    });
  }

  /** Transfer every declared child before any child can dispatch. Unused child capacity stays
   * held until the entire group finishes; siblings cannot borrow it, retry with it or add a payer.
   * This transfers accounting only. It establishes no Source, Access or physical-work authority.
   */
  transferChildren<K extends string>(
    declarations: Readonly<Record<K, WorkDimensions>>,
  ): Readonly<{
    children: Readonly<Record<K, NativeCollectionWork>>;
    finish(): WorkReceipt;
  }> {
    this.assertReady();
    if (Date.now() >= this.deadline) throw this.unavailable();
    const entries = Object.entries(declarations) as [K, WorkDimensions][];
    if (!entries.length) throw new TypeError('Missing native child declarations');
    const total = zero();
    const children = Object.create(null) as Record<K, NativeCollectionWork>;
    for (const [name, declaration] of entries) {
      const snapshot = { ...declaration };
      for (const axis of axes) {
        const amount = snapshot[axis];
        if (!Number.isSafeInteger(amount) || amount < 0) throw new TypeError('Invalid native child declaration');
        total[axis] += amount;
        if (!Number.isSafeInteger(total[axis])) throw new TypeError('Native child declaration overflow');
      }
      children[name] = new NativeCollectionWork(
        { reservationId: this.allowance.reservationId, remaining: snapshot },
        this.deadline,
      );
    }
    // Validate the complete sum before changing any balance. No partial allocation on refusal.
    for (const axis of axes) if (total[axis] > this.available(axis)) throw this.unavailable();
    for (const axis of axes) this.held[axis] += total[axis];
    this.pending++;
    let finished = false;
    return Object.freeze({
      children: Object.freeze(children),
      finish: () => {
        if (finished) throw new TypeError('Native children already finished');
        const used = zero();
        const values = Object.values(children) as NativeCollectionWork[];
        for (const child of values) {
          if (child.pending !== 0) throw new TypeError('Native child work is still in flight');
          for (const axis of axes) used[axis] += child.used[axis];
        }
        finished = true;
        this.pending--;
        for (const child of values) {
          child.closed = true;
          child.open = false;
          this.failure ??= child.failure;
        }
        for (const axis of axes) {
          this.held[axis] -= total[axis];
          this.used[axis] += used[axis];
        }
        return this.receipt();
      },
    });
  }

  /** Transfer the remaining reservation to ONE existing producer ledger, never a second allowance.
   * The parent cannot dispatch while it is held. Unlike an SQL footprint this is not itself native work:
   * the child reserves its actual operation bounds before dispatch and returns those charges unchanged.
   */
  async compose<T extends { readonly work: WorkReceipt }>(
    operation: (allowance: WorkAllowance) => Promise<T>,
    ceiling?: WorkDimensions,
  ): Promise<T> {
    this.assertReady();
    if (Date.now() >= this.deadline) throw this.unavailable();
    const available = zero();
    const ceilingSnapshot = ceiling === undefined ? undefined : { ...ceiling };
    for (const axis of axes) {
      if (ceilingSnapshot && (!Number.isSafeInteger(ceilingSnapshot[axis]) || ceilingSnapshot[axis] < 0))
        throw new TypeError('Invalid composed source work ceiling');
      available[axis] = this.available(axis);
    }
    const remaining = zero();
    for (const axis of axes) {
      remaining[axis] = Math.min(available[axis], ceilingSnapshot?.[axis] ?? available[axis]);
    }
    for (const axis of axes) {
      this.held[axis] += remaining[axis];
    }
    this.pending++;
    const settle = (receipt: WorkReceipt) => {
      receipt = Object.freeze({ reservationId: receipt.reservationId, used: Object.freeze({ ...receipt.used }) });
      if (receipt.reservationId !== this.allowance.reservationId) throw new TypeError('Foreign source work receipt');
      for (const axis of axes)
        if (!Number.isSafeInteger(receipt.used[axis]) || receipt.used[axis] < 0 || receipt.used[axis] > remaining[axis])
          throw new TypeError('Composed source exceeded its reservation');
      for (const axis of axes) {
        this.held[axis] -= remaining[axis];
        this.used[axis] += receipt.used[axis];
      }
      this.pending--;
    };
    try {
      Object.freeze(remaining);
      const result = await composing.run([...(composing.getStore() ?? []), this], () =>
        operation(Object.freeze({ reservationId: this.allowance.reservationId, remaining })),
      );
      this.assertReady();
      settle(result.work);
      return result;
    } catch (error) {
      // A child that did not complete cannot release its prepaid partition.
      // Failed/rejected/rolled-back callbacks retain the entire dispatched transfer.
      const failed = error instanceof Error && 'work' in error ? (error.work as WorkReceipt) : undefined;
      let accounted = false;
      if (failed) {
        try {
          settle(failed);
          accounted = true;
        } catch {
          /* unknown work stays fully charged */
        }
      }
      if (!accounted) {
        for (const axis of axes) {
          this.held[axis] -= remaining[axis];
          this.used[axis] += remaining[axis];
        }
        this.pending--;
      }
      this.failure = error instanceof Error ? error : new Error('Composed source failed');
      if (error instanceof Error)
        Object.defineProperty(error, 'work', { get: () => this.receipt(), configurable: true });
      throw error;
    }
  }

  /** Permanently end this callback-owned ledger; this never releases spent work. */
  close(): void {
    if (this.pending !== 0) throw new TypeError('Native work is still in flight');
    this.closed = true;
    this.open = false;
  }

  assertReady(): void {
    if (this.closed) throw new TypeError('Native work allocation is closed');
    receivingLifetimes.get(this)?.();
    if (this.failure) throw this.failure;
    if (!this.open || Date.now() >= this.deadline || !livePlan(this.planned.getStore())) throw this.unavailable();
  }

  /** Undefined means unproved, including for an operation expected to return no rows. */
  reserve(
    footprint: WorkDimensions | undefined,
    cleanup = false,
  ): {
    dispatch(): void;
    query<T>(operation: () => Promise<T>): Promise<T>;
    settle(actual?: Partial<WorkDimensions>): void;
    cancel(): void;
  } {
    if (this.closed) throw new TypeError('Native work allocation is closed');
    const plan = this.planned.getStore();
    receivingLifetimes.get(this)?.();
    if (!this.open || !livePlan(plan)) throw this.unavailable();
    if (!cleanup) this.assertReady();
    if (Date.now() >= this.deadline || footprint === undefined) throw this.unavailable();
    const bound = Object.freeze({ ...footprint });
    for (const axis of axes) {
      if (!Number.isSafeInteger(bound[axis]) || bound[axis] < 0) throw new TypeError('Invalid native footprint');
      if (bound[axis] > this.available(axis)) throw this.unavailable();
    }
    for (const axis of axes) this.held[axis] += bound[axis];
    this.pending++;
    let state: 'reserved' | 'dispatched' | 'settled' = 'reserved';
    let queried = false;
    const release = (charged: WorkDimensions) => {
      for (const axis of axes) {
        this.held[axis] -= bound[axis];
        this.used[axis] += charged[axis];
      }
      state = 'settled';
      this.pending--;
    };
    return {
      dispatch: () => {
        if (state !== 'reserved') throw new TypeError('Source work already dispatched');
        receivingLifetimes.get(this)?.();
        if (!this.open || !livePlan(plan) || (!cleanup && Date.now() >= this.deadline)) {
          release(zero());
          throw this.unavailable();
        }
        state = 'dispatched';
      },
      // The owner already admitted this literal. Suppress only duplicate observation of this
      // single dispatched query; no unreserved operation can enter the enclosing frame this way.
      query: async (operation) => {
        receivingLifetimes.get(this)?.();
        if (!this.open || !livePlan(plan) || Date.now() >= this.deadline) throw this.unavailable();
        if (state !== 'dispatched' || queried) throw new TypeError('Source query was not uniquely dispatched');
        queried = true;
        // A local ledger is only a child cap unless its receipt is actually
        // composed by the parent. It cannot suppress another ledger's observer.
        const active = observing.getStore();
        assertObservation(active);
        let result: Awaited<ReturnType<typeof operation>>;
        if (active && ledgerAliases.get(active.work) === this) {
          // Suppress the duplicate charge, never the owner's literal policy. The
          // manually held amount must cover the actual literal on all eight axes.
          let dispatched = false;
          const required = {
            pool: active.pool,
            work: active.work,
            active: true,
            footprint: (sql: string, values: readonly unknown[]) => {
              const literal = active.footprint(sql, values);
              if (dispatched || !literal || !axes.every((axis) => literal[axis] <= bound[axis])) return undefined;
              dispatched = true;
              return literal;
            },
          };
          let parent = active.parent;
          while (parent && ledgerAliases.get(parent.work) === this) parent = parent.parent;
          try {
            result = await requiredFootprints.run([...(requiredFootprints.getStore() ?? []), required], () =>
              manuallyObserved.run(active, () => observing.run(parent, operation)),
            );
          } finally {
            required.active = false;
          }
        } else {
          result = await operation();
        }
        assertObservation(active);
        receivingLifetimes.get(this)?.();
        if (!this.open || !livePlan(plan) || Date.now() >= this.deadline) throw this.unavailable();
        return result;
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
    Object.defineProperty(error, 'work', { value: this.receipt(), configurable: true });
    return error;
  }
}

type Footprint = (sql: string, values: readonly unknown[]) => WorkDimensions | undefined;
type Observation = {
  pool: Pool;
  work: NativeCollectionWork;
  footprint: Footprint;
  active: boolean;
  parent: Observation | undefined;
};
function assertObservation(observation: Observation | undefined): void {
  for (; observation; observation = observation.parent)
    if (!observation.active) throw new ProblemError('dependency_unavailable');
}
const observing = new AsyncLocalStorage<Observation | undefined>();
const requiredFootprints = new AsyncLocalStorage<
  readonly { pool: Pool; work: NativeCollectionWork; footprint: Footprint; active: boolean }[]
>();
const pools = new WeakSet<Pool>();
type NativeQueryClient = Pick<PoolClient, 'query'>;
const clients = new WeakSet<NativeQueryClient>();
const checkoutObservations = new WeakMap<NativeQueryClient, Observation | undefined>();

function observeNativeCollectionClient(client: NativeQueryClient, pool: Pool, delegated = false): void {
  if (clients.has(client)) return;
  clients.add(client);
  const original = client.query;
  type Control = { reservation: ReturnType<NativeCollectionWork['reserve']>; bound: WorkDimensions };
  let terminal:
    | {
        work: NativeCollectionWork;
        commit?: Control;
        rollback?: Control;
      }
    | undefined;
  const cancelTerminal = () => {
    terminal?.commit?.reservation.cancel();
    terminal?.rollback?.reservation.cancel();
    terminal = undefined;
  };
  client.query = function (this: NativeQueryClient, ...args: unknown[]) {
    const active = observing.getStore();
    const checkout = checkoutObservations.get(client);
    assertObservation(checkout);
    assertObservation(active);
    assertObservation(manuallyObserved.getStore());
    if (checkout) {
      let ancestor = manuallyObserved.getStore() ?? active;
      while (ancestor && ancestor !== checkout) ancestor = ancestor.parent;
      if (!ancestor) throw new ProblemError('dependency_unavailable');
    }
    const invoke = original as unknown as (...args: unknown[]) => unknown;
    // A live Core transaction forwards to a bound PoolClient query. Observe that exact
    // transaction even if it predates pool instrumentation, without charging its client twice.
    const invokeQuery = () =>
      delegated
        ? manuallyObserved.run(active ?? manuallyObserved.getStore(), () =>
            requiredFootprints.run([], () => observing.run(undefined, () => invoke.apply(this, args))),
          )
        : invoke.apply(this, args);
    const config = args[0] as string | QueryConfig;
    const sql = typeof config === 'string' ? config : config.text;
    const values = (typeof config === 'string' ? args[1] : config.values) as unknown[] | undefined;
    for (const required of requiredFootprints.getStore() ?? []) {
      if (required.pool !== pool) continue;
      try {
        if (!required.active) throw new ProblemError('dependency_unavailable');
        if (!required.footprint(sql, Array.isArray(values) ? values : []))
          throw new ProblemError('dependency_unavailable');
        // A real transaction keeps its already held cleanup even after a refusal.
        const cleanup =
          (sql === 'COMMIT' || sql === 'ROLLBACK') && terminal !== undefined && terminal.work === active?.work;
        if (!cleanup) required.work.assertReady();
      } catch (error) {
        required.work.failure = error instanceof Error ? error : new Error('Unproved transferred source statement');
        throw error;
      }
    }
    if (!active) return invoke.apply(this, args);
    const beginning = /^BEGIN\b/i.test(sql);
    const control = sql === 'COMMIT' ? 'commit' : sql === 'ROLLBACK' ? 'rollback' : undefined;
    const finishing = control !== undefined && terminal?.work === active.work;
    let beganReservation = false;
    let reservation: ReturnType<NativeCollectionWork['reserve']>;
    let bound: WorkDimensions | undefined;
    try {
      if (finishing && terminal) {
        const slot = terminal[control!];
        if (!slot) throw new TypeError('Native transaction control already dispatched');
        ({ reservation, bound } = slot);
        delete terminal[control!];
      } else {
        active.work.assertReady();
        if (beginning) {
          if (terminal) throw new TypeError('Native transaction cleanup is still reserved');
          const commitBound = active.footprint('COMMIT', []);
          const commit = active.work.reserve(commitBound, true);
          try {
            const rollbackBound = active.footprint('ROLLBACK', []);
            const rollback = active.work.reserve(rollbackBound, true);
            terminal = {
              work: active.work,
              commit: { reservation: commit, bound: commitBound! },
              rollback: { reservation: rollback, bound: rollbackBound! },
            };
            beganReservation = true;
          } catch (error) {
            commit.cancel();
            throw error;
          }
        }
        bound = active.footprint(sql, Array.isArray(values) ? values : []);
        reservation = active.work.reserve(bound);
      }
      reservation.dispatch();
    } catch (error) {
      if (beganReservation) cancelTerminal();
      active.work.failure = error instanceof Error ? error : new Error('Native work admission failed');
      throw error;
    }
    let settled = false;
    const settle = (result?: QueryResult, error?: unknown) => {
      if (settled) return;
      settled = true;
      if ((finishing || beginning) && error && 'release' in client)
        discardConnection(
          client as PoolClient,
          error instanceof Error ? error : new Error('Native transaction cleanup failed'),
        );
      reservation.settle({
        emptySeeks:
          !result || bound!.emptySeeks > 1 ? bound!.emptySeeks : result.rows.length === 0 ? bound!.emptySeeks : 0,
        candidateKeys: result ? Math.min(bound!.candidateKeys, result.rows.length) : bound!.candidateKeys,
        witnessKeys: result ? Math.min(bound!.witnessKeys, result.rows.length) : bound!.witnessKeys,
      });
      // A deferred COMMIT failure still needs its separately admitted ROLLBACK. Successful
      // commit, rollback, or a failed BEGIN cancels only controls that were never dispatched.
      if ((finishing && (control === 'rollback' || !error)) || (beginning && error)) cancelTerminal();
    };
    const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (error: unknown, result: QueryResult) => void;
      args[callbackIndex] = (error: unknown, result: QueryResult) => {
        observing.run(active, () => {
          settle(result, error);
          callback(error, result);
        });
      };
      try {
        return invokeQuery();
      } catch (error) {
        settle(undefined, error);
        throw error;
      }
    }
    try {
      return Promise.resolve(invokeQuery()).then(
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
}

/** A prepaid child retains its parent's literal statement policy even when it
 * instruments its own ledger. This checks admission without creating or charging funds. */
export function requireNativeCollectionFootprint<T>(
  pool: Pool,
  work: NativeCollectionWork,
  footprint: Footprint,
  operation: () => Promise<T>,
): Promise<T> {
  observePool(pool);
  const required = { pool, work, footprint, active: true };
  return requiredFootprints.run([...(requiredFootprints.getStore() ?? []), required], async () => {
    try {
      return await operation();
    } finally {
      required.active = false;
    }
  });
}

/** Observe the original pool/clients: no shadow pool, client proxy or identity/time registration changes. */
export async function instrumentNativeCollectionWork<T>(
  pool: Pool,
  work: NativeCollectionWork,
  footprint: Footprint,
  operation: () => Promise<T>,
  client?: NativeQueryClient,
): Promise<T> {
  // A live command deliberately exposes query only. Observing its forwarding
  // surface does not turn it into a PoolClient or give it checkout/release authority.
  // The caller may have acquired this live command before this pool was first observed.
  // Its forwarding wrapper suppresses only duplicate observation at the bound client.
  if (client) observeNativeCollectionClient(client, pool, true);
  observePool(pool);
  const parent = observing.getStore();
  assertObservation(parent);
  const ledger = receivedLedger(work);
  // A local observer cannot silently replace a parent's charge. Transfer first or
  // use the existing ledger; the transferred parent's literal policy remains active.
  if (
    parent &&
    ledgerAliases.get(parent.work) !== ledger &&
    !(composing.getStore() ?? []).includes(ledgerAliases.get(parent.work)!)
  )
    throw new TypeError('Nested native ledger has no parent transfer');
  const observation = { pool, work, footprint, active: true, parent };
  // A delegated CommandTransaction was acquired by Core, outside this body
  // observer. Its real private lifetime guards escape. Do not attach the shorter
  // body scope as checkout custody: Core still owes its fence/COMMIT/cleanup
  // after the body observer ends. Actual pool checkouts retain their own custody.
  const inherited = requiredFootprints.getStore() ?? [];
  const requirements = parent
    ? [...inherited, { pool, work: parent.work, footprint: parent.footprint, active: true }]
    : inherited;
  return requiredFootprints.run(requirements, () =>
    observing.run(observation, async () => {
      try {
        const result = await operation();
        work.assertReady();
        return result;
      } catch (error) {
        if (error instanceof Error)
          Object.defineProperty(error, 'work', { value: ledger.receipt(), configurable: true });
        throw error;
      } finally {
        observation.active = false;
      }
    }),
  );
}

function observePool(pool: Pool): void {
  if (!pools.has(pool)) {
    pools.add(pool);
    const connect = pool.connect.bind(pool);
    pool.connect = ((...args: unknown[]) => {
      for (const required of requiredFootprints.getStore() ?? [])
        if (required.pool === pool) {
          if (!required.active) throw new ProblemError('dependency_unavailable');
          required.work.assertReady();
        }
      const active = observing.getStore();
      assertObservation(active);
      if (manuallyObserved.getStore()) throw new TypeError('A reserved query cannot acquire another checkout');
      if (active) {
        try {
          active.work.assertReady();
          const checkout = active.work.reserve({ ...zero(), nativePoints: 1 });
          checkout.dispatch();
          checkout.settle();
        } catch (error) {
          active.work.failure = error instanceof Error ? error : new Error('Native checkout admission failed');
          throw error;
        }
      }
      return (connect as unknown as (...args: unknown[]) => unknown)(...args);
    }) as Pool['connect'];
    pool.on('acquire', (client) => {
      checkoutObservations.set(client, observing.getStore());
      observeNativeCollectionClient(client, pool);
    });
  }
}

/** One physical Source reservation shared by metadata, native drivers, scope and derived work. */
export class CollectionSourceLedger {
  private readonly used = zero();
  constructor(
    readonly initial: WorkAllowance,
    readonly deadline: number,
  ) {
    // Validate once with the same native accounting rules.
    new NativeCollectionWork(initial, deadline);
  }
  allowance(): WorkAllowance {
    const remaining = zero();
    for (const axis of axes) remaining[axis] = this.initial.remaining[axis] - this.used[axis];
    return { reservationId: this.initial.reservationId, remaining };
  }
  receipt(): WorkReceipt {
    return { reservationId: this.initial.reservationId, used: { ...this.used } };
  }
  take(receipt: WorkReceipt): void {
    if (receipt.reservationId !== this.initial.reservationId) throw new TypeError('Foreign Source reservation');
    for (const axis of axes)
      if (
        !Number.isSafeInteger(receipt.used[axis]) ||
        receipt.used[axis] < 0 ||
        receipt.used[axis] > this.initial.remaining[axis] - this.used[axis]
      )
        throw new TypeError('Source receipt exceeds shared allowance');
    for (const axis of axes) this.used[axis] += receipt.used[axis];
  }
  async run<T extends { work: WorkReceipt }>(call: (allowance: WorkAllowance) => Promise<T>): Promise<T> {
    try {
      const result = await call(this.allowance());
      this.take(result.work);
      return result;
    } catch (error) {
      if (error instanceof Error && 'work' in error) {
        const receipt = error.work;
        if (isReceipt(receipt)) this.take(receipt);
      }
      throw error;
    }
  }
  async bounded<T>(
    cost: Partial<WorkDimensions>,
    operation: () => Promise<T>,
    actual?: (result: T) => Partial<WorkDimensions>,
  ): Promise<T> {
    const work = new NativeCollectionWork(this.allowance(), this.deadline);
    const reservation = work.reserve({ ...zero(), ...cost });
    reservation.dispatch();
    let settled: Partial<WorkDimensions> = {};
    try {
      const result = await operation();
      settled = actual?.(result) ?? {};
      return result;
    } finally {
      reservation.settle(settled);
      this.take(work.receipt());
    }
  }
}
function isReceipt(value: unknown): value is WorkReceipt {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reservationId' in value &&
    'used' in value &&
    typeof value.reservationId === 'string' &&
    typeof value.used === 'object' &&
    value.used !== null &&
    axes.every((axis) => typeof Reflect.get(Object(value.used), axis) === 'number')
  );
}

import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomUUID } from 'node:crypto';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  withIdentitySourceConsumerMaintenance,
} from '../semantic/identity-source-consumer-maintenance.ts';
import {
  bindCanonicalSourceWork,
  advanceCanonicalSourceCapture,
  readCanonicalSourceState,
  beginCanonicalSourceRepair,
  repairCanonicalSourceStep,
  publishCanonicalSourceRepair,
  CANONICAL_SOURCE_WORKFLOW,
  type CanonicalAllowance,
  type CanonicalWork,
} from './canonical-source-store.ts';

const sourceStepAllowance = (): CanonicalAllowance => ({
  reservationId: randomUUID(),
  rawKeys: 100,
  nativeRows: 1000000,
  nativePoints: 10000,
  emptySeeks: 1000,
  statements: 10000,
  bytes: 16 * 1024 * 1024,
  // Native custody checks the owner partition and its committed capture receipt.
  identityMetadataRows: 32,
});
type SourceLocator = { accounts: [string]; collectionId: string };
type SourceSweep = {
  root: string;
  sequence: number;
  partition: number;
  route: number | null;
  collection: string | null;
};
export async function advanceCollectionSourceWork(
  context: WorkContext,
  input: SourceLocator,
): Promise<'ready' | 'more' | 'unavailable'> {
  const active = activeIdentitySourceConsumerMaintenance(context.pool);
  const deadline = Math.min(Date.now() + 30000, active?.deadline ?? Infinity);
  const run = () => advanceSourceStep(context, input, deadline);
  return active
    ? run()
    : withIdentitySourceConsumerMaintenance({ pool: context.pool, env: context.env }, { deadline }, run);
}
async function advanceSourceStep(
  context: WorkContext,
  input: SourceLocator,
  deadline: number,
): Promise<'ready' | 'more' | 'unavailable'> {
  const route = routeOf(input.collectionId);
  if (
    route === null ||
    input.accounts.length !== 1 ||
    routeOf(input.accounts[0]) === null ||
    partitionOf(routeOf(input.accounts[0])!) !== partitionOf(route) ||
    Buffer.byteLength(JSON.stringify(input)) > 4096
  )
    throw new TypeError('Invalid native Source work locator');
  const call = {
    route,
    collectionId: input.collectionId,
    deadline,
    allowance: sourceStepAllowance(),
  };
  function consume(w: CanonicalWork) {
    const a = call.allowance;
    call.allowance = {
      reservationId: a.reservationId,
      rawKeys: a.rawKeys - w.candidateKeys - w.aliasKeys - w.duplicateKeys - w.lookaheadKeys - w.internalDriverKeys,
      nativeRows: a.nativeRows - w.nativeRows,
      nativePoints: a.nativePoints - w.nativePoints,
      emptySeeks: a.emptySeeks - w.emptySeeks,
      statements: a.statements - w.statements,
      bytes: a.bytes - w.bytes,
      identityMetadataRows: a.identityMetadataRows - w.identityMetadataRows,
    };
  }
  const observed = await advanceCanonicalSourceCapture(context.pool, call);
  consume(observed.work);
  if (observed.state !== 'admitted') {
    return observed.reason === 'incomplete' ? 'more' : 'unavailable';
  }
  const ready = await readCanonicalSourceState(context.pool, call);
  consume(ready.work);
  if (ready.state === 'ready') return 'ready';
  const started = await beginCanonicalSourceRepair(context.pool, { ...call, basis: observed.basis });
  consume(started.work);
  if (started.state !== 'working') return 'unavailable';
  const next = await repairCanonicalSourceStep(context.pool, {
    ...call,
    basis: observed.basis,
    repair: started.repair,
  });
  consume(next.work);
  if (next.state !== 'complete') return next.state === 'working' ? 'more' : 'unavailable';
  const published = await publishCanonicalSourceRepair(context.pool, {
    ...call,
    basis: observed.basis,
    repair: next.repair,
  });
  return published.state === 'published' ? 'ready' : 'unavailable';
}
/** The existing Library worker owns native checkpoints. No Source GET writes, scheduler or new participant. */
export async function registerCollectionSourceWork(context: WorkContext): Promise<void> {
  bindCanonicalSourceWork(context);
  const page = (input: SourceLocator) => advanceCollectionSourceWork(context, input);
  const step = DBOS.registerStep(page, { name: 'library.canonicalSourcePage', ...COMMAND_STEP_RETRIES });
  DBOS.registerWorkflow((input: SourceLocator) => step(input), { name: CANONICAL_SOURCE_WORKFLOW });
  const sweepPage = DBOS.registerStep(
    async (input: SourceSweep): Promise<SourceSweep> => {
      const { rows } = await withConnection(context.pool, (client) =>
        client.query<{ route: number; collection: string; owner: string | null }>(
          `SELECT route,collection_id::text AS collection,curator_account_id::text AS owner FROM library.collection
       WHERE route BETWEEN $1 AND $2 AND ($3::integer IS NULL OR (route,collection_id)>($3,$4::uuid))
       ORDER BY route,collection_id LIMIT 1`,
          [input.partition * 16, input.partition * 16 + 15, input.route, input.collection],
        ),
      );
      const row = rows[0];
      if (!row) return { ...input, partition: input.partition + 1, route: null, collection: null };
      if (row.owner) await page({ accounts: [row.owner], collectionId: row.collection });
      return { ...input, route: row.route, collection: row.collection };
    },
    { name: 'library.canonicalSourceSweepPage', ...COMMAND_STEP_RETRIES },
  );
  const continuation = DBOS.registerStep(
    async (input: SourceSweep) => {
      await context.client.enqueue(
        {
          workflowName: 'library.canonicalSourceSweepSegment',
          queueName: 'maintenance',
          workflowID: `library.canonicalSourceSweep:${input.root}:${input.sequence}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
      );
    },
    { name: 'library.canonicalSourceSweepContinue', ...COMMAND_STEP_RETRIES },
  );
  async function segment(input: SourceSweep) {
    let next = input;
    for (let n = 0; n < 100 && next.partition < 4096; n++) next = await sweepPage(next);
    if (next.partition < 4096) await continuation({ ...next, sequence: next.sequence + 1 });
  }
  DBOS.registerWorkflow(segment, { name: 'library.canonicalSourceSweepSegment' });
  DBOS.registerWorkflow(
    () => segment({ root: DBOS.workflowID!, sequence: 0, partition: 0, route: null, collection: null }),
    { name: 'library.canonicalSourceSweep' },
  );
  await context.client.applySchedules([
    {
      scheduleName: 'library.canonicalSource.every-10-minutes',
      workflowName: 'library.canonicalSourceSweep',
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}

// Library-owned declaration region. Components never grant or refill work. A whole
// installed declaration covers only the enforced selected Library schedule.
export {
  IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION,
  declareLibraryIdentityStatement,
  assembleLibraryIdentityOriginalComponents,
  LIBRARY_IDENTITY_CHECKOUT_WORK,
  LIBRARY_IDENTITY_ORIGINAL_MISSING_OPERANDS,
  assembleLibraryIdentitySelectedBodies,
  LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES,
  LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS,
} from './identity-original-work.ts';
