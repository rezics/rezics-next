import type { Pool, PoolClient } from 'pg';
import { shareAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { PARTITIONS, routeOf } from '../route/route.ts';
import { workStepDeadline } from './command-support.ts';
import { lockLabelAssignmentSubject } from './label-assignment-store.ts';

type Key = {
  accountId: string;
  labelId: string;
  revision: number;
  deletedAt: string;
  purgeAfter: string;
  subjectId: string;
  assignmentId: string | null;
};
type Cursor = {
  version: 1;
  partition: number;
  route: number;
  kind: 'label' | 'assignment';
  cutoff: string;
  last: Key | null;
  parent: Key | null;
  childAfter: string | null;
};
type Client = Pick<PoolClient, 'query'>;
export type LabelRetentionPage = { examined: number; removed: number; next: string | null };
const ZERO = '00000000-0000-0000-0000-000000000000';
const columns = `account_id AS "accountId", label_id AS "labelId", revision,
  deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"`;

function encode(cursor: Cursor): string {
  const value = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  if (Buffer.byteLength(value) > 2048) throw new RangeError('Label retention cursor exceeds its bound');
  return value;
}
function decode(after: string, partition: number): Cursor {
  if (typeof after !== 'string' || Buffer.byteLength(after) > 2048 || !/^[A-Za-z0-9_-]+$/.test(after))
    throw new TypeError('Invalid private retention cursor');
  const cursor = JSON.parse(Buffer.from(after, 'base64url').toString()) as Cursor;
  if (!cursor || typeof cursor !== 'object') throw new TypeError('Invalid private retention cursor');
  if (cursor.version !== 1 || cursor.partition !== partition ||
      !Number.isInteger(cursor.route) || cursor.route < partition * 16 || cursor.route >= (partition + 1) * 16 ||
      !['label', 'assignment'].includes(cursor.kind) || !Number.isFinite(Date.parse(cursor.cutoff)))
    throw new TypeError('Invalid private retention cursor');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const key of [cursor.last, cursor.parent]) {
    if (key !== null && (!key || routeOf(key.accountId) !== cursor.route || !uuid.test(key.labelId) ||
      !Number.isInteger(key.revision) || key.revision < 1 || key.revision > 2147483647 ||
      !Number.isFinite(Date.parse(key.deletedAt)) || !Number.isFinite(Date.parse(key.purgeAfter)) ||
      (key.subjectId !== '' && !uuid.test(key.subjectId)) ||
      (key.assignmentId !== null && !uuid.test(key.assignmentId))))
      throw new TypeError('Invalid private retention key');
  }
  if ((cursor.parent !== null && cursor.kind !== 'label') ||
      (cursor.childAfter !== null && !uuid.test(cursor.childAfter))) throw new TypeError('Invalid private parent cursor');
  return cursor;
}

async function discover(db: Client, cursor: Cursor): Promise<Key | undefined> {
  const { route, cutoff, last } = cursor;
  // One exact route equality per seek. The two existing partial due indexes need no global timestamp index.
  const result = cursor.kind === 'label'
    ? await db.query<Key>(`SELECT ${columns}, ''::text AS "subjectId", NULL::uuid AS "assignmentId"
        FROM library.personal_label WHERE route=$1 AND deleted_at IS NOT NULL AND purge_after <= $2::timestamptz
        AND (purge_after,account_id,label_id) > ($3::timestamptz,$4::uuid,$5::uuid)
        ORDER BY purge_after,account_id,label_id LIMIT 1`,
      [route, cutoff, last?.purgeAfter ?? '-infinity', last?.accountId ?? ZERO, last?.labelId ?? ZERO])
    : await db.query<Key>(`SELECT ${columns}, subject_id AS "subjectId", assignment_id AS "assignmentId"
        FROM library.label_assignment WHERE route=$1 AND deleted_at IS NOT NULL AND purge_after <= $2::timestamptz
        AND (purge_after,account_id,subject_id,label_id) > ($3::timestamptz,$4::uuid,$5::uuid,$6::uuid)
        ORDER BY purge_after,account_id,subject_id,label_id LIMIT 1`,
      [route, cutoff, last?.purgeAfter ?? '-infinity', last?.accountId ?? ZERO, last?.subjectId ?? ZERO, last?.labelId ?? ZERO]);
  return result.rows[0];
}

