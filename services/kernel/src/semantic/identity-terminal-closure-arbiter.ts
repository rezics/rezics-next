import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { discardConnection, withConnection } from '../database/pool.ts';
import { IdentityEpochStoreError } from './identity-epoch-store.ts';

type NativeArbiter = {
  pool: Pool;
  client: PoolClient;
  partition: number;
  deadline: number;
  epoch: number;
  position: bigint;
  live: boolean;
};
const callbacks = new AsyncLocalStorage<NativeArbiter>();
const transactions = new WeakMap<object, NativeArbiter>();
const unavailable = () => new IdentityEpochStoreError('identity_epoch_unavailable', 'No live native closure original arbiter');

/** Private association of the actual checked-out client, never a query copy or
 * synthetic CommandTransaction. This is only metadata admission/debit/retirement;
 * it cannot authorize a Core body, source capture, receipt or domain write.
 */
export function identityTerminalArbiter(tx: object) {
  const state = transactions.get(tx);
  if (!state || !state.live || callbacks.getStore() !== state || Date.now() >= state.deadline) throw unavailable();
  return Object.freeze({ pool: state.pool, partition: state.partition, deadline: state.deadline,
    epoch: state.epoch, position: state.position });
}

export function checkIdentityTerminalArbiter(tx: object): void { identityTerminalArbiter(tx); }

/** Fixed native metadata transaction, with no executor association or retries.
 * All body statements are direct calls on this actual client. Cleanup has its
 * own prepaid ROLLBACK and remains possible after effect permission expires.
 */
export async function withIdentityTerminalArbiter<T>(
  pool: Pool, partition: number, deadline: number, body: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095) throw new RangeError('Invalid arbiter home');
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(deadline) || remaining <= 0 || remaining > 2147483647) throw unavailable();
  return withConnection(pool, async (client) => {
    const state: NativeArbiter = { pool, client, partition, deadline, epoch: 0, position: 0n, live: true };
    transactions.set(client, state);
    return callbacks.run(state, async () => {
      try {
        checkIdentityTerminalArbiter(client);
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        checkIdentityTerminalArbiter(client);
        await client.query("SET LOCAL lock_timeout='100ms'");
        checkIdentityTerminalArbiter(client);
        await client.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, deadline - Date.now()))]);
        checkIdentityTerminalArbiter(client);
        const owner = (await client.query<{ epoch: number; position: string }>(
          `SELECT epoch,position::text FROM core.partition
           WHERE partition_no=$1 AND write_state='active' FOR UPDATE`, [partition],
        )).rows[0];
        checkIdentityTerminalArbiter(client);
        if (!owner) throw unavailable();
        state.epoch = owner.epoch;
        state.position = BigInt(owner.position);
        const value = await body(client);
        checkIdentityTerminalArbiter(client);
        await client.query('COMMIT');
        checkIdentityTerminalArbiter(client);
        return value;
      } catch (error) {
        // A lost COMMIT reply does not undo a committed debit. Reopening the
        // same original observes that spent ticket and refuses another effect.
        try { await client.query('ROLLBACK'); }
        catch (cleanup) {
          const failure = new AggregateError([error, cleanup], 'Closure arbiter rollback failed');
          discardConnection(client, failure);
          throw failure;
        }
        throw error;
      } finally {
        state.live = false;
        transactions.delete(client);
      }
    });
  });
}
