import { noEffect, runCommand, type CommandTransaction } from '../../command/command.ts';
import type { Pool } from 'pg';
import type { RecordPurgeAuthority, RecordPurgeSource } from '../../semantic/record-purge-authority.ts';
import { lockRecordPurgeAuthoritySource } from '../../semantic/record-purge-authority.ts';
import {
  nativeRecordSourceSetProducer,
  RecordSourceSetUnavailableError,
  type RecordSourceSetCommitment,
} from './record-source-set-native.ts';
import { recordSourceSetStorageKey, validateNativeRecordSourceSetSnapshot } from './record-source-set.ts';
import { recordHistoryPurgeSourceReference } from './record-resource-adapter.ts';
import { sameRecordPurgeSource } from './record-source-lock.ts';
import { type HistoryArtifactType } from '../contract/index.ts';

export type RecordHistoryCopy = Readonly<{
  partition_no: number;
  artifact_type: HistoryArtifactType;
  locator: Buffer;
  gap?: string | null;
  sourceSet?: RecordSourceSetCommitment;
}>;
type NativePage = Awaited<
  ReturnType<import('./record-source-set-native.ts').RecordSourceSetProducer['pageSemanticRecordSourceSets']>
>;
type PreparedPage = Readonly<{
  frontier: string | null;
  complete: boolean;
  page: NativePage | null;
  gap: string | null;
}>;

/** All producer pool reads finish before the live source verification/History transaction.
 * This never opens another checkout while an original building set is uncommitted. */
export async function prepareRecordHistorySourceSetPage(
  deps: Readonly<{ pool: Pool; clock?: () => Date }>,
  authority: RecordPurgeAuthority,
  source: RecordPurgeSource,
  key: string,
  partition: number,
  context: Readonly<{ deadline: number }>,
): Promise<PreparedPage> {
  let producer;
  try {
    producer = nativeRecordSourceSetProducer();
  } catch (error) {
    if (error instanceof RecordSourceSetUnavailableError)
      return { frontier: null, complete: false, page: null, gap: error.code };
    throw error;
  }
  const progress = await runCommand(
    deps.pool,
    { partition, deadline: context.deadline, clock: deps.clock },
    async (tx) => {
      const current = await lockRecordPurgeAuthoritySource(tx, authority);
      if (!current || !sameRecordPurgeSource(current, source)) return noEffect(null);
      const found = await tx.query<{ native_set_frontier: string | null; native_set_index_complete: boolean }>(
        `SELECT native_set_frontier,native_set_index_complete FROM core.record_history_purge
       WHERE source_key=$1 AND deletion_generation=$2`,
        [key, source.reference.deletionGeneration],
      );
      return noEffect(found.rows[0] ?? null);
    },
  );
  const row = progress.value;
  if (!row)
    return { frontier: null, complete: false, page: null, gap: 'record-native-source-set-inventory-unavailable' };
  const page = await producer.pageSemanticRecordSourceSets(deps, recordHistoryPurgeSourceReference(source.reference), {
    // Revisit EOF on the next sweep: it cannot exclude later native writers.
    frontier: row.native_set_index_complete ? null : row.native_set_frontier,
    limit: 1,
    deadline: context.deadline,
  });
  if (
    page.sets.length > 1 ||
    (page.state !== 'progress' && page.state !== 'complete') ||
    (page.frontier !== null && typeof page.frontier !== 'string') ||
    !Number.isSafeInteger(page.examined) ||
    page.examined < 0
  )
    throw new TypeError('Invalid native source-set reverse page');
  for (const set of page.sets) {
    validateNativeRecordSourceSetSnapshot(set);
    // The reverse index points to a sealed immutable native row, never a building digest.
    const snapshot = await producer.readSemanticRecordSourceSet(deps, set.locator, context);
    if (!snapshot)
      return {
        frontier: row.native_set_frontier,
        complete: row.native_set_index_complete,
        page: null,
        gap: 'record-native-source-set-snapshot-unavailable',
      };
    validateNativeRecordSourceSetSnapshot(snapshot);
    if (
      snapshot.locator.partition !== set.locator.partition ||
      snapshot.locator.transactionId !== set.locator.transactionId ||
      snapshot.locator.revision !== set.locator.revision ||
      snapshot.digest !== set.digest ||
      snapshot.members !== set.members
    )
      throw new TypeError('Conflicting native record source set snapshot');
  }
  return { frontier: row.native_set_frontier, complete: row.native_set_index_complete, page, gap: null };
}

