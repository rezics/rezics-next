import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { createPool } from '../../../src/database/pool.ts';
import {
  libraryWorkModule,
  ENTRY_INCARNATION_CUTOVER_SCHEDULE,
  LABEL_RETENTION_SCHEDULE,
} from '../../../src/library/work-module.ts';
import { ENTRY_RETENTION_SCHEDULE } from '../../../src/library/entry-due-work.ts';
import { routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { observeRetentionQueries } from '../entry-retention-worker-runtime.ts';

/** The sole historical-storage mutation: remove only the guard from a genuine native-created fact. */
export async function legacy(pool: Pool, accountId: string, subjectId: string) {
  await pool.query('UPDATE library.entry SET incarnation_id=NULL WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
    routeOf(accountId),
    accountId,
    subjectId,
  ]);
}
export async function fact(pool: Pool, accountId: string, subjectId: string) {
  return (
    await pool.query(
      'SELECT to_jsonb(e) AS value FROM library.entry e WHERE route=$1 AND account_id=$2 AND subject_id=$3',
      [routeOf(accountId), accountId, subjectId],
    )
  ).rows[0]?.value;
}

if (import.meta.main) {
  const [mode, executorId, timePath] = process.argv.slice(2);
  if (!executorId || !timePath) throw new Error('Cutover runtime requires executor identity and clock file');
  const pool = createPool(process.env.DATABASE_URL!);
  const client = await createWorkClient(process.env.DATABASE_URL!);
  let parked = false;
  let sourceBarrier: Promise<void> | undefined;
  pool.connect = new Proxy(pool.connect, {
    apply(connect, receiver, args) {
      return sourceBarrier
        ? sourceBarrier.then(() => Reflect.apply(connect, receiver, args))
        : Reflect.apply(connect, receiver, args);
    },
  });
  const changed = new WeakSet<object>();
  await observeRetentionQueries(pool, async ({ connection, sql, result }) => {
    if (/UPDATE library.entry\s+SET incarnation_id/i.test(sql) && result.rows.length) changed.add(connection);
    const source =
      (mode === 'park' || mode === 'source-crash') &&
      /xmin::text AS version/i.test(sql) &&
      result.rows.some((row) => row.incarnationId === null);
    const commit = mode === 'crash' && changed.has(connection) && /^COMMIT$/i.test(sql.trim());
    if (/^(COMMIT|ROLLBACK)$/i.test(sql.trim())) changed.delete(connection);
    if (!parked && source) {
      parked = true;
      const release = connection.release;
      connection.release = (...args) => {
        release.apply(connection, args);
        sourceBarrier = new Promise<void>((resolve) =>
          process.stdin.once('data', () => {
            sourceBarrier = undefined;
            resolve();
          }),
        );
        console.log('source-parked');
      };
    }
    if (!parked && commit) {
      parked = true;
      console.log('native-committed');
      await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
    }
  });
  const work = await composeWork([libraryWorkModule], {
    pool,
    client,
    databaseUrl: process.env.DATABASE_URL!,
    executorId,
    clock: () => new Date(Number(readFileSync(timePath, 'utf8'))),
    env: {},
  });
  for (const schedule of [ENTRY_RETENTION_SCHEDULE, LABEL_RETENTION_SCHEDULE, ENTRY_INCARNATION_CUTOVER_SCHEDULE])
    await client.pauseSchedule(schedule);
  await work.launch();
  console.log('worker-ready');
  process.once(
    'SIGTERM',
    () =>
      void (async () => {
        await work.shutdown();
        await client.close();
        await pool.end();
        process.exit(0);
      })(),
  );
}
