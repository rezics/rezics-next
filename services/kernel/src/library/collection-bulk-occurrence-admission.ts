import type { Pool } from 'pg';
import { Compile } from 'typebox/compile';
import { commandAccessContext } from '../access/command-admission.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { CommandAttempt } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { AccountActor, Access } from '../request/access.ts';
import { accessCheck } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { BulkAdmission, OccurrenceTarget } from './bulk-contract.ts';
import { bulkAdmissionSchema } from './bulk-schemas.ts';
import { BULK_ADMISSION_BODY_BYTES, BULK_MAX_SELECTION_IDS } from './bulk-limits.ts';
import type { CollectionBulkTarget } from './collection-bulk-store.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { readCollection } from './collection-store.ts';
import { readableSubjects } from './subject-anchor.ts';

export type ExplicitCollectionOccurrenceRemoval = Extract<BulkAdmission, { action: 'remove_from_collection' }> & {
  selection: { kind: 'occurrences'; memberIds: readonly string[] };
};
type CapturedOccurrenceTarget = Omit<Extract<OccurrenceTarget, { expected: unknown }>, 'operationId' | 'ordinal'>;

type OccurrenceAdmissionDependencies = { pool: Pool; access: Access };
const validator = Compile(bulkAdmissionSchema);

/** Validate and canonicalize the only Collection removal selection installed on the preview route. */
export function explicitCollectionOccurrenceRemoval(input: BulkAdmission): ExplicitCollectionOccurrenceRemoval {
  if (Buffer.byteLength(JSON.stringify(input)) > BULK_ADMISSION_BODY_BYTES)
    throw new RangeError('Bulk command exceeds 64 KiB');
  if (!validator.Check(input)) throw new TypeError('Invalid bulk selection');
  if (input.action !== 'remove_from_collection' || input.selection.kind !== 'occurrences')
    throw new ProblemError('dependency_unavailable');
  const collectionId = input.collectionId.toLowerCase();
  const memberIds = input.selection.memberIds.map((memberId) => memberId.toLowerCase());
  if (!memberIds.length || memberIds.length > BULK_MAX_SELECTION_IDS)
    throw new RangeError('Select 1 to 1,000 occurrences');
  if (new Set(memberIds).size !== memberIds.length) throw new TypeError('Occurrence member IDs must be unique');
  return { action: 'remove_from_collection', collectionId, selection: { kind: 'occurrences', memberIds } };
}

/** Capture only the selected active native rows, after current curated-Collection and Subject admission. */
export async function captureCollectionBulkOccurrences(
  deps: OccurrenceAdmissionDependencies,
  actor: AccountActor,
  input: ExplicitCollectionOccurrenceRemoval,
  attempt: CommandAttempt,
  deadline: number,
): Promise<CollectionBulkTarget[]> {
  const route = routeOf(input.collectionId);
  if (route === null || input.selection.memberIds.some((memberId) => routeOf(memberId) !== route))
    throw new LibraryNotFoundError();
  const context = commandAccessContext({ pool: deps.pool, deadline }, attempt);
  let collectionAccess: Awaited<ReturnType<typeof accessCheck>>;
  try {
    collectionAccess = await accessCheck(
      deps.access,
      actor,
      'collection:update',
      { route, id: input.collectionId },
      context,
    );
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new LibraryNotFoundError();
    throw error;
  }

  const targets = await withConnection(deps.pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const collection = await readCollection(tx, route, input.collectionId);
      if (
        !collection ||
        collection.state !== 'active' ||
        collection.membershipKind !== 'curated' ||
        !collection.curatorAccountId
      )
        throw new LibraryNotFoundError();
      try {
        if (!(await collectionAccess(tx, attempt.time))) throw new LibraryNotFoundError();
      } catch (error) {
        if (error instanceof GrantDeniedError) throw new LibraryNotFoundError();
        throw error;
      }

      const rows = await tx.query<{
        memberId: string;
        subjectId: string;
        memberRevision: string;
        transactionId: string;
        addedAt: string;
      }>(
        `SELECT member_id AS "memberId",subject_id AS "subjectId",member_revision::text AS "memberRevision",
          transaction_id AS "transactionId",added_at::text AS "addedAt"
         FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=ANY($3::uuid[])
           AND deletion_id IS NULL ORDER BY member_id`,
        [route, input.collectionId, input.selection.memberIds],
      );
      if (rows.rows.length !== input.selection.memberIds.length) throw new LibraryNotFoundError();
      const byId = new Map(rows.rows.map((row) => [row.memberId, row]));
      const captured = input.selection.memberIds.map((memberId): CollectionBulkTarget => {
        const row = byId.get(memberId);
        if (!row) throw new LibraryNotFoundError();
        const target: CapturedOccurrenceTarget = {
          kind: 'occurrence',
          collectionId: input.collectionId,
          memberId,
          subjectId: row.subjectId,
          expected: {
            memberRevision: row.memberRevision,
            transactionId: row.transactionId,
            addedAt: row.addedAt,
          },
        };
        return target;
      });
      await tx.query('COMMIT');
      return captured;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });

  const subjectIds = [...new Set(targets.map((target) => target.subjectId))];
  for (let offset = 0; offset < subjectIds.length; offset += 100) {
    const page = subjectIds.slice(offset, offset + 100);
    if ((await readableSubjects(deps, actor, page, attempt.time)).length !== page.length)
      throw new LibraryNotFoundError();
  }
  return targets;
}
