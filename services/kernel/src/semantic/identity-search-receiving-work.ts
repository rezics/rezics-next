import type { Pool, PoolClient } from 'pg';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import type { WorkDimensions, WorkReceipt } from '../library/collection-source.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from '../library/collection-source-work.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import type { NativeStepWork } from './identity-epoch-contract.ts';
import { prepareSearchReceivingCaptures, searchReceivingCaptureStatements } from './identity-search-receiving-capture.ts';
import {
  identitySourceConsumerLibraryWork, identitySourceConsumerNativeWork,
  reserveIdentitySourceConsumerNativeWork,
  type IdentitySourceConsumerMaintenanceWork,
} from './identity-source-consumer-maintenance.ts';

export const searchReceivingOperations = ['resolvePlanned', 'readAndHold', 'revalidateHold', 'recordApplied',
  'reconcileOriginal', 'releaseHold'] as const;
export type SearchReceivingOperation = typeof searchReceivingOperations[number];
export type SearchReceivingWorkContext = Readonly<{
  deadline: number;
  identityConsumerWork: IdentitySourceConsumerMaintenanceWork;
  ceiling: WorkDimensions;
  allowance: NativeStepWork;
}>;
/** Static trusted application configuration, never a request's proof callback. Each SQL bound includes
 * its triggers, constraints and deferred work; outsideSql excludes those already instrumented statements.
 * An absent declaration is deliberately different from a declaration of zero work.
 */
export type SearchReceivingWorkDeclaration = Readonly<{
  statements: readonly Readonly<{ sql: string; work: WorkDimensions }>[];
  native: Readonly<Partial<Record<SearchReceivingOperation, Readonly<{
    allowance: NativeStepWork;
    outsideSql: WorkDimensions;
  }>>>>;
}>;
const axes = ['candidateKeys', 'identityMetadataRows', 'nativeRows', 'nativePoints', 'witnessKeys',
  'statements', 'bytes', 'emptySeeks'] as const;
const nativeAxes = ['rows', 'points', 'statements', 'bytes', 'engineRequests'] as const;
const nativeSqlReservations = new AsyncLocalStorage<{
  allowance: NativeStepWork; used: { -readonly [K in keyof NativeStepWork]: NativeStepWork[K] };
}>();
const nativeCheckouts = new AsyncLocalStorage<(cost: NativeStepWork) => void>();
const capturePlanning = new AsyncLocalStorage<true>();
const observedPools = new WeakSet<Pool>();
type QueryLifetime = { closed: boolean; pending: Set<Promise<unknown>>; work: NativeCollectionWork;
  capture?: (cost: WorkDimensions) => void };
const queryLifetimes = new AsyncLocalStorage<QueryLifetime>();
const queryPools = new WeakSet<Pool>();
const queryClients = new WeakSet<PoolClient>();
const emptyNative = (): NativeStepWork => ({ rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 });

function retainQuery(lifetime: QueryLifetime, query: Promise<unknown>) {
  lifetime.pending.add(query);
  void query.then(() => lifetime.pending.delete(query), (error: unknown) => {
    lifetime.pending.delete(query);
    lifetime.work.failure = error instanceof Error ? error : refused('Search receiving SQL failed');
  });
}

/** Install after the eight-axis observer so its settlement finishes before our tracked promise.
 * Observe the real acquired client; do not replace a transaction or route work through a proxy.
 */
