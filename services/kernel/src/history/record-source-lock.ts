import { currentCommand, type CommandTransaction } from '../command/command.ts';
import {
  lockRecordPurgeAuthoritySource,
  type RecordPurgeAuthority,
  type RecordPurgeSource,
} from '../semantic/record-purge-authority.ts';
import type { HistoryArtifactType } from './contracts.ts';
import { recordHistorySourceKey } from './record-source.ts';

export type RecordHistoryLocalJob = Readonly<{ partition_no: number; authority: RecordPurgeAuthority }>;

export function purgeSourceKey(source: RecordPurgeSource): string {
  // The current native issuer supports contribution references. Narrow before accessing its tuple;
  // resource variants must use their native resource key when the source owner delivers them.
  const ref = source.reference;
  if (!('subjectId' in ref)) throw new Error('record_history_native_resource_reference_unavailable');
  return recordHistorySourceKey({
    kind: 'contribution',
    subjectId: ref.subjectId,
    candidateId: ref.candidateId,
    revision: ref.revision,
    documentId: ref.documentId,
  });
}

/** Exact source and association locks remain held through physical effect and local progress. */
export async function lockRecordHistoryCopy(
  tx: CommandTransaction,
  job: RecordHistoryLocalJob,
  type: HistoryArtifactType,
  locator: Buffer,
): Promise<boolean> {
  if (currentCommand(tx).partition !== job.partition_no) return false;
  const source = await lockRecordPurgeAuthoritySource(tx, job.authority);
  if (!source) return false;
  const found = await tx.query(
    `SELECT producer_version,original_position FROM core.record_history_locator
     WHERE source_key=$1 AND partition_no=$2 AND artifact_type=$3 AND locator=$4 FOR UPDATE`,
    [purgeSourceKey(source), job.partition_no, type, locator],
  );
  return found.rows.length === 1 && found.rows[0].producer_version === 1 && found.rows[0].original_position !== null;
}
