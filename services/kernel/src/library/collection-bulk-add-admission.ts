import type { Pool } from 'pg';
import { Compile } from 'typebox/compile';
import { accessCheck, type Access, type AccountActor, type AccessContext } from '../request/access.ts';
import type { AuthoritativeTime, CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { ProblemError } from '../http/problem.ts';
import { routeOf } from '../route/route.ts';
import { bulkAdmissionSchema } from './bulk-schemas.ts';
import { BULK_ADMISSION_BODY_BYTES, BULK_MAX_SELECTION_IDS } from './bulk-limits.ts';
import type { BulkAdmission, EntryExpectation } from './bulk-contract.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { readCollection } from './collection-store.ts';
import type { CollectionBulkTarget } from './collection-bulk-store.ts';
import { resolveSubject, type ResolvedSubject } from './subject-anchor.ts';

export type ExplicitCollectionBulkAdd = Extract<BulkAdmission, { action: 'add_to_collection' }> & {
  selection: Extract<BulkAdmission['selection'], { kind: 'explicit' }>;
};

const validator = Compile(bulkAdmissionSchema);

/** Validate and freeze the explicit add intent before any destination or Subject read. */
export function explicitCollectionBulkAdd(input: BulkAdmission): ExplicitCollectionBulkAdd {
  if (Buffer.byteLength(JSON.stringify(input)) > BULK_ADMISSION_BODY_BYTES)
    throw new RangeError('Bulk command exceeds 64 KiB');
  if (!validator.Check(input)) throw new TypeError('Invalid bulk selection');
  if (input.action !== 'add_to_collection' || input.selection.kind !== 'explicit')
    throw new ProblemError('dependency_unavailable');
  const collectionId = input.collectionId.toLowerCase();
  if (routeOf(collectionId) === null) throw new TypeError('Invalid target Collection');
  const targets = [...new Set(input.selection.targets.map(({ subjectId }) => subjectId.toLowerCase()))];
  if (!targets.length || targets.length > BULK_MAX_SELECTION_IDS) throw new RangeError('Select 1 to 1,000 subjects');
  return {
    action: 'add_to_collection',
    collectionId,
    selection: { kind: 'explicit', targets: targets.map((subjectId) => ({ subjectId })) },
  };
}

export async function prepareCollectionBulkAddAdmission(
  dependencies: { pool: Pool; access: Access },
  actor: AccountActor,
  request: ExplicitCollectionBulkAdd,
  at: AuthoritativeTime,
  context: AccessContext,
): Promise<readonly ResolvedSubject[]> {
  const collectionRoute = routeOf(request.collectionId);
  if (collectionRoute === null) throw new LibraryNotFoundError();
  const resource = { route: collectionRoute, id: request.collectionId };
  let check: Awaited<ReturnType<typeof accessCheck>>;
  try {
    check = await accessCheck(dependencies.access, actor, 'collection:update', resource, context);
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new LibraryNotFoundError();
    throw error;
  }

  const destination = await withConnection(dependencies.pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      if (!(await check(client, at))) {
        await client.query('COMMIT');
        return null;
      }
      const current = await readCollection(client, collectionRoute, request.collectionId);
      await client.query('COMMIT');
      return current;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  if (!destination || destination.state !== 'active') throw new LibraryNotFoundError();
  if (destination.membershipKind === 'dynamic') throw new ProblemError('dynamic_membership_immutable');

  const subjects: ResolvedSubject[] = [];
  const seen = new Set<string>();
  for (const { subjectId } of request.selection.targets) {
    const subject = await resolveSubject(dependencies, actor, subjectId, at, context);
    if (!subject) throw new LibraryNotFoundError();
    if (!seen.has(subject.subjectId)) {
      seen.add(subject.subjectId);
      subjects.push(subject);
    }
  }
  return subjects;
}

/** Capture the executor's exact personal-entry fence. It is never used as Collection membership evidence. */
export async function captureCollectionBulkAddTargets(
  tx: Pick<CommandTransaction, 'query'>,
  route: number,
  accountId: string,
  collectionId: string,
  subjects: readonly ResolvedSubject[],
): Promise<CollectionBulkTarget[]> {
  const ids = subjects.map(({ subjectId }) => subjectId);
  const entries = await tx.query<{
    subjectId: string;
    incarnation: string | null;
    admissionSequence: string | null;
    revision: number;
  }>(
    `SELECT subject_id AS "subjectId",incarnation_id AS incarnation,owner_write_seq::text AS "admissionSequence",revision
       FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=ANY($3::uuid[]) ORDER BY subject_id`,
    [route, accountId, ids],
  );
  const bySubject = new Map(entries.rows.map((entry) => [entry.subjectId, entry]));
  const absent = await tx.query<{ sequence: string }>(
    'SELECT seq::text AS sequence FROM library.owner_write_counter WHERE route=$1 AND account_id=$2',
    [route, accountId],
  );
  // The installed executor treats a missing counter row as the owner's initial generation.
  const slotGeneration = absent.rows[0]?.sequence ?? '0';
  if (!/^(0|[1-9][0-9]*)$/.test(slotGeneration)) throw new ProblemError('dependency_unavailable');

  return subjects.map(({ subjectId, requestedSubjectId }) => {
    const entry = bySubject.get(subjectId);
    let expected: EntryExpectation;
    if (entry) {
      if (
        !entry.incarnation ||
        routeOf(entry.incarnation) === null ||
        !entry.admissionSequence ||
        !/^(0|[1-9][0-9]*)$/.test(entry.admissionSequence) ||
        !Number.isSafeInteger(entry.revision) ||
        entry.revision < 1
      )
        throw new ProblemError('dependency_unavailable');
      expected = {
        kind: 'present',
        incarnation: entry.incarnation,
        admissionSequence: entry.admissionSequence,
        revision: entry.revision,
      };
    } else expected = { kind: 'absent', slotGeneration };
    return { kind: 'subject', subjectId, requestedSubjectId, collectionId, expected };
  });
}
