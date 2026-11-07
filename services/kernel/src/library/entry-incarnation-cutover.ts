import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { LifecycleDeniedError } from '../access/contract/errors.ts';
import { CommandUnavailableError } from '../access/contract/errors.ts';
import { runOperationalTransaction } from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { newId, PARTITIONS, routeOf } from '../route/route.ts';
import { createWorkClient, type WorkClient } from '../work/client.ts';
import { workStepDeadline } from './collection-command-work.ts';
import page from './entry-incarnation-cutover-page.sql';
import lock from './entry-incarnation-cutover-lock.sql';
import stamp from './entry-legacy-incarnation-stamp.sql';
import { fenceShelfTechnicalWrite } from './shelf-maintenance-owner.ts';

type Key = { route: number; accountId: string; subjectId: string };
type Cursor = Key & { v: 1; partition: number };
export type EntryIncarnationCutoverPage = {
  examined: number;
  stamped: number;
  next: string | null;
  pending: number;
};
const ZERO = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function decode(after: string, partition: number): Cursor {
  const invalid = () => new TypeError('Invalid private entry incarnation cursor');
  if (typeof after !== 'string' || after.length > 512 || !/^[A-Za-z0-9_-]+$/.test(after)) throw invalid();
  let cursor: Cursor;
  try {
    cursor = JSON.parse(Buffer.from(after, 'base64url').toString()) as Cursor;
  } catch {
    throw invalid();
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !== 'accountId,partition,route,subjectId,v' ||
    cursor.v !== 1 ||
    cursor.partition !== partition ||
    !Number.isInteger(cursor.route) ||
    cursor.route < partition * 16 ||
    cursor.route >= (partition + 1) * 16 ||
    typeof cursor.accountId !== 'string' ||
    routeOf(cursor.accountId) !== cursor.route ||
    typeof cursor.subjectId !== 'string' ||
    !UUID.test(cursor.subjectId)
  )
    throw invalid();
  return cursor;
}

/** Private technical repair, never authority, owner chronology, profile readiness or a GET side effect.
 * Raw live keys are materialized before eligibility checks. The checkout ends before each independently
 * fenced native transaction; even changes without a user revision invalidate the captured MVCC source.
 */
export async function cutoverEntryIncarnationsPage(
  { pool, clock, client }: { pool: Pool; clock?: KernelClock; client?: WorkClient },
  { partition, after, limit }: { partition: number; after: string | null; limit: number },
): Promise<EntryIncarnationCutoverPage> {
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError('Invalid partition');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid page limit');
  const cursor = after === null ? null : decode(after, partition);
  const deadline = workStepDeadline();
  const result: EntryIncarnationCutoverPage = { examined: 0, stamped: 0, next: null, pending: 0 };
  const keys = await withConnection(pool, async (db) => {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await db.query(`SET LOCAL statement_timeout = '${Math.max(1, deadline - Date.now())}ms'`);
      const metadata = await readPartition(db, partition);
      if (!metadata || metadata.writeState !== 'active') {
        result.pending++;
        await db.query('COMMIT');
        return [];
      }
      // One route-leading PK seek; no NULL predicate, catalogue, owner or history enumeration.
      const raw = await page.run(db, {
        start_route: partition * 16,
        end_route: (partition + 1) * 16,
        after_route: cursor?.route ?? partition * 16,
        after_account_id: cursor?.accountId ?? ZERO,
        after_subject_id: cursor?.subjectId ?? ZERO,
        limit,
      });
      await db.query('COMMIT');
      return raw;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  });
  result.examined = keys.length;
  const last = keys.at(-1);
  if (last && keys.length === limit) {
    const frontier: Cursor = {
      v: 1,
      partition,
      route: last.route,
      accountId: last.accountId,
      subjectId: last.subjectId,
    };
    result.next = Buffer.from(JSON.stringify(frontier)).toString('base64url');
  }
  let work = client;
  try {
    for (const source of keys) {
      if (source.incarnationId !== null) continue;
      const version = source.version;
      // Missing exact-source evidence stays pending; it cannot authorize a stamp.
      if (version === null || Date.now() >= deadline - 100) {
        result.pending++;
        continue;
      }
      work ??= await createWorkClient(pool.options.connectionString!, pool);
      try {
        const changed = await runOperationalTransaction(
          pool,
          {
            mode: 'work-step',
            partition,
            kind: 'library.entry.incarnation-cutover',
            accounts: [source.accountId],
            workClient: work,
            deadline,
            ...(clock === undefined ? {} : { clock }),
          },
          async (tx) => {
            await fenceShelfTechnicalWrite(tx, { route: source.route, accountId: source.accountId });
            // Lock only the exact captured row. xmin is ephemeral CAS evidence and is never checkpointed.
            const exact = await lock.run(tx, {
              route: source.route,
              account_id: source.accountId,
              subject_id: source.subjectId,
              revision: source.revision,
              transaction_id: source.transactionId,
              version,
            });
            if (exact?.subject_id !== source.subjectId) return false;
            const identity = newId(source.route);
            const stamped = await stamp.run(tx, {
              route: source.route,
              account_id: source.accountId,
              subject_id: source.subjectId,
              revision: source.revision,
              transaction_id: source.transactionId,
              incarnation_id: identity,
            });
            return stamped?.incarnationId === identity;
          },
        );
        if (changed) result.stamped++;
        else result.pending++;
      } catch (error) {
        if (
          error instanceof LifecycleDeniedError ||
          (error instanceof CommandUnavailableError && (error.reason === 'moved' || error.reason === 'fenced'))
        ) {
          result.pending++;
        } else throw error;
      }
    }
  } finally {
    if (!client) await work?.close();
  }
  return result;
}