/** Private automatic producer. Only service configuration can inject a clock; input conveys no authority.
 * Source checkout ends before the owning native command, which rechecks time, owner and exact episode.
 * A cursor contains bounded technical keys only; it is never a public list/Undo token.
 */
export async function purgeLabelRetentionPage(
  { pool, clock }: { pool: Pool; clock?: KernelClock },
  { partition, limit, after }: { partition: number; limit: number; after: string | null },
): Promise<LabelRetentionPage> {
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS) throw new RangeError('Invalid partition');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid page limit');
  const deadline = workStepDeadline();
  const cursor: Cursor = after === null ? {
    version: 1, partition, route: partition * 16, kind: 'label', last: null, parent: null, childAfter: null,
    cutoff: (await pool.query<{ at: string }>(
      "SELECT COALESCE($1::timestamptz,transaction_timestamp())::text AS at", [clock?.().toISOString() ?? null],
    )).rows[0]!.at,
  } : decode(after, partition);
  const result: LabelRetentionPage = { examined: 0, removed: 0, next: null };
  while (cursor.route < (partition + 1) * 16 && result.examined < limit && Date.now() < deadline - 100) {
    if (!cursor.parent) {
      const key = await withConnection(pool, (db) => discover(db, cursor));
      if (!key) {
        cursor.last = null;
        if (cursor.kind === 'label') cursor.kind = 'assignment';
        else { cursor.route++; cursor.kind = 'label'; }
        continue;
      }
      result.examined++;
      cursor.last = key;
      if (cursor.kind === 'label') { cursor.parent = key; cursor.childAfter = null; }
      else {
        result.removed += await purgeAssignment(pool, clock, deadline, cursor.route, key);
        continue;
      }
    }
    // The parent locator survives a full raw page. No private progress table or permanent tombstone is needed.
    if (result.examined === limit) break;
    const key = cursor.parent;
    const remaining = Math.min(99, limit - result.examined);
    try {
      const outcome = await runCommand(pool, {
        partition, deadline, clock,
        authorization: {
          action: 'library:label-retention-maintenance', resource: { route: cursor.route, id: key.accountId },
          denied: () => new LifecycleDeniedError(),
          async authorize(tx) { await shareAccount(tx, key.accountId); return 'execute'; },
        },
      }, async (tx, command) => {
        const time = authoritativeTimeValue(command.time);
        const parameters = [cursor.route, key.accountId, key.labelId, key.revision, key.deletedAt, key.purgeAfter, time];
        // Exclusive parent lock fences restore/redelete and admission's sorted parent FOR SHARE locks.
        const parent = await tx.query(`SELECT label_id FROM library.personal_label
          WHERE route=$1 AND account_id=$2 AND label_id=$3 AND revision=$4
          AND deleted_at=$5::timestamptz AND purge_after=$6::timestamptz AND purge_after <= $7::timestamptz
          FOR UPDATE`, parameters);
        if (!parent.rows.length) return noEffect({ examined: 0, removed: 0, more: false, childAfter: null as string | null });
        const children = await tx.query<{ subjectId: string; assignmentId: string | null; revision: number;
          deletedAt: string | null; purgeAfter: string | null; slotNo: number | null }>(
          `SELECT subject_id AS "subjectId", assignment_id AS "assignmentId", revision,
             deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter", slot_no AS "slotNo"
           FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND label_id=$3 AND subject_id > $4::uuid
           ORDER BY subject_id LIMIT $5`,
          [cursor.route, key.accountId, key.labelId, cursor.childAfter ?? ZERO, remaining]);
        let removed = 0;
        for (const child of children.rows) {
          // Parent is exclusively locked: admission/restore cannot install a replacement while we erase.
          const deleted = await tx.query(`DELETE FROM library.label_assignment
            WHERE route=$1 AND account_id=$2 AND label_id=$3 AND subject_id=$4 AND revision=$5
            AND assignment_id IS NOT DISTINCT FROM $6::uuid AND slot_no IS NOT DISTINCT FROM $7::smallint
            AND deleted_at IS NOT DISTINCT FROM $8::timestamptz AND purge_after IS NOT DISTINCT FROM $9::timestamptz
            AND (deleted_at IS NULL OR purge_after <= $10::timestamptz) RETURNING subject_id`,
            [cursor.route,key.accountId,key.labelId,child.subjectId,child.revision,child.assignmentId,child.slotNo,
              child.deletedAt,child.purgeAfter,time]);
          removed += deleted.rows.length;
        }
        // Actual indexed absence, including independently deleted children with a later original deadline.
        const head = await tx.query(`DELETE FROM library.personal_label AS p
          WHERE p.route=$1 AND p.account_id=$2 AND p.label_id=$3 AND p.revision=$4
          AND p.deleted_at=$5::timestamptz AND p.purge_after=$6::timestamptz AND p.purge_after <= $7::timestamptz
          AND NOT EXISTS (SELECT 1 FROM library.label_assignment AS a
            WHERE a.route=$1 AND a.account_id=$2 AND a.label_id=$3) RETURNING label_id`, parameters);
        removed += head.rows.length;
        const value = { examined: children.rows.length, removed,
          more: head.rows.length === 0 && children.rows.length === remaining,
          childAfter: children.rows.at(-1)?.subjectId ?? null };
        if (!removed) return noEffect(value);
        return { value, events: [{ type: 'com.rezics.library.label.retention-purged.v1',
          subject: key.accountId, data: { labelId: key.labelId } }] };
      });
      result.examined += outcome.value.examined;
      result.removed += outcome.value.removed;
      cursor.childAfter = outcome.value.childAfter;
      if (!outcome.value.more) { cursor.parent = null; cursor.childAfter = null; }
    } catch (error) {
      // Terminal T owns these rows. Never reconstitute an Actor or an account to finish ordinary work.
      if (!(error instanceof LifecycleDeniedError)) throw error;
      cursor.parent = null; cursor.childAfter = null;
    }
  }
  result.next = cursor.route < (partition + 1) * 16 ? encode(cursor) : null;
  if (Buffer.byteLength(JSON.stringify(result)) > 4096) throw new RangeError('Label retention result exceeds its bound');
  return result;
}

