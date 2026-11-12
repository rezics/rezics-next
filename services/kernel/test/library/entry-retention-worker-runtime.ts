import { readFileSync } from 'node:fs';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { installNativeHistoryPreload } from '../../src/composition/preload.ts';
import { createPool } from '../../src/database/pool.ts';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { routeOf } from '../../src/route/route.ts';
import type { DueEntryDeletionKey } from '../../src/library/entry-due-store.ts';
import { accountToken } from '../support/admitted-access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import {
  composeProfileEntryLibrary,
  entryKey,
  profileEntryRouteKey,
  type NativeProfileFixture,
} from './support/profile-entry-fixture.ts';

export async function deletionKey(pool: Pool, accountId: string, deletionId: string): Promise<DueEntryDeletionKey> {
  const result = await pool.query(
    `SELECT route, account_id AS "accountId", deletion_id AS "deletionId", restore_until::text AS "restoreUntil"
     FROM library.entry_deleted WHERE route=$1 AND account_id=$2 AND deletion_id=$3`,
    [routeOf(accountId), accountId, deletionId],
  );
  if (!result.rows[0]) throw new Error('Native deletion locator missing');
  return result.rows[0];
}

export async function archive(f: NativeProfileFixture, subjectId: string, actor = f.owner.actor) {
  const entry = (await f.commands.putEntry(actor, subjectId, { state: 'planned' }, entryKey())).value.entry;
  const removed = await f.commands.deleteEntry(actor, subjectId, entry.revision, entryKey(), entry.incarnationId!);
  return deletionKey(f.pool, actor.accountId, removed.transactionId);
}

/** Observe completed native queries while preserving pg's promise and callback calling conventions. */
export async function observeRetentionQueries(
  pool: Pool,
  observe: (query: {
    connection: PoolClient;
    sql: string;
    values: readonly unknown[];
    result: QueryResult;
  }) => void | Promise<void>,
) {
  const observed = new WeakSet<PoolClient>();
  const instrument = (connection: PoolClient) => {
    if (observed.has(connection)) return;
    observed.add(connection);
    connection.query = new Proxy(connection.query, {
      apply(query, receiver, args: unknown[]) {
        const config = args[0] as string | { text?: string; values?: unknown[] };
        const sql = typeof config === 'string' ? config : (config.text ?? '');
        const values = (Array.isArray(args[1]) ? args[1] : typeof config === 'object' ? config.values : []) ?? [];
        const complete = async (result: QueryResult) => {
          await observe({ connection, sql, values, result });
          return result;
        };
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          return Reflect.apply(query, receiver, [
            ...args.slice(0, -1),
            (error: Error | null, result: QueryResult) => {
              if (error) callback(error, result);
              else
                void complete(result).then(
                  (value) => callback(null, value),
                  (failure) => callback(failure),
                );
            },
          ]);
        }
        const result = Reflect.apply(query, receiver, args);
        return result instanceof Promise ? result.then(complete) : result;
      },
    });
  };
  pool.on('connect', instrument);
  // Growth setup has already probed its pool. Cover those idle clients as well as new connections.
  const existing = await Promise.all(Array.from({ length: pool.totalCount }, () => pool.connect()));
  for (const connection of existing) {
    instrument(connection);
    connection.release();
  }
}

