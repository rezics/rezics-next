import { currentCommand, type CommandTransaction } from '../command/command.ts';
import type { HistoryLocator } from './locator.ts';
import { encodeLocator } from './locator.ts';
import {
  nativeRecordSourceSetProducer,
  type RecordSourceSetCommitment,
  type SemanticRecordSourceSet,
} from './record-source-set-native.ts';

export type { SemanticRecordSourceSet } from './record-source-set-native.ts';
export const MAX_NATIVE_RECORD_SOURCE_SET_MEMBERS = 512;
const sets = new WeakMap<CommandTransaction, SemanticRecordSourceSet>();

// Declaration exclusivity and serialization ordering are enforced by record-source.ts.
export function rememberCommandRecordSourceSet(tx: CommandTransaction, sourceSet: SemanticRecordSourceSet): void {
  if (!sourceSet || typeof sourceSet !== 'object' || Array.isArray(sourceSet))
    throw new TypeError('Invalid native command record source set');
  sets.set(tx, sourceSet);
}
export function hasCommandRecordSourceSet(tx: CommandTransaction): boolean {
  return sets.has(tx);
}
export function releaseCommandRecordSourceSet(tx: CommandTransaction): void {
  sets.delete(tx);
}

export function validateRecordSourceSetCommitment(set: RecordSourceSetCommitment): void {
  if (
    !Number.isInteger(set.sourcePartition) || set.sourcePartition < 0 || set.sourcePartition > 4095 ||
    !(set.locator instanceof Uint8Array) || set.locator.byteLength < 1 || set.locator.byteLength > 256 ||
    !(set.revision instanceof Uint8Array) || set.revision.byteLength < 1 || set.revision.byteLength > 256 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(set.originalTransaction) ||
    !Number.isInteger(set.memberCount) || set.memberCount < 1 || set.memberCount > MAX_NATIVE_RECORD_SOURCE_SET_MEMBERS
  ) throw new TypeError('Invalid native record source set commitment');
}

/** One native ownership locator per generated artifact. No member expansion enters History,
 * a command receipt, an outbox payload or DBOS. Validation must read the real native row. */
export async function recordCommandRecordSourceSetCopy(
  tx: CommandTransaction,
  locator: HistoryLocator,
  position: bigint | null,
): Promise<void> {
  const sourceSet = sets.get(tx);
  if (!sourceSet) return;
  const command = currentCommand(tx);
  const producer = await nativeRecordSourceSetProducer();
  const set = await producer.readCommandRecordSourceSet(tx, sourceSet);
  if (!set) throw new TypeError('Native command record source set is unproven');
  validateRecordSourceSetCommitment(set);
  if (set.sourcePartition !== command.partition || set.originalTransaction !== command.transactionId ||
      !(await producer.verifyRecordSourceSet(tx, set)))
    throw new TypeError('Native record source set belongs to another command or revision');
  await tx.query(
    `INSERT INTO core.record_history_source_set
     (source_partition,set_locator,set_revision,original_transaction,original_position,member_count,producer_version)
     VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT DO NOTHING`,
    [set.sourcePartition, Buffer.from(set.locator), Buffer.from(set.revision), set.originalTransaction,
      position?.toString() ?? null, set.memberCount],
  );
  const original = await tx.query(
    `SELECT original_transaction,original_position,member_count FROM core.record_history_source_set
     WHERE source_partition=$1 AND set_locator=$2 AND set_revision=$3 FOR SHARE`,
    [set.sourcePartition, Buffer.from(set.locator), Buffer.from(set.revision)],
  );
  const row = original.rows[0];
  if (!row || row.original_transaction !== command.transactionId || row.member_count !== set.memberCount ||
      (row.original_position !== null && position !== null && BigInt(row.original_position) !== position))
    throw new TypeError('Conflicting immutable native record source set');
  await tx.query(
    `INSERT INTO core.record_history_source_set_copy
     (source_partition,set_locator,set_revision,partition_no,artifact_type,locator,original_transaction,original_position,producer_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,1) ON CONFLICT DO NOTHING`,
    [set.sourcePartition, Buffer.from(set.locator), Buffer.from(set.revision), command.partition,
      locator.artifactType, Buffer.from(encodeLocator(locator)), command.transactionId, position?.toString() ?? null],
  );
  const accepted = await tx.query(
    `SELECT source_partition,set_locator,set_revision,original_transaction,original_position,producer_version
     FROM core.record_history_source_set_copy
     WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3 FOR SHARE`,
    [command.partition, locator.artifactType, Buffer.from(encodeLocator(locator))],
  );
  const copy = accepted.rows[0];
  if (!copy || copy.source_partition !== set.sourcePartition ||
      !Buffer.from(copy.set_locator).equals(Buffer.from(set.locator)) ||
      !Buffer.from(copy.set_revision).equals(Buffer.from(set.revision)) ||
      copy.original_transaction !== command.transactionId || copy.producer_version !== 1 ||
      (copy.original_position !== null && position !== null && BigInt(copy.original_position) !== position))
    throw new TypeError('Conflicting native record source set copy');
}

export async function finalizeCommandRecordSourceSet(tx: CommandTransaction, position: bigint): Promise<void> {
  if (!sets.has(tx)) return;
  const command = currentCommand(tx);
  // Also validate declarations on commands which generated no artifacts; an opaque-looking
  // object must not survive merely because the command had an empty response/event scope.
  const producer = await nativeRecordSourceSetProducer();
  const set = await producer.readCommandRecordSourceSet(tx, sets.get(tx)!);
  if (!set) throw new TypeError('Native command record source set is unproven');
  validateRecordSourceSetCommitment(set);
  if (set.sourcePartition !== command.partition || set.originalTransaction !== command.transactionId ||
      !(await producer.verifyRecordSourceSet(tx, set)))
    throw new TypeError('Native record source set belongs to another command or revision');
  await tx.query(
    `UPDATE core.record_history_source_set SET original_position=$3
     WHERE source_partition=$1 AND original_transaction=$2 AND original_position IS NULL`,
    [command.partition, command.transactionId, position.toString()],
  );
  await tx.query(
    `UPDATE core.record_history_source_set_copy SET original_position=$3
     WHERE partition_no=$1 AND original_transaction=$2 AND original_position IS NULL`,
    [command.partition, command.transactionId, position.toString()],
  );
}
