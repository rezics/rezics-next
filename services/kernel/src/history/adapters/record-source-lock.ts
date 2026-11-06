import { nativeRecordPurgeCustody, type RecordPurgeReceivingHold } from './record-native-custody.ts';
import { nativeRecordSourceSetProducer, type RecordSourceSetCommitment } from './record-source-set-native.ts';
import { recordSourceSetStorageKey } from './record-source-set.ts';
import { currentCommand, type CommandTransaction } from '../../command/command.ts';
import {
  lockRecordPurgeAuthoritySource,
  type RecordPurgeAuthority,
  type RecordPurgeSource,
} from '../../semantic/record-purge-authority.ts';
import { recordHistoryPurgeSourceReference } from './record-resource-adapter.ts';
import { type HistoryArtifactType, recordHistorySourceKey } from '../contract/index.ts';

export type RecordHistoryLocalJob = Readonly<{
  partition_no: number;
  authority: RecordPurgeAuthority;
  receivingHold?: RecordPurgeReceivingHold;
  expectedSource?: RecordPurgeSource;
  sourceSet?: RecordSourceSetCommitment;
}>;

export function sameRecordPurgeSource(a: RecordPurgeSource, b: RecordPurgeSource): boolean {
  return (
    a.disposition === b.disposition &&
    a.sourceVersion === b.sourceVersion &&
    a.deletionTransactionId === b.deletionTransactionId &&
    a.deletionCommittedAt === b.deletionCommittedAt &&
    a.purgeAfter === b.purgeAfter &&
    a.reference.deletionGeneration === b.reference.deletionGeneration &&
    purgeSourceKey(a) === purgeSourceKey(b)
  );
}

export function purgeSourceKey(source: RecordPurgeSource): string {
  return recordHistorySourceKey(recordHistoryPurgeSourceReference(source.reference));
}

/** Exact source and association locks remain held through physical effect and local progress. */
export async function lockRecordHistoryCopy(
  tx: CommandTransaction,
  job: RecordHistoryLocalJob,
  type: HistoryArtifactType,
  locator: Buffer,
): Promise<boolean> {
  if (currentCommand(tx).partition !== job.partition_no) return false;
  const custody = job.receivingHold ? await nativeRecordPurgeCustody() : null;
  const source = job.receivingHold
    ? await custody?.lockRecordPurgeReceivingHold(tx, job.receivingHold)
    : await lockRecordPurgeAuthoritySource(tx, job.authority);
  if (!source || (job.expectedSource && !sameRecordPurgeSource(source, job.expectedSource))) return false;
  if (job.sourceSet) {
    const set = job.sourceSet;
    // This retained immutable enrollment was produced ONLY by the native member-to-set
    // index. A real authority for another record cannot authorize a caller-supplied set.
    // This is History's own exact metadata point, never foreign Source SQL. A receiving
    // database lacking that enrollment must remain unavailable, not infer membership.
    const enrolled = await tx.query(
      `SELECT original_transaction,member_count,native_revision,snapshot_digest FROM core.record_history_purge_set
       WHERE source_key=$1 AND deletion_generation=$2 AND source_partition=$3
         AND set_locator=$4 AND set_revision=$5 FOR SHARE`,
      [purgeSourceKey(source), source.reference.deletionGeneration, ...recordSourceSetStorageKey(set.locator)],
    );
    if (
      enrolled.rows[0]?.original_transaction !== set.locator.transactionId ||
      enrolled.rows[0]?.member_count !== set.members ||
      enrolled.rows[0]?.native_revision !== set.locator.revision ||
      enrolled.rows[0]?.snapshot_digest !== set.digest
    )
      return false;
    if (
      !job.receivingHold &&
      !(await nativeRecordSourceSetProducer().verifySemanticRecordSourceSet(tx, set.locator, set.digest))
    )
      return false;
    const found = await tx.query(
      `SELECT producer_version,original_transaction,original_position FROM core.record_history_source_set_copy
       WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3
         AND partition_no=$4 AND artifact_type=$5 AND locator=$6 FOR UPDATE`,
      [...recordSourceSetStorageKey(set.locator), job.partition_no, type, locator],
    );
    const row = found.rows[0];
    return (
      !!row &&
      row.producer_version === 1 &&
      row.original_position !== null &&
      row.original_transaction === set.locator.transactionId
    );
  }
  const found = await tx.query(
    `SELECT producer_version,original_position FROM core.record_history_locator
     WHERE source_key=$1 AND partition_no=$2 AND artifact_type=$3 AND locator=$4 FOR UPDATE`,
    [purgeSourceKey(source), job.partition_no, type, locator],
  );
  return found.rows.length === 1 && found.rows[0].producer_version === 1 && found.rows[0].original_position !== null;
}