function observeQueryLifetimes(pool: Pool) {
  if (queryPools.has(pool)) return;
  queryPools.add(pool);
  pool.on('acquire', (client: PoolClient) => {
    if (queryClients.has(client)) return;
    queryClients.add(client);
    const query = client.query;
    let writing: QueryLifetime | undefined;
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const lifetime = queryLifetimes.getStore();
      if (!lifetime) return Reflect.apply(query, this, args);
      if (lifetime.closed) throw refused('Search receiving SQL outlived its original child reservation');
      const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
      const config = args[0] as string | { text?: string };
      const sql = typeof config === 'string' ? config : config?.text;
      const beginning = sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE';
      const committing = sql === 'COMMIT' && writing === lifetime;
      if (lifetime.capture && (beginning || committing)) {
        // The actual command executor uses promises. A callback terminal cannot escape funding
        // by dispatching COMMIT before the original asynchronous planner has settled.
        if (callbackIndex >= 0) throw refused('Search receiving write transaction controls require promises');
        const actualClient = this;
        const completed = (async () => {
          if (committing) await capturePlanning.run(true, () => prepareSearchReceivingCaptures(actualClient, lifetime.capture!));
          const result = await Reflect.apply(query, actualClient, args);
          if (beginning) {
            writing = lifetime;
            try { await actualClient.query(searchReceivingCaptureStatements.enable); }
            catch (error) {
              // runCommand establishes its body try/finally after BEGIN. Own this failed setup's
              // already-open transaction and use its original prepaid rollback before returning.
              await actualClient.query('ROLLBACK');
              throw error;
            }
          } else writing = undefined;
          return result;
        })();
        retainQuery(lifetime, completed);
        return completed;
      }
      if (sql === 'ROLLBACK') writing = undefined;
      if (callbackIndex >= 0) {
        const callback = args[callbackIndex] as (...values: unknown[]) => unknown;
        let finish!: () => void;
        let fail!: (error: unknown) => void;
        const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
        retainQuery(lifetime, completed);
        args[callbackIndex] = AsyncResource.bind((...values: unknown[]) => {
          // A driver may invoke its callback from a resource created before this frame. Restore
          // only this query's existing lifetime; the enclosing accounting observer restores its
          // actual reservation. Await an async callback, including SQL it dispatches.
          return queryLifetimes.run(lifetime, () => {
            try {
              const result = callback(...values);
              void Promise.resolve(result).then(() => values[0] ? fail(values[0]) : finish(), fail);
              return result;
            } catch (error) { fail(error); throw error; }
          });
        });
        try { return Reflect.apply(query, this, args); }
        catch (error) { fail(error); throw error; }
      }
      const result = Reflect.apply(query, this, args);
      // PoolClient's promise overload is used by production. Callback queries preserve the
      // driver's original return value above; a submitted event-emitting Query is not a promise
      // and therefore is refused rather than silently escaping settlement.
      if (!result || typeof (result as Promise<unknown>).then !== 'function')
        throw refused('Search receiving requires a settling promise or callback query');
      retainQuery(lifetime, result as Promise<unknown>);
      return result;
    } as PoolClient['query'];
  });
}

/** Observe the configured Pool itself. This adds no client, home or alternate checkout and is
 * inactive outside Search composition. Native and eight-axis ledgers both fund each acquisition.
 */
function observeNativeCheckouts(pool: Pool) {
  if (observedPools.has(pool)) return;
  observedPools.add(pool);
  const connect = pool.connect;
  pool.connect = function (this: Pool, ...args: unknown[]) {
    nativeCheckouts.getStore()?.({ ...emptyNative(), points: 1 });
    return Reflect.apply(connect, this, args);
  } as Pool['connect'];
}
export const receivingSqlKey = (sql: string) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
function valid(value: object, keys: readonly string[]) {
  return keys.every((key) => Number.isSafeInteger((value as Record<string, number>)[key]) &&
    (value as Record<string, number>)[key]! >= 0);
}
function refused(detail: string): Error {
  return Object.assign(new Error(detail), { code: 'identity_epoch_unavailable' });
}
/** Snapshot the literal inventory once at application construction. Mutation cannot grant later work. */
export function receivingWorkDeclaration(declaration: SearchReceivingWorkDeclaration,
  pageStatements: readonly Readonly<{ sql: string; kind: 'copies' | 'insertCopies' }>[] = []) {
  const statements = new Map<string, WorkDimensions>();
  for (const { sql, work } of declaration.statements) {
    const key = receivingSqlKey(sql);
    if (!key || statements.has(key) || !valid(work, axes)) throw new TypeError('Invalid receiving SQL declaration');
    statements.set(key, Object.freeze({ ...work }));
  }
  // Only the installed owner's exact named page statements get a raw-size bound. Snapshot that
  // inventory too; neither an SQL substring nor a returned row count can lower an admitted cost.
  const pages = new Map<string, 'copies' | 'insertCopies'>();
  for (const { sql, kind } of pageStatements) {
    const key = receivingSqlKey(sql);
    const maximum = statements.get(key);
    if (pages.has(key) || !maximum || !['copies', 'insertCopies'].includes(kind) ||
        maximum.nativeRows < (kind === 'copies' ? 300 : 100) ||
        maximum.nativePoints < (kind === 'copies' ? 201 : 100) || maximum.bytes < 256256)
      throw new TypeError('Invalid receiving raw-page declaration');
    pages.set(key, kind);
  }
  const native = Object.fromEntries(searchReceivingOperations.map((operation) => {
    const bound = declaration.native[operation];
    if (!bound) return [operation, undefined];
    if (!valid(bound.allowance, nativeAxes) || !valid(bound.outsideSql, axes))
      throw new TypeError('Invalid receiving native declaration');
    return [operation, Object.freeze({ allowance: Object.freeze({ ...bound.allowance }),
      outsideSql: Object.freeze({ ...bound.outsideSql }) })];
  })) as Partial<Record<SearchReceivingOperation, { allowance: NativeStepWork; outsideSql: WorkDimensions }>>;
  return Object.freeze({ footprint: (sql: string, values?: readonly unknown[]): WorkDimensions | undefined => {
    // The executor's sole dynamic literal is a positive integral remaining timeout. This template
    // is separately declared; arbitrary SET statements do not inherit its cost.
    const key = /^SET LOCAL statement_timeout = '[1-9][0-9]*ms'$/.test(sql)
      ? "SET LOCAL statement_timeout = '<remaining>ms'" : receivingSqlKey(sql);
    const maximum = statements.get(key);
    const page = pages.get(key);
    if (!maximum || !page || !values) return maximum;
    let count: unknown;
    if (page === 'copies') count = values[3];
    else {
      const encoded = values[2];
      if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 256256) return undefined;
      try {
        const items: unknown = JSON.parse(encoded);
        if (!Array.isArray(items)) return undefined;
        count = items.length;
      } catch { return undefined; }
    }
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 100) return undefined;
    const unused = 100 - count;
    // Preserve every configured transitive surcharge. Only the known, undispatched raw keys are
    // removed from the literal maximum; failed and empty dispatched pages keep this entire bound.
    return Object.freeze({ ...maximum, nativeRows: maximum.nativeRows - unused * (page === 'copies' ? 3 : 1),
      nativePoints: maximum.nativePoints - unused * (page === 'copies' ? 2 : 1),
      bytes: maximum.bytes - unused * 2560 });
  }, native: Object.freeze(native) });
}
export type SearchReceivingWork = Readonly<{
  deadline: number;
  work: NativeCollectionWork;
  invoke<T extends { work: NativeStepWork }>(operation: SearchReceivingOperation,
    body: (context: Readonly<{ deadline: number; allowance: NativeStepWork }>) => Promise<T>): Promise<T>;
}>;