async function purgeAssignment(pool: Pool, clock: KernelClock | undefined, deadline: number, route: number, key: Key) {
  try {
    const outcome = await runCommand(pool, {
      partition: route >>> 4, deadline, clock,
      authorization: {
        action: 'library:label-retention-maintenance', resource: { route, id: key.accountId },
        denied: () => new LifecycleDeniedError(),
        async authorize(tx) { await shareAccount(tx, key.accountId); return 'execute'; },
      },
    }, async (tx, command) => {
      await lockLabelAssignmentSubject(tx, { route, accountId: key.accountId, subjectId: key.subjectId });
      const deleted = await tx.query(`DELETE FROM library.label_assignment
        WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4
        AND assignment_id IS NOT DISTINCT FROM $5::uuid AND revision=$6
        AND deleted_at=$7::timestamptz AND purge_after=$8::timestamptz AND purge_after <= $9::timestamptz
        AND slot_no IS NULL RETURNING label_id`,
        [route,key.accountId,key.subjectId,key.labelId,key.assignmentId,key.revision,key.deletedAt,key.purgeAfter,
          authoritativeTimeValue(command.time)]);
      if (!deleted.rows.length) return noEffect(0);
      return { value: 1, events: [{ type: 'com.rezics.library.label.retention-purged.v1',
        subject: key.accountId, data: { labelId: key.labelId } }] };
    });
    return outcome.value;
  } catch (error) {
    if (error instanceof LifecycleDeniedError) return 0;
    throw error;
  }
}
