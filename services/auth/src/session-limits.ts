import { readFileSync } from 'node:fs';
import type { BetterAuthPlugin } from 'better-auth';
import type { DBAdapter, DBTransactionAdapter } from 'better-auth/adapters';
import type { Pool, PoolClient } from 'pg';
import { nativeVerificationTransactionPlugin } from './verification-maintenance.ts';

export const SESSION_CAPACITY = 64;
export type SessionTrim = { deleted: number; ready: boolean };
const expiryStatement = readFileSync(new URL('./session-limits.sql', import.meta.url), 'utf8');
function admittedBatch(batch: number) {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 1000)
    throw new RangeError('Invalid session maintenance batch');
  return batch;
}

/** Internal maintenance ports only; the host owns scheduling and registration. */
export async function pruneExpiredSessions(database: Pool, batch = 1000): Promise<number> {
  return (await database.query(expiryStatement, [admittedBatch(batch)])).rowCount ?? 0;
}

/** One resumable legacy page; callers must never loop over history in a request. */
export async function trimSessionHistory(database: Pool, accountId: string, batch = 1000): Promise<SessionTrim> {
  const result = await database.query<SessionTrim>('SELECT * FROM auth_trim_session_history($1,$2)', [
    accountId,
    admittedBatch(batch),
  ]);
  return result.rows[0]!;
}

/** Indexed keyset discovery of legacy owners, including inactive/expired ones. */
export async function sessionUpgradePage(database: Pool, after: string, limit = 100): Promise<string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid session upgrade page');
  return (
    await database.query<{ id: string }>(
      'SELECT id FROM "user" WHERE NOT sessions_bounded AND id>$1 ORDER BY id LIMIT $2',
      [after, limit],
    )
  ).rows.map((row) => row.id);
}

/** Retain the installed native adapter, hooks and transaction context. Session
 * INSERTs are guarded by PostgreSQL, covering every establishment endpoint.
 * Native bulk revocation snapshots are capped before reading legacy history;
 * deletion takes the same owner lock as insertion in one native transaction.
 * This configuration has no secondary cache or provider refresh-history store.
 * A provider integration must use its family guard, never an unbounded session
 * FK cascade or a session-delete hook that walks its token history.
 */
export function nativeSessionLimits(database: Pool): BetterAuthPlugin {
  return {
    id: 'native-session-capacity',
    async init(ctx) {
      function adapter(base: DBAdapter, connection?: PoolClient): DBAdapter {
        const query = (sql: string, parameters: unknown[]) =>
          (connection ?? database).query<{ affected: number }>(sql, parameters);
        const wrapped: DBAdapter = {
          ...base,
          async findMany<T>(input: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> {
            if (input.model !== 'session') return base.findMany<T>(input);
            const owner = input.where?.find(
              (where) =>
                where.field === 'userId' &&
                (!where.operator || where.operator === 'eq') &&
                typeof where.value === 'string',
            );
            if (owner) await query('SELECT auth_assert_session_capacity($1)', [owner.value]);
            return base.findMany<T>({ ...input, limit: Math.min(input.limit ?? SESSION_CAPACITY, SESSION_CAPACITY) });
          },
          async deleteMany(input) {
            if (input.model !== 'session') return base.deleteMany(input);
            const owner = input.where.length === 1 ? input.where[0] : undefined;
            if (
              owner?.field === 'userId' &&
              (!owner.operator || owner.operator === 'eq') &&
              typeof owner.value === 'string'
            ) {
              const result = await query('SELECT auth_revoke_sessions($1) AS affected', [owner.value]);
              return result.rows[0]!.affected;
            }
            // Native revoke-other-sessions uses a bounded list of token keys.
            if (
              owner?.field === 'token' &&
              owner.operator === 'in' &&
              Array.isArray(owner.value) &&
              owner.value.length <= SESSION_CAPACITY
            )
              return base.deleteMany(input);
            throw new Error('Unsupported native bulk session deletion');
          },
          async transaction<T>(callback: (transaction: DBTransactionAdapter) => Promise<T>): Promise<T> {
            if (connection) return callback(wrapped);
            const pinned = await database.connect();
            try {
              await pinned.query('BEGIN');
              // Give the official native adapter this transaction's connection.
              // Its per-query release is a no-op; only this transaction releases it.
              const lease = new Proxy(pinned, {
                get(target, property) {
                  if (property === 'release') return () => {};
                  const value = Reflect.get(target, property);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
              const nativePool = new Proxy(database, {
                get(target, property) {
                  if (property === 'connect') return async () => lease;
                  const value = Reflect.get(target, property);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
              // Rebuild the installed verification adapter on the same lease so
              // native recovery consumes retain their deterministic indexed seek.
              const native = await nativeVerificationTransactionPlugin.init({
                ...ctx,
                options: { ...ctx.options, database: nativePool },
              });
              const result = await callback(adapter(native.context.adapter, pinned));
              await pinned.query('COMMIT');
              return result;
            } catch (error) {
              await pinned.query('ROLLBACK');
              throw error;
            } finally {
              pinned.release();
            }
          },
        };
        return wrapped;
      }
      return { context: { adapter: adapter(ctx.adapter) } };
    },
  };
}
