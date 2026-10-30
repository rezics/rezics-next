import type { CommandTransaction } from '../command/command.ts';
import type { RecordPurgeAuthority } from '../semantic/record-purge-authority.ts';
import {
  nativeRecordSourceSetProducer,
  RecordSourceSetUnavailableError,
  type RecordSourceSetCommitment,
} from './record-source-set-native.ts';
import { validateRecordSourceSetCommitment } from './record-source-set.ts';
import type { HistoryArtifactType } from './contracts.ts';

export type RecordHistoryCopy = Readonly<{
  partition_no: number;
  artifact_type: HistoryArtifactType;
  locator: Buffer;
  gap?: string | null;
  sourceSet?: RecordSourceSetCommitment;
}>;

/** Discover one native reverse-index page and retain its exact immutable locators. Later
 * revisions cannot replace membership in an original set. No membership is inferred locally. */
export async function enrollRecordHistorySourceSets(
  tx: CommandTransaction,
  authority: RecordPurgeAuthority,
  key: string,
  generation: string,
): Promise<string | null> {
  let producer;
  try {
    producer = await nativeRecordSourceSetProducer();
  } catch (error) {
    if (error instanceof RecordSourceSetUnavailableError) return error.code;
    throw error;
  }
  const progress = await tx.query(
    `SELECT set_frontier,set_inventory_sealed FROM core.record_history_purge
     WHERE source_key=$1 AND deletion_generation=$2 FOR UPDATE`,
    [key, generation],
  );
  const row = progress.rows[0];
  if (!row) throw new TypeError('Record history source-set progress missing');
  if (row.set_inventory_sealed) return null;
  const page = await producer.readRecordSourceSetMembership(tx, authority, row.set_frontier, 1);
  if (page.sets.length > 1) throw new TypeError('Native source-set reverse page exceeded bound');
  if (
    page.frontier !== null &&
    (!(page.frontier instanceof Uint8Array) || page.frontier.byteLength < 1 || page.frontier.byteLength > 256)
  )
    throw new TypeError('Native source-set reverse frontier exceeded metadata bound');
  for (const set of page.sets) {
    validateRecordSourceSetCommitment(set);
    if (!(await producer.verifyRecordSourceSet(tx, set)))
      throw new TypeError('Native source-set reverse membership is unproven');
    await tx.query(
      `INSERT INTO core.record_history_purge_set
       (source_key,deletion_generation,source_partition,set_locator,set_revision,original_transaction,member_count)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        key,
        generation,
        set.sourcePartition,
        Buffer.from(set.locator),
        Buffer.from(set.revision),
        set.originalTransaction,
        set.memberCount,
      ],
    );
  }
  if (page.state !== 'pending')
    await tx.query(
      `UPDATE core.record_history_purge SET set_frontier=$3,set_inventory_sealed=$4
       WHERE source_key=$1 AND deletion_generation=$2`,
      [key, generation, page.frontier === null ? null : Buffer.from(page.frontier), page.state === 'sealed'],
    );
  return page.state === 'sealed' ? null : 'record-native-source-set-inventory-unsealed';
}

/** Rotating retained sets keeps late receiving associations visible after native reverse
 * enumeration. Neither that enumeration's EOF nor this copy page seals receiving inventory. */
export async function readRecordHistorySourceSetCopies(
  tx: CommandTransaction,
  key: string,
  generation: string,
  limit: number,
): Promise<RecordHistoryCopy[]> {
  if (limit < 1) return [];
  const sets = await tx.query(
    `SELECT source_partition,set_locator,set_revision,original_transaction,member_count
     FROM core.record_history_purge_set WHERE source_key=$1 AND deletion_generation=$2
     AND next_attempt<=now() ORDER BY next_attempt,source_partition,set_locator,set_revision LIMIT 1 FOR UPDATE`,
    [key, generation],
  );
  const row = sets.rows[0];
  if (!row) return [];
  const set: RecordSourceSetCommitment = {
    sourcePartition: row.source_partition,
    locator: row.set_locator,
    revision: row.set_revision,
    originalTransaction: row.original_transaction,
    memberCount: row.member_count,
  };
  const copies = await tx.query<RecordHistoryCopy>(
    `SELECT partition_no,artifact_type,locator,gap FROM core.record_history_source_set_copy
     WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3 AND (state='pending' OR gap='record-source-native-release-pending') AND next_attempt<=now()
     ORDER BY next_attempt,partition_no,artifact_type,locator LIMIT $4`,
    [set.sourcePartition, Buffer.from(set.locator), Buffer.from(set.revision), limit],
  );
  await tx.query(
    `UPDATE core.record_history_purge_set SET next_attempt=now()+interval '30 seconds'
     WHERE source_key=$1 AND deletion_generation=$2 AND source_partition=$3 AND set_locator=$4 AND set_revision=$5`,
    [key, generation, set.sourcePartition, Buffer.from(set.locator), Buffer.from(set.revision)],
  );
  return copies.rows.map((copy) => ({ ...copy, sourceSet: set }));
}

/** The receiving physical effect, association progress and native completion share this tx. */
export async function recordRecordHistoryCopyProgress(
  tx: CommandTransaction,
  key: string,
  copy: RecordHistoryCopy,
  pending: string | null,
  minimized = pending === null,
): Promise<void> {
  if (copy.sourceSet) {
    const set = copy.sourceSet;
    await tx.query(
      `UPDATE core.record_history_source_set_copy SET state=$7,gap=$8,next_attempt=now()+interval '30 seconds'
       WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3
         AND partition_no=$4 AND artifact_type=$5 AND locator=$6`,
      [
        set.sourcePartition,
        Buffer.from(set.locator),
        Buffer.from(set.revision),
        copy.partition_no,
        copy.artifact_type,
        copy.locator,
        minimized ? 'minimized' : 'pending',
        pending,
      ],
    );
  } else {
    await tx.query(
      `UPDATE core.record_history_locator SET state=$5,gap=$6,next_attempt=now()+interval '30 seconds'
       WHERE source_key=$1 AND partition_no=$2 AND artifact_type=$3 AND locator=$4`,
      [key, copy.partition_no, copy.artifact_type, copy.locator, minimized ? 'minimized' : 'pending', pending],
    );
  }
}