if (import.meta.main) {
  const [mode, executorId, timePath] = process.argv.slice(2);
  if (!executorId || !timePath) throw new Error('Runtime requires executor identity and native clock file');
  const databaseUrl = process.env.DATABASE_URL!;
  installNativeHistoryPreload();
  const pool = createPool(databaseUrl);
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  let settled = false;
  let stop!: () => void;
  const stopping = new Promise<void>((resolve) => (stop = resolve));
  const onSigterm = () => stop();
  async function settle() {
    if (settled) return;
    settled = true;
    process.off('SIGTERM', onSigterm);
    const failures: unknown[] = [];
    for (const release of [async () => work?.shutdown(), async () => client?.close(), async () => pool.end()]) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Retention worker resource settlement failed');
  }

  let runtimeError: unknown;
  let runtimeFailed = false;
  try {
    client = await createWorkClient(databaseUrl, pool);
    const clock = () => new Date(Number(readFileSync(timePath, 'utf8')));
    // Test-only transport interception observes the actual native source/COMMIT, never replaces a command or SDK.
    // Holding after COMMIT leaves the DBOS page output uncheckpointed when this child is killed.
    if (mode !== 'recover') {
      let barrierUsed = false;
      const deleted = new WeakSet<PoolClient>();
      await observeRetentionQueries(pool, async ({ connection, sql, result }) => {
        if (/DELETE FROM library.entry_deleted/i.test(sql) && result.rows.length) deleted.add(connection);
        const park = mode === 'park' && /SELECT restore_until::text AS "restoreUntil"/i.test(sql) && result.rows.length;
        const committed = mode === 'crash' && deleted.has(connection) && /^COMMIT$/i.test(sql.trim());
        if (/^(COMMIT|ROLLBACK)$/i.test(sql.trim())) deleted.delete(connection);
        if (!barrierUsed && (park || committed)) {
          barrierUsed = true;
          console.log(park ? 'source-parked' : 'native-committed');
          await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
        }
      });
    }
    const { workerEnv } = await composeProfileEntryLibrary({
      pool,
      clock,
      routeKey: profileEntryRouteKey(process.env),
    });
    work = await composeWork([libraryWorkModule], {
      pool,
      client,
      databaseUrl,
      executorId,
      clock,
      env: workerEnv,
    });
    process.once('SIGTERM', onSigterm);
    await work.launch();
    console.log('worker-ready');
    await stopping;
  } catch (error) {
    runtimeFailed = true;
    runtimeError = error;
  }

  let settlementError: unknown;
  try {
    await settle();
  } catch (error) {
    settlementError = error;
  }
  if (runtimeFailed && settlementError !== undefined)
    throw new AggregateError([runtimeError, settlementError], 'Retention worker failed and could not settle cleanly');
  if (runtimeFailed) throw runtimeError;
  if (settlementError !== undefined) throw settlementError;
}

/** Legal unrelated owners/live replacements/future archives grow both partition-local and remote indexes. */
export async function growRetentionPopulation(
  f: NativeProfileFixture,
  partition: number,
  subjectId: string,
  previous: number,
  scale: number,
  report?: (progress: RetentionGrowthProgress) => void,
) {
  const target = scale - previous;
  const started = performance.now();
  let completed = 0;
  const connectionCounts = () => ({
    max: f.pool.options.max,
    total: f.pool.totalCount,
    idle: f.pool.idleCount,
    waiting: f.pool.waitingCount,
  });
  const progress = (phase: RetentionGrowthPhase, from: number, count: number) =>
    report?.({
      phase,
      from,
      count,
      completed,
      target,
      elapsedMs: Math.round(performance.now() - started),
      connections: connectionCounts(),
    });

  for (let n = previous; n < scale; n += 2) {
    const indexes = n + 1 < scale ? [n, n + 1] : [n];
    progress('identity', n, indexes.length);
    const owners = await Promise.all(
      indexes.map((index) =>
        f.identity(
          ['subject:read', 'library_entry:update', 'library_entry:delete'],
          index % 2 === 0 ? partition : (partition + 1) % 4096,
        ),
      ),
    );

    // Pairing adjacent partition owners keeps each authenticated actor fresh
    // while allowing independent setup to use the fixture's bounded pool.
    progress('archive', n, owners.length);
    await Promise.all(owners.map((owner) => archive(f, subjectId, owner.actor)));

    progress('replacement', n, owners.length);
    await Promise.all(
      owners.map((owner) => f.commands.putEntry(owner.actor, subjectId, { state: 'planned' }, entryKey())),
    );
    completed += owners.length;
  }
  progress('complete', scale, 0);
}

export type RetentionGrowthPhase = 'identity' | 'archive' | 'replacement' | 'complete';
export type RetentionGrowthProgress = {
  readonly phase: RetentionGrowthPhase;
  readonly from: number;
  readonly count: number;
  readonly completed: number;
  readonly target: number;
  readonly elapsedMs: number;
  readonly connections: {
    readonly max: number;
    readonly total: number;
    readonly idle: number;
    readonly waiting: number;
  };
};

export async function renewRetentionIdentities(f: NativeProfileFixture) {
  for (const identity of [f.owner, f.other, f.steward]) {
    identity.bearer = await accountToken(identity.actor);
    identity.actor = await f.access.authenticate(identity.bearer, { pool: f.pool, deadline: deadlineFor(30000) });
  }
}
