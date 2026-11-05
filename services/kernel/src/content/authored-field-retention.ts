import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  lockRecordPurgeAuthoritySource,
  type RecordPurgeAuthority,
  type RecordPurgeReference,
} from '../semantic/record-purge-authority.ts';
import lock from './authored-field-retention-lock.sql';
import purge from './authored-field-retention-purge.sql';
import bind from './authored-field-retention-bind.sql';

export type AuthoredFieldPurgeResult = Readonly<{
  documentId: string;
  deletionGeneration: string;
  state: 'purged' | 'already-purged';
}>;

/** Source eligibility and Content custody commit in the caller's native source
 * command. Neither an author permission nor a caller-supplied source is authority.
 */
export async function purgeAuthoredFieldForDeletedRecord(
  tx: CommandTransaction,
  authority: RecordPurgeAuthority,
): Promise<AuthoredFieldPurgeResult | null> {
  // The owner rechecks native T, deadline, generation, holds and restoration while
  // holding its source locks. Unavailable/unknown source evidence must throw.
  const source = await lockRecordPurgeAuthoritySource(tx, authority);
  if (source === null) return null;
  if (source.disposition !== 'ordinary-deletion') throw new TypeError('Invalid record purge disposition');
  const reference = source.reference;
  // Content owns authored fields only for semantic contributions. Context and
  // Zone payloads have their own native owners and must never be interpreted as
  // document-bearing contribution references.
  if (!isContributionReference(reference)) return null;
  if (reference.documentId === null) return null;
  const route = routeOf(reference.subjectId);
  if (
    route === null ||
    routeOf(reference.documentId) !== route ||
    routeOf(reference.candidateId) !== route ||
    partitionOf(route) !== currentCommand(tx).partition
  )
    throw new RangeError('Authored field purge requires the current source home command');
  if (!Number.isSafeInteger(reference.revision) || reference.revision < 1)
    throw new TypeError('Invalid record purge revision');

  const binding = {
    route,
    document_id: reference.documentId,
    subject_id: reference.subjectId,
    candidate_id: reference.candidateId,
    revision: reference.revision,
    deletion_generation: reference.deletionGeneration,
    source_version: source.sourceVersion,
    deletion_transaction_id: source.deletionTransactionId,
    deletion_committed_at: source.deletionCommittedAt,
    purge_after: source.purgeAfter,
  };
  // Source first, then this exact immutable authored tuple; never reverse the
  // lock order used to serialize source restoration and purge progress.
  const row = await lock.run(tx, binding);
  if (!row || (row.recorded && !row.same_source)) return null;
  if (row.recorded) {
    if (!row.body_is_null || row.availability !== 'erased')
      throw new Error('Authored field purge evidence does not match physical custody');
    return {
      documentId: reference.documentId,
      deletionGeneration: reference.deletionGeneration,
      state: 'already-purged',
    };
  }

  // An earlier author/account erasure may already have removed the bytes. It
  // supplies no ordinary-record completion until this live source binding commits.
  const alreadyErased = row.availability === 'erased' && row.body_is_null;
  if (!alreadyErased) {
    if (row.availability !== 'available' || row.body_is_null)
      throw new Error('Invalid authored field physical custody');
    if ((await purge.run(tx, binding)) === null) throw new Error('Authored field physical purge did not complete');
  }
  // The INSERT independently requires the exact native tombstone with NULL bytes.
  // A failed INSERT aborts the same transaction as the body change and source lock.
  if ((await bind.run(tx, binding)).length !== 1) throw new Error('Authored field purge source binding did not commit');
  return {
    documentId: reference.documentId,
    deletionGeneration: reference.deletionGeneration,
    state: alreadyErased ? 'already-purged' : 'purged',
  };
}

function isContributionReference(reference: unknown): reference is RecordPurgeReference {
  return typeof reference === 'object' && reference !== null && 'subjectId' in reference;
}