/** Compose with the original caller's two ledgers. No new maintenance frame or aggregate allowance.
 * Catch inside compose so even a thrown child returns its actual eight-axis charges to the parent.
 */
export async function withSearchReceivingWork<T>(pool: Pool, context: SearchReceivingWorkContext,
  declaration: ReturnType<typeof receivingWorkDeclaration>, requiredSql: readonly string[],
  body: (work: SearchReceivingWork) => Promise<T>): Promise<Readonly<{ value: T; work: WorkReceipt }>> {
  context = Object.freeze({ ...context, allowance: Object.freeze({ ...context.allowance }),
    ceiling: Object.freeze({ ...context.ceiling }) });
  const parent = identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline);
  const balance = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, context.deadline);
  if (!parent || !balance) throw refused('Search receiving requires the original live caller work frame');
  const outcome = await parent.compose(async (allowance) => {
    const child = new NativeCollectionWork(allowance, context.deadline);
    const remaining = { ...context.allowance };
    let active = true;
    const pending = new Set<Promise<unknown>>();
    const lifetime: QueryLifetime = { closed: false, pending: new Set(), work: child };
    try {
      if (!valid(remaining, nativeAxes) || nativeAxes.some((axis) => remaining[axis] > balance[axis]))
        throw refused('Search receiving native child exceeds original caller residual');
      if (requiredSql.some((sql) => declaration.footprint(sql) === undefined) ||
          searchReceivingOperations.some((operation) => !declaration.native[operation]))
        throw refused('Search receiving exact native/common SQL cost composition is not installed');
      const chargeNative = (cost: NativeStepWork) => {
        if (lifetime.closed) throw refused('Search receiving work outlived its original child reservation');
        const operation = nativeSqlReservations.getStore();
        if (operation) {
          // The operation's complete native allowance was already taken from the original
          // frame. Include transitive and nested SQL in that SAME reservation, before dispatch.
          const axis = nativeAxes.find((axis) => operation.used[axis] + cost[axis] > operation.allowance[axis]);
          if (axis) throw refused(capturePlanning.getStore()
            ? `Search receiving capture unavailable funding: original native ${axis} requires ${cost[axis]}, remaining ${operation.allowance[axis] - operation.used[axis]}`
            : 'Search receiving SQL exceeds its original native operation reservation');
          for (const axis of nativeAxes) operation.used[axis] += cost[axis];
        } else {
          // Common selection/control/executor SQL and callbacks outside an active native call
          // are additional work. Deferred work is conservatively charged again when necessary;
          // an expired call's reservation never supplies a new callback with free authority.
          const axis = nativeAxes.find((axis) => cost[axis] > remaining[axis]);
          if (axis || !reserveIdentitySourceConsumerNativeWork(pool, context.identityConsumerWork, cost))
            throw refused(capturePlanning.getStore()
              ? `Search receiving capture unavailable funding: original native ${axis ?? 'frame'} requires ${axis ? cost[axis] : 'live residual'}, remaining ${axis ? remaining[axis] : 'unavailable'}`
              : 'Search receiving common SQL exceeds the original native frame');
          for (const axis of nativeAxes) remaining[axis] -= cost[axis];
        }
      };
      if (requiredSql.includes(searchReceivingCaptureStatements.enable)) lifetime.capture = (cost) => {
        // The deferred body is reserved in the SAME child as its command and native operation.
        // Even if COMMIT later refuses or throws, dispatched/uncertain charges stay consumed.
        const axis = axes.find((axis) => cost[axis] > child.available(axis));
        if (axis) throw refused(`Search receiving capture unavailable funding: original ${axis} requires ${cost[axis]}, remaining ${child.available(axis)}`);
        const held = child.reserve(cost);
        try {
          chargeNative({ rows: cost.nativeRows, points: cost.nativePoints, statements: cost.statements,
            bytes: cost.bytes, engineRequests: 0 });
        } catch (error) { held.cancel(); throw error; }
        held.dispatch();
        held.settle();
      };
      observeNativeCheckouts(pool);
      const funded: SearchReceivingWork = {
        deadline: context.deadline, work: child,
        invoke(operation, call) {
          const task = (async () => {
            if (!active) throw refused('Search receiving child reservation has ended');
            child.assertReady();
            const bound = declaration.native[operation];
            if (!bound || nativeAxes.some((axis) => bound.allowance[axis] > remaining[axis]))
              throw refused(`Search receiving ${operation} has no residual native reservation`);
            const extra = child.reserve(bound.outsideSql);
            if (!reserveIdentitySourceConsumerNativeWork(pool, context.identityConsumerWork, bound.allowance)) {
              extra.cancel();
              throw refused(`Search receiving ${operation} exceeds original native frame`);
            }
            for (const axis of nativeAxes) remaining[axis] -= bound.allowance[axis];
            extra.dispatch();
            try {
              const result = await nativeSqlReservations.run({ allowance: bound.allowance,
                used: { ...emptyNative() } }, () => call({ deadline: context.deadline, allowance: { ...bound.allowance } }));
              if (!valid(result.work, nativeAxes) || nativeAxes.some((axis) => result.work[axis] > bound.allowance[axis]))
                throw refused(`Search receiving ${operation} exceeded declared native work`);
              return result;
            } catch (error) {
              child.failure = error instanceof Error ? error : refused('Search receiving native failure');
              throw error;
            } finally {
              // Dispatched refusal, failure and rollback retain the admitted non-SQL cost.
              extra.settle();
            }
          })();
          pending.add(task);
          void task.then(() => pending.delete(task), () => pending.delete(task));
          return task;
        },
      };
      const value = await nativeCheckouts.run(chargeNative, () => withRequestDeadline(context.deadline,
        () => instrumentNativeCollectionWork(pool, child, (sql, values) => {
          const footprint = declaration.footprint(sql, values);
          if (footprint && capturePlanning.getStore()) {
            const axis = axes.find((axis) => footprint[axis] > child.available(axis));
            if (axis) throw refused(`Search receiving capture unavailable funding: original ${axis} requires ${footprint[axis]}, remaining ${child.available(axis)}`);
          }
          if (footprint) chargeNative({ rows: footprint.nativeRows, points: footprint.nativePoints,
            statements: footprint.statements, bytes: footprint.bytes, engineRequests: 0 });
          return footprint;
        }, async () => queryLifetimes.run(lifetime, async () => {
          observeQueryLifetimes(pool);
          try { return await body(funded); }
          finally {
            active = false;
            // Drain actual existing handles. A settled callback can dispatch another funded
            // query; repeat until those handles settle too, then fence its inherited context.
            while (pending.size || lifetime.pending.size)
              await Promise.allSettled([...pending, ...lifetime.pending]);
            lifetime.closed = true;
            child.assertReady();
          }
        }))));
      return { ok: true as const, value, work: child.receipt() };
    } catch (error) {
      return { ok: false as const, error, work: child.receipt() };
    } finally {
      active = false;
      lifetime.closed = true;
    }
  }, context.ceiling);
  if (!outcome.ok) {
    // Preserve an actual returned receipt without treating caught unknown/failing SQL as permission
    // to spend the remaining parent reservation in a later sibling call.
    const error = outcome.error instanceof Error ? outcome.error : refused('Search receiving failed');
    parent.failure = error;
    Object.defineProperty(error, 'work', { value: outcome.work, configurable: true });
    throw error;
  }
  return { value: outcome.value, work: outcome.work };
}
