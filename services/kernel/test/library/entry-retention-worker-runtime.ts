import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { routeOf } from '../../src/route/route.ts';
import type { DueEntryDeletionKey } from '../../src/library/entry-due-store.ts';
import { accountToken } from '../support/admitted-access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

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

if (import.meta.main) {
  const [mode, executorId, timePath] = process.argv.slice(2);
  if (!executorId || !timePath) throw new Error('Runtime requires executor identity and native clock file');
  const pool = createPool(process.env.DATABASE_URL!);
  const client = await createWorkClient(process.env.DATABASE_URL!);
  let barrierUsed = false;
  // Test-only transport interception observes the actual native source/COMMIT, never replaces a command or SDK.
  // Holding after COMMIT leaves the DBOS page output uncheckpointed when this child is killed.
  if (mode !== 'recover') {
    const connect = pool.connect.bind(pool);
    pool.connect = (async () => {
      const connection: PoolClient = await connect();
      const query = connection.query.bind(connection);
      let deleted = false;
      connection.query = (async (...args: unknown[]) => {
        const sql = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
        const result = await (query as (...args: unknown[]) => Promise<{ rows: unknown[] }>)(...args);
        if (/DELETE FROM library.entry_deleted/i.test(sql) && result.rows.length) deleted = true;
        const park = mode === 'park' && /SELECT restore_until::text AS "restoreUntil"/i.test(sql) && result.rows.length;
        const committed = mode === 'crash' && deleted && /^COMMIT$/i.test(sql.trim());
        if (!barrierUsed && (park || committed)) {
          barrierUsed = true;
          console.log(park ? 'source-parked' : 'native-committed');
          await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
        }
        return result;
      }) as PoolClient['query'];
      const release = connection.release.bind(connection);
      connection.release = (...args) => {
        connection.query = query as PoolClient['query'];
        connection.release = release;
        return release(...args);
      };
      return connection;
    }) as Pool['connect'];
  }
  const work = await composeWork([libraryWorkModule], {
    pool,
    client,
    databaseUrl: process.env.DATABASE_URL!,
    executorId,
    clock: () => new Date(Number(readFileSync(timePath, 'utf8'))),
    env: {},
  });
  await work.launch();
  console.log('worker-ready');
  const stop = async () => {
    await work.shutdown();
    await client.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
}

/** Legal unrelated owners/live replacements/future archives grow both partition-local and remote indexes. */
export async function growRetentionPopulation(
  f: NativeProfileFixture,
  partition: number,
  subjectId: string,
  previous: number,
  scale: number,
) {
  for (let n = previous; n < scale; n++) {
    if (n % 16 === 0) await renewRetentionIdentities(f);
    const owner = await f.identity(
      ['subject:read', 'library_entry:update', 'library_entry:delete'],
      n % 2 === 0 ? partition : (partition + 1) % 4096,
    );
    await archive(f, subjectId, owner.actor);
    await f.commands.putEntry(owner.actor, subjectId, { state: 'planned' }, entryKey());
  }
}

export async function renewRetentionIdentities(f: NativeProfileFixture) {
  for (const identity of [f.owner, f.other, f.steward]) {
    identity.bearer = await accountToken(identity.actor);
    identity.actor = await f.access.authenticate(identity.bearer, { pool: f.pool, deadline: deadlineFor(30000) });
  }
}
