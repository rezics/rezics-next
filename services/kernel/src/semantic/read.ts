import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { nativeSourceQuery } from '../database/native-source-query.ts';
import readStatementTimeout from './read-statement-timeout.sql';
import restoreStatementTimeout from './restore-statement-timeout.sql';
import { deadlineClient } from '../access/deadline.ts';
import {
  AccessUnavailableError,
  classifyUnavailability,
  CommandUnavailableError,
  requireAccessDeadline,
  throwAccessUnavailable,
} from '../access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { withBoundedReadConnection, withBoundedReadOnlyTransaction } from '../database/pool.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';

export { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable };
export { withRequestDeadline };

const snapshots = new AsyncLocalStorage<ReadonlyMap<Pool, { client: PoolClient; deadline: number; live: boolean }>>();

function isSettledServerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = error as { code?: unknown; severity?: unknown };
  return typeof details.code === 'string' && /^[0-9A-Z]{5}$/.test(details.code) && details.severity === 'ERROR';
}

const readLifetimeOptions = {
  deadlineError: () => new AccessUnavailableError('deadline'),
  mapError(error: unknown) {
    try {
      // The bounded lifetime selects the deadline race; classify its settled failure without checking time again.
      throwAccessUnavailable(error);
    } catch (mapped) {
      return mapped;
    }
    return error;
  },
  isUncertainError: (error: unknown) => classifyUnavailability(error) !== undefined,
  isUncertainSettledQueryError: (error: unknown) => !isSettledServerError(error),
};

/** Only this executor's live checked-out RR clients qualify; a pool.query facade never does. */
export function currentReadSnapshot(pool: Pool): PoolClient | undefined {
  const snapshot = snapshots.getStore()?.get(pool);
  return snapshot?.live ? snapshot.client : undefined;
}

/** A single native SELECT has its own snapshot. Reuse a caller's repeatable-read snapshot when present. */
export function withReadStatement<T>(
  pool: Pool,
  read: (client: PoolClient) => Promise<T>,
  deadline = deadlineFor(DEFAULT_REQUEST_DEADLINE_MS),
): Promise<T> {
  if (currentReadSnapshot(pool)) return withReadTransaction(pool, read, deadline);
  requireAccessDeadline(deadline);
  return withBoundedReadConnection(
    pool,
    deadline,
    async (client) => {
      const guarded = Object.create(client) as PoolClient;
      let previous: string | undefined;
      let queued = 0;
      let tail = Promise.resolve();
      guarded.query = ((input: unknown, values?: unknown, callback?: unknown) => {
        const done = typeof values === 'function' ? values : callback;
        queued++;
        const query = tail
          .then(async () => {
            requireAccessDeadline(deadline);
            try {
              const setting = await nativeSourceQuery(client, readStatementTimeout, {
                timeout_ms: Math.max(1, Math.floor(deadline - Date.now())),
              });
              if (!setting?.timeout) throw new Error('Missing original statement timeout');
              previous ??= setting.timeout;
            } catch (error) {
              client.release(true);
              throw error;
            }
            // Callback work and earlier queued queries may have already spent part of the deadline.
            return Reflect.apply(client.query, client, Array.isArray(values) ? [input, values] : [input]);
          })
          .finally(() => {
            queued--;
          });
        tail = query.then(
          () => {},
          () => {},
        );
        if (typeof done !== 'function') return query;
        void query.then(
          (result) => done(null, result),
          (error) => done(error),
        );
      }) as PoolClient['query'];

      let succeeded = false;
      try {
        const result = await read(guarded);
        if (queued) throw new Error('A bounded statement read returned with a query still running');
        succeeded = true;
        return result;
      } finally {
        if (queued) client.release(true);
        else if (previous !== undefined) {
          try {
            await nativeSourceQuery(client, restoreStatementTimeout, { timeout: previous });
          } catch (error) {
            client.release(true);
            if (succeeded) throw error;
          }
        }
      }
    },
    { ...readLifetimeOptions, discardOnExpiry: true },
  );
}

/** One physical-pool snapshot across independently bound logical partition reads. */
export function withReadTransaction<T>(
  pool: Pool,
  read: (client: PoolClient) => Promise<T>,
  requestDeadline = deadlineFor(DEFAULT_REQUEST_DEADLINE_MS),
): Promise<T> {
  const inherited = snapshots.getStore()?.get(pool);
  const owned = inherited?.live ? inherited : undefined;
  const deadline = Math.min(requestDeadline, owned?.deadline ?? Infinity);
  requireAccessDeadline(deadline);
  if (owned) {
    return (async () => {
      const client = deadline < owned.deadline ? (deadlineClient(owned.client, deadline) as PoolClient) : owned.client;
      const result = await read(client);
      requireAccessDeadline(deadline);
      return result;
    })();
  }
  let snapshot: { client: PoolClient; deadline: number; live: boolean } | undefined;
  const visit = withBoundedReadOnlyTransaction(
    pool,
    deadline,
    async (client) => {
      requireAccessDeadline(deadline);
      const remaining = Math.max(1, Math.floor(deadline - Date.now()));
      await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);
      requireAccessDeadline(deadline);
      const ownedSnapshot = { client, deadline, live: true };
      snapshot = ownedSnapshot;
      const next = new Map(snapshots.getStore());
      next.set(pool, ownedSnapshot);
      try {
        return await snapshots.run(next, () => read(client));
      } finally {
        ownedSnapshot.live = false;
      }
    },
    readLifetimeOptions,
  );
  return visit.finally(() => {
    if (snapshot) snapshot.live = false;
  });
}
