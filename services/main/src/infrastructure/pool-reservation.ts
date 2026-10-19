import type { Pool } from 'pg';
import { boundedPool } from './pg-pool.ts';

const reservation = Symbol('independent-transaction-pool');
type ReservablePool = Pool & { [reservation]?: Pool };

/** Reserve one connection before serving requests. A separately committed
 * publication fence must not join or wait for the caller's held transaction.
 * Both lanes retain the parent's total connection limit and shutdown owner.
 * The symbol also preserves ownership through transparent pool proxies. */
export function reservedTransactionPool(parent: Pool): Pool {
  const owner = parent as ReservablePool;
  if (owner[reservation]) return owner[reservation];
  const maximum = parent.options.max;
  if (!Number.isSafeInteger(maximum) || maximum < 2 || parent.ending
    || parent.totalCount > maximum - 1 || parent.waitingCount > 0) {
    throw new Error('Reserve the independent transaction connection before using the Access pool');
  }
  // pg deliberately makes password non-enumerable on options; copying the
  // remaining configuration alone would silently discard password providers.
  const independent = boundedPool({ ...parent.options, password: parent.options.password, max: 1, min: 0 });
  const end = parent.end.bind(parent);
  let closing: Promise<void> | undefined;
  parent.options.max = maximum - 1;
  parent.options.min = Math.min(parent.options.min ?? 0, maximum - 1);
  Object.defineProperty(parent, reservation, { value: independent });
  parent.end = ((callback?: (error?: Error) => void) => {
    closing ??= Promise.allSettled([end(), independent.end()]).then(results => {
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Access pool shutdown failed');
    });
    if (callback) { void closing.then(() => callback(), error => callback(error)); return; }
    return closing;
  }) as Pool['end'];
  return independent;
}