/** Native reverse-index EOF is only index progress, never historical/copy/source-cut proof. */
export async function enrollRecordHistorySourceSets(
  tx: CommandTransaction,
  key: string,
  generation: string,
  prepared: PreparedPage,
): Promise<string | null> {
  if (prepared.gap) return prepared.gap;
  const progress = await tx.query(
    `SELECT native_set_frontier,native_set_index_complete FROM core.record_history_purge
     WHERE source_key=$1 AND deletion_generation=$2 FOR UPDATE`,
    [key, generation],
  );
  const row = progress.rows[0];
  if (!row) throw new TypeError('Record history source-set progress missing');
  if (
    !prepared.page ||
    row.native_set_frontier !== prepared.frontier ||
    row.native_set_index_complete !== prepared.complete
  )
    return 'record-native-source-set-inventory-unsealed';
  const producer = nativeRecordSourceSetProducer();
  for (const set of prepared.page.sets) {
    if (!(await producer.verifySemanticRecordSourceSet(tx, set.locator, set.digest)))
      throw new TypeError('Native source-set reverse membership is unproven');
    const storageKey = recordSourceSetStorageKey(set.locator);
    await tx.query(
      `INSERT INTO core.record_history_purge_set
       (source_key,deletion_generation,source_partition,set_locator,set_revision,original_transaction,member_count,native_revision,snapshot_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [key, generation, ...storageKey, set.locator.transactionId, set.members, set.locator.revision, set.digest],
    );
    const enrolled = await tx.query(
      `SELECT original_transaction,member_count,native_revision,snapshot_digest FROM core.record_history_purge_set
       WHERE source_key=$1 AND deletion_generation=$2 AND source_partition=$3 AND set_locator=$4 AND set_revision=$5 FOR SHARE`,
      [key, generation, ...storageKey],
    );
    const retained = enrolled.rows[0];
    if (
      !retained ||
      retained.original_transaction !== set.locator.transactionId ||
      retained.member_count !== set.members ||
      retained.native_revision !== set.locator.revision ||
      retained.snapshot_digest !== set.digest
    )
      throw new TypeError('Conflicting immutable native source set enrollment');
    // Exact native verification is the only path from unresolved metadata to snapshot.
    await tx.query(
      `UPDATE core.record_history_source_set SET metadata_state='native-snapshot',snapshot_digest=$4,member_count=$5
       WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3 AND metadata_state='building'
       AND native_revision=$6 AND original_transaction=$7`,
      [...storageKey, set.digest, set.members, set.locator.revision, set.locator.transactionId],
    );
    const original = await tx.query(
      `SELECT original_transaction,native_revision,snapshot_digest,member_count,metadata_state
       FROM core.record_history_source_set WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3 FOR SHARE`,
      storageKey,
    );
    const row = original.rows[0];
    if (
      row &&
      (row.original_transaction !== set.locator.transactionId ||
        row.native_revision !== set.locator.revision ||
        row.snapshot_digest !== set.digest ||
        row.member_count !== set.members ||
        row.metadata_state !== 'native-snapshot')
    )
      throw new TypeError('Conflicting immutable native source set association');
  }
  await tx.query(
    `UPDATE core.record_history_purge SET native_set_frontier=$3,native_set_index_complete=$4
     WHERE source_key=$1 AND deletion_generation=$2`,
    [key, generation, prepared.page.frontier, prepared.page.state === 'complete'],
  );
  return prepared.page.state === 'complete' ? null : 'record-native-source-set-inventory-unsealed';
}

/** Rotation keeps late receiving copies visible; only real immutable snapshots are eligible. */
export async function readRecordHistorySourceSetCopies(
  tx: CommandTransaction,
  key: string,
  generation: string,
  limit: number,
): Promise<RecordHistoryCopy[]> {
  if (limit < 1) return [];
  const sets = await tx.query(
    `SELECT source_partition,set_locator,set_revision,original_transaction,member_count,native_revision,snapshot_digest
     FROM core.record_history_purge_set WHERE source_key=$1 AND deletion_generation=$2
     AND native_revision IS NOT NULL AND snapshot_digest IS NOT NULL
     AND next_attempt<=now() ORDER BY next_attempt,source_partition,set_locator,set_revision LIMIT 1 FOR UPDATE`,
    [key, generation],
  );
  const row = sets.rows[0];
  if (!row) return [];
  const set: RecordSourceSetCommitment = {
    locator: {
      partition: row.source_partition,
      transactionId: row.original_transaction,
      revision: row.native_revision,
    },
    digest: row.snapshot_digest,
    members: row.member_count,
  };
  validateNativeRecordSourceSetSnapshot(set);
  const storageKey = recordSourceSetStorageKey(set.locator);
  if (!storageKey[1].equals(row.set_locator) || !storageKey[2].equals(row.set_revision))
    throw new TypeError('Conflicting native source set storage key');
  const copies = await tx.query<RecordHistoryCopy>(
    `SELECT partition_no,artifact_type,locator,gap FROM core.record_history_source_set_copy
     WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3 AND (state='pending' OR gap='record-source-native-release-pending') AND next_attempt<=now()
     ORDER BY next_attempt,partition_no,artifact_type,locator LIMIT $4`,
    [...storageKey, limit],
  );
  await tx.query(
    `UPDATE core.record_history_purge_set SET next_attempt=now()+interval '30 seconds'
     WHERE source_key=$1 AND deletion_generation=$2 AND source_partition=$3 AND set_locator=$4 AND set_revision=$5`,
    [key, generation, ...storageKey],
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
        ...recordSourceSetStorageKey(set.locator),
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
